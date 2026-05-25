#!/usr/bin/env python3
"""Monitor Azure AD token health for DokoKin.

Refreshes the Azure AD token, exchanges for a KINTAI token, makes a test
API call, and (optionally with --gist) writes a structured status JSON to
the shared Gist so the dashboard can display it.

Requires: AZURE_REFRESH_TOKEN env var. For --gist also requires GH_TOKEN
or GH_PAT with `gist` scope. Zero external deps (stdlib only).
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

JST = timezone(timedelta(hours=9))

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from user_config import GIST_ID, API_BASE, AZURE_APP_ID, AZURE_TENANT  # noqa: E402

AZURE_SCOPE = f"api://{AZURE_APP_ID}/openid user.read offline_access"
STATUS_FILE = "token-status.json"


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
    """Decode JWT payload without verification (for expiry/user info only)."""
    import base64
    parts = token.split(".")
    if len(parts) != 3:
        return None
    payload = parts[1]
    payload += "=" * (4 - len(payload) % 4)
    try:
        decoded = base64.urlsafe_b64decode(payload)
        return json.loads(decoded)
    except Exception:
        return None


def write_status_to_gist(status):
    """PATCH the shared Gist with current token status JSON."""
    token = os.environ.get("GH_TOKEN") or os.environ.get("GH_PAT")
    if not token:
        print("  (skip gist write: GH_TOKEN/GH_PAT not set)")
        return
    url = f"https://api.github.com/gists/{GIST_ID}"
    payload = json.dumps({
        "files": {STATUS_FILE: {"content": json.dumps(status, indent=2, ensure_ascii=False)}}
    }).encode()
    req = urllib.request.Request(url, data=payload, method="PATCH")
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            print(f"  ✅ Gist updated ({resp.status}): {STATUS_FILE}")
    except Exception as e:
        print(f"  ⚠️ Gist update failed: {e}")


def load_existing_status():
    """Read previous status from Gist to preserve last_rotation_at across runs."""
    token = os.environ.get("GH_TOKEN") or os.environ.get("GH_PAT")
    if not token:
        return {}
    url = f"https://api.github.com/gists/{GIST_ID}"
    req = urllib.request.Request(url)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Accept", "application/vnd.github+json")
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read())
            content = (data.get("files", {}).get(STATUS_FILE, {}) or {}).get("content")
            return json.loads(content) if content else {}
    except Exception:
        return {}


def main():
    write_gist = "--gist" in sys.argv
    now = datetime.now(JST)
    prev = load_existing_status() if write_gist else {}

    status = {
        "checked_at": now.isoformat(),
        "status": "error",
        "user": None,
        "access_token_expires_at": None,
        "refresh_token_rotated": False,
        "last_rotation_at": prev.get("last_rotation_at"),
        "error": None,
    }

    def finish(exit_code=0):
        if write_gist:
            print()
            print("Writing status to Gist...")
            write_status_to_gist(status)
        sys.exit(exit_code)

    print(f"=== Token Health Monitor ===")
    print(f"Time: {now.strftime('%Y-%m-%d %H:%M JST')}")
    print()

    refresh_token = os.environ.get("AZURE_REFRESH_TOKEN")
    if not refresh_token:
        print("CRITICAL: AZURE_REFRESH_TOKEN not set!")
        status["status"] = "missing"
        status["error"] = "AZURE_REFRESH_TOKEN secret not set"
        finish(1)

    # Step 1: Refresh Azure AD token
    print("Step 1: Refreshing Azure AD token...")
    st, data = http_post(
        f"https://login.microsoftonline.com/{AZURE_TENANT}/oauth2/v2.0/token",
        data={
            "client_id": AZURE_APP_ID,
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "scope": AZURE_SCOPE,
        },
    )

    if st != 200:
        error_desc = data.get("error_description", data.get("error", "unknown"))
        print(f"CRITICAL: Azure AD token refresh failed (HTTP {st})")
        print(f"  Error: {error_desc}")
        if "AADSTS700082" in str(error_desc):
            print("  → Refresh token has EXPIRED (>90 days)")
            status["status"] = "expired"
        elif "AADSTS50173" in str(error_desc):
            print("  → Refresh token has been REVOKED")
            status["status"] = "revoked"
        else:
            status["status"] = "error"
        status["error"] = str(error_desc)[:500]
        finish(1)

    azure_token = data.get("access_token", "")
    new_refresh = data.get("refresh_token", "")
    print("  ✅ Azure AD token refresh successful")

    # Decode JWT for expiry + user info
    payload = decode_jwt_payload(azure_token)
    if payload:
        if "exp" in payload:
            exp_dt = datetime.fromtimestamp(payload["exp"], tz=JST)
            status["access_token_expires_at"] = exp_dt.isoformat()
            print(f"  Access token expires: {exp_dt.strftime('%Y-%m-%d %H:%M JST')}")
        user = {
            "name": payload.get("name") or payload.get("given_name"),
            "email": payload.get("upn") or payload.get("preferred_username") or payload.get("email"),
            "oid": payload.get("oid"),
        }
        status["user"] = user
        if user.get("name") or user.get("email"):
            print(f"  User: {user.get('name')} <{user.get('email')}>")

    # Step 2: Exchange for KINTAI token
    print()
    print("Step 2: Exchanging for KINTAI token...")
    st, data = http_post(
        API_BASE + "token",
        data={"module": "KINTAI", "grant_type": "azure_ad_token", "token": azure_token},
    )

    if st != 200 or not data.get("access_token"):
        print(f"WARNING: KINTAI token exchange failed (HTTP {st})")
        print(f"  Response: {data}")
        status["status"] = "error"
        status["error"] = f"KINTAI token exchange failed: HTTP {st}"
        finish(1)

    kintai_token = data["access_token"]
    print("  ✅ KINTAI token exchange successful")

    # Step 3: Test API call (today's dakoku)
    print()
    print("Step 3: Testing API call (dakoku status)...")
    today_str = now.date().isoformat()
    st, data = http_get(
        API_BASE + f"dakoku/me/{today_str}",
        headers={"Authorization": f"Bearer {kintai_token}", "Module": "KINTAI"},
    )

    if st == 401:
        print(f"CRITICAL: API returned 401 Unauthorized")
        status["status"] = "error"
        status["error"] = "KINTAI API returned 401"
        finish(1)
    elif st == 200:
        ci = data.get("displayStartWorkingTime") or data.get("startWorkingTime")
        co = data.get("displayEndWorkingTime") or data.get("endWorkingTime")
        print(f"  ✅ API call successful (CI: {ci or '—'}, CO: {co or '—'})")
    else:
        print(f"  ⚠️ API returned HTTP {st} (non-critical)")

    # Step 4: Refresh-token rotation
    if new_refresh and new_refresh != refresh_token:
        print()
        print("⚠️ Refresh token was ROTATED by Azure AD")
        status["refresh_token_rotated"] = True
        status["last_rotation_at"] = now.isoformat()
        out = os.environ.get("GITHUB_OUTPUT")
        if out:
            print(f"::add-mask::{new_refresh}")
            with open(out, "a") as f:
                f.write("token_rotated=true\n")
                f.write(f"new_refresh_token={new_refresh}\n")

    status["status"] = "healthy"
    print()
    print("=== Token Health: ✅ HEALTHY ===")
    finish(0)


if __name__ == "__main__":
    main()
