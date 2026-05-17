"""
Reddit Crawler (Optional) - Fetches posts from r/forex and r/japanfinance.
Uses Reddit's JSON API (no authentication needed).
"""
import logging
from datetime import datetime, timezone, timedelta

from crawlers.base import BaseCrawler, Article, MarketDataPoint
from config import REDDIT_SUBREDDITS, MAX_ARTICLES_PER_SOURCE

logger = logging.getLogger("jpy_forecast")

JPY_KEYWORDS = [
    "yen", "jpy", "usd/jpy", "usdjpy", "japan", "boj",
    "bank of japan", "carry trade", "intervention",
]


class RedditCrawler(BaseCrawler):
    """Fetches JPY-relevant posts from Reddit subreddits."""

    def __init__(self, enabled: bool = False):
        super().__init__(name="reddit", enabled=enabled, rate_limit=2.0)

    def crawl(self) -> tuple[list[Article], list[MarketDataPoint]]:
        all_articles = []

        for subreddit in REDDIT_SUBREDDITS:
            try:
                url = f"https://www.reddit.com/r/{subreddit}/hot.json?limit=25"
                resp = self.safe_fetch(url)
                if not resp:
                    continue

                data = resp.json()
                posts = data.get("data", {}).get("children", [])
                count = 0

                for post in posts:
                    if count >= MAX_ARTICLES_PER_SOURCE // len(REDDIT_SUBREDDITS):
                        break

                    pdata = post.get("data", {})
                    title = pdata.get("title", "")
                    selftext = pdata.get("selftext", "")[:500]
                    permalink = pdata.get("permalink", "")
                    created = pdata.get("created_utc", 0)

                    # Filter relevant posts
                    text = f"{title} {selftext}".lower()
                    if not any(kw in text for kw in JPY_KEYWORDS):
                        continue

                    pub_date = datetime.fromtimestamp(created, tz=timezone.utc).isoformat() if created else ""

                    all_articles.append(Article(
                        source=f"reddit_r/{subreddit}",
                        title=title.strip(),
                        url=f"https://reddit.com{permalink}",
                        summary=selftext.strip()[:500],
                        published_at=pub_date,
                    ))
                    count += 1

                logger.info(f"[reddit] r/{subreddit}: {count} relevant posts")

            except Exception as e:
                logger.warning(f"[reddit] Failed for r/{subreddit}: {e}")
                continue

        return all_articles, []


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    crawler = RedditCrawler(enabled=True)
    arts, _ = crawler.run()
    for a in arts[:5]:
        print(f"  [{a.source}] {a.title}")
    print(f"\nTotal: {len(arts)} posts")
