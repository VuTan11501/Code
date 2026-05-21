"""Local fare table — Tier 1 fare provider.

Reads `data/kanto_fares.json` (hand-curated from JR East 2026-03 published
schedule) and returns FareQuote for known OD pairs. Always 100% offline
and free. Falls through to next-tier providers when an OD pair is missing.

Convention: keys are sorted-alphabetically "A↔B" so direction-agnostic
(東京↔新宿 == 新宿↔東京).
"""
from __future__ import annotations

import json
import logging
from pathlib import Path

from ._protocols import FareProvider, FareQuote, Station

log = logging.getLogger(__name__)

DEFAULT_TABLE = Path(__file__).resolve().parents[2] / "data" / "kanto_fares.json"


def _normalize_pair(a: str, b: str) -> str:
    """Direction-agnostic key: sort by Unicode codepoint."""
    return "↔".join(sorted([a, b]))


class LocalFareTable:
    """Tier-1 fare provider backed by a JSON file."""

    name = "local-table"

    def __init__(self, table_path: Path = DEFAULT_TABLE):
        self._path = table_path
        self._fares: dict[str, int] = {}
        self._meta: dict = {}
        self.reload()

    def reload(self) -> None:
        with open(self._path, encoding="utf-8") as fh:
            data = json.load(fh)
        raw_fares = data.get("fares", {})
        # Normalize each "A↔B" key to canonical sorted form so lookup
        # works regardless of JSON's original direction.
        self._fares = {}
        for k, v in raw_fares.items():
            if "↔" not in k:
                log.warning("Skipping malformed fare key %r", k)
                continue
            a, b = k.split("↔", 1)
            self._fares[_normalize_pair(a, b)] = int(v)
        self._meta = data.get("_meta", {})
        log.info("Loaded %d fares from %s", len(self._fares), self._path)

    def quote_fare(self, origin: Station, dest: Station) -> FareQuote | None:
        key = _normalize_pair(origin.name_kanji, dest.name_kanji)
        fare = self._fares.get(key)
        if fare is None:
            return None
        return FareQuote(
            provider=self.name,
            ic_fare_yen=int(fare),
            confidence=0.80,  # hardcoded table can go stale; realtime providers should win on disagreement
            notes=f"hardcoded; effective_from={self._meta.get('effective_from','?')}",
        )

    def known_pairs(self) -> list[str]:
        return sorted(self._fares.keys())


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    t = LocalFareTable()
    print(f"Loaded {len(t.known_pairs())} pairs.")
    # demo
    s1 = Station(code="x", name_kanji="東京")
    s2 = Station(code="y", name_kanji="新宿")
    print(t.quote_fare(s1, s2))
