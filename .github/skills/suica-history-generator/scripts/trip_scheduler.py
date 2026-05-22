"""Trip scheduler: pick which days have trips, which routes, how many.

Algorithm:
1. For each date in the month, classify as workday / weekend / holiday / off-day.
2. On workdays: apply `weekly_pattern[<weekday>]` → emit 1 PlannedTrip per slot,
   round-trip (outbound + return).
3. On weekends: optionally sample from leisure_pool (count = uniform[low,high]
   per month, distributed across Sat/Sun).
4. Skip Sundays and Japanese national holidays unless explicitly listed in
   weekly_pattern for that day.

Holidays come from `jpholiday` (lightweight, embedded data).
"""
from __future__ import annotations

import calendar
import datetime as dt
import logging
import random
from collections import defaultdict

try:
    import jpholiday  # type: ignore[import-not-found]
    _HOLIDAYS_AVAILABLE = True
except ImportError:
    _HOLIDAYS_AVAILABLE = False

from .models import (
    GeneratorConfig,
    LeisureCandidate,
    PlannedTrip,
    TripType,
    WEEKDAY_NAMES,
)

log = logging.getLogger(__name__)


def _is_jp_holiday(d: dt.date) -> bool:
    if _HOLIDAYS_AVAILABLE:
        try:
            return jpholiday.is_holiday(d)
        except Exception:
            return False
    return False


def _month_dates(month: str) -> list[dt.date]:
    """month = 'YYYY-MM' → list of all dates."""
    y, m = (int(x) for x in month.split("-"))
    _, last_day = calendar.monthrange(y, m)
    return [dt.date(y, m, d) for d in range(1, last_day + 1)]


def _pick_leisure_route(pool: list[LeisureCandidate], rng: random.Random) -> str:
    weights = [c.weight for c in pool]
    return rng.choices([c.route for c in pool], weights=weights, k=1)[0]


class TripScheduler:
    """Phase 2.2 — produces the initial list of PlannedTrip for a month."""

    def __init__(self, config: GeneratorConfig, rng: random.Random | None = None):
        self.config = config
        self.rng = rng or random.Random()

    def plan_month(self, month: str) -> list[PlannedTrip]:
        """Return all PlannedTrips for the given month (unbudgeted)."""
        plans: list[PlannedTrip] = []
        weekend_days: list[dt.date] = []

        for d in _month_dates(month):
            if d in self.config.off_days:
                log.debug("Skip %s (off-day)", d)
                continue
            if _is_jp_holiday(d):
                log.debug("Skip %s (Japanese holiday)", d)
                # Treat as a weekend candidate for leisure trips
                weekend_days.append(d)
                continue

            weekday = WEEKDAY_NAMES[d.weekday()]
            slots = self.config.weekly_pattern.get(weekday, [])
            if slots:
                # Workday — emit round-trip for each slot
                for slot in slots:
                    plans.append(PlannedTrip(date=d, route=slot.route, trip_type=slot.type, direction="outbound"))
                    plans.append(PlannedTrip(date=d, route=slot.route, trip_type=slot.type, direction="return"))
            elif weekday in ("saturday", "sunday"):
                weekend_days.append(d)
            else:
                log.debug("Skip %s (%s has empty weekly_pattern)", d, weekday)

        # Sprinkle leisure trips on weekend_days
        if self.config.leisure_pool and weekend_days:
            low, high = self.config.leisure_monthly_count
            count = self.rng.randint(low, high)
            count = min(count, len(weekend_days))
            chosen_days = self.rng.sample(weekend_days, count)
            for d in chosen_days:
                route = _pick_leisure_route(self.config.leisure_pool, self.rng)
                plans.append(PlannedTrip(date=d, route=route, trip_type=TripType.LEISURE, direction="outbound"))
                plans.append(PlannedTrip(date=d, route=route, trip_type=TripType.LEISURE, direction="return"))
            log.info("Scheduled %d leisure trips on %s", count, sorted(chosen_days))

        plans.sort(key=lambda p: (p.date, 0 if p.direction == "outbound" else 1))
        log.info("Total planned trips: %d (%d round trips)", len(plans), len(plans) // 2)
        return plans

    @staticmethod
    def group_by_date(trips: list[PlannedTrip]) -> dict[dt.date, list[PlannedTrip]]:
        out: dict[dt.date, list[PlannedTrip]] = defaultdict(list)
        for t in trips:
            out[t.date].append(t)
        return dict(out)
