"""OSM Overpass API client — fully offline-capable station bulk-import.

The Overpass API is a free, no-key public endpoint that lets you query
OpenStreetMap data. We use it to pull every `railway=station` node in Japan
(or a smaller bbox if specified) into our local SQLite DB.

Pros over ekidata:
- No registration needed
- Always up to date (OSM is community-maintained)
- Nationwide
Cons:
- Slower bulk pull (~30-60s for full Japan, ~5s for Kanto bbox)
- No fare data (still need a fare provider on top)
- Some stations lack the `name:ja` tag (we fall back to `name`)

Usage:
    python -m scripts.apis.overpass bootstrap            # full Japan
    python -m scripts.apis.overpass bootstrap --kanto    # bbox 35.0..36.5N, 138.5..140.5E
    python -m scripts.apis.overpass find 東京
"""
from __future__ import annotations

import logging
import sqlite3
import sys
from pathlib import Path

import requests

from ._protocols import Station

log = logging.getLogger(__name__)

OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",  # mirror
]
TIMEOUT = 120.0

DEFAULT_DB = Path(__file__).resolve().parents[2] / "data" / "stations_osm.sqlite"

SCHEMA = """
CREATE TABLE IF NOT EXISTS osm_stations (
    osm_id      INTEGER PRIMARY KEY,
    name_ja     TEXT,
    name_en     TEXT,
    operator    TEXT,
    network     TEXT,
    railway     TEXT,
    lat         REAL,
    lon         REAL
);
CREATE INDEX IF NOT EXISTS ix_osm_name ON osm_stations(name_ja);
CREATE VIRTUAL TABLE IF NOT EXISTS osm_stations_fts
USING fts5(name_ja, name_en, content='osm_stations', content_rowid='osm_id');
"""

# --- bbox presets ---
BBOXES = {
    "japan": (24.0, 122.9, 45.7, 153.9),
    "kanto": (34.9, 138.5, 36.6, 141.0),
    "kansai": (33.5, 134.0, 35.7, 136.3),
    "chubu":  (34.5, 136.4, 37.5, 138.5),
}


def _query(south: float, west: float, north: float, east: float) -> dict:
    q = f"""
    [out:json][timeout:120];
    (
      node["railway"="station"]({south},{west},{north},{east});
      node["railway"="halt"]({south},{west},{north},{east});
    );
    out body;
    """.strip()
    last_err: Exception | None = None
    for url in OVERPASS_ENDPOINTS:
        try:
            log.info("Overpass query bbox=(%g,%g,%g,%g) via %s", south, west, north, east, url)
            r = requests.post(url, data={"data": q}, timeout=TIMEOUT)
            r.raise_for_status()
            return r.json()
        except requests.RequestException as e:
            last_err = e
            log.warning("Overpass endpoint %s failed: %s, trying next", url, e)
    raise RuntimeError(f"All Overpass endpoints failed; last: {last_err}")


def _connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.executescript(SCHEMA)
    return conn


def bootstrap(region: str = "japan", db_path: Path = DEFAULT_DB) -> int:
    """Pull OSM stations for the region. Returns count loaded."""
    if region not in BBOXES:
        raise ValueError(f"Unknown region {region!r}, expected one of {list(BBOXES)}")
    south, west, north, east = BBOXES[region]
    data = _query(south, west, north, east)
    elements = data.get("elements", [])
    log.info("Got %d stations from Overpass", len(elements))

    conn = _connect(db_path)
    try:
        rows = []
        for el in elements:
            tags = el.get("tags", {}) or {}
            name_ja = tags.get("name:ja") or tags.get("name", "")
            rows.append((
                el["id"],
                name_ja,
                tags.get("name:en", ""),
                tags.get("operator", ""),
                tags.get("network", ""),
                tags.get("railway", ""),
                el.get("lat"),
                el.get("lon"),
            ))
        conn.executemany(
            "INSERT OR REPLACE INTO osm_stations VALUES (?,?,?,?,?,?,?,?)", rows,
        )
        conn.execute("DELETE FROM osm_stations_fts")
        conn.execute(
            "INSERT INTO osm_stations_fts(rowid, name_ja, name_en) "
            "SELECT osm_id, COALESCE(name_ja,''), COALESCE(name_en,'') FROM osm_stations"
        )
        conn.commit()
        return len(rows)
    finally:
        conn.close()


class OverpassClient:
    """Read-only client over the OSM stations SQLite DB."""

    name = "overpass-osm"

    def __init__(self, db_path: Path = DEFAULT_DB):
        if not db_path.exists():
            raise RuntimeError(
                f"OSM DB not found at {db_path}. "
                "Run `python -m scripts.apis.overpass bootstrap [japan|kanto|...]` first."
            )
        self._db = sqlite3.connect(db_path)
        self._db.row_factory = sqlite3.Row

    def find_station(self, name: str, limit: int = 5) -> list[Station]:
        rows = self._db.execute(
            """SELECT osm_id, name_ja, name_en, operator, network, lat, lon
               FROM osm_stations_fts ft
               JOIN osm_stations s ON s.osm_id = ft.rowid
               WHERE osm_stations_fts MATCH ?
               LIMIT ?""",
            (f'"{name}"', limit),
        ).fetchall()
        if not rows:
            rows = self._db.execute(
                """SELECT osm_id, name_ja, name_en, operator, network, lat, lon
                   FROM osm_stations
                   WHERE name_ja LIKE ? OR name_en LIKE ?
                   LIMIT ?""",
                (f"%{name}%", f"%{name}%", limit),
            ).fetchall()
        return [
            Station(
                code=f"osm:{r['osm_id']}",
                name_kanji=r["name_ja"] or r["name_en"] or "",
                name_kana="",
                lat=float(r["lat"] or 0),
                lon=float(r["lon"] or 0),
                line_codes=(r["network"] or "",) if r["network"] else (),
                operators=(r["operator"] or "",) if r["operator"] else (),
            )
            for r in rows
        ]

    def close(self) -> None:
        self._db.close()


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    args = argv if argv is not None else sys.argv[1:]
    if not args:
        print("usage: python -m scripts.apis.overpass {bootstrap|find} [args]")
        return 2
    cmd = args[0]
    if cmd == "bootstrap":
        region = "japan"
        for a in args[1:]:
            if a.startswith("--"):
                region = a.lstrip("-")
        n = bootstrap(region=region)
        print(f"OK: loaded {n} stations from region={region}")
        return 0
    if cmd == "find":
        if len(args) < 2:
            print("usage: ... find <station-name>")
            return 2
        c = OverpassClient()
        try:
            for s in c.find_station(args[1]):
                print(f"  - {s.name_kanji}  operator={','.join(s.operators)}  "
                      f"@ ({s.lat:.4f},{s.lon:.4f})  [osm {s.code}]")
        finally:
            c.close()
        return 0
    print(f"unknown command: {cmd}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
