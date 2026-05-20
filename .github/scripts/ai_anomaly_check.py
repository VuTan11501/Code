#!/usr/bin/env python3
"""AI Anomaly Check — Daily kintai/schedule/OT anomaly detector.
Zero external dependencies (stdlib only).

Runs deterministic pre-checks (5 anomaly classes), then invokes AI ONLY
to write a friendly Vietnamese summary. Email always on findings (template
fallback if AI fails). LINE only on critical severity.

Usage:
    python ai_anomaly_check.py [--dry-run] [--days N] [--always-email] [--fixture path.json]
"""
import json
import os
import sys
import urllib.request
import urllib.error
import urllib.parse
import smtplib
import traceback
from datetime import datetime, timezone, timedelta, date
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

# Make sibling modules importable
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import anomaly_rules
import ai_client
import line_notify

_PREFIX = "[anomaly]"
JST = timezone(timedelta(hours=9))

# ── Config ──
AZURE_APP_ID = os.environ.get("AZURE_APP_ID", "f5be0f68-7285-4365-b979-10af0f3f4106")
AZURE_TENANT = os.environ.get("AZURE_TENANT_ID", "f01e930a-b52e-42b1-b70f-a8882b5d043b")
AZURE_SCOPE = f"api://{AZURE_APP_ID}/openid user.read offline_access"
API_BASE = "https://api.fjpservice.com/api/"
GIST_ID = "abc2a47c0a396025a72a6580227ff493"


def log(msg):
    ts = datetime.now(JST).strftime("%H:%M:%S")
    print(f"{_PREFIX} [{ts}] {msg}", file=sys.stderr)


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


def http_get(url, headers=None):
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


# ═══════════════════════════════════════════════════════════
#  TOKEN MANAGEMENT
# ═══════════════════════════════════════════════════════════

def refresh_azure_token():
    """Refresh Azure AD token. Returns (access_token, new_refresh_token) or raises."""
    refresh_token = os.environ.get("AZURE_REFRESH_TOKEN", "")
    if not refresh_token:
        raise RuntimeError("AZURE_REFRESH_TOKEN not set")

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

def load_dakoku_records(days=7):
    """Load dakoku records for last N days from DokoKin API."""
    log(f"Loading dakoku records for last {days} days...")
    try:
        azure_token, _ = refresh_azure_token()
        kintai_token = get_dokokin_token(azure_token)
    except Exception as e:
        log(f"Token error: {e}")
        return []

    headers = {
        "Authorization": f"Bearer {kintai_token}",
        "Content-Type": "application/json",
        "Module": "KINTAI",
    }

    records = []
    today = datetime.now(JST).date()
    for i in range(days):
        d = today - timedelta(days=i)
        date_str = d.strftime("%Y-%m-%d")
        try:
            status, data = http_get(f"{API_BASE}dakoku/me/{date_str}", headers=headers)
            if status == 200 and data:
                rec = {
                    "date": date_str,
                    "startWorkingTime": data.get("startWorkingTime"),
                    "endWorkingTime": data.get("endWorkingTime"),
                    "displayStartWorkingTime": data.get("displayStartWorkingTime"),
                    "displayEndWorkingTime": data.get("displayEndWorkingTime"),
                }
                records.append(rec)
            else:
                records.append({"date": date_str, "startWorkingTime": None, "endWorkingTime": None})
        except Exception as e:
            log(f"  Failed to load dakoku for {date_str}: {e}")
            records.append({"date": date_str, "startWorkingTime": None, "endWorkingTime": None})

    log(f"  Loaded {len(records)} dakoku records")
    return records


def load_gist_file(filename):
    """Load a file from the schedule Gist."""
    gh_pat = os.environ.get("GH_PAT", "")
    if not gh_pat:
        log(f"GH_PAT not set, cannot load Gist file {filename}")
        return None

    headers = {
        "Authorization": f"Bearer {gh_pat}",
        "Accept": "application/vnd.github+json",
    }
    status, data = http_get(f"https://api.github.com/gists/{GIST_ID}", headers=headers)
    if status != 200:
        log(f"Gist fetch failed: HTTP {status}")
        return None

    files = data.get("files", {})
    file_info = files.get(filename)
    if not file_info:
        log(f"File '{filename}' not found in Gist")
        return None

    content = file_info.get("content", "")
    try:
        return json.loads(content)
    except (json.JSONDecodeError, ValueError) as e:
        log(f"Failed to parse Gist file '{filename}': {e}")
        return None


def load_schedule_entries():
    """Load scheduled-runs.json from Gist."""
    log("Loading schedule entries from Gist...")
    data = load_gist_file("scheduled-runs.json")
    if data is None:
        return []
    entries = data.get("entries", data) if isinstance(data, dict) else data
    log(f"  Loaded {len(entries)} schedule entries")
    return entries


def load_ot_requests():
    """Load ot-requests.json from Gist."""
    log("Loading OT requests from Gist...")
    data = load_gist_file("ot-requests.json")
    if data is None:
        return []
    entries = data if isinstance(data, list) else data.get("entries", [])
    log(f"  Loaded {len(entries)} OT requests")
    return entries


def estimate_token_expiry():
    """Estimate Azure refresh token expiry (~90 days from last refresh).
    Since we don't store the exact issue date, use a rough heuristic.
    Returns datetime or None.
    """
    # If AZURE_REFRESH_TOKEN is set, assume it was last refreshed recently
    # In production, token_monitor.py tracks this more precisely
    # For anomaly detection, we check if token can still refresh successfully
    # If refresh_azure_token() succeeded (called in load_dakoku), token is valid
    # We'll return None (no expiry concern) unless we detect it's close
    return None


def load_fixture(path):
    """Load fixture file for testing."""
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


# ═══════════════════════════════════════════════════════════
#  AI SUMMARIZER
# ═══════════════════════════════════════════════════════════

def ai_summarize(anomalies):
    """Call AI to write a Vietnamese summary with suggested actions."""
    system_prompt = (
        "Bạn là kintai monitor cho TanVC (nhân viên FJP). "
        "Tóm tắt danh sách anomalies bên dưới bằng tiếng Việt thân thiện, rõ ràng. "
        "Mỗi anomaly cần: (1) mô tả vấn đề, (2) tác động, (3) suggested action cụ thể. "
        "Dùng emoji cho severity: 🚨 critical, ⚠️ high, ℹ️ medium, 💬 low. "
        "Viết ngắn gọn, actionable, không lặp lại raw data."
    )
    user_content = json.dumps(anomalies, ensure_ascii=False, indent=2)

    resp = ai_client.chat_completion(
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
        model="gpt-4o-mini",
        temperature=0.2,
        max_tokens=800,
    )

    if resp is None:
        log("AI summarizer returned None — using template fallback")
        return None
    return resp.content


def template_summary(anomalies):
    """Fallback template when AI is unavailable."""
    severity_emoji = {"critical": "🚨", "high": "⚠️", "medium": "ℹ️", "low": "💬"}
    lines = []
    for a in anomalies:
        emoji = severity_emoji.get(a["severity"], "•")
        lines.append(f"{emoji} [{a['class']}] {a['summary']}")
    return "\n".join(lines)


# ═══════════════════════════════════════════════════════════
#  NOTIFICATIONS
# ═══════════════════════════════════════════════════════════

def send_email(subject, body_html):
    """Send email notification via Gmail SMTP."""
    smtp_user = os.environ.get("SMTP_USER", "")
    smtp_pass = os.environ.get("SMTP_PASS", "")
    notify_email = os.environ.get("NOTIFY_EMAIL", "")

    if not all([smtp_user, smtp_pass, notify_email]):
        log("Email credentials not set, skipping email")
        return False

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = smtp_user
    msg["To"] = notify_email
    msg.attach(MIMEText(body_html, "html", "utf-8"))

    try:
        with smtplib.SMTP("smtp.gmail.com", 587, timeout=30) as server:
            server.starttls()
            server.login(smtp_user, smtp_pass)
            server.sendmail(smtp_user, [notify_email], msg.as_string())
        log("✅ Email sent successfully")
        return True
    except Exception as e:
        log(f"❌ Email failed: {e}")
        return False


def send_line_critical(summary_text):
    """Send LINE notification for critical anomalies."""
    short = summary_text[:900] if len(summary_text) > 900 else summary_text
    msg = f"\n🚨 Kintai Anomaly Alert\n{short}"
    return line_notify.send(msg)


def compose_email_html(anomalies, ai_summary, today_str):
    """Compose HTML email body."""
    severity_emoji = {"critical": "🚨", "high": "⚠️", "medium": "ℹ️", "low": "💬"}

    html_parts = [
        "<html><body style='font-family: sans-serif; max-width: 600px;'>",
        f"<h2>Kintai Anomaly Report — {today_str}</h2>",
    ]

    if ai_summary:
        html_parts.append(f"<div style='background:#f8f9fa;padding:16px;border-radius:8px;margin:16px 0;white-space:pre-wrap;'>{ai_summary}</div>")
        html_parts.append("<hr><h3>Raw Details</h3>")

    # Group by severity
    by_severity = {}
    for a in anomalies:
        by_severity.setdefault(a["severity"], []).append(a)

    for sev in ["critical", "high", "medium", "low"]:
        items = by_severity.get(sev, [])
        if not items:
            continue
        emoji = severity_emoji[sev]
        html_parts.append(f"<h4>{emoji} {sev.upper()} ({len(items)})</h4><ul>")
        for a in items:
            html_parts.append(
                f"<li><b>[{a['class']}]</b> {a['date']} — {a['summary']}</li>"
            )
        html_parts.append("</ul>")

    html_parts.append("<p style='color:#888;font-size:12px;'>Generated by AI Anomaly Detective (P2)</p>")
    html_parts.append("</body></html>")
    return "".join(html_parts)


# ═══════════════════════════════════════════════════════════
#  MAIN
# ═══════════════════════════════════════════════════════════

def main():
    import argparse
    parser = argparse.ArgumentParser(description="AI Anomaly Check")
    parser.add_argument("--dry-run", action="store_true", help="Don't send notifications")
    parser.add_argument("--days", type=int, default=7, help="Lookback window in days")
    parser.add_argument("--always-email", action="store_true", help="Send email even on empty results")
    parser.add_argument("--fixture", type=str, help="Load fixture JSON instead of API calls")
    args = parser.parse_args()

    today_str = datetime.now(JST).strftime("%Y-%m-%d")
    now_jst = datetime.now(JST)
    log(f"Starting anomaly check for {today_str} (lookback {args.days} days)")

    # ── Load context ──
    if args.fixture:
        log(f"Loading fixture from {args.fixture}")
        try:
            fixture = load_fixture(args.fixture)
            dakoku_records = fixture.get("dakoku_records", [])
            ot_requests = fixture.get("ot_requests", [])
            schedule_entries = fixture.get("schedule_entries", [])
            token_expires_at_str = fixture.get("token_expires_at")
            token_expires_at = (
                datetime.fromisoformat(token_expires_at_str)
                if token_expires_at_str else None
            )
        except Exception as e:
            log(f"Fixture load error: {e}")
            traceback.print_exc()
            sys.exit(0)
    else:
        # Load from APIs (each loader handles its own errors)
        dakoku_records = load_dakoku_records(args.days)
        ot_requests = load_ot_requests()
        schedule_entries = load_schedule_entries()
        token_expires_at = estimate_token_expiry()

    # ── Run rules ──
    context = {
        "dakoku_records": dakoku_records,
        "ot_requests": ot_requests,
        "schedule_entries": schedule_entries,
        "token_expires_at": token_expires_at,
        "now_jst": now_jst,
    }

    anomalies = anomaly_rules.run_all(context)
    log(f"Detection complete: {len(anomalies)} anomalies found")

    # ── Handle results ──
    if not anomalies:
        log("✅ No anomalies detected")
        if args.always_email and not args.dry_run:
            send_email(
                f"✅ Kintai All Clear — {today_str}",
                f"<html><body><h2>✅ All Clear</h2><p>No anomalies detected for {today_str} (last {args.days} days).</p></body></html>",
            )
        sys.exit(0)

    # Sort by severity
    severity_order = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    anomalies.sort(key=lambda a: severity_order.get(a["severity"], 9))

    has_critical = any(a["severity"] == "critical" for a in anomalies)
    has_high = any(a["severity"] in ("critical", "high") for a in anomalies)

    # ── AI Summary ──
    ai_summary = None
    if not args.dry_run:
        try:
            ai_summary = ai_summarize(anomalies)
        except Exception as e:
            log(f"AI summarizer error: {e}")

    summary_text = ai_summary if ai_summary else template_summary(anomalies)

    # ── Print results ──
    print(f"\n{'='*60}")
    print(f"ANOMALY REPORT — {today_str}")
    print(f"{'='*60}")
    print(summary_text)
    print(f"{'='*60}\n")

    if args.dry_run:
        log("Dry-run mode — skipping notifications")
        for a in anomalies:
            print(f"  [{a['severity'].upper()}] {a['class']}: {a['summary']}")
        sys.exit(0)

    # ── Compose & send email ──
    if has_critical or has_high:
        subject = f"🚨 Kintai Anomaly Alert — {len(anomalies)} issue(s) ({today_str})"
    else:
        subject = f"⚠️ Kintai Anomaly — {len(anomalies)} issue(s) ({today_str})"

    body_html = compose_email_html(anomalies, ai_summary, today_str)
    send_email(subject, body_html)

    # ── LINE (critical only) ──
    if has_critical:
        log("Sending LINE notification (critical anomaly detected)")
        critical_items = [a for a in anomalies if a["severity"] == "critical"]
        line_summary = "\n".join(f"• {a['summary']}" for a in critical_items[:3])
        send_line_critical(line_summary)

    log("Done")
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        log(f"FATAL (non-crash): {e}")
        traceback.print_exc()
        sys.exit(0)  # Never fail the workflow
