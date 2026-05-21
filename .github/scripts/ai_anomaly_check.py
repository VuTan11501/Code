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
    """Compose HTML email body — modern, mobile-first, Gmail-safe.

    Design rules:
      - Inline CSS only (no <style> tag — Gmail strips them inconsistently).
      - Outer table for centering (Outlook hates flex/grid).
      - System font stack, 16px base, max-width 640px.
      - Color-coded severity chips matching the dashboard palette
        (zinc base, red/amber/blue/slate accents).
      - Pre-header text for inbox preview.
    """
    severity_meta = {
        "critical": {"emoji": "🚨", "label": "Critical", "bg": "#fef2f2", "border": "#fecaca",
                     "fg": "#991b1b", "chip_bg": "#dc2626", "chip_fg": "#ffffff"},
        "high":     {"emoji": "⚠️", "label": "High",     "bg": "#fffbeb", "border": "#fde68a",
                     "fg": "#92400e", "chip_bg": "#d97706", "chip_fg": "#ffffff"},
        "medium":   {"emoji": "ℹ️",  "label": "Medium",   "bg": "#eff6ff", "border": "#bfdbfe",
                     "fg": "#1e40af", "chip_bg": "#2563eb", "chip_fg": "#ffffff"},
        "low":      {"emoji": "💬", "label": "Low",      "bg": "#f8fafc", "border": "#e2e8f0",
                     "fg": "#475569", "chip_bg": "#64748b", "chip_fg": "#ffffff"},
    }

    counts = {sev: 0 for sev in severity_meta}
    for a in anomalies:
        counts[a["severity"]] = counts.get(a["severity"], 0) + 1
    total = len(anomalies)
    has_critical = counts["critical"] > 0
    has_high = counts["high"] > 0

    # Header gradient depends on worst severity
    if has_critical:
        header_grad = "linear-gradient(135deg, #dc2626 0%, #991b1b 100%)"
        header_emoji = "🚨"
    elif has_high:
        header_grad = "linear-gradient(135deg, #f59e0b 0%, #b45309 100%)"
        header_emoji = "⚠️"
    elif total > 0:
        header_grad = "linear-gradient(135deg, #3b82f6 0%, #1e40af 100%)"
        header_emoji = "ℹ️"
    else:
        header_grad = "linear-gradient(135deg, #10b981 0%, #047857 100%)"
        header_emoji = "✅"

    pre_header = f"{total} anomaly/anomalies found ({today_str})" if total else f"All clear ({today_str})"

    # ── Severity counter pills (visible at top) ──
    pills_html = ""
    for sev in ("critical", "high", "medium", "low"):
        n = counts.get(sev, 0)
        if n == 0:
            continue
        m = severity_meta[sev]
        pills_html += (
            f'<span style="display:inline-block;background:{m["chip_bg"]};color:{m["chip_fg"]};'
            f'font-size:12px;font-weight:600;padding:4px 10px;border-radius:9999px;'
            f'margin:0 6px 6px 0;letter-spacing:.02em;">'
            f'{m["emoji"]} {m["label"]} · {n}</span>'
        )
    if not pills_html:
        pills_html = (
            '<span style="display:inline-block;background:#10b981;color:#fff;font-size:12px;'
            'font-weight:600;padding:4px 10px;border-radius:9999px;">✅ All clear</span>'
        )

    # ── AI summary card ──
    ai_card = ""
    if ai_summary:
        # Convert simple newlines to <br> while keeping HTML escaped
        from html import escape as _esc
        ai_html = _esc(ai_summary).replace("\n", "<br>")
        ai_card = f"""
        <tr><td style="padding:0 24px 8px 24px;">
          <div style="background:#fafafa;border:1px solid #e5e7eb;border-left:4px solid #6366f1;
                      border-radius:10px;padding:18px 20px;color:#1f2937;font-size:15px;
                      line-height:1.6;">
            <div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;
                        color:#6366f1;margin-bottom:8px;">✨ AI Summary</div>
            {ai_html}
          </div>
        </td></tr>"""

    # ── Anomaly cards grouped by severity ──
    by_severity = {}
    for a in anomalies:
        by_severity.setdefault(a["severity"], []).append(a)

    cards_html_parts = []
    for sev in ("critical", "high", "medium", "low"):
        items = by_severity.get(sev, [])
        if not items:
            continue
        m = severity_meta[sev]
        cards_html_parts.append(
            f'<tr><td style="padding:8px 24px 0 24px;">'
            f'<div style="font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;'
            f'color:{m["fg"]};margin:14px 0 8px 0;">{m["emoji"]} {m["label"]} · {len(items)}</div>'
            f'</td></tr>'
        )
        for a in items:
            cls = a.get("class", "?")
            ad = a.get("date", "")
            summary = a.get("summary", "")
            from html import escape as _esc
            cards_html_parts.append(f"""
            <tr><td style="padding:0 24px 10px 24px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
                     style="background:{m['bg']};border:1px solid {m['border']};border-radius:10px;">
                <tr>
                  <td style="padding:14px 16px;vertical-align:top;">
                    <div style="margin-bottom:6px;">
                      <span style="display:inline-block;background:{m['chip_bg']};color:{m['chip_fg']};
                                   font-size:11px;font-weight:700;padding:3px 8px;border-radius:6px;
                                   font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
                                   letter-spacing:.04em;">{_esc(cls)}</span>
                      <span style="color:#6b7280;font-size:13px;margin-left:8px;
                                   font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;">{_esc(ad)}</span>
                    </div>
                    <div style="color:#111827;font-size:14px;line-height:1.55;">{_esc(summary)}</div>
                  </td>
                </tr>
              </table>
            </td></tr>""")
    cards_html = "".join(cards_html_parts)

    # ── Action buttons ──
    repo = os.environ.get("GITHUB_REPOSITORY", "VuTan11501/Code")
    actions_url = f"https://github.com/{repo}/actions/workflows/ai-anomaly-check.yml"
    dashboard_url = f"https://{repo.split('/')[0]}.github.io/{repo.split('/')[1]}/"
    actions_row = f"""
    <tr><td style="padding:8px 24px 24px 24px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="padding-right:8px;">
            <a href="{dashboard_url}" style="display:inline-block;background:#111827;color:#ffffff;
               text-decoration:none;font-size:13px;font-weight:600;padding:10px 16px;border-radius:8px;">
               📊 Dashboard</a>
          </td>
          <td>
            <a href="{actions_url}" style="display:inline-block;background:#ffffff;color:#111827;
               text-decoration:none;font-size:13px;font-weight:600;padding:10px 16px;border-radius:8px;
               border:1px solid #d1d5db;">🔍 Workflow logs</a>
          </td>
        </tr>
      </table>
    </td></tr>"""

    title_text = f"{total} anomaly · Kintai" if total else "All clear · Kintai"
    summary_text = (
        f"{total} item{'s' if total != 1 else ''} found in last 7 days"
        if total else "No issues detected in last 7 days"
    )

    return f"""<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title_text} — {today_str}</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;
            font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;
            color:#111827;-webkit-font-smoothing:antialiased;">
<!-- pre-header (hidden) -->
<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:#f3f4f6;">{pre_header}</div>

<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f3f4f6;">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="640"
           style="max-width:640px;width:100%;background:#ffffff;border-radius:14px;
                  box-shadow:0 1px 3px rgba(0,0,0,.06),0 4px 12px rgba(0,0,0,.04);overflow:hidden;">

      <!-- Header -->
      <tr><td style="background:{header_grad};padding:28px 24px;color:#ffffff;">
        <div style="font-size:13px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;
                    opacity:.9;margin-bottom:6px;">Kintai Anomaly Report</div>
        <div style="font-size:26px;font-weight:700;line-height:1.2;margin-bottom:4px;">
          {header_emoji} {summary_text}
        </div>
        <div style="font-size:14px;opacity:.92;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;">
          {today_str} · JST
        </div>
      </td></tr>

      <!-- Severity pills row -->
      <tr><td style="padding:18px 24px 6px 24px;">{pills_html}</td></tr>

      {ai_card}

      {cards_html}

      {actions_row if total else ''}

      <!-- Footer -->
      <tr><td style="background:#fafafa;padding:14px 24px;border-top:1px solid #e5e7eb;
                     color:#6b7280;font-size:12px;line-height:1.5;">
        Generated by <b>AI Anomaly Detective</b> (Phase 2) ·
        deterministic rules + AI summary ·
        <a href="{actions_url}" style="color:#6366f1;text-decoration:none;">workflow logs</a>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>"""


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
                compose_email_html([], None, today_str),
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
