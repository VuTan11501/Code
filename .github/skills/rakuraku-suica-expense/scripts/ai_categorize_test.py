"""Tests for ai_categorize.py — mock AI + optional real AI smoke test.

Usage:
    python ai_categorize_test.py
    GH_PAT=<token> python ai_categorize_test.py   # also runs real AI test
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

# Ensure script dir is importable
sys.path.insert(0, str(Path(__file__).parent))
import ai_categorize  # noqa: E402

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

SAMPLE_TRIPS = [
    {"date": "2026/06/02", "weekday": "月", "from": "Tokyo", "to": "Shinjuku", "amount": 200},
    {"date": "2026/06/02", "weekday": "月", "from": "Shinjuku", "to": "Tokyo", "amount": 200},
    {"date": "2026/06/07", "weekday": "土", "from": "Asakusa", "to": "Ueno", "amount": 170},
    {"date": "2026/06/03", "weekday": "火", "from": "Shinjuku", "to": "Yoyogi", "amount": 140},
    {"date": "2026/06/05", "weekday": "木", "from": "Shibuya", "to": "Roppongi", "amount": 200},
]

MOCK_AI_RESPONSE = [
    {"idx": 0, "category": "commute", "purpose": "通勤 (Tokyo→Shinjuku)", "include": True, "confidence": 0.95},
    {"idx": 1, "category": "commute", "purpose": "通勤 (帰宅)", "include": True, "confidence": 0.95},
    {"idx": 2, "category": "personal", "purpose": "週末私用", "include": False, "confidence": 0.85},
    {"idx": 3, "category": "personal", "purpose": "昼食外出", "include": False, "confidence": 0.75},
    {"idx": 4, "category": "unknown", "purpose": "不明（要確認）", "include": True, "confidence": 0.55},
]


# ---------------------------------------------------------------------------
# Mock test
# ---------------------------------------------------------------------------


def test_with_mock_ai():
    """Test merge logic with mocked AI response."""
    print("=" * 60)
    print("TEST: test_with_mock_ai")
    print("=" * 60)

    # Test merge_annotations directly
    result = ai_categorize.merge_annotations(SAMPLE_TRIPS, MOCK_AI_RESPONSE)

    assert len(result) == 5, f"Expected 5 trips, got {len(result)}"
    assert result[0]["category"] == "commute"
    assert result[0]["include"] is True
    assert result[0]["confidence"] == 0.95
    assert result[0]["purpose"] == "通勤 (Tokyo→Shinjuku)"
    assert result[0]["from"] == "Tokyo"  # original fields preserved

    assert result[2]["category"] == "personal"
    assert result[2]["include"] is False

    assert result[4]["confidence"] == 0.55

    # Test with missing annotations (safe defaults)
    partial_ann = [MOCK_AI_RESPONSE[0], MOCK_AI_RESPONSE[2]]  # only idx 0 and 2
    result2 = ai_categorize.merge_annotations(SAMPLE_TRIPS, partial_ann)
    assert result2[1]["category"] == "unknown"  # missing → safe default
    assert result2[1]["include"] is True
    assert result2[1]["confidence"] == 0.0

    # Test with invalid category
    bad_ann = [{"idx": 0, "category": "invalid", "purpose": "x", "include": True, "confidence": 0.9}]
    result3 = ai_categorize.merge_annotations(SAMPLE_TRIPS[:1], bad_ann)
    assert result3[0]["category"] == "unknown"  # corrected
    assert result3[0]["confidence"] == 0.0  # reset

    # Test full pipeline with mocked call_ai
    tmp_dir = Path(__file__).parent
    tmp_input = tmp_dir / "_test_trips.json"
    tmp_output = tmp_dir / "_test_trips_annotated.json"

    try:
        with open(tmp_input, "w", encoding="utf-8") as f:
            json.dump(SAMPLE_TRIPS, f)

        with patch.dict(os.environ, {"GH_PAT": "fake-token"}):
            with patch("ai_categorize.call_ai", return_value=MOCK_AI_RESPONSE):
                ai_categorize.categorize(
                    tmp_input, tmp_output, "gpt-4o-mini", 50, dry_run=False
                )

        assert tmp_output.exists(), "Output file not created"
        with open(tmp_output, "r", encoding="utf-8") as f:
            output_data = json.load(f)
        assert len(output_data) == 5
        assert output_data[0]["category"] == "commute"
        assert output_data[2]["include"] is False

    finally:
        if tmp_input.exists():
            tmp_input.unlink()
        if tmp_output.exists():
            tmp_output.unlink()

    print("✅ test_with_mock_ai PASSED\n")


# ---------------------------------------------------------------------------
# Real AI test (requires GH_PAT)
# ---------------------------------------------------------------------------


def test_real_ai():
    """Smoke test with real AI — verify all trips get a category."""
    print("=" * 60)
    print("TEST: test_real_ai (live API)")
    print("=" * 60)

    tmp_dir = Path(__file__).parent
    tmp_input = tmp_dir / "_test_trips_real.json"
    tmp_output = tmp_dir / "_test_trips_real_annotated.json"

    try:
        with open(tmp_input, "w", encoding="utf-8") as f:
            json.dump(SAMPLE_TRIPS, f)

        ai_categorize.categorize(
            tmp_input, tmp_output, os.environ.get("AI_MODEL", "gpt-4o-mini"),
            50, dry_run=False
        )

        assert tmp_output.exists(), "Output file not created"
        with open(tmp_output, "r", encoding="utf-8") as f:
            output_data = json.load(f)

        assert len(output_data) == 5, f"Expected 5 trips, got {len(output_data)}"

        all_categorized = all(
            t.get("category") in ("commute", "personal", "business", "unknown")
            for t in output_data
        )
        assert all_categorized, "Not all trips got a valid category"

        print("\nResults:")
        for t in output_data:
            flag = "✓" if t["confidence"] >= 0.7 else "⚠️"
            print(f"  {flag} [{t['category']:8s}] {t['date']} {t['from']}→{t['to']} "
                  f"conf={t['confidence']:.2f} purpose={t['purpose']}")

        print("\n✅ test_real_ai PASSED\n")

    finally:
        if tmp_input.exists():
            tmp_input.unlink()
        if tmp_output.exists():
            tmp_output.unlink()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    test_with_mock_ai()

    if os.environ.get("GH_PAT"):
        test_real_ai()
    else:
        print("ℹ️  GH_PAT not set — skipping real AI test.")

    print("\nAll tests completed.")
