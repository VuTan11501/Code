"""
Accuracy Tracker & Auto-Calibrator for JPY Forecast Tool.

Computes rolling accuracy stats from past predictions vs actual outcomes.
Auto-calibrates factor weights in shadow mode until 30+ forecasts,
then switches to active calibration with small incremental changes.
"""
import json
import logging
from dataclasses import dataclass, field
from typing import Optional

from config import FACTOR_GROUPS
from data.db import (
    get_completed_outcomes, get_latest_calibrated_weights,
    insert_calibrated_weight, get_connection,
)

logger = logging.getLogger("jpy_forecast")

# Calibration thresholds
MIN_FORECASTS_DISPLAY = 5       # Min to show accuracy stats
MIN_FORECASTS_SHADOW = 10       # Min to run shadow calibration
MIN_FORECASTS_ACTIVE = 30       # Min to apply active weight changes
MAX_WEIGHT_CHANGE = 0.03        # Max weight adjustment per run
MIN_WEIGHT = 0.05               # Never disable a factor entirely
BASELINE_ACCURACY = 0.33        # Random guess (3 directions)


@dataclass
class FactorAccuracy:
    """Accuracy stats for one factor group."""
    group: str
    name_vi: str
    total: int = 0
    hits: int = 0
    misses: int = 0
    inconclusive: int = 0
    hit_rate: float = 0.0
    avg_score_when_correct: float = 0.0
    avg_score_when_wrong: float = 0.0


@dataclass
class AccuracyStats:
    """Overall prediction accuracy statistics."""
    # Overall accuracy by horizon
    accuracy_1d: float = 0.0
    accuracy_3d: float = 0.0
    accuracy_7d: float = 0.0
    total_forecasts: int = 0
    verified_forecasts: int = 0

    # Rolling windows
    accuracy_7day: float = 0.0     # last 7 calendar days
    accuracy_30day: float = 0.0    # last 30 calendar days
    accuracy_90day: float = 0.0    # last 90 calendar days
    count_7day: int = 0
    count_30day: int = 0
    count_90day: int = 0

    # Streak
    current_streak: int = 0        # positive = consecutive correct
    streak_type: str = ""          # "win" or "loss"

    # Confidence calibration (bucket: hit_rate)
    confidence_calibration: dict = field(default_factory=dict)

    # Per-factor accuracy
    factor_accuracy: list[FactorAccuracy] = field(default_factory=list)

    # VND accuracy
    vnd_accuracy_1d: float = 0.0
    vnd_total: int = 0

    # Magnitude tracking
    avg_predicted_score_correct: float = 0.0
    avg_predicted_score_wrong: float = 0.0
    avg_actual_move_pct: float = 0.0

    # Baseline comparison
    beats_always_neutral: bool = False
    beats_momentum: bool = False

    # Calibration status
    calibration_mode: str = "collecting"  # collecting, shadow, active
    recent_history: list[dict] = field(default_factory=list)


def compute_accuracy_stats(days: int = 90) -> AccuracyStats:
    """
    Compute comprehensive accuracy statistics from outcome history.
    Returns AccuracyStats used by reporter and calibrator.
    """
    outcomes = get_completed_outcomes(days)
    stats = AccuracyStats()
    stats.total_forecasts = _count_total_forecasts()
    stats.verified_forecasts = len(outcomes)

    if not outcomes:
        stats.calibration_mode = "collecting"
        return stats

    # ── Overall accuracy by horizon ──
    hits_1d, total_1d = 0, 0
    hits_3d, total_3d = 0, 0
    hits_7d, total_7d = 0, 0

    for o in outcomes:
        if o.get("hit_1d") is not None and o["hit_1d"] >= 0:
            total_1d += 1
            hits_1d += o["hit_1d"]
        if o.get("hit_3d") is not None and o["hit_3d"] >= 0:
            total_3d += 1
            hits_3d += o["hit_3d"]
        if o.get("hit_7d") is not None and o["hit_7d"] >= 0:
            total_7d += 1
            hits_7d += o["hit_7d"]

    stats.accuracy_1d = hits_1d / total_1d if total_1d > 0 else 0
    stats.accuracy_3d = hits_3d / total_3d if total_3d > 0 else 0
    stats.accuracy_7d = hits_7d / total_7d if total_7d > 0 else 0

    # ── Rolling window accuracy ──
    from datetime import datetime, timedelta, timezone
    now = datetime.now(timezone.utc)
    for window, attr_acc, attr_cnt in [
        (7, "accuracy_7day", "count_7day"),
        (30, "accuracy_30day", "count_30day"),
        (90, "accuracy_90day", "count_90day"),
    ]:
        cutoff = (now - timedelta(days=window)).isoformat()
        window_outcomes = [o for o in outcomes if o.get("created_at", "") >= cutoff]
        w_hits = sum(1 for o in window_outcomes if o.get("hit_1d") == 1)
        w_total = sum(1 for o in window_outcomes if o.get("hit_1d") is not None and o["hit_1d"] >= 0)
        setattr(stats, attr_acc, w_hits / w_total if w_total > 0 else 0)
        setattr(stats, attr_cnt, w_total)

    # ── Streak tracking ──
    sorted_outcomes = sorted(outcomes, key=lambda o: o.get("created_at", ""), reverse=True)
    streak = 0
    streak_type = ""
    for o in sorted_outcomes:
        h = o.get("hit_1d")
        if h is None or h < 0:
            continue
        if streak == 0:
            streak = 1
            streak_type = "win" if h == 1 else "loss"
        elif (h == 1 and streak_type == "win") or (h == 0 and streak_type == "loss"):
            streak += 1
        else:
            break
    stats.current_streak = streak if streak_type == "win" else -streak
    stats.streak_type = streak_type

    # ── Confidence calibration ──
    buckets = {"low": (0, 0.4), "medium": (0.4, 0.6), "high": (0.6, 0.8), "very_high": (0.8, 1.01)}
    for name, (lo, hi) in buckets.items():
        bucket_outcomes = [o for o in outcomes
                         if lo <= (o.get("confidence") or 0) < hi
                         and o.get("hit_1d") is not None and o["hit_1d"] >= 0]
        if len(bucket_outcomes) >= 3:
            bucket_hits = sum(1 for o in bucket_outcomes if o["hit_1d"] == 1)
            stats.confidence_calibration[name] = {
                "hit_rate": round(bucket_hits / len(bucket_outcomes), 3),
                "count": len(bucket_outcomes),
            }

    # ── Magnitude tracking ──
    correct_scores = [abs(o["overall_score"]) for o in outcomes if o.get("hit_1d") == 1]
    wrong_scores = [abs(o["overall_score"]) for o in outcomes if o.get("hit_1d") == 0]
    all_moves = [abs(o.get("actual_move_pct_1d", 0) or 0) for o in outcomes if o.get("actual_move_pct_1d")]

    stats.avg_predicted_score_correct = sum(correct_scores) / len(correct_scores) if correct_scores else 0
    stats.avg_predicted_score_wrong = sum(wrong_scores) / len(wrong_scores) if wrong_scores else 0
    stats.avg_actual_move_pct = sum(all_moves) / len(all_moves) if all_moves else 0

    # ── Baseline comparisons ──
    neutral_hits = sum(1 for o in outcomes if o.get("actual_direction_1d") == "neutral")
    momentum_hits = _count_momentum_hits(outcomes)
    my_hits = hits_1d

    stats.beats_always_neutral = (my_hits / total_1d if total_1d else 0) > (neutral_hits / total_1d if total_1d else 0)
    stats.beats_momentum = (my_hits / total_1d if total_1d else 0) > (momentum_hits / total_1d if total_1d else 0)

    # ── VND accuracy ──
    vnd_outcomes = [o for o in outcomes if o.get("vnd_hit_1d") is not None]
    if vnd_outcomes:
        vnd_hits = sum(1 for o in vnd_outcomes if o["vnd_hit_1d"] == 1)
        stats.vnd_accuracy_1d = vnd_hits / len(vnd_outcomes)
        stats.vnd_total = len(vnd_outcomes)

    # ── Per-factor accuracy ──
    stats.factor_accuracy = _compute_factor_accuracy()

    # ── Calibration mode ──
    if stats.verified_forecasts >= MIN_FORECASTS_ACTIVE:
        stats.calibration_mode = "active"
    elif stats.verified_forecasts >= MIN_FORECASTS_SHADOW:
        stats.calibration_mode = "shadow"
    else:
        stats.calibration_mode = "collecting"

    # ── Recent history (last 7 forecasts for report) ──
    stats.recent_history = [
        {
            "date": o.get("created_at", "")[:10],
            "predicted": o.get("jpy_direction", ""),
            "actual": o.get("actual_direction_1d", ""),
            "score": o.get("overall_score", 0),
            "hit": o.get("hit_1d"),
            "move_pct": o.get("actual_move_pct_1d", 0),
        }
        for o in sorted_outcomes[:7]
    ]

    return stats


def _count_total_forecasts() -> int:
    conn = get_connection()
    row = conn.execute("SELECT COUNT(*) as cnt FROM forecasts").fetchone()
    conn.close()
    return row["cnt"] if row else 0


def _count_momentum_hits(outcomes: list[dict]) -> int:
    """Baseline: predict previous day's direction."""
    hits = 0
    prev_dir = None
    for o in sorted(outcomes, key=lambda x: x.get("created_at", "")):
        actual = o.get("actual_direction_1d")
        if prev_dir and actual and actual != "neutral":
            if prev_dir == actual:
                hits += 1
        prev_dir = actual
    return hits


def _compute_factor_accuracy() -> list[FactorAccuracy]:
    """Compute per-factor accuracy from factor_outcomes table."""
    conn = get_connection()
    rows = conn.execute("""
        SELECT factor_group,
               COUNT(*) as total,
               SUM(CASE WHEN hit = 1 THEN 1 ELSE 0 END) as hits,
               SUM(CASE WHEN hit = 0 THEN 1 ELSE 0 END) as misses,
               SUM(CASE WHEN hit = -1 THEN 1 ELSE 0 END) as inconclusive,
               AVG(CASE WHEN hit = 1 THEN ABS(factor_score) END) as avg_score_correct,
               AVG(CASE WHEN hit = 0 THEN ABS(factor_score) END) as avg_score_wrong
        FROM factor_outcomes
        GROUP BY factor_group
    """).fetchall()
    conn.close()

    results = []
    for r in rows:
        group = r["factor_group"]
        name_vi = FACTOR_GROUPS.get(group, {}).get("name_vi", group)
        decisive = r["total"] - (r["inconclusive"] or 0)
        results.append(FactorAccuracy(
            group=group,
            name_vi=name_vi,
            total=r["total"],
            hits=r["hits"] or 0,
            misses=r["misses"] or 0,
            inconclusive=r["inconclusive"] or 0,
            hit_rate=round((r["hits"] or 0) / decisive, 3) if decisive > 0 else 0,
            avg_score_when_correct=round(r["avg_score_correct"] or 0, 2),
            avg_score_when_wrong=round(r["avg_score_wrong"] or 0, 2),
        ))

    return results


# ═══════════════════════════════════════════
# AUTO-CALIBRATOR
# ═══════════════════════════════════════════

def auto_calibrate_weights(run_id: int, stats: AccuracyStats) -> dict[str, float]:
    """
    Auto-calibrate factor weights based on accuracy history.
    Returns the weights to use for this run's scoring.

    Modes:
    - collecting: <10 forecasts, use default weights
    - shadow: 10-29 forecasts, log proposed changes but don't apply
    - active: 30+ forecasts, apply small incremental changes
    """
    default_weights = {k: v["weight"] for k, v in FACTOR_GROUPS.items()}

    if stats.calibration_mode == "collecting":
        logger.info(f"[calibrator] Collecting data ({stats.verified_forecasts}/{MIN_FORECASTS_SHADOW} for shadow mode)")
        return default_weights

    # Load current calibrated weights (or use defaults)
    current_weights = get_latest_calibrated_weights()
    if not current_weights:
        current_weights = default_weights.copy()

    # Compute proposed adjustments
    proposed = _compute_weight_adjustments(current_weights, stats)

    mode = stats.calibration_mode
    logger.info(f"[calibrator] Mode: {mode} ({stats.verified_forecasts} verified forecasts)")

    for group, (old_w, new_w, reason) in proposed.items():
        insert_calibrated_weight(run_id, group, old_w, new_w, reason, mode)
        if mode == "active":
            logger.info(f"  {group}: {old_w:.3f} → {new_w:.3f} ({reason})")
        else:
            logger.info(f"  [shadow] {group}: {old_w:.3f} → {new_w:.3f} ({reason})")

    if mode == "active":
        return {g: proposed[g][1] for g in proposed}
    else:
        return current_weights if current_weights else default_weights


def _compute_weight_adjustments(
    current_weights: dict[str, float],
    stats: AccuracyStats,
) -> dict[str, tuple[float, float, str]]:
    """
    Compute proposed weight adjustments.
    Returns {factor: (old_weight, new_weight, reason)}.
    """
    adjustments = {}

    # Build factor accuracy map
    factor_hit_rates = {fa.group: fa.hit_rate for fa in stats.factor_accuracy}
    factor_totals = {fa.group: fa.total for fa in stats.factor_accuracy}

    overall_hit_rate = stats.accuracy_1d

    for group, old_weight in current_weights.items():
        hit_rate = factor_hit_rates.get(group)
        total = factor_totals.get(group, 0)

        # Skip if insufficient data for this factor
        if total < 5 or hit_rate is None:
            adjustments[group] = (old_weight, old_weight, f"insufficient data ({total} samples)")
            continue

        # Compare factor hit rate to overall accuracy
        delta_from_avg = hit_rate - overall_hit_rate

        # Determine adjustment direction and magnitude
        if delta_from_avg > 0.1:
            # Factor significantly better than average → increase weight
            adj = min(MAX_WEIGHT_CHANGE, delta_from_avg * 0.1)
            reason = f"hit_rate={hit_rate:.1%} > avg={overall_hit_rate:.1%}, +{adj:.3f}"
        elif delta_from_avg < -0.1:
            # Factor significantly worse than average → decrease weight
            adj = max(-MAX_WEIGHT_CHANGE, delta_from_avg * 0.1)
            reason = f"hit_rate={hit_rate:.1%} < avg={overall_hit_rate:.1%}, {adj:.3f}"
        else:
            adj = 0.0
            reason = f"hit_rate={hit_rate:.1%} ≈ avg={overall_hit_rate:.1%}, no change"

        new_weight = max(MIN_WEIGHT, old_weight + adj)
        adjustments[group] = (old_weight, new_weight, reason)

    # Normalize to sum to 1.0
    total_new = sum(v[1] for v in adjustments.values())
    if total_new > 0 and abs(total_new - 1.0) > 0.001:
        for group in adjustments:
            old_w, new_w, reason = adjustments[group]
            normalized = round(new_w / total_new, 4)
            adjustments[group] = (old_w, normalized, reason)

    return adjustments


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    import sys
    sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent.parent))

    stats = compute_accuracy_stats()
    print(f"\n📊 Accuracy Stats:")
    print(f"  Total forecasts: {stats.total_forecasts}")
    print(f"  Verified: {stats.verified_forecasts}")
    print(f"  1d accuracy: {stats.accuracy_1d:.1%}")
    print(f"  3d accuracy: {stats.accuracy_3d:.1%}")
    print(f"  7d accuracy: {stats.accuracy_7d:.1%}")
    print(f"  Streak: {stats.current_streak} ({stats.streak_type})")
    print(f"  Calibration mode: {stats.calibration_mode}")
