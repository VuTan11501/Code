"""
Email Reporter - Sends daily JPY forecast reports via SMTP.
Same pattern as auto-checkin email notifications.
"""
import logging
import smtplib
from dataclasses import asdict
from datetime import datetime, timezone, timedelta
from email.header import Header
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path

import css_inline
from jinja2 import Environment, FileSystemLoader

from config import (
    SMTP_SERVER, SMTP_PORT, SMTP_USER, SMTP_PASS, NOTIFY_EMAIL,
    TEMPLATE_DIR, SYMBOL_DISPLAY, FACTOR_GROUPS,
)
from analyzers.factor_scorer import ForecastResult
from crawlers.base import Article, MarketDataPoint, CrawlerHealth

logger = logging.getLogger("jpy_forecast")

JST = timezone(timedelta(hours=9))

# CSS inliner: inlines <style> rules into style="" attrs for email client compatibility
# Keeps <style> block as fallback + preserves @import/@media at-rules
_css_inliner = css_inline.CSSInliner(
    keep_style_tags=True,
    keep_link_tags=True,
    load_remote_stylesheets=False,
)


def render_report(
    forecast: ForecastResult,
    market_data: list[MarketDataPoint],
    top_news: list[Article],
    calendar_events: list[Article],
    source_health: list[CrawlerHealth],
    gemini_signals: list[dict] = None,
    accuracy_stats=None,
) -> str:
    """Render HTML email from Jinja2 template."""
    env = Environment(loader=FileSystemLoader(str(TEMPLATE_DIR)))
    template = env.get_template("daily_report.html")

    now_jst = datetime.now(JST)

    # Convert dataclasses to dicts for Jinja2
    market_dicts = [
        {"symbol": md.symbol, "value": md.value, "change_pct": md.change_pct}
        for md in market_data
    ]

    # Build title translation map from Gemini signals
    title_translations = {}
    signal_metadata = {}  # article_title -> {direction, magnitude}
    if gemini_signals:
        for sig in gemini_signals:
            orig = sig.get("article_title", "")
            vi = sig.get("title_vi", "")
            if orig and vi:
                title_translations[orig] = vi
            if orig:
                signal_metadata[orig] = {
                    "direction": sig.get("direction", ""),
                    "magnitude": sig.get("magnitude", ""),
                }

    # Enrich news with Vietnamese translations and signal metadata
    news_dicts = []
    for a in top_news:
        d = {
            "title": a.title,
            "title_vi": title_translations.get(a.title, ""),
            "url": a.url,
            "source": a.source,
            "published_at": a.published_at,
            "direction": signal_metadata.get(a.title, {}).get("direction", ""),
            "magnitude": signal_metadata.get(a.title, {}).get("magnitude", ""),
        }
        news_dicts.append(d)

    calendar_dicts = [
        {"title": a.title, "summary": a.summary}
        for a in calendar_events
    ]
    health_dicts = [
        {"name": h.name, "status": h.status, "articles_count": h.articles_count, "error": h.error}
        for h in source_health
    ]

    # Convert ForecastResult to dict (with Vietnamese factor names)
    forecast_dict = {
        "jpy_direction": forecast.jpy_direction,
        "usdjpy_direction": forecast.usdjpy_direction,
        "overall_score": forecast.overall_score,
        "confidence": forecast.confidence,
        "market_summary": forecast.market_summary,
        "key_risks": forecast.key_risks,
        "vnd_analysis": forecast.vnd_analysis,
        "vnd_direction": forecast.vnd_direction,
        "jpyvnd_rate": forecast.jpyvnd_rate,
        "usdjpy_forecast_low": forecast.usdjpy_forecast_low,
        "usdjpy_forecast_high": forecast.usdjpy_forecast_high,
        "jpyvnd_forecast_low": forecast.jpyvnd_forecast_low,
        "jpyvnd_forecast_high": forecast.jpyvnd_forecast_high,
        "factors": [
            {
                "name": f.name,
                "name_vi": FACTOR_GROUPS.get(f.group, {}).get("name_vi", f.name),
                "score": f.score,
                "confidence": f.confidence,
                "weight": f.weight,
                "weighted_score": f.weighted_score,
                "rationale": f.rationale,
                "signal_count": f.signal_count,
            }
            for f in forecast.factors
        ],
    }

    # Convert accuracy stats to dict for template
    accuracy_dict = None
    if accuracy_stats and accuracy_stats.verified_forecasts >= 5:
        accuracy_dict = {
            "accuracy_1d": accuracy_stats.accuracy_1d,
            "accuracy_3d": accuracy_stats.accuracy_3d,
            "accuracy_7d": accuracy_stats.accuracy_7d,
            "total_forecasts": accuracy_stats.total_forecasts,
            "verified_forecasts": accuracy_stats.verified_forecasts,
            "accuracy_7day": accuracy_stats.accuracy_7day,
            "accuracy_30day": accuracy_stats.accuracy_30day,
            "count_7day": accuracy_stats.count_7day,
            "count_30day": accuracy_stats.count_30day,
            "current_streak": accuracy_stats.current_streak,
            "streak_type": accuracy_stats.streak_type,
            "calibration_mode": accuracy_stats.calibration_mode,
            "beats_always_neutral": accuracy_stats.beats_always_neutral,
            "beats_momentum": accuracy_stats.beats_momentum,
            "avg_actual_move_pct": accuracy_stats.avg_actual_move_pct,
            "confidence_calibration": accuracy_stats.confidence_calibration,
            "factor_accuracy": [
                {
                    "group": fa.group,
                    "name_vi": fa.name_vi,
                    "hit_rate": fa.hit_rate,
                    "total": fa.total,
                    "hits": fa.hits,
                    "misses": fa.misses,
                }
                for fa in accuracy_stats.factor_accuracy
            ],
            "recent_history": accuracy_stats.recent_history,
            "vnd_accuracy_1d": accuracy_stats.vnd_accuracy_1d,
            "vnd_total": accuracy_stats.vnd_total,
        }

    html = template.render(
        report_date=now_jst.strftime("%Y-%m-%d (%A)"),
        cutoff_time=now_jst.strftime("%H:%M"),
        generated_at=now_jst.strftime("%Y-%m-%d %H:%M"),
        forecast=forecast_dict,
        market_data=market_dicts,
        symbol_display=SYMBOL_DISPLAY,
        top_news=news_dicts,
        calendar_events=calendar_dicts,
        source_health=health_dicts,
        accuracy=accuracy_dict,
    )

    # Inline CSS into style="" attributes for email client compatibility
    try:
        html = _css_inliner.inline(html)
    except Exception as e:
        logger.warning(f"[email] CSS inlining failed, sending raw HTML: {e}")

    return html


def send_email(
    forecast: ForecastResult,
    market_data: list[MarketDataPoint],
    top_news: list[Article],
    calendar_events: list[Article],
    source_health: list[CrawlerHealth],
    gemini_signals: list[dict] = None,
    accuracy_stats=None,
) -> bool:
    """Render and send daily forecast email."""
    if not all([SMTP_USER, SMTP_PASS, NOTIFY_EMAIL]):
        logger.error("[email] Missing SMTP credentials or NOTIFY_EMAIL in env vars")
        return False

    try:
        html = render_report(forecast, market_data, top_news, calendar_events,
                             source_health, gemini_signals, accuracy_stats)

        now_jst = datetime.now(JST)
        direction_emoji = {"stronger": "💹", "weaker": "📉", "neutral": "➡️"}
        emoji = direction_emoji.get(forecast.jpy_direction, "📊")

        # Find USD/JPY and JPY/VND rates for subject
        usdjpy_str = ""
        jpyvnd_str = ""
        for md in market_data:
            if md.symbol == "usdjpy":
                usdjpy_str = f"¥{md.value:.2f}"
            elif md.symbol == "jpyvnd":
                jpyvnd_str = f" | 1¥={md.value:.0f}₫"

        # Vietnamese direction text
        dir_vi = {"stronger": "TĂNG GIÁ", "weaker": "GIẢM GIÁ", "neutral": "ĐI NGANG"}
        dir_short = {"stronger": "Tăng", "weaker": "Giảm", "neutral": "Ngang"}

        subject = (
            f"{emoji} Yên Nhật {dir_short.get(forecast.jpy_direction, '?')} "
            f"· {now_jst.strftime('%d/%m')} "
            f"· {usdjpy_str}{jpyvnd_str} "
            f"· Score {forecast.overall_score:+.1f}"
        )

        msg = MIMEMultipart("alternative")
        msg["Subject"] = Header(subject, "utf-8")
        msg["From"] = SMTP_USER
        msg["To"] = NOTIFY_EMAIL

        # Plain text fallback (Vietnamese)
        vnd_section = ""
        if forecast.jpyvnd_rate > 0:
            vnd_section = f"\n1 JPY = {forecast.jpyvnd_rate:.1f} VND\n"

        plain = (
            f"Dự báo Yên Nhật {now_jst.strftime('%Y-%m-%d')}\n"
            f"{'='*40}\n"
            f"Hướng đi: {dir_vi.get(forecast.jpy_direction, 'N/A')}\n"
            f"USD/JPY dự kiến: {forecast.usdjpy_direction.upper()}\n"
            f"Điểm: {forecast.overall_score:+.1f} / ±5.0\n"
            f"Độ tin cậy: {forecast.confidence:.0%}\n"
            f"{vnd_section}\n"
            f"Tóm tắt: {forecast.market_summary}\n\n"
            f"Mở HTML để xem báo cáo đầy đủ."
        )

        msg.attach(MIMEText(plain, "plain", "utf-8"))
        msg.attach(MIMEText(html, "html", "utf-8"))

        with smtplib.SMTP(SMTP_SERVER, SMTP_PORT) as server:
            server.ehlo()
            server.starttls()
            server.ehlo()
            server.login(SMTP_USER, SMTP_PASS)
            server.send_message(msg)

        logger.info(f"[email] Report sent to {NOTIFY_EMAIL}: {subject}")
        return True

    except Exception as e:
        logger.error(f"[email] Failed to send: {e}")
        return False
