"""
Scheduler - Manage GitHub Actions scheduled dispatch for daily JPY forecast.

Uses a Gist-based scheduler (scheduled-dispatch.yml) that polls every 5 minutes
and triggers workflow_dispatch at the configured JST time. This avoids GitHub
Actions native cron delays (5-30+ minutes).

Also supports running with Python's `schedule` library for local testing.
"""
import json
import logging
import subprocess
import sys
from pathlib import Path

logger = logging.getLogger("jpy_forecast")

TASK_NAME = "JPY_Forecast_Daily"
PYTHON_EXE = sys.executable
PROJECT_DIR = Path(__file__).resolve().parent
SCRIPT_PATH = PROJECT_DIR / "main.py"
GIST_ID = "abc2a47c0a396025a72a6580227ff493"
WORKFLOW_FILE = "jpy-forecast.yml"


def _gist_read() -> list[dict] | None:
    """Read scheduled-runs.json from Gist."""
    try:
        result = subprocess.run(
            ["gh", "gist", "view", GIST_ID, "--filename", "scheduled-runs.json"],
            capture_output=True, text=True, check=True,
        )
        return json.loads(result.stdout)
    except (subprocess.CalledProcessError, json.JSONDecodeError) as e:
        print(f"❌ Failed to read Gist: {e}")
        return None


def _gist_write(entries: list[dict]) -> bool:
    """Write scheduled-runs.json to Gist."""
    import tempfile
    tmp = Path(tempfile.gettempdir()) / "scheduled-runs.json"
    tmp.write_text(json.dumps(entries, indent=2, ensure_ascii=False), encoding="utf-8")
    try:
        subprocess.run(
            ["gh", "gist", "edit", GIST_ID, str(tmp)],
            capture_output=True, text=True, check=True,
        )
        return True
    except subprocess.CalledProcessError as e:
        print(f"❌ Failed to write Gist: {e.stderr}")
        return False
    finally:
        tmp.unlink(missing_ok=True)


def _find_entry(entries: list[dict]) -> tuple[int, dict | None]:
    """Find the jpy-forecast entry in the Gist entries."""
    for i, entry in enumerate(entries):
        if entry.get("workflow") == WORKFLOW_FILE:
            return i, entry
    return -1, None


def setup_github_actions(time_str: str = "07:30"):
    """Register/update JPY forecast in the Gist-based scheduler.
    
    The scheduled-dispatch.yml workflow polls every 5 minutes and triggers
    workflow_dispatch at the configured JST time, avoiding native cron delays.
    """
    print(f"Setting up GitHub Actions scheduled dispatch...")
    print(f"  Workflow: {WORKFLOW_FILE}")
    print(f"  Time: {time_str} JST (weekdays only)")
    print(f"  Gist: {GIST_ID}")

    entries = _gist_read()
    if entries is None:
        return False

    new_entry = {
        "type": "recurring",
        "workflow": WORKFLOW_FILE,
        "enabled": True,
        "recurrence": {
            "pattern": "weekdays",
            "time": time_str,
        },
    }

    idx, existing = _find_entry(entries)
    if existing:
        entries[idx] = new_entry
        print(f"\n  Updated existing entry (was: {existing.get('recurrence', {}).get('time', '?')})")
    else:
        entries.append(new_entry)
        print(f"\n  Added new entry")

    if _gist_write(entries):
        print(f"\n✅ Schedule registered!")
        print(f"  • Dispatcher polls every 5 min → ±5 min precision")
        print(f"  • 15-min window + last_run dedup → no missed runs")
        print(f"  • No native cron → no GitHub delay issues")
        print(f"\nTo check: python scheduler.py status")
        print(f"To run now: gh workflow run {WORKFLOW_FILE}")
        return True
    return False


def remove_github_actions():
    """Remove JPY forecast from the Gist-based scheduler."""
    entries = _gist_read()
    if entries is None:
        return False

    idx, existing = _find_entry(entries)
    if existing is None:
        print(f"⚠️ '{WORKFLOW_FILE}' not found in schedule.")
        return True

    entries.pop(idx)
    if _gist_write(entries):
        print(f"✅ '{WORKFLOW_FILE}' removed from schedule.")
        return True
    return False


def query_status():
    """Query the current schedule status from Gist."""
    entries = _gist_read()
    if entries is None:
        return False

    idx, entry = _find_entry(entries)
    if entry is None:
        print(f"❌ '{WORKFLOW_FILE}' not registered in schedule.")
        return False

    rec = entry.get("recurrence", {})
    print(f"📋 Schedule status for '{WORKFLOW_FILE}':")
    print(f"  Enabled:   {entry.get('enabled', True)}")
    print(f"  Pattern:   {rec.get('pattern', '?')}")
    print(f"  Time:      {rec.get('time', '?')} JST")
    last = entry.get("last_run")
    if last:
        print(f"  Last run:  {last}")
    else:
        print(f"  Last run:  (never)")

    # Show all entries
    print(f"\n📋 All scheduled entries ({len(entries)}):")
    for e in entries:
        r = e.get("recurrence", {})
        status = "✅" if e.get("enabled", True) else "⏸️"
        last = e.get("last_run", "never")
        print(f"  {status} {e.get('workflow', '?')} | {r.get('pattern', '?')} @ {r.get('time', '?')} | last: {last}")
    return True


def run_with_schedule(time_str: str = "07:30"):
    """Run using Python schedule library (for local testing/development).
    
    Uses short sleep interval for better precision.
    """
    import schedule
    import time as time_mod
    from datetime import datetime, timezone, timedelta

    from main import run_pipeline

    JST = timezone(timedelta(hours=9))

    print(f"Running with Python scheduler (Ctrl+C to stop)")
    print(f"  Scheduled at: {time_str} daily (JST)")
    print(f"  Sleep interval: 10s (±10s precision)")

    schedule.every().day.at(time_str).do(run_pipeline)

    # Also run immediately for testing
    print(f"\nRunning initial forecast now...")
    run_pipeline()

    while True:
        schedule.run_pending()
        time_mod.sleep(10)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="JPY Forecast Scheduler (GitHub Actions)")
    parser.add_argument("action", choices=["setup", "remove", "status", "test"],
                        help="setup: Register in GitHub Actions | remove: Unregister | status: Check schedule | test: Run locally with schedule lib")
    parser.add_argument("--time", default="07:30", help="Daily run time JST (default: 07:30)")
    args = parser.parse_args()

    if args.action == "setup":
        setup_github_actions(args.time)
    elif args.action == "remove":
        remove_github_actions()
    elif args.action == "status":
        query_status()
    elif args.action == "test":
        run_with_schedule(args.time)
