"""HeartRails Express API client.

Free, no API key required. Nationwide coverage. Endpoint:
  http://express.heartrails.com/api/json?method=...

Methods used:
- getStations: by line / by GPS / by name

Limitations:
- No fare data (need to combine with another provider)
- HTTP only (not HTTPS); use with caution on sensitive networks
"""
from __future__ import annotations

import logging
from typing import Any

import requests

from ._protocols import Station, StationProvider

log = logging.getLogger(__name__)

BASE_URL = "http://express.heartrails.com/api/json"
TIMEOUT = 8.0


class HeartRailsClient:
    name = "heartrails"

    def __init__(self, session: requests.Session | None = None):
        self._session = session or requests.Session()

    def _get(self, **params: Any) -> dict:
        resp = self._session.get(BASE_URL, params=params, timeout=TIMEOUT)
        resp.raise_for_status()
        return resp.json().get("response", {})

    def find_station(self, name: str, limit: int = 5) -> list[Station]:
        """Find stations matching the given name (substring match)."""
        try:
            data = self._get(method="getStations", name=name)
        except requests.RequestException as e:
            log.warning("HeartRails getStations(%s) failed: %s", name, e)
            return []

        stations_raw = data.get("station", [])
        out: list[Station] = []
        for s in stations_raw[:limit]:
            try:
                out.append(
                    Station(
                        code=f"heartrails:{s['name']}:{s.get('line', '')}",
                        name_kanji=s["name"],
                        name_kana="",
                        lat=float(s.get("y", 0)),
                        lon=float(s.get("x", 0)),
                        line_codes=(s.get("line", ""),),
                        operators=(_operator_from_line(s.get("line", "")),),
                    )
                )
            except (KeyError, TypeError, ValueError) as e:
                log.debug("Skipping malformed station %r: %s", s, e)
        return out

    def nearest_stations(self, lat: float, lon: float, limit: int = 3) -> list[Station]:
        """Find stations within 1km of given coordinates."""
        try:
            data = self._get(method="getStations", x=lon, y=lat)
        except requests.RequestException as e:
            log.warning("HeartRails nearest_stations failed: %s", e)
            return []
        return [
            Station(
                code=f"heartrails:{s['name']}:{s.get('line', '')}",
                name_kanji=s["name"],
                lat=float(s.get("y", 0)),
                lon=float(s.get("x", 0)),
                line_codes=(s.get("line", ""),),
                operators=(_operator_from_line(s.get("line", "")),),
            )
            for s in data.get("station", [])[:limit]
        ]


def _operator_from_line(line: str) -> str:
    """Best-effort guess at operator name from line name prefix."""
    if line.startswith("JR"):
        return "JR"
    if "東京メトロ" in line or line.startswith("メトロ"):
        return "東京メトロ"
    if "都営" in line:
        return "東京都交通局"
    if "私鉄" in line or "電鉄" in line or "鉄道" in line:
        return line
    return ""


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    c = HeartRailsClient()
    results = c.find_station("東京")
    print(f"Found {len(results)} matches for '東京':")
    for r in results:
        print(f"  - {r.name_kanji} ({r.line_codes[0] if r.line_codes else 'n/a'}) at ({r.lat}, {r.lon})")
