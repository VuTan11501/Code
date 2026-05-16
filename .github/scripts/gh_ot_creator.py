#!/usr/bin/env python3
"""GitHub Actions — Auto OT Request Creator.
Zero external dependencies (stdlib only).
Reads pending_ot from schedule.json, checks existing OT requests via KINTAI API,
creates missing ones that are within the 7-day creation window.
"""
import os, sys, json, urllib.request, urllib.parse, traceback
from datetime import datetime, timezone, timedelta, date
from calendar import monthrange
from email.mime.text import MIMEText
import smtplib

JST = timezone(timedelta(hours=9))

# ── Config ──
AZURE_APP_ID = "f5be0f68-7285-4365-b979-10af0f3f4106"
AZURE_TENANT = "f01e930a-b52e-42b1-b70f-a8882b5d043b"
AZURE_SCOPE = f"api://{AZURE_APP_ID}/openid user.read offline_access"
API_BASE = "https://api.fjpservice.com/api/"

EMPLOYEE_ID = 8883
APPROVER = "HuyNQ23"
ACCOUNT = "tanvc"
CREATION_WINDOW_DAYS = 7

LOG_LINES = []


def log(msg):
    ts = datetime.now(JST).strftime("%H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line)
    LOG_LINES.append(line)


# ═══════════════════════════════════════════════════════════
#  HTTP HELPERS
# ═══════════════════════════════════════════════════════════

def http_post(url, data=None, json_data=None, headers=None):
    if json_data is not None:
        body = json.dumps(json_data).encode()
        headers = headers or {}
        headers["Content-Type"] = "application/json"
    elif data is not None:
        body = urllib.parse.urlencode(data).encode()
        headers = headers or {}
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    else:
        body = None
    req = urllib.request.Request(url, data=body, headers=headers or {}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read()
            if not raw or not raw.strip():
                return resp.status, {}
            return resp.status, json.loads(raw)
    except urllib.error.HTTPError as e:
        raw = e.read().decode(errors="replace")
        try:
            return e.code, json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            return e.code, {"error": raw}


# ═══════════════════════════════════════════════════════════
#  TOKEN MANAGEMENT
# ═══════════════════════════════════════════════════════════

def refresh_azure_token(refresh_token):
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
    return data["access_token"], data.get("refresh_token", refresh_token)


def get_kintai_token(azure_token):
    status, data = http_post(
        API_BASE + "token",
        data={"module": "KINTAI", "grant_type": "azure_ad_token", "token": azure_token},
    )
    if status != 200 or not data.get("access_token"):
        raise RuntimeError(f"KINTAI token exchange failed: {data}")
    return data["access_token"]


def api_headers(token):
    return {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Module": "KINTAI",
    }


# ═══════════════════════════════════════════════════════════
#  OT REQUEST API
# ═══════════════════════════════════════════════════════════

def search_ot_requests(token, year, month):
    """Get all OT requests for a month."""
    last_day = monthrange(year, month)[1]
    status, data = http_post(
        API_BASE + "otrequest/search",
        json_data={
            "Status": 0,
            "FromDate": f"{year}-{month:02d}-01",
            "ToDate": f"{year}-{month:02d}-{last_day}",
            "IsApproval": False,
        },
        headers=api_headers(token),
    )
    if status == 200 and isinstance(data, list):
        return data
    log(f"  Search OT requests: HTTP {status}, response type: {type(data).__name__}")
    return []


def create_ot_request(token, entry):
    """Create a single OT request from a pending_ot entry."""
    d = date.fromisoformat(entry["date"])
    start_h, start_m = map(int, entry["start"].split(":"))
    end_h, end_m = map(int, entry["end"].split(":"))
    ot_hours = entry["hours"]

    start_dt = datetime(d.year, d.month, d.day, start_h, start_m)
    if end_h < start_h or (end_h == start_h and end_m < start_m):
        end_date = d + timedelta(days=1)
    else:
        end_date = d
    end_dt = datetime(end_date.year, end_date.month, end_date.day, end_h, end_m)

    is_sun = d.weekday() == 6
    is_sat = d.weekday() == 5

    payload = [{
        "employeeId": EMPLOYEE_ID,
        "requestDate": f"{d}T00:00:00",
        "startTime": start_dt.strftime("%Y-%m-%dT%H:%M:%S"),
        "endTime": end_dt.strftime("%Y-%m-%dT%H:%M:%S"),
        "totalOvertime": ot_hours,
        "normalOvertime": ot_hours,
        "lateNightOvertime": 0.0,
        "holidayOvertime": 0.0,
        "sundayWorkingtime": ot_hours if is_sun else 0.0,
        "saturdayWorkingtime": ot_hours if is_sat else 0.0,
        "status": 1,
        "isHoliday": False,
        "reason": entry.get("reason", "task shishin"),
        "approver": APPROVER,
        "account": ACCOUNT,
    }]

    status, resp = http_post(
        API_BASE + "otrequest",
        json_data=payload,
        headers=api_headers(token),
    )
    return status, resp


# ═══════════════════════════════════════════════════════════
#  EMAIL
# ═══════════════════════════════════════════════════════════

def send_email(subject, body):
    smtp_user = os.environ.get("SMTP_USER")
    smtp_pass = os.environ.get("SMTP_PASS")
    notify_email = os.environ.get("NOTIFY_EMAIL")
    if not all([smtp_user, smtp_pass, notify_email]):
        log("Email not configured, skip notification")
        return
    try:
        msg = MIMEText(body, "plain", "utf-8")
        msg["Subject"] = subject
        msg["From"] = smtp_user
        msg["To"] = notify_email
        with smtplib.SMTP("smtp.gmail.com", 587, timeout=15) as server:
            server.starttls()
            server.login(smtp_user, smtp_pass)
            server.send_message(msg)
        log(f"📧 Email sent to {notify_email}")
    except Exception as e:
        log(f"⚠️ Email failed: {e}")


# ═══════════════════════════════════════════════════════════
#  MAIN
# ═══════════════════════════════════════════════════════════

def main():
    now = datetime.now(JST)
    today = now.date()
    log(f"OT Auto-Creator running at {now.strftime('%Y-%m-%d %H:%M:%S %A')}")

    created_count = 0
    skipped_existing = 0
    skipped_window = 0
    skipped_past = 0
    errors = []

    try:
        # Load schedule
        sched_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "schedule.json")
        with open(sched_path, encoding="utf-8") as f:
            schedule = json.load(f)

        pending_ot = schedule.get("pending_ot", [])
        if not pending_ot:
            log("No pending_ot entries in schedule.json. Nothing to do.")
            return

        log(f"Found {len(pending_ot)} planned OT entries")

        # Filter: only process entries within the creation window
        actionable = []
        for entry in pending_ot:
            ot_date = date.fromisoformat(entry["date"])
            days_until = (ot_date - today).days

            if days_until < 0:
                skipped_past += 1
            elif days_until > CREATION_WINDOW_DAYS:
                skipped_window += 1
                log(f"  {entry['date']}: {days_until} days away, outside {CREATION_WINDOW_DAYS}-day window")
            else:
                actionable.append(entry)

        if not actionable:
            log(f"No OT entries within creation window. (past:{skipped_past}, waiting:{skipped_window})")
            return

        log(f"{len(actionable)} entries within {CREATION_WINDOW_DAYS}-day window, checking existing...")

        # Get token
        refresh_token = os.environ.get("AZURE_REFRESH_TOKEN")
        if not refresh_token:
            raise RuntimeError("AZURE_REFRESH_TOKEN secret not set!")

        log("Getting KINTAI token...")
        azure_token, new_refresh = refresh_azure_token(refresh_token)
        kintai_token = get_kintai_token(azure_token)
        log("KINTAI token OK ✓")

        # Get existing OT requests for relevant months
        months_to_check = set()
        for entry in actionable:
            d = date.fromisoformat(entry["date"])
            months_to_check.add((d.year, d.month))

        existing_dates = set()
        for y, m in months_to_check:
            reqs = search_ot_requests(kintai_token, y, m)
            log(f"  Found {len(reqs)} existing OT requests for {y}-{m:02d}")
            for r in reqs:
                rd = datetime.fromisoformat(r["requestDate"]).date()
                existing_dates.add(rd)

        # Create missing OT requests
        for entry in actionable:
            ot_date = date.fromisoformat(entry["date"])
            day_name = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][ot_date.weekday()]

            if ot_date in existing_dates:
                skipped_existing += 1
                log(f"  ✓ {entry['date']} {day_name}: already exists, skip")
                continue

            log(f"  → Creating OT: {entry['date']} {day_name} {entry['start']}→{entry['end']} ({entry['hours']}h)")
            try:
                status, resp = create_ot_request(kintai_token, entry)
                if status == 200:
                    created_count += 1
                    log(f"    ✅ Created successfully")
                else:
                    errors.append(f"{entry['date']}: HTTP {status} - {resp}")
                    log(f"    ❌ Failed: HTTP {status} - {resp}")
            except Exception as e:
                errors.append(f"{entry['date']}: {e}")
                log(f"    ❌ Exception: {e}")

        # Handle token rotation
        if new_refresh != refresh_token:
            log("⚠️ Azure refresh token rotated!")
            # Mask token in GitHub Actions logs
            print(f"::add-mask::{new_refresh}")
            output_file = os.environ.get("GITHUB_OUTPUT")
            if output_file:
                with open(output_file, "a") as f:
                    f.write(f"token_rotated=true\n")
                    f.write(f"new_refresh_token={new_refresh}\n")

    except Exception as e:
        errors.append(str(e))
        log(f"❌ EXCEPTION: {e}")
        traceback.print_exc()
    finally:
        # Summary
        log("")
        log("═══ Summary ═══")
        log(f"  Created: {created_count}")
        log(f"  Already exist: {skipped_existing}")
        log(f"  Past dates: {skipped_past}")
        log(f"  Outside window: {skipped_window}")
        if errors:
            log(f"  Errors: {len(errors)}")
            for e in errors:
                log(f"    • {e}")

        # Send email if anything was created or failed
        if created_count > 0 or errors:
            emoji = "✅" if not errors else "⚠️"
            subject = f"{emoji} OT Auto-Creator: {created_count} created, {len(errors)} errors — {today}"
            body = "\n".join(LOG_LINES)
            send_email(subject, body)

        if errors:
            sys.exit(1)


if __name__ == "__main__":
    main()
