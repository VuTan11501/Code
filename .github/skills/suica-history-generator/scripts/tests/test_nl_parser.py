"""Tests for nl_parser heuristic parser (no API call, no LLM)."""
from __future__ import annotations

import datetime as dt

import pytest

from scripts.nl_parser import (
    _normalize_station,
    _parse_month,
    _parse_target,
    merge_into_preset,
    parse_heuristic,
    to_cli_command,
)


def test_parse_target_simple():
    assert _parse_target("25000 yen") == 25000
    assert _parse_target("25k") == 25000
    assert _parse_target("25,000") == 25000
    assert _parse_target("2万円") == 20000


def test_parse_target_picks_largest():
    # '5 lần' should not be picked as target (filtered by 1000-1M band)
    assert _parse_target("đi 5 lần, 25000 yen") == 25000


def test_parse_target_none_when_too_small():
    assert _parse_target("đi 5 lần") is None


def test_parse_month_vietnamese():
    today = dt.date(2026, 3, 15)
    assert _parse_month("tháng 5", today) == "2026-05"
    assert _parse_month("tháng 5/2027", today) == "2027-05"


def test_parse_month_iso():
    assert _parse_month("2026-05") == "2026-05"
    assert _parse_month("2026/05") == "2026-05"


def test_normalize_station_romaji():
    assert _normalize_station("Tokyo") == "東京"
    assert _normalize_station("shinjuku") == "新宿"
    # Already kanji: pass-through
    assert _normalize_station("品川") == "品川"


def test_parse_heuristic_commute():
    out = parse_heuristic("tháng 5 đi Tokyo↔Shinjuku hàng ngày, 25000 yên",
                          today=dt.date(2026, 1, 1))
    assert out["month"] == "2026-05"
    assert out["target"] == 25000
    assert any(r["route"] == "東京↔新宿" for r in out["routes"])
    assert out["leisure"] == []


def test_parse_heuristic_with_leisure():
    out = parse_heuristic(
        "tháng 6 Tokyo↔Shinjuku mỗi ngày + cuối tuần Tokyo↔Yokohama 2 lần, 30k",
        today=dt.date(2026, 1, 1),
    )
    assert out["month"] == "2026-06"
    assert out["target"] == 30000
    assert any(r["route"] == "東京↔新宿" for r in out["routes"])
    leisure = out["leisure"]
    assert len(leisure) == 1
    assert leisure[0]["route"] == "東京↔横浜"
    assert leisure[0]["count"] == 2


def test_parse_heuristic_seed():
    out = parse_heuristic("seed=42 tháng 1 Tokyo↔Shinjuku 20k",
                          today=dt.date(2026, 1, 1))
    assert out["seed"] == 42


def test_parse_heuristic_drops_self_loop():
    out = parse_heuristic("tháng 5 đi Tokyo↔Tokyo 20k", today=dt.date(2026, 1, 1))
    assert out["routes"] == []


def test_to_cli_command_minimal():
    parsed = {"month": "2026-05", "target": 25000, "seed": None}
    cmd = to_cli_command(parsed)
    assert "--month 2026-05" in cmd
    assert "--target 25000" in cmd
    assert "--seed" not in cmd


def test_to_cli_command_with_seed():
    parsed = {"month": "2026-05", "target": 25000, "seed": 42}
    cmd = to_cli_command(parsed)
    assert "--seed 42" in cmd


def test_merge_into_preset():
    preset = {"weekly": [{"route": "X↔Y", "type": "commute"}], "other_field": "keep"}
    parsed = {
        "routes": [{"route": "東京↔新宿", "type": "commute"}],
        "leisure": [{"route": "東京↔横浜", "count": 2}],
    }
    merged = merge_into_preset(parsed, preset)
    assert merged["weekly"] == [{"route": "東京↔新宿", "type": "commute"}]
    assert merged["leisure_pool"] == [{"route": "東京↔横浜", "weight": 2}]
    assert merged["other_field"] == "keep"
