"""gps_import.py — Build a Suica history from Google Timeline GPS data.

Input formats supported:
  * Google Maps Timeline JSON export ("Records.json" from Takeout)
  * Google Maps Timeline KML export (single-day or month bundles)
  * Generic GeoJSON FeatureCollection with point timestamps

Pipeline:
  1. Parse points into (timestamp, lat, lon) tuples.
  2. Smooth and segment by speed: a "train segment" is a contiguous run
     where instantaneous speed is between TRAIN_MIN_KMH and TRAIN_MAX_KMH
     for at least MIN_TRAIN_DURATION_S seconds. (Walking < 8 km/h, train
     30-130 km/h, shinkansen excluded by upper bound.)
  3. Snap the segment endpoints to the nearest known stations (via
     HeartRails by coordinate; cached locally).
  4. Emit a list of (date, from_station, to_station) trips suitable as
     input to TripScheduler / BudgetAllocator / TapBuilder.

Used as a CLI:
    python -m scripts.gps_import Records.json --month 2026-05 --out out/may-from-gps.json

The output JSON can be fed back into generate.py via the --gps-import flag,
or used standalone for forensic analysis ("where did I actually go in May?").
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import logging
import math
import sys
import xml.etree.ElementTree as ET
from dataclasses import asdict, dataclass
from pathlib import Path

log = logging.getLogger("gps_import")

# Train segment detection thresholds
TRAIN_MIN_KMH = 25.0          # > brisk cycling
TRAIN_MAX_KMH = 140.0         # exclude shinkansen + driving on expressway
MIN_TRAIN_DURATION_S = 90     # at least 1.5 minutes — filter out brief overtakes
MAX_GAP_S = 180               # if no point for 3 min, break the segment
MIN_SEGMENT_DISTANCE_KM = 1.5 # don't snap short segments — likely platform meandering


@dataclass(frozen=True, slots=True)
class GpsPoint:
    ts: dt.datetime
    lat: float
    lon: float


@dataclass(frozen=True, slots=True)
class TrainSegment:
    start_ts: dt.datetime
    end_ts: dt.datetime
    start_lat: float
    start_lon: float
    end_lat: float
    end_lon: float
    avg_kmh: float
    distance_km: float


@dataclass(frozen=True, slots=True)
class DetectedTrip:
    date: str          # YYYY-MM-DD
    start_ts: str      # ISO 8601
    end_ts: str
    from_station: str
    to_station: str
    distance_km: float
    avg_kmh: float


# ----------------------------------------------------------------------
# Parsers
# ----------------------------------------------------------------------

def parse_takeout_json(path: Path) -> list[GpsPoint]:
    """Google Takeout 'Records.json' format."""
    data = json.loads(path.read_text(encoding="utf-8"))
    out: list[GpsPoint] = []
    for loc in data.get("locations", []):
        try:
            ts_ms = int(loc.get("timestampMs") or 0)
            if not ts_ms:
                # Some exports use ISO under 'timestamp'
                ts = dt.datetime.fromisoformat(loc["timestamp"].replace("Z", "+00:00"))
            else:
                ts = dt.datetime.fromtimestamp(ts_ms / 1000, tz=dt.timezone.utc)
            lat = float(loc["latitudeE7"]) / 1e7
            lon = float(loc["longitudeE7"]) / 1e7
            out.append(GpsPoint(ts, lat, lon))
        except (KeyError, TypeError, ValueError):
            continue
    return out


def parse_kml(path: Path) -> list[GpsPoint]:
    """KML export (gx:Track elements)."""
    ns = {"kml": "http://www.opengis.net/kml/2.2", "gx": "http://www.google.com/kml/ext/2.2"}
    tree = ET.parse(path)
    out: list[GpsPoint] = []
    for track in tree.findall(".//gx:Track", ns):
        whens = [w.text for w in track.findall("kml:when", ns)]
        coords = [c.text for c in track.findall("gx:coord", ns)]
        for when, coord in zip(whens, coords):
            if not (when and coord):
                continue
            try:
                ts = dt.datetime.fromisoformat(when.replace("Z", "+00:00"))
                parts = coord.split()
                if len(parts) < 2:
                    continue
                lon, lat = float(parts[0]), float(parts[1])
                out.append(GpsPoint(ts, lat, lon))
            except (TypeError, ValueError):
                continue
    return out


def parse_geojson(path: Path) -> list[GpsPoint]:
    data = json.loads(path.read_text(encoding="utf-8"))
    out: list[GpsPoint] = []
    for feat in data.get("features", []):
        geom = feat.get("geometry") or {}
        props = feat.get("properties") or {}
        if geom.get("type") == "Point":
            ts_str = props.get("timestamp") or props.get("time")
            if not ts_str:
                continue
            try:
                ts = dt.datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
                lon, lat = geom["coordinates"][:2]
                out.append(GpsPoint(ts, float(lat), float(lon)))
            except (KeyError, TypeError, ValueError):
                continue
    return out


def load_points(path: Path) -> list[GpsPoint]:
    suffix = path.suffix.lower()
    if suffix == ".json":
        # Try Takeout first, fall back to GeoJSON
        try:
            pts = parse_takeout_json(path)
            if pts:
                return pts
        except Exception:
            pass
        return parse_geojson(path)
    if suffix == ".kml":
        return parse_kml(path)
    raise ValueError(f"Unsupported GPS file type: {suffix}")


# ----------------------------------------------------------------------
# Geo helpers
# ----------------------------------------------------------------------

def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


# ----------------------------------------------------------------------
# Segmentation
# ----------------------------------------------------------------------

def detect_train_segments(points: list[GpsPoint]) -> list[TrainSegment]:
    """Greedy single-pass segmenter.

    A segment starts when a point-to-point speed enters the train band,
    extends while subsequent speeds stay in the band (with smoothing
    tolerance for momentary slowdowns at stations), and ends when speed
    drops below TRAIN_MIN_KMH for >2 consecutive points or the time gap
    exceeds MAX_GAP_S.
    """
    if len(points) < 2:
        return []
    points = sorted(points, key=lambda p: p.ts)
    segments: list[TrainSegment] = []

    i = 0
    n = len(points)
    while i < n - 1:
        a = points[i]
        b = points[i + 1]
        dt_s = (b.ts - a.ts).total_seconds()
        if dt_s <= 0 or dt_s > MAX_GAP_S:
            i += 1
            continue
        dist_km = haversine_km(a.lat, a.lon, b.lat, b.lon)
        kmh = (dist_km / dt_s) * 3600.0
        if not (TRAIN_MIN_KMH <= kmh <= TRAIN_MAX_KMH):
            i += 1
            continue

        # Found a candidate segment start; extend while in-band.
        seg_start = a
        last_in_band = b
        slow_streak = 0
        total_dist = dist_km
        speeds = [kmh]

        j = i + 2
        while j < n:
            prev = points[j - 1]
            cur = points[j]
            dt2 = (cur.ts - prev.ts).total_seconds()
            if dt2 <= 0 or dt2 > MAX_GAP_S:
                break
            d2 = haversine_km(prev.lat, prev.lon, cur.lat, cur.lon)
            v2 = (d2 / dt2) * 3600.0
            total_dist += d2
            speeds.append(v2)
            if v2 > TRAIN_MAX_KMH:
                break  # outside band on the high side -> probably car/highway
            if v2 >= TRAIN_MIN_KMH:
                last_in_band = cur
                slow_streak = 0
            else:
                slow_streak += 1
                if slow_streak >= 2:
                    break
            j += 1

        duration_s = (last_in_band.ts - seg_start.ts).total_seconds()
        if duration_s >= MIN_TRAIN_DURATION_S and total_dist >= MIN_SEGMENT_DISTANCE_KM:
            segments.append(
                TrainSegment(
                    start_ts=seg_start.ts,
                    end_ts=last_in_band.ts,
                    start_lat=seg_start.lat,
                    start_lon=seg_start.lon,
                    end_lat=last_in_band.lat,
                    end_lon=last_in_band.lon,
                    avg_kmh=sum(speeds) / len(speeds),
                    distance_km=total_dist,
                )
            )
            i = j
        else:
            i += 1
    return segments


# ----------------------------------------------------------------------
# Station snapping
# ----------------------------------------------------------------------

def snap_to_stations(segments: list[TrainSegment]) -> list[DetectedTrip]:
    """Use HeartRails nearest_stations() to label segment endpoints.

    Falls back to "(lat,lon)" if no station is within ~1 km.
    """
    try:
        from .apis.heartrails import HeartRailsClient
    except ImportError:
        log.warning("HeartRails client unavailable; emitting raw coordinates only")
        HeartRailsClient = None  # type: ignore

    client = HeartRailsClient() if HeartRailsClient else None
    cache: dict[tuple[float, float], str] = {}

    def nearest(lat: float, lon: float) -> str:
        # Round to ~10m precision for cache reuse
        key = (round(lat, 4), round(lon, 4))
        if key in cache:
            return cache[key]
        if not client:
            cache[key] = f"({lat:.4f},{lon:.4f})"
            return cache[key]
        try:
            stations = client.nearest_stations(lat, lon, limit=1)
        except Exception as e:
            log.debug("nearest_stations failed at (%s,%s): %s", lat, lon, e)
            stations = []
        cache[key] = stations[0].name_kanji if stations else f"({lat:.4f},{lon:.4f})"
        return cache[key]

    out: list[DetectedTrip] = []
    for s in segments:
        a_name = nearest(s.start_lat, s.start_lon)
        b_name = nearest(s.end_lat, s.end_lon)
        if a_name == b_name:
            continue  # snapped to same station -> drop
        out.append(
            DetectedTrip(
                date=s.start_ts.astimezone().date().isoformat(),
                start_ts=s.start_ts.isoformat(),
                end_ts=s.end_ts.isoformat(),
                from_station=a_name,
                to_station=b_name,
                distance_km=round(s.distance_km, 2),
                avg_kmh=round(s.avg_kmh, 1),
            )
        )
    return out


# ----------------------------------------------------------------------
# CLI
# ----------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Detect train trips from Google Timeline GPS data")
    p.add_argument("input", type=Path, help="Records.json / *.kml / *.geojson")
    p.add_argument("--month", default=None, help="Filter to YYYY-MM (optional)")
    p.add_argument("--no-snap", action="store_true", help="Skip station snapping (emit raw coords)")
    p.add_argument("--out", type=Path, default=Path("out/gps-trips.json"))
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args(argv)

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(message)s")

    log.info("Loading %s", args.input)
    points = load_points(args.input)
    log.info("  -> %d GPS points", len(points))
    if args.month:
        points = [pt for pt in points if pt.ts.astimezone().strftime("%Y-%m") == args.month]
        log.info("  -> %d points after month=%s filter", len(points), args.month)

    log.info("Detecting train segments (band %.0f-%.0f km/h, min %ds)…",
             TRAIN_MIN_KMH, TRAIN_MAX_KMH, MIN_TRAIN_DURATION_S)
    segments = detect_train_segments(points)
    log.info("  -> %d train segments", len(segments))

    if args.no_snap:
        trips = [
            DetectedTrip(
                date=s.start_ts.astimezone().date().isoformat(),
                start_ts=s.start_ts.isoformat(),
                end_ts=s.end_ts.isoformat(),
                from_station=f"({s.start_lat:.4f},{s.start_lon:.4f})",
                to_station=f"({s.end_lat:.4f},{s.end_lon:.4f})",
                distance_km=round(s.distance_km, 2),
                avg_kmh=round(s.avg_kmh, 1),
            )
            for s in segments
        ]
    else:
        log.info("Snapping endpoints to stations…")
        trips = snap_to_stations(segments)
    log.info("  -> %d named trips", len(trips))

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps([asdict(t) for t in trips], ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    log.info("Wrote %s", args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
