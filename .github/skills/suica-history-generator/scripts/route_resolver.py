"""Multi-provider route resolver with cross-validation.

Composes multiple StationProvider/FareProvider clients into a single
resolver that:

1. Resolves station names → canonical Station objects via the first
   available provider (HeartRails preferred for nationwide coverage).
2. Looks up the IC fare for an OD pair from EVERY available fare
   provider in parallel-ish order, then cross-validates them.
3. Returns a consensus Route + per-provider quotes so callers can see
   disagreements.

Provider tier:
  Tier 1: LocalFareTable          (hand-curated, free, instant)
  Tier 2: HeartRails (stations only; pairs with another fare source)
  Tier 3: ekidata / overpass-osm  (bulk-imported, offline after bootstrap)
  Tier 4: Google Directions       (paid but free credit; fallback only)

Cross-validation:
  - If two providers disagree by > ¥10, log a warning and pick the
    consensus (median of providers).
  - If only one provider quotes, accept it but mark confidence=0.5.

CLI:
  python -m scripts.route_resolver resolve 東京 新宿
  python -m scripts.route_resolver compare 東京 新宿  # cross-check
"""
from __future__ import annotations

import logging
import sqlite3
import statistics
import sys
from dataclasses import dataclass
from pathlib import Path

from .apis._protocols import FareProvider, FareQuote, Route, Station, StationProvider
from .apis.heartrails import HeartRailsClient
from .apis.local_table import LocalFareTable
from .apis.yahoo_transit import YahooTransitClient

log = logging.getLogger(__name__)

CACHE_DB = Path(__file__).resolve().parent.parent / "data" / "routes.sqlite"


@dataclass(slots=True)
class ResolveResult:
    """Output of a route resolution, including cross-validation diagnostics."""

    route: Route
    quotes: list[FareQuote]
    consensus_fare: int
    disagreement_yen: int
    warnings: list[str]


class RouteResolver:
    """Multi-provider station + fare resolver with caching."""

    def __init__(
        self,
        station_providers: list[StationProvider] | None = None,
        fare_providers: list[FareProvider] | None = None,
        cache_db: Path = CACHE_DB,
        disagreement_threshold_yen: int = 10,
    ):
        # Default stack: HeartRails for stations; LocalFareTable + YahooTransit for fares
        self._stations = station_providers or [HeartRailsClient()]
        self._fares = fare_providers or [LocalFareTable(), YahooTransitClient()]
        self._threshold = disagreement_threshold_yen
        self._cache_db = cache_db
        self._init_cache()

    # ------------------------------------------------------------------
    # Cache
    # ------------------------------------------------------------------

    def _init_cache(self) -> None:
        self._cache_db.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(self._cache_db) as c:
            c.execute("""
                CREATE TABLE IF NOT EXISTS routes_cache (
                    from_name TEXT,
                    to_name TEXT,
                    fare_yen INTEGER,
                    duration_min INTEGER,
                    provider TEXT,
                    cached_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (from_name, to_name)
                )
            """)

    def _cache_get(self, frm: str, to: str) -> Route | None:
        with sqlite3.connect(self._cache_db) as c:
            row = c.execute(
                "SELECT fare_yen, duration_min, provider FROM routes_cache "
                "WHERE from_name=? AND to_name=?", (frm, to),
            ).fetchone()
        if row:
            return Route(
                from_station=frm, to_station=to,
                ic_fare_yen=row[0], duration_min=row[1] or 0,
                provider=f"cache({row[2]})",
            )
        return None

    def _cache_put(self, route: Route) -> None:
        with sqlite3.connect(self._cache_db) as c:
            c.execute(
                "INSERT OR REPLACE INTO routes_cache "
                "(from_name, to_name, fare_yen, duration_min, provider) "
                "VALUES (?, ?, ?, ?, ?)",
                (route.from_station, route.to_station,
                 route.ic_fare_yen, route.duration_min, route.provider),
            )

    # ------------------------------------------------------------------
    # Station lookup
    # ------------------------------------------------------------------

    def find_station(self, name: str) -> Station | None:
        """Try each station provider in order, return first match."""
        for p in self._stations:
            try:
                results = p.find_station(name, limit=1)
                if results:
                    log.debug("Station %r resolved by %s", name, p.name)
                    return results[0]
            except Exception as e:
                log.warning("Station provider %s failed for %r: %s", p.name, name, e)
        return None

    # ------------------------------------------------------------------
    # Fare lookup with cross-validation
    # ------------------------------------------------------------------

    def quote_fares(self, origin: Station, dest: Station) -> list[FareQuote]:
        """Query every fare provider and return all quotes."""
        quotes: list[FareQuote] = []
        for p in self._fares:
            try:
                q = p.quote_fare(origin, dest)
                if q is not None:
                    quotes.append(q)
            except Exception as e:
                log.warning("Fare provider %s failed: %s", p.name, e)
        return quotes

    def consensus(self, quotes: list[FareQuote]) -> tuple[int, int, list[str]]:
        """Return (consensus_yen, max_disagreement_yen, warnings).

        Strategy:
        - 0 quotes → 0 fare with warning
        - 1 quote → accept it, warn that no cross-validation possible
        - 2+ quotes within threshold → use confidence-weighted median
        - 2+ quotes disagree → prefer highest-confidence provider, warn
        """
        if not quotes:
            return 0, 0, ["No fare provider returned a quote."]
        values = [q.ic_fare_yen for q in quotes]
        max_diff = max(values) - min(values)

        if len(quotes) == 1:
            return values[0], 0, [
                f"Only one provider ({quotes[0].provider}); cannot cross-validate."
            ]

        warnings: list[str] = []
        if max_diff > self._threshold:
            # Disagreement: pick the highest-confidence provider's value
            winner = max(quotes, key=lambda q: q.confidence)
            consensus_yen = winner.ic_fare_yen
            warnings.append(
                f"Providers disagree by ¥{max_diff} (>{self._threshold}); "
                f"using {winner.provider} (confidence={winner.confidence:.2f}): "
                + ", ".join(f"{q.provider}=¥{q.ic_fare_yen}" for q in quotes)
            )
        else:
            consensus_yen = int(statistics.median(values))
        return consensus_yen, max_diff, warnings

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def resolve(self, from_name: str, to_name: str, use_cache: bool = True) -> ResolveResult:
        """Resolve a full route from station names."""
        if use_cache:
            cached = self._cache_get(from_name, to_name)
            if cached:
                return ResolveResult(
                    route=cached,
                    quotes=[FareQuote(provider="cache", ic_fare_yen=cached.ic_fare_yen)],
                    consensus_fare=cached.ic_fare_yen,
                    disagreement_yen=0,
                    warnings=[],
                )

        origin = self.find_station(from_name)
        dest = self.find_station(to_name)
        if origin is None or dest is None:
            missing = [n for n, s in [(from_name, origin), (to_name, dest)] if s is None]
            raise LookupError(f"Cannot resolve stations: {missing}")

        quotes = self.quote_fares(origin, dest)
        consensus_yen, max_diff, warnings = self.consensus(quotes)
        provider_label = "+".join(q.provider for q in quotes) or "none"

        route = Route(
            from_station=from_name,
            to_station=to_name,
            ic_fare_yen=consensus_yen,
            duration_min=0,  # filled in later from Google Directions if available
            provider=provider_label,
        )
        if consensus_yen > 0:
            self._cache_put(route)
        return ResolveResult(
            route=route,
            quotes=quotes,
            consensus_fare=consensus_yen,
            disagreement_yen=max_diff,
            warnings=warnings,
        )


# ----------------------------------------------------------------------
# CLI
# ----------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    args = argv if argv is not None else sys.argv[1:]
    if len(args) < 3 or args[0] not in ("resolve", "compare"):
        print("usage: python -m scripts.route_resolver {resolve|compare} <from> <to>")
        return 2
    cmd, frm, to = args[0], args[1], args[2]

    r = RouteResolver()
    try:
        result = r.resolve(frm, to, use_cache=(cmd == "resolve"))
    except LookupError as e:
        print(f"ERROR: {e}")
        return 1

    print(f"\n=== {frm} → {to} ===")
    print(f"Consensus fare: ¥{result.consensus_fare}")
    print(f"Provider chain: {result.route.provider}")
    if cmd == "compare":
        print("\nIndividual quotes:")
        for q in result.quotes:
            print(f"  • {q.provider:>15}  ¥{q.ic_fare_yen:>4}   ({q.notes})")
        print(f"\nMax disagreement: ¥{result.disagreement_yen}")
    for w in result.warnings:
        print(f"⚠ {w}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
