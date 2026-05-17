"""
Scheduler - Set up Windows Task Scheduler for daily JPY forecast.
Also supports running with Python's `schedule` library for testing.
"""
import logging
import subprocess
import sys
from pathlib import Path

logger = logging.getLogger("jpy_forecast")

TASK_NAME = "JPY_Forecast_Daily"
PYTHON_EXE = sys.executable
SCRIPT_PATH = Path(__file__).resolve().parent / "main.py"


def setup_windows_task_scheduler(time_str: str = "07:00"):
    """Create a Windows Task Scheduler task for daily execution."""
    print(f"Setting up Windows Task Scheduler...")
    print(f"  Task name: {TASK_NAME}")
    print(f"  Time: {time_str} daily")
    print(f"  Python: {PYTHON_EXE}")
    print(f"  Script: {SCRIPT_PATH}")

    # Build schtasks command
    cmd = [
        "schtasks", "/Create",
        "/TN", TASK_NAME,
        "/TR", f'"{PYTHON_EXE}" "{SCRIPT_PATH}"',
        "/SC", "DAILY",
        "/ST", time_str,
        "/F",  # Force overwrite if exists
        "/RL", "HIGHEST",  # Run with highest privileges
    ]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        print(f"\n✅ Task created successfully!")
        print(f"  {result.stdout.strip()}")
        print(f"\nTo verify: schtasks /Query /TN {TASK_NAME}")
        print(f"To delete: schtasks /Delete /TN {TASK_NAME} /F")
        print(f"To run now: schtasks /Run /TN {TASK_NAME}")
        return True
    except subprocess.CalledProcessError as e:
        print(f"\n❌ Failed to create task: {e.stderr}")
        return False


def remove_windows_task():
    """Remove the scheduled task."""
    try:
        result = subprocess.run(
            ["schtasks", "/Delete", "/TN", TASK_NAME, "/F"],
            capture_output=True, text=True, check=True,
        )
        print(f"✅ Task '{TASK_NAME}' removed.")
        return True
    except subprocess.CalledProcessError as e:
        print(f"❌ Failed to remove task: {e.stderr}")
        return False


def run_with_schedule(time_str: str = "07:00"):
    """Run using Python schedule library (for testing/development)."""
    import schedule
    import time as time_mod

    from main import run_pipeline

    print(f"Running with Python scheduler (Ctrl+C to stop)")
    print(f"  Scheduled at: {time_str} daily")

    schedule.every().day.at(time_str).do(run_pipeline)

    # Also run immediately for testing
    print(f"\nRunning initial forecast now...")
    run_pipeline()

    while True:
        schedule.run_pending()
        time_mod.sleep(60)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="JPY Forecast Scheduler")
    parser.add_argument("action", choices=["setup", "remove", "test"],
                        help="setup: Create Windows Task | remove: Delete task | test: Run with schedule lib")
    parser.add_argument("--time", default="07:00", help="Daily run time (default: 07:00)")
    args = parser.parse_args()

    if args.action == "setup":
        setup_windows_task_scheduler(args.time)
    elif args.action == "remove":
        remove_windows_task()
    elif args.action == "test":
        run_with_schedule(args.time)
