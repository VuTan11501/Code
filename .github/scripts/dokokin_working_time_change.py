#!/usr/bin/env python3
"""
Worker: submit working time change (勤務時間変更) request to DokoKin.
Triggered by timesheet-action.yml dispatch when user submits form.

Zero external dependencies (stdlib only).
"""
import os
import sys
import json
import urllib.request
import urllib.parse
from datetime import datetime, timezone, timedelta
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
import smtplib
import logging


def gha_output(name, value):
    """Write a GitHub Actions step output (modern $GITHUB_OUTPUT file API;
    the old `::set-output` workflow command was disabled by GitHub in 2023)."""
    gh_output_path = os.getenv("GITHUB_OUTPUT")
    if not gh_output_path:
        return
    with open(gh_output_path, "a", encoding="utf-8") as f:
        f.write(f"{name}={value}\n")

# Make sibling modules importable
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from user_config import (  # noqa: E402
    EMPLOYEE_ID, API_BASE, AZURE_APP_ID, AZURE_TENANT,
)

JST = timezone(timedelta(hours=9))

AZURE_SCOPE = f"api://{AZURE_APP_ID}/openid user.read offline_access"

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s'
)
log = logging.getLogger(__name__)

# HTTP utility
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


def get_dakoku_record(token, date_str):
    """GET current dakoku record for a date."""
    status, data = http_get(
        API_BASE + f"dakoku/me/{date_str}",
        headers={"Authorization": f"Bearer {token}", "Module": "KINTAI"},
    )
    if status != 200:
        raise RuntimeError(f"Failed to fetch dakoku record for {date_str}: {data}")
    return data


def update_working_time(token, payload):
    """
    Submit working time change request to DokoKin.
    
    Endpoint: POST https://api.fjpservice.com/api/dakoku/{date}/working-time
    
    Payload:
    {
      "date": "2026-10-11",
      "original_end_time": "23:00",
      "new_end_time": "02:30",
      "new_end_next_day": true,
      "reason": "OT not yet reflected in timesheet",
      "employee_id": "8883"
    }
    """
    date = payload.get("date")
    status, data = http_post(
        API_BASE + f"dakoku/{date}/working-time",
        json_data=payload,
        headers={"Authorization": f"Bearer {token}", "Module": "KINTAI"},
    )
    if status not in (200, 201):
        raise RuntimeError(f"Working time change failed ({status}): {data}")
    return data


def send_email(subject, body_html, employee_id):
    """Send notification email via SMTP."""
    smtp_user = os.getenv("SMTP_USER", "")
    smtp_pass = os.getenv("SMTP_PASS", "")
    notify_email = os.getenv("NOTIFY_EMAIL", "")

    if not smtp_user or not smtp_pass or not notify_email:
        log.info("⚠️ Email credentials missing; skipping notification")
        return

    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = smtp_user
        msg["To"] = notify_email

        msg.attach(MIMEText(body_html, "html", "utf-8"))

        with smtplib.SMTP("smtp.gmail.com", 587) as server:
            server.starttls()
            server.login(smtp_user, smtp_pass)
            server.sendmail(smtp_user, notify_email, msg.as_string())
        log.info(f"✅ Email sent to {notify_email}")
    except Exception as e:
        log.info(f"❌ Email send failed: {e}")


def main():
    """Main entry point."""
    # Read env inputs from workflow
    date = os.getenv("INPUT_DATE", "")
    original_end = os.getenv("INPUT_ORIGINAL_END", "")
    new_end_time = os.getenv("INPUT_NEW_END_TIME", "")
    new_end_next_day_str = os.getenv("INPUT_NEW_END_NEXT_DAY", "false")
    reason = os.getenv("INPUT_REASON", "")
    employee_id = os.getenv("EMPLOYEE_ID", EMPLOYEE_ID)
    refresh_token = os.getenv("AZURE_REFRESH_TOKEN", "")

    new_end_next_day = new_end_next_day_str.lower() in ("true", "1", "yes")

    if not date:
        log.info("❌ INPUT_DATE is required")
        return 1

    if not new_end_time:
        log.info("❌ INPUT_NEW_END_TIME is required")
        return 1

    log.info("=" * 60)
    log.info("DokoKin Working Time Change Request")
    log.info("=" * 60)
    log.info(f"Date: {date}")
    log.info(f"Original end time: {original_end}")
    log.info(f"New end time: {new_end_time}")
    log.info(f"Next day: {new_end_next_day}")
    log.info(f"Reason: {reason}")
    log.info(f"Employee ID: {employee_id}")

    try:
        # Step 1: Refresh Azure token
        log.info("\n[1/5] Refreshing Azure AD token...")
        if not refresh_token:
            log.info("❌ AZURE_REFRESH_TOKEN not set")
            return 1

        access_token, new_refresh = refresh_azure_token(refresh_token)
        log.info("✅ Azure token obtained")

        # Step 2: Exchange for DokoKin token
        log.info("\n[2/5] Exchanging for DokoKin token...")
        dokokin_token = get_dokokin_token(access_token)
        log.info("✅ DokoKin token obtained")

        # Step 3: Fetch current dakoku record for validation
        log.info(f"\n[3/5] Fetching current dakoku record for {date}...")
        current = get_dakoku_record(dokokin_token, date)
        log.info(f"✅ Current record: {json.dumps(current, ensure_ascii=False, indent=2)}")

        # Prefer the server's own recorded checkout time over whatever the
        # frontend sent (it may not have sent one at all), so the payload
        # always reflects the real original_end_time.
        server_original_end = current.get("displayEndWorkingTime") or ""
        if server_original_end:
            original_end = server_original_end

        # Step 4: Submit working time change
        log.info("\n[4/5] Submitting working time change request...")
        payload = {
            "date": date,
            "original_end_time": original_end,
            "new_end_time": new_end_time,
            "new_end_next_day": new_end_next_day,
            "reason": reason,
            "employee_id": employee_id,
        }

        result = update_working_time(dokokin_token, payload)
        log.info(f"✅ Working time changed successfully")
        log.info(f"   Response: {json.dumps(result, ensure_ascii=False, indent=2)}")

        # Step 5: Return output for workflow
        new_hours = result.get("new_working_hours", 0)
        new_gross = result.get("new_gross_yen", 0)

        log.info("\n" + "=" * 60)
        log.info(f"✅ SUCCESS")
        log.info(f"New working hours: {new_hours}h")
        log.info(f"Estimated gross: ¥{new_gross:,}" if isinstance(new_gross, int) else f"¥{new_gross}")
        log.info("=" * 60)

        # GitHub Actions outputs
        gha_output("status", "success")
        gha_output("new_hours", new_hours)
        gha_output("new_gross", new_gross)

        # Send email notification
        body_html = f"""
        <html>
          <body style="font-family: sans-serif; color: #333;">
            <h2>✅ Working Time Change Submitted</h2>
            <p><strong>Date:</strong> {date}</p>
            <p><strong>Original end time:</strong> {original_end}</p>
            <p><strong>New end time:</strong> {new_end_time}</p>
            <p><strong>Next day:</strong> {"Yes" if new_end_next_day else "No"}</p>
            <p><strong>Reason:</strong> {reason}</p>
            <hr />
            <p><strong>New working hours:</strong> {new_hours}h</p>
            <p><strong>Estimated gross:</strong> ¥{new_gross:,}</p>
            <p style="color: #666; font-size: 0.9em; margin-top: 20px;">
              Actual amount depends on payroll rules & deductions.<br />
              Submit before payroll cutoff (usually 15th).
            </p>
          </body>
        </html>
        """
        send_email("✅ DokoKin Working Time Change", body_html, employee_id)

        return 0

    except Exception as e:
        log.info(f"\n❌ ERROR: {e}")
        log.info(f"Traceback: {repr(e)}")

        # GitHub Actions outputs
        gha_output("status", "error")
        gha_output("error", str(e))

        # Send error email
        body_html = f"""
        <html>
          <body style="font-family: sans-serif; color: #333;">
            <h2>❌ Working Time Change Failed</h2>
            <p><strong>Date:</strong> {date}</p>
            <p><strong>New end time:</strong> {new_end_time}</p>
            <hr />
            <p><strong>Error:</strong> {str(e)}</p>
            <p style="color: #666; font-size: 0.9em; margin-top: 20px;">
              Please check the workflow logs for details:<br />
              <code>{os.getenv("GITHUB_SERVER_URL")}/{os.getenv("GITHUB_REPOSITORY")}/actions/runs/{os.getenv("GITHUB_RUN_ID")}</code>
            </p>
          </body>
        </html>
        """
        send_email("❌ DokoKin Working Time Change Failed", body_html, employee_id)

        return 1


if __name__ == "__main__":
    sys.exit(main())
