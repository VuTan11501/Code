#!/usr/bin/env python3
"""GitHub Actions — Auto Request OT.
Zero external dependencies (stdlib only).
Reads pending_ot from schedule.json, checks existing OT requests via KINTAI API,
creates missing ones that are within the 7-day creation window.
"""
import os, sys, json, urllib.request, urllib.parse, traceback
from datetime import datetime, timezone, timedelta, date
from calendar import monthrange
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
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
CREATION_WINDOW_DAYS = 7   # forward: today + 7 days
BACKWARD_DAYS = 1          # backward: today - 1 day (yesterday allowed by DokoKin)

GIST_ID = "abc2a47c0a396025a72a6580227ff493"
OT_GIST_FILE = "ot-requests.json"

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


def calculate_night_hours(start_dt, end_dt):
    """Count OT hours overlapping with the 22:00-05:00 late-night window."""
    total_min = int((end_dt - start_dt).total_seconds() / 60)
    night_min = 0
    for m in range(total_min):
        h = (start_dt + timedelta(minutes=m)).hour
        if h >= 22 or h < 5:
            night_min += 1
    return round(night_min / 60, 2)


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

    # Bug #2-3 fix: split OT into normal and late-night (22:00-05:00)
    late_night = min(calculate_night_hours(start_dt, end_dt), ot_hours)
    normal_ot = round(ot_hours - late_night, 2)

    payload = [{
        "employeeId": EMPLOYEE_ID,
        "requestDate": f"{d}T00:00:00",
        "startTime": start_dt.strftime("%Y-%m-%dT%H:%M:%S"),
        "endTime": end_dt.strftime("%Y-%m-%dT%H:%M:%S"),
        "totalOvertime": ot_hours,
        "normalOvertime": normal_ot,
        "lateNightOvertime": late_night,
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

def build_ot_html(created, existing, past, outside_window, errors, today):
    """Build shadcn/ui dark-themed HTML email for Auto Request OT results."""
    BG = "#0a0a0a"
    CARD = "#0f0f0f"
    BORDER = "#262626"
    FG = "#fafafa"
    MUTED = "#a3a3a3"
    MUTED_BG = "#171717"
    has_errors = len(errors) > 0
    accent = (
        {"bg": "rgba(239,68,68,0.12)", "fg": "#f87171", "border": "rgba(239,68,68,0.25)", "label": "Errors"} if has_errors else
        {"bg": "rgba(34,197,94,0.12)", "fg": "#4ade80", "border": "rgba(34,197,94,0.25)", "label": "OK"} if created else
        {"bg": "rgba(59,130,246,0.12)", "fg": "#60a5fa", "border": "rgba(59,130,246,0.25)", "label": "Status"}
    )
    title = "OT Requests Created" if created else "Auto Request OT Status"

    def stat_card(label, value, color=FG):
        return f'''<td width="33%" style="padding:0 4px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:{MUTED_BG};border:1px solid {BORDER};border-radius:8px;">
          <tr><td style="padding:14px 12px;">
            <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:{MUTED};margin-bottom:4px;">{label}</div>
            <div style="font:600 22px/1 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:-0.02em;color:{color};">{value}</div>
          </td></tr></table></td>'''

    def status_pill(color_key, txt):
        c = {"green": ("rgba(34,197,94,0.12)", "#4ade80", "rgba(34,197,94,0.25)"),
             "muted": (MUTED_BG, MUTED, BORDER),
             "yellow": ("rgba(234,179,8,0.12)", "#facc15", "rgba(234,179,8,0.25)")}[color_key]
        return f'<span style="display:inline-block;background:{c[0]};border:1px solid {c[2]};border-radius:9999px;padding:2px 8px;color:{c[1]};font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;">{txt}</span>'

    def trow(date, time, hours, pill):
        return f'''<tr style="border-bottom:1px solid {BORDER};">
          <td style="padding:10px 8px;color:{FG};font:13px ui-monospace,SFMono-Regular,Consolas,monospace;">{date}</td>
          <td style="padding:10px 8px;color:{MUTED};font:12px ui-monospace,SFMono-Regular,Consolas,monospace;">{time}</td>
          <td style="padding:10px 8px;text-align:right;color:{FG};font:600 13px ui-monospace,SFMono-Regular,Consolas,monospace;">{hours}h</td>
          <td style="padding:10px 8px;text-align:right;">{pill}</td></tr>'''

    rows = ""
    for it in created: rows += trow(it['date'], f"{it['start']}→{it['end']}", it['hours'], status_pill('green', 'Created'))
    for it in existing: rows += trow(it['date'], f"{it['start']}→{it['end']}", it['hours'], status_pill('muted', 'Exists'))
    for it in outside_window: rows += trow(it['date'], f"{it['start']}→{it['end']}", it['hours'], status_pill('yellow', 'Waiting'))

    if not rows:
        rows = f'<tr><td colspan="4" style="padding:32px 8px;text-align:center;color:{MUTED};font-size:13px;">No entries to display</td></tr>'

    error_html = ""
    if errors:
        err_items = "".join(f'<li style="color:#fca5a5;margin:6px 0;font-size:12px;">{e}</li>' for e in errors)
        error_html = f'''<div style="background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.25);border-radius:8px;padding:14px;margin-top:20px;">
          <div style="color:#f87171;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:6px;">Errors ({len(errors)})</div>
          <ul style="margin:0;padding-left:18px;">{err_items}</ul></div>'''

    log_html = "<br>".join(LOG_LINES)

    return f'''<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"></head>
<body style="margin:0;padding:0;background:{BG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:{FG};-webkit-font-smoothing:antialiased;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="{BG}" style="background:{BG};">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:{CARD};border:1px solid {BORDER};border-radius:12px;overflow:hidden;">

  <tr><td style="padding:24px 24px 0;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="background:{accent['bg']};border:1px solid {accent['border']};border-radius:9999px;padding:4px 12px;color:{accent['fg']};font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;">{accent['label']}</td>
    </tr></table>
    <h1 style="margin:14px 0 4px;font-size:22px;font-weight:700;letter-spacing:-0.01em;color:{FG};">{title}</h1>
    <p style="margin:0;color:{MUTED};font-size:13px;">Auto Request OT · {today}</p>
  </td></tr>

  <!-- Stats -->
  <tr><td style="padding:20px 20px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      {stat_card('Created', len(created), '#4ade80')}
      {stat_card('Exists', len(existing), FG)}
      {stat_card('Waiting', len(outside_window), '#facc15')}
    </tr></table>
  </td></tr>

  <!-- Table -->
  <tr><td style="padding:20px 24px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid {BORDER};border-radius:8px;overflow:hidden;">
      <thead><tr style="background:{MUTED_BG};">
        <th style="padding:10px 8px;text-align:left;color:{MUTED};font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;border-bottom:1px solid {BORDER};">Date</th>
        <th style="padding:10px 8px;text-align:left;color:{MUTED};font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;border-bottom:1px solid {BORDER};">Time</th>
        <th style="padding:10px 8px;text-align:right;color:{MUTED};font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;border-bottom:1px solid {BORDER};">Hours</th>
        <th style="padding:10px 8px;text-align:right;color:{MUTED};font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;border-bottom:1px solid {BORDER};">Status</th>
      </tr></thead>
      <tbody>{rows}</tbody>
    </table>
    {error_html}
  </td></tr>

  <!-- Log -->
  <tr><td style="padding:20px 24px;">
    <details style="background:{MUTED_BG};border:1px solid {BORDER};border-radius:8px;">
      <summary style="cursor:pointer;padding:10px 14px;color:{MUTED};font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;">Execution log ({len(LOG_LINES)} lines)</summary>
      <div style="padding:0 14px 14px;font:11px/1.7 ui-monospace,SFMono-Regular,Consolas,monospace;color:#d4d4d4;max-height:360px;overflow:auto;white-space:pre-wrap;word-break:break-word;">{log_html}</div>
    </details>
  </td></tr>

  <tr><td style="padding:14px 24px;border-top:1px solid {BORDER};background:#080808;">
    <div style="color:#737373;font-size:11px;letter-spacing:0.02em;">Auto Request OT · GitHub Actions · {today}</div>
  </td></tr>
</table>
</td></tr></table></body></html>'''


def send_email(subject, body, html=None):
    smtp_user = os.environ.get("SMTP_USER")
    smtp_pass = os.environ.get("SMTP_PASS")
    notify_email = os.environ.get("NOTIFY_EMAIL")
    if not all([smtp_user, smtp_pass, notify_email]):
        log("Email not configured, skip notification")
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
        with smtplib.SMTP("smtp.gmail.com", 587, timeout=15) as server:
            server.starttls()
            server.login(smtp_user, smtp_pass)
            server.send_message(msg)
        log(f"📧 Email sent to {notify_email}")
    except Exception as e:
        log(f"⚠️ Email failed: {e}")


# ═══════════════════════════════════════════════════════════
#  GIST LOADER (OT requests) — delegated to shared helper
# ═══════════════════════════════════════════════════════════

from ot_gist import load_ot_from_gist as _load_ot_from_gist_shared


def load_ot_from_gist():
    return _load_ot_from_gist_shared(log=log)


def write_back_kintai_status(created_dates, existing_dates):
    """Mark OT entries in Gist with `kintai_created_at` ISO timestamp when they
    are confirmed present in DokoKin (either just created or already existed).
    Idempotent — won't overwrite an existing `kintai_created_at`.
    Returns count of entries updated. Best-effort: failure is logged, not raised.
    """
    pat = os.environ.get("GH_PAT")
    if not pat:
        log("GH_PAT not set; skip Gist write-back of kintai_created_at")
        return 0
    target_dates = {d.isoformat() if hasattr(d, 'isoformat') else str(d)
                    for d in (set(created_dates) | set(existing_dates))}
    if not target_dates:
        return 0

    # Use defensive read/write helpers (rolling backup + race detection + sanity gate)
    from gist_safety import (
        read_gist_file, safe_patch_gist_file,
        sanity_check_ot_requests, validate_ot_requests_shape,
        GistSafetyError,
    )
    try:
        snapshot = read_gist_file(pat, GIST_ID, OT_GIST_FILE, log=log)
    except Exception as e:
        log(f"⚠️ Gist read failed for write-back: {e}")
        return 0
    raw = snapshot["parsed"]
    if isinstance(raw, dict) and "requests" in raw:
        wrapper = raw
        arr = raw.get("requests") or []
    elif isinstance(raw, list):
        wrapper = None
        arr = list(raw)
    else:
        log(f"⚠️ Gist {OT_GIST_FILE} unexpected shape; skip write-back")
        return 0
    if not isinstance(arr, list):
        return 0
    old_arr_snapshot = json.loads(json.dumps(arr))
    now_iso = datetime.now(JST).isoformat(timespec="seconds")
    updated = 0
    for entry in arr:
        if not isinstance(entry, dict):
            continue
        if entry.get("date") in target_dates and not entry.get("kintai_created_at"):
            entry["kintai_created_at"] = now_iso
            updated += 1
    if updated == 0:
        log("Gist write-back: nothing to mark (all entries already tagged)")
        return 0
    # This op only mutates — should never remove. Sanity check will catch bugs.
    try:
        sanity_check_ot_requests(old_arr_snapshot, arr, log=log)
    except GistSafetyError as e:
        log(f"⚠️ Gist write-back blocked by safety gate: {e}")
        return 0
    if wrapper is not None:
        wrapper["requests"] = arr
        new_content = json.dumps(wrapper, indent=2, ensure_ascii=False)
    else:
        new_content = json.dumps(arr, indent=2, ensure_ascii=False)
    try:
        st = safe_patch_gist_file(
            pat, GIST_ID, OT_GIST_FILE,
            new_content=new_content,
            snapshot=snapshot,
            shape_validator=validate_ot_requests_shape,
            log=log,
        )
        log(f"✓ Gist write-back: marked {updated} entries as kintai_created (HTTP {st}, backup written)")
        return updated
    except Exception as e:
        log(f"⚠️ Gist write-back PATCH failed: {e}")
        return 0


# ═══════════════════════════════════════════════════════════
#  MAIN
# ═══════════════════════════════════════════════════════════

def main():
    now = datetime.now(JST)
    today = now.date()
    log(f"Auto Request OT running at {now.strftime('%Y-%m-%d %H:%M:%S %A')}")

    created_items = []
    existing_items = []
    outside_items = []
    skipped_past = 0
    errors = []

    try:
        # Try to load OT requests from Gist first (authoritative if present)
        pending_ot = load_ot_from_gist()
        source = "gist"
        if pending_ot is None:
            # Fallback to schedule.json
            sched_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "schedule.json")
            with open(sched_path, encoding="utf-8") as f:
                schedule = json.load(f)
            pending_ot = schedule.get("pending_ot", [])
            source = "schedule.json (fallback)"

        if not pending_ot:
            log(f"No OT requests found (source: {source}). Nothing to do.")
            return

        log(f"Found {len(pending_ot)} planned OT entries (source: {source})")

        # Filter: only process entries within the creation window
        # Window = [today - 1 day, today + 7 days]. DokoKin OT API explicitly
        # allows 1 day backward ("The overtime request only accept for 1 day
        # backward.") + 7 days forward.
        actionable = []
        for entry in pending_ot:
            ot_date = date.fromisoformat(entry["date"])
            days_until = (ot_date - today).days

            if days_until < -BACKWARD_DAYS:
                skipped_past += 1
            elif days_until > CREATION_WINDOW_DAYS:
                outside_items.append(entry)
                log(f"  {entry['date']}: {days_until} days away, outside window (-{BACKWARD_DAYS}..+{CREATION_WINDOW_DAYS})")
            else:
                actionable.append(entry)

        if not actionable:
            log(f"No OT entries within creation window. (past:{skipped_past}, waiting:{len(outside_items)})")
            return

        log(f"{len(actionable)} entries within window (-{BACKWARD_DAYS}..+{CREATION_WINDOW_DAYS} days), checking existing...")

        # Get token
        refresh_token = os.environ.get("AZURE_REFRESH_TOKEN")
        if not refresh_token:
            raise RuntimeError("AZURE_REFRESH_TOKEN secret not set!")

        log("Getting KINTAI token...")
        azure_token, new_refresh = refresh_azure_token(refresh_token)
        kintai_token = get_kintai_token(azure_token)
        log("KINTAI token OK ✓")

        # Get existing OT requests for relevant months — expand to ALL Gist
        # pending months (not just actionable) so write-back can backfill past
        # entries that were created in earlier auto-runs.
        months_to_check = set()
        for entry in pending_ot:
            try:
                d = date.fromisoformat(entry["date"])
                months_to_check.add((d.year, d.month))
            except Exception:
                pass

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
                existing_items.append(entry)
                log(f"  ✓ {entry['date']} {day_name}: already exists, skip")
                continue

            log(f"  → Creating OT: {entry['date']} {day_name} {entry['start']}→{entry['end']} ({entry['hours']}h)")
            try:
                status, resp = create_ot_request(kintai_token, entry)
                if status == 200:
                    created_items.append(entry)
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
            print(f"::add-mask::{new_refresh}")
            output_file = os.environ.get("GITHUB_OUTPUT")
            if output_file:
                with open(output_file, "a") as f:
                    f.write(f"token_rotated=true\n")
                    f.write(f"new_refresh_token={new_refresh}\n")

        # Write back kintai_created_at to Gist (best-effort).
        # existing_dates contains ALL DokoKin OT requests for relevant months
        # so this also backfills past entries that pre-date this feature.
        if source == "gist":
            try:
                created_dates_set = {e["date"] for e in created_items}
                write_back_kintai_status(created_dates_set, existing_dates)
            except Exception as e:
                log(f"⚠️ Write-back exception (non-fatal): {e}")

    except Exception as e:
        errors.append(str(e))
        log(f"❌ EXCEPTION: {e}")
        traceback.print_exc()
    finally:
        # Summary
        log("")
        log("═══ Summary ═══")
        log(f"  Created: {len(created_items)}")
        log(f"  Already exist: {len(existing_items)}")
        log(f"  Past dates: {skipped_past}")
        log(f"  Outside window: {len(outside_items)}")
        if errors:
            log(f"  Errors: {len(errors)}")
            for e in errors:
                log(f"    • {e}")

        # Always send email summary (matches checkin/checkout behavior)
        today_str = today if isinstance(today, str) else str(today)
        if errors:
            emoji, status_word = "🚨", "ERROR"
        elif created_items:
            emoji, status_word = "✅", "CREATED"
        elif existing_items and not outside_items:
            emoji, status_word = "ℹ️", "UP-TO-DATE"
        elif outside_items:
            emoji, status_word = "⏳", "WAITING"
        else:
            emoji, status_word = "💤", "NO-OP"
        subject = (
            f"{emoji} Auto Request OT [{status_word}]: "
            f"{len(created_items)} created, {len(existing_items)} exist, "
            f"{len(outside_items)} pending, {len(errors)} errors — {today_str}"
        )
        plain_body = "\n".join(LOG_LINES)
        html_body = build_ot_html(created_items, existing_items, skipped_past, outside_items, errors, today_str)
        send_email(subject, plain_body, html=html_body)

        if errors:
            sys.exit(1)


if __name__ == "__main__":
    main()
