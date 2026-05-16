---
name: dokokin-azure-login
description: 'Manage Azure AD authentication tokens for DokoKin (FJP kintai). USE WHEN: user needs to login to Azure AD for DokoKin, refresh expired tokens, check token status/validity, get an access token for API calls, or revoke cached credentials. Handles the full OAuth2 PKCE flow with browser-based Azure AD login using the DokoKin Flutter app mobile redirect URI. Tokens are cached locally with automatic silent refresh (~90 days via refresh_token). DO NOT USE FOR: checkin/checkout operations (use dokokin-auto-checkin skill instead); other Azure AD apps; modifying Azure AD app registration.'
argument-hint: 'login | refresh | status | token | revoke'
---

# DokoKin Azure AD Login & Token Manager

Quản lý Azure AD authentication tokens cho hệ thống DokoKin (FJP kintai). Tách riêng phần auth để tái sử dụng cho nhiều script/tool khác nhau.

## When to Use

- User nói "đăng nhập", "login", "xác thực", "authenticate"
- User gặp lỗi 401 / token expired / "cần login lại"
- User muốn kiểm tra token còn hạn không
- User muốn lấy access token cho API call thủ công
- User muốn xóa credentials đã cache (revoke)
- Trước khi dùng skill `dokokin-auto-checkin` lần đầu

## Prerequisites

- **Python 3.12+** (`C:\Users\Admin\AppData\Local\Programs\Python\Python312\python.exe`)
- **Package**: `requests` (`pip install requests`)
- **Script**: `scripts/azure_auth.py` trong workspace `C:\Users\Admin\Downloads\FJP Tool\FJP Tool\`

## Script Location

```
C:\Users\Admin\Downloads\FJP Tool\FJP Tool\scripts\azure_auth.py
```

Token file: `scripts/.azure_tokens.json`

## Procedure

### Login (lần đầu / re-login)

```powershell
cd "C:\Users\Admin\Downloads\FJP Tool\FJP Tool"
python scripts/azure_auth.py --login
```

Flow:
1. Mở browser → trang đăng nhập Microsoft Azure AD
2. User chọn tài khoản FPT (`*@fpt.com`)
3. Azure AD redirect về URL scheme `msauth.com.fjp.portal://auth`
4. Windows URL protocol handler capture auth code
5. Script exchange code → tokens (PKCE, no client_secret)
6. Tokens (access + refresh) lưu vào `scripts/.azure_tokens.json`

**Popup "Open app?"**: User phải nhấn **Open** hoặc **Allow** để callback hoạt động.

Output:
```
✅ Login thành công!
  User:          Tan Vu Cao
  Email:         tanvc@fpt.com
  Refresh token: Có
  Expires in:    4218s
```

### Refresh Token (silent — không cần browser)

```powershell
cd "C:\Users\Admin\Downloads\FJP Tool\FJP Tool"
python scripts/azure_auth.py --refresh
```

Dùng refresh_token đã lưu để lấy access_token mới. Không mở browser. Refresh token valid ~90 ngày.

### Check Token Status

```powershell
cd "C:\Users\Admin\Downloads\FJP Tool\FJP Tool"
python scripts/azure_auth.py --status
```

Output:
```
=== Azure AD Token Status ===
  User:           Tan Vu Cao
  Email:          tanvc@fpt.com
  Access token:   ✅ Còn hạn
  Hết hạn sau:    1.2 giờ
  Refresh token:  Có
  Employee:       Vu Cao Tan (ID: 8883, user: TanVC)
  Token file:     ...\scripts\.azure_tokens.json
  Lưu lúc:        2026-05-16T07:06:22+00:00
```

Dạng JSON (cho scripting):
```powershell
python scripts/azure_auth.py --status-json
```

### Get Access Token (stdout — cho pipe/script khác)

```powershell
# In raw token ra stdout (dùng cho curl, script khác)
python scripts/azure_auth.py --token
```

Tự refresh nếu hết hạn. Exit code 1 nếu không có token.

Ví dụ kết hợp với curl:
```powershell
$token = python scripts/azure_auth.py --token
curl -H "Authorization: Bearer $token" -H "Module: KINTAI" https://api.fjpservice.com/api/employee/profile
```

### Revoke (xóa tokens)

```powershell
cd "C:\Users\Admin\Downloads\FJP Tool\FJP Tool"
python scripts/azure_auth.py --revoke
```

Xóa file `.azure_tokens.json` và các artifact tạm. Sau đó cần `--login` lại.

## Architecture — How Auth Works

```
┌─────────────┐    PKCE + auth code     ┌──────────────────┐
│   Browser    │ ◄─────────────────────► │  Azure AD        │
│   (user)     │    login.microsoft.com  │  (tenant FPT)    │
└──────┬───────┘                         └────────┬─────────┘
       │ redirect msauth://auth?code=XX           │
       ▼                                          │
┌─────────────┐    code + PKCE verifier  ┌────────▼─────────┐
│ URL Handler  │ ─────write──────────►   │  Token file      │
│ (registry)   │    .auth_callback.tmp   │  .azure_tokens   │
└──────────────┘                         │  .json           │
                                         └────────┬─────────┘
                                                  │
       ┌─────────────────────────────────────────►│
       │  exchange code → access + refresh token   │
       │                                          │
┌──────┴──────┐   refresh_token (silent)  ┌───────▼─────────┐
│ azure_auth  │ ◄───────────────────────► │  Azure AD       │
│ .py         │    grant_type=refresh     │  /oauth2/v2.0/  │
│             │                           │  token           │
└──────┬──────┘                           └─────────────────┘
       │ access_token
       ▼
┌─────────────┐   azure_ad_token         ┌──────────────────┐
│ DokoKin API │ ◄───────────────────────► │  api.fjpservice  │
│ (any script)│   POST /api/token         │  .com            │
└─────────────┘                           └──────────────────┘
```

### Key Points
- **App ID**: `f5be0f68-7285-4365-b979-10af0f3f4106` (DokoKin Azure AD app)
- **Tenant**: `f01e930a-b52e-42b1-b70f-a8882b5d043b` (FPT)
- **Redirect URI**: `msauth.com.fjp.portal://auth` — mobile URI của Flutter app
- **Flow**: OAuth2 Authorization Code + PKCE (public client)
- **Scope**: `api://f5be0f68-7285-4365-b979-10af0f3f4106/openid user.read offline_access`
- App được cấu hình là **confidential client** trên Azure AD, nhưng mobile redirect URI + PKCE bypass yêu cầu client_secret
- **Access token**: ~70 phút, tự decode JWT để kiểm tra `exp` claim
- **Refresh token**: ~90 ngày, dùng để lấy access token mới không cần browser
- **Windows URL handler**: Registry key `HKCU\Software\Classes\msauth.com.fjp.portal` — chỉ register tạm lúc login, cleanup sau

### Token File Format (`scripts/.azure_tokens.json`)

```json
{
  "token_type": "Bearer",
  "scope": "api://f5be0f68.../Mail",
  "expires_in": 4218,
  "access_token": "eyJ0eXAi...",
  "refresh_token": "1.AXIACpMe...",
  "id_token": "eyJ0eXAi...",
  "_saved_at": "2026-05-16T07:06:22+00:00"
}
```

Các script khác (như `auto_checkin.py`) dùng chung file này — login 1 lần, tất cả script đều dùng được.

## Integration with Other Scripts

`azure_auth.py` export các function có thể import:

```python
from azure_auth import get_token, get_token_status, load_tokens, refresh_token

# Lấy token (tự refresh nếu cần)
token = get_token()

# Kiểm tra status
status = get_token_status()
if not status["access_token_valid"]:
    token = get_token(force_interactive=True)
```

Hoặc dùng `--token` flag để pipe:
```powershell
$token = python scripts/azure_auth.py --token
# Dùng $token cho bất kỳ API call nào cần Azure AD
```

## Troubleshooting

| Triệu chứng | Nguyên nhân | Fix |
|---|---|---|
| Browser không mở | Python path sai / browser blocked | Kiểm tra `python --version`, thử mở URL thủ công |
| "Không nhận được callback" | Popup "Open app?" bị block / URL handler chưa register | Nhấn Allow, hoặc paste URL thủ công |
| Refresh failed | Refresh token hết hạn (>90 ngày) | Chạy `--login` lại |
| `AADSTS7000218` | Đang dùng sai redirect URI | Script đã dùng `msauth.com.fjp.portal://auth` — đúng rồi |
| `401` từ DokoKin API | Azure token valid nhưng DokoKin không chấp nhận | Kiểm tra scope, thử `--login` lại |
| Token file bị corrupt | Edit tay sai format | `--revoke` rồi `--login` lại |
| `ModuleNotFoundError: requests` | Chưa install | `pip install requests` |

## Security Notes

- Tokens lưu local tại `scripts/.azure_tokens.json` — **KHÔNG commit lên git**
- Refresh token là credential dài hạn (~90 ngày) — bảo vệ file này
- URL protocol handler chỉ register tạm trong lúc login, cleanup ngay sau đó
- Script không gửi token đến bất kỳ third-party nào — chỉ Azure AD và DokoKin API
- Dùng `--revoke` khi không cần nữa hoặc nghi bị leak

## User Info (current setup)

- **Username**: TanVC
- **Full name**: Vu Cao Tan / Tan Vu Cao
- **Email**: tanvc@fpt.com
- **Employee ID**: 8883
