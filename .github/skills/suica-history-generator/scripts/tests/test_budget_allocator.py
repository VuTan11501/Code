"""Tests for BudgetAllocator convergence to target."""
import datetime as dt
import random

import pytest

from scripts.budget_allocator import BudgetAllocator
from scripts.models import (
    GeneratorConfig, LeisureCandidate, PlannedTrip, TripType, WeeklySlot,
)


def _config():
    return GeneratorConfig(
        weekly_pattern={"monday": [WeeklySlot(route="東京↔新宿", type=TripType.COMMUTE)]},
        leisure_pool=[
            LeisureCandidate(route="東京↔横浜", weight=1),
            LeisureCandidate(route="新宿↔渋谷", weight=1),
        ],
    )


def _fare_for_trip(t: PlannedTrip) -> int:
    table = {"東京↔新宿": 253, "東京↔横浜": 595, "新宿↔渋谷": 178}
    return table.get(t.route, 300)


def _trip(date, route, ttype=TripType.COMMUTE, direction="outbound"):
    return PlannedTrip(date=date, route=route, trip_type=ttype, direction=direction)


def test_pads_under_budget():
    trips = [
        _trip(dt.date(2026, 5, 4), "東京↔新宿", direction="outbound"),
        _trip(dt.date(2026, 5, 4), "東京↔新宿", direction="return"),
    ]
    rng = random.Random(42)
    out = BudgetAllocator(_config(), rng, tolerance_yen=200).adjust(
        trips, target_yen=2000, fare_of=_fare_for_trip,
    )
    total = sum(_fare_for_trip(t) for t in out)
    assert 1800 <= total <= 2200, f"Expected near 2000, got {total}"
    assert len([t for t in out if t.trip_type == TripType.COMMUTE]) == 2


def test_trims_over_budget():
    trips = [
        _trip(dt.date(2026, 5, 4), "東京↔新宿", TripType.COMMUTE, "outbound"),
        _trip(dt.date(2026, 5, 4), "東京↔新宿", TripType.COMMUTE, "return"),
    ]
    for i in range(10):
        d = dt.date(2026, 5, 2 + (i % 4))
        trips.append(_trip(d, "東京↔横浜", TripType.LEISURE, "outbound"))
        trips.append(_trip(d, "東京↔横浜", TripType.LEISURE, "return"))

    rng = random.Random(42)
    out = BudgetAllocator(_config(), rng, tolerance_yen=200).adjust(
        trips, target_yen=1500, fare_of=_fare_for_trip,
    )
    total = sum(_fare_for_trip(t) for t in out)
    assert any(t.trip_type == TripType.COMMUTE for t in out)
    assert total <= 1700, f"Failed to trim, got {total}"


def test_no_leisure_pool_cannot_pad():
    cfg = GeneratorConfig(
        weekly_pattern={"monday": [WeeklySlot(route="東京↔新宿", type=TripType.COMMUTE)]},
        leisure_pool=[],
    )
    trips = [
        _trip(dt.date(2026, 5, 4), "東京↔新宿", TripType.COMMUTE, "outbound"),
        _trip(dt.date(2026, 5, 4), "東京↔新宿", TripType.COMMUTE, "return"),
    ]
    rng = random.Random(42)
    out = BudgetAllocator(cfg, rng, tolerance_yen=100).adjust(
        trips, target_yen=10000, fare_of=_fare_for_trip,
    )
    total = sum(_fare_for_trip(t) for t in out)
    assert total == 506
