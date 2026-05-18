#!/usr/bin/env python3
"""GitHub Actions — DokoKin auto checkin/checkout.
Zero external dependencies (stdlib only).
Reads schedule.json, matches current JST time, executes checkin/checkout via API.
Optionally sends email notification via SMTP.
"""
import os, sys, json, urllib.request, urllib.parse, traceback, time
from datetime import datetime, timezone, timedelta, date
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
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


def http_get(url, headers=None):
    """Simple HTTP GET using urllib."""
    req = urllib.request.Request(url, headers=headers or {}, method="GET")
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


def retry(fn, retries=3, backoff=5):
    """Retry a function up to N times with exponential backoff."""
    last_err = None
    for attempt in range(retries):
        try:
            return fn()
        except Exception as e:
            last_err = e
            if attempt < retries - 1:
                wait = backoff * (2 ** attempt)
                log(f"  ⚠️ Attempt {attempt+1} failed: {e}. Retrying in {wait}s...")
                time.sleep(wait)
    raise last_err


# ── Japanese public holidays (auto-generated for current + next year) ──
# Source: 国民の祝日に関する法律
JAPANESE_HOLIDAYS_2026 = {
    date(2026, 1, 1), date(2026, 1, 12), date(2026, 2, 11), date(2026, 2, 23),
    date(2026, 3, 20), date(2026, 4, 29), date(2026, 5, 3), date(2026, 5, 4),
    date(2026, 5, 5), date(2026, 5, 6),  # 振替休日
    date(2026, 7, 20), date(2026, 8, 11), date(2026, 9, 21), date(2026, 9, 22),
    date(2026, 9, 23), date(2026, 10, 12), date(2026, 11, 3), date(2026, 11, 23),
    date(2026, 12, 23),
}
JAPANESE_HOLIDAYS_2027 = {
    date(2027, 1, 1), date(2027, 1, 11), date(2027, 2, 11), date(2027, 2, 23),
    date(2027, 3, 21), date(2027, 4, 29), date(2027, 5, 3), date(2027, 5, 4),
    date(2027, 5, 5), date(2027, 7, 19), date(2027, 8, 11), date(2027, 9, 20),
    date(2027, 9, 23), date(2027, 10, 11), date(2027, 11, 3), date(2027, 11, 23),
}
JAPANESE_HOLIDAYS = JAPANESE_HOLIDAYS_2026 | JAPANESE_HOLIDAYS_2027


def is_japanese_holiday(d):
    """Check if a date is a Japanese public holiday."""
    return d in JAPANESE_HOLIDAYS


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
    """GET dakoku status for a date. Returns (checkin_time, checkout_time) or None.

    The API uses field names startWorkingTime / endWorkingTime (with display variants).
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


# ═══════════════════════════════════════════════════════════
#  CHECKIN / CHECKOUT
# ═══════════════════════════════════════════════════════════

def do_dakoku(token, checkin_type, lat, lon, is_checkout=False,
              is_checkout_yesterday=False, break_minutes=0):
    """POST dakoku. checkin_type: 1=checkin, 2=checkout."""
    now = datetime.now(JST)
    body = {
        "employeeId": 8883,
        "appId": "com.fjp.portal",
        "logTime": now.strftime("%Y-%m-%dT%H:%M:%S"),
        "isCheckoutYesterday": is_checkout_yesterday,
        "TotalOfBreakTime": break_minutes,
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


def find_matching_action(schedule, now_jst, expected_type=None):
    """Find the closest *past* scheduled action within tolerance.

    Only matches actions whose scheduled time has already passed (with 5-min
    grace for early triggers).  This prevents a delayed cron from jumping
    forward to the next action (e.g. a CO cron accidentally triggering a CI).
    If expected_type is set (from TRIGGER_CRON), only matches that action type.
    Returns the single closest past match.
    """
    tolerance = schedule.get("tolerance_minutes", 180)
    best_entry = None
    best_diff = float("inf")

    for entry in schedule["actions"]:
        if expected_type and entry["action"] != expected_type:
            continue

        dt = datetime.strptime(entry["datetime"], "%Y-%m-%d %H:%M").replace(tzinfo=JST)
        diff_minutes = (now_jst - dt).total_seconds() / 60  # positive = past

        if diff_minutes < -5:  # skip future actions (allow 5min early)
            continue

        if diff_minutes <= tolerance and diff_minutes < best_diff:
            best_diff = diff_minutes
            best_entry = entry

    return best_entry


# Cron expression → expected action type
# Includes both primary and backup (+30min) crons.
CRON_TYPE_MAP = {
    "0 0 * * 1-5":   "checkin",   # 09:00 JST Mon-Fri workday CI
    "30 0 * * 1-5":  "checkin",   # 09:30 JST backup
    "0 9 * * 1-5":   "checkout",  # 18:00 JST Mon-Fri workday CO
    "30 9 * * 1-5":  "checkout",  # 18:30 JST backup
    "0 13 * * *":    "checkin",   # 22:00 JST night OT CI
    "30 13 * * *":   "checkin",   # 22:30 JST backup
    "0 15 * * *":    "checkout",  # 00:00 JST midnight CO
    "30 15 * * *":   "checkout",  # 00:30 JST backup
    "30 18 * * *":   "checkout",  # 03:30 JST night OT CO + Sunday OT CO
    "0 19 * * *":    "checkout",  # 04:00 JST backup
    "30 5 * * 0":    "checkin",   # 14:30 JST Sunday OT CI
    "0 6 * * 0":     "checkin",   # 15:00 JST Sunday backup
}

# Cron → intended JST (hour, minute) for delay-resilient matching.
# GitHub Actions cron can be delayed by hours; this map lets us compute
# the *intended* fire time and match schedule entries against that
# instead of the (late) current time.
# Backup crons map to the SAME intended time as their primary.
CRON_JST_TIME = {
    "0 0 * * 1-5":   (9, 0),     # 00:00 UTC → 09:00 JST
    "30 0 * * 1-5":  (9, 0),     # backup → same 09:00 JST
    "0 9 * * 1-5":   (18, 0),    # 09:00 UTC → 18:00 JST
    "30 9 * * 1-5":  (18, 0),    # backup → same 18:00 JST
    "0 13 * * *":    (22, 0),    # 13:00 UTC → 22:00 JST
    "30 13 * * *":   (22, 0),    # backup → same 22:00 JST
    "0 15 * * *":    (0, 0),     # 15:00 UTC → 00:00 JST (+1 day)
    "30 15 * * *":   (0, 0),     # backup → same 00:00 JST
    "30 18 * * *":   (3, 30),    # 18:30 UTC → 03:30 JST (+1 day)
    "0 19 * * *":    (3, 30),    # backup → same 03:30 JST
    "30 5 * * 0":    (14, 30),   # 05:30 UTC → 14:30 JST
    "0 6 * * 0":     (14, 30),   # backup → same 14:30 JST
}


def find_action_by_cron(schedule, trigger_cron, now_jst):
    """Delay-resilient matching: use cron identity to find intended action.

    GitHub Actions scheduled cron can be delayed by hours. Instead of
    matching by current time (which fails when delayed past tolerance),
    compute the intended fire time from the cron expression and find
    the schedule entry closest to that intended time.
    """
    expected_type = CRON_TYPE_MAP.get(trigger_cron)
    jst_time = CRON_JST_TIME.get(trigger_cron)
    if not expected_type or not jst_time:
        return None

    intended_hour, intended_min = jst_time

    # Build the intended JST datetime (start from today)
    intended = now_jst.replace(hour=intended_hour, minute=intended_min,
                               second=0, microsecond=0)

    # If intended is >12h in the future, the cron was for yesterday
    if (intended - now_jst).total_seconds() > 12 * 3600:
        intended -= timedelta(days=1)

    # Find schedule entry matching intended time + action type
    best_entry = None
    best_diff = float("inf")
    max_diff_min = 360  # 6h window (dated entries prevent false matches)

    for entry in schedule["actions"]:
        if entry["action"] != expected_type:
            continue
        dt = datetime.strptime(entry["datetime"], "%Y-%m-%d %H:%M").replace(tzinfo=JST)
        diff = abs((intended - dt).total_seconds() / 60)
        if diff <= max_diff_min and diff < best_diff:
            best_diff = diff
            best_entry = entry

    return best_entry


# ═══════════════════════════════════════════════════════════
#  NOTIFICATION
# ═══════════════════════════════════════════════════════════

def build_checkin_html(status, action, location_name, location_key, note, now_jst, ci_after=None, co_after=None, error_detail=None):
    """Build beautiful HTML email for checkin/checkout notification."""
    colors = {"success": "#22c55e", "failure": "#ef4444", "error": "#f97316"}
    bg_colors = {"success": "#f0fdf4", "failure": "#fef2f2", "error": "#fff7ed"}
    icons = {"success": "✅", "failure": "❌", "error": "🚨"}
    labels = {"success": "SUCCESS", "failure": "FAILED", "error": "ERROR"}
    action_icons = {"checkin": "📥", "checkout": "📤"}

    color = colors.get(status, "#6b7280")
    bg = bg_colors.get(status, "#f9fafb")
    icon = icons.get(status, "❓")
    label = labels.get(status, "UNKNOWN")
    a_icon = action_icons.get(action, "🔄")

    date_str = now_jst.strftime("%Y-%m-%d")
    time_str = now_jst.strftime("%H:%M")
    day_str = now_jst.strftime("%A")

    verified_html = ""
    if ci_after:
        verified_html = f"""
        <tr><td style="padding:8px 12px;color:#6b7280;font-size:13px;">Verified</td>
            <td style="padding:8px 12px;font-size:13px;">CI: {ci_after} / CO: {co_after or '—'}</td></tr>"""

    error_html = ""
    if error_detail:
        error_html = f"""
        <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px;margin-top:16px;">
          <strong style="color:#dc2626;">Error Detail:</strong>
          <pre style="margin:8px 0 0;font-size:12px;color:#7f1d1d;white-space:pre-wrap;">{error_detail}</pre>
        </div>"""

    log_html = "\n".join(f"<div style='padding:2px 0;'>{line}</div>" for line in LOG_LINES)

    return f"""<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<div style="max-width:520px;margin:20px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
  <!-- Header -->
  <div style="background:{color};padding:20px 24px;text-align:center;">
    <div style="font-size:36px;">{a_icon}</div>
    <div style="color:#fff;font-size:20px;font-weight:700;margin-top:4px;">{action.upper()} {label}</div>
    <div style="color:rgba(255,255,255,0.85);font-size:13px;margin-top:4px;">{icon} DokoKin Auto System</div>
  </div>

  <!-- Body -->
  <div style="padding:20px 24px;">
    <table style="width:100%;border-collapse:collapse;">
      <tr><td style="padding:8px 12px;color:#6b7280;font-size:13px;width:90px;">Date</td>
          <td style="padding:8px 12px;font-weight:600;">{date_str} ({day_str})</td></tr>
      <tr style="background:#f9fafb;"><td style="padding:8px 12px;color:#6b7280;font-size:13px;">Time</td>
          <td style="padding:8px 12px;font-weight:600;font-size:18px;">{time_str} JST</td></tr>
      <tr><td style="padding:8px 12px;color:#6b7280;font-size:13px;">Location</td>
          <td style="padding:8px 12px;">📍 {location_name}</td></tr>
      {"<tr style='background:#f9fafb;'><td style='padding:8px 12px;color:#6b7280;font-size:13px;'>Note</td><td style='padding:8px 12px;'>" + note + "</td></tr>" if note else ""}
      {verified_html}
    </table>
    {error_html}

    <!-- Log -->
    <details style="margin-top:20px;">
      <summary style="cursor:pointer;color:#6b7280;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">
        Execution Log ({len(LOG_LINES)} lines)
      </summary>
      <div style="background:#1e293b;color:#e2e8f0;padding:12px;border-radius:8px;margin-top:8px;font-family:'Cascadia Code',Consolas,monospace;font-size:11px;line-height:1.6;max-height:400px;overflow-y:auto;">
        {log_html}
      </div>
    </details>
  </div>

  <!-- Footer -->
  <div style="padding:12px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;text-align:center;">
    <span style="color:#9ca3af;font-size:11px;">🤖 Auto Checkin System • GitHub Actions • {date_str}</span>
  </div>
</div></body></html>"""


def send_email(subject, body, html=None):
    """Send email notification via SMTP. Supports HTML."""
    smtp_server = os.environ.get("SMTP_SERVER", "smtp.gmail.com")
    smtp_port = int(os.environ.get("SMTP_PORT", "587"))
    smtp_user = os.environ.get("SMTP_USER")
    smtp_pass = os.environ.get("SMTP_PASS")
    notify_email = os.environ.get("NOTIFY_EMAIL")

    if not all([smtp_user, smtp_pass, notify_email]):
        log("Email not configured (SMTP_USER/SMTP_PASS/NOTIFY_EMAIL missing), skip notification")
        return

    try:
        if html:
            msg = MIMEMultipart("alternative")
            msg.attach(MIMEText(body, "plain", "utf-8"))
            msg.attach(MIMEText(html, "html", "utf-8"))
        else:
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
    action = ""
    location_name = ""
    location_key = ""
    note = ""
    ci_after = None
    co_after = None

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
                "datetime": now_jst.strftime("%Y-%m-%d %H:%M"),
            }
            log(f"FORCE mode: {force_action} at {force_location}")
        else:
            # Use TRIGGER_CRON to filter by expected action type
            trigger_cron = os.environ.get("TRIGGER_CRON", "")
            expected_type = CRON_TYPE_MAP.get(trigger_cron)
            if trigger_cron:
                log(f"Trigger cron: '{trigger_cron}' → expected type: {expected_type or 'any'}")
                # Delay-resilient: match by cron's intended time, not current time
                action_entry = find_action_by_cron(schedule, trigger_cron, now_jst)
                if action_entry:
                    log(f"Cron-matched (delay-resilient): {action_entry['datetime']} {action_entry['action']}")
                else:
                    log("No cron-match, falling back to time-based matching")
                    action_entry = find_matching_action(schedule, now_jst, expected_type)
            else:
                action_entry = find_matching_action(schedule, now_jst)

        if not action_entry:
            log("No scheduled action for current time. Skipping.")
            set_output("skipped", "true")
            set_summary(f"⏭️ **Skipped** — no action at {now_jst.strftime('%Y-%m-%d %H:%M')} JST ({now_jst.strftime('%A')})")
            return  # No email for routine skips

        # ── Holiday check: skip workday actions on Japanese holidays ──
        # OT entries (with "OT"/"Sun" in note or on weekends) are NOT skipped
        entry_date = datetime.strptime(action_entry["datetime"], "%Y-%m-%d %H:%M").replace(tzinfo=JST).date()
        entry_note = action_entry.get("note", "").lower()
        is_ot_entry = any(k in entry_note for k in ("ot", "sun", "night")) or entry_date.isoweekday() >= 6
        if not is_ot_entry and is_japanese_holiday(entry_date):
            log(f"🎌 {entry_date} is a Japanese holiday. Skipping workday action.")
            set_output("skipped", "true")
            set_summary(f"🎌 **Skipped** — {entry_date} is a Japanese holiday")
            return

        action = action_entry["action"]
        location_key = action_entry["location"]
        # ── Resolve coords: env override (PWA custom location) > schedule.json lookup ──
        force_lat = os.environ.get("FORCE_LATITUDE", "").strip()
        force_lon = os.environ.get("FORCE_LONGITUDE", "").strip()
        if force_lat and force_lon:
            try:
                loc = {"lat": float(force_lat), "lon": float(force_lon), "name": location_key}
                log(f"Using lat/lon override from inputs: ({loc['lat']}, {loc['lon']})")
            except ValueError:
                log(f"⚠️ Invalid FORCE_LATITUDE/FORCE_LONGITUDE: '{force_lat}', '{force_lon}' — falling back to schedule.json")
                loc = schedule["locations"][location_key]
        else:
            loc = schedule["locations"][location_key]
        location_name = loc["name"]
        note = action_entry.get("note", "")

        log(f"Action: {action} at {location_key} ({loc['name']})")
        if note:
            log(f"Note: {note}")

        # ── Get tokens (with retry) ──
        refresh_token = os.environ.get("AZURE_REFRESH_TOKEN")
        if not refresh_token:
            log("ERROR: AZURE_REFRESH_TOKEN secret not set!")
            result_status = "error"
            result_detail = "AZURE_REFRESH_TOKEN not set"
            sys.exit(1)

        log("Refreshing Azure AD token...")
        azure_token, new_refresh = retry(lambda: refresh_azure_token(refresh_token))
        log("Azure token OK ✓")

        log("Exchanging for DokoKin token...")
        dokokin_token = retry(lambda: get_dokokin_token(azure_token))
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

        # ── Determine checkout context (overnight, break time) ──
        checkin_type = 1  # GPS-based checkin type
        is_checkout = action == "checkout"

        # Bug #1 fix: detect overnight checkout using schedule time + API state
        is_checkout_yesterday = False
        break_minutes = 0
        if is_checkout:
            # Use schedule entry time if available; for force_action use current time
            if action_entry.get("datetime"):
                entry_dt = datetime.strptime(action_entry["datetime"], "%Y-%m-%d %H:%M").replace(tzinfo=JST)
                is_overnight_time = 0 <= entry_dt.hour < 6
            else:
                is_overnight_time = 0 <= now_jst.hour < 6
            is_checkout_yesterday = bool(is_overnight_time and ci_yest and not co_yest)
            if is_checkout_yesterday:
                log("  🌙 Overnight checkout → isCheckoutYesterday=True")

            # Bug #4 fix: calculate break time from shift duration
            ci_ref = ci_yest if is_checkout_yesterday else ci_today
            if ci_ref:
                try:
                    ci_dt = datetime.fromisoformat(str(ci_ref).replace("Z", "+00:00"))
                    if ci_dt.tzinfo is None:
                        ci_dt = ci_dt.replace(tzinfo=JST)
                    shift_h = (now_jst - ci_dt).total_seconds() / 3600
                    if shift_h > 8:
                        break_minutes = 60
                    elif shift_h > 6:
                        break_minutes = 45
                    log(f"  Shift ~{shift_h:.1f}h → break {break_minutes}min")
                except (ValueError, TypeError):
                    log(f"  ⚠️ Could not parse CI time for break calc: {ci_ref}")

        # ── Idempotent skip: don't re-execute if action already recorded ──
        if action == "checkin" and ci_today:
            log(f"⏭️ Already checked in today at {ci_today}. Skipping (idempotent).")
            set_output("skipped", "true")
            set_summary(f"⏭️ Already checked in at {ci_today}. Skipping.")
            return  # No email for idempotent skips
        if is_checkout:
            co_ref = co_yest if is_checkout_yesterday else co_today
            if co_ref:
                ref_day = "yesterday" if is_checkout_yesterday else "today"
                # Checkout is allowed to be updated (e.g. user worked OT after initial checkout).
                # Skip ONLY if the recorded checkout is in the future relative to now (clock skew).
                try:
                    co_dt = datetime.fromisoformat(str(co_ref).replace("Z", "+00:00"))
                    if co_dt.tzinfo is None:
                        co_dt = co_dt.replace(tzinfo=JST)
                    if co_dt >= now_jst:
                        log(f"⏭️ Already checked out {ref_day} at {co_ref} (>= now). Skipping (idempotent).")
                        set_output("skipped", "true")
                        set_summary(f"⏭️ Already checked out at {co_ref}. Skipping.")
                        return
                    log(f"🔁 Re-checkout {ref_day}: previous CO at {co_ref}, current time {now_jst.strftime('%H:%M:%S')} — updating.")
                except (ValueError, TypeError):
                    log(f"  ⚠️ Could not parse previous CO time ({co_ref}); proceeding with checkout anyway.")

        # ── Execute (with retry on server errors) ──
        emoji = "📥" if action == "checkin" else "📤"

        def _do_dakoku():
            s, r = do_dakoku(dokokin_token, checkin_type, loc["lat"], loc["lon"],
                             is_checkout, is_checkout_yesterday, break_minutes)
            if s >= 500:
                raise RuntimeError(f"Server error {s}: {r}")
            return s, r

        status, result = retry(_do_dakoku, retries=3, backoff=10)

        if status == 200:
            log(f"{emoji} {action.upper()} SUCCESS at {loc['name']}")
            log(f"  API response: {result}")
            result_status = "success"
            result_detail = f"{action} at {loc['name']} ({location_key})"

            # Post-action verification (check correct date for overnight CO)
            verify_date = yesterday_str if is_checkout_yesterday else today_str
            log(f"Verifying status after action (date={verify_date})...")
            ci_after, co_after = get_dakoku_status(dokokin_token, verify_date)
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
            # Mask token in GitHub Actions logs
            print(f"::add-mask::{new_refresh}")
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
            subject = f"{emoji_map.get(result_status, '❓')} DokoKin {action.upper() or result_status.upper()}: {now_jst.strftime('%Y-%m-%d %H:%M %A')}"
            plain_body = "\n".join(LOG_LINES) + f"\n\n--- Result: {result_status} ---\n{result_detail}"
            html_body = build_checkin_html(
                status=result_status,
                action=action or "unknown",
                location_name=location_name or "—",
                location_key=location_key or "—",
                note=note,
                now_jst=now_jst,
                ci_after=ci_after,
                co_after=co_after,
                error_detail=result_detail if result_status != "success" else None,
            )
            send_email(subject, plain_body, html=html_body)


if __name__ == "__main__":
    main()
