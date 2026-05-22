#!/usr/bin/env python3
"""Daily attendance validation — compare DokoKin status against schedule.json.

Checks today's expected checkin/checkout against actual DokoKin records.
Exits with code 1 on mismatch (for GitHub Actions failure detection).

Requires: AZURE_REFRESH_TOKEN env var.
Zero external dependencies (stdlib only).
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone

JST = timezone(timedelta(hours=9))

AZURE_APP_ID = "f5be0f68-7285-4365-b979-10af0f3f4106"
AZURE_TENANT = "f01e930a-b52e-42b1-b70f-a8882b5d043b"
AZURE_SCOPE = f"api://{AZURE_APP_ID}/openid user.read offline_access"
API_BASE = "https://api.fjpservice.com/api/"


def http_post(url, data=None, headers=None):
    if data is not None:
        body = urllib.parse.urlencode(data).encode()
        headers = headers or {}
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    else:
        body = None
    req = urllib.request.Request(url, data=body, headers=headers or {}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read()
            return resp.status, json.loads(raw) if raw.strip() else {}
    except urllib.error.HTTPError as e:
        raw = e.read().decode(errors="replace")
        try:
            return e.code, json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            return e.code, {"error": raw}


def http_get(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {}, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read()
            return resp.status, json.loads(raw) if raw.strip() else {}
    except urllib.error.HTTPError as e:
        raw = e.read().decode(errors="replace")
        try:
            return e.code, json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            return e.code, {"error": raw}


def get_tokens(refresh_token):
    """Refresh Azure AD token → exchange for KINTAI token."""
    status, data = http_post(
        f"https://login.microsoftonline.com/{AZURE_TENANT}/oauth2/v2.0/token",
        data={
            "client_id": AZURE_APP_ID,
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "scope": AZURE_SCOPE,
        },
    )
    if status != 200:
        raise RuntimeError(f"Azure refresh failed ({status}): {data}")
    azure_token = data["access_token"]

    status, data = http_post(
        API_BASE + "token",
        data={"module": "KINTAI", "grant_type": "azure_ad_token", "token": azure_token},
    )
    if status != 200 or not data.get("access_token"):
        raise RuntimeError(f"KINTAI token exchange failed: {data}")
    return data["access_token"]


def get_dakoku_status(token, date_str):
    """GET dakoku status for a date.

    The KINTAI API uses startWorkingTime / endWorkingTime (with display variants).
    Older field names (checkinDate/checkinTime) are kept as fallback for safety.
    """
    status, data = http_get(
        API_BASE + f"dakoku/me/{date_str}",
        headers={"Authorization": f"Bearer {token}", "Module": "KINTAI"},
    )
    if status == 200 and data:
        ci = (
            data.get("startWorkingTime")
            or data.get("displayStartWorkingTime")
            or data.get("checkinDate")
            or data.get("checkinTime")
        )
        co = (
            data.get("endWorkingTime")
            or data.get("displayEndWorkingTime")
            or data.get("checkoutDate")
            or data.get("checkoutTime")
        )
        return ci, co
    return None, None


def load_schedule():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "schedule.json")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def find_today_actions(schedule, today_str):
    """Find scheduled actions for today."""
    results = []
    for entry in schedule.get("actions", []):
        dt_str = entry.get("datetime", "")
        if dt_str.startswith(today_str):
            results.append(entry)
    return results


def format_time(iso_str):
    """Extract HH:MM from an ISO datetime string."""
    if not iso_str:
        return None
    try:
        dt = datetime.fromisoformat(iso_str.replace("Z", "+00:00"))
        return dt.astimezone(JST).strftime("%H:%M")
    except (ValueError, AttributeError):
        return iso_str[:16] if len(iso_str) >= 16 else iso_str


def main():
    now = datetime.now(JST)
    today = now.date()
    today_str = today.isoformat()

    print(f"=== Daily Attendance Validation ===")
    print(f"Date: {today_str} ({today.strftime('%A')})")
    print(f"Time: {now.strftime('%H:%M JST')}")
    print()

    # Load schedule
    schedule = load_schedule()
    expected = find_today_actions(schedule, today_str)

    if not expected:
        print(f"No scheduled actions for today ({today_str}).")
        print("Result: SKIP (no schedule)")
        return

    expected_ci = None
    expected_co = None
    for entry in expected:
        if entry["action"] == "checkin":
            expected_ci = entry["datetime"].split(" ")[1]
        elif entry["action"] == "checkout":
            expected_co = entry["datetime"].split(" ")[1]

    print(f"Expected: CI={expected_ci or '—'}, CO={expected_co or '—'}")

    # Get actual status from DokoKin
    refresh_token = os.environ.get("AZURE_REFRESH_TOKEN")
    if not refresh_token:
        print("WARNING: AZURE_REFRESH_TOKEN not set, cannot verify against API")
        print("Expected actions for today:")
        for entry in expected:
            print(f"  {entry['action']} at {entry['datetime']} ({entry.get('location', '?')})")
        return

    try:
        token = get_tokens(refresh_token)
        actual_ci, actual_co = get_dakoku_status(token, today_str)
    except Exception as e:
        print(f"ERROR: Failed to get DokoKin status: {e}")
        sys.exit(1)

    actual_ci_time = format_time(actual_ci)
    actual_co_time = format_time(actual_co)
    print(f"Actual:   CI={actual_ci_time or '—'}, CO={actual_co_time or '—'}")
    print()

    # Validate
    issues = []

    if expected_ci and not actual_ci:
        issues.append(f"MISSING CHECKIN: expected at {expected_ci}, no record found")
    elif expected_ci and actual_ci_time:
        exp_h, exp_m = map(int, expected_ci.split(":"))
        act_h, act_m = map(int, actual_ci_time.split(":"))
        diff = abs((act_h * 60 + act_m) - (exp_h * 60 + exp_m))
        if diff > 30:
            issues.append(f"CHECKIN TIME MISMATCH: expected {expected_ci}, actual {actual_ci_time} (diff {diff}min)")

    # Only check checkout if it's after expected CO time
    if expected_co:
        exp_co_h, exp_co_m = map(int, expected_co.split(":"))
        if now.hour > exp_co_h or (now.hour == exp_co_h and now.minute >= exp_co_m + 30):
            if not actual_co:
                issues.append(f"MISSING CHECKOUT: expected at {expected_co}, no record found")
            elif actual_co_time:
                act_h, act_m = map(int, actual_co_time.split(":"))
                diff = abs((act_h * 60 + act_m) - (exp_co_h * 60 + exp_co_m))
                if diff > 30:
                    issues.append(f"CHECKOUT TIME MISMATCH: expected {expected_co}, actual {actual_co_time} (diff {diff}min)")
        else:
            print(f"Note: Checkout not yet due (expected at {expected_co})")

    if issues:
        print("⚠️ DISCREPANCIES FOUND:")
        for issue in issues:
            print(f"  • {issue}")
        print()
        print("Result: FAIL")
        sys.exit(1)
    else:
        print("✅ All scheduled actions match DokoKin records.")
        print("Result: PASS")


if __name__ == "__main__":
    main()
