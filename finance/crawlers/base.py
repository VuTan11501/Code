"""
Base Crawler - Abstract base class for all data crawlers.
Provides error handling, rate limiting, health tracking, and logging.
"""
import hashlib
import logging
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

import requests

logger = logging.getLogger("jpy_forecast")


@dataclass
class Article:
    """Represents a news article or data point."""
    source: str
    title: str
    url: str = ""
    summary: str = ""
    published_at: str = ""
    content_hash: str = ""

    def __post_init__(self):
        if not self.content_hash:
            raw = f"{self.source}:{self.title}:{self.url}"
            self.content_hash = hashlib.sha256(raw.encode()).hexdigest()[:16]


@dataclass
class MarketDataPoint:
    """Represents a financial market data point."""
    symbol: str
    value: float
    change_pct: float = 0.0
    timestamp: str = ""
    source: str = "yfinance"

    def __post_init__(self):
        if not self.timestamp:
            self.timestamp = datetime.now(timezone.utc).isoformat()


@dataclass
class CrawlerHealth:
    """Tracks crawler health status."""
    name: str
    status: str = "ok"
    articles_count: int = 0
    error: Optional[str] = None
    last_fetch: Optional[str] = None


class BaseCrawler(ABC):
    """Abstract base class for all crawlers."""

    def __init__(self, name: str, enabled: bool = True, rate_limit: float = 1.0):
        self.name = name
        self.enabled = enabled
        self.rate_limit = rate_limit
        self._last_request_time = 0.0
        self.health = CrawlerHealth(name=name)
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": "JPY-Forecast-Bot/1.0 (Personal Finance Tool)"
        })

    def _rate_limit_wait(self):
        elapsed = time.time() - self._last_request_time
        if elapsed < self.rate_limit:
            time.sleep(self.rate_limit - elapsed)
        self._last_request_time = time.time()

    def safe_fetch(self, url: str, timeout: int = 15) -> Optional[requests.Response]:
        """Fetch URL with rate limiting and error handling."""
        self._rate_limit_wait()
        try:
            resp = self.session.get(url, timeout=timeout)
            resp.raise_for_status()
            return resp
        except requests.RequestException as e:
            logger.warning(f"[{self.name}] Failed to fetch {url}: {e}")
            return None

    @abstractmethod
    def crawl(self) -> tuple[list[Article], list[MarketDataPoint]]:
        """Run the crawler. Returns (articles, market_data)."""
        ...

    def run(self) -> tuple[list[Article], list[MarketDataPoint]]:
        """Execute crawler with health tracking."""
        if not self.enabled:
            self.health.status = "disabled"
            return [], []

        try:
            articles, market_data = self.crawl()
            self.health.status = "ok" if articles or market_data else "stale"
            self.health.articles_count = len(articles)
            self.health.last_fetch = datetime.now(timezone.utc).isoformat()
            logger.info(f"[{self.name}] Fetched {len(articles)} articles, {len(market_data)} data points")
            return articles, market_data
        except Exception as e:
            self.health.status = "failed"
            self.health.error = str(e)
            logger.error(f"[{self.name}] Crawler failed: {e}")
            return [], []
