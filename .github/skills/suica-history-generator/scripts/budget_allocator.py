"""Budget allocator: adjust planned trips so total fare hits target ± tolerance.

Inputs:
  - List[PlannedTrip] from TripScheduler
  - Total fare each trip would cost (round-tripped & teiki applied) — passed in
  - Target ¥ amount + tolerance

Strategy:
  - Compute baseline total = sum of plan fares
  - If baseline > target by more than tolerance:
      drop leisure trips (random) until baseline ≤ target+tolerance
  - If baseline < target - tolerance:
      add extra leisure trips (sampled from leisure_pool) until baseline ≥ target-tolerance
  - Commute trips are never dropped (they're the user's actual commute schedule)

Returns the adjusted list of PlannedTrips.
"""
from __future__ import annotations

import logging
import random
from typing import Callable

from .models import GeneratorConfig, LeisureCandidate, PlannedTrip, TripType

log = logging.getLogger(__name__)

FareLookup = Callable[[PlannedTrip], int]


class BudgetAllocator:
    """Phase 2.1 — adjusts trip list to hit target ¥ amount."""

    def __init__(self, config: GeneratorConfig, rng: random.Random | None = None,
                 tolerance_yen: int = 500):
        self.config = config
        self.rng = rng or random.Random()
        self.tolerance = tolerance_yen

    def total(self, trips: list[PlannedTrip], fare_of: FareLookup) -> int:
        return sum(fare_of(t) for t in trips)

    def adjust(
        self,
        trips: list[PlannedTrip],
        target_yen: int,
        fare_of: FareLookup,
        max_iterations: int = 100,
    ) -> list[PlannedTrip]:
        trips = list(trips)
        cur_total = self.total(trips, fare_of)
        log.info("Initial trip total: ¥%d  (target=¥%d ±¥%d)",
                 cur_total, target_yen, self.tolerance)

        # Helper: leisure trips are round-trip pairs sharing a date+route
        def leisure_pairs() -> list[list[int]]:
            """Return groups of indices that form one leisure round-trip."""
            groups: dict[tuple, list[int]] = {}
            for i, t in enumerate(trips):
                if t.trip_type == TripType.LEISURE:
                    groups.setdefault((t.date, t.route), []).append(i)
            return [v for v in groups.values() if len(v) == 2]

        # --- Reduce if over budget ---
        if cur_total > target_yen + self.tolerance:
            pairs = leisure_pairs()
            self.rng.shuffle(pairs)
            for pair in pairs:
                if cur_total <= target_yen + self.tolerance:
                    break
                pair_fare = sum(fare_of(trips[i]) for i in pair)
                # mark for removal
                for i in pair:
                    trips[i] = None  # type: ignore[assignment]
                cur_total -= pair_fare
            trips = [t for t in trips if t is not None]
            log.info("After leisure trimming: ¥%d", cur_total)

        # --- Add leisure if under budget ---
        elif cur_total < target_yen - self.tolerance and self.config.leisure_pool:
            iters = 0
            stalled = 0
            while cur_total < target_yen - self.tolerance and iters < max_iterations:
                iters += 1
                candidate = self._random_leisure_route()
                if candidate is None:
                    break
                candidate_date = self._pick_extra_leisure_date(trips)
                if candidate_date is None:
                    log.info("All weekend slots full — stopping leisure padding")
                    break
                ob = PlannedTrip(date=candidate_date, route=candidate,
                                 trip_type=TripType.LEISURE, direction="outbound")
                rt = PlannedTrip(date=candidate_date, route=candidate,
                                 trip_type=TripType.LEISURE, direction="return")
                added = fare_of(ob) + fare_of(rt)
                # Avoid overshooting: try a few more candidates first
                if cur_total + added > target_yen + self.tolerance:
                    stalled += 1
                    if stalled < 20:
                        continue
                trips.extend([ob, rt])
                cur_total += added
                stalled = 0
            log.info("After leisure padding (%d iters): ¥%d", iters, cur_total)

        log.info("Final trip total: ¥%d  (diff=¥%+d)", cur_total, cur_total - target_yen)
        trips.sort(key=lambda p: (p.date, 0 if p.direction == "outbound" else 1))
        return trips

    # ---------------- helpers ----------------

    def _random_leisure_route(self) -> str | None:
        if not self.config.leisure_pool:
            return None
        weights = [c.weight for c in self.config.leisure_pool]
        return self.rng.choices(
            [c.route for c in self.config.leisure_pool], weights=weights, k=1)[0]

    def _pick_extra_leisure_date(self, trips: list[PlannedTrip]):
        """Pick a weekend day, preferring days that don't already have leisure trips."""
        if not trips:
            return None
        any_date = trips[0].date
        import calendar
        import datetime as dt
        _, last = calendar.monthrange(any_date.year, any_date.month)
        weekends = [
            dt.date(any_date.year, any_date.month, d)
            for d in range(1, last + 1)
            if dt.date(any_date.year, any_date.month, d).weekday() >= 5
        ]
        if not weekends:
            return None

        # Count existing leisure round-trips per date (already-used days)
        leisure_count: dict[dt.date, int] = {}
        for t in trips:
            if t.trip_type == TripType.LEISURE and t.direction == "outbound":
                leisure_count[t.date] = leisure_count.get(t.date, 0) + 1

        MAX_LEISURE_PER_DAY = 2
        # Try empty days first, then days with <2 leisure round-trips
        empty = [d for d in weekends if d not in leisure_count]
        if empty:
            return self.rng.choice(empty)
        available = [d for d in weekends if leisure_count.get(d, 0) < MAX_LEISURE_PER_DAY]
        if available:
            return self.rng.choice(available)
        return None  # all weekends full, give up rather than pile on
