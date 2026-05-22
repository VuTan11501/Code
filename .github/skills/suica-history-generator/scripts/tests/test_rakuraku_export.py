"""Tests for rakuraku_export schema."""
import datetime as dt

from scripts.models import MonthlyHistory, TapEntry, TapKind
from scripts.rakuraku_export import history_to_trips


def _h(entries):
    return MonthlyHistory(
        month="2026-05",
        initial_balance=3000,
        final_balance=entries[-1].balance_yen if entries else 3000,
        total_spent=0,
        total_charged=0,
        entries=entries,
    )


def test_in_out_pair_emits_trip():
    h = _h([
        TapEntry(kind=TapKind.IN,  at=dt.datetime(2026, 5, 1, 8, 30),
                 station="東京", fare_yen=0,   balance_yen=3000),
        TapEntry(kind=TapKind.OUT, at=dt.datetime(2026, 5, 1, 8, 55),
                 station="新宿", fare_yen=253, balance_yen=2747),
    ])
    trips = history_to_trips(h)
    assert trips == [{
        "date": "2026/05/01",
        "weekday": "金",
        "from": "東京",
        "to":   "新宿",
        "amount": 253,
    }]


def test_zero_fare_excluded():
    h = _h([
        TapEntry(kind=TapKind.IN,  at=dt.datetime(2026, 5, 1, 8, 30),
                 station="東京", fare_yen=0, balance_yen=3000),
        TapEntry(kind=TapKind.OUT, at=dt.datetime(2026, 5, 1, 8, 55),
                 station="新宿", fare_yen=0, balance_yen=3000),
    ])
    assert history_to_trips(h) == []


def test_same_station_excluded():
    h = _h([
        TapEntry(kind=TapKind.IN,  at=dt.datetime(2026, 5, 1, 8, 30),
                 station="東京", fare_yen=0, balance_yen=3000),
        TapEntry(kind=TapKind.OUT, at=dt.datetime(2026, 5, 1, 8, 35),
                 station="東京", fare_yen=0, balance_yen=3000),
    ])
    assert history_to_trips(h) == []


def test_autotopup_excluded():
    h = _h([
        TapEntry(kind=TapKind.AUTO, at=dt.datetime(2026, 5, 1, 8, 30),
                 station="東京", fare_yen=3000, balance_yen=6000),
        TapEntry(kind=TapKind.IN,   at=dt.datetime(2026, 5, 1, 8, 30),
                 station="東京", fare_yen=0,    balance_yen=6000),
        TapEntry(kind=TapKind.OUT,  at=dt.datetime(2026, 5, 1, 8, 55),
                 station="新宿", fare_yen=253,  balance_yen=5747),
    ])
    trips = history_to_trips(h)
    assert len(trips) == 1
    assert trips[0]["amount"] == 253


def test_weekday_japanese():
    days = [
        (dt.datetime(2026, 5, 4, 8, 30),  "月"),
        (dt.datetime(2026, 5, 5, 8, 30),  "火"),
        (dt.datetime(2026, 5, 10, 8, 30), "日"),
    ]
    for d, expected in days:
        h = _h([
            TapEntry(kind=TapKind.IN,  at=d, station="東京", fare_yen=0, balance_yen=3000),
            TapEntry(kind=TapKind.OUT, at=d + dt.timedelta(minutes=25),
                     station="新宿", fare_yen=253, balance_yen=2747),
        ])
        trips = history_to_trips(h)
        assert trips[0]["weekday"] == expected, f"{d.date()} got {trips[0]['weekday']}, want {expected}"
