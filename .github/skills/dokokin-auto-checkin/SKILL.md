---
name: dokokin-auto-checkin
description: 'Auto checkin/checkout DokoKin (FJP kintai) via Azure AD. USE WHEN: user asks to checkin, checkout, check attendance status, setup DokoKin login, or schedule daily auto checkin/checkout. Wraps the auto_checkin.py script that authenticates via Azure AD (PKCE + mobile redirect), exchanges for DokoKin API token, and calls the dakoku endpoint with GPS coordinates. Supports: setup (first-time Azure AD login), instant checkin/checkout, today status check, Task Scheduler setup for daily automation. DO NOT USE FOR: other FJP services (Rakuraku, Jira sync); modifying DokoKin Flutter app source code; anything unrelated to kintai/attendance.'
argument-hint: 'checkin | checkout | status | setup | schedule'
---

# DokoKin Auto Checkin/Checkout

Tự động checkin/checkout trên hệ thống kintai DokoKin (FJP) bằng Azure AD — tương đương nhấn nút trên app mobile.

## When to Use

- User nói "checkin", "checkout", "đánh công", "chấm công", "kintai"
- User muốn xem trạng thái chấm công hôm nay
- User muốn setup lần đầu (đăng nhập Azure AD)
- User muốn tạo lịch tự động checkin/checkout hàng ngày

## Prerequisites

- **Python 3.12+** installed (verify: `python --version`)
- **Packages**: `requests`, `schedule` (`pip install requests schedule`)
- **Script**: `scripts/auto_checkin.py` trong workspace `C:\Users\Admin\Downloads\FJP Tool\FJP Tool\`
- **First-time**: phải chạy `--setup` để đăng nhập Azure AD và cache tokens

Nếu chưa install deps:
```powershell
pip install requests schedule
```

## Script Location

```
C:\Users\Admin\Downloads\FJP Tool\FJP Tool\scripts\auto_checkin.py
```

Config & tokens:
- Config: `scripts/checkin_config.json` (checkin_time, checkout_time, GPS, checkin_type)
- Tokens: `scripts/.azure_tokens.json` (Azure AD access + refresh tokens, auto-renewed)
- Log: `scripts/auto_checkin.log`

## Procedure

### Checkin Now (đánh công vào)

```powershell
cd "C:\Users\Admin\Downloads\FJP Tool\FJP Tool"
python scripts/auto_checkin.py --checkin
```

Exit code 0 = thành công. Script tự:
1. Refresh Azure AD token (dùng cached refresh_token, không cần browser)
2. Exchange → DokoKin API token
3. Kiểm tra đã checkin chưa (nếu rồi thì skip)
4. POST dakoku với GPS + checkin type

### Checkout Now (đánh công ra)

```powershell
cd "C:\Users\Admin\Downloads\FJP Tool\FJP Tool"
python scripts/auto_checkin.py --checkout
```

### Check Today Status (xem trạng thái)

```powershell
cd "C:\Users\Admin\Downloads\FJP Tool\FJP Tool"
python scripts/auto_checkin.py --status
```

Output: ngày, giờ checkin, giờ checkout (hoặc `---` nếu chưa).

### Setup (lần đầu / re-login)

```powershell
cd "C:\Users\Admin\Downloads\FJP Tool\FJP Tool"
python scripts/auto_checkin.py --setup
```

Mở browser → đăng nhập Microsoft Azure AD → tự capture auth code qua URL protocol handler → lưu tokens. Chỉ cần chạy 1 lần (refresh token valid ~90 ngày).

**Lưu ý**: Nếu gặp lỗi token expired / 401, chạy lại `--setup`.

### Schedule (chạy loop tự động)

```powershell
cd "C:\Users\Admin\Downloads\FJP Tool\FJP Tool"
python scripts/auto_checkin.py --schedule
```

Chạy scheduler loop: checkin lúc `checkin_time` và checkout lúc `checkout_time` (từ config). Có random delay 0-5 phút để tự nhiên. Ctrl+C để dừng.

### Setup Task Scheduler (Windows — daily auto)

Để tự động hàng ngày không cần mở terminal:

```powershell
# Checkin 9:00 hàng ngày (thứ 2-6)
$action = New-ScheduledTaskAction -Execute "python" -Argument '"C:\Users\Admin\Downloads\FJP Tool\FJP Tool\scripts\auto_checkin.py" --checkin' -WorkingDirectory "C:\Users\Admin\Downloads\FJP Tool\FJP Tool\scripts"
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At 09:00
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName "DokoKin-Checkin" -Action $action -Trigger $trigger -Settings $settings -Description "Auto checkin DokoKin 9h"

# Checkout 18:00 hàng ngày (thứ 2-6)
$action2 = New-ScheduledTaskAction -Execute "python" -Argument '"C:\Users\Admin\Downloads\FJP Tool\FJP Tool\scripts\auto_checkin.py" --checkout' -WorkingDirectory "C:\Users\Admin\Downloads\FJP Tool\FJP Tool\scripts"
$trigger2 = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At 18:00
Register-ScheduledTask -TaskName "DokoKin-Checkout" -Action $action2 -Trigger $trigger2 -Settings $settings -Description "Auto checkout DokoKin 18h"
```

Kiểm tra task đã tạo:
```powershell
Get-ScheduledTask -TaskName "DokoKin-*" | Format-Table TaskName, State, NextRunTime
```

## Config Reference

File: `scripts/checkin_config.json`

| Field | Default | Mô tả |
|---|---|---|
| `checkin_time` | `"09:00"` | Giờ checkin (HH:MM) |
| `checkout_time` | `"18:00"` | Giờ checkout |
| `checkin_type` | `1` | 1=office GPS, 2=direct customer, 3=noGPS, 5=WFH, 6=WFH noGPS |
| `office_latitude` | `35.649213` | Vĩ độ văn phòng |
| `office_longitude` | `0.0` | Kinh độ văn phòng (⚠️ có thể cần update) |
| `app_id` | `"com.fjp.portal"` | App identifier |
| `randomize_minutes` | `5` | Random delay (phút) khi schedule |

Sửa config:
```powershell
# Đổi giờ checkin
python -c "import json; c=json.load(open('scripts/checkin_config.json')); c['checkin_time']='08:30'; json.dump(c,open('scripts/checkin_config.json','w'),indent=2)"
```

## Azure AD Auth — Technical Details

- **App ID**: `f5be0f68-7285-4365-b979-10af0f3f4106` (DokoKin)
- **Tenant**: `f01e930a-b52e-42b1-b70f-a8882b5d043b`
- **Flow**: OAuth2 Authorization Code + PKCE (public client)
- **Redirect URI**: `msauth.com.fjp.portal://auth` (Flutter app's mobile URI)
- **Scope**: `api://f5be0f68-7285-4365-b979-10af0f3f4106/openid user.read offline_access`
- Script registers a Windows URL protocol handler (`HKCU\Software\Classes\msauth.com.fjp.portal`) để capture auth code từ browser redirect
- Refresh token valid ~90 ngày → headless operation không cần browser
- Khi refresh token hết hạn → chạy `--setup` lại

## DokoKin API Reference

| Endpoint | Method | Mô tả |
|---|---|---|
| `api/token` | POST | Login (azure_ad_token → DokoKin token) |
| `api/dakoku` | POST | Checkin/checkout |
| `api/dakoku/me/{date}` | GET | Record hôm nay |
| `api/employee/profile` | GET | Thông tin nhân viên |
| `api/dakoku/workplace` | GET | Tọa độ văn phòng |

Headers: `Authorization: Bearer <token>`, `Module: KINTAI`

## Troubleshooting

| Triệu chứng | Nguyên nhân | Fix |
|---|---|---|
| `401 Unauthorized` | Token expired | Chạy `--setup` lại |
| `AADSTS7000218` | Thử dùng sai flow (device code / localhost redirect) | Script đã dùng đúng mobile redirect + PKCE, không cần sửa |
| `Connection error` | VPN / network | Kiểm tra kết nối đến `api.fjpservice.com` |
| `Đã checkin rồi` | Đã checkin hôm nay | Script tự skip — đây là expected behavior |
| `longitude = 0.0` | Workplace API không trả kinh độ | Sửa thủ công trong `checkin_config.json` |
| `ModuleNotFoundError: schedule` | Chưa install | `pip install schedule` |
| Python not found | Chưa install / chưa trong PATH | `winget install Python.Python.3.12` rồi restart terminal |

## Safety Rules

- Tokens chỉ lưu local trong `scripts/.azure_tokens.json` — **không commit lên git**
- Script chỉ gọi đúng endpoint mà app mobile dùng — không hack hay bypass
- Checkin type phải khớp với thực tế (office = 1, WFH = 5)
- Nếu gặp lỗi lạ, dừng lại và báo user — không retry vô hạn

## User Info (current setup)

- **Username**: TanVC
- **Full name**: Vu Cao Tan
- **Employee ID**: 8883
