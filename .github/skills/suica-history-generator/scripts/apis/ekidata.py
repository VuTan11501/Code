"""ekidata.jp bulk CSV importer (free, no API key, nationwide ~9,000 stations).

ekidata.jp publishes 4 CSV files we use:
- station20XX.csv      : station_cd, station_name, lon, lat, line_cd, pref_cd, ...
- line20XX.csv         : line_cd, company_cd, line_name, ...
- company20XX.csv      : company_cd, company_name, ...
- join20XX.csv         : line_cd, station_cd1, station_cd2  (adjacency, for routing)

ekidata.jp requires free registration to download CSVs. After downloading and
unzipping, pass the directory path to `bootstrap` and we normalize the data
into a local SQLite database with FTS5 indices on station name (kanji + kana),
so subsequent station resolution is offline and instant.

Usage:
    1) Register at https://www.ekidata.jp/download/  (free, email only)
    2) Download station*.csv, line*.csv, company*.csv, join*.csv ZIPs
    3) Unzip to e.g. ~/ekidata-csv/
    4) python -m scripts.apis.ekidata bootstrap ~/ekidata-csv/
    5) python -m scripts.apis.ekidata find 東京

If you cannot/won't register, use HeartRails or OSM-Overpass as the station
source instead — both work without any key.

Data source: http://www.ekidata.jp/  (CC BY 4.0)
"""
from __future__ import annotations

import csv
import io
import logging
import sqlite3
import sys
from pathlib import Path
from typing import Iterable

from ._protocols import Station

log = logging.getLogger(__name__)

DEFAULT_DB = Path(__file__).resolve().parents[2] / "data" / "stations.sqlite"
DATA_DIR = DEFAULT_DB.parent

# Note: ekidata.jp does not expose stable public URLs; CSVs require free
# registration to download. We accept user-provided local paths instead.
# Recommended download flow is documented in SKILL.md section "Bootstrap".
SCHEMA = """
CREATE TABLE IF NOT EXISTS stations (
    station_cd   INTEGER PRIMARY KEY,
    station_g_cd INTEGER,
    name         TEXT NOT NULL,
    name_kana    TEXT,
    line_cd      INTEGER,
    pref_cd      INTEGER,
    post         TEXT,
    address      TEXT,
    lon          REAL,
    lat          REAL,
    open_ymd     TEXT,
    close_ymd    TEXT,
    e_status     INTEGER
);
CREATE INDEX IF NOT EXISTS ix_stations_name ON stations(name);
CREATE INDEX IF NOT EXISTS ix_stations_group ON stations(station_g_cd);
CREATE INDEX IF NOT EXISTS ix_stations_line ON stations(line_cd);

CREATE TABLE IF NOT EXISTS lines (
    line_cd      INTEGER PRIMARY KEY,
    company_cd   INTEGER,
    line_name    TEXT NOT NULL,
    line_name_k  TEXT,
    line_name_h  TEXT,
    line_color_c TEXT,
    line_color_t TEXT,
    line_type    INTEGER,
    lon          REAL,
    lat          REAL,
    zoom         INTEGER,
    e_status     INTEGER
);

CREATE TABLE IF NOT EXISTS companies (
    company_cd     INTEGER PRIMARY KEY,
    rr_cd          INTEGER,
    company_name   TEXT NOT NULL,
    company_name_k TEXT,
    company_name_h TEXT,
    company_name_r TEXT,
    company_url    TEXT,
    company_type   INTEGER,
    e_status       INTEGER
);

CREATE TABLE IF NOT EXISTS line_joins (
    line_cd      INTEGER,
    station_cd1  INTEGER,
    station_cd2  INTEGER,
    PRIMARY KEY (line_cd, station_cd1, station_cd2)
);

CREATE VIRTUAL TABLE IF NOT EXISTS stations_fts
USING fts5(name, name_kana, content='stations', content_rowid='station_cd');
"""

TIMEOUT = 30.0


# ---------------------------------------------------------------------------
# Bootstrap (download + load CSVs)
# ---------------------------------------------------------------------------


def _read_csv(path: Path) -> str:
    """Read a CSV file. ekidata CSVs are sometimes Shift-JIS, sometimes UTF-8."""
    raw = path.read_bytes()
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return raw.decode("cp932")


def _iter_csv(text: str) -> Iterable[dict]:
    reader = csv.DictReader(io.StringIO(text))
    yield from reader


def _connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.executescript(SCHEMA)
    return conn


def bootstrap(csv_dir: Path, db_path: Path = DEFAULT_DB) -> None:
    """Load ekidata CSVs from `csv_dir` into local SQLite.

    Expected files in csv_dir (any 'free' release, e.g. 20240426):
      - company*.csv  -> companies
      - line*.csv     -> lines
      - station*.csv  -> stations
      - join*.csv     -> line_joins
    """
    csv_dir = Path(csv_dir)
    if not csv_dir.exists():
        raise FileNotFoundError(f"CSV directory not found: {csv_dir}")

    def _find(prefix: str) -> Path:
        candidates = sorted(csv_dir.glob(f"{prefix}*.csv"))
        if not candidates:
            raise FileNotFoundError(f"No {prefix}*.csv in {csv_dir}")
        return candidates[-1]  # latest dated file

    conn = _connect(db_path)
    try:
        # --- companies ---
        comp_text = _read_csv(_find("company"))
        conn.executemany(
            """INSERT OR REPLACE INTO companies VALUES (
                :company_cd,:rr_cd,:company_name,:company_name_k,
                :company_name_h,:company_name_r,:company_url,
                :company_type,:e_status)""",
            ({k: r.get(k) for k in (
                "company_cd","rr_cd","company_name","company_name_k",
                "company_name_h","company_name_r","company_url",
                "company_type","e_status")} for r in _iter_csv(comp_text)),
        )
        log.info("Loaded companies")

        # --- lines ---
        line_text = _read_csv(_find("line"))
        conn.executemany(
            """INSERT OR REPLACE INTO lines VALUES (
                :line_cd,:company_cd,:line_name,:line_name_k,:line_name_h,
                :line_color_c,:line_color_t,:line_type,:lon,:lat,:zoom,
                :e_status)""",
            ({k: r.get(k) for k in (
                "line_cd","company_cd","line_name","line_name_k","line_name_h",
                "line_color_c","line_color_t","line_type","lon","lat","zoom",
                "e_status")} for r in _iter_csv(line_text)),
        )
        log.info("Loaded lines")

        # --- stations ---
        stn_text = _read_csv(_find("station"))
        conn.executemany(
            """INSERT OR REPLACE INTO stations VALUES (
                :station_cd,:station_g_cd,:station_name,:station_name_k,
                :line_cd,:pref_cd,:post,:address,:lon,:lat,:open_ymd,
                :close_ymd,:e_status)""",
            ({
                "station_cd":   r["station_cd"],
                "station_g_cd": r.get("station_g_cd"),
                "station_name": r["station_name"],
                "station_name_k": r.get("station_name_k"),
                "line_cd":      r.get("line_cd"),
                "pref_cd":      r.get("pref_cd"),
                "post":         r.get("post"),
                "address":      r.get("address"),
                "lon":          r.get("lon"),
                "lat":          r.get("lat"),
                "open_ymd":     r.get("open_ymd"),
                "close_ymd":    r.get("close_ymd"),
                "e_status":     r.get("e_status"),
            } for r in _iter_csv(stn_text)),
        )
        # Rebuild FTS
        conn.execute("DELETE FROM stations_fts")
        conn.execute(
            "INSERT INTO stations_fts(rowid, name, name_kana) "
            "SELECT station_cd, name, COALESCE(name_kana,'') FROM stations"
        )
        log.info("Loaded stations + FTS index")

        # --- joins ---
        join_text = _read_csv(_find("join"))
        conn.executemany(
            "INSERT OR REPLACE INTO line_joins VALUES (:line_cd,:station_cd1,:station_cd2)",
            ({k: r.get(k) for k in ("line_cd","station_cd1","station_cd2")}
             for r in _iter_csv(join_text)),
        )
        log.info("Loaded line_joins")

        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Query helpers
# ---------------------------------------------------------------------------


class EkidataClient:
    """Read-only client over a pre-loaded `stations.sqlite`."""

    name = "ekidata"

    def __init__(self, db_path: Path = DEFAULT_DB):
        if not db_path.exists():
            raise RuntimeError(
                f"Station DB not found at {db_path}. "
                "Run `python -m scripts.apis.ekidata bootstrap` first."
            )
        self._db = sqlite3.connect(db_path)
        self._db.row_factory = sqlite3.Row

    def find_station(self, name: str, limit: int = 5) -> list[Station]:
        # Try FTS first (handles partial matches), fall back to LIKE.
        rows = self._db.execute(
            """SELECT s.station_cd, s.name, s.name_kana, s.lat, s.lon,
                      s.line_cd, l.line_name, l.company_cd, c.company_name
               FROM stations_fts ft
               JOIN stations s ON s.station_cd = ft.rowid
               LEFT JOIN lines l ON l.line_cd = s.line_cd
               LEFT JOIN companies c ON c.company_cd = l.company_cd
               WHERE stations_fts MATCH ?
                 AND COALESCE(s.e_status, 0) = 0
               LIMIT ?""",
            (f'"{name}"', limit * 4),  # over-fetch then dedupe by station_g_cd
        ).fetchall()

        if not rows:
            rows = self._db.execute(
                """SELECT s.station_cd, s.name, s.name_kana, s.lat, s.lon,
                          s.line_cd, l.line_name, l.company_cd, c.company_name
                   FROM stations s
                   LEFT JOIN lines l ON l.line_cd = s.line_cd
                   LEFT JOIN companies c ON c.company_cd = l.company_cd
                   WHERE s.name LIKE ?
                     AND COALESCE(s.e_status, 0) = 0
                   LIMIT ?""",
                (f"%{name}%", limit * 4),
            ).fetchall()

        # Group by station name (one station has multiple lines)
        out: list[Station] = []
        seen: dict[str, list[sqlite3.Row]] = {}
        for r in rows:
            seen.setdefault(r["name"], []).append(r)
        for stn_name, group in list(seen.items())[:limit]:
            first = group[0]
            out.append(Station(
                code=str(first["station_cd"]),
                name_kanji=stn_name,
                name_kana=first["name_kana"] or "",
                lat=float(first["lat"] or 0),
                lon=float(first["lon"] or 0),
                line_codes=tuple(str(r["line_cd"]) for r in group if r["line_cd"]),
                operators=tuple(sorted({r["company_name"] for r in group if r["company_name"]})),
            ))
        return out

    def close(self) -> None:
        self._db.close()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    args = argv if argv is not None else sys.argv[1:]
    if not args:
        print("usage: python -m scripts.apis.ekidata {bootstrap|find} [args]")
        return 2

    cmd = args[0]
    if cmd == "bootstrap":
        if len(args) < 2:
            print("usage: ... bootstrap <csv-dir>")
            print("Download CSVs from https://www.ekidata.jp/download/ (free register)")
            print("and pass the unzipped directory path here.")
            return 2
        bootstrap(Path(args[1]))
        print(f"OK: loaded into {DEFAULT_DB}")
        return 0
    if cmd == "find":
        if len(args) < 2:
            print("usage: ... find <station-name>")
            return 2
        c = EkidataClient()
        try:
            res = c.find_station(args[1])
            for s in res:
                print(f"  - {s.name_kanji} ({s.name_kana})  "
                      f"lines={','.join(s.line_codes[:3])} ops={','.join(s.operators)}  "
                      f"@ ({s.lat:.4f},{s.lon:.4f})")
        finally:
            c.close()
        return 0
    print(f"unknown command: {cmd}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
