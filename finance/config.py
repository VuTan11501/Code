"""
JPY Forecast Tool - Configuration
Loads settings from environment variables and defines constants.
"""
import os
from pathlib import Path
from dotenv import load_dotenv

# Load .env from project root
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

# ── Paths ──
BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
TEMPLATE_DIR = BASE_DIR / "reporters" / "templates"
DB_PATH = DATA_DIR / "jpy_forecast.db"

# ── Gemini AI ──
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.0-flash")

# ── Email / SMTP ──
SMTP_SERVER = os.getenv("SMTP_SERVER", "smtp.gmail.com")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_USER = os.getenv("SMTP_USER", "")
SMTP_PASS = os.getenv("SMTP_PASS", "")
NOTIFY_EMAIL = os.getenv("NOTIFY_EMAIL", "")

# ── Data Settings ──
DATA_CUTOFF_HOURS = 24          # Crawl articles from last N hours
REPORT_TIME = "09:00"           # JST
MAX_ARTICLES_PER_SOURCE = 25    # Cap per crawler
MAX_ARTICLES_TO_GEMINI = 60     # Total cap sent to Gemini

# ── Crawler Toggles ──
ENABLE_RSS = True
ENABLE_YAHOO_FINANCE = True
ENABLE_GOOGLE_NEWS = True
ENABLE_ECONOMIC_CALENDAR = True
ENABLE_COT = True               # CFTC Commitment of Traders
ENABLE_REDDIT = False           # Optional, noisy
ENABLE_TWITTER = False          # Optional, unreliable

# ── Market Symbols ──
SYMBOLS = {
    "usdjpy": "JPY=X",
    "vndjpy": "VNDJPY=X",
    "usdvnd": "VND=X",
    "nikkei225": "^N225",
    "sp500": "^GSPC",
    "oil_wti": "CL=F",
    "oil_brent": "BZ=F",
    "gold": "GC=F",
    "us_10y": "^TNX",       # US 10-Year Treasury Yield
    "us_2y": "2YY=F",       # US 2-Year Yield (for yield curve)
    "dxy": "DX-Y.NYB",
    "vix": "^VIX",          # Fear index → safe haven signal
}

# Display names for market symbols (Vietnamese)
SYMBOL_DISPLAY = {
    "usdjpy": {"name": "USD/JPY", "icon": "💴", "desc": "Tỷ giá Đô la/Yên"},
    "vndjpy": {"name": "VND/JPY", "icon": "🇻🇳", "desc": "Tỷ giá Đồng/Yên"},
    "usdvnd": {"name": "USD/VND", "icon": "💵", "desc": "Tỷ giá Đô la/Đồng"},
    "jpyvnd": {"name": "JPY→VND", "icon": "🇻🇳", "desc": "1 Yên = ? Đồng"},
    "nikkei225": {"name": "Nikkei 225", "icon": "📈", "desc": "Chứng khoán Nhật"},
    "sp500": {"name": "S&P 500", "icon": "🇺🇸", "desc": "Chứng khoán Mỹ"},
    "oil_wti": {"name": "Dầu WTI", "icon": "🛢️", "desc": "Giá dầu thô WTI"},
    "oil_brent": {"name": "Dầu Brent", "icon": "🛢️", "desc": "Giá dầu thô Brent"},
    "gold": {"name": "Vàng", "icon": "🥇", "desc": "Giá vàng thế giới"},
    "us_10y": {"name": "US 10Y Yield", "icon": "🏦", "desc": "Lợi suất TPCP Mỹ 10 năm"},
    "us_2y": {"name": "US 2Y Yield", "icon": "🏦", "desc": "Lợi suất TPCP Mỹ 2 năm"},
    "dxy": {"name": "DXY", "icon": "💲", "desc": "Chỉ số Đô la Mỹ"},
    "vix": {"name": "VIX", "icon": "😱", "desc": "Chỉ số sợ hãi (biến động)"},
    "yield_spread": {"name": "US-JP Spread", "icon": "📐", "desc": "Chênh lệch lợi suất Mỹ-Nhật"},
}

# ── RSS Feeds (expanded with all premium sources) ──
RSS_FEEDS = {
    # ═══ Central Banks (QUAN TRỌNG NHẤT) ═══
    "boj_announcements": "https://www.boj.or.jp/en/rss/whatsnew.xml",
    "boj_research": "https://www.boj.or.jp/en/rss/research.xml",
    "fed_press": "https://www.federalreserve.gov/feeds/press_all.xml",
    "fed_speeches": "https://www.federalreserve.gov/feeds/speeches.xml",
    "fed_monetary": "https://www.federalreserve.gov/feeds/press_monetary.xml",

    # ═══ Major Financial News ═══
    "reuters_markets": "https://www.reutersagency.com/feed/?taxonomy=best-sectors&post_type=best",
    "bloomberg_markets": "https://feeds.bloomberg.com/markets/news.rss",
    "bloomberg_economics": "https://feeds.bloomberg.com/economics/news.rss",

    # ═══ Japan-specific News ═══
    "nikkei_english": "https://www.nikkei.com/rss/nikkei_english.rdf",
    "nhk_business": "https://www3.nhk.or.jp/rss/news/cat04.xml",
    "japantimes_business": "https://www.japantimes.co.jp/feed/business/",

    # ═══ FX & Trading ═══
    "forexlive": "https://www.forexlive.com/feed/",
    "fxstreet": "https://www.fxstreet.com/rss",
    "dailyfx": "https://www.dailyfx.com/feeds/forex",

    # ═══ Vietnam (for VND analysis) ═══
    "vnexpress_business": "https://vnexpress.net/rss/kinh-doanh.rss",
    "sbv_news": "https://www.sbv.gov.vn/webcenter/portal/vi/menu/rm/rss",
}

# ── Google News Search Queries (expanded) ──
GOOGLE_NEWS_QUERIES = [
    # JPY core
    "JPY USD exchange rate forecast",
    "Bank of Japan interest rate decision",
    "BOJ monetary policy meeting",
    "Federal Reserve FOMC rate decision",
    # Economic indicators
    "Japan CPI inflation",
    "US CPI inflation",
    "Japan GDP economy",
    "US nonfarm payrolls",
    "Japan trade balance",
    "Japan wage growth shunto",
    # Market drivers
    "oil price energy crisis",
    "yen intervention MOF Japan",
    "US treasury yield 10 year",
    "carry trade yen",
    # VND specific
    "JPY VND exchange rate",
    "Vietnam dong exchange rate",
    "State Bank Vietnam interest rate",
    "Vietnam FDI Japan investment",
    # Risk & geopolitics
    "global recession risk",
    "US China trade war",
]

# ── Reddit Subreddits (optional) ──
REDDIT_SUBREDDITS = [
    "forex",
    "japanfinance",
]

# ── Factor Groups & Weights (with Vietnamese names) ──
FACTOR_GROUPS = {
    "monetary_policy": {
        "name": "Monetary Policy Differential",
        "name_vi": "🏦 Chênh Lệch Chính Sách Tiền Tệ",
        "description": "BOJ + FED interest rates, QE, YCC, carry trade, dot plot, yield spread",
        "weight": 0.30,
        "keywords": [
            "BOJ", "Bank of Japan", "interest rate", "FED", "Federal Reserve",
            "rate hike", "rate cut", "QE", "quantitative easing", "YCC",
            "yield curve", "carry trade", "bond yield", "monetary policy",
            "FOMC", "dot plot", "Powell", "Ueda", "hawkish", "dovish",
            "yield spread", "rate differential",
        ],
    },
    "japan_domestic": {
        "name": "Japan Domestic Economy",
        "name_vi": "🇯🇵 Kinh Tế Nội Địa Nhật",
        "description": "GDP, wages, consumption, inflation, employment, Tankan",
        "weight": 0.20,
        "keywords": [
            "Japan GDP", "Japan wages", "Japan inflation", "Japan CPI",
            "Japan employment", "Japan consumer", "Tankan", "Japan economy",
            "wage growth", "spring wage", "shunto", "Japan PPI",
            "Japan retail", "Japan manufacturing", "Japan services",
            "core CPI", "BOJ outlook",
        ],
    },
    "external_balance": {
        "name": "External Balance & Energy",
        "name_vi": "⚡ Cán Cân Thương Mại & Năng Lượng",
        "description": "Trade balance, oil prices, energy imports, current account",
        "weight": 0.20,
        "keywords": [
            "trade balance", "trade deficit", "trade surplus", "oil price",
            "crude oil", "energy price", "LNG", "natural gas", "import",
            "export", "current account", "Brent", "WTI", "OPEC",
            "Japan trade", "Japan imports", "Japan exports",
        ],
    },
    "risk_sentiment": {
        "name": "Risk Sentiment & Safe Haven",
        "name_vi": "🛡️ Tâm Lý Rủi Ro & Trú Ẩn An Toàn",
        "description": "Global crises, market panic, VIX, safe haven demand, carry trade unwind",
        "weight": 0.20,
        "keywords": [
            "safe haven", "risk off", "risk on", "crisis", "war", "conflict",
            "market crash", "VIX", "volatility", "panic", "recession",
            "stock market", "sell-off", "flight to safety", "fear",
            "carry trade unwind", "deleveraging",
        ],
    },
    "intervention_political": {
        "name": "Intervention & Political Risk",
        "name_vi": "🏛️ Can Thiệp & Rủi Ro Chính Trị",
        "description": "MOF intervention, elections, trade policy, geopolitics, CFTC positioning",
        "weight": 0.10,
        "keywords": [
            "intervention", "MOF", "Ministry of Finance", "excessive moves",
            "closely watching", "election", "Trump", "tariff", "sanctions",
            "geopolitical", "trade war", "US-China", "US-Japan",
            "ready to act", "speculative", "one-sided", "COT", "positioning",
        ],
    },
}

# ── Economic Calendar Events (expanded) ──
CALENDAR_EVENTS = [
    # BOJ
    {"name": "BOJ Policy Meeting", "dates": [
        "2026-01-22", "2026-03-13", "2026-04-30", "2026-06-16",
        "2026-07-30", "2026-09-17", "2026-10-29", "2026-12-18"
    ]},
    {"name": "BOJ Outlook Report", "dates": [
        "2026-01-22", "2026-04-30", "2026-07-30", "2026-10-29"
    ]},
    # FOMC
    {"name": "FOMC Meeting", "dates": [
        "2026-01-28", "2026-03-18", "2026-05-06", "2026-06-17",
        "2026-07-29", "2026-09-16", "2026-11-04", "2026-12-16"
    ]},
    # Monthly indicators
    {"name": "Japan CPI", "frequency": "monthly", "day": 20},
    {"name": "US CPI", "frequency": "monthly", "day": 13},
    {"name": "US Core PCE", "frequency": "monthly", "day": 28},
    {"name": "US PPI", "frequency": "monthly", "day": 14},
    {"name": "US Non-Farm Payrolls", "frequency": "monthly", "day": 5},
    {"name": "Japan Trade Balance", "frequency": "monthly", "day": 19},
    # Quarterly
    {"name": "Japan Tankan Survey", "dates": [
        "2026-04-01", "2026-07-01", "2026-10-01", "2027-01-05"
    ]},
    {"name": "Japan GDP (Preliminary)", "dates": [
        "2026-02-17", "2026-05-18", "2026-08-17", "2026-11-16"
    ]},
    {"name": "US GDP (Advance)", "dates": [
        "2026-01-29", "2026-04-29", "2026-07-29", "2026-10-29"
    ]},
    # Weekly
    {"name": "CFTC COT Report", "frequency": "weekly", "weekday": 4},  # Friday
]

# ── CFTC COT Configuration ──
CFTC_COT_URL = "https://www.cftc.gov/dea/newcot/deafut.txt"
CFTC_JPY_CODE = "097741"  # Japanese Yen futures contract code

# ── Intervention Alert Thresholds ──
INTERVENTION_ALERT = {
    "usdjpy_upper": 160.0,   # Alert if USD/JPY exceeds this
    "usdjpy_lower": 140.0,   # Alert if USD/JPY falls below this
    "daily_move_pct": 1.5,   # Alert if daily move exceeds this %
}

# ── Key Indicators Quick Reference (for report) ──
INDICATOR_GUIDE = {
    "fed_rate": {"name": "Lãi suất FED", "impact": "USD mạnh/yếu → JPY ngược lại"},
    "boj_rate": {"name": "Lãi suất BOJ", "impact": "JPY mạnh/yếu trực tiếp"},
    "us_cpi": {"name": "CPI Mỹ", "impact": "Ảnh hưởng kỳ vọng FED"},
    "us_10y": {"name": "US 10Y Yield", "impact": "Yield cao → USD mạnh → JPY yếu"},
    "risk": {"name": "Tâm lý thị trường", "impact": "Panic → JPY mạnh (safe haven)"},
}
