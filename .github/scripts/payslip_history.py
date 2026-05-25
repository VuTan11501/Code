#!/usr/bin/env python3
"""Payslip history loader — loads monthly stat snapshots from Gist or computes on the fly.

Used by ai_monthly_insight.py for trend analysis (lookback N months).
Zero external dependencies (stdlib only).
"""
import json
import os
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from user_config import GIST_ID  # noqa: E402

INSIGHTS_FILE = "monthly-insights.json"


def _read_gist_file(filename):
    """Read a single file from the project Gist. Returns parsed JSON or None."""
    pat = os.environ.get("GH_PAT")
    if not pat:
        return None
    url = f"https://api.github.com/gists/{GIST_ID}"
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {pat}",
        "Accept": "application/vnd.github+json",
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            gist = json.loads(resp.read())
    except Exception:
        return None
    files = gist.get("files") or {}
    f = files.get(filename)
    if not f:
        return None
    content = f.get("content") or "[]"
    try:
        return json.loads(content)
    except Exception:
        return None


def load_months(n=6, end_month=None, compute_fn=None):
    """Load up to `n` months of historical stats ending at `end_month` (YYYY-MM).

    Strategy:
      1. Try loading from Gist `monthly-insights.json` (cached history).
      2. For months not in cache, call `compute_fn(month_str)` if provided.
      3. Returns list of dicts sorted chronologically (oldest first).

    Args:
        n: Number of months to look back.
        end_month: YYYY-MM string for the last month (inclusive). Defaults to previous month.
        compute_fn: Optional callable(month_str) → dict with at least 'month' key.

    Returns:
        list[dict] — each has at minimum {'month': 'YYYY-MM', 'stats': {...}}
    """
    from datetime import date, timedelta

    if end_month is None:
        today = date.today()
        first_of_month = today.replace(day=1)
        prev = first_of_month - timedelta(days=1)
        end_month = prev.strftime("%Y-%m")

    # Generate list of target months
    year, mon = map(int, end_month.split("-"))
    months = []
    for _ in range(n):
        months.append(f"{year}-{mon:02d}")
        mon -= 1
        if mon < 1:
            mon = 12
            year -= 1
    months.reverse()  # oldest first

    # Try loading from Gist
    cached = _read_gist_file(INSIGHTS_FILE)
    cached_map = {}
    if isinstance(cached, list):
        for entry in cached:
            if isinstance(entry, dict) and "month" in entry:
                cached_map[entry["month"]] = entry

    results = []
    for m in months:
        if m in cached_map:
            results.append(cached_map[m])
        elif compute_fn:
            try:
                computed = compute_fn(m)
                if computed:
                    results.append(computed)
            except Exception:
                pass
        # else: skip this month (no data)

    return results
