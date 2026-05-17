"""
RSS Crawler - Fetches news from financial RSS feeds.
Sources: Reuters, Bloomberg, NHK, Nikkei, BOJ, FED, ForexLive, FXStreet.
"""
import logging
from datetime import datetime, timezone, timedelta
from typing import Optional

import feedparser

from crawlers.base import BaseCrawler, Article, MarketDataPoint
from config import RSS_FEEDS, MAX_ARTICLES_PER_SOURCE, DATA_CUTOFF_HOURS

logger = logging.getLogger("jpy_forecast")

# JPY-relevant keywords for filtering
JPY_KEYWORDS = [
    # JPY core
    "yen", "jpy", "usd/jpy", "usdjpy", "dollar-yen", "dollar yen",
    "bank of japan", "boj", "ueda", "japan",
    # Fed & US
    "federal reserve", "fed", "fomc", "powell", "dot plot",
    "interest rate", "rate hike", "rate cut", "monetary policy",
    "hawkish", "dovish",
    # Economic indicators
    "inflation", "cpi", "ppi", "gdp", "trade balance",
    "nonfarm", "payroll", "unemployment", "tankan", "pce",
    "wage", "shunto", "consumer", "retail",
    # Energy & commodities
    "oil", "crude", "energy", "lng", "opec",
    # Markets & risk
    "safe haven", "risk", "carry trade", "vix", "volatility",
    "intervention", "ministry of finance", "mof",
    "nikkei", "treasury", "yield", "bond",
    "forex", "fx", "currency", "exchange rate",
    # VND / Vietnam
    "vietnam", "vnd", "dong", "sbv", "state bank",
    "hanoi", "ho chi minh", "fdi japan vietnam",
]


def is_relevant(title: str, summary: str) -> bool:
    """Check if article is relevant to JPY analysis."""
    text = f"{title} {summary}".lower()
    return any(kw in text for kw in JPY_KEYWORDS)


def parse_date(entry) -> Optional[str]:
    """Extract published date from RSS entry."""
    if hasattr(entry, "published_parsed") and entry.published_parsed:
        try:
            dt = datetime(*entry.published_parsed[:6], tzinfo=timezone.utc)
            return dt.isoformat()
        except Exception:
            pass
    if hasattr(entry, "updated_parsed") and entry.updated_parsed:
        try:
            dt = datetime(*entry.updated_parsed[:6], tzinfo=timezone.utc)
            return dt.isoformat()
        except Exception:
            pass
    return datetime.now(timezone.utc).isoformat()


class RSSCrawler(BaseCrawler):
    """Fetches and filters news from multiple RSS feeds."""

    def __init__(self, enabled: bool = True):
        super().__init__(name="rss_feeds", enabled=enabled, rate_limit=1.0)

    def crawl(self) -> tuple[list[Article], list[MarketDataPoint]]:
        all_articles = []
        cutoff = datetime.now(timezone.utc) - timedelta(hours=DATA_CUTOFF_HOURS)

        for feed_name, feed_url in RSS_FEEDS.items():
            try:
                feed = feedparser.parse(feed_url)
                count = 0

                for entry in feed.entries:
                    if count >= MAX_ARTICLES_PER_SOURCE:
                        break

                    title = getattr(entry, "title", "")
                    summary = getattr(entry, "summary", "")
                    link = getattr(entry, "link", "")
                    pub_date = parse_date(entry)

                    # Filter by relevance
                    if not is_relevant(title, summary):
                        continue

                    # Clean summary (remove HTML tags)
                    if "<" in summary:
                        from bs4 import BeautifulSoup
                        summary = BeautifulSoup(summary, "html.parser").get_text()[:500]

                    all_articles.append(Article(
                        source=f"rss_{feed_name}",
                        title=title.strip(),
                        url=link,
                        summary=summary.strip()[:500],
                        published_at=pub_date,
                    ))
                    count += 1

                logger.info(f"[rss] {feed_name}: {count} relevant articles")

            except Exception as e:
                logger.warning(f"[rss] Failed to parse {feed_name}: {e}")
                continue

        return all_articles, []


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    crawler = RSSCrawler()
    arts, _ = crawler.run()
    for a in arts[:10]:
        print(f"  [{a.source}] {a.title}")
    print(f"\nTotal: {len(arts)} articles")
