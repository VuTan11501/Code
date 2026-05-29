#!/usr/bin/env python3
"""GitHub Actions — DokoKin auto checkin/checkout.
Zero external dependencies (stdlib only).
Reads schedule.json, matches current JST time, executes checkin/checkout via API.
Optionally sends email notification via SMTP.
"""
import os, sys, json, urllib.request, urllib.parse, traceback, time, uuid
from datetime import datetime, timezone, timedelta, date
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
import smtplib

# Make sibling modules in same dir importable when run via `python path/to/script.py`
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from user_config import (  # noqa: E402
    EMPLOYEE_ID, GIST_ID, API_BASE, AZURE_APP_ID, AZURE_TENANT,
)
from ot_gist import load_ot_from_gist  # noqa: E402
from gist_safety import (  # noqa: E402
    read_gist_file, safe_patch_gist_file, validate_scheduled_runs_shape,
)
from gist_cas import cas_update  # noqa: E402

JST = timezone(timedelta(hours=9))

# ── Azure AD scope (derived from config) ──
AZURE_SCOPE = f"api://{AZURE_APP_ID}/openid user.read offline_access"

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
              is_checkout_yesterday=False, break_hours=0.0):
    """POST dakoku. checkin_type: 1=checkin, 2=checkout.

    `break_hours` is decimal HOURS (e.g. 1.0 = 60min, 0.75 = 45min, 0 = none) —
    matches the Flutter DokoKin app's `convertToDouble(hour, minute)` helper
    which sends `hour + minute/60` as a double. Sending a raw minute count
    (e.g. 60) causes the server to interpret it as 60 HOURS and display "60:00".
    """
    now = datetime.now(JST)
    body = {
        "employeeId": EMPLOYEE_ID,
        "appId": "com.fjp.portal",
        "logTime": now.strftime("%Y-%m-%dT%H:%M:%S"),
        "isCheckoutYesterday": is_checkout_yesterday,
        "TotalOfBreakTime": float(break_hours),
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
    """Build shadcn/ui dark-themed HTML email for checkin/checkout notification."""
    # shadcn dark tokens
    BG = "#0a0a0a"
    CARD = "#0f0f0f"
    BORDER = "#262626"
    FG = "#fafafa"
    MUTED = "#a3a3a3"
    MUTED_BG = "#171717"
    # status accents (subtle bg + bright fg, matching .badge-warning style)
    accents = {
        "success": {"bg": "rgba(34,197,94,0.12)", "fg": "#4ade80", "border": "rgba(34,197,94,0.25)"},
        "failure": {"bg": "rgba(239,68,68,0.12)", "fg": "#f87171", "border": "rgba(239,68,68,0.25)"},
        "error":   {"bg": "rgba(249,115,22,0.12)", "fg": "#fb923c", "border": "rgba(249,115,22,0.25)"},
    }
    a = accents.get(status, {"bg": MUTED_BG, "fg": MUTED, "border": BORDER})
    labels = {"success": "Success", "failure": "Failed", "error": "Error"}
    icons = {"success": "✓", "failure": "✕", "error": "!"}
    action_icons = {"checkin": "↓", "checkout": "↑"}
    label = labels.get(status, "Unknown")
    icon = icons.get(status, "?")
    a_icon = action_icons.get(action, "•")

    date_str = now_jst.strftime("%Y-%m-%d")
    time_str = now_jst.strftime("%H:%M")
    day_str = now_jst.strftime("%A")

    def row(k, v, mono=False):
        v_style = f"color:{FG};font-size:13px;{'font-family:ui-monospace,SFMono-Regular,Consolas,monospace;' if mono else ''}"
        return f'<tr><td style="padding:10px 0;color:{MUTED};font-size:12px;width:96px;border-bottom:1px solid {BORDER};">{k}</td><td style="padding:10px 0;{v_style};border-bottom:1px solid {BORDER};">{v}</td></tr>'

    rows = ""
    rows += row("Date", f"{date_str} <span style='color:{MUTED}'>· {day_str}</span>", mono=True)
    rows += row("Time", f'<span style="font-size:16px;font-weight:600;letter-spacing:-0.01em">{time_str}</span> <span style="color:{MUTED};font-size:11px">JST</span>', mono=True)
    rows += row("Location", location_name)
    if note:
        rows += row("Note", note)
    if ci_after:
        rows += row("Verified", f"CI {ci_after} / CO {co_after or '—'}", mono=True)

    error_html = ""
    if error_detail:
        error_html = f'''<div style="background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.25);border-radius:8px;padding:14px;margin-top:20px;">
          <div style="color:#f87171;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:8px;">Error</div>
          <pre style="margin:0;font:11px ui-monospace,SFMono-Regular,Consolas,monospace;color:#fca5a5;white-space:pre-wrap;word-break:break-word;">{error_detail}</pre>
        </div>'''

    log_html = "<br>".join(LOG_LINES)

    return f'''<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"></head>
<body style="margin:0;padding:0;background:{BG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:{FG};-webkit-font-smoothing:antialiased;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="{BG}" style="background:{BG};">
<tr><td align="center" style="padding:24px 12px;">

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:{CARD};border:1px solid {BORDER};border-radius:12px;overflow:hidden;">

  <!-- Header: status pill -->
  <tr><td style="padding:24px 24px 0;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="background:{a['bg']};border:1px solid {a['border']};border-radius:9999px;padding:4px 12px;color:{a['fg']};font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;">
        <span style="font-family:ui-monospace,SFMono-Regular,Consolas,monospace;">{icon}</span> &nbsp;{action.capitalize()} · {label}
      </td>
    </tr></table>
    <h1 style="margin:14px 0 4px;font-size:22px;font-weight:700;letter-spacing:-0.01em;color:{FG};">
      <span style="display:inline-block;width:28px;height:28px;line-height:28px;text-align:center;background:{MUTED_BG};border:1px solid {BORDER};border-radius:8px;font-size:14px;margin-right:6px;vertical-align:middle;">{a_icon}</span>
      {action.capitalize()} {label.lower()}
    </h1>
    <p style="margin:0 0 4px;color:{MUTED};font-size:13px;">DokoKin attendance automation</p>
  </td></tr>

  <!-- Divider -->
  <tr><td style="padding:20px 24px 0;"><div style="height:1px;background:{BORDER};"></div></td></tr>

  <!-- Body: rows -->
  <tr><td style="padding:4px 24px 20px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">{rows}</table>
    {error_html}
  </td></tr>

  <!-- Log (collapsed) -->
  <tr><td style="padding:0 24px 20px;">
    <details style="background:{MUTED_BG};border:1px solid {BORDER};border-radius:8px;">
      <summary style="cursor:pointer;padding:10px 14px;color:{MUTED};font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;">Execution log ({len(LOG_LINES)} lines)</summary>
      <div style="padding:0 14px 14px;font:11px/1.7 ui-monospace,SFMono-Regular,Consolas,monospace;color:#d4d4d4;max-height:360px;overflow:auto;white-space:pre-wrap;word-break:break-word;">{log_html}</div>
    </details>
  </td></tr>

  <!-- Footer -->
  <tr><td style="padding:14px 24px;border-top:1px solid {BORDER};background:#080808;">
    <div style="color:#737373;font-size:11px;letter-spacing:0.02em;">DokoKin Auto · GitHub Actions · {date_str}</div>
  </td></tr>
</table>

</td></tr></table></body></html>'''


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
#  OT-AWARE CHECKOUT SCHEDULING
# ═══════════════════════════════════════════════════════════

SCHEDULED_RUNS_FILE = "scheduled-runs.json"


def _compute_ot_co_time(ot_entry):
    """Compute the required checkout datetime (JST) that covers an OT entry's end.

    For cross-midnight OT (end time < start time or end <= 06:00), the CO is on the
    next calendar day. Returns a tz-aware datetime in JST.
    """
    ot_date = datetime.strptime(ot_entry["date"], "%Y-%m-%d").date()
    end_parts = ot_entry["end"].split(":")
    end_h, end_m = int(end_parts[0]), int(end_parts[1])
    start_parts = ot_entry["start"].split(":")
    start_h, start_m = int(start_parts[0]), int(start_parts[1])

    end_total_min = end_h * 60 + end_m
    start_total_min = start_h * 60 + start_m

    # Cross-midnight: end is earlier in day than start, or end is <= 06:00 with late start
    is_cross_midnight = (end_total_min < start_total_min) or (end_h <= 6 and start_h >= 18)
    if is_cross_midnight:
        co_date = ot_date + timedelta(days=1)
    else:
        co_date = ot_date

    return datetime(co_date.year, co_date.month, co_date.day,
                    end_h, end_m, tzinfo=JST)


def _find_existing_co_entry(entries, ot_co_dt, tolerance_min=30):
    """Check if a scheduled CO entry already covers the OT end time.

    Looks for any auto-checkout entry (once or recurring) that fires at or within
    `tolerance_min` minutes AFTER ot_co_dt. Returns True if covered.
    """
    co_date_str = ot_co_dt.strftime("%Y-%m-%d")
    co_dow_js = ot_co_dt.isoweekday() % 7  # JS convention: Sun=0..Sat=6

    for entry in entries:
        if entry.get("dispatched"):
            continue
        if entry.get("enabled") is False:
            continue
        wf = entry.get("workflow", "")
        if "checkout" not in wf:
            continue

        if entry.get("type") == "once" and entry.get("run_at"):
            try:
                run_at = datetime.fromisoformat(entry["run_at"])
                if run_at.tzinfo is None:
                    run_at = run_at.replace(tzinfo=JST)
                # CO must be at or after OT end (0 <= diff, no negative tolerance)
                diff = (run_at - ot_co_dt).total_seconds() / 60
                if 0 <= diff <= tolerance_min:
                    return True
            except (ValueError, TypeError):
                continue
        elif entry.get("type") == "recurring":
            rec = entry.get("recurrence", {})
            entry_time = rec.get("time") or entry.get("time", "")
            if not entry_time:
                continue
            t_parts = entry_time.split(":")
            if len(t_parts) < 2:
                continue
            e_h, e_m = int(t_parts[0]), int(t_parts[1])

            # Validate recurrence pattern runs on ot_co_dt's date
            pattern = rec.get("pattern", "daily")
            if pattern == "weekdays" and co_dow_js in (0, 6):
                continue  # weekdays-only won't run on Sat/Sun
            elif pattern == "weekly":
                days = rec.get("days", [])
                if co_dow_js not in days:
                    continue
            elif pattern == "monthly":
                dates = rec.get("dates", [])
                if ot_co_dt.day not in dates:
                    continue

            # Check date range
            start_date = rec.get("start_date")
            end_date = rec.get("end_date")
            if start_date and co_date_str < start_date:
                continue
            if end_date and co_date_str > end_date:
                continue

            # Check skip_dates
            skip_dates = set(rec.get("skip_dates", []))
            if co_date_str in skip_dates:
                continue

            # Build datetime for comparison on the same day as ot_co_dt
            entry_dt = ot_co_dt.replace(hour=e_h, minute=e_m, second=0)
            diff = (entry_dt - ot_co_dt).total_seconds() / 60
            if 0 <= diff <= tolerance_min:
                return True

    return False


def _add_skip_date_to_recurring_co(date_str, entry_dt=None):
    """Add date_str to skip_dates of the recurring CO entry in Gist (CAS).

    Best-effort: failure only logs a warning, never raises.
    Matches by workflow='auto-checkout.yml' + time match (if entry_dt provided).
    """
    pat = os.environ.get("GH_PAT")
    if not pat:
        log("  ⚠️ GH_PAT not set — cannot add skip_date to recurring CO")
        return

    # Determine target time (HH:MM) for matching
    target_time = None
    if entry_dt is not None:
        target_time = entry_dt.strftime("%H:%M")

    def mutator(parsed):
        entries = parsed if isinstance(parsed, list) else []
        found = False
        for entry in entries:
            if entry.get("type") != "recurring":
                continue
            if entry.get("workflow") != "auto-checkout.yml":
                continue
            rec = entry.get("recurrence", {})
            entry_time = rec.get("time") or entry.get("time", "")
            # Match by time if available
            if target_time and entry_time != target_time:
                continue
            # Found the recurring CO entry
            skip_dates = rec.get("skip_dates", [])
            if date_str in skip_dates:
                # Already present — no-op (cas_update detects no change)
                return entries
            skip_dates.append(date_str)
            rec["skip_dates"] = sorted(set(skip_dates))
            entry["recurrence"] = rec
            found = True
            break  # Only update first matching entry

        if not found:
            # No matching recurring CO entry — return unchanged (no-op)
            pass
        return entries

    try:
        result = cas_update(GIST_ID, SCHEDULED_RUNS_FILE, mutator, pat, max_retries=3)
        if result.get("no_change"):
            log(f"  ℹ️ skip_dates: {date_str} already present (no-op)")
        elif result.get("ok"):
            log(f"  ✅ Added {date_str} to recurring CO skip_dates (attempts: {result['attempts']})")
        else:
            log(f"  ⚠️ Failed to add skip_date: {result.get('error', 'unknown')} — checkin continues")
    except Exception as e:
        log(f"  ⚠️ skip_date CAS error: {e} — checkin continues")


def ensure_ot_checkout_scheduled(ot_entries_today, now_jst, location_key="home"):
    """Ensure a checkout entry exists in Gist scheduled-runs.json covering OT end.

    Called after successful checkin or when early-CO is skipped.
    Creates a once-type entry in the Gist if no existing CO covers the OT end time.

    Returns list of created entry descriptions (for logging).
    """
    pat = os.environ.get("GH_PAT")
    if not pat:
        log("  ⚠️ GH_PAT not set — cannot create OT checkout schedule")
        return []

    created = []
    for ot_entry in ot_entries_today:
        ot_co_dt = _compute_ot_co_time(ot_entry)

        # Only schedule future COs
        if ot_co_dt <= now_jst:
            log(f"  ⏭️ OT CO time {ot_co_dt.strftime('%m-%d %H:%M')} already passed, skip")
            continue

        # Read current Gist schedule
        try:
            snapshot = read_gist_file(pat, GIST_ID, SCHEDULED_RUNS_FILE, log=log)
        except Exception as e:
            log(f"  ⚠️ Failed to read Gist scheduled-runs: {e}")
            return created

        entries = snapshot["parsed"] if isinstance(snapshot.get("parsed"), list) else []

        # Check if CO already covered
        if _find_existing_co_entry(entries, ot_co_dt):
            log(f"  ✅ OT CO at {ot_co_dt.strftime('%m-%d %H:%M')} already scheduled")
            continue

        # Create new once-type CO entry
        new_entry = {
            "id": str(uuid.uuid4())[:8],
            "type": "once",
            "workflow": "auto-checkout.yml",
            "run_at": ot_co_dt.isoformat(),
            "location": location_key,
            "note": f"OT CO (auto-created by CI flow, OT {ot_entry['start']}→{ot_entry['end']})",
            "created": now_jst.isoformat(timespec="seconds"),
            "dispatched": False,
        }
        entries.append(new_entry)

        # Write back to Gist with safety
        new_content = json.dumps(entries, indent=2, ensure_ascii=False)
        try:
            safe_patch_gist_file(
                pat, GIST_ID, SCHEDULED_RUNS_FILE,
                new_content, snapshot,
                shape_validator=validate_scheduled_runs_shape,
                log=log,
            )
            desc = f"CO @ {ot_co_dt.strftime('%Y-%m-%d %H:%M')} JST"
            log(f"  📅 Created OT checkout schedule: {desc}")
            created.append(desc)
        except Exception as e:
            log(f"  ⚠️ Failed to write OT CO schedule: {e}")

    return created


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

        # ── Always send DirectCustomer/DirectHome (type=2) so timesheet
        # "Working Place" column always shows "Customer Office" (WorkingType=0).
        # Backend rule (TimesheetImporter.GetWorkingType): CI=2/4 paired with
        # CO=2/4 → WorkingType=0. Real GPS coords are fine here.
        checkin_type = 2
        send_lat, send_lon = loc["lat"], loc["lon"]
        log(f"  📍 Working mode: Customer Office (type=2) [location='{location_key}']")
        is_checkout = action == "checkout"

        # Bug #1 fix: detect overnight checkout using schedule time + API state
        is_checkout_yesterday = False
        break_hours = 0.0
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

            # Match Flutter DokoKin app: TotalOfBreakTime is HOURS as a double
            # (e.g. 1.0 = 60min, 0.75 = 45min, 0 = no break). Earlier patch sent
            # raw minutes (60) — server interpreted as 60 HOURS and displayed
            # "60:00". Labor Standards Act Art. 34: shift >8h → 1h break,
            # 6h < shift ≤ 8h → 45min break, ≤6h → no break.
            ci_ref = ci_yest if is_checkout_yesterday else ci_today
            if ci_ref:
                try:
                    ci_dt = datetime.fromisoformat(str(ci_ref).replace("Z", "+00:00"))
                    if ci_dt.tzinfo is None:
                        ci_dt = ci_dt.replace(tzinfo=JST)
                    shift_h = (now_jst - ci_dt).total_seconds() / 3600
                    if shift_h > 8:
                        break_hours = 1.0
                    elif shift_h > 6:
                        break_hours = 0.75
                    log(f"  Shift ~{shift_h:.1f}h → break {break_hours}h ({int(break_hours*60)}min)")
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

        # ── Smart skip: early-CO on a day that has scheduled night OT ──
        # Kintai Rule 2: don't close the shift at 18:00 if OT runs until 03:30
        # next-day — that would clip OT hours. The 03:30 CO entry will close it.
        if is_checkout and not is_checkout_yesterday:
            # Phase 1 migration: Gist is source-of-truth; schedule.json is fallback.
            pending_ot = load_ot_from_gist(log=log)
            if pending_ot is None:
                pending_ot = schedule.get("pending_ot", []) or []
                log(f"📂 OT source: schedule.json ({len(pending_ot)} entries)")
            else:
                log(f"☁️ OT source: Gist ({len(pending_ot)} entries)")
            has_ot_today = any(ot.get("date") == today_str for ot in pending_ot)
            entry_dt_for_check = None
            try:
                entry_dt_for_check = datetime.strptime(
                    action_entry["datetime"], "%Y-%m-%d %H:%M"
                ).replace(tzinfo=JST)
            except (ValueError, KeyError):
                pass
            # Compare CO time against actual OT end (not static hour < 20)
            note_marks_ot = any(k in (note or "").lower() for k in ("ot", "night"))
            if has_ot_today and not note_marks_ot:
                ot_entry = next(ot for ot in pending_ot if ot["date"] == today_str)
                ot_co_dt = _compute_ot_co_time(ot_entry)
                is_early_co = entry_dt_for_check is None or entry_dt_for_check < ot_co_dt
                if is_early_co:
                    log(
                        f"⏭️ Skip early CO — {today_str} has scheduled OT "
                        f"{ot_entry.get('start','?')}→{ot_entry.get('end','?')}. "
                        f"OT CO at end-time will close the shift."
                    )
                    # ── Add today to skip_dates of the recurring CO entry (CAS) ──
                    # Prevents dispatcher from re-firing this CO on the same date.
                    _add_skip_date_to_recurring_co(today_str, entry_dt_for_check)

                    # Ensure the later OT checkout is actually scheduled in Gist
                    ot_today_list = [ot for ot in pending_ot if ot["date"] == today_str]
                    created = ensure_ot_checkout_scheduled(ot_today_list, now_jst, location_key)
                    if created:
                        log(f"  📅 Auto-created OT CO entries: {', '.join(created)}")
                    set_output("skipped", "true")
                    set_summary(
                        f"⏭️ **Skipped early CO** — OT scheduled today "
                        f"({ot_entry.get('start','?')}→{ot_entry.get('end','?')}). "
                        f"Will CO at OT end time instead."
                        + (f"\n📅 Auto-scheduled: {', '.join(created)}" if created else "")
                    )
                    return  # No email for routine domain-rule skips

        # ── Execute (with retry on server errors) ──
        emoji = "📥" if action == "checkin" else "📤"

        def _do_dakoku():
            s, r = do_dakoku(dokokin_token, checkin_type, send_lat, send_lon,
                             is_checkout, is_checkout_yesterday, break_hours)
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

            # ── OT-aware CO scheduling ──
            # After successful CI: check if today has OT, ensure CO covers OT end.
            # After successful CO: check if CO time < OT end → schedule later CO.
            if action == "checkin":
                ot_data = load_ot_from_gist(log=log)
                if ot_data is None:
                    ot_data = schedule.get("pending_ot", []) or []
                ot_today = [ot for ot in ot_data if ot.get("date") == today_str]
                if ot_today:
                    log(f"🔍 OT-aware check: {len(ot_today)} OT request(s) today")
                    created = ensure_ot_checkout_scheduled(ot_today, now_jst, location_key)
                    if created:
                        result_detail += f" | Auto-scheduled CO: {', '.join(created)}"
            elif action == "checkout" and not is_checkout_yesterday:
                # CO just executed. Check if we still need a later CO for OT.
                ot_data = load_ot_from_gist(log=log)
                if ot_data is None:
                    ot_data = schedule.get("pending_ot", []) or []
                ot_today = [ot for ot in ot_data if ot.get("date") == today_str]
                if ot_today:
                    # Check if our CO time is before OT end
                    for ot in ot_today:
                        ot_co_dt = _compute_ot_co_time(ot)
                        if now_jst < ot_co_dt:
                            log(f"⚠️ CO at {now_jst.strftime('%H:%M')} is before OT end "
                                f"{ot_co_dt.strftime('%m-%d %H:%M')} — scheduling later CO")
                            created = ensure_ot_checkout_scheduled([ot], now_jst, location_key)
                            if created:
                                result_detail += f" | Auto-scheduled later CO: {', '.join(created)}"

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
        # Phase 3 hardening: queue the rotated token in the Gist;
        # token-monitor.yml drains the queue and updates the GitHub
        # secret centrally (avoids overlapping `gh secret set` races
        # that previously overwrote a newer token with an older one).
        if new_refresh != refresh_token:
            print(f"::add-mask::{new_refresh}")
            try:
                from pending_rotation import write_pending  # noqa: E402
                gh_pat = os.environ.get("GH_PAT") or os.environ.get("GH_TOKEN")
                if gh_pat:
                    write_pending(new_refresh, source="gh_checkin", gh_pat=gh_pat)
                    log("🔄 Refresh token rotated; queued for centralized rotation.")
                else:
                    log("⚠️ Refresh token rotated but GH_PAT missing — cannot queue.")
            except Exception as _e:
                log(f"⚠️ Failed to queue pending rotation (non-fatal): {_e}")
            set_output("token_rotated", "true")
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
