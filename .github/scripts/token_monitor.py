#!/usr/bin/env python3
"""Monitor Azure AD token health for DokoKin.

Makes a test API call to verify the token is still valid.
Exits with code 1 if the token is expired or unhealthy.

Requires: AZURE_REFRESH_TOKEN env var.
Zero external dependencies (stdlib only).
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

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


def decode_jwt_payload(token):
    """Decode JWT payload without verification (for expiry check only)."""
    import base64
    parts = token.split(".")
    if len(parts) != 3:
        return None
    payload = parts[1]
    # Fix padding
    payload += "=" * (4 - len(payload) % 4)
    try:
        decoded = base64.urlsafe_b64decode(payload)
        return json.loads(decoded)
    except Exception:
        return None


def main():
    now = datetime.now(JST)
    print(f"=== Token Health Monitor ===")
    print(f"Time: {now.strftime('%Y-%m-%d %H:%M JST')}")
    print()

    refresh_token = os.environ.get("AZURE_REFRESH_TOKEN")
    if not refresh_token:
        print("CRITICAL: AZURE_REFRESH_TOKEN not set!")
        sys.exit(1)

    # Step 1: Try to refresh the Azure AD token
    print("Step 1: Refreshing Azure AD token...")
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
        error_desc = data.get("error_description", data.get("error", "unknown"))
        print(f"CRITICAL: Azure AD token refresh failed (HTTP {status})")
        print(f"  Error: {error_desc}")
        print()
        if "AADSTS700082" in str(error_desc):
            print("  → Refresh token has EXPIRED (>90 days)")
            print("  → Action: Run `dokokin_auth_login` to re-authenticate")
        elif "AADSTS50173" in str(error_desc):
            print("  → Refresh token has been REVOKED")
            print("  → Action: Run `dokokin_auth_login` to re-authenticate")
        else:
            print("  → Action: Check Azure AD app registration and token")
        sys.exit(1)

    azure_token = data.get("access_token", "")
    new_refresh = data.get("refresh_token", "")
    print("  ✅ Azure AD token refresh successful")

    # Check JWT expiry of the access token
    payload = decode_jwt_payload(azure_token)
    if payload and "exp" in payload:
        exp_dt = datetime.fromtimestamp(payload["exp"], tz=JST)
        remaining = exp_dt - now
        print(f"  Access token expires: {exp_dt.strftime('%Y-%m-%d %H:%M JST')} ({remaining})")

    # Step 2: Exchange for KINTAI token
    print()
    print("Step 2: Exchanging for KINTAI token...")
    status, data = http_post(
        API_BASE + "token",
        data={"module": "KINTAI", "grant_type": "azure_ad_token", "token": azure_token},
    )

    if status != 200 or not data.get("access_token"):
        print(f"WARNING: KINTAI token exchange failed (HTTP {status})")
        print(f"  Response: {data}")
        print("  → The Azure AD token is valid but KINTAI API rejected it")
        sys.exit(1)

    kintai_token = data["access_token"]
    print("  ✅ KINTAI token exchange successful")

    # Step 3: Test API call (get today's dakoku status)
    print()
    print("Step 3: Testing API call (dakoku status)...")
    today_str = now.date().isoformat()
    status, data = http_get(
        API_BASE + f"dakoku/me/{today_str}",
        headers={"Authorization": f"Bearer {kintai_token}", "Module": "KINTAI"},
    )

    if status == 401:
        print(f"CRITICAL: API returned 401 Unauthorized")
        print("  → Token is expired or invalid")
        sys.exit(1)
    elif status == 200:
        ci = data.get("checkinDate") or data.get("checkinTime")
        co = data.get("checkoutDate") or data.get("checkoutTime")
        print(f"  ✅ API call successful (CI: {ci or '—'}, CO: {co or '—'})")
    else:
        print(f"  ⚠️ API returned HTTP {status} (non-critical)")
        print(f"  Response: {data}")

    # Step 4: Check if refresh token was rotated
    if new_refresh and new_refresh != refresh_token:
        print()
        print("⚠️ Refresh token was ROTATED by Azure AD")
        print("  → The AZURE_REFRESH_TOKEN secret needs updating")
        # Output for GitHub Actions to update the secret
        output_file = os.environ.get("GITHUB_OUTPUT")
        if output_file:
            print(f"::add-mask::{new_refresh}")
            with open(output_file, "a") as f:
                f.write(f"token_rotated=true\n")
                f.write(f"new_refresh_token={new_refresh}\n")

    print()
    print("=== Token Health: ✅ HEALTHY ===")


if __name__ == "__main__":
    main()
