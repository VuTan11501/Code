"""
Factor Scorer - Deterministic scoring system for JPY factors.
Uses Gemini signals + market data to produce weighted factor scores.
Gemini extracts signals; this module applies transparent, auditable rules.
"""
import json
import logging
from dataclasses import dataclass
from typing import Optional

from config import FACTOR_GROUPS
from crawlers.base import MarketDataPoint

logger = logging.getLogger("jpy_forecast")

# Score mapping for Gemini signal magnitudes
DIRECTION_MULTIPLIER = {
    "stronger": 1.0,   # JPY stronger = positive
    "weaker": -1.0,    # JPY weaker = negative
    "neutral": 0.0,
}
MAGNITUDE_SCORE = {
    "high": 4.0,
    "medium": 2.5,
    "low": 1.0,
}
TIME_WEIGHT = {
    "immediate": 1.0,
    "short_term": 0.7,
    "medium_term": 0.4,
}


@dataclass
class FactorResult:
    """Result for one factor group."""
    group: str
    name: str
    score: float          # -5.0 to +5.0
    confidence: float     # 0.0 to 1.0
    weight: float         # Group weight from config
    weighted_score: float # score * weight
    rationale: str
    signal_count: int
    key_articles: list[str]


@dataclass
class ForecastResult:
    """Overall forecast result."""
    jpy_direction: str       # stronger, weaker, neutral
    usdjpy_direction: str    # down, up, sideways
    overall_score: float     # -5.0 to +5.0
    confidence: float        # 0.0 to 1.0
    factors: list[FactorResult]
    market_summary: str
    key_risks: list[str]
    gemini_summary: str
    # VND-specific
    vnd_analysis: str = ""
    vnd_direction: str = "sideways"  # up=1JPY buys more VND, down=less
    jpyvnd_rate: float = 0.0
    # Next-day price forecast
    usdjpy_forecast_low: float = 0.0
    usdjpy_forecast_high: float = 0.0
    jpyvnd_forecast_low: float = 0.0
    jpyvnd_forecast_high: float = 0.0
    # ML prediction metadata
    ml_model_type: str = ""
    ml_probability: float = 0.5
    ml_auc: float = 0.5
    ml_weight_used: float = 0.0


def _score_from_signals(signals: list[dict]) -> tuple[float, float, list[str]]:
    """
    Calculate score from Gemini signals for one factor group.
    Returns (score, confidence, key_article_titles).
    """
    if not signals:
        return 0.0, 0.1, []

    total_score = 0.0
    total_weight = 0.0
    articles = []

    for sig in signals:
        direction = DIRECTION_MULTIPLIER.get(sig.get("direction", "neutral"), 0.0)
        magnitude = MAGNITUDE_SCORE.get(sig.get("magnitude", "low"), 1.0)
        time_w = TIME_WEIGHT.get(sig.get("time_relevance", "medium_term"), 0.4)

        signal_score = direction * magnitude * time_w
        total_score += signal_score
        total_weight += time_w
        articles.append(sig.get("article_title", ""))

    # Average and clamp to [-5, 5]
    if total_weight > 0:
        avg_score = total_score / max(len(signals), 1)
    else:
        avg_score = 0.0

    clamped = max(-5.0, min(5.0, avg_score))

    # Confidence based on number of signals and agreement
    if len(signals) >= 5:
        confidence = 0.8
    elif len(signals) >= 3:
        confidence = 0.6
    elif len(signals) >= 1:
        confidence = 0.4
    else:
        confidence = 0.1

    return round(clamped, 2), confidence, articles


def _apply_market_data_adjustments(
    factor_scores: dict[str, float],
    market_data: list[MarketDataPoint],
) -> dict[str, float]:
    """
    Apply deterministic adjustments based on hard market data.
    These override or supplement Gemini signals with factual data.
    """
    md = {d.symbol: d for d in market_data}
    adjustments = {}

    # Oil price impact on external_balance
    oil = md.get("oil_wti") or md.get("oil_brent")
    if oil and oil.change_pct != 0:
        # Rising oil → Japan imports more → weak JPY
        oil_impact = -oil.change_pct / 2  # scale down
        adjustments["external_balance"] = max(-2.0, min(2.0, oil_impact))

    # USD/JPY movement as confirmation
    usdjpy = md.get("usdjpy")
    if usdjpy and abs(usdjpy.change_pct) > 0.5:
        # Large USD/JPY move already happened, note momentum
        # Rising USD/JPY = weaker JPY
        momentum = -usdjpy.change_pct / 3
        adjustments["_momentum"] = max(-2.0, min(2.0, momentum))

    # US-JP yield differential
    us_yield = md.get("us_10y")
    if us_yield and us_yield.change_pct != 0:
        # Rising US yields → wider differential → weak JPY
        yield_impact = -us_yield.change_pct / 4
        adjustments["monetary_policy"] = max(-1.5, min(1.5, yield_impact))

    return adjustments


def compute_factor_scores(
    gemini_result: Optional[dict],
    market_data: list[MarketDataPoint],
    weight_overrides: Optional[dict[str, float]] = None,
    ml_prediction=None,
) -> ForecastResult:
    """
    Compute deterministic factor scores from Gemini signals and market data.
    Accepts optional weight_overrides from auto-calibrator.
    Accepts optional ml_prediction from ML predictor for ensemble blending.
    Returns complete ForecastResult.
    """
    signals_by_factor = {k: [] for k in FACTOR_GROUPS}

    # Group Gemini signals by factor
    if gemini_result and "signals" in gemini_result:
        for sig in gemini_result["signals"]:
            factor = sig.get("factor", "")
            if factor in signals_by_factor:
                signals_by_factor[factor].append(sig)

    # Resolve weights: calibrated > default
    resolved_weights = {k: v["weight"] for k, v in FACTOR_GROUPS.items()}
    if weight_overrides:
        for k, w in weight_overrides.items():
            if k in resolved_weights:
                resolved_weights[k] = w

    # Score each factor group
    factor_results = []
    for group_key, group_config in FACTOR_GROUPS.items():
        signals = signals_by_factor.get(group_key, [])
        score, confidence, articles = _score_from_signals(signals)
        weight = resolved_weights.get(group_key, group_config["weight"])

        factor_results.append(FactorResult(
            group=group_key,
            name=group_config["name"],
            score=score,
            confidence=confidence,
            weight=weight,
            weighted_score=round(score * weight, 2),
            rationale=_build_rationale(signals),
            signal_count=len(signals),
            key_articles=articles[:5],
        ))

    # Apply market data adjustments
    adjustments = _apply_market_data_adjustments(
        {f.group: f.score for f in factor_results},
        market_data,
    )

    for fr in factor_results:
        if fr.group in adjustments:
            adj = adjustments[fr.group]
            fr.score = round(max(-5.0, min(5.0, fr.score + adj)), 2)
            fr.weighted_score = round(fr.score * fr.weight, 2)
            fr.rationale += f" [Market data adjustment: {adj:+.2f}]"

    # Calculate overall score
    overall = sum(f.weighted_score for f in factor_results)
    momentum = adjustments.get("_momentum", 0.0)
    overall = round(max(-5.0, min(5.0, overall + momentum)), 2)

    # Overall confidence (weighted average)
    total_weight = sum(f.weight for f in factor_results)
    overall_confidence = sum(f.confidence * f.weight for f in factor_results) / total_weight if total_weight > 0 else 0.3

    # Gemini's overall assessment (as additional reference)
    gemini_bias = gemini_result.get("overall_bias", "neutral") if gemini_result else "neutral"
    gemini_confidence = gemini_result.get("confidence", 0.3) if gemini_result else 0.3

    # Blend: 70% deterministic + 30% Gemini overall + optional ML
    gemini_score_map = {"stronger": 2.0, "weaker": -2.0, "neutral": 0.0}
    gemini_score = gemini_score_map.get(gemini_bias, 0.0) * gemini_confidence

    # ML ensemble blending
    ml_weight_used = 0.0
    ml_model_type = ""
    ml_probability = 0.5
    ml_auc = 0.5

    if ml_prediction and ml_prediction.model_type != "unavailable":
        from analyzers.ml_predictor import get_ml_weight
        ml_weight_used = get_ml_weight(ml_prediction)
        ml_model_type = ml_prediction.model_type
        ml_probability = ml_prediction.probability
        ml_auc = ml_prediction.walk_forward_auc

        # Blend: (1-ml_weight)*news_score + ml_weight*ml_score
        news_score = overall * 0.7 + gemini_score * 0.3
        blended = round(news_score * (1 - ml_weight_used) + ml_prediction.ml_score * ml_weight_used, 2)
        blended = max(-5.0, min(5.0, blended))
        logger.info(f"  ML ensemble: news={news_score:+.2f} * {1-ml_weight_used:.0%} + "
                     f"ml={ml_prediction.ml_score:+.2f} * {ml_weight_used:.0%} = {blended:+.2f}")
    else:
        blended = round(overall * 0.7 + gemini_score * 0.3, 2)
        blended = max(-5.0, min(5.0, blended))

    # Determine directions
    if blended > 0.5:
        jpy_dir = "stronger"
        usdjpy_dir = "down"
    elif blended < -0.5:
        jpy_dir = "weaker"
        usdjpy_dir = "up"
    else:
        jpy_dir = "neutral"
        usdjpy_dir = "sideways"

    # VND analysis from Gemini
    vnd_analysis = gemini_result.get("vnd_analysis", "") if gemini_result else ""
    vnd_direction = gemini_result.get("vnd_direction", "sideways") if gemini_result else "sideways"

    # Get JPY/VND rate from market data
    jpyvnd_rate = 0.0
    usdjpy_current = 0.0
    for md in market_data:
        if md.symbol == "jpyvnd":
            jpyvnd_rate = md.value
        elif md.symbol == "usdjpy":
            usdjpy_current = md.value

    # Compute next-day USD/JPY forecast range from score + current price
    # Score -5 to +5 maps to roughly ±2% expected move
    # Negative score = JPY weaker = USD/JPY goes UP
    usdjpy_forecast_low = 0.0
    usdjpy_forecast_high = 0.0
    jpyvnd_forecast_low = 0.0
    jpyvnd_forecast_high = 0.0
    if usdjpy_current > 0:
        base_move_pct = -blended * 0.25  # score → expected % change (inverted: neg score → positive USD/JPY)
        volatility = max(0.15, (1 - overall_confidence) * 0.5)  # uncertainty band
        move_low = (base_move_pct - volatility) / 100
        move_high = (base_move_pct + volatility) / 100
        usdjpy_forecast_low = round(usdjpy_current * (1 + move_low), 2)
        usdjpy_forecast_high = round(usdjpy_current * (1 + move_high), 2)
        # JPY/VND forecast: derive from USD/JPY forecast + current USDVND
        if jpyvnd_rate > 0:
            # When USD/JPY goes up (JPY weaker), JPY/VND goes down
            # jpyvnd = usdvnd / usdjpy → higher usdjpy = lower jpyvnd
            usdvnd_current = jpyvnd_rate * usdjpy_current
            jpyvnd_forecast_high = round(usdvnd_current / usdjpy_forecast_low, 1)
            jpyvnd_forecast_low = round(usdvnd_current / usdjpy_forecast_high, 1)

    # If no Gemini VND analysis, infer from JPY direction
    if not vnd_analysis:
        if jpy_dir == "stronger":
            vnd_direction = "up"
            vnd_analysis = "JPY dự kiến tăng giá → 1 Yên có thể mua được nhiều VND hơn. Người chuyển tiền từ Nhật về VN có lợi."
        elif jpy_dir == "weaker":
            vnd_direction = "down"
            vnd_analysis = "JPY dự kiến giảm giá → 1 Yên mua được ít VND hơn. Người chuyển tiền từ Nhật về VN bị thiệt."
        else:
            vnd_direction = "sideways"
            vnd_analysis = "JPY dự kiến đi ngang → Tỷ giá JPY/VND ít biến động. Chưa có tín hiệu rõ ràng."

    return ForecastResult(
        jpy_direction=jpy_dir,
        usdjpy_direction=usdjpy_dir,
        overall_score=blended,
        confidence=round(overall_confidence, 2),
        factors=factor_results,
        market_summary=gemini_result.get("market_summary", "") if gemini_result else "Chỉ có dữ liệu thị trường (Gemini không khả dụng)",
        key_risks=gemini_result.get("key_risks", []) if gemini_result else [],
        gemini_summary=gemini_result.get("market_summary", "") if gemini_result else "",
        vnd_analysis=vnd_analysis,
        vnd_direction=vnd_direction,
        jpyvnd_rate=jpyvnd_rate,
        usdjpy_forecast_low=usdjpy_forecast_low,
        usdjpy_forecast_high=usdjpy_forecast_high,
        jpyvnd_forecast_low=jpyvnd_forecast_low,
        jpyvnd_forecast_high=jpyvnd_forecast_high,
        ml_model_type=ml_model_type,
        ml_probability=ml_probability,
        ml_auc=ml_auc,
        ml_weight_used=ml_weight_used,
    )


def _build_rationale(signals: list[dict]) -> str:
    """Build human-readable rationale from signals."""
    if not signals:
        return "No relevant signals detected."

    parts = []
    for sig in signals[:3]:
        direction = sig.get("direction", "neutral")
        evidence = sig.get("evidence", "")
        if evidence:
            parts.append(f"{direction.upper()}: {evidence}")

    return " | ".join(parts) if parts else "Signals present but no evidence extracted."
