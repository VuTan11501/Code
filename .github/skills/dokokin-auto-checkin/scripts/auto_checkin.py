"""
DokoKin Auto Checkin/Checkout Script
=====================================
Tự động checkin lúc 9:00 và checkout theo giờ cấu hình.
Đăng nhập bằng Azure AD (cùng flow với Flutter app — PKCE + mobile redirect).

Cách dùng:
  1. pip install requests schedule
  2. Chạy lần đầu: python auto_checkin.py --setup
     (Mở browser → đăng nhập Microsoft → tự capture token)
  3. Sau setup, chạy tự động không cần browser (dùng refresh token):
     python auto_checkin.py --checkin
     python auto_checkin.py --checkout
     python auto_checkin.py --schedule
"""

import argparse
import base64
import hashlib
import json
import logging
import secrets
import sys
import time
import urllib.parse
import webbrowser
import winreg
from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from threading import Thread

import requests

# ─── Constants ───────────────────────────────────────────────────────────────

SCRIPT_DIR = Path(__file__).parent
CONFIG_FILE = SCRIPT_DIR / "checkin_config.json"
TOKEN_FILE = SCRIPT_DIR / ".azure_tokens.json"
LOG_FILE = SCRIPT_DIR / "auto_checkin.log"
CALLBACK_FILE = SCRIPT_DIR / ".auth_callback.tmp"
HANDLER_SCRIPT = SCRIPT_DIR / "_auth_callback.py"

# DokoKin API
API_BASE = "https://api.fjpservice.com/api/"
API_LOGIN = API_BASE + "token"
API_CHECKIN = API_BASE + "dakoku"
API_TODAY_RECORD = API_BASE + "dakoku/me/"
API_PROFILE = API_BASE + "employee/profile"
API_WORKPLACE = API_BASE + "dakoku/workplace"

# Azure AD config (from DokoKin Flutter app)
AZURE_TENANT = "f01e930a-b52e-42b1-b70f-a8882b5d043b"
AZURE_CLIENT_ID = "f5be0f68-7285-4365-b979-10af0f3f4106"
AZURE_AUTHORITY = f"https://login.microsoftonline.com/{AZURE_TENANT}"
AZURE_TOKEN_URL = f"{AZURE_AUTHORITY}/oauth2/v2.0/token"
AZURE_AUTH_URL = f"{AZURE_AUTHORITY}/oauth2/v2.0/authorize"
AZURE_REDIRECT_URI = "msauth.com.fjp.portal://auth"
AZURE_SCOPE = f"api://{AZURE_CLIENT_ID}/openid user.read offline_access"
URL_SCHEME = "msauth.com.fjp.portal"

DEFAULT_CONFIG = {
    "checkin_time": "09:00",
    "checkout_time": "18:00",
    "checkin_type": 1,
    "office_latitude": 0.0,
    "office_longitude": 0.0,
    "app_id": "com.fjp.portal",
    "randomize_minutes": 5,
}

# ─── Logging ─────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE, encoding="utf-8"),
        logging.StreamHandler(sys.stdout),
    ],
)
log = logging.getLogger("auto_checkin")

# ─── Config ──────────────────────────────────────────────────────────────────

def load_config() -> dict:
    if CONFIG_FILE.exists():
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        for k, v in DEFAULT_CONFIG.items():
            cfg.setdefault(k, v)
        return cfg
    return dict(DEFAULT_CONFIG)


def save_config(cfg: dict):
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)
    log.info(f"Config saved: {CONFIG_FILE}")

# ─── PKCE Helpers ────────────────────────────────────────────────────────────

def _generate_pkce() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(43)
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
        .rstrip(b"=")
        .decode()
    )
    return verifier, challenge

# ─── Windows URL Protocol Handler ────────────────────────────────────────────

def _register_url_handler():
    """Register msauth.com.fjp.portal as a Windows URL protocol handler."""
    python_exe = sys.executable
    # Create callback script
    HANDLER_SCRIPT.write_text(
        f'import sys; from pathlib import Path\n'
        f'url = sys.argv[1] if len(sys.argv) > 1 else ""\n'
        f'Path(r"{CALLBACK_FILE}").write_text(url, encoding="utf-8")\n',
        encoding="utf-8",
    )
    key_path = rf"Software\Classes\{URL_SCHEME}"
    key = winreg.CreateKey(winreg.HKEY_CURRENT_USER, key_path)
    winreg.SetValue(key, "", winreg.REG_SZ, f"URL:{URL_SCHEME}")
    winreg.SetValueEx(key, "URL Protocol", 0, winreg.REG_SZ, "")
    cmd_key = winreg.CreateKey(key, r"shell\open\command")
    winreg.SetValue(cmd_key, "", winreg.REG_SZ, f'"{python_exe}" "{HANDLER_SCRIPT}" "%1"')
    winreg.CloseKey(cmd_key)
    winreg.CloseKey(key)
    log.info("URL handler registered.")


def _unregister_url_handler():
    """Remove the URL protocol handler."""
    for sub in [r"shell\open\command", r"shell\open", "shell", ""]:
        try:
            path = rf"Software\Classes\{URL_SCHEME}"
            if sub:
                path += rf"\{sub}"
            winreg.DeleteKey(winreg.HKEY_CURRENT_USER, path)
        except OSError:
            pass
    for f in [HANDLER_SCRIPT, CALLBACK_FILE]:
        if f.exists():
            f.unlink()
    log.info("URL handler cleaned up.")

# ─── Token Storage ───────────────────────────────────────────────────────────

def _save_tokens(tokens: dict):
    TOKEN_FILE.write_text(json.dumps(tokens, indent=2), encoding="utf-8")


def _load_tokens() -> dict | None:
    if TOKEN_FILE.exists():
        return json.loads(TOKEN_FILE.read_text(encoding="utf-8"))
    return None

# ─── Azure AD Auth ───────────────────────────────────────────────────────────

def azure_login_interactive() -> str:
    """Mở browser → Azure AD login → capture auth code via URL handler → exchange for tokens."""
    code_verifier, code_challenge = _generate_pkce()
    state = secrets.token_urlsafe(16)

    # Build authorize URL
    params = {
        "client_id": AZURE_CLIENT_ID,
        "response_type": "code",
        "redirect_uri": AZURE_REDIRECT_URI,
        "scope": AZURE_SCOPE,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
        "state": state,
        "prompt": "select_account",
    }
    auth_url = AZURE_AUTH_URL + "?" + urllib.parse.urlencode(params)

    # Setup URL handler
    if CALLBACK_FILE.exists():
        CALLBACK_FILE.unlink()
    _register_url_handler()

    try:
        print("\n" + "=" * 60)
        print("  ĐĂNG NHẬP AZURE AD")
        print("  Browser sẽ tự mở — đăng nhập tài khoản Microsoft")
        print("  Nếu thấy popup 'Open app?', hãy nhấn Open/Allow")
        print("=" * 60 + "\n")
        webbrowser.open(auth_url)

        # Wait for callback
        log.info("Đang chờ đăng nhập... (timeout 120s)")
        for i in range(120):
            if CALLBACK_FILE.exists():
                callback_url = CALLBACK_FILE.read_text(encoding="utf-8").strip()
                if callback_url:
                    break
            time.sleep(1)
        else:
            # Fallback: ask user to paste URL
            print("\n  Không nhận được callback tự động.")
            print("  Hãy copy URL từ thanh địa chỉ browser và paste vào đây:")
            callback_url = input("  URL: ").strip()

        if not callback_url:
            raise RuntimeError("Không nhận được auth callback.")

        # Parse auth code from callback URL
        # URL format: msauth.com.fjp.portal://auth?code=XXX&state=YYY
        parsed = urllib.parse.urlparse(callback_url)
        query_params = urllib.parse.parse_qs(parsed.query)

        if "code" not in query_params:
            # Try parsing fragment
            query_params = urllib.parse.parse_qs(parsed.fragment)
        if "code" not in query_params:
            raise RuntimeError(f"No auth code in callback URL: {callback_url}")

        auth_code = query_params["code"][0]
        log.info("Auth code received!")

        # Exchange code for tokens (PKCE — no client_secret needed)
        token_resp = requests.post(AZURE_TOKEN_URL, data={
            "client_id": AZURE_CLIENT_ID,
            "scope": AZURE_SCOPE,
            "code": auth_code,
            "redirect_uri": AZURE_REDIRECT_URI,
            "grant_type": "authorization_code",
            "code_verifier": code_verifier,
        }, timeout=30)
        token_data = token_resp.json()

        if "access_token" not in token_data:
            error = token_data.get("error_description") or token_data.get("error") or str(token_data)
            raise RuntimeError(f"Token exchange failed: {error}")

        # Save tokens (including refresh_token for future silent auth)
        _save_tokens(token_data)
        log.info("Azure AD login thành công! Tokens saved.")
        return token_data["access_token"]

    finally:
        _unregister_url_handler()


def azure_refresh_token() -> str | None:
    """Dùng refresh token để lấy access token mới (không cần browser)."""
    tokens = _load_tokens()
    if not tokens or "refresh_token" not in tokens:
        return None

    try:
        resp = requests.post(AZURE_TOKEN_URL, data={
            "client_id": AZURE_CLIENT_ID,
            "scope": AZURE_SCOPE,
            "refresh_token": tokens["refresh_token"],
            "grant_type": "refresh_token",
        }, timeout=30)
        data = resp.json()

        if "access_token" in data:
            _save_tokens(data)
            log.info("Azure AD token refreshed (silent).")
            return data["access_token"]

        log.warning(f"Refresh failed: {data.get('error_description', data.get('error'))}")
        return None
    except Exception as e:
        log.warning(f"Refresh error: {e}")
        return None


def get_azure_token(force_interactive: bool = False) -> str:
    """Lấy Azure AD token — silent refresh nếu có, interactive nếu cần."""
    if not force_interactive:
        token = azure_refresh_token()
        if token:
            return token

    return azure_login_interactive()

# ─── DokoKin API ─────────────────────────────────────────────────────────────

def dokokin_login_azure(azure_token: str) -> dict:
    resp = requests.post(API_LOGIN, data={
        "module": "KINTAI",
        "grant_type": "azure_ad_token",
        "token": azure_token,
    }, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    if data.get("error"):
        raise RuntimeError(f"DokoKin login error: {data['error']}")
    if not data.get("access_token"):
        raise RuntimeError(f"No access_token: {data}")
    log.info(f"DokoKin login OK — user: {data.get('username')}")
    return data


def _headers(token: str) -> dict:
    return {
        "Authorization": f"Bearer {token}",
        "Module": "KINTAI",
        "Content-Type": "application/json",
    }


def get_employee_profile(token: str) -> dict:
    resp = requests.get(API_PROFILE, headers=_headers(token), timeout=30)
    resp.raise_for_status()
    return resp.json()


def get_workplace(token: str) -> dict | None:
    try:
        resp = requests.get(API_WORKPLACE, headers=_headers(token), timeout=30)
        resp.raise_for_status()
        return resp.json()
    except Exception:
        return None


def get_today_record(token: str, date_str: str) -> dict | None:
    try:
        resp = requests.get(API_TODAY_RECORD + date_str, headers=_headers(token), timeout=30)
        resp.raise_for_status()
        return resp.json()
    except Exception:
        return None


def do_checkin(token: str, employee_id: int, cfg: dict, is_checkout: bool = False) -> bool:
    now = datetime.now()
    body = {
        "employeeId": employee_id,
        "appId": cfg["app_id"],
        "logTime": now.strftime("%Y-%m-%dT%H:%M:%S"),
        "isCheckoutYesterday": False,
        "TotalOfBreakTime": 0,
    }
    lat, lon = cfg["office_latitude"], cfg["office_longitude"]
    ctype = cfg["checkin_type"]

    if is_checkout:
        body.update(checkoutType=ctype, checkoutLongitute=lon, checkoutLatitude=lat)
        action = "CHECKOUT"
    else:
        body.update(checkinType=ctype, checkinLongitute=lon, checkinLatitude=lat)
        action = "CHECKIN"

    log.info(f"Gửi {action}: type={ctype}, lat={lat}, lon={lon}, time={body['logTime']}")
    resp = requests.post(API_CHECKIN, headers=_headers(token), json=body, timeout=30)

    if resp.status_code == 200:
        log.info(f"✅ {action} thành công!")
        return True
    else:
        log.error(f"❌ {action} thất bại: {resp.status_code} — {resp.text}")
        return False

# ─── Main Actions ────────────────────────────────────────────────────────────

def get_dokokin_token(force_interactive: bool = False) -> str:
    azure_token = get_azure_token(force_interactive=force_interactive)
    return dokokin_login_azure(azure_token)["access_token"]


def perform_action(is_checkout: bool = False) -> bool:
    action = "checkout" if is_checkout else "checkin"
    log.info(f"=== Bắt đầu {action} ===")
    cfg = load_config()
    today_str = datetime.now().strftime("%Y-%m-%d")

    try:
        dk_token = get_dokokin_token()
        profile = get_employee_profile(dk_token)
        employee_id = profile["employeeId"]
        log.info(f"Employee: {profile.get('fullname', 'N/A')} (ID: {employee_id})")

        if cfg["office_latitude"] == 0.0 and cfg["office_longitude"] == 0.0:
            workplace = get_workplace(dk_token)
            if workplace:
                cfg["office_latitude"] = workplace.get("latitude", 0.0)
                cfg["office_longitude"] = workplace.get("longitude", 0.0)
                save_config(cfg)
                log.info(f"Workplace: lat={cfg['office_latitude']}, lon={cfg['office_longitude']}")

        record = get_today_record(dk_token, today_str)
        if record:
            if not is_checkout and record.get("displayStartWorkingTime"):
                log.info(f"Đã checkin rồi lúc {record['displayStartWorkingTime']}. Bỏ qua.")
                return True
            if is_checkout and record.get("displayEndWorkingTime"):
                log.info(f"Đã checkout rồi lúc {record['displayEndWorkingTime']}. Bỏ qua.")
                return True

        return do_checkin(dk_token, employee_id, cfg, is_checkout=is_checkout)
    except Exception as e:
        log.error(f"Lỗi khi {action}: {e}", exc_info=True)
        return False


def setup():
    log.info("=== SETUP ===")
    azure_token = get_azure_token(force_interactive=True)
    login_data = dokokin_login_azure(azure_token)
    dk_token = login_data["access_token"]

    profile = get_employee_profile(dk_token)
    name = profile.get("fullname", "N/A")
    log.info(f"Xin chào {name}! (ID: {profile['employeeId']})")

    cfg = load_config()
    workplace = get_workplace(dk_token)
    if workplace:
        cfg["office_latitude"] = workplace.get("latitude", 0.0)
        cfg["office_longitude"] = workplace.get("longitude", 0.0)
        log.info(f"Workplace: lat={cfg['office_latitude']}, lon={cfg['office_longitude']}")
    else:
        log.warning("Không tìm thấy workplace.")
    save_config(cfg)

    print("\n" + "=" * 60)
    print(f"  ✅ SETUP HOÀN TẤT — Xin chào {name}!")
    print(f"  Config: {CONFIG_FILE}")
    print(f"  Tokens: {TOKEN_FILE}")
    print(f"  Type:   {cfg['checkin_type']} (1=office, 5=WFH, 3=noGPS)")
    print(f"  Tọa độ: ({cfg['office_latitude']}, {cfg['office_longitude']})")
    print()
    print("  Lệnh:")
    print(f'    python "{__file__}" --checkin')
    print(f'    python "{__file__}" --checkout')
    print(f'    python "{__file__}" --status')
    print(f'    python "{__file__}" --schedule')
    print("=" * 60)


def run_scheduler():
    import random
    import schedule as sched_lib

    cfg = load_config()
    ci, co = cfg["checkin_time"], cfg["checkout_time"]
    rand_min = cfg.get("randomize_minutes", 5)

    def do(is_checkout):
        delay = random.randint(0, rand_min * 60)
        log.info(f"{'Checkout' if is_checkout else 'Checkin'} in {delay}s")
        time.sleep(delay)
        perform_action(is_checkout=is_checkout)

    sched_lib.every().day.at(ci).do(lambda: do(False))
    sched_lib.every().day.at(co).do(lambda: do(True))
    log.info(f"Scheduler: checkin={ci}, checkout={co}. Ctrl+C to stop.")

    try:
        while True:
            sched_lib.run_pending()
            time.sleep(30)
    except KeyboardInterrupt:
        log.info("Stopped.")

# ─── CLI ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="DokoKin Auto Checkin/Checkout")
    g = parser.add_mutually_exclusive_group()
    g.add_argument("--setup", action="store_true", help="Đăng nhập Azure AD (lần đầu)")
    g.add_argument("--checkin", action="store_true", help="Checkin ngay")
    g.add_argument("--checkout", action="store_true", help="Checkout ngay")
    g.add_argument("--status", action="store_true", help="Xem record hôm nay")
    g.add_argument("--schedule", action="store_true", help="Chạy scheduler loop")
    args = parser.parse_args()

    if args.setup:
        setup()
    elif args.checkin:
        sys.exit(0 if perform_action(False) else 1)
    elif args.checkout:
        sys.exit(0 if perform_action(True) else 1)
    elif args.status:
        dk_token = get_dokokin_token()
        record = get_today_record(dk_token, datetime.now().strftime("%Y-%m-%d"))
        if record:
            print(f"Ngày:     {record.get('displayWorkingDate', 'N/A')}")
            print(f"Checkin:  {record.get('displayStartWorkingTime') or '---'}")
            print(f"Checkout: {record.get('displayEndWorkingTime') or '---'}")
        else:
            print("Chưa có record hôm nay.")
    elif args.schedule:
        run_scheduler()
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
