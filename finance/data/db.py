"""
SQLite Database Manager for JPY Forecast Tool.
Stores articles, market data, factor scores, forecasts, outcomes, and weight calibration.
"""
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from config import DB_PATH, DATA_DIR


def get_connection() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    """Create all tables if they don't exist."""
    conn = get_connection()
    conn.executescript("""
    CREATE TABLE IF NOT EXISTS runs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at  TEXT NOT NULL,
        finished_at TEXT,
        status      TEXT DEFAULT 'running',
        errors      TEXT,
        article_count INTEGER DEFAULT 0,
        source_health TEXT
    );

    CREATE TABLE IF NOT EXISTS articles (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id      INTEGER REFERENCES runs(id),
        source      TEXT NOT NULL,
        title       TEXT NOT NULL,
        url         TEXT,
        summary     TEXT,
        published_at TEXT,
        fetched_at  TEXT NOT NULL,
        content_hash TEXT,
        UNIQUE(content_hash)
    );

    CREATE TABLE IF NOT EXISTS market_data (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id      INTEGER REFERENCES runs(id),
        symbol      TEXT NOT NULL,
        value       REAL,
        change_pct  REAL,
        timestamp   TEXT,
        source      TEXT DEFAULT 'yfinance',
        fetched_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS gemini_outputs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id      INTEGER REFERENCES runs(id),
        prompt_hash TEXT,
        model       TEXT,
        input_text  TEXT,
        output_json TEXT,
        created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS factor_scores (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id      INTEGER REFERENCES runs(id),
        factor_group TEXT NOT NULL,
        score       REAL NOT NULL,
        confidence  REAL DEFAULT 0.5,
        rationale   TEXT,
        key_articles TEXT
    );

    CREATE TABLE IF NOT EXISTS forecasts (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id      INTEGER REFERENCES runs(id),
        jpy_direction TEXT NOT NULL,
        usdjpy_direction TEXT NOT NULL,
        overall_score REAL,
        confidence  REAL,
        summary     TEXT,
        created_at  TEXT NOT NULL,
        weights_used TEXT
    );

    CREATE TABLE IF NOT EXISTS outcomes (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        forecast_id     INTEGER UNIQUE REFERENCES forecasts(id),
        -- Prices at forecast time (saved immediately)
        usdjpy_at_forecast REAL,
        jpyvnd_at_forecast REAL,
        -- Actual prices after N days
        usdjpy_after_1d  REAL,
        usdjpy_after_3d  REAL,
        usdjpy_after_7d  REAL,
        jpyvnd_after_1d  REAL,
        jpyvnd_after_7d  REAL,
        -- Per-horizon actual direction
        actual_direction_1d TEXT,
        actual_direction_3d TEXT,
        actual_direction_7d TEXT,
        -- Per-horizon hit/miss
        hit_1d      INTEGER,
        hit_3d      INTEGER,
        hit_7d      INTEGER,
        vnd_hit_1d  INTEGER,
        -- Actual move percentages for magnitude tracking
        actual_move_pct_1d REAL,
        actual_move_pct_3d REAL,
        actual_move_pct_7d REAL,
        -- Evaluation timestamps
        evaluated_at_1d TEXT,
        evaluated_at_3d TEXT,
        evaluated_at_7d TEXT,
        -- Metadata
        verified_at TEXT,
        updated_at  TEXT
    );

    -- Weight calibration audit trail
    CREATE TABLE IF NOT EXISTS calibrated_weights (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id          INTEGER REFERENCES runs(id),
        factor_group    TEXT NOT NULL,
        old_weight      REAL,
        new_weight      REAL,
        reason          TEXT,
        mode            TEXT DEFAULT 'shadow',  -- 'shadow' or 'active'
        created_at      TEXT NOT NULL
    );

    -- Factor-level outcome tracking
    CREATE TABLE IF NOT EXISTS factor_outcomes (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        forecast_id     INTEGER REFERENCES forecasts(id),
        factor_group    TEXT NOT NULL,
        factor_score    REAL,
        factor_direction TEXT,       -- stronger/weaker/neutral
        signed_alignment REAL,      -- sign(score) * sign(actual_move)
        hit             INTEGER,    -- did factor direction match actual?
        UNIQUE(forecast_id, factor_group)
    );

    CREATE INDEX IF NOT EXISTS idx_articles_run ON articles(run_id);
    CREATE INDEX IF NOT EXISTS idx_articles_hash ON articles(content_hash);
    CREATE INDEX IF NOT EXISTS idx_market_data_run ON market_data(run_id);
    CREATE INDEX IF NOT EXISTS idx_factor_scores_run ON factor_scores(run_id);
    CREATE INDEX IF NOT EXISTS idx_forecasts_run ON forecasts(run_id);
    CREATE INDEX IF NOT EXISTS idx_outcomes_forecast ON outcomes(forecast_id);
    CREATE INDEX IF NOT EXISTS idx_calibrated_weights_run ON calibrated_weights(run_id);
    CREATE INDEX IF NOT EXISTS idx_factor_outcomes_forecast ON factor_outcomes(forecast_id);
    """)
    conn.commit()
    conn.close()


def create_run() -> int:
    conn = get_connection()
    cur = conn.execute(
        "INSERT INTO runs (started_at) VALUES (?)",
        (datetime.now(timezone.utc).isoformat(),)
    )
    run_id = cur.lastrowid
    conn.commit()
    conn.close()
    return run_id


def finish_run(run_id: int, status: str, errors: Optional[str] = None,
               article_count: int = 0, source_health: Optional[str] = None):
    conn = get_connection()
    conn.execute(
        """UPDATE runs SET finished_at=?, status=?, errors=?,
           article_count=?, source_health=? WHERE id=?""",
        (datetime.now(timezone.utc).isoformat(), status, errors,
         article_count, source_health, run_id)
    )
    conn.commit()
    conn.close()


def insert_article(run_id: int, source: str, title: str, url: str,
                   summary: str, published_at: str, content_hash: str) -> Optional[int]:
    """Insert article, returns None if duplicate."""
    conn = get_connection()
    try:
        cur = conn.execute(
            """INSERT OR IGNORE INTO articles
               (run_id, source, title, url, summary, published_at, fetched_at, content_hash)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (run_id, source, title, url, summary, published_at,
             datetime.now(timezone.utc).isoformat(), content_hash)
        )
        conn.commit()
        return cur.lastrowid if cur.rowcount > 0 else None
    finally:
        conn.close()


def insert_market_data(run_id: int, symbol: str, value: float,
                       change_pct: float, timestamp: str, source: str = "yfinance"):
    conn = get_connection()
    conn.execute(
        """INSERT INTO market_data
           (run_id, symbol, value, change_pct, timestamp, source, fetched_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (run_id, symbol, value, change_pct, timestamp, source,
         datetime.now(timezone.utc).isoformat())
    )
    conn.commit()
    conn.close()


def insert_factor_score(run_id: int, factor_group: str, score: float,
                        confidence: float, rationale: str, key_articles: str = "[]"):
    conn = get_connection()
    conn.execute(
        """INSERT INTO factor_scores
           (run_id, factor_group, score, confidence, rationale, key_articles)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (run_id, factor_group, score, confidence, rationale, key_articles)
    )
    conn.commit()
    conn.close()


def insert_forecast(run_id: int, jpy_direction: str, usdjpy_direction: str,
                    overall_score: float, confidence: float, summary: str,
                    weights_used: str = "") -> int:
    conn = get_connection()
    cur = conn.execute(
        """INSERT INTO forecasts
           (run_id, jpy_direction, usdjpy_direction, overall_score, confidence,
            summary, created_at, weights_used)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (run_id, jpy_direction, usdjpy_direction, overall_score, confidence,
         summary, datetime.now(timezone.utc).isoformat(), weights_used)
    )
    forecast_id = cur.lastrowid
    conn.commit()
    conn.close()
    return forecast_id


def insert_outcome_at_forecast(forecast_id: int, usdjpy_at_forecast: float,
                               jpyvnd_at_forecast: float = 0.0):
    """Save current prices at forecast creation time."""
    conn = get_connection()
    conn.execute(
        """INSERT OR IGNORE INTO outcomes
           (forecast_id, usdjpy_at_forecast, jpyvnd_at_forecast, updated_at)
           VALUES (?, ?, ?, ?)""",
        (forecast_id, usdjpy_at_forecast, jpyvnd_at_forecast,
         datetime.now(timezone.utc).isoformat())
    )
    conn.commit()
    conn.close()


def insert_factor_outcome(forecast_id: int, factor_group: str, factor_score: float,
                          factor_direction: str, signed_alignment: float, hit: int):
    conn = get_connection()
    conn.execute(
        """INSERT OR IGNORE INTO factor_outcomes
           (forecast_id, factor_group, factor_score, factor_direction,
            signed_alignment, hit)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (forecast_id, factor_group, factor_score, factor_direction,
         signed_alignment, hit)
    )
    conn.commit()
    conn.close()


def insert_gemini_output(run_id: int, prompt_hash: str, model: str,
                         input_text: str, output_json: str):
    conn = get_connection()
    conn.execute(
        """INSERT INTO gemini_outputs
           (run_id, prompt_hash, model, input_text, output_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (run_id, prompt_hash, model, input_text, output_json,
         datetime.now(timezone.utc).isoformat())
    )
    conn.commit()
    conn.close()


def get_pending_outcomes() -> list[dict]:
    """Get forecasts that need outcome verification (missing 1d/3d/7d data)."""
    conn = get_connection()
    rows = conn.execute("""
        SELECT f.id as forecast_id, f.jpy_direction, f.overall_score,
               f.created_at, f.run_id,
               o.usdjpy_at_forecast, o.jpyvnd_at_forecast,
               o.usdjpy_after_1d, o.usdjpy_after_3d, o.usdjpy_after_7d,
               o.jpyvnd_after_1d, o.jpyvnd_after_7d
        FROM forecasts f
        LEFT JOIN outcomes o ON f.id = o.forecast_id
        WHERE o.usdjpy_at_forecast IS NOT NULL
          AND (o.usdjpy_after_1d IS NULL OR o.usdjpy_after_3d IS NULL OR o.usdjpy_after_7d IS NULL)
        ORDER BY f.created_at ASC
    """).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def update_outcome(forecast_id: int, **kwargs):
    """Update outcome fields dynamically."""
    conn = get_connection()
    sets = []
    vals = []
    for k, v in kwargs.items():
        sets.append(f"{k} = ?")
        vals.append(v)
    sets.append("updated_at = ?")
    vals.append(datetime.now(timezone.utc).isoformat())
    vals.append(forecast_id)
    conn.execute(
        f"UPDATE outcomes SET {', '.join(sets)} WHERE forecast_id = ?", vals
    )
    conn.commit()
    conn.close()


def get_completed_outcomes(days: int = 90) -> list[dict]:
    """Get outcomes with at least 1d verification for accuracy stats."""
    conn = get_connection()
    rows = conn.execute("""
        SELECT f.id as forecast_id, f.jpy_direction, f.overall_score,
               f.confidence, f.created_at, f.weights_used,
               o.*
        FROM forecasts f
        JOIN outcomes o ON f.id = o.forecast_id
        WHERE o.hit_1d IS NOT NULL
          AND f.created_at >= datetime('now', ? || ' days')
        ORDER BY f.created_at DESC
    """, (f"-{days}",)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_factor_outcomes_for_forecast(forecast_id: int) -> list[dict]:
    conn = get_connection()
    rows = conn.execute(
        "SELECT * FROM factor_outcomes WHERE forecast_id = ? ORDER BY factor_group",
        (forecast_id,)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_latest_calibrated_weights() -> dict[str, float]:
    """Get most recent active calibrated weights."""
    conn = get_connection()
    rows = conn.execute("""
        SELECT factor_group, new_weight FROM calibrated_weights
        WHERE mode = 'active'
          AND run_id = (SELECT MAX(run_id) FROM calibrated_weights WHERE mode = 'active')
        ORDER BY factor_group
    """).fetchall()
    conn.close()
    return {r["factor_group"]: r["new_weight"] for r in rows}


def insert_calibrated_weight(run_id: int, factor_group: str,
                             old_weight: float, new_weight: float,
                             reason: str, mode: str = "shadow"):
    conn = get_connection()
    conn.execute(
        """INSERT INTO calibrated_weights
           (run_id, factor_group, old_weight, new_weight, reason, mode, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (run_id, factor_group, old_weight, new_weight, reason, mode,
         datetime.now(timezone.utc).isoformat())
    )
    conn.commit()
    conn.close()


def get_recent_forecasts(days: int = 30) -> list[dict]:
    conn = get_connection()
    rows = conn.execute(
        """SELECT f.*, r.started_at as run_date
           FROM forecasts f JOIN runs r ON f.run_id = r.id
           WHERE r.started_at >= datetime('now', ? || ' days')
           ORDER BY r.started_at DESC""",
        (f"-{days}",)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_articles_for_run(run_id: int) -> list[dict]:
    conn = get_connection()
    rows = conn.execute(
        "SELECT * FROM articles WHERE run_id = ? ORDER BY published_at DESC",
        (run_id,)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


if __name__ == "__main__":
    init_db()
    print(f"Database initialized at {DB_PATH}")
