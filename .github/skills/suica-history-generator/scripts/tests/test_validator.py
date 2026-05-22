"""Tests for validator rules."""
import datetime as dt

import pytest

from scripts.models import MonthlyHistory, TapEntry, TapKind
from scripts.validator import Severity, validate


def _make_history(entries: list[TapEntry], initial: int = 3000, final: int | None = None) -> MonthlyHistory:
    return MonthlyHistory(
        month="2026-05",
        initial_balance=initial,
        final_balance=final if final is not None else (entries[-1].balance_yen if entries else initial),
        total_spent=0,
        total_charged=0,
        entries=entries,
    )


def _e(kind, h, m, station, fare, bal, day=1):
    return TapEntry(
        kind=kind,
        at=dt.datetime(2026, 5, day, h, m),
        station=station,
        fare_yen=fare,
        balance_yen=bal,
    )


def test_clean_history_passes():
    h = _make_history([
        _e(TapKind.IN,  8, 30, "東京", 0,   3000),
        _e(TapKind.OUT, 8, 55, "新宿", 253, 2747),
    ])
    r = validate(h)
    assert r.ok, f"Expected clean, got: {[i.rule for i in r.errors]}"


def test_negative_balance_caught():
    h = _make_history([
        _e(TapKind.IN,  8, 30, "東京", 0,    50),
        _e(TapKind.OUT, 8, 55, "新宿", 253, -203),
    ], initial=50)
    r = validate(h)
    assert not r.ok
    assert any(i.rule == "balance_nonneg" for i in r.errors)


def test_balance_arithmetic_mismatch():
    h = _make_history([
        _e(TapKind.IN,  8, 30, "東京", 0,   3000),
        _e(TapKind.OUT, 8, 55, "新宿", 253, 9999),
    ])
    r = validate(h)
    assert any(i.rule == "balance_arithmetic" for i in r.errors)


def test_double_in_no_out():
    h = _make_history([
        _e(TapKind.IN, 8,  30, "東京",  0, 3000),
        _e(TapKind.IN, 8,  35, "新宿",  0, 3000),
    ])
    r = validate(h)
    assert any(i.rule == "in_out_pairing" for i in r.errors)


def test_out_without_in():
    h = _make_history([
        _e(TapKind.OUT, 8, 55, "新宿", 253, 2747),
    ])
    r = validate(h)
    assert any(i.rule == "in_out_pairing" for i in r.errors)


def test_overlap_caught():
    h = _make_history([
        _e(TapKind.IN,  9,  0, "東京", 0,   3000),
        _e(TapKind.OUT, 9, 30, "新宿", 253, 2747),
        _e(TapKind.IN,  9, 20, "新宿", 0,   2747, day=1),
        _e(TapKind.OUT, 9, 45, "東京", 253, 2494, day=1),
    ])
    r = validate(h)
    bad = [i.rule for i in r.errors]
    assert "no_overlap" in bad or "chronological" in bad


def test_last_train_warning():
    h = _make_history([
        _e(TapKind.IN,  23, 45, "東京", 0,   3000),
        _e(TapKind.OUT, 23, 59, "新宿", 253, 2747),
    ])
    r = validate(h)
    assert any(i.rule == "last_train" for i in r.warnings)


def test_topup_synced_with_in():
    h = _make_history([
        _e(TapKind.AUTO, 8, 30, "東京",  3000, 6000),
        _e(TapKind.IN,   8, 30, "東京", 0,    6000),
        _e(TapKind.OUT,  8, 55, "新宿", 253, 5747),
    ])
    r = validate(h)
    topup_issues = [i for i in r.issues if i.rule == "topup_realism"]
    assert not topup_issues, f"Unexpected topup issues: {[i.message for i in topup_issues]}"


def test_topup_at_wrong_station_warns():
    h = _make_history([
        _e(TapKind.AUTO, 8, 30, "横浜",  3000, 6000),
        _e(TapKind.IN,   8, 30, "東京", 0,    6000),
        _e(TapKind.OUT,  8, 55, "新宿", 253, 5747),
    ])
    r = validate(h)
    assert any(i.rule == "topup_realism" for i in r.warnings)


def test_too_many_trips_per_day():
    entries = []
    bal = 10000
    for i in range(8):
        h_t, m_t = 6 + i, 0
        entries.append(_e(TapKind.IN,  h_t, m_t, "東京", 0, bal))
        bal -= 253
        entries.append(_e(TapKind.OUT, h_t, m_t + 25, "新宿", 253, bal))
    h = _make_history(entries, initial=10000)
    r = validate(h)
    assert any(i.rule == "trips_per_day" for i in r.warnings)
