"""
DokoKin Azure AD Auth Manager
==============================
Quản lý Azure AD tokens cho DokoKin — login, refresh, status, revoke.
Tách riêng khỏi auto_checkin.py để tái sử dụng.

Cách dùng:
  python azure_auth.py --login        # Đăng nhập Azure AD (mở browser)
  python azure_auth.py --refresh      # Refresh token silently
  python azure_auth.py --token        # In ra access token (dùng cho script khác)
  python azure_auth.py --status       # Xem trạng thái token + user info
  python azure_auth.py --revoke       # Xóa tokens đã cache
"""

import argparse
import base64
import hashlib
import json
import os
import secrets
import sys
import time
import urllib.parse
import webbrowser
import winreg
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

# Fix Windows console encoding for emoji/unicode
if sys.platform == "win32":
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# ─── Constants ───────────────────────────────────────────────────────────────

SCRIPT_DIR = Path(__file__).parent
TOKEN_FILE = SCRIPT_DIR / ".azure_tokens.json"
CALLBACK_FILE = SCRIPT_DIR / ".auth_callback.tmp"
HANDLER_SCRIPT = SCRIPT_DIR / "_auth_callback.py"

# Azure AD config (from DokoKin Flutter app)
AZURE_TENANT = "f01e930a-b52e-42b1-b70f-a8882b5d043b"
AZURE_CLIENT_ID = "f5be0f68-7285-4365-b979-10af0f3f4106"
AZURE_AUTHORITY = f"https://login.microsoftonline.com/{AZURE_TENANT}"
AZURE_TOKEN_URL = f"{AZURE_AUTHORITY}/oauth2/v2.0/token"
AZURE_AUTH_URL = f"{AZURE_AUTHORITY}/oauth2/v2.0/authorize"
AZURE_REDIRECT_URI = "msauth.com.fjp.portal://auth"
AZURE_SCOPE = f"api://{AZURE_CLIENT_ID}/openid user.read offline_access"
URL_SCHEME = "msauth.com.fjp.portal"

# DokoKin API (for --status user info)
API_BASE = "https://api.fjpservice.com/api/"
API_LOGIN = API_BASE + "token"
API_PROFILE = API_BASE + "employee/profile"

# ─── PKCE ────────────────────────────────────────────────────────────────────

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
    python_exe = sys.executable
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


def _unregister_url_handler():
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

# ─── Token Storage ───────────────────────────────────────────────────────────

def save_tokens(tokens: dict):
    """Lưu tokens + timestamp vào file."""
    tokens["_saved_at"] = datetime.now(timezone.utc).isoformat()
    TOKEN_FILE.write_text(json.dumps(tokens, indent=2), encoding="utf-8")


def load_tokens() -> dict | None:
    if TOKEN_FILE.exists():
        return json.loads(TOKEN_FILE.read_text(encoding="utf-8"))
    return None


def decode_jwt_payload(token: str) -> dict | None:
    """Decode JWT payload (no verification — for reading claims only)."""
    try:
        payload = token.split(".")[1]
        # Add padding
        payload += "=" * (4 - len(payload) % 4)
        return json.loads(base64.urlsafe_b64decode(payload))
    except Exception:
        return None

# ─── Azure AD Auth ───────────────────────────────────────────────────────────

def login_interactive() -> dict:
    """Mở browser → Azure AD login → capture auth code → exchange for tokens."""
    code_verifier, code_challenge = _generate_pkce()
    state = secrets.token_urlsafe(16)

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

        print("Đang chờ đăng nhập... (timeout 120s)")
        for i in range(120):
            if CALLBACK_FILE.exists():
                callback_url = CALLBACK_FILE.read_text(encoding="utf-8").strip()
                if callback_url:
                    break
            time.sleep(1)
        else:
            print("\n  Không nhận được callback tự động.")
            print("  Hãy copy URL từ thanh địa chỉ browser và paste vào đây:")
            callback_url = input("  URL: ").strip()

        if not callback_url:
            raise RuntimeError("Không nhận được auth callback.")

        parsed = urllib.parse.urlparse(callback_url)
        query_params = urllib.parse.parse_qs(parsed.query)
        if "code" not in query_params:
            query_params = urllib.parse.parse_qs(parsed.fragment)
        if "code" not in query_params:
            raise RuntimeError(f"No auth code in callback URL: {callback_url}")

        auth_code = query_params["code"][0]
        print("✓ Auth code received!")

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

        save_tokens(token_data)
        return token_data

    finally:
        _unregister_url_handler()


def refresh_token() -> dict | None:
    """Dùng refresh token để lấy access token mới (không cần browser)."""
    tokens = load_tokens()
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
            save_tokens(data)
            return data

        print(f"Refresh failed: {data.get('error_description', data.get('error'))}")
        return None
    except Exception as e:
        print(f"Refresh error: {e}")
        return None


def get_token(force_interactive: bool = False) -> str | None:
    """Lấy Azure AD access token — silent refresh nếu có, interactive nếu cần."""
    if not force_interactive:
        tokens = load_tokens()
        if tokens and "access_token" in tokens:
            # Check if token is still valid
            claims = decode_jwt_payload(tokens["access_token"])
            if claims and claims.get("exp"):
                exp = datetime.fromtimestamp(claims["exp"], tz=timezone.utc)
                if exp > datetime.now(timezone.utc) + timedelta(minutes=5):
                    return tokens["access_token"]

            # Token expired, try refresh
            result = refresh_token()
            if result:
                return result["access_token"]

    # Need interactive login
    result = login_interactive()
    return result["access_token"]


def get_token_status() -> dict:
    """Trả về trạng thái đầy đủ của token."""
    tokens = load_tokens()
    status = {
        "has_tokens": False,
        "has_access_token": False,
        "has_refresh_token": False,
        "access_token_valid": False,
        "user": None,
        "email": None,
        "expires_at": None,
        "expires_in_minutes": None,
        "saved_at": None,
        "token_file": str(TOKEN_FILE),
        "employee": None,
    }

    if not tokens:
        return status

    status["has_tokens"] = True
    status["has_access_token"] = "access_token" in tokens
    status["has_refresh_token"] = "refresh_token" in tokens
    status["saved_at"] = tokens.get("_saved_at")

    if not status["has_access_token"]:
        return status

    # Decode JWT to check expiry and user info
    claims = decode_jwt_payload(tokens["access_token"])
    if claims:
        status["user"] = claims.get("name")
        status["email"] = claims.get("email") or claims.get("preferred_username") or claims.get("upn")

        if claims.get("exp"):
            exp = datetime.fromtimestamp(claims["exp"], tz=timezone.utc)
            now = datetime.now(timezone.utc)
            status["expires_at"] = exp.isoformat()
            remaining = (exp - now).total_seconds() / 60
            status["expires_in_minutes"] = round(remaining, 1)
            status["access_token_valid"] = remaining > 0

    # Try to get employee info from DokoKin API
    if status["access_token_valid"]:
        try:
            dk_resp = requests.post(API_LOGIN, data={
                "module": "KINTAI",
                "grant_type": "azure_ad_token",
                "token": tokens["access_token"],
            }, timeout=10)
            if dk_resp.status_code == 200:
                dk_data = dk_resp.json()
                if dk_data.get("access_token"):
                    headers = {
                        "Authorization": f"Bearer {dk_data['access_token']}",
                        "Module": "KINTAI",
                    }
                    profile_resp = requests.get(API_PROFILE, headers=headers, timeout=10)
                    if profile_resp.status_code == 200:
                        profile = profile_resp.json()
                        status["employee"] = {
                            "id": profile.get("employeeId"),
                            "name": profile.get("fullname"),
                            "username": profile.get("username") or dk_data.get("username"),
                        }
        except Exception:
            pass

    return status


def revoke_tokens():
    """Xóa toàn bộ tokens đã cache."""
    if TOKEN_FILE.exists():
        TOKEN_FILE.unlink()
        print("✓ Đã xóa tokens.")
    else:
        print("Không có tokens để xóa.")
    # Clean up handler artifacts
    for f in [HANDLER_SCRIPT, CALLBACK_FILE]:
        if f.exists():
            f.unlink()

# ─── CLI ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="DokoKin Azure AD Auth Manager")
    g = parser.add_mutually_exclusive_group()
    g.add_argument("--login", action="store_true", help="Đăng nhập Azure AD (mở browser)")
    g.add_argument("--refresh", action="store_true", help="Refresh token silently")
    g.add_argument("--token", action="store_true", help="In ra access token (stdout)")
    g.add_argument("--status", action="store_true", help="Xem trạng thái token + user info")
    g.add_argument("--status-json", action="store_true", help="Token status dạng JSON")
    g.add_argument("--revoke", action="store_true", help="Xóa tokens đã cache")
    args = parser.parse_args()

    if args.login:
        result = login_interactive()
        claims = decode_jwt_payload(result["access_token"])
        name = claims.get("name", "N/A") if claims else "N/A"
        email = (claims.get("email") or claims.get("upn") or "N/A") if claims else "N/A"
        has_refresh = "refresh_token" in result
        print(f"\n✅ Login thành công!")
        print(f"  User:          {name}")
        print(f"  Email:         {email}")
        print(f"  Refresh token: {'Có' if has_refresh else 'Không'}")
        print(f"  Token file:    {TOKEN_FILE}")
        print(f"  Expires in:    {result.get('expires_in', '?')}s")

    elif args.refresh:
        result = refresh_token()
        if result:
            print("✅ Token refreshed thành công!")
            print(f"  Expires in: {result.get('expires_in', '?')}s")
        else:
            print("❌ Refresh thất bại — cần chạy --login lại.")
            sys.exit(1)

    elif args.token:
        token = get_token()
        if token:
            print(token, end="")
        else:
            print("ERROR: No valid token. Run --login first.", file=sys.stderr)
            sys.exit(1)

    elif args.status or args.status_json:
        status = get_token_status()

        if args.status_json:
            print(json.dumps(status, indent=2, ensure_ascii=False))
        else:
            print("=== Azure AD Token Status ===")
            if not status["has_tokens"]:
                print("  Chưa đăng nhập. Chạy --login.")
            else:
                print(f"  User:           {status['user'] or 'N/A'}")
                print(f"  Email:          {status['email'] or 'N/A'}")
                valid = "✅ Còn hạn" if status["access_token_valid"] else "❌ Hết hạn"
                print(f"  Access token:   {valid}")
                if status["expires_in_minutes"] is not None:
                    mins = status["expires_in_minutes"]
                    if mins > 60:
                        print(f"  Hết hạn sau:    {mins/60:.1f} giờ")
                    elif mins > 0:
                        print(f"  Hết hạn sau:    {mins:.0f} phút")
                    else:
                        print(f"  Đã hết hạn:     {abs(mins):.0f} phút trước")
                print(f"  Refresh token:  {'Có' if status['has_refresh_token'] else 'Không'}")
                if status["employee"]:
                    emp = status["employee"]
                    print(f"  Employee:       {emp['name']} (ID: {emp['id']}, user: {emp['username']})")
                print(f"  Token file:     {status['token_file']}")
                if status["saved_at"]:
                    print(f"  Lưu lúc:        {status['saved_at']}")

    elif args.revoke:
        revoke_tokens()

    else:
        parser.print_help()


if __name__ == "__main__":
    main()
