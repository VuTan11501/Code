"""
Outcome Verifier - Fetches actual market data for past predictions.
Compares predicted direction with actual USD/JPY and JPY/VND movements.
Runs at the START of each pipeline before generating new forecasts.
"""
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

import yfinance as yf

from data.db import (
    get_pending_outcomes, update_outcome,
    get_completed_outcomes, insert_factor_outcome,
    get_connection,
)

logger = logging.getLogger("jpy_forecast")

# Direction threshold: moves < NEUTRAL_THRESHOLD% are considered neutral
NEUTRAL_THRESHOLD_PCT = 0.3

# Horizons to verify
HORIZONS = {
    "1d": 1,
    "3d": 3,
    "7d": 7,
}


def _get_price_at_date(symbol: str, target_date: datetime) -> Optional[float]:
    """
    Fetch closing price at or after target_date.
    Handles weekends/holidays by looking forward up to 3 days.
    """
    try:
        start = target_date.strftime("%Y-%m-%d")
        end = (target_date + timedelta(days=4)).strftime("%Y-%m-%d")
        data = yf.download(symbol, start=start, end=end, progress=False)
        if data.empty:
            return None
        # Use first available close after target date
        close = data["Close"]
        if hasattr(close, "iloc"):
            return float(close.iloc[0])
        return None
    except Exception as e:
        logger.warning(f"[verifier] Failed to get {symbol} at {target_date}: {e}")
        return None


def _determine_direction(base_price: float, actual_price: float) -> tuple[str, float]:
    """
    Determine actual JPY direction from USD/JPY movement.
    Returns (direction, move_pct).
    USD/JPY up → JPY weaker; USD/JPY down → JPY stronger.
    """
    if base_price <= 0:
        return "neutral", 0.0

    move_pct = ((actual_price - base_price) / base_price) * 100

    if abs(move_pct) < NEUTRAL_THRESHOLD_PCT:
        return "neutral", move_pct
    elif move_pct > 0:
        return "weaker", move_pct  # USD/JPY up → JPY weaker
    else:
        return "stronger", move_pct  # USD/JPY down → JPY stronger


def _check_hit(predicted_direction: str, actual_direction: str) -> int:
    """
    Check if prediction was correct.
    Returns 1 (hit), 0 (miss), or -1 (actual was neutral, inconclusive).
    """
    if actual_direction == "neutral":
        # If we predicted neutral too, it's a hit; otherwise inconclusive
        return 1 if predicted_direction == "neutral" else -1

    return 1 if predicted_direction == actual_direction else 0


def verify_past_predictions() -> dict:
    """
    Check all pending forecasts and fill in actual outcomes.
    Returns summary stats of verification run.
    """
    pending = get_pending_outcomes()
    if not pending:
        logger.info("[verifier] No pending outcomes to verify")
        return {"verified": 0, "skipped": 0}

    logger.info(f"[verifier] Checking {len(pending)} pending forecasts...")
    now = datetime.now(timezone.utc)
    verified = 0
    skipped = 0

    for p in pending:
        forecast_id = p["forecast_id"]
        forecast_time = datetime.fromisoformat(p["created_at"])

        # Make timezone-aware if needed
        if forecast_time.tzinfo is None:
            forecast_time = forecast_time.replace(tzinfo=timezone.utc)

        base_price = p["usdjpy_at_forecast"]
        base_jpyvnd = p.get("jpyvnd_at_forecast", 0) or 0
        predicted = p["jpy_direction"]

        updates = {}

        for horizon_key, days in HORIZONS.items():
            # Check if we already have this horizon
            col = f"usdjpy_after_{horizon_key}"
            if p.get(col) is not None:
                continue

            target_time = forecast_time + timedelta(days=days)

            # Only verify if enough time has passed
            if now < target_time + timedelta(hours=6):
                continue

            # Fetch USD/JPY
            usdjpy_actual = _get_price_at_date("JPY=X", target_time)
            if usdjpy_actual is None:
                continue

            actual_dir, move_pct = _determine_direction(base_price, usdjpy_actual)
            hit = _check_hit(predicted, actual_dir)

            updates[f"usdjpy_after_{horizon_key}"] = usdjpy_actual
            updates[f"actual_direction_{horizon_key}"] = actual_dir
            updates[f"hit_{horizon_key}"] = hit
            updates[f"actual_move_pct_{horizon_key}"] = round(move_pct, 4)
            updates[f"evaluated_at_{horizon_key}"] = now.isoformat()

            # JPY/VND for 1d and 7d
            if horizon_key in ("1d", "7d") and base_jpyvnd > 0:
                jpyvnd_actual = _get_cross_rate_at_date(target_time)
                if jpyvnd_actual:
                    updates[f"jpyvnd_after_{horizon_key}"] = jpyvnd_actual
                    if horizon_key == "1d":
                        vnd_dir, _ = _determine_vnd_direction(base_jpyvnd, jpyvnd_actual)
                        updates["vnd_hit_1d"] = 1 if vnd_dir == p.get("vnd_direction", "") else 0

        if updates:
            updates["verified_at"] = now.isoformat()
            update_outcome(forecast_id, **updates)
            verified += 1

            # Also update factor-level outcomes for 1d results
            if "hit_1d" in updates:
                _record_factor_outcomes(forecast_id, updates.get("actual_move_pct_1d", 0))
        else:
            skipped += 1

    result = {"verified": verified, "skipped": skipped, "total_pending": len(pending)}
    logger.info(f"[verifier] Done: verified={verified}, skipped={skipped}")
    return result


def _get_cross_rate_at_date(target_date: datetime) -> Optional[float]:
    """Compute JPY/VND cross rate = USD/VND / USD/JPY."""
    try:
        start = target_date.strftime("%Y-%m-%d")
        end = (target_date + timedelta(days=4)).strftime("%Y-%m-%d")

        usdjpy = yf.download("JPY=X", start=start, end=end, progress=False)
        usdvnd = yf.download("VND=X", start=start, end=end, progress=False)

        if usdjpy.empty or usdvnd.empty:
            return None

        jpy_val = float(usdjpy["Close"].iloc[0])
        vnd_val = float(usdvnd["Close"].iloc[0])

        if jpy_val > 0:
            return round(vnd_val / jpy_val, 2)
        return None
    except Exception:
        return None


def _determine_vnd_direction(base_rate: float, actual_rate: float) -> tuple[str, float]:
    """Direction for JPY/VND: up = 1 JPY buys more VND."""
    if base_rate <= 0:
        return "sideways", 0.0
    move_pct = ((actual_rate - base_rate) / base_rate) * 100
    if abs(move_pct) < 0.5:
        return "sideways", move_pct
    elif move_pct > 0:
        return "up", move_pct
    else:
        return "down", move_pct


def _record_factor_outcomes(forecast_id: int, actual_move_pct_1d: float):
    """Record per-factor hit/miss based on 1d actual move."""
    conn = get_connection()
    try:
        rows = conn.execute(
            """SELECT factor_group, score FROM factor_scores
               WHERE run_id = (SELECT run_id FROM forecasts WHERE id = ?)""",
            (forecast_id,)
        ).fetchall()

        if not rows:
            return

        for row in rows:
            group = row["factor_group"]
            score = row["score"]

            # Factor direction
            if score > 0.3:
                factor_dir = "stronger"
            elif score < -0.3:
                factor_dir = "weaker"
            else:
                factor_dir = "neutral"

            # Actual direction from move
            if abs(actual_move_pct_1d) < NEUTRAL_THRESHOLD_PCT:
                actual_dir = "neutral"
            elif actual_move_pct_1d > 0:
                actual_dir = "weaker"
            else:
                actual_dir = "stronger"

            # Signed alignment: positive = factor agreed with reality
            import math
            sign_score = math.copysign(1, score) if abs(score) > 0.1 else 0
            sign_actual = math.copysign(1, -actual_move_pct_1d) if abs(actual_move_pct_1d) > 0.1 else 0
            alignment = sign_score * sign_actual

            hit = 1 if factor_dir == actual_dir else (0 if actual_dir != "neutral" else -1)

            insert_factor_outcome(forecast_id, group, score, factor_dir, alignment, hit)

    finally:
        conn.close()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    import sys
    sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent.parent))
    from data.db import init_db
    init_db()
    result = verify_past_predictions()
    print(f"Verification result: {result}")
