"""odpt.org client — Public Transportation Open Data Center for Tokyo metropolitan.

Free with registration. Sign up at: https://developer.odpt.org/users/sign_up

Endpoints used (Challenge dataset, free tier):
  - https://api-public.odpt.org/api/v4/odpt:Station         (station master)
  - https://api-public.odpt.org/api/v4/odpt:Railway         (line info)
  - https://api-public.odpt.org/api/v4/odpt:Station:Passenger
                                                            (passenger fare matrix; not all operators provide)

Authentication: pass `acl:consumerKey=<KEY>` as a query parameter.

Cache:
  Responses are JSON-LD lists. We cache by (endpoint, sorted-params) tuple
  to local SQLite (data/odpt_cache.sqlite) with TTL=7 days. Station/fare data
  changes rarely; this dramatically reduces request volume.

Limitations:
  - Free tier covers Tokyo metropolitan only (JR East within Kanto, Metro,
    Toei, Tokyu, Keio, Odakyu, Tobu, Seibu, etc.). Outside Kanto -> empty.
  - Fare matrix coverage varies: Metro/Toei provide full station-pair
    matrices; JR East provides line-level only. Use cross-validation with
    other providers.
"""
from __future__ import annotations

import json
import logging
import os
import sqlite3
import time
from pathlib import Path
from typing import Any

import requests

from ._protocols import FareQuote, Station

log = logging.getLogger(__name__)

BASE_URL = "https://api-public.odpt.org/api/v4"
TIMEOUT = 10.0
CACHE_DB = Path(__file__).resolve().parent.parent.parent / "data" / "odpt_cache.sqlite"
CACHE_TTL_SECONDS = 7 * 24 * 3600  # 7 days

ENV_KEY = "ODPT_API_KEY"


def _ensure_cache() -> sqlite3.Connection:
    CACHE_DB.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(CACHE_DB)
    conn.execute(
        """CREATE TABLE IF NOT EXISTS odpt_cache (
              cache_key TEXT PRIMARY KEY,
              fetched_at INTEGER NOT NULL,
              payload TEXT NOT NULL
           )"""
    )
    return conn


class OdptClient:
    """odpt.org client with disk caching. Requires ODPT_API_KEY env var."""

    name = "odpt"

    def __init__(self, api_key: str | None = None, session: requests.Session | None = None):
        self._key = api_key or os.environ.get(ENV_KEY)
        if not self._key:
            log.warning(
                "%s env var not set. odpt requests will fail. "
                "Register at https://developer.odpt.org/users/sign_up", ENV_KEY,
            )
        self._session = session or requests.Session()

    # ------------------------------------------------------------------
    # Internal HTTP + cache
    # ------------------------------------------------------------------
    def _cache_key(self, endpoint: str, params: dict[str, Any]) -> str:
        items = sorted((k, str(v)) for k, v in params.items() if k != "acl:consumerKey")
        return endpoint + "?" + "&".join(f"{k}={v}" for k, v in items)

    def _get(self, endpoint: str, **params: Any) -> list[dict]:
        if not self._key:
            return []
        params["acl:consumerKey"] = self._key
        cache_key = self._cache_key(endpoint, params)

        conn = _ensure_cache()
        try:
            row = conn.execute(
                "SELECT fetched_at, payload FROM odpt_cache WHERE cache_key=?", (cache_key,)
            ).fetchone()
            if row and time.time() - row[0] < CACHE_TTL_SECONDS:
                return json.loads(row[1])

            url = f"{BASE_URL}/{endpoint}"
            try:
                resp = self._session.get(url, params=params, timeout=TIMEOUT)
                resp.raise_for_status()
            except requests.RequestException as e:
                log.warning("odpt %s failed: %s", endpoint, e)
                # If we have a stale cached value, return it rather than nothing
                if row:
                    return json.loads(row[1])
                return []

            data = resp.json() if resp.text else []
            conn.execute(
                "INSERT OR REPLACE INTO odpt_cache(cache_key, fetched_at, payload) VALUES (?, ?, ?)",
                (cache_key, int(time.time()), json.dumps(data, ensure_ascii=False)),
            )
            conn.commit()
            return data
        finally:
            conn.close()

    # ------------------------------------------------------------------
    # StationProvider
    # ------------------------------------------------------------------
    def find_station(self, name: str, limit: int = 5) -> list[Station]:
        """Find stations by Japanese title (substring match server-side)."""
        rows = self._get("odpt:Station", **{"dc:title": name})
        out: list[Station] = []
        for s in rows[:limit]:
            try:
                out.append(
                    Station(
                        code=s.get("owl:sameAs", s.get("@id", "")),
                        name_kanji=s.get("dc:title", ""),
                        name_kana=(s.get("odpt:stationTitle") or {}).get("ja-Hrkt", ""),
                        lat=float(s.get("geo:lat", 0)),
                        lon=float(s.get("geo:long", 0)),
                        line_codes=(s.get("odpt:railway", ""),),
                        operators=(_operator_from_id(s.get("odpt:operator", "")),),
                    )
                )
            except (KeyError, TypeError, ValueError) as e:
                log.debug("Skipping malformed odpt station %r: %s", s, e)
        return out

    # ------------------------------------------------------------------
    # FareProvider
    # ------------------------------------------------------------------
    def quote_fare(self, origin: Station, dest: Station) -> FareQuote | None:
        """Look up an IC fare between two stations via odpt:Station:Passenger.

        Note: This dataset is sparse. JR East does not publish station-pair
        fares; only Metro / Toei / private rails do. Returns None if no
        matching fare entry is found.
        """
        # The Station:Passenger feed is indexed by fromStation
        rows = self._get("odpt:Station:Passenger", **{"odpt:fromStation": origin.code})
        for row in rows:
            if row.get("odpt:toStation") == dest.code:
                fare = row.get("odpt:icCardFare") or row.get("odpt:ticketFare")
                if fare is not None:
                    try:
                        return FareQuote(
                            provider=self.name,
                            ic_fare_yen=int(fare),
                            confidence=0.95,
                            notes=f"odpt:{row.get('owl:sameAs', '')}",
                        )
                    except (TypeError, ValueError):
                        continue
        return None


def _operator_from_id(op_id: str) -> str:
    """Map odpt operator IRI ('odpt.Operator:JR-East') to display name."""
    if not op_id:
        return ""
    short = op_id.rsplit(":", 1)[-1]
    return {
        "JR-East": "JR東日本",
        "TokyoMetro": "東京メトロ",
        "Toei": "東京都交通局",
        "Tokyu": "東急電鉄",
        "Keio": "京王電鉄",
        "Odakyu": "小田急電鉄",
        "Tobu": "東武鉄道",
        "Seibu": "西武鉄道",
        "Keikyu": "京急電鉄",
        "Keisei": "京成電鉄",
        "JR-Central": "JR東海",
    }.get(short, short)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    c = OdptClient()
    if not c._key:
        print(f"Set {ENV_KEY} env var first. Register: https://developer.odpt.org/users/sign_up")
        raise SystemExit(1)
    rs = c.find_station("東京")
    print(f"Found {len(rs)} stations:")
    for s in rs:
        print(f"  - {s.name_kanji} ({s.operators[0] if s.operators else 'n/a'}) {s.code}")
