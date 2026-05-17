"""
Twitter/X Crawler (Optional) - Placeholder for social media monitoring.
Note: Twitter/X API access is increasingly restricted.
Currently uses Nitter RSS as a fallback, which may be unreliable.
"""
import logging
from datetime import datetime, timezone

import feedparser

from crawlers.base import BaseCrawler, Article, MarketDataPoint

logger = logging.getLogger("jpy_forecast")

# Financial accounts to monitor (via Nitter instances)
FINANCIAL_ACCOUNTS = [
    "BOJ_en",           # Bank of Japan (English)
    "federalreserve",   # Federal Reserve
    "business",         # Bloomberg Business
    "ReutersBiz",       # Reuters Business
    "zaborsky_fmr",     # FX analyst
]

# Public Nitter instances (may change/go down)
NITTER_INSTANCES = [
    "nitter.privacydev.net",
    "nitter.poast.org",
]


class TwitterCrawler(BaseCrawler):
    """Fetches tweets via Nitter RSS (fallback for Twitter API)."""

    def __init__(self, enabled: bool = False):
        super().__init__(name="twitter", enabled=enabled, rate_limit=3.0)

    def crawl(self) -> tuple[list[Article], list[MarketDataPoint]]:
        all_articles = []

        for account in FINANCIAL_ACCOUNTS:
            fetched = False
            for instance in NITTER_INSTANCES:
                if fetched:
                    break
                try:
                    url = f"https://{instance}/{account}/rss"
                    feed = feedparser.parse(url)

                    if not feed.entries:
                        continue

                    for entry in feed.entries[:5]:
                        title = getattr(entry, "title", "")[:280]
                        link = getattr(entry, "link", "")
                        pub_date = ""
                        if hasattr(entry, "published_parsed") and entry.published_parsed:
                            try:
                                dt = datetime(*entry.published_parsed[:6], tzinfo=timezone.utc)
                                pub_date = dt.isoformat()
                            except Exception:
                                pub_date = datetime.now(timezone.utc).isoformat()

                        all_articles.append(Article(
                            source=f"twitter_{account}",
                            title=title.strip(),
                            url=link,
                            published_at=pub_date,
                        ))

                    fetched = True
                    logger.info(f"[twitter] @{account}: fetched via {instance}")

                except Exception as e:
                    logger.warning(f"[twitter] Failed {account} via {instance}: {e}")
                    continue

        return all_articles, []


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    crawler = TwitterCrawler(enabled=True)
    arts, _ = crawler.run()
    for a in arts[:10]:
        print(f"  [{a.source}] {a.title[:80]}")
    print(f"\nTotal: {len(arts)} tweets")
