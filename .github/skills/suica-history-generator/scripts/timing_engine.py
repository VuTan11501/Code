"""Timing engine: assign realistic timestamps + IC fares to PlannedTrips.

Per trip type:
- COMMUTE outbound: morning_commute base ± Gaussian(sigma_min)
- COMMUTE return:   evening_commute base ± Gaussian(sigma_min)
- LEISURE outbound: uniform in weekend_leisure.window
- LEISURE return:   uniform in (outbound + 2h .. window_end)
- BUSINESS: similar to commute but base = 09:00

Duration between tap_in and tap_out: route resolver supplies duration_min;
if unknown, we estimate 15min for short trips (<¥250), 25min for medium
(<¥600), 45min for long.

Guarantees:
- No two trips on the same date overlap (we sort and shift forward if needed)
- Tap-out always > tap-in by at least 5 minutes
- No taps before 05:00 or after 01:00 (last-train safety)
"""
from __future__ import annotations

import datetime as dt
import logging
import random
from typing import Callable

from .models import GeneratorConfig, PlannedTrip, TimedTrip, TripType

log = logging.getLogger(__name__)

FareLookup = Callable[[PlannedTrip], int]
DurationLookup = Callable[[PlannedTrip], int]   # minutes, may be 0


def _parse_hm(s: str) -> tuple[int, int]:
    h, m = s.split(":")
    return int(h), int(m)


def _clip(t: dt.time, lo: dt.time = dt.time(5, 0), hi: dt.time = dt.time(1, 0)) -> dt.time:
    """Last-train cutoff: 5:00 ≤ t ≤ 25:00 (i.e., 01:00 next day, modeled as ≤23:59 here)."""
    # Treat 'hi=01:00' as 'before 25:00'; for simplicity clamp into [05:00, 23:59].
    if t < lo:
        return lo
    if t > dt.time(23, 59):
        return dt.time(23, 59)
    return t


def _estimate_duration(fare_yen: int) -> int:
    if fare_yen < 250:
        return 15
    if fare_yen < 600:
        return 25
    if fare_yen < 1200:
        return 45
    return 75


class TimingEngine:
    """Phase 2.3 — assigns timestamps and computes fare per trip."""

    def __init__(self, config: GeneratorConfig, rng: random.Random | None = None):
        self.config = config
        self.rng = rng or random.Random()

    def assign(
        self,
        trips: list[PlannedTrip],
        fare_of: FareLookup,
        duration_of: DurationLookup | None = None,
    ) -> list[TimedTrip]:
        """Convert plans to timed trips, sorted by tap_in_at."""
        timed_by_date: dict[dt.date, list[TimedTrip]] = {}
        for t in trips:
            fare = self._effective_fare(t, fare_of)
            dur = (duration_of(t) if duration_of else 0) or _estimate_duration(fare or fare_of(t))
            tap_in = self._sample_tap_in(t)
            tap_out = self._combine(t.date, tap_in) + dt.timedelta(minutes=dur)
            timed = TimedTrip(
                plan=t,
                tap_in_at=self._combine(t.date, tap_in),
                tap_out_at=tap_out,
                fare_yen=fare,
            )
            timed_by_date.setdefault(t.date, []).append(timed)

        # De-overlap per day: sort by tap_in_at then shift each subsequent
        # tap_in forward to be ≥ previous tap_out + 5min.
        result: list[TimedTrip] = []
        for d, day_trips in timed_by_date.items():
            day_trips.sort(key=lambda x: x.tap_in_at)
            for i in range(1, len(day_trips)):
                prev_out = day_trips[i - 1].tap_out_at
                if day_trips[i].tap_in_at <= prev_out + dt.timedelta(minutes=5):
                    shift_to = prev_out + dt.timedelta(minutes=self.rng.randint(5, 25))
                    duration = day_trips[i].tap_out_at - day_trips[i].tap_in_at
                    # Clamp into last-train cutoff
                    if shift_to.time() > dt.time(23, 30):
                        log.warning("Cannot fit trip on %s after %s (last-train cutoff)",
                                    d, prev_out)
                        continue
                    day_trips[i] = day_trips[i].model_copy(update={
                        "tap_in_at": shift_to,
                        "tap_out_at": shift_to + duration,
                    })
            result.extend(day_trips)
        result.sort(key=lambda x: x.tap_in_at)
        return result

    # ---------------- helpers ----------------

    def _effective_fare(self, trip: PlannedTrip, fare_of: FareLookup) -> int:
        """Apply teiki: free if covered."""
        for tk in self.config.teiki:
            if tk.covers(trip.route, trip.date):
                return 0
        return fare_of(trip)

    def _sample_tap_in(self, trip: PlannedTrip) -> dt.time:
        t = self.config.timing
        if trip.trip_type == TripType.COMMUTE:
            spec = t.morning_commute if trip.direction == "outbound" else t.evening_commute
            base_h, base_m = _parse_hm(spec["base"])
            sigma = float(spec.get("sigma_min", 8))
            offset = self.rng.gauss(0, sigma)
            return self._add_minutes(dt.time(base_h, base_m), offset)
        if trip.trip_type == TripType.LEISURE:
            win = t.weekend_leisure["window"]
            start_h, start_m = _parse_hm(win[0])
            end_h,   end_m   = _parse_hm(win[1])
            start_min = start_h * 60 + start_m
            end_min   = end_h   * 60 + end_m
            if trip.direction == "outbound":
                pick = self.rng.uniform(start_min, max(start_min, end_min - 180))
            else:
                pick = self.rng.uniform(start_min + 120, end_min)
            return dt.time(int(pick) // 60 % 24, int(pick) % 60)
        # BUSINESS or fallback
        base = dt.time(9, 0) if trip.direction == "outbound" else dt.time(18, 0)
        return self._add_minutes(base, self.rng.gauss(0, 10))

    @staticmethod
    def _add_minutes(t: dt.time, minutes_offset: float) -> dt.time:
        total = t.hour * 60 + t.minute + int(minutes_offset)
        total = max(5 * 60, min(23 * 60 + 59, total))
        return dt.time(total // 60, total % 60)

    @staticmethod
    def _combine(d: dt.date, t: dt.time) -> dt.datetime:
        return dt.datetime.combine(d, t)
