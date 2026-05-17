"""
Yahoo Finance Crawler - Fetches market data for JPY analysis.
Symbols: USD/JPY, VND/JPY, USD/VND, Nikkei 225, S&P 500, Oil, Gold, Bond Yields, DXY.
Also computes JPY/VND cross rate for Vietnamese users.
"""
import logging
from datetime import datetime, timezone

import yfinance as yf

from crawlers.base import BaseCrawler, Article, MarketDataPoint
from config import SYMBOLS, SYMBOL_DISPLAY

logger = logging.getLogger("jpy_forecast")


class YahooFinanceCrawler(BaseCrawler):
    """Fetches real-time market data from Yahoo Finance."""

    def __init__(self, enabled: bool = True):
        super().__init__(name="yahoo_finance", enabled=enabled, rate_limit=0.5)

    def _fetch_ticker(self, key: str, ticker_symbol: str) -> tuple[float, float, float]:
        """Fetch price and change for a ticker. Returns (price, prev_close, change_pct)."""
        ticker = yf.Ticker(ticker_symbol)
        info = ticker.fast_info

        current_price = getattr(info, "last_price", None)
        prev_close = getattr(info, "previous_close", None)

        if current_price is None:
            hist = ticker.history(period="2d")
            if not hist.empty:
                current_price = hist["Close"].iloc[-1]
                if len(hist) > 1:
                    prev_close = hist["Close"].iloc[-2]

        if current_price is None:
            return 0, 0, 0

        change_pct = 0.0
        if prev_close and prev_close > 0:
            change_pct = round((current_price - prev_close) / prev_close * 100, 3)

        return current_price, prev_close or 0, change_pct

    def crawl(self) -> tuple[list[Article], list[MarketDataPoint]]:
        articles = []
        market_data = []
        prices = {}

        for key, ticker_symbol in SYMBOLS.items():
            try:
                price, prev_close, change_pct = self._fetch_ticker(key, ticker_symbol)
                if price == 0:
                    logger.warning(f"[yahoo_finance] No data for {key} ({ticker_symbol})")
                    continue

                prices[key] = price

                md = MarketDataPoint(
                    symbol=key,
                    value=round(price, 4),
                    change_pct=change_pct,
                    source="yfinance",
                )
                market_data.append(md)

                display = SYMBOL_DISPLAY.get(key, {})
                name = display.get("name", key)
                icon = display.get("icon", "📊")
                direction = "↑" if change_pct > 0 else "↓" if change_pct < 0 else "→"

                articles.append(Article(
                    source="yahoo_finance",
                    title=f"{icon} {name}: {price:.2f} ({direction}{abs(change_pct):.2f}%)",
                    summary=f"{name} đang ở mức {price:.2f}, thay đổi {change_pct:+.2f}% so với phiên trước ({prev_close:.2f})",
                    published_at=datetime.now(timezone.utc).isoformat(),
                ))

            except Exception as e:
                logger.warning(f"[yahoo_finance] Error fetching {key}: {e}")
                continue

        # Compute JPY→VND cross rate if both available
        usdjpy = prices.get("usdjpy")
        usdvnd = prices.get("usdvnd")
        if usdjpy and usdvnd and usdjpy > 0:
            jpyvnd = round(usdvnd / usdjpy, 2)
            market_data.append(MarketDataPoint(
                symbol="jpyvnd",
                value=jpyvnd,
                change_pct=0.0,  # Cross rate change is complex
                source="computed",
            ))
            articles.append(Article(
                source="yahoo_finance",
                title=f"🇻🇳 1 JPY = {jpyvnd:.2f} VND (tính từ USD/JPY & USD/VND)",
                summary=f"Tỷ giá quy đổi: 1 Yên Nhật = {jpyvnd:.2f} Đồng Việt Nam. "
                        f"USD/JPY={usdjpy:.2f}, USD/VND={usdvnd:.0f}",
                published_at=datetime.now(timezone.utc).isoformat(),
            ))

        return articles, market_data


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    crawler = YahooFinanceCrawler()
    arts, data = crawler.run()
    for d in data:
        print(f"  {d.symbol}: {d.value} ({d.change_pct:+.2f}%)")
    print(f"\nTotal: {len(data)} data points")
