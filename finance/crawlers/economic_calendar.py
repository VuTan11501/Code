"""
Economic Calendar Crawler - Tracks upcoming/recent economic events.
Covers BOJ, FOMC, CPI, GDP, NFP, PCE, Tankan, CFTC COT, and more.
"""
import logging
from datetime import datetime, timezone, timedelta

from crawlers.base import BaseCrawler, Article, MarketDataPoint
from config import CALENDAR_EVENTS

logger = logging.getLogger("jpy_forecast")

# Vietnamese names for calendar events
EVENT_NAMES_VI = {
    "BOJ Policy Meeting": "🇯🇵 Họp Chính Sách BOJ",
    "BOJ Outlook Report": "🇯🇵 Báo Cáo Triển Vọng BOJ",
    "FOMC Meeting": "🇺🇸 Họp FOMC (FED)",
    "Japan CPI": "🇯🇵 CPI Nhật Bản",
    "US CPI": "🇺🇸 CPI Mỹ",
    "US Core PCE": "🇺🇸 Core PCE Mỹ",
    "US PPI": "🇺🇸 PPI Mỹ",
    "US Non-Farm Payrolls": "🇺🇸 Bảng Lương Phi Nông Nghiệp Mỹ",
    "Japan Trade Balance": "🇯🇵 Cán Cân Thương Mại Nhật",
    "Japan Tankan Survey": "🇯🇵 Khảo Sát Tankan",
    "Japan GDP (Preliminary)": "🇯🇵 GDP Nhật (Sơ bộ)",
    "US GDP (Advance)": "🇺🇸 GDP Mỹ (Ước tính)",
    "CFTC COT Report": "📊 Báo Cáo COT (Vị thế JPY)",
}

# Impact levels
EVENT_IMPACT = {
    "BOJ Policy Meeting": "🔴 Cực cao",
    "BOJ Outlook Report": "🔴 Cực cao",
    "FOMC Meeting": "🔴 Cực cao",
    "US CPI": "🔴 Cao",
    "US Non-Farm Payrolls": "🔴 Cao",
    "Japan CPI": "🟠 Trung bình-Cao",
    "US Core PCE": "🟠 Trung bình-Cao",
    "US PPI": "🟡 Trung bình",
    "Japan Trade Balance": "🟡 Trung bình",
    "Japan Tankan Survey": "🟠 Trung bình-Cao",
    "Japan GDP (Preliminary)": "🟠 Trung bình-Cao",
    "US GDP (Advance)": "🟠 Trung bình-Cao",
    "CFTC COT Report": "🟡 Trung bình",
}


def get_upcoming_events(within_days: int = 7) -> list[dict]:
    """Get economic events within the next N days."""
    today = datetime.now(timezone.utc).date()
    upcoming = []

    for event in CALENDAR_EVENTS:
        if "dates" in event:
            for date_str in event["dates"]:
                event_date = datetime.strptime(date_str, "%Y-%m-%d").date()
                delta = (event_date - today).days
                if 0 <= delta <= within_days:
                    upcoming.append({
                        "name": event["name"],
                        "name_vi": EVENT_NAMES_VI.get(event["name"], event["name"]),
                        "date": date_str,
                        "days_away": delta,
                        "impact": EVENT_IMPACT.get(event["name"], "🟡 Trung bình"),
                    })
        elif event.get("frequency") == "monthly":
            for month_offset in range(2):
                year = today.year
                month = today.month + month_offset
                if month > 12:
                    month -= 12
                    year += 1
                try:
                    event_date = datetime(year, month, event["day"]).date()
                    delta = (event_date - today).days
                    if 0 <= delta <= within_days:
                        upcoming.append({
                            "name": event["name"],
                            "name_vi": EVENT_NAMES_VI.get(event["name"], event["name"]),
                            "date": event_date.isoformat(),
                            "days_away": delta,
                            "impact": EVENT_IMPACT.get(event["name"], "🟡 Trung bình"),
                        })
                except ValueError:
                    pass
        elif event.get("frequency") == "weekly":
            # Find next occurrence of the given weekday
            target_weekday = event.get("weekday", 4)  # 4 = Friday
            days_ahead = (target_weekday - today.weekday()) % 7
            if days_ahead == 0:
                days_ahead = 0  # Include today
            next_date = today + timedelta(days=days_ahead)
            if (next_date - today).days <= within_days:
                upcoming.append({
                    "name": event["name"],
                    "name_vi": EVENT_NAMES_VI.get(event["name"], event["name"]),
                    "date": next_date.isoformat(),
                    "days_away": (next_date - today).days,
                    "impact": EVENT_IMPACT.get(event["name"], "🟡 Trung bình"),
                })

    upcoming.sort(key=lambda x: x["days_away"])
    return upcoming


class EconomicCalendarCrawler(BaseCrawler):
    """Generates articles from upcoming economic events."""

    def __init__(self, enabled: bool = True):
        super().__init__(name="economic_calendar", enabled=enabled)

    def crawl(self) -> tuple[list[Article], list[MarketDataPoint]]:
        articles = []
        events = get_upcoming_events(within_days=7)

        for evt in events:
            if evt["days_away"] == 0:
                urgency = "⚠️ HÔM NAY"
            elif evt["days_away"] == 1:
                urgency = "📅 NGÀY MAI"
            else:
                urgency = f"📋 Còn {evt['days_away']} ngày"

            articles.append(Article(
                source="economic_calendar",
                title=f"{urgency}: {evt['name_vi']} ({evt['date']})",
                summary=f"Sự kiện kinh tế quan trọng: {evt['name_vi']} vào ngày {evt['date']}. "
                        f"Mức độ ảnh hưởng: {evt['impact']}. "
                        f"Có thể tác động mạnh tới biến động JPY.",
                published_at=datetime.now(timezone.utc).isoformat(),
            ))

        if not events:
            articles.append(Article(
                source="economic_calendar",
                title="📋 Không có sự kiện kinh tế lớn trong 7 ngày tới",
                summary="Không có cuộc họp BOJ, FOMC, CPI, hay sự kiện quan trọng nào trong tuần tới.",
                published_at=datetime.now(timezone.utc).isoformat(),
            ))

        return articles, []


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    events = get_upcoming_events(within_days=14)
    for e in events:
        print(f"  [{e['days_away']}d] {e['impact']} {e['name_vi']} - {e['date']}")

    crawler = EconomicCalendarCrawler()
    arts, _ = crawler.run()
    for a in arts:
        print(f"  {a.title}")
