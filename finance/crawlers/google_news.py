"""
Google News Crawler - Searches Google News RSS for JPY-related articles.
Uses Google News RSS endpoint (no API key needed).
"""
import logging
from datetime import datetime, timezone
from urllib.parse import quote_plus

import feedparser

from crawlers.base import BaseCrawler, Article, MarketDataPoint
from config import GOOGLE_NEWS_QUERIES, MAX_ARTICLES_PER_SOURCE

logger = logging.getLogger("jpy_forecast")

GOOGLE_NEWS_RSS = "https://news.google.com/rss/search?q={query}&hl=en&gl=US&ceid=US:en"


class GoogleNewsCrawler(BaseCrawler):
    """Searches Google News RSS for JPY-relevant articles."""

    def __init__(self, enabled: bool = True):
        super().__init__(name="google_news", enabled=enabled, rate_limit=2.0)

    def crawl(self) -> tuple[list[Article], list[MarketDataPoint]]:
        all_articles = []
        seen_titles = set()

        for query in GOOGLE_NEWS_QUERIES:
            try:
                url = GOOGLE_NEWS_RSS.format(query=quote_plus(query))
                feed = feedparser.parse(url)
                count = 0

                for entry in feed.entries:
                    if count >= MAX_ARTICLES_PER_SOURCE // len(GOOGLE_NEWS_QUERIES):
                        break

                    title = getattr(entry, "title", "").strip()
                    link = getattr(entry, "link", "")
                    summary = getattr(entry, "summary", "")
                    pub_date = ""

                    if hasattr(entry, "published_parsed") and entry.published_parsed:
                        try:
                            dt = datetime(*entry.published_parsed[:6], tzinfo=timezone.utc)
                            pub_date = dt.isoformat()
                        except Exception:
                            pub_date = datetime.now(timezone.utc).isoformat()
                    else:
                        pub_date = datetime.now(timezone.utc).isoformat()

                    # Deduplicate by title
                    title_key = title.lower()[:80]
                    if title_key in seen_titles:
                        continue
                    seen_titles.add(title_key)

                    # Clean HTML from summary
                    if "<" in summary:
                        from bs4 import BeautifulSoup
                        summary = BeautifulSoup(summary, "html.parser").get_text()[:500]

                    all_articles.append(Article(
                        source=f"google_news",
                        title=title,
                        url=link,
                        summary=summary.strip()[:500],
                        published_at=pub_date,
                    ))
                    count += 1

                logger.info(f"[google_news] '{query}': {count} articles")

            except Exception as e:
                logger.warning(f"[google_news] Failed for query '{query}': {e}")
                continue

        return all_articles, []


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    crawler = GoogleNewsCrawler()
    arts, _ = crawler.run()
    for a in arts[:10]:
        print(f"  {a.title}")
    print(f"\nTotal: {len(arts)} articles")
