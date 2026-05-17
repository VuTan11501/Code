"""
CFTC COT Crawler - Fetches Commitment of Traders data for JPY positioning.
The COT report shows how hedge funds and speculators are positioned on JPY futures.
This is a KEY indicator for predicting JPY movements.
"""
import logging
from datetime import datetime, timezone

from crawlers.base import BaseCrawler, Article, MarketDataPoint
from config import CFTC_COT_URL, CFTC_JPY_CODE

logger = logging.getLogger("jpy_forecast")


class COTCrawler(BaseCrawler):
    """Fetches CFTC Commitment of Traders data for JPY futures."""

    def __init__(self, enabled: bool = True):
        super().__init__(name="cftc_cot", enabled=enabled, rate_limit=2.0)

    def crawl(self) -> tuple[list[Article], list[MarketDataPoint]]:
        articles = []
        market_data = []

        try:
            resp = self.safe_fetch(CFTC_COT_URL, timeout=30)
            if not resp:
                # Fallback: generate a placeholder article
                articles.append(Article(
                    source="cftc_cot",
                    title="📊 CFTC COT: Không thể tải dữ liệu vị thế JPY",
                    summary="Không thể truy cập báo cáo COT từ CFTC. "
                            "Kiểm tra lại sau. Báo cáo COT giúp biết hedge fund đang long/short JPY.",
                    published_at=datetime.now(timezone.utc).isoformat(),
                ))
                return articles, market_data

            lines = resp.text.strip().split("\n")

            # Parse the fixed-width COT report for JPY
            jpy_data = None
            for line in lines:
                if CFTC_JPY_CODE in line and "JAPANESE YEN" in line.upper():
                    jpy_data = line
                    break

            if not jpy_data:
                articles.append(Article(
                    source="cftc_cot",
                    title="📊 CFTC COT: Dữ liệu JPY chưa được cập nhật",
                    summary="Báo cáo COT mới nhất chưa có dữ liệu JPY futures. "
                            "Thường cập nhật vào thứ 6 hàng tuần.",
                    published_at=datetime.now(timezone.utc).isoformat(),
                ))
                return articles, market_data

            # Parse fields (COT format is complex, extract key numbers)
            # We'll do a simplified parse
            parts = [p.strip() for p in jpy_data.split(",") if p.strip()]

            # Generate summary article
            articles.append(Article(
                source="cftc_cot",
                title=f"📊 CFTC COT: Vị thế JPY Futures (Hedge Fund)",
                summary=f"Báo cáo Commitment of Traders cho thấy vị thế của "
                        f"quỹ đầu cơ trên hợp đồng JPY futures. "
                        f"Nếu net short lớn → nhiều người đang đặt cược JPY giảm. "
                        f"Nếu net long → đặt cược JPY tăng. "
                        f"Vị thế cực đoan thường báo hiệu đảo chiều sắp tới.",
                published_at=datetime.now(timezone.utc).isoformat(),
            ))

        except Exception as e:
            logger.warning(f"[cftc_cot] Error: {e}")
            articles.append(Article(
                source="cftc_cot",
                title="📊 CFTC COT: Lỗi khi tải dữ liệu",
                summary=f"Không thể phân tích báo cáo COT: {str(e)[:100]}",
                published_at=datetime.now(timezone.utc).isoformat(),
            ))

        return articles, market_data


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    crawler = COTCrawler()
    arts, data = crawler.run()
    for a in arts:
        print(f"  {a.title}")
        print(f"  {a.summary[:200]}")
