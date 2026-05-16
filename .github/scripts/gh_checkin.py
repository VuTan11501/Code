#!/usr/bin/env python3
"""GitHub Actions — DokoKin auto checkin/checkout.
Zero external dependencies (stdlib only).
Reads schedule.json, matches current JST time, executes checkin/checkout via API.
Optionally sends email notification via SMTP.
"""
import os, sys, json, urllib.request, urllib.parse, traceback
from datetime import datetime, timezone, timedelta
from email.mime.text import MIMEText
import smtplib

JST = timezone(timedelta(hours=9))

# ── Azure AD / DokoKin config ──
AZURE_APP_ID = "f5be0f68-7285-4365-b979-10af0f3f4106"
AZURE_TENANT = "f01e930a-b52e-42b1-b70f-a8882b5d043b"
AZURE_SCOPE = f"api://{AZURE_APP_ID}/openid user.read offline_access"
API_BASE = "https://api.fjpservice.com/api/"

LOG_LINES = []


def log(msg):
    ts = datetime.now(JST).strftime("%H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line)
    LOG_LINES.append(line)


# ═══════════════════════════════════════════════════════════
#  TOKEN MANAGEMENT
# ═══════════════════════════════════════════════════════════

def http_post(url, data=None, json_data=None, headers=None):
    """Simple HTTP POST using urllib."""
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
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, {"error": e.read().decode(errors="replace")}


def http_get(url, headers=None):
    """Simple HTTP GET using urllib."""
    req = urllib.request.Request(url, headers=headers or {}, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, {"error": e.read().decode(errors="replace")}


def refresh_azure_token(refresh_token):
    """Refresh Azure AD token. Returns (access_token, new_refresh_token)."""
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


def get_dokokin_token(azure_token):
    """Exchange Azure AD token for DokoKin KINTAI token."""
    status, data = http_post(
        API_BASE + "token",
        data={"module": "KINTAI", "grant_type": "azure_ad_token", "token": azure_token},
    )
    if status != 200 or not data.get("access_token"):
        raise RuntimeError(f"DokoKin token exchange failed: {data}")
    return data["access_token"]


# ═══════════════════════════════════════════════════════════
#  STATUS CHECK
# ═══════════════════════════════════════════════════════════

def get_dakoku_status(token, date_str):
    """GET dakoku status for a date. Returns (checkin_time, checkout_time) or None."""
    status, data = http_get(
        API_BASE + f"dakoku/me/{date_str}",
        headers={"Authorization": f"Bearer {token}", "Module": "KINTAI"},
    )
    if status == 200 and data:
        ci = data.get("checkinDate") or data.get("checkinTime")
        co = data.get("checkoutDate") or data.get("checkoutTime")
        return ci, co
    return None, None


# ═══════════════════════════════════════════════════════════
#  CHECKIN / CHECKOUT
# ═══════════════════════════════════════════════════════════

def do_dakoku(token, checkin_type, lat, lon, is_checkout=False):
    """POST dakoku. checkin_type: 1=checkin, 2=checkout."""
    now = datetime.now(JST)
    body = {
        "employeeId": 8883,
        "appId": "com.fjp.portal",
        "logTime": now.strftime("%Y-%m-%dT%H:%M:%S"),
        "isCheckoutYesterday": False,
        "TotalOfBreakTime": 0,
    }
    if is_checkout:
        body.update(checkoutType=checkin_type, checkoutLongitute=lon, checkoutLatitude=lat)
    else:
        body.update(checkinType=checkin_type, checkinLongitute=lon, checkinLatitude=lat)

    status, data = http_post(
        API_BASE + "dakoku",
        json_data=body,
        headers={
            "Authorization": f"Bearer {token}",
            "Module": "KINTAI",
        },
    )
    return status, data


# ═══════════════════════════════════════════════════════════
#  SCHEDULE MATCHING
# ═══════════════════════════════════════════════════════════

def load_schedule():
    """Load schedule.json from same directory as this script."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "schedule.json")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def find_matching_action(schedule, now_jst):
    """Find action matching current time within tolerance."""
    tolerance = schedule.get("tolerance_minutes", 30)
    now_minutes = now_jst.hour * 60 + now_jst.minute
    now_date = now_jst.date()

    for entry in schedule["actions"]:
        dt = datetime.strptime(entry["datetime"], "%Y-%m-%d %H:%M")
        entry_date = dt.date()
        entry_minutes = dt.hour * 60 + dt.minute

        if entry_date != now_date:
            continue

        diff = abs(now_minutes - entry_minutes)
        if diff > 12 * 60:  # handle midnight wrap
            diff = 24 * 60 - diff

        if diff <= tolerance:
            return entry

    return None


# ═══════════════════════════════════════════════════════════
#  NOTIFICATION
# ═══════════════════════════════════════════════════════════

def send_email(subject, body):
    """Send email notification via SMTP. Requires env vars."""
    smtp_server = os.environ.get("SMTP_SERVER", "smtp.gmail.com")
    smtp_port = int(os.environ.get("SMTP_PORT", "587"))
    smtp_user = os.environ.get("SMTP_USER")
    smtp_pass = os.environ.get("SMTP_PASS")
    notify_email = os.environ.get("NOTIFY_EMAIL")

    if not all([smtp_user, smtp_pass, notify_email]):
        log("Email not configured (SMTP_USER/SMTP_PASS/NOTIFY_EMAIL missing), skip notification")
        return

    try:
        msg = MIMEText(body, "plain", "utf-8")
        msg["Subject"] = subject
        msg["From"] = smtp_user
        msg["To"] = notify_email

        with smtplib.SMTP(smtp_server, smtp_port, timeout=15) as server:
            server.starttls()
            server.login(smtp_user, smtp_pass)
            server.send_message(msg)
        log(f"📧 Email sent to {notify_email}")
    except Exception as e:
        log(f"⚠️ Email failed: {e}")


# ═══════════════════════════════════════════════════════════
#  GITHUB ACTIONS HELPERS
# ═══════════════════════════════════════════════════════════

def set_output(key, value):
    """Set GitHub Actions output variable."""
    output_file = os.environ.get("GITHUB_OUTPUT")
    if output_file:
        with open(output_file, "a") as f:
            # Use multiline syntax for values that might contain special chars
            if "\n" in str(value):
                import uuid
                delim = f"ghadelimiter_{uuid.uuid4()}"
                f.write(f"{key}<<{delim}\n{value}\n{delim}\n")
            else:
                f.write(f"{key}={value}\n")


def set_summary(markdown):
    """Write GitHub Actions step summary."""
    summary_file = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_file:
        with open(summary_file, "a") as f:
            f.write(markdown + "\n")


# ═══════════════════════════════════════════════════════════
#  MAIN
# ═══════════════════════════════════════════════════════════

def main():
    now_jst = datetime.now(JST)
    log(f"Current JST: {now_jst.strftime('%Y-%m-%d %H:%M:%S %A')}")

    result_status = "skip"
    result_detail = ""

    try:
        # ── Check for manual override via env ──
        force_action = os.environ.get("FORCE_ACTION")  # "checkin" or "checkout"
        if force_action == "auto" or force_action == "":
            force_action = None
        force_location = os.environ.get("FORCE_LOCATION", "office")

        # ── Load schedule and find action ──
        schedule = load_schedule()

        if force_action:
            action_entry = {
                "action": force_action,
                "location": force_location,
                "note": "manual override",
            }
            log(f"FORCE mode: {force_action} at {force_location}")
        else:
            action_entry = find_matching_action(schedule, now_jst)

        if not action_entry:
            log("No scheduled action for current time. Skipping.")
            set_output("skipped", "true")
            set_summary(f"⏭️ **Skipped** — no action at {now_jst.strftime('%Y-%m-%d %H:%M')} JST ({now_jst.strftime('%A')})")
            return  # No email for routine skips

        action = action_entry["action"]
        location_key = action_entry["location"]
        loc = schedule["locations"][location_key]
        note = action_entry.get("note", "")

        log(f"Action: {action} at {location_key} ({loc['name']})")
        if note:
            log(f"Note: {note}")

        # ── Get tokens ──
        refresh_token = os.environ.get("AZURE_REFRESH_TOKEN")
        if not refresh_token:
            log("ERROR: AZURE_REFRESH_TOKEN secret not set!")
            result_status = "error"
            result_detail = "AZURE_REFRESH_TOKEN not set"
            sys.exit(1)

        log("Refreshing Azure AD token...")
        azure_token, new_refresh = refresh_azure_token(refresh_token)
        log("Azure token OK ✓")

        log("Exchanging for DokoKin token...")
        dokokin_token = get_dokokin_token(azure_token)
        log("DokoKin token OK ✓")

        # ── Pre-action status check ──
        today_str = now_jst.strftime("%Y-%m-%d")
        yesterday_str = (now_jst - timedelta(days=1)).strftime("%Y-%m-%d")

        log(f"Checking current status for {today_str}...")
        ci_today, co_today = get_dakoku_status(dokokin_token, today_str)
        if ci_today:
            log(f"  Today: CI={ci_today}, CO={co_today or 'none'}")
        else:
            log("  Today: no record")

        # Also check yesterday for overnight shifts
        ci_yest, co_yest = get_dakoku_status(dokokin_token, yesterday_str)
        if ci_yest:
            log(f"  Yesterday: CI={ci_yest}, CO={co_yest or 'none'}")

        # Smart conflict detection
        if action == "checkin" and ci_today and not co_today:
            log("⚠️ Already checked in today without checkout. Will attempt checkin anyway (may overwrite).")
        elif action == "checkout" and not ci_today and not ci_yest:
            log("⚠️ No checkin record found for today or yesterday. Checkout may fail.")

        # ── Execute ──
        checkin_type = 1  # GPS-based checkin type
        is_checkout = action == "checkout"
        emoji = "📥" if action == "checkin" else "📤"
        status, result = do_dakoku(dokokin_token, checkin_type, loc["lat"], loc["lon"], is_checkout)

        if status == 200:
            log(f"{emoji} {action.upper()} SUCCESS at {loc['name']}")
            result_status = "success"
            result_detail = f"{action} at {loc['name']} ({location_key})"

            # Post-action verification
            log("Verifying status after action...")
            ci_after, co_after = get_dakoku_status(dokokin_token, today_str)
            if ci_after:
                log(f"  Verified: CI={ci_after}, CO={co_after or 'pending'}")

            set_output("success", "true")
            set_summary(
                f"{emoji} **{action.upper()}** at {now_jst.strftime('%Y-%m-%d %H:%M')} JST ({now_jst.strftime('%A')})\n"
                f"📍 {loc['name']} ({location_key})\n"
                + (f"> {note}\n" if note else "")
                + (f"\n✅ Verified: CI={ci_after}, CO={co_after or 'pending'}" if ci_after else "")
            )
        else:
            log(f"❌ {action.upper()} FAILED (HTTP {status}): {result}")
            result_status = "failure"
            result_detail = f"{action} failed (HTTP {status}): {result}"
            set_output("success", "false")
            set_summary(f"❌ **{action.upper()} FAILED** (HTTP {status}) at {now_jst.strftime('%H:%M')} JST")
            sys.exit(1)

        # ── Handle token rotation ──
        if new_refresh != refresh_token:
            log("⚠️ Refresh token rotated!")
            set_output("token_rotated", "true")
            set_output("new_refresh_token", new_refresh)
        else:
            set_output("token_rotated", "false")

    except Exception as e:
        result_status = "error"
        result_detail = str(e)
        log(f"❌ EXCEPTION: {e}")
        traceback.print_exc()
        raise
    finally:
        # ── Send notification (only on action, not routine skips) ──
        if result_status != "skip":
            emoji_map = {"success": "✅", "failure": "❌", "error": "🚨"}
            subject = f"{emoji_map.get(result_status, '❓')} DokoKin {result_status.upper()}: {now_jst.strftime('%Y-%m-%d %H:%M %A')}"
            body = "\n".join(LOG_LINES) + f"\n\n--- Result: {result_status} ---\n{result_detail}"
            send_email(subject, body)


if __name__ == "__main__":
    main()
