#!/usr/bin/env python3
"""AI Monthly Insight Report — deterministic stats + AI-written prose insights.

Generates a monthly email (1st of month, 09:00 JST) with:
  - Deterministic OT/attendance stats for previous month
  - 3-6 month trend analysis
  - AI-written Vietnamese prose insights (fallback to template)
  - Actionable suggestions for next month
  - Persists history to Gist monthly-insights.json (24 months max)

CLI:
  --month YYYY-MM   Override target month (default: previous month JST)
  --dry-run         Print email body without sending
  --always-email    Send even if no data
  --lookback-months N  Months of history for trend (default: 6)
  --test            Run with synthetic data, print stats, exit 0

Zero external dependencies (stdlib only).
"""
import argparse
import json
import os
import smtplib
import sys
import time
import traceback
import urllib.request
import urllib.parse
from datetime import datetime, timezone, timedelta, date
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

# Make sibling modules importable
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from user_config import (  # noqa: E402
    GIST_ID, API_BASE, AZURE_APP_ID, AZURE_TENANT, BASE_HOURLY_RATE, EMPLOYEE_ID,
)

JST = timezone(timedelta(hours=9))
INSIGHTS_FILE = "monthly-insights.json"
AZURE_SCOPE = f"api://{AZURE_APP_ID}/openid user.read offline_access"

# OT Rate multipliers (same as ot_report.py / ot-salary.js)
RATES = {
    "sunday_night": 1.60,
    "any_night": 1.50,
    "sunday_day": 1.35,
    "weekday_sat": 1.25,
}
BASE_HOURLY = BASE_HOURLY_RATE


def log(msg, prefix="[insight]"):
    ts = datetime.now(JST).strftime("%H:%M:%S")
    print(f"{prefix} [{ts}] {msg}")


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
            return resp.status, json.loads(raw) if raw.strip() else {}
    except urllib.error.HTTPError as e:
        raw = e.read().decode(errors="replace")
        try:
            return e.code, json.loads(raw)
        except Exception:
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
        except Exception:
            return e.code, {"error": raw}


# ═══════════════════════════════════════════════════════════
#  TOKEN MANAGEMENT (reused pattern from gh_checkin.py)
# ═══════════════════════════════════════════════════════════

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
#  DATA LOADERS
# ═══════════════════════════════════════════════════════════

def load_dakoku_month(token, year, month):
    """Fetch dakoku records for every day in a month. Returns list of day records."""
    from calendar import monthrange
    days_in_month = monthrange(year, month)[1]
    records = []
    for day in range(1, days_in_month + 1):
        d = date(year, month, day)
        date_str = d.isoformat()
        status_code, data = http_get(
            API_BASE + f"dakoku/me/{date_str}",
            headers={"Authorization": f"Bearer {token}", "Module": "KINTAI"},
        )
        if status_code == 200 and data:
            records.append({
                "date": date_str,
                "weekday": d.weekday(),  # Mon=0
                "startWorkingTime": data.get("startWorkingTime") or data.get("displayStartWorkingTime"),
                "endWorkingTime": data.get("endWorkingTime") or data.get("displayEndWorkingTime"),
                "raw": data,
            })
        else:
            records.append({"date": date_str, "weekday": d.weekday(),
                            "startWorkingTime": None, "endWorkingTime": None, "raw": None})
        # Rate limit courtesy
        time.sleep(0.1)
    return records


def load_ot_requests_for_month(year, month):
    """Load OT requests from Gist filtered by month."""
    try:
        from ot_gist import load_ot_from_gist
        entries = load_ot_from_gist(log=lambda m: log(m, "[stats]"))
    except ImportError:
        entries = None
    if entries is None:
        return []
    prefix = f"{year}-{month:02d}"
    return [e for e in entries if e.get("date", "").startswith(prefix)]


def read_gist_file(filename):
    """Read a file from the project Gist."""
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
    try:
        return json.loads(f.get("content") or "null")
    except Exception:
        return None


def write_gist_file(filename, content_obj):
    """Write/update a file in the project Gist."""
    pat = os.environ.get("GH_PAT")
    if not pat:
        log("⚠️ GH_PAT not set, cannot write Gist")
        return False
    url = f"https://api.github.com/gists/{GIST_ID}"
    payload = json.dumps({
        "files": {filename: {"content": json.dumps(content_obj, ensure_ascii=False, indent=2)}}
    }).encode()
    req = urllib.request.Request(url, data=payload, headers={
        "Authorization": f"Bearer {pat}",
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
    }, method="PATCH")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status == 200
    except Exception as e:
        log(f"⚠️ Gist write failed: {e}")
        return False


# ═══════════════════════════════════════════════════════════
#  DETERMINISTIC STATS (pure functions)
# ═══════════════════════════════════════════════════════════

def parse_working_hours(start_str, end_str):
    """Parse working time strings to compute hours worked.
    Handles formats like '2026-05-19T09:00:00' or 'HH:MM'.
    Returns float hours or None.
    """
    if not start_str or not end_str:
        return None
    try:
        # Try ISO datetime format
        if "T" in start_str:
            fmt = "%Y-%m-%dT%H:%M:%S"
            start = datetime.strptime(start_str[:19], fmt)
            end = datetime.strptime(end_str[:19], fmt)
        else:
            # HH:MM format
            start = datetime.strptime(start_str[:5], "%H:%M")
            end = datetime.strptime(end_str[:5], "%H:%M")
            if end < start:
                end += timedelta(days=1)
        delta = (end - start).total_seconds() / 3600
        return max(0, delta)
    except Exception:
        return None


def classify_hours(d, start_str, end_str, total_hours):
    """Classify working hours into shift types (pure-night, day, mixed).
    d: date object. Returns dict {shift_type: hours}.
    """
    if not start_str or not end_str or not total_hours or total_hours <= 0:
        return {}
    try:
        if "T" in start_str:
            start_h = int(start_str[11:13])
            start_m = int(start_str[14:16])
            end_h = int(end_str[11:13])
            end_m = int(end_str[14:16])
        else:
            parts = start_str.split(":")
            start_h, start_m = int(parts[0]), int(parts[1])
            parts = end_str.split(":")
            end_h, end_m = int(parts[0]), int(parts[1])
    except (ValueError, IndexError):
        return {"day": total_hours}

    # Build minute timeline
    start_dt = datetime(d.year, d.month, d.day, start_h, start_m)
    if end_h < start_h or (end_h == start_h and end_m < start_m):
        end_date = d + timedelta(days=1)
    else:
        end_date = d
    end_dt = datetime(end_date.year, end_date.month, end_date.day, end_h, end_m)

    total_minutes = int((end_dt - start_dt).total_seconds() / 60)
    if total_minutes <= 0:
        return {"day": total_hours}

    night_minutes = 0
    for m in range(total_minutes):
        h = (start_dt + timedelta(minutes=m)).hour
        if h >= 22 or h < 5:
            night_minutes += 1
    day_minutes = total_minutes - night_minutes

    night_ratio = night_minutes / total_minutes
    if night_ratio >= 0.9:
        return {"pure_night": total_hours}
    elif night_ratio >= 0.1:
        night_h = round(total_hours * night_ratio, 2)
        return {"mixed": total_hours, "pure_night": night_h, "day": total_hours - night_h}
    else:
        return {"day": total_hours}


def compute_month_stats(month_str, dakoku_records, ot_requests, base_hourly=BASE_HOURLY):
    """Compute deterministic stats for a single month.

    Args:
        month_str: 'YYYY-MM'
        dakoku_records: list from load_dakoku_month
        ot_requests: list of OT entries for this month
        base_hourly: base JPY/h

    Returns: dict with all stat fields.
    """
    log(f"Computing stats for {month_str}", "[stats]")
    total_hours = 0.0
    regular_hours = 0.0
    ot_hours = 0.0
    by_dow = {i: 0.0 for i in range(7)}  # Mon=0..Sun=6
    by_shift = {"pure_night": 0.0, "day": 0.0, "mixed": 0.0}
    day_hours_list = []
    late_checkins = 0
    early_co_before_ot = 0

    REGULAR_DAY_HOURS = 8.0  # standard working hours

    for rec in dakoku_records:
        start = rec.get("startWorkingTime")
        end = rec.get("endWorkingTime")
        hours = parse_working_hours(start, end)
        if hours is None or hours <= 0:
            continue
        d = date.fromisoformat(rec["date"])
        dow = d.weekday()

        total_hours += hours
        # Regular vs OT: weekday hours > 8 = OT, weekend = all OT
        if dow < 5:  # Mon-Fri
            reg = min(hours, REGULAR_DAY_HOURS)
            ot = max(0, hours - REGULAR_DAY_HOURS)
        else:  # Sat/Sun = all OT
            reg = 0
            ot = hours
        regular_hours += reg
        ot_hours += ot
        by_dow[dow] += hours

        # Classify shift type
        shifts = classify_hours(d, start, end, hours)
        for stype in ("pure_night", "day", "mixed"):
            by_shift[stype] += shifts.get(stype, 0)

        day_hours_list.append((rec["date"], hours))

        # Late checkin check (> 09:15 on weekdays)
        if dow < 5 and start:
            try:
                ci_h = int(start[11:13]) if "T" in start else int(start.split(":")[0])
                ci_m = int(start[14:16]) if "T" in start else int(start.split(":")[1])
                if ci_h > 9 or (ci_h == 9 and ci_m > 15):
                    late_checkins += 1
            except (ValueError, IndexError):
                pass

    # Top 5 days by hours
    day_hours_list.sort(key=lambda x: x[1], reverse=True)
    top_5_days = []
    for d_str, hrs in day_hours_list[:5]:
        d = date.fromisoformat(d_str)
        # Estimate gross for this day
        dow = d.weekday()
        if dow == 6:  # Sunday
            rate = RATES["sunday_night"] if hrs > 0 and by_shift["pure_night"] > 0 else RATES["sunday_day"]
        elif hrs > REGULAR_DAY_HOURS:
            rate = RATES["any_night"] if by_shift["pure_night"] > 0 else RATES["weekday_sat"]
        else:
            rate = 1.0
        gross = round(hrs * base_hourly * rate)
        top_5_days.append({"date": d_str, "hours": round(hrs, 2), "gross_jpy": gross})

    # Gross/net estimates from OT requests (more accurate than dakoku for OT breakdown)
    gross_jpy = 0
    for entry in ot_requests:
        d = date.fromisoformat(entry["date"])
        hrs = entry.get("hours", 0)
        is_sunday = d.weekday() == 6
        # Classify night vs day for this OT entry
        start_h = int(entry["start"].split(":")[0])
        end_h = int(entry["end"].split(":")[0])
        is_night = start_h >= 22 or end_h <= 5 or start_h < 5
        if is_sunday and is_night:
            rate = RATES["sunday_night"]
        elif is_sunday:
            rate = RATES["sunday_day"]
        elif is_night:
            rate = RATES["any_night"]
        else:
            rate = RATES["weekday_sat"]
        gross_jpy += hrs * base_hourly * rate

    gross_jpy = round(gross_jpy)
    # Rough net estimate (income tax ~20% + social insurance ~15%)
    estimated_net_jpy = round(gross_jpy * 0.65)

    target_75h_pct = round(ot_hours / 75 * 100, 1) if ot_hours > 0 else 0

    return {
        "month": month_str,
        "total_hours": round(total_hours, 2),
        "ot_hours": round(ot_hours, 2),
        "regular_hours": round(regular_hours, 2),
        "by_day_of_week": {str(k): round(v, 2) for k, v in by_dow.items()},
        "by_shift_type": {k: round(v, 2) for k, v in by_shift.items()},
        "top_5_days": top_5_days,
        "gross_jpy": gross_jpy,
        "estimated_net_jpy": estimated_net_jpy,
        "target_75h_pct": target_75h_pct,
        "late_checkins": late_checkins,
        "early_checkouts_before_ot_end": early_co_before_ot,
        "ot_entry_count": len(ot_requests),
    }


def compute_trend(month_stats_list):
    """Compute 3-6 month rolling trend from list of month stats.

    Returns: dict with direction, pace_delta_pct, gross_delta_jpy.
    """
    if len(month_stats_list) < 2:
        return {"direction": "→", "pace_delta_pct": 0, "gross_delta_jpy": 0, "months_analyzed": len(month_stats_list)}

    current = month_stats_list[-1]
    previous = month_stats_list[-2]

    cur_ot = current.get("stats", current).get("ot_hours", 0) if "stats" in current else current.get("ot_hours", 0)
    prev_ot = previous.get("stats", previous).get("ot_hours", 0) if "stats" in previous else previous.get("ot_hours", 0)

    cur_gross = current.get("stats", current).get("gross_jpy", 0) if "stats" in current else current.get("gross_jpy", 0)
    prev_gross = previous.get("stats", previous).get("gross_jpy", 0) if "stats" in previous else previous.get("gross_jpy", 0)

    if prev_ot > 0:
        pace_delta_pct = round((cur_ot - prev_ot) / prev_ot * 100, 1)
    else:
        pace_delta_pct = 100 if cur_ot > 0 else 0

    gross_delta_jpy = round(cur_gross - prev_gross)

    if pace_delta_pct > 5:
        direction = "↑"
    elif pace_delta_pct < -5:
        direction = "↓"
    else:
        direction = "→"

    return {
        "direction": direction,
        "pace_delta_pct": pace_delta_pct,
        "gross_delta_jpy": gross_delta_jpy,
        "months_analyzed": len(month_stats_list),
    }


# ═══════════════════════════════════════════════════════════
#  AI PROSE GENERATION
# ═══════════════════════════════════════════════════════════

def generate_ai_prose(stats, trend):
    """Generate AI-written insights in Vietnamese. Falls back to template on failure."""
    # Try importing shared ai_client
    try:
        from ai_client import chat_completion
        has_ai_client = True
    except ImportError:
        has_ai_client = False

    if not has_ai_client:
        # Check for AI_API_BASE env to use inline fallback client
        api_base = os.environ.get("AI_API_BASE")
        api_key = os.environ.get("GH_PAT")  # GitHub Models uses PAT
        if api_base and api_key:
            has_ai_client = True

            def chat_completion(messages, model="gpt-4o-mini", max_tokens=600, **kwargs):
                """Inline minimal AI client (fallback if ai_client.py not available)."""
                url = f"{api_base.rstrip('/')}/chat/completions"
                payload = {
                    "model": model,
                    "messages": messages,
                    "max_tokens": max_tokens,
                }
                payload.update(kwargs)
                body = json.dumps(payload).encode()
                req = urllib.request.Request(url, data=body, headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                })
                with urllib.request.urlopen(req, timeout=30) as resp:
                    result = json.loads(resp.read())
                return {"content": result["choices"][0]["message"]["content"]}
        else:
            log("⚠️ No AI client available, using template fallback")

    system_prompt = (
        "Bạn là financial coach cho TanVC. Cho stats sau, viết 2-4 insights bằng tiếng Việt, "
        "mỗi insight là 1 bullet ngắn (1-2 câu), ưu tiên insights actionable. "
        "Tone: warm + analytical. Bao gồm 1 suggestion cụ thể cho tháng sau."
    )
    user_content = json.dumps({"stats": stats, "trend": trend}, ensure_ascii=False, indent=2)

    if has_ai_client:
        try:
            messages = [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_content},
            ]
            result = chat_completion(messages, model="gpt-4o-mini", max_tokens=600)
            prose = result.get("content") or result.get("text", "")
            if prose and len(prose) > 20:
                log("✅ AI prose generated successfully")
                return prose
        except Exception as e:
            log(f"⚠️ AI generation failed: {e}, using template fallback")

    # Template fallback
    return _template_fallback(stats, trend)


def _template_fallback(stats, trend):
    """Generate template-based insights when AI is unavailable."""
    lines = []
    ot = stats.get("ot_hours", 0)
    gross = stats.get("gross_jpy", 0)
    pct = stats.get("target_75h_pct", 0)
    direction = trend.get("direction", "→")
    delta_pct = trend.get("pace_delta_pct", 0)

    lines.append(f"• Tổng OT tháng này: {ot:.1f}h ({pct:.0f}% cap 75h), gross ¥{gross:,.0f}")

    if direction == "↑":
        lines.append(f"• Xu hướng tăng {abs(delta_pct):.0f}% so với tháng trước — giữ pace tốt!")
    elif direction == "↓":
        lines.append(f"• Xu hướng giảm {abs(delta_pct):.0f}% so với tháng trước — cân nhắc tăng ca đêm CN.")
    else:
        lines.append("• Pace ổn định so với tháng trước.")

    pure_night = stats.get("by_shift_type", {}).get("pure_night", 0)
    if pure_night > 0 and ot > 0:
        night_pct = pure_night / ot * 100
        lines.append(f"• Ca đêm chiếm {night_pct:.0f}% tổng OT — rate 150-160% hiệu quả nhất.")

    late = stats.get("late_checkins", 0)
    if late > 0:
        lines.append(f"• ⚠️ {late} ngày CI muộn (>09:15) — check alarm?")

    lines.append("• 💡 Suggestion: ưu tiên pure-night shifts CN (22:00-04:00) để tối đa rate 160%.")
    return "\n".join(lines)


# ═══════════════════════════════════════════════════════════
#  EMAIL COMPOSITION
# ═══════════════════════════════════════════════════════════

def compose_email_html(month_str, stats, trend, ai_prose):
    """Compose HTML email with inline CSS for email client compatibility."""
    BG = "#0a0a0a"
    CARD = "#0f0f0f"
    BORDER = "#262626"
    FG = "#fafafa"
    MUTED = "#a3a3a3"
    MUTED_BG = "#171717"
    PRIMARY = "#3b82f6"
    GREEN = "#22c55e"
    RED = "#ef4444"

    ot = stats.get("ot_hours", 0)
    gross = stats.get("gross_jpy", 0)
    net = stats.get("estimated_net_jpy", 0)
    pct = stats.get("target_75h_pct", 0)
    direction = trend.get("direction", "→")
    delta_pct = trend.get("pace_delta_pct", 0)
    delta_jpy = trend.get("gross_delta_jpy", 0)

    trend_color = GREEN if direction == "↑" else (RED if direction == "↓" else MUTED)

    # DOW labels
    dow_labels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    by_dow = stats.get("by_day_of_week", {})
    dow_rows = ""
    for i in range(7):
        h = by_dow.get(str(i), 0)
        bar_width = min(100, int(h / max(1, ot) * 100)) if ot > 0 else 0
        dow_rows += f'''<tr>
            <td style="padding:4px 8px;color:{MUTED};font-size:12px;width:40px;">{dow_labels[i]}</td>
            <td style="padding:4px 8px;">
                <div style="background:{PRIMARY};height:12px;width:{bar_width}%;border-radius:4px;min-width:2px;"></div>
            </td>
            <td style="padding:4px 8px;color:{FG};font-size:12px;text-align:right;width:50px;">{h:.1f}h</td>
        </tr>'''

    # Top 5 days
    top5_rows = ""
    for item in stats.get("top_5_days", [])[:5]:
        top5_rows += f'''<tr style="border-bottom:1px solid {BORDER};">
            <td style="padding:6px 8px;color:{FG};font-size:13px;font-family:monospace;">{item['date']}</td>
            <td style="padding:6px 8px;color:{FG};text-align:right;font-family:monospace;">{item['hours']:.1f}h</td>
            <td style="padding:6px 8px;color:{GREEN};text-align:right;font-family:monospace;">¥{item['gross_jpy']:,}</td>
        </tr>'''

    # AI prose formatted
    prose_html = ""
    for line in (ai_prose or "").split("\n"):
        line = line.strip()
        if line:
            prose_html += f'<p style="margin:8px 0;color:{FG};font-size:14px;line-height:1.6;">{line}</p>'

    shift_data = stats.get("by_shift_type", {})

    html = f'''<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="color-scheme" content="dark"></head>
<body style="margin:0;padding:20px;background:{BG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:{FG};">
<div style="max-width:600px;margin:0 auto;">

<!-- Header -->
<div style="text-align:center;padding:24px 0;border-bottom:1px solid {BORDER};">
    <h1 style="margin:0;font-size:20px;font-weight:700;color:{FG};">📊 Monthly Insight — {month_str}</h1>
    <p style="margin:8px 0 0;color:{MUTED};font-size:13px;">AI-generated report for TanVC</p>
</div>

<!-- Summary Cards -->
<table width="100%" cellpadding="0" cellspacing="8" style="margin:16px 0;">
<tr>
    <td width="33%" style="background:{MUTED_BG};border:1px solid {BORDER};border-radius:8px;padding:14px;text-align:center;">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:{MUTED};margin-bottom:4px;">OT Hours</div>
        <div style="font:700 22px monospace;color:{FG};">{ot:.1f}h</div>
        <div style="font-size:11px;color:{MUTED};">{pct:.0f}% of 75h cap</div>
    </td>
    <td width="33%" style="background:{MUTED_BG};border:1px solid {BORDER};border-radius:8px;padding:14px;text-align:center;">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:{MUTED};margin-bottom:4px;">Gross OT</div>
        <div style="font:700 22px monospace;color:{GREEN};">¥{gross:,}</div>
    </td>
    <td width="33%" style="background:{MUTED_BG};border:1px solid {BORDER};border-radius:8px;padding:14px;text-align:center;">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:{MUTED};margin-bottom:4px;">Est. Net</div>
        <div style="font:700 22px monospace;color:{PRIMARY};">¥{net:,}</div>
    </td>
</tr>
</table>

<!-- Trend -->
<div style="background:{MUTED_BG};border:1px solid {BORDER};border-radius:8px;padding:16px;margin:16px 0;">
    <div style="font-size:12px;font-weight:600;color:{MUTED};text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">Trend ({trend.get('months_analyzed', 0)} months)</div>
    <span style="font-size:28px;color:{trend_color};">{direction}</span>
    <span style="font-size:14px;color:{FG};margin-left:12px;">{delta_pct:+.1f}% OT hours</span>
    <span style="font-size:14px;color:{trend_color};margin-left:12px;">¥{delta_jpy:+,} gross</span>
</div>

<!-- Breakdown by DOW -->
<div style="background:{MUTED_BG};border:1px solid {BORDER};border-radius:8px;padding:16px;margin:16px 0;">
    <div style="font-size:12px;font-weight:600;color:{MUTED};text-transform:uppercase;letter-spacing:0.05em;margin-bottom:12px;">Hours by Day of Week</div>
    <table width="100%" cellpadding="0" cellspacing="0">{dow_rows}</table>
</div>

<!-- Shift Type -->
<div style="background:{MUTED_BG};border:1px solid {BORDER};border-radius:8px;padding:16px;margin:16px 0;">
    <div style="font-size:12px;font-weight:600;color:{MUTED};text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">Shift Type Breakdown</div>
    <table width="100%" cellpadding="4" cellspacing="0">
        <tr><td style="color:{MUTED};font-size:12px;">🌙 Pure Night (22-05)</td><td style="color:{FG};font-family:monospace;text-align:right;">{shift_data.get('pure_night', 0):.1f}h</td></tr>
        <tr><td style="color:{MUTED};font-size:12px;">☀️ Day</td><td style="color:{FG};font-family:monospace;text-align:right;">{shift_data.get('day', 0):.1f}h</td></tr>
        <tr><td style="color:{MUTED};font-size:12px;">🔀 Mixed</td><td style="color:{FG};font-family:monospace;text-align:right;">{shift_data.get('mixed', 0):.1f}h</td></tr>
    </table>
</div>

<!-- Top 5 Days -->
<div style="background:{MUTED_BG};border:1px solid {BORDER};border-radius:8px;padding:16px;margin:16px 0;">
    <div style="font-size:12px;font-weight:600;color:{MUTED};text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">Top 5 Days</div>
    <table width="100%" cellpadding="0" cellspacing="0">{top5_rows}</table>
</div>

<!-- AI Insights -->
<div style="background:{MUTED_BG};border:1px solid {BORDER};border-radius:8px;padding:16px;margin:16px 0;border-left:3px solid {PRIMARY};">
    <div style="font-size:12px;font-weight:600;color:{PRIMARY};text-transform:uppercase;letter-spacing:0.05em;margin-bottom:12px;">💡 AI Insights</div>
    {prose_html}
</div>

<!-- Footer -->
<div style="text-align:center;padding:16px 0;border-top:1px solid {BORDER};margin-top:24px;">
    <p style="font-size:11px;color:{MUTED};margin:0;">Generated by AI Monthly Insight • {datetime.now(JST).strftime('%Y-%m-%d %H:%M JST')}</p>
</div>

</div></body></html>'''
    return html


# ═══════════════════════════════════════════════════════════
#  EMAIL SENDING
# ═══════════════════════════════════════════════════════════

def send_email(subject, html_body):
    """Send email via SMTP (Gmail). Returns True on success."""
    smtp_user = os.environ.get("SMTP_USER")
    smtp_pass = os.environ.get("SMTP_PASS")
    notify_email = os.environ.get("NOTIFY_EMAIL")

    if not all([smtp_user, smtp_pass, notify_email]):
        log("⚠️ SMTP credentials missing, cannot send email")
        return False

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = smtp_user
    msg["To"] = notify_email
    msg.attach(MIMEText(html_body, "html", "utf-8"))

    try:
        with smtplib.SMTP("smtp.gmail.com", 587, timeout=30) as server:
            server.starttls()
            server.login(smtp_user, smtp_pass)
            server.sendmail(smtp_user, [notify_email], msg.as_string())
        log("✅ Email sent successfully")
        return True
    except Exception as e:
        log(f"❌ Email send failed: {e}")
        return False


# ═══════════════════════════════════════════════════════════
#  GIST PERSISTENCE
# ═══════════════════════════════════════════════════════════

def persist_to_gist(month_str, stats, trend, ai_prose):
    """Append monthly insight to Gist history (max 24 months)."""
    existing = read_gist_file(INSIGHTS_FILE)
    if not isinstance(existing, list):
        existing = []

    entry = {
        "month": month_str,
        "computed_at": datetime.now(JST).isoformat(),
        "stats": stats,
        "trend": trend,
        "ai_prose": ai_prose,
    }

    # Replace if same month exists, else append
    found = False
    for i, e in enumerate(existing):
        if isinstance(e, dict) and e.get("month") == month_str:
            existing[i] = entry
            found = True
            break
    if not found:
        existing.append(entry)

    # Sort by month, keep latest 24
    existing.sort(key=lambda x: x.get("month", ""))
    if len(existing) > 24:
        existing = existing[-24:]

    if write_gist_file(INSIGHTS_FILE, existing):
        log(f"✅ Persisted insight for {month_str} to Gist ({len(existing)} months total)")
    else:
        log("⚠️ Failed to persist to Gist")


# ═══════════════════════════════════════════════════════════
#  SYNTHETIC TEST DATA
# ═══════════════════════════════════════════════════════════

def generate_test_data():
    """Generate synthetic month of dakoku + OT data for testing."""
    from calendar import monthrange
    year, month = 2026, 4
    days = monthrange(year, month)[1]

    dakoku = []
    ot_requests = []

    for day in range(1, days + 1):
        d = date(year, month, day)
        dow = d.weekday()
        date_str = d.isoformat()

        if dow < 5:  # Weekday
            dakoku.append({
                "date": date_str, "weekday": dow,
                "startWorkingTime": f"{date_str}T09:00:00",
                "endWorkingTime": f"{date_str}T18:00:00",
                "raw": None,
            })
        elif dow == 6 and day % 7 == 0:  # Some Sundays have OT
            dakoku.append({
                "date": date_str, "weekday": dow,
                "startWorkingTime": f"{date_str}T22:00:00",
                "endWorkingTime": f"{d + timedelta(days=1)}T04:00:00".replace(str(d + timedelta(days=1)), (d + timedelta(days=1)).isoformat()),
                "raw": None,
            })
            ot_requests.append({
                "date": date_str, "start": "22:00", "end": "04:00",
                "hours": 6, "reason": "project delivery",
            })
        # Some weekday nights
        if dow in (1, 3) and day <= 20:  # Tue, Thu nights
            ot_requests.append({
                "date": date_str, "start": "22:00", "end": "04:00",
                "hours": 6, "reason": "deadline",
            })

    return year, month, dakoku, ot_requests


# ═══════════════════════════════════════════════════════════
#  MAIN ORCHESTRATOR
# ═══════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(description="AI Monthly Insight Report")
    parser.add_argument("--month", help="Target month YYYY-MM (default: previous month)")
    parser.add_argument("--dry-run", action="store_true", help="Print email, don't send")
    parser.add_argument("--always-email", action="store_true", help="Send even if no data")
    parser.add_argument("--lookback-months", type=int, default=6, help="Months for trend")
    parser.add_argument("--test", action="store_true", help="Run with synthetic data")
    args = parser.parse_args()

    log("═══ AI Monthly Insight Report ═══")

    # ─── Test mode ───
    if args.test:
        log("Running in TEST mode with synthetic data")
        year, month, dakoku, ot_requests = generate_test_data()
        month_str = f"{year}-{month:02d}"
        stats = compute_month_stats(month_str, dakoku, ot_requests)
        trend = compute_trend([
            {"ot_hours": 60, "gross_jpy": 140000},
            {"ot_hours": 65, "gross_jpy": 155000},
            stats,
        ])
        prose = generate_ai_prose(stats, trend)
        html = compose_email_html(month_str, stats, trend, prose)
        print("\n══ STATS ══")
        print(json.dumps(stats, indent=2, ensure_ascii=False))
        print("\n══ TREND ══")
        print(json.dumps(trend, indent=2))
        print("\n══ AI PROSE ══")
        print(prose)
        print(f"\n══ EMAIL HTML ({len(html)} chars) ══")
        print(html[:500] + "...")
        log("✅ Test completed successfully")
        sys.exit(0)

    # ─── Determine target month ───
    if args.month:
        month_str = args.month
        year, month = int(month_str[:4]), int(month_str[5:7])
    else:
        now = datetime.now(JST)
        first = now.replace(day=1)
        prev = first - timedelta(days=1)
        year, month = prev.year, prev.month
        month_str = f"{year}-{month:02d}"

    log(f"Target month: {month_str}")

    # ─── Authenticate ───
    refresh_token = os.environ.get("AZURE_REFRESH_TOKEN")
    if not refresh_token:
        log("❌ AZURE_REFRESH_TOKEN not set")
        if not args.always_email:
            log("No data available and --always-email not set. Exiting.")
            sys.exit(0)
        # Continue with empty data if always-email
        dakoku = []
        dokokin_token = None
    else:
        try:
            log("Refreshing Azure AD token...")
            azure_token, new_refresh = refresh_azure_token(refresh_token)
            # Phase 3 hardening: queue rotation; token-monitor drains centrally.
            if new_refresh != refresh_token:
                print(f"::add-mask::{new_refresh}")
                try:
                    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
                    from pending_rotation import write_pending  # noqa: E402
                    gh_pat = os.environ.get("GH_PAT") or os.environ.get("GH_TOKEN")
                    if gh_pat:
                        write_pending(new_refresh, source="ai_monthly_insight", gh_pat=gh_pat)
                        log("🔄 Refresh token rotated; queued for centralized rotation.")
                    else:
                        log("⚠️ Refresh token rotated but GH_PAT missing — cannot queue.")
                except Exception as _e:
                    log(f"⚠️ Failed to queue pending rotation (non-fatal): {_e}")
                gh_output = os.environ.get("GITHUB_OUTPUT")
                if gh_output:
                    with open(gh_output, "a") as f:
                        f.write("token_rotated=true\n")

            log("Exchanging for DokoKin token...")
            dokokin_token = get_dokokin_token(azure_token)
            log("✅ Authentication successful")
        except Exception as e:
            log(f"❌ Authentication failed: {e}")
            if not args.always_email:
                sys.exit(0)
            dakoku = []
            dokokin_token = None

    # ─── Load data ───
    if dokokin_token:
        log(f"Loading dakoku records for {month_str}...")
        dakoku = load_dakoku_month(dokokin_token, year, month)
        log(f"Loaded {sum(1 for r in dakoku if r['startWorkingTime'])} working days")
    else:
        dakoku = []

    ot_requests = load_ot_requests_for_month(year, month)
    log(f"Loaded {len(ot_requests)} OT requests for {month_str}")

    # ─── Compute stats ───
    stats = compute_month_stats(month_str, dakoku, ot_requests)

    if stats["total_hours"] == 0 and stats["ot_entry_count"] == 0 and not args.always_email:
        log("No data for this month. Use --always-email to send anyway. Exiting.")
        sys.exit(0)

    # ─── Load history for trend ───
    log(f"Loading {args.lookback_months} months history for trend analysis...")
    try:
        from payslip_history import load_months
        history = load_months(n=args.lookback_months - 1, end_month=month_str)
    except Exception as e:
        log(f"⚠️ History load failed: {e}")
        history = []

    # Add current month to history for trend computation
    all_months = history + [stats]
    trend = compute_trend(all_months)
    log(f"Trend: {trend['direction']} ({trend['pace_delta_pct']:+.1f}%)")

    # ─── AI prose ───
    log("Generating AI insights...")
    ai_prose = generate_ai_prose(stats, trend)

    # ─── Compose email ───
    net = stats.get("estimated_net_jpy", 0)
    ot_h = stats.get("ot_hours", 0)
    subject = f"📊 Monthly Insight {month_str} — ¥{net:,} net, {ot_h:.0f}h OT"
    html = compose_email_html(month_str, stats, trend, ai_prose)
    log(f"Email composed: {len(html)} chars")

    # ─── Send or print ───
    if args.dry_run:
        log("DRY RUN — printing email body:")
        print("\n" + "═" * 60)
        print(f"Subject: {subject}")
        print("═" * 60)
        print(html)
    else:
        send_email(subject, html)

    # ─── Persist to Gist ───
    if not args.dry_run:
        persist_to_gist(month_str, stats, trend, ai_prose)

    log("═══ Done ═══")
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        log(f"❌ Unhandled error: {e}")
        traceback.print_exc()
        sys.exit(0)  # Always exit 0 per spec
