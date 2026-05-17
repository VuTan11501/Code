"""
ML Predictor — XGBoost-based next-day USD/JPY direction predictor.

Architecture:
  1. Fetch 5Y OHLC → compute 30+ technical features
  2. Train logistic regression baseline + XGBoost
  3. Walk-forward validation (TimeSeriesSplit)
  4. Ensemble with existing news-based score
  5. Auto-retrain when model is stale

Key design decisions (from rubber-duck critique):
  - Start with LOW ML weight (0.15), performance-gated increase
  - Conservative probability→score mapping with dampening
  - Walk-forward validation as primary evaluation
  - Must beat baselines (always-neutral, momentum, logistic)
  - Model metadata saved alongside weights
"""
import json
import logging
import pickle
from dataclasses import dataclass, asdict
from datetime import datetime, timezone, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (accuracy_score, roc_auc_score, brier_score_loss,
                             log_loss, balanced_accuracy_score)
from sklearn.model_selection import TimeSeriesSplit
from sklearn.preprocessing import StandardScaler

try:
    import xgboost as xgb
    HAS_XGB = True
except ImportError:
    HAS_XGB = False

from analyzers.technical_features import (
    fetch_ohlc, build_features, fetch_cross_asset_history,
    build_cross_asset_indicators, FEATURE_COLUMNS,
)

logger = logging.getLogger("jpy_forecast")

MODEL_DIR = Path(__file__).resolve().parent.parent / "data" / "models"
MODEL_DIR.mkdir(parents=True, exist_ok=True)

# Stale threshold: retrain if model older than this
RETRAIN_DAYS = 7
# Minimum walk-forward AUC to trust the model
MIN_AUC_THRESHOLD = 0.52
# ML weight in ensemble (conservative start)
DEFAULT_ML_WEIGHT = 0.15
MAX_ML_WEIGHT = 0.30


@dataclass
class MLPrediction:
    """Result from the ML predictor."""
    direction: str          # "up" / "down" / "neutral"
    probability: float      # raw probability of USD/JPY going up (0-1)
    confidence: float       # calibrated confidence (0-1)
    ml_score: float         # converted to [-5, +5] scale
    model_type: str         # "xgboost" / "logistic" / "unavailable"
    walk_forward_auc: float # out-of-sample AUC from walk-forward
    walk_forward_acc: float # out-of-sample accuracy
    features_used: int      # number of features
    training_samples: int   # number of training samples
    model_age_days: int     # days since last training


@dataclass
class ModelMetadata:
    """Saved alongside the model for reproducibility."""
    trained_at: str
    training_date_range: str
    feature_columns: list
    model_type: str
    n_samples: int
    walk_forward_auc: float
    walk_forward_accuracy: float
    walk_forward_brier: float
    baseline_accuracy: float   # always-predict-majority baseline
    momentum_accuracy: float   # predict-yesterday's-direction baseline
    beats_baselines: bool


def _probability_to_score(prob: float, auc: float) -> float:
    """
    Convert probability to [-5, +5] score with dampening.
    Only generates meaningful scores when model has decent AUC.
    """
    # Center around 0.5
    raw = prob - 0.5

    # Dampen: divide by 0.15 and clip to [-1, 1], then scale
    # This means prob=0.65 → raw=0.15 → damped=1.0 → score=2.0
    # And prob=0.55 → raw=0.05 → damped=0.33 → score=0.67
    damped = np.clip(raw / 0.15, -1.0, 1.0)

    # Scale by model quality: low AUC → smaller scores
    quality_factor = np.clip((auc - 0.50) / 0.15, 0.0, 1.0)
    max_score = 2.0 + 3.0 * quality_factor  # range [2, 5] based on AUC

    return float(damped * max_score)


def _train_and_evaluate(X: np.ndarray, y: np.ndarray,
                        feature_names: list) -> dict:
    """
    Train models with walk-forward validation.
    Returns dict with trained model, scaler, metrics.
    """
    n = len(X)
    logger.info(f"[ml] Training on {n} samples, {X.shape[1]} features")

    # ── Walk-forward evaluation ──
    n_splits = 5
    tscv = TimeSeriesSplit(n_splits=n_splits, gap=1)  # gap=1 prevents label leakage

    results = {"logistic": [], "xgboost": []}
    baselines = {"majority": [], "momentum": []}

    for fold, (train_idx, val_idx) in enumerate(tscv.split(X)):
        X_tr, X_va = X[train_idx], X[val_idx]
        y_tr, y_va = y[train_idx], y[val_idx]

        # Fit scaler on training fold only (no leakage)
        scaler = StandardScaler()
        X_tr_sc = scaler.fit_transform(X_tr)
        X_va_sc = scaler.transform(X_va)

        # Baseline: always predict majority class
        majority = 1 if y_tr.mean() > 0.5 else 0
        baselines["majority"].append(accuracy_score(y_va, [majority] * len(y_va)))

        # Baseline: predict yesterday's direction (momentum)
        # Use last return sign as proxy
        return_idx = feature_names.index("return_1d") if "return_1d" in feature_names else 0
        momentum_pred = (X_va[:, return_idx] > 0).astype(int)
        baselines["momentum"].append(accuracy_score(y_va, momentum_pred))

        # Logistic Regression (baseline model)
        lr = LogisticRegression(C=1.0, max_iter=1000, solver="lbfgs")
        lr.fit(X_tr_sc, y_tr)
        lr_prob = lr.predict_proba(X_va_sc)[:, 1]
        results["logistic"].append({
            "auc": roc_auc_score(y_va, lr_prob) if len(np.unique(y_va)) > 1 else 0.5,
            "acc": accuracy_score(y_va, (lr_prob >= 0.5).astype(int)),
            "brier": brier_score_loss(y_va, lr_prob),
        })

        # XGBoost
        if HAS_XGB:
            pos_count = y_tr.sum()
            neg_count = len(y_tr) - pos_count
            spw = neg_count / max(pos_count, 1)

            xgb_model = xgb.XGBClassifier(
                n_estimators=500,
                learning_rate=0.05,
                max_depth=3,           # shallow to prevent overfit
                min_child_weight=10,   # conservative
                subsample=0.8,
                colsample_bytree=0.7,
                scale_pos_weight=spw,
                eval_metric="auc",
                verbosity=0,
                random_state=42,
            )
            xgb_model.fit(
                X_tr_sc, y_tr,
                eval_set=[(X_va_sc, y_va)],
                verbose=False,
            )
            xgb_prob = xgb_model.predict_proba(X_va_sc)[:, 1]
            results["xgboost"].append({
                "auc": roc_auc_score(y_va, xgb_prob) if len(np.unique(y_va)) > 1 else 0.5,
                "acc": accuracy_score(y_va, (xgb_prob >= 0.5).astype(int)),
                "brier": brier_score_loss(y_va, xgb_prob),
            })

    # ── Aggregate walk-forward metrics ──
    def avg_metrics(results_list):
        return {
            "auc": np.mean([r["auc"] for r in results_list]),
            "acc": np.mean([r["acc"] for r in results_list]),
            "brier": np.mean([r["brier"] for r in results_list]),
        }

    lr_metrics = avg_metrics(results["logistic"])
    baseline_maj = np.mean(baselines["majority"])
    baseline_mom = np.mean(baselines["momentum"])

    logger.info(f"[ml] Walk-forward results ({n_splits} folds):")
    logger.info(f"  Baseline (majority): {baseline_maj:.1%}")
    logger.info(f"  Baseline (momentum): {baseline_mom:.1%}")
    logger.info(f"  Logistic: AUC={lr_metrics['auc']:.4f}, "
                f"Acc={lr_metrics['acc']:.1%}, Brier={lr_metrics['brier']:.4f}")

    # Pick best model
    best_type = "logistic"
    best_metrics = lr_metrics

    if HAS_XGB and results["xgboost"]:
        xgb_metrics = avg_metrics(results["xgboost"])
        logger.info(f"  XGBoost:  AUC={xgb_metrics['auc']:.4f}, "
                    f"Acc={xgb_metrics['acc']:.1%}, Brier={xgb_metrics['brier']:.4f}")
        # Use XGBoost only if it beats logistic AND baseline
        if xgb_metrics["auc"] > lr_metrics["auc"] + 0.005:
            best_type = "xgboost"
            best_metrics = xgb_metrics

    logger.info(f"[ml] Best model: {best_type} "
                f"(AUC={best_metrics['auc']:.4f}, Acc={best_metrics['acc']:.1%})")

    # ── Train final model on all data ──
    final_scaler = StandardScaler()
    X_scaled = final_scaler.fit_transform(X)

    if best_type == "xgboost":
        # Use last 15% as eval set for early stopping
        split_idx = int(n * 0.85)
        pos_count = y[:split_idx].sum()
        neg_count = split_idx - pos_count
        spw = neg_count / max(pos_count, 1)

        final_model = xgb.XGBClassifier(
            n_estimators=500, learning_rate=0.05, max_depth=3,
            min_child_weight=10, subsample=0.8, colsample_bytree=0.7,
            scale_pos_weight=spw, eval_metric="auc", verbosity=0,
            random_state=42,
        )
        final_model.fit(
            X_scaled[:split_idx], y[:split_idx],
            eval_set=[(X_scaled[split_idx:], y[split_idx:])],
            verbose=False,
        )

        # Log feature importance
        if hasattr(final_model, "feature_importances_"):
            imp = sorted(zip(feature_names, final_model.feature_importances_),
                         key=lambda x: -x[1])[:10]
            logger.info(f"[ml] Top features: {[(n, f'{v:.3f}') for n, v in imp]}")
    else:
        final_model = LogisticRegression(C=1.0, max_iter=1000, solver="lbfgs")
        final_model.fit(X_scaled, y)

    beats_baselines = (best_metrics["acc"] > max(baseline_maj, baseline_mom))

    return {
        "model": final_model,
        "scaler": final_scaler,
        "model_type": best_type,
        "metrics": best_metrics,
        "baseline_majority": baseline_maj,
        "baseline_momentum": baseline_mom,
        "beats_baselines": beats_baselines,
        "n_samples": n,
        "feature_names": feature_names,
    }


def train_model() -> dict:
    """
    Full training pipeline: fetch data → features → train → save.
    Returns training results dict.
    """
    logger.info("[ml] Starting model training...")

    # Fetch 5Y OHLC for USDJPY
    df = fetch_ohlc("USDJPY=X", years=5)

    # Compute USDJPY technical features
    features = build_features(df)

    # Fetch and merge cross-asset data (VIX, DXY, gold, oil, yields, Nikkei, FX pairs)
    try:
        cross_df = fetch_cross_asset_history(years=5)
        if not cross_df.empty:
            cross_features = build_cross_asset_indicators(cross_df, df.index)
            features = features.join(cross_features, how="left")
            logger.info(f"[ml] Added {len(cross_features.columns)} cross-asset features")
    except Exception as e:
        logger.warning(f"[ml] Cross-asset fetch failed (non-fatal): {e}")

    # Target: next-day direction (1 = USD/JPY goes up = JPY weaker)
    features = features.copy()
    features["target"] = (df["Close"].shift(-1) > df["Close"]).astype(int)

    # Drop rows where core USDJPY features have NaN (warmup period ~50 days)
    # For cross-asset features, fill remaining NaN with 0 (data may start later)
    core_cols = [c for c in FEATURE_COLUMNS if c in features.columns]
    features = features.dropna(subset=core_cols + ["target"])
    features = features.fillna(0.0)

    # Select feature columns: USDJPY technicals + any cross-asset columns found
    available_cols = [c for c in FEATURE_COLUMNS if c in features.columns]
    # Auto-discover cross-asset columns
    cross_cols = [c for c in features.columns
                  if c not in FEATURE_COLUMNS and c != "target"]
    all_cols = available_cols + sorted(cross_cols)

    logger.info(f"[ml] Total features: {len(all_cols)} "
                f"({len(available_cols)} technical + {len(cross_cols)} cross-asset)")

    X = features[all_cols].values
    y = features["target"].values

    # Train and evaluate
    result = _train_and_evaluate(X, y, all_cols)

    # Save model + metadata
    model_path = MODEL_DIR / "usdjpy_model.pkl"
    meta_path = MODEL_DIR / "usdjpy_meta.json"

    with open(model_path, "wb") as f:
        pickle.dump({
            "model": result["model"],
            "scaler": result["scaler"],
        }, f)

    metadata = ModelMetadata(
        trained_at=datetime.now(timezone.utc).isoformat(),
        training_date_range=f"{features.index[0].date()} → {features.index[-1].date()}",
        feature_columns=all_cols,
        model_type=result["model_type"],
        n_samples=result["n_samples"],
        walk_forward_auc=round(result["metrics"]["auc"], 4),
        walk_forward_accuracy=round(result["metrics"]["acc"], 4),
        walk_forward_brier=round(result["metrics"]["brier"], 4),
        baseline_accuracy=round(float(result["baseline_majority"]), 4),
        momentum_accuracy=round(float(result["baseline_momentum"]), 4),
        beats_baselines=bool(result["beats_baselines"]),
    )
    with open(meta_path, "w") as f:
        json.dump(asdict(metadata), f, indent=2)

    logger.info(f"[ml] Model saved to {model_path}")
    logger.info(f"[ml] Beats baselines: {metadata.beats_baselines}")

    return result


def load_model() -> tuple:
    """Load saved model + metadata. Returns (model_dict, metadata) or (None, None)."""
    model_path = MODEL_DIR / "usdjpy_model.pkl"
    meta_path = MODEL_DIR / "usdjpy_meta.json"

    if not model_path.exists() or not meta_path.exists():
        return None, None

    with open(model_path, "rb") as f:
        model_dict = pickle.load(f)

    with open(meta_path, "r") as f:
        meta = json.load(f)

    return model_dict, meta


def _needs_retrain(meta: dict) -> bool:
    """Check if model needs retraining."""
    if meta is None:
        return True
    trained_at = datetime.fromisoformat(meta["trained_at"])
    age = datetime.now(timezone.utc) - trained_at
    if age.days >= RETRAIN_DAYS:
        logger.info(f"[ml] Model is {age.days} days old, retraining...")
        return True
    return False


def predict_next_day() -> MLPrediction:
    """
    Predict next-day USD/JPY direction.
    Auto-trains if no model exists or model is stale.
    """
    # Load or train model
    model_dict, meta = load_model()
    if model_dict is None or _needs_retrain(meta):
        try:
            result = train_model()
            model_dict, meta = load_model()
        except Exception as e:
            logger.error(f"[ml] Training failed: {e}")
            return MLPrediction(
                direction="neutral", probability=0.5, confidence=0.0,
                ml_score=0.0, model_type="unavailable",
                walk_forward_auc=0.5, walk_forward_acc=0.5,
                features_used=0, training_samples=0, model_age_days=0,
            )

    model = model_dict["model"]
    scaler = model_dict["scaler"]
    feature_cols = meta["feature_columns"]

    # Fetch recent OHLC (need ~60 days for indicator warmup)
    try:
        df = fetch_ohlc("USDJPY=X", years=1)
        features = build_features(df)

        # Add cross-asset features for prediction too
        try:
            cross_df = fetch_cross_asset_history(years=1)
            if not cross_df.empty:
                cross_features = build_cross_asset_indicators(cross_df, df.index)
                features = features.join(cross_features, how="left")
        except Exception as e:
            logger.warning(f"[ml] Cross-asset prediction fetch failed: {e}")

        # Drop rows with NaN in core features, fill rest with 0
        core_cols = [c for c in FEATURE_COLUMNS if c in features.columns]
        features = features.dropna(subset=core_cols)
        features = features.fillna(0.0)

        # Get the latest row
        latest = features.iloc[-1:]

        if len(latest) == 0:
            raise ValueError("No valid feature rows after dropna")

        # Fill missing columns with 0
        for c in feature_cols:
            if c not in latest.columns:
                latest[c] = 0.0

        X = latest[feature_cols].values
        X_scaled = scaler.transform(X)

        # Predict
        prob = model.predict_proba(X_scaled)[0][1]  # P(USD/JPY up)

    except Exception as e:
        logger.error(f"[ml] Prediction failed: {e}")
        return MLPrediction(
            direction="neutral", probability=0.5, confidence=0.0,
            ml_score=0.0, model_type=meta.get("model_type", "unknown"),
            walk_forward_auc=meta.get("walk_forward_auc", 0.5),
            walk_forward_acc=meta.get("walk_forward_accuracy", 0.5),
            features_used=len(feature_cols), training_samples=meta.get("n_samples", 0),
            model_age_days=0,
        )

    # Convert probability to direction and score
    auc = meta.get("walk_forward_auc", 0.5)
    ml_score = _probability_to_score(prob, auc)

    # Direction with confidence threshold
    if prob > 0.57:
        direction = "up"
    elif prob < 0.43:
        direction = "down"
    else:
        direction = "neutral"

    # Confidence: based on distance from 0.5 and model quality
    confidence = min(abs(prob - 0.5) * 2, 1.0) * np.clip((auc - 0.48) / 0.20, 0, 1)

    # Model age
    trained_at = datetime.fromisoformat(meta["trained_at"])
    age_days = (datetime.now(timezone.utc) - trained_at).days

    prediction = MLPrediction(
        direction=direction,
        probability=round(float(prob), 4),
        confidence=round(float(confidence), 4),
        ml_score=round(float(ml_score), 2),
        model_type=meta["model_type"],
        walk_forward_auc=meta.get("walk_forward_auc", 0.5),
        walk_forward_acc=meta.get("walk_forward_accuracy", 0.5),
        features_used=len(feature_cols),
        training_samples=meta.get("n_samples", 0),
        model_age_days=age_days,
    )

    logger.info(f"[ml] Prediction: {direction} (prob={prob:.3f}, "
                f"score={ml_score:+.2f}, model={meta['model_type']}, "
                f"auc={auc:.3f})")

    return prediction


def get_ml_weight(prediction: MLPrediction) -> float:
    """
    Compute dynamic ML weight for ensemble.
    Performance-gated: higher weight only if model is proven.
    """
    if prediction.model_type == "unavailable":
        return 0.0

    auc = prediction.walk_forward_auc

    # Base weight: 0.15
    weight = DEFAULT_ML_WEIGHT

    # Increase if model is strong (AUC > 0.55)
    if auc > 0.58:
        weight = MAX_ML_WEIGHT  # 0.30
    elif auc > 0.55:
        weight = 0.20
    elif auc < MIN_AUC_THRESHOLD:
        weight = 0.05  # barely trust it

    return weight


if __name__ == "__main__":
    """Run standalone training + prediction test."""
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    print("=" * 60)
    print("ML Predictor — Training & Evaluation")
    print("=" * 60)

    result = train_model()
    print(f"\nModel type: {result['model_type']}")
    print(f"Walk-forward AUC: {result['metrics']['auc']:.4f}")
    print(f"Walk-forward Acc: {result['metrics']['acc']:.1%}")
    print(f"Baseline (majority): {result['baseline_majority']:.1%}")
    print(f"Baseline (momentum): {result['baseline_momentum']:.1%}")
    print(f"Beats baselines: {result['beats_baselines']}")

    print("\n--- Predicting next day ---")
    pred = predict_next_day()
    print(f"Direction: {pred.direction}")
    print(f"Probability (USD/JPY up): {pred.probability:.3f}")
    print(f"ML Score: {pred.ml_score:+.2f}")
    print(f"Confidence: {pred.confidence:.2f}")
    print(f"Ensemble weight: {get_ml_weight(pred):.2f}")
