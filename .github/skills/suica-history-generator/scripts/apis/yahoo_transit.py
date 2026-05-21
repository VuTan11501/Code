"""Yahoo!路線情報 fare scraper.

Public free transit search at https://transit.yahoo.co.jp/. No API key.
We scrape the result HTML for the cheapest IC fare on a given OD pair.

The result page contains multiple route options. Each option has a summary
block at the top with the total IC fare (`<li class="fare">`) plus per-leg
fares (`<p class="fare">`). We pick the cheapest summary.

Rate limiting: be polite. Add 0.5-1s delay between requests, persistent
SQLite cache, and respect robots.txt (Yahoo allows /search/).

Caveats:
- HTML structure is subject to change; if scraper breaks, fall back tier.
- Requires `requests`; no JS rendering needed (server-rendered Next.js).
- This is for personal use only; do not run as a high-volume bot.
"""
from __future__ import annotations

import logging
import re
import time
from urllib.parse import urlencode

import requests

from ._protocols import FareProvider, FareQuote, Station

log = logging.getLogger(__name__)

BASE_URL = "https://transit.yahoo.co.jp/search/result"
TIMEOUT = 12.0
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
MIN_REQUEST_INTERVAL_SEC = 0.8  # be polite

# Match fare in the route summary (header) - usually "<li class=\"fare\"><span class=\"mark\">IC </span><span>¥253</span></li>"
# or "<span>253円</span>" inside fare blocks.
_RE_FARE_YEN  = re.compile(r"(\d[\d,]*)\s*円")
_RE_FARE_MARK = re.compile(r"¥\s*(\d[\d,]*)")
# Per-leg <p class="fare"><span>253円</span></p>
_RE_LEG_FARE  = re.compile(
    r'<p\s+class="fare"[^>]*>\s*<span>\s*(\d[\d,]*)\s*円\s*</span>',
    re.IGNORECASE,
)
# Route summary block (Yahoo wraps each option in <div class="routeSummary">)
_RE_ROUTE_BLOCK = re.compile(
    r'<div class="routeSummary"[^>]*>(.*?)</div>\s*<div class="routeDetail"',
    re.IGNORECASE | re.DOTALL,
)


class YahooTransitClient:
    """Fare provider via Yahoo!路線情報 HTML scraping."""

    name = "yahoo-transit"

    def __init__(self, session: requests.Session | None = None):
        self._session = session or requests.Session()
        self._session.headers.update({
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "ja,en;q=0.7",
        })
        self._last_request_ts = 0.0

    def _throttle(self) -> None:
        gap = time.time() - self._last_request_ts
        if gap < MIN_REQUEST_INTERVAL_SEC:
            time.sleep(MIN_REQUEST_INTERVAL_SEC - gap)
        self._last_request_ts = time.time()

    def _fetch(self, params: dict) -> str:
        self._throttle()
        url = f"{BASE_URL}?{urlencode(params, doseq=True)}"
        log.debug("GET %s", url)
        resp = self._session.get(url, timeout=TIMEOUT)
        resp.raise_for_status()
        return resp.text

    def quote_fare(self, origin: Station, dest: Station,
                   y: int = 2026, m: int = 5, d: int = 22,
                   hh: int = 9, mm: int = 0) -> FareQuote | None:
        params = {
            "from": origin.name_kanji,
            "to":   dest.name_kanji,
            "y": y, "m": f"{m:02d}", "d": f"{d:02d}",
            "hh": f"{hh:02d}", "m1": mm // 10, "m2": mm % 10,
            "type": 1,        # 出発
            "ticket": "ic",   # IC fare
            "expkind": 1,     # use 特急 freely
        }
        try:
            html = self._fetch(params)
        except requests.RequestException as e:
            log.warning("Yahoo Transit fetch failed: %s", e)
            return None

        fares = self._extract_fares(html)
        if not fares:
            log.warning("No fare matches in Yahoo Transit response for %s→%s",
                        origin.name_kanji, dest.name_kanji)
            return None

        cheapest = min(fares)
        return FareQuote(
            provider=self.name,
            ic_fare_yen=cheapest,
            confidence=0.95,
            notes=f"scraped IC; {len(fares)} route option(s); min=¥{cheapest}",
        )

    def _extract_fares(self, html: str) -> list[int]:
        """Pull a list of total IC fares per route option.

        Yahoo wraps each alternative route in a <div class="routeDetail"...>.
        Inside that, each leg has <p class="fare"><span>NNN円</span></p>.
        Total fare for a route = sum of its leg fares.
        We return one entry per route, then caller picks min.
        """
        per_route_totals: list[int] = []
        # Split by routeDetail boundary; first element is page header, skip it.
        for block in re.split(r'<div class="routeDetail"', html, flags=re.IGNORECASE)[1:]:
            legs = _RE_LEG_FARE.findall(block)
            if not legs:
                continue
            try:
                total = sum(int(v.replace(",", "")) for v in legs)
            except ValueError:
                continue
            if total > 0:
                per_route_totals.append(total)
        return per_route_totals


if __name__ == "__main__":
    import sys
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    if len(sys.argv) < 3:
        print("usage: python -m scripts.apis.yahoo_transit <from> <to>")
        sys.exit(2)
    c = YahooTransitClient()
    s1 = Station(code="x", name_kanji=sys.argv[1])
    s2 = Station(code="y", name_kanji=sys.argv[2])
    q = c.quote_fare(s1, s2)
    print(q)
