"""
ML Predictor — Multi-model next-day USD/JPY direction predictor.

Architecture v4:
  1. Fetch 10Y OHLC → 48 technical + 60 cross-asset + macro + regime features
  2. Walk-forward validation with NESTED feature selection per fold
  3. XGBoost + LightGBM + Logistic → 3-model ensemble
  4. Holdout test (last 12 months) for honest evaluation
  5. Label shuffle sanity check to detect leakage
  6. Yearly performance breakdown
  7. Conservative probability→score with AUC dampening

Key design decisions (from rubber-duck critique v2):
  - Feature selection INSIDE each fold (no global leakage)
  - Holdout + label shuffle = mandatory validation
  - Point-in-time macro features (30-day publication lag)
  - Regime features for non-stationarity
  - LightGBM as diversity addition to ensemble
  - Performance-gated ML weight (0.05–0.30)
"""
import json
import logging
import pickle
import warnings
from dataclasses import dataclass, asdict
from datetime import datetime, timezone, timedelta
from pathlib import Path

warnings.filterwarnings("ignore", message="X does not have valid feature names")

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (accuracy_score, roc_auc_score, brier_score_loss)
from sklearn.model_selection import TimeSeriesSplit
from sklearn.preprocessing import StandardScaler

try:
    import xgboost as xgb
    HAS_XGB = True
except ImportError:
    HAS_XGB = False

try:
    import lightgbm as lgbm
    HAS_LGBM = True
except ImportError:
    HAS_LGBM = False

from analyzers.technical_features import (
    fetch_ohlc, build_features, fetch_cross_asset_history,
    build_cross_asset_indicators, FEATURE_COLUMNS,
    fetch_fred_macro, build_macro_features, build_regime_features,
)

logger = logging.getLogger("jpy_forecast")

MODEL_DIR = Path(__file__).resolve().parent.parent / "data" / "models"
MODEL_DIR.mkdir(parents=True, exist_ok=True)

RETRAIN_DAYS = 7
MIN_AUC_THRESHOLD = 0.52
DEFAULT_ML_WEIGHT = 0.15
MAX_ML_WEIGHT = 0.30
DATA_YEARS = 10                # Extended from 5Y to 10Y
HOLDOUT_DAYS = 252             # ~12 months for holdout test
FEATURE_TOP_K = 60


@dataclass
class MLPrediction:
    """Result from the ML predictor."""
    direction: str
    probability: float
    confidence: float
    ml_score: float
    model_type: str
    walk_forward_auc: float
    walk_forward_acc: float
    features_used: int
    training_samples: int
    model_age_days: int


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
    holdout_auc: float
    holdout_accuracy: float
    baseline_accuracy: float
    momentum_accuracy: float
    beats_baselines: bool
    label_shuffle_auc: float     # sanity: should be ~0.50
    yearly_performance: dict     # {year: {auc, acc}}
    total_features: int
    selected_features: int


def _probability_to_score(prob: float, auc: float) -> float:
    """Convert probability to [-5, +5] score with AUC dampening."""
    raw = prob - 0.5
    damped = np.clip(raw / 0.15, -1.0, 1.0)
    quality_factor = np.clip((auc - 0.50) / 0.15, 0.0, 1.0)
    max_score = 2.0 + 3.0 * quality_factor
    return float(damped * max_score)


def _select_features_for_fold(X_tr: np.ndarray, y_tr: np.ndarray,
                              feature_names: list, top_k: int = FEATURE_TOP_K) -> list[int]:
    """
    Select top-k features INSIDE a fold's training set only.
    This prevents feature selection leakage.
    """
    if X_tr.shape[1] <= top_k:
        return list(range(X_tr.shape[1]))

    if HAS_XGB:
        quick = xgb.XGBClassifier(
            n_estimators=100, max_depth=3, learning_rate=0.1,
            verbosity=0, random_state=42,
        )
        quick.fit(X_tr, y_tr)
        importances = quick.feature_importances_
    else:
        # Fallback: mutual information proxy via correlation
        importances = np.array([
            abs(np.corrcoef(X_tr[:, i], y_tr)[0, 1])
            if np.std(X_tr[:, i]) > 1e-9 else 0.0
            for i in range(X_tr.shape[1])
        ])

    top_indices = np.argsort(importances)[::-1][:top_k].tolist()
    return sorted(top_indices)


def _tune_xgboost(X_tr: np.ndarray, y_tr: np.ndarray,
                   X_va: np.ndarray, y_va: np.ndarray,
                   spw: float) -> "xgb.XGBClassifier":
    """Quick hyperparameter search. Returns best XGBClassifier."""
    param_grid = [
        {"max_depth": 3, "learning_rate": 0.05, "min_child_weight": 10, "colsample_bytree": 0.7},
        {"max_depth": 4, "learning_rate": 0.03, "min_child_weight": 8, "colsample_bytree": 0.6},
        {"max_depth": 3, "learning_rate": 0.08, "min_child_weight": 15, "colsample_bytree": 0.8},
        {"max_depth": 2, "learning_rate": 0.05, "min_child_weight": 20, "colsample_bytree": 0.5},
        {"max_depth": 5, "learning_rate": 0.02, "min_child_weight": 5, "colsample_bytree": 0.6},
        {"max_depth": 3, "learning_rate": 0.05, "min_child_weight": 10, "colsample_bytree": 0.5, "gamma": 1.0},
    ]

    best_model, best_auc = None, 0.0
    for params in param_grid:
        model = xgb.XGBClassifier(
            n_estimators=800, subsample=0.8, scale_pos_weight=spw,
            eval_metric="auc", verbosity=0, random_state=42,
            reg_alpha=0.1, reg_lambda=1.0, **params,
        )
        model.fit(X_tr, y_tr, eval_set=[(X_va, y_va)], verbose=False)
        prob = model.predict_proba(X_va)[:, 1]
        auc = roc_auc_score(y_va, prob) if len(np.unique(y_va)) > 1 else 0.5
        if auc > best_auc:
            best_auc, best_model = auc, model
    return best_model


def _tune_lightgbm(X_tr: np.ndarray, y_tr: np.ndarray,
                    X_va: np.ndarray, y_va: np.ndarray,
                    spw: float) -> "lgbm.LGBMClassifier":
    """Quick LightGBM hyperparameter search."""
    param_grid = [
        {"max_depth": 3, "learning_rate": 0.05, "num_leaves": 15, "colsample_bytree": 0.7},
        {"max_depth": 4, "learning_rate": 0.03, "num_leaves": 20, "colsample_bytree": 0.6},
        {"max_depth": 3, "learning_rate": 0.08, "num_leaves": 12, "colsample_bytree": 0.8},
        {"max_depth": 2, "learning_rate": 0.05, "num_leaves": 8, "colsample_bytree": 0.5},
    ]

    best_model, best_auc = None, 0.0
    for params in param_grid:
        model = lgbm.LGBMClassifier(
            n_estimators=800, subsample=0.8, scale_pos_weight=spw,
            metric="auc", verbosity=-1, random_state=42,
            reg_alpha=0.1, reg_lambda=1.0,
            min_child_samples=max(10, int(len(y_tr) * 0.01)),
            **params,
        )
        model.fit(X_tr, y_tr, eval_set=[(X_va, y_va)],
                  callbacks=[lgbm.log_evaluation(period=0)])
        prob = model.predict_proba(X_va)[:, 1]
        auc = roc_auc_score(y_va, prob) if len(np.unique(y_va)) > 1 else 0.5
        if auc > best_auc:
            best_auc, best_model = auc, model
    return best_model


def _run_label_shuffle_test(X: np.ndarray, y: np.ndarray,
                            feature_names: list, n_shuffles: int = 3) -> float:
    """
    Sanity check: shuffle labels and retrain. AUC should drop to ~0.50.
    If it doesn't, there's likely leakage.
    """
    logger.info("[ml] Running label shuffle sanity check...")
    shuffle_aucs = []

    tscv = TimeSeriesSplit(n_splits=3, gap=1)

    for i in range(n_shuffles):
        rng = np.random.RandomState(i)
        y_shuffled = rng.permutation(y)
        fold_aucs = []

        for train_idx, val_idx in tscv.split(X):
            X_tr, X_va = X[train_idx], X[val_idx]
            y_tr, y_va = y_shuffled[train_idx], y_shuffled[val_idx]

            scaler = StandardScaler()
            X_tr_sc = scaler.fit_transform(X_tr)
            X_va_sc = scaler.transform(X_va)

            lr = LogisticRegression(C=0.5, l1_ratio=1.0, solver="saga",
                                    max_iter=1000, random_state=42)
            lr.fit(X_tr_sc, y_tr)
            prob = lr.predict_proba(X_va_sc)[:, 1]
            auc = roc_auc_score(y_va, prob) if len(np.unique(y_va)) > 1 else 0.5
            fold_aucs.append(auc)

        shuffle_aucs.append(np.mean(fold_aucs))

    avg_shuffle_auc = np.mean(shuffle_aucs)
    logger.info(f"[ml] Label shuffle AUC: {avg_shuffle_auc:.4f} "
                f"(expected ~0.50, got {shuffle_aucs})")

    if avg_shuffle_auc > 0.55:
        logger.warning("[ml] ⚠️ Label shuffle AUC > 0.55 — possible leakage!")
    else:
        logger.info("[ml] ✅ Label shuffle test passed (no obvious leakage)")

    return float(avg_shuffle_auc)


def _compute_yearly_performance(dates: np.ndarray, y_true: np.ndarray,
                                y_prob: np.ndarray) -> dict:
    """Compute AUC/accuracy per calendar year for stability analysis."""
    yearly = {}
    years = pd.Series(dates).dt.year.values

    for yr in sorted(set(years)):
        mask = years == yr
        if mask.sum() < 20:
            continue
        yt = y_true[mask]
        yp = y_prob[mask]
        if len(np.unique(yt)) < 2:
            continue
        yearly[int(yr)] = {
            "auc": round(float(roc_auc_score(yt, yp)), 4),
            "acc": round(float(accuracy_score(yt, (yp >= 0.5).astype(int))), 4),
            "n": int(mask.sum()),
        }

    return yearly


def _train_and_evaluate(X: np.ndarray, y: np.ndarray,
                        feature_names: list, dates: np.ndarray = None) -> dict:
    """
    Train with walk-forward validation, nested feature selection, 3-model ensemble.
    """
    n = len(X)
    total_features = X.shape[1]
    logger.info(f"[ml] Training on {n} samples, {total_features} features")

    # ── Walk-forward evaluation with nested feature selection ──
    n_splits = 5
    tscv = TimeSeriesSplit(n_splits=n_splits, gap=1)

    results = {"logistic": [], "xgboost": [], "lightgbm": [], "ensemble": []}
    baselines = {"majority": [], "momentum": [], "sma_trend": []}
    all_val_dates, all_val_y, all_val_probs = [], [], []

    # Track which features are consistently selected across folds
    feature_selection_counts = np.zeros(total_features)

    for fold, (train_idx, val_idx) in enumerate(tscv.split(X)):
        X_tr_raw, X_va_raw = X[train_idx], X[val_idx]
        y_tr, y_va = y[train_idx], y[val_idx]

        # ── Nested feature selection (inside this fold only) ──
        if total_features > FEATURE_TOP_K:
            sel_idx = _select_features_for_fold(X_tr_raw, y_tr, feature_names, FEATURE_TOP_K)
            X_tr = X_tr_raw[:, sel_idx]
            X_va = X_va_raw[:, sel_idx]
            fold_feature_names = [feature_names[i] for i in sel_idx]
            for i in sel_idx:
                feature_selection_counts[i] += 1
        else:
            X_tr, X_va = X_tr_raw, X_va_raw
            fold_feature_names = feature_names
            feature_selection_counts += 1

        scaler = StandardScaler()
        X_tr_sc = scaler.fit_transform(X_tr)
        X_va_sc = scaler.transform(X_va)

        # ── Baselines ──
        majority = 1 if y_tr.mean() > 0.5 else 0
        baselines["majority"].append(accuracy_score(y_va, [majority] * len(y_va)))

        return_idx = fold_feature_names.index("return_1d") if "return_1d" in fold_feature_names else 0
        momentum_pred = (X_va[:, return_idx] > 0).astype(int)
        baselines["momentum"].append(accuracy_score(y_va, momentum_pred))

        sma_idx = fold_feature_names.index("dist_sma20") if "dist_sma20" in fold_feature_names else None
        if sma_idx is not None:
            sma_pred = (X_va[:, sma_idx] < 0).astype(int)
            baselines["sma_trend"].append(accuracy_score(y_va, sma_pred))

        # ── Logistic Regression with L1 ──
        lr = LogisticRegression(C=0.5, l1_ratio=1.0, solver="saga",
                                max_iter=2000, random_state=42)
        lr.fit(X_tr_sc, y_tr)
        lr_prob = lr.predict_proba(X_va_sc)[:, 1]
        results["logistic"].append({
            "auc": roc_auc_score(y_va, lr_prob) if len(np.unique(y_va)) > 1 else 0.5,
            "acc": accuracy_score(y_va, (lr_prob >= 0.5).astype(int)),
            "brier": brier_score_loss(y_va, lr_prob),
            "probs": lr_prob,
        })

        # ── XGBoost ──
        xgb_prob = None
        if HAS_XGB:
            pos_count = y_tr.sum()
            neg_count = len(y_tr) - pos_count
            spw = neg_count / max(pos_count, 1)
            xgb_model = _tune_xgboost(X_tr_sc, y_tr, X_va_sc, y_va, spw)
            xgb_prob = xgb_model.predict_proba(X_va_sc)[:, 1]
            results["xgboost"].append({
                "auc": roc_auc_score(y_va, xgb_prob) if len(np.unique(y_va)) > 1 else 0.5,
                "acc": accuracy_score(y_va, (xgb_prob >= 0.5).astype(int)),
                "brier": brier_score_loss(y_va, xgb_prob),
                "probs": xgb_prob,
            })

        # ── LightGBM ──
        lgbm_prob = None
        if HAS_LGBM:
            pos_count = y_tr.sum()
            neg_count = len(y_tr) - pos_count
            spw = neg_count / max(pos_count, 1)
            lgbm_model = _tune_lightgbm(X_tr_sc, y_tr, X_va_sc, y_va, spw)
            lgbm_prob = lgbm_model.predict_proba(X_va_sc)[:, 1]
            results["lightgbm"].append({
                "auc": roc_auc_score(y_va, lgbm_prob) if len(np.unique(y_va)) > 1 else 0.5,
                "acc": accuracy_score(y_va, (lgbm_prob >= 0.5).astype(int)),
                "brier": brier_score_loss(y_va, lgbm_prob),
                "probs": lgbm_prob,
            })

        # ── 3-model ensemble ──
        model_probs = [lr_prob]
        model_weights = [0.2]
        if xgb_prob is not None:
            model_probs.append(xgb_prob)
            model_weights.append(0.4)
        if lgbm_prob is not None:
            model_probs.append(lgbm_prob)
            model_weights.append(0.4)

        # Normalize weights
        w_sum = sum(model_weights)
        model_weights = [w / w_sum for w in model_weights]

        ens_prob = sum(w * p for w, p in zip(model_weights, model_probs))
        results["ensemble"].append({
            "auc": roc_auc_score(y_va, ens_prob) if len(np.unique(y_va)) > 1 else 0.5,
            "acc": accuracy_score(y_va, (ens_prob >= 0.5).astype(int)),
            "brier": brier_score_loss(y_va, ens_prob),
        })

        # Collect for yearly analysis
        if dates is not None:
            all_val_dates.extend(dates[val_idx])
            all_val_y.extend(y_va)
            all_val_probs.extend(ens_prob)

    # ── Aggregate metrics ──
    def avg_metrics(rl):
        return {
            "auc": np.mean([r["auc"] for r in rl]),
            "acc": np.mean([r["acc"] for r in rl]),
            "brier": np.mean([r["brier"] for r in rl]),
        }

    lr_metrics = avg_metrics(results["logistic"])
    baseline_maj = np.mean(baselines["majority"])
    baseline_mom = np.mean(baselines["momentum"])
    baseline_sma = np.mean(baselines["sma_trend"]) if baselines["sma_trend"] else 0.0

    logger.info(f"[ml] Walk-forward results ({n_splits} folds):")
    logger.info(f"  Baseline (majority): {baseline_maj:.1%}")
    logger.info(f"  Baseline (momentum): {baseline_mom:.1%}")
    if baseline_sma > 0:
        logger.info(f"  Baseline (SMA trend): {baseline_sma:.1%}")
    logger.info(f"  Logistic L1: AUC={lr_metrics['auc']:.4f}, "
                f"Acc={lr_metrics['acc']:.1%}, Brier={lr_metrics['brier']:.4f}")

    best_type = "logistic"
    best_metrics = lr_metrics

    candidates = [("logistic", lr_metrics)]

    if HAS_XGB and results["xgboost"]:
        xgb_metrics = avg_metrics(results["xgboost"])
        logger.info(f"  XGBoost: AUC={xgb_metrics['auc']:.4f}, "
                    f"Acc={xgb_metrics['acc']:.1%}, Brier={xgb_metrics['brier']:.4f}")
        candidates.append(("xgboost", xgb_metrics))

    if HAS_LGBM and results["lightgbm"]:
        lgbm_metrics = avg_metrics(results["lightgbm"])
        logger.info(f"  LightGBM: AUC={lgbm_metrics['auc']:.4f}, "
                    f"Acc={lgbm_metrics['acc']:.1%}, Brier={lgbm_metrics['brier']:.4f}")
        candidates.append(("lightgbm", lgbm_metrics))

    if results["ensemble"]:
        ens_metrics = avg_metrics(results["ensemble"])
        logger.info(f"  Ensemble (3-model): AUC={ens_metrics['auc']:.4f}, "
                    f"Acc={ens_metrics['acc']:.1%}, Brier={ens_metrics['brier']:.4f}")
        candidates.append(("ensemble", ens_metrics))

    best_type, best_metrics = max(candidates, key=lambda x: x[1]["auc"])
    logger.info(f"[ml] Best: {best_type} (AUC={best_metrics['auc']:.4f})")

    # ── Yearly performance ──
    yearly_perf = {}
    if all_val_dates:
        yearly_perf = _compute_yearly_performance(
            np.array(all_val_dates), np.array(all_val_y), np.array(all_val_probs))
        for yr, p in yearly_perf.items():
            logger.info(f"  Year {yr}: AUC={p['auc']:.3f}, Acc={p['acc']:.1%} (n={p['n']})")

    # ── Feature stability: consistently selected features ──
    if total_features > FEATURE_TOP_K:
        stable_features = [(feature_names[i], int(c))
                           for i, c in enumerate(feature_selection_counts) if c >= 3]
        stable_features.sort(key=lambda x: -x[1])
        logger.info(f"[ml] Features selected in ≥3/5 folds: {len(stable_features)}")
        # Use features selected in majority of folds for final model
        final_sel_idx = [i for i, c in enumerate(feature_selection_counts)
                         if c >= max(2, n_splits // 2)]
        if len(final_sel_idx) < 20:
            final_sel_idx = list(np.argsort(feature_selection_counts)[::-1][:FEATURE_TOP_K])
        final_sel_idx = sorted(final_sel_idx)
    else:
        final_sel_idx = list(range(total_features))

    selected_feature_names = [feature_names[i] for i in final_sel_idx]
    X_sel = X[:, final_sel_idx]

    # ── Train final model(s) on all data (with selected features) ──
    final_scaler = StandardScaler()
    X_scaled = final_scaler.fit_transform(X_sel)
    split_idx = int(n * 0.85)

    final_lr = LogisticRegression(C=0.5, l1_ratio=1.0, solver="saga",
                                  max_iter=2000, random_state=42)
    final_lr.fit(X_scaled, y)

    final_xgb = None
    if HAS_XGB:
        pos_count = y[:split_idx].sum()
        neg_count = split_idx - pos_count
        spw = neg_count / max(pos_count, 1)
        final_xgb = _tune_xgboost(X_scaled[:split_idx], y[:split_idx],
                                    X_scaled[split_idx:], y[split_idx:], spw)
        if hasattr(final_xgb, "feature_importances_"):
            imp = sorted(zip(selected_feature_names, final_xgb.feature_importances_),
                         key=lambda x: -x[1])[:10]
            logger.info(f"[ml] Top features: {[(n, f'{v:.3f}') for n, v in imp]}")

    final_lgbm = None
    if HAS_LGBM:
        pos_count = y[:split_idx].sum()
        neg_count = split_idx - pos_count
        spw = neg_count / max(pos_count, 1)
        final_lgbm = _tune_lightgbm(X_scaled[:split_idx], y[:split_idx],
                                      X_scaled[split_idx:], y[split_idx:], spw)

    # Build final model dict
    if best_type == "ensemble":
        model_dict = {"lr": final_lr}
        weights = {"lr": 0.2}
        if final_xgb:
            model_dict["xgb"] = final_xgb
            weights["xgb"] = 0.4
        if final_lgbm:
            model_dict["lgbm"] = final_lgbm
            weights["lgbm"] = 0.4
        # Normalize
        w_sum = sum(weights.values())
        weights = {k: v / w_sum for k, v in weights.items()}
        model_dict["weights"] = weights
        final_model = model_dict
    elif best_type == "xgboost":
        final_model = final_xgb
    elif best_type == "lightgbm":
        final_model = final_lgbm
    else:
        final_model = final_lr

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
        "feature_names": selected_feature_names,
        "yearly_performance": yearly_perf,
        "total_features": total_features,
        "selected_features": len(selected_feature_names),
    }


def _run_holdout_test(X: np.ndarray, y: np.ndarray,
                      feature_names: list, holdout_size: int = HOLDOUT_DAYS) -> dict:
    """
    Honest out-of-sample evaluation on last 12 months.
    NO data from holdout period used in training/selection/tuning.
    """
    if len(X) <= holdout_size + 500:
        logger.warning("[ml] Not enough data for holdout test")
        return {"auc": 0.0, "acc": 0.0, "n": 0}

    cutoff = len(X) - holdout_size
    X_train, X_holdout = X[:cutoff], X[cutoff:]
    y_train, y_holdout = y[:cutoff], y[cutoff:]

    logger.info(f"[ml] Holdout test: train={cutoff}, holdout={holdout_size}")

    # Feature selection on train only
    if X_train.shape[1] > FEATURE_TOP_K and HAS_XGB:
        sel_idx = _select_features_for_fold(X_train, y_train, feature_names, FEATURE_TOP_K)
        X_train = X_train[:, sel_idx]
        X_holdout = X_holdout[:, sel_idx]

    scaler = StandardScaler()
    X_tr_sc = scaler.fit_transform(X_train)
    X_ho_sc = scaler.transform(X_holdout)

    # Train XGBoost on train set
    if HAS_XGB:
        split = int(len(X_train) * 0.85)
        pos = y_train[:split].sum()
        neg = split - pos
        spw = neg / max(pos, 1)
        model = _tune_xgboost(X_tr_sc[:split], y_train[:split],
                               X_tr_sc[split:], y_train[split:], spw)
        prob = model.predict_proba(X_ho_sc)[:, 1]
    else:
        lr = LogisticRegression(C=0.5, l1_ratio=1.0, solver="saga",
                                max_iter=2000, random_state=42)
        lr.fit(X_tr_sc, y_train)
        prob = lr.predict_proba(X_ho_sc)[:, 1]

    auc = roc_auc_score(y_holdout, prob) if len(np.unique(y_holdout)) > 1 else 0.5
    acc = accuracy_score(y_holdout, (prob >= 0.5).astype(int))

    logger.info(f"[ml] Holdout: AUC={auc:.4f}, Acc={acc:.1%} (n={holdout_size})")
    return {"auc": round(float(auc), 4), "acc": round(float(acc), 4), "n": holdout_size}


def train_model() -> dict:
    """
    Full training pipeline: fetch data → features → validate → train → save.
    """
    logger.info("[ml] Starting model training (v4 — 10Y data, 3 models, validation)...")

    # ── 1. Fetch 10Y OHLC for USDJPY ──
    df = fetch_ohlc("USDJPY=X", years=DATA_YEARS)
    features = build_features(df)

    # ── 2. Cross-asset features (VIX, DXY, gold, oil, yields, etc.) ──
    cross_df = pd.DataFrame()
    try:
        cross_df = fetch_cross_asset_history(years=DATA_YEARS)
        if not cross_df.empty:
            cross_features = build_cross_asset_indicators(cross_df, df.index)
            features = features.join(cross_features, how="left")
            logger.info(f"[ml] Added {len(cross_features.columns)} cross-asset features")
    except Exception as e:
        logger.warning(f"[ml] Cross-asset fetch failed (non-fatal): {e}")

    # ── 3. FRED macro features (rate differentials, CPI, unemployment) ──
    try:
        macro_df = fetch_fred_macro(years=DATA_YEARS)
        if not macro_df.empty:
            macro_features = build_macro_features(macro_df, df.index)
            features = features.join(macro_features, how="left")
            logger.info(f"[ml] Added {len(macro_features.columns)} macro features")
    except Exception as e:
        logger.warning(f"[ml] FRED macro fetch failed (non-fatal): {e}")

    # ── 4. Regime features (volatility regime, rolling correlations, seasonality) ──
    try:
        regime_features = build_regime_features(df, cross_df)
        features = features.join(regime_features, how="left")
        logger.info(f"[ml] Added {len(regime_features.columns)} regime features")
    except Exception as e:
        logger.warning(f"[ml] Regime features failed (non-fatal): {e}")

    # ── 5. Target ──
    features = features.copy()
    features["target"] = (df["Close"].shift(-1) > df["Close"]).astype(int)

    # Drop rows where core USDJPY features have NaN
    core_cols = [c for c in FEATURE_COLUMNS if c in features.columns]
    features = features.dropna(subset=core_cols + ["target"])
    features = features.fillna(0.0)

    # Collect all feature columns
    available_cols = [c for c in FEATURE_COLUMNS if c in features.columns]
    extra_cols = [c for c in features.columns
                  if c not in FEATURE_COLUMNS and c != "target"]
    all_cols = available_cols + sorted(extra_cols)

    logger.info(f"[ml] Total features: {len(all_cols)} "
                f"({len(available_cols)} technical + {len(extra_cols)} extra)")

    X = features[all_cols].values
    y = features["target"].values
    dates = features.index.values

    # ── 6. Label shuffle sanity check ──
    shuffle_auc = _run_label_shuffle_test(X, y, all_cols)

    # ── 7. Holdout test (last 12 months) ──
    holdout_result = _run_holdout_test(X, y, all_cols)

    # ── 8. Train and evaluate (walk-forward with nested feature selection) ──
    result = _train_and_evaluate(X, y, all_cols, dates)
    final_feature_names = result["feature_names"]

    # ── 9. Save model + metadata ──
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
        feature_columns=final_feature_names,
        model_type=result["model_type"],
        n_samples=result["n_samples"],
        walk_forward_auc=round(result["metrics"]["auc"], 4),
        walk_forward_accuracy=round(result["metrics"]["acc"], 4),
        walk_forward_brier=round(result["metrics"]["brier"], 4),
        holdout_auc=holdout_result.get("auc", 0.0),
        holdout_accuracy=holdout_result.get("acc", 0.0),
        baseline_accuracy=round(float(result["baseline_majority"]), 4),
        momentum_accuracy=round(float(result["baseline_momentum"]), 4),
        beats_baselines=bool(result["beats_baselines"]),
        label_shuffle_auc=round(shuffle_auc, 4),
        yearly_performance=result.get("yearly_performance", {}),
        total_features=result.get("total_features", len(all_cols)),
        selected_features=result.get("selected_features", len(final_feature_names)),
    )
    with open(meta_path, "w") as f:
        json.dump(asdict(metadata), f, indent=2, default=str)

    logger.info(f"[ml] Model saved to {model_path}")
    logger.info(f"[ml] Beats baselines: {metadata.beats_baselines}")
    logger.info(f"[ml] Holdout AUC: {holdout_result.get('auc', 'N/A')}")
    logger.info(f"[ml] Label shuffle AUC: {shuffle_auc:.4f}")

    result["holdout"] = holdout_result
    result["label_shuffle_auc"] = shuffle_auc
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

    try:
        df = fetch_ohlc("USDJPY=X", years=1)
        features = build_features(df)

        # Cross-asset features
        cross_df = pd.DataFrame()
        try:
            cross_df = fetch_cross_asset_history(years=1)
            if not cross_df.empty:
                cross_features = build_cross_asset_indicators(cross_df, df.index)
                features = features.join(cross_features, how="left")
        except Exception as e:
            logger.warning(f"[ml] Cross-asset prediction fetch failed: {e}")

        # Macro features
        try:
            macro_df = fetch_fred_macro(years=2)
            if not macro_df.empty:
                macro_features = build_macro_features(macro_df, df.index)
                features = features.join(macro_features, how="left")
        except Exception as e:
            logger.warning(f"[ml] FRED prediction fetch failed: {e}")

        # Regime features
        try:
            regime_features = build_regime_features(df, cross_df)
            features = features.join(regime_features, how="left")
        except Exception as e:
            logger.warning(f"[ml] Regime prediction features failed: {e}")

        core_cols = [c for c in FEATURE_COLUMNS if c in features.columns]
        features = features.dropna(subset=core_cols)
        features = features.fillna(0.0)

        latest = features.iloc[-1:]
        if len(latest) == 0:
            raise ValueError("No valid feature rows after dropna")

        for c in feature_cols:
            if c not in latest.columns:
                latest[c] = 0.0

        X = latest[feature_cols].values
        X_scaled = scaler.transform(X)

        # Predict — handle ensemble vs single model
        model_type = meta.get("model_type", "")
        if model_type == "ensemble" and isinstance(model, dict):
            weights = model.get("weights", {"lr": 0.2, "xgb": 0.4, "lgbm": 0.4})
            prob = 0.0
            for key, w in weights.items():
                if key in model and hasattr(model[key], "predict_proba"):
                    prob += w * model[key].predict_proba(X_scaled)[0][1]
        else:
            prob = model.predict_proba(X_scaled)[0][1]

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

    auc = meta.get("walk_forward_auc", 0.5)
    ml_score = _probability_to_score(prob, auc)

    if prob > 0.57:
        direction = "up"
    elif prob < 0.43:
        direction = "down"
    else:
        direction = "neutral"

    confidence = min(abs(prob - 0.5) * 2, 1.0) * np.clip((auc - 0.48) / 0.20, 0, 1)

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
    """Dynamic ML weight, performance-gated."""
    if prediction.model_type == "unavailable":
        return 0.0
    auc = prediction.walk_forward_auc
    if auc > 0.58:
        return MAX_ML_WEIGHT
    elif auc > 0.55:
        return 0.20
    elif auc < MIN_AUC_THRESHOLD:
        return 0.05
    return DEFAULT_ML_WEIGHT


if __name__ == "__main__":
    """Run standalone training + prediction test."""
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    print("=" * 60)
    print("ML Predictor v4 — Training & Evaluation")
    print("=" * 60)

    result = train_model()
    print(f"\nModel type: {result['model_type']}")
    print(f"Walk-forward AUC: {result['metrics']['auc']:.4f}")
    print(f"Walk-forward Acc: {result['metrics']['acc']:.1%}")
    print(f"Holdout AUC: {result['holdout'].get('auc', 'N/A')}")
    print(f"Holdout Acc: {result['holdout'].get('acc', 'N/A')}")
    print(f"Label shuffle AUC: {result['label_shuffle_auc']:.4f}")
    print(f"Baseline (majority): {result['baseline_majority']:.1%}")
    print(f"Baseline (momentum): {result['baseline_momentum']:.1%}")
    print(f"Beats baselines: {result['beats_baselines']}")
    print(f"Total features: {result.get('total_features', '?')}")
    print(f"Selected features: {result.get('selected_features', '?')}")

    if result.get("yearly_performance"):
        print("\nYearly performance:")
        for yr, p in result["yearly_performance"].items():
            print(f"  {yr}: AUC={p['auc']:.3f}, Acc={p['acc']:.1%} (n={p['n']})")

    print("\n--- Predicting next day ---")
    pred = predict_next_day()
    print(f"Direction: {pred.direction}")
    print(f"Probability (USD/JPY up): {pred.probability:.3f}")
    print(f"ML Score: {pred.ml_score:+.2f}")
    print(f"Confidence: {pred.confidence:.2f}")
    print(f"Ensemble weight: {get_ml_weight(pred):.2f}")
