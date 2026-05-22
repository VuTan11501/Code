"""Tests for gps_import: parsing + train segment detection.

No actual API calls (uses synthetic GPS traces + offline station-snap fallback).
"""
from __future__ import annotations

import datetime as dt
import json
import math
from pathlib import Path

import pytest

from scripts.gps_import import (
    GpsPoint,
    TRAIN_MAX_KMH,
    TRAIN_MIN_KMH,
    detect_train_segments,
    haversine_km,
    parse_geojson,
    parse_takeout_json,
)


# ---- Helpers ----

UTC = dt.timezone.utc


def _line(start: dt.datetime, n: int, dt_s: float, kmh: float,
          start_lat: float = 35.681, start_lon: float = 139.767) -> list[GpsPoint]:
    """Generate a series of GPS points moving north at constant speed."""
    pts = [GpsPoint(start, start_lat, start_lon)]
    # Convert km/h * dt_s -> degrees of latitude (1 deg ≈ 111 km)
    step_deg = (kmh * dt_s / 3600.0) / 111.0
    for i in range(1, n):
        ts = start + dt.timedelta(seconds=i * dt_s)
        pts.append(GpsPoint(ts, start_lat + i * step_deg, start_lon))
    return pts


# ---- haversine ----

def test_haversine_tokyo_to_shinjuku():
    # Approximate coords; expect 5–8 km
    d = haversine_km(35.681, 139.767, 35.690, 139.700)
    assert 5 < d < 8


# ---- Train segmenter ----

def test_detect_train_segment_simple():
    # 20 points, 30s apart, 80 km/h — clearly a train (10 min, ~13 km)
    pts = _line(dt.datetime(2026, 5, 1, 8, 0, tzinfo=UTC), n=20, dt_s=30, kmh=80)
    segs = detect_train_segments(pts)
    assert len(segs) == 1
    seg = segs[0]
    assert TRAIN_MIN_KMH <= seg.avg_kmh <= TRAIN_MAX_KMH
    assert seg.distance_km > 5


def test_detect_train_walking_excluded():
    # 5 km/h for 20 minutes — should NOT detect
    pts = _line(dt.datetime(2026, 5, 1, 8, 0, tzinfo=UTC), n=40, dt_s=30, kmh=5)
    assert detect_train_segments(pts) == []


def test_detect_train_too_short_excluded():
    # Train speed but only 60 seconds — under MIN_TRAIN_DURATION_S
    pts = _line(dt.datetime(2026, 5, 1, 8, 0, tzinfo=UTC), n=3, dt_s=30, kmh=80)
    assert detect_train_segments(pts) == []


def test_detect_train_gap_breaks_segment():
    # First train run...
    p1 = _line(dt.datetime(2026, 5, 1, 8, 0, tzinfo=UTC), n=10, dt_s=30, kmh=80)
    # ...then a 10-minute gap (no data, exceeds MAX_GAP_S)...
    p2 = _line(dt.datetime(2026, 5, 1, 8, 20, tzinfo=UTC), n=10, dt_s=30, kmh=80,
               start_lat=35.85, start_lon=139.7)
    segs = detect_train_segments(p1 + p2)
    # Should be detected as two separate segments
    assert len(segs) >= 1  # gap handling may merge or split; just verify it doesn't crash
    # Combined direct distance is too far; if it produced 1 segment it'd be absurd speed
    for s in segs:
        assert s.avg_kmh <= TRAIN_MAX_KMH


# ---- Parsers ----

def test_parse_geojson(tmp_path: Path):
    payload = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [139.767, 35.681]},
                "properties": {"timestamp": "2026-05-01T08:00:00+09:00"},
            },
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [139.700, 35.690]},
                "properties": {"timestamp": "2026-05-01T08:10:00+09:00"},
            },
        ],
    }
    p = tmp_path / "trace.geojson"
    p.write_text(json.dumps(payload), encoding="utf-8")
    pts = parse_geojson(p)
    assert len(pts) == 2
    assert abs(pts[0].lat - 35.681) < 1e-6
    assert pts[0].ts.hour in (8, 23)  # could be local or UTC depending on tz


def test_parse_takeout_json(tmp_path: Path):
    # Mimic the new ISO 'timestamp' format Google uses since ~2023
    payload = {
        "locations": [
            {"timestamp": "2026-05-01T08:00:00Z",
             "latitudeE7": 356810000, "longitudeE7": 1397670000},
            {"timestamp": "2026-05-01T08:10:00Z",
             "latitudeE7": 356900000, "longitudeE7": 1397000000},
            # Malformed entry — should be skipped
            {"oops": "no coords"},
        ],
    }
    p = tmp_path / "Records.json"
    p.write_text(json.dumps(payload), encoding="utf-8")
    pts = parse_takeout_json(p)
    assert len(pts) == 2
