#!/usr/bin/env python3
"""GitHub Actions — DokoKin auto checkin/checkout.
Zero external dependencies (stdlib only).
Reads schedule.json, matches current JST time, executes checkin/checkout via API.
"""
import os, sys, json, urllib.request, urllib.parse, base64
from datetime import datetime, timezone, timedelta

JST = timezone(timedelta(hours=9))

# ── Azure AD / DokoKin config ──
AZURE_APP_ID = "f5be0f68-7285-4365-b979-10af0f3f4106"
AZURE_TENANT = "f01e930a-b52e-42b1-b70f-a8882b5d043b"
AZURE_SCOPE = f"api://{AZURE_APP_ID}/openid user.read offline_access"
API_BASE = "https://api.fjpservice.com/api/"


def log(msg):
    print(f"[{datetime.now(JST).strftime('%H:%M:%S')}] {msg}")


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
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, {"error": e.read().decode(errors="replace")}


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
#  CHECKIN / CHECKOUT
# ═══════════════════════════════════════════════════════════

def do_dakoku(token, checkin_type, lat, lon):
    """POST dakoku. checkin_type: 1=checkin, 2=checkout."""
    now = datetime.now(JST)
    status, data = http_post(
        API_BASE + "dakoku",
        json_data={
            "checkinType": checkin_type,
            "checkinDate": now.strftime("%Y-%m-%dT%H:%M:%S"),
            "checkinLatitude": lat,
            "checkinLongitute": lon,  # API typo is intentional
        },
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


def find_matching_action(schedule, now_jst):
    """Find action matching current time within tolerance."""
    tolerance = schedule.get("tolerance_minutes", 20)
    now_minutes = now_jst.hour * 60 + now_jst.minute
    now_date = now_jst.date()

    for entry in schedule["actions"]:
        dt = datetime.strptime(entry["datetime"], "%Y-%m-%d %H:%M")
        entry_date = dt.date()
        entry_minutes = dt.hour * 60 + dt.minute

        if entry_date != now_date:
            continue

        diff = abs(now_minutes - entry_minutes)
        if diff > 12 * 60:  # handle midnight wrap
            diff = 24 * 60 - diff

        if diff <= tolerance:
            return entry

    return None


# ═══════════════════════════════════════════════════════════
#  GITHUB ACTIONS HELPERS
# ═══════════════════════════════════════════════════════════

def set_output(key, value):
    """Set GitHub Actions output variable."""
    output_file = os.environ.get("GITHUB_OUTPUT")
    if output_file:
        with open(output_file, "a") as f:
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

    # ── Check for manual override via env ──
    force_action = os.environ.get("FORCE_ACTION")  # "checkin" or "checkout"
    force_location = os.environ.get("FORCE_LOCATION", "office")

    # ── Load schedule and find action ──
    schedule = load_schedule()

    if force_action:
        action_entry = {
            "action": force_action,
            "location": force_location,
            "note": "manual override",
        }
        log(f"FORCE mode: {force_action} at {force_location}")
    else:
        action_entry = find_matching_action(schedule, now_jst)

    if not action_entry:
        log("No scheduled action for current time. Skipping.")
        set_output("skipped", "true")
        set_summary(f"⏭️ **Skipped** — no action at {now_jst.strftime('%H:%M')} JST")
        return

    action = action_entry["action"]
    location_key = action_entry["location"]
    loc = schedule["locations"][location_key]
    note = action_entry.get("note", "")

    log(f"Action: {action} at {location_key} ({loc['name']})")
    if note:
        log(f"Note: {note}")

    # ── Get tokens ──
    refresh_token = os.environ.get("AZURE_REFRESH_TOKEN")
    if not refresh_token:
        log("ERROR: AZURE_REFRESH_TOKEN secret not set!")
        sys.exit(1)

    log("Refreshing Azure AD token...")
    azure_token, new_refresh = refresh_azure_token(refresh_token)
    log("Azure token OK ✓")

    log("Exchanging for DokoKin token...")
    dokokin_token = get_dokokin_token(azure_token)
    log("DokoKin token OK ✓")

    # ── Execute ──
    checkin_type = 1 if action == "checkin" else 2
    emoji = "📥" if action == "checkin" else "📤"
    status, result = do_dakoku(dokokin_token, checkin_type, loc["lat"], loc["lon"])

    if status == 200:
        log(f"{emoji} {action.upper()} SUCCESS at {loc['name']}")
        set_output("success", "true")
        set_summary(
            f"{emoji} **{action.upper()}** at {now_jst.strftime('%H:%M')} JST "
            f"— {loc['name']} ({location_key})"
            + (f"\n> {note}" if note else "")
        )
    else:
        log(f"❌ {action.upper()} FAILED (HTTP {status}): {result}")
        set_output("success", "false")
        set_summary(f"❌ **{action.upper()} FAILED** (HTTP {status})")
        sys.exit(1)

    # ── Handle token rotation ──
    if new_refresh != refresh_token:
        log("⚠️ Refresh token rotated!")
        set_output("token_rotated", "true")
        set_output("new_refresh_token", new_refresh)
    else:
        set_output("token_rotated", "false")


if __name__ == "__main__":
    main()
