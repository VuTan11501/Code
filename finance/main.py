"""
JPY Forecast Tool - Main Orchestrator
Pipeline: Crawl → Analyze → Score → Report → Email
"""
import json
import logging
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone, timedelta

# Add project root to path
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent))

from config import (
    ENABLE_RSS, ENABLE_YAHOO_FINANCE, ENABLE_GOOGLE_NEWS,
    ENABLE_ECONOMIC_CALENDAR, ENABLE_REDDIT, ENABLE_TWITTER, ENABLE_COT,
)
from crawlers.base import Article, MarketDataPoint, CrawlerHealth
from crawlers.yahoo_finance import YahooFinanceCrawler
from crawlers.rss_crawler import RSSCrawler
from crawlers.google_news import GoogleNewsCrawler
from crawlers.economic_calendar import EconomicCalendarCrawler
from crawlers.reddit_crawler import RedditCrawler
from crawlers.twitter_crawler import TwitterCrawler
from crawlers.cot_crawler import COTCrawler
from analyzers.gemini_analyzer import analyze_with_gemini
from analyzers.factor_scorer import compute_factor_scores
from analyzers.outcome_verifier import verify_past_predictions
from analyzers.accuracy_tracker import compute_accuracy_stats, auto_calibrate_weights
from analyzers.ml_predictor import predict_next_day as ml_predict_next_day
from reporters.email_reporter import send_email
from data.db import (
    init_db, create_run, finish_run,
    insert_article, insert_market_data, insert_factor_score,
    insert_forecast, insert_gemini_output,
    insert_outcome_at_forecast,
)

# ── Logging Setup ──
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("jpy_forecast")

JST = timezone(timedelta(hours=9))


def run_crawlers() -> tuple[list[Article], list[MarketDataPoint], list[CrawlerHealth]]:
    """Run all enabled crawlers in parallel."""
    crawlers = [
        YahooFinanceCrawler(enabled=ENABLE_YAHOO_FINANCE),
        RSSCrawler(enabled=ENABLE_RSS),
        GoogleNewsCrawler(enabled=ENABLE_GOOGLE_NEWS),
        EconomicCalendarCrawler(enabled=ENABLE_ECONOMIC_CALENDAR),
        COTCrawler(enabled=ENABLE_COT),
        RedditCrawler(enabled=ENABLE_REDDIT),
        TwitterCrawler(enabled=ENABLE_TWITTER),
    ]

    all_articles = []
    all_market_data = []
    health_reports = []

    with ThreadPoolExecutor(max_workers=7) as executor:
        futures = {executor.submit(c.run): c for c in crawlers}

        for future in as_completed(futures):
            crawler = futures[future]
            try:
                articles, market_data = future.result()
                all_articles.extend(articles)
                all_market_data.extend(market_data)
            except Exception as e:
                logger.error(f"[{crawler.name}] Unexpected error: {e}")
                crawler.health.status = "failed"
                crawler.health.error = str(e)

            health_reports.append(crawler.health)

    logger.info(f"Crawling complete: {len(all_articles)} articles, {len(all_market_data)} data points")
    return all_articles, all_market_data, health_reports


def deduplicate_articles(articles: list[Article]) -> list[Article]:
    """Remove duplicate articles by content hash."""
    seen = set()
    unique = []
    for a in articles:
        if a.content_hash not in seen:
            seen.add(a.content_hash)
            unique.append(a)
    return unique


def separate_calendar_articles(articles: list[Article]) -> tuple[list[Article], list[Article]]:
    """Separate calendar events from news articles."""
    calendar = [a for a in articles if a.source == "economic_calendar"]
    news = [a for a in articles if a.source != "economic_calendar"]
    return news, calendar


def run_pipeline(dry_run: bool = False):
    """
    Execute the full forecast pipeline:
    0. Verify past predictions (outcome tracking)
    0.5. Compute accuracy stats & auto-calibrate weights
    1. Initialize DB
    2. Run crawlers in parallel
    3. Deduplicate articles
    4. Analyze with Gemini (extract signals + Vietnamese translations)
    5. Score factors (with calibrated weights)
    6. Generate and send email report (with accuracy stats)
    7. Save everything to DB + record outcome baseline
    """
    start_time = time.time()
    now_jst = datetime.now(JST)
    logger.info(f"{'='*60}")
    logger.info(f"JPY Forecast Pipeline - {now_jst.strftime('%Y-%m-%d %H:%M JST')}")
    logger.info(f"{'='*60}")

    # 1. Initialize
    init_db()
    run_id = create_run()
    errors = []

    try:
        # Step 0: Verify past predictions
        logger.info("Step 0/7: Verifying past predictions...")
        try:
            verify_result = verify_past_predictions()
            if verify_result["verified"] > 0:
                logger.info(f"  Verified {verify_result['verified']} past forecasts")
        except Exception as e:
            logger.warning(f"  Verification failed (non-fatal): {e}")

        # Step 0.5: Compute accuracy stats & calibrate weights
        logger.info("Step 0.5/7: Computing accuracy & calibrating weights...")
        accuracy_stats = compute_accuracy_stats()
        calibrated_weights = auto_calibrate_weights(run_id, accuracy_stats)
        logger.info(f"  Mode: {accuracy_stats.calibration_mode} | "
                    f"Verified: {accuracy_stats.verified_forecasts} | "
                    f"1d accuracy: {accuracy_stats.accuracy_1d:.0%}")

        # 2. Crawl
        logger.info("Step 1/7: Crawling data sources...")
        all_articles, market_data, health_reports = run_crawlers()

        # 3. Deduplicate & separate
        logger.info("Step 2/7: Processing articles...")
        unique_articles = deduplicate_articles(all_articles)
        news_articles, calendar_articles = separate_calendar_articles(unique_articles)
        logger.info(f"  {len(unique_articles)} unique articles ({len(news_articles)} news, {len(calendar_articles)} calendar)")

        # Save articles to DB
        for a in unique_articles:
            insert_article(run_id, a.source, a.title, a.url, a.summary, a.published_at, a.content_hash)

        # Save market data to DB
        for md in market_data:
            insert_market_data(run_id, md.symbol, md.value, md.change_pct, md.timestamp, md.source)

        # 4. Analyze with Gemini
        logger.info("Step 3/7: AI analysis with Gemini...")
        gemini_result = analyze_with_gemini(news_articles)
        gemini_signals = []

        if gemini_result:
            gemini_signals = gemini_result.get("signals", [])
            insert_gemini_output(
                run_id,
                gemini_result.get("_meta", {}).get("prompt_hash", ""),
                gemini_result.get("_meta", {}).get("model", ""),
                f"[{len(news_articles)} articles]",
                json.dumps(gemini_result, ensure_ascii=False),
            )
            logger.info(f"  Gemini: {len(gemini_signals)} signals extracted, "
                        f"bias={gemini_result.get('overall_bias', 'N/A')}, "
                        f"VND={gemini_result.get('vnd_direction', 'N/A')}")
        else:
            errors.append("Gemini analysis failed - using market data only")
            logger.warning("Gemini analysis failed, generating degraded report")

        # 5. ML Prediction (technical analysis)
        logger.info("Step 4/7: ML prediction (technical analysis)...")
        ml_prediction = None
        try:
            ml_prediction = ml_predict_next_day()
            logger.info(f"  ML: {ml_prediction.direction} (prob={ml_prediction.probability:.3f}, "
                        f"model={ml_prediction.model_type}, AUC={ml_prediction.walk_forward_auc:.3f})")
        except Exception as e:
            logger.warning(f"  ML prediction failed (non-fatal): {e}")

        # 6. Score factors (with calibrated weights + ML prediction)
        logger.info("Step 5/7: Computing factor scores...")
        forecast = compute_factor_scores(gemini_result, market_data, calibrated_weights, ml_prediction)

        # Save factor scores to DB
        for f in forecast.factors:
            insert_factor_score(
                run_id, f.group, f.score, f.confidence,
                f.rationale, json.dumps(f.key_articles),
            )

        # Save forecast to DB (with weights used for reproducibility)
        weights_json = json.dumps(calibrated_weights)
        forecast_id = insert_forecast(
            run_id, forecast.jpy_direction, forecast.usdjpy_direction,
            forecast.overall_score, forecast.confidence, forecast.market_summary,
            weights_json,
        )

        # Save current prices as outcome baseline
        usdjpy_now = next((md.value for md in market_data if md.symbol == "usdjpy"), 0)
        jpyvnd_now = next((md.value for md in market_data if md.symbol == "jpyvnd"), 0)
        if usdjpy_now > 0:
            insert_outcome_at_forecast(forecast_id, usdjpy_now, jpyvnd_now)

        # 7. Send email
        logger.info("Step 6/7: Sending email report...")
        if dry_run:
            logger.info("[DRY RUN] Skipping email send")
            from reporters.email_reporter import render_report
            html = render_report(forecast, market_data, news_articles[:20],
                                 calendar_articles, health_reports, gemini_signals,
                                 accuracy_stats)
            output_path = __import__("pathlib").Path(__file__).parent / "data" / f"report_{now_jst.strftime('%Y%m%d')}.html"
            output_path.write_text(html, encoding="utf-8")
            logger.info(f"  Report saved to {output_path}")
            email_sent = True
        else:
            email_sent = send_email(
                forecast, market_data, news_articles[:20],
                calendar_articles, health_reports, gemini_signals,
                accuracy_stats,
            )

        if not email_sent:
            errors.append("Email send failed")

        # 7. Finalize
        source_health_json = json.dumps(
            {h.name: h.status for h in health_reports},
            ensure_ascii=False,
        )
        status = "success" if not errors else "partial"
        finish_run(run_id, status, "; ".join(errors) if errors else None,
                   len(unique_articles), source_health_json)

        elapsed = time.time() - start_time

        # Find JPY/VND rate for logging
        jpyvnd_str = ""
        for md in market_data:
            if md.symbol == "jpyvnd":
                jpyvnd_str = f"  1 JPY = {md.value:.1f} VND ({forecast.vnd_direction})"
                break

        logger.info(f"{'='*60}")
        logger.info(f"Pipeline complete in {elapsed:.1f}s - Status: {status}")
        logger.info(f"  JPY Direction: {forecast.jpy_direction.upper()}")
        logger.info(f"  USD/JPY Expected: {forecast.usdjpy_direction.upper()}")
        logger.info(f"  Score: {forecast.overall_score:+.2f} (Confidence: {forecast.confidence:.0%})")
        if jpyvnd_str:
            logger.info(jpyvnd_str)
        if errors:
            logger.warning(f"  Errors: {'; '.join(errors)}")
        logger.info(f"{'='*60}")

        return forecast

    except Exception as e:
        logger.error(f"Pipeline failed: {e}", exc_info=True)
        finish_run(run_id, "failed", str(e))
        raise


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="JPY Forecast Daily Report")
    parser.add_argument("--dry-run", action="store_true", help="Save HTML locally instead of sending email")
    args = parser.parse_args()

    run_pipeline(dry_run=args.dry_run)
