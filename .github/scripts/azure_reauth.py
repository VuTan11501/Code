#!/usr/bin/env python3
"""Azure AD device-code re-auth flow for DokoKin (server-side).

Runs the OAuth2 device-code flow:
1. POST /devicecode to get user_code + verification_uri + device_code
2. Write code/uri to Gist (reauth-status.json) so dashboard can display
3. Poll /token with grant_type=device_code until user authenticates
4. On success: update GitHub secret AZURE_REFRESH_TOKEN via `gh secret set`
5. Re-run token monitor for fresh status

Requires env: AZURE_APP_ID (optional, has default), GH_TOKEN (gist+repo+actions),
GITHUB_REPOSITORY, GIST_ID. Zero external deps.
"""
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

JST = timezone(timedelta(hours=9))

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from user_config import GIST_ID, AZURE_APP_ID, AZURE_TENANT  # noqa: E402

AZURE_SCOPE = f"api://{AZURE_APP_ID}/openid user.read offline_access"

STATUS_FILE = "reauth-status.json"
REPO = os.environ["GITHUB_REPOSITORY"]
GH_TOKEN = os.environ["GH_TOKEN"]


def http_post(url, data, headers=None):
    body = urllib.parse.urlencode(data).encode()
    h = {"Content-Type": "application/x-www-form-urlencoded"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=body, headers=h, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        raw = e.read().decode(errors="replace")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"error": raw}


def gist_write(status):
    url = f"https://api.github.com/gists/{GIST_ID}"
    payload = json.dumps({
        "files": {STATUS_FILE: {"content": json.dumps(status, indent=2, ensure_ascii=False)}}
    }).encode()
    req = urllib.request.Request(url, data=payload, method="PATCH")
    req.add_header("Authorization", f"Bearer {GH_TOKEN}")
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            print(f"  → gist {STATUS_FILE} updated ({resp.status})")
    except Exception as e:
        print(f"  ⚠️ gist write failed: {e}")


def now_iso():
    return datetime.now(JST).isoformat()


def main():
    started_at = now_iso()
    print(f"=== Azure AD Re-auth (device code) ===")
    print(f"Started: {started_at}")

    # Step 1: initiate device code
    print()
    print("Requesting device code from Microsoft...")
    st, dc = http_post(
        f"https://login.microsoftonline.com/{AZURE_TENANT}/oauth2/v2.0/devicecode",
        data={"client_id": AZURE_APP_ID, "scope": AZURE_SCOPE},
    )
    if st != 200 or "device_code" not in dc:
        msg = dc.get("error_description") or dc.get("error") or str(dc)
        print(f"❌ Failed to get device code: {msg}")
        gist_write({
            "state": "error",
            "started_at": started_at,
            "finished_at": now_iso(),
            "message": f"Failed to initiate device code: {msg}",
        })
        sys.exit(1)

    user_code = dc["user_code"]
    verification_uri = dc.get("verification_uri") or dc.get("verification_url") or "https://microsoft.com/devicelogin"
    device_code = dc["device_code"]
    interval = int(dc.get("interval", 5))
    expires_in = int(dc.get("expires_in", 900))
    expires_at = (datetime.now(JST) + timedelta(seconds=expires_in)).isoformat()

    print(f"User code: {user_code}")
    print(f"URL: {verification_uri}")
    print(f"Expires at: {expires_at}")

    gist_write({
        "state": "waiting_code",
        "user_code": user_code,
        "verification_uri": verification_uri,
        "expires_at": expires_at,
        "started_at": started_at,
        "finished_at": None,
        "message": dc.get("message", ""),
    })

    # Step 2: poll for token
    print()
    print(f"Polling for token (interval={interval}s, timeout={expires_in}s)...")
    deadline = time.time() + expires_in
    new_refresh = None
    last_status = "pending"
    last_err = None
    while time.time() < deadline:
        time.sleep(interval)
        st, tok = http_post(
            f"https://login.microsoftonline.com/{AZURE_TENANT}/oauth2/v2.0/token",
            data={
                "client_id": AZURE_APP_ID,
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                "device_code": device_code,
            },
        )
        if st == 200 and tok.get("refresh_token"):
            new_refresh = tok["refresh_token"]
            print("  ✅ User authenticated, got refresh token")
            break
        err = tok.get("error", "")
        if err == "authorization_pending":
            print("  ⏳ pending...")
            continue
        elif err == "slow_down":
            interval += 5
            print(f"  ⚠️ slow_down, new interval={interval}")
            continue
        elif err in ("authorization_declined", "bad_verification_code", "expired_token"):
            last_status = err
            last_err = tok.get("error_description", err)
            print(f"  ❌ {err}: {last_err}")
            break
        else:
            last_err = tok.get("error_description", err or str(tok))
            print(f"  ⚠️ unexpected: {last_err}")

    if not new_refresh:
        gist_write({
            "state": "expired" if last_status == "expired_token" or time.time() >= deadline else "error",
            "started_at": started_at,
            "finished_at": now_iso(),
            "message": last_err or "Authentication timed out before user completed login.",
        })
        sys.exit(1)

    # Step 3: update GitHub secret
    print()
    print("Updating AZURE_REFRESH_TOKEN secret...")
    print(f"::add-mask::{new_refresh}")
    proc = subprocess.run(
        ["gh", "secret", "set", "AZURE_REFRESH_TOKEN", "--body", new_refresh, "--repo", REPO],
        env={**os.environ, "GH_TOKEN": GH_TOKEN},
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        print(f"❌ gh secret set failed: {proc.stderr}")
        gist_write({
            "state": "error",
            "started_at": started_at,
            "finished_at": now_iso(),
            "message": f"Auth succeeded but failed to update GitHub secret: {proc.stderr.strip()[:300]}",
        })
        sys.exit(1)
    print("  ✅ Secret updated")

    # Step 4: trigger token-monitor to refresh status
    print()
    print("Triggering token-monitor workflow...")
    subprocess.run(
        ["gh", "workflow", "run", "token-monitor.yml", "--repo", REPO, "--ref", "main"],
        env={**os.environ, "GH_TOKEN": GH_TOKEN},
        capture_output=True,
        text=True,
    )

    gist_write({
        "state": "success",
        "started_at": started_at,
        "finished_at": now_iso(),
        "message": "Re-authentication successful. AZURE_REFRESH_TOKEN updated.",
    })
    print()
    print("=== Re-auth completed ===")


if __name__ == "__main__":
    main()
