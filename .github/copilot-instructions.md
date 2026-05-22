# Copilot Instructions — Finance / DokoKin Automation Project

Tự động hóa nghiệp vụ kintai (chấm công) FJP DokoKin + báo cáo OT + dự báo JPY, vận hành hoàn toàn trên **GitHub Actions** với một dashboard PWA hosted trên **GitHub Pages**. Người dùng chính: **TanVC (Vu Cao Tan, EmpID 8883)**.

> 🇻🇳 User nói tiếng Việt. Trả lời tiếng Việt, code/log/identifier giữ tiếng Anh. Giữ phong cách ngắn gọn, đi thẳng vào vấn đề.

---

## 1. Kiến trúc tổng thể

```
┌───────────────────────────┐      ┌─────────────────────────────┐
│  PWA Dashboard (GH Pages) │◄────►│  Gist (scheduled-runs.json) │
│  docs/  — static, no BE   │      │  abc2a47c0a396025a72a6580…  │
└──────────┬────────────────┘      └──────────────┬──────────────┘
           │ workflow_dispatch                    │ read/write
           ▼                                      ▼
   ┌──────────────────────────────────────────────────────┐
   │  External pingers (off-GitHub, defeat cron skip)     │
   │  • Cloudflare Worker `dokokin-heartbeat` cron */2    │
   │  • cron-job.org HTTP cronjob every 5 min             │
   │  → POST repository_dispatch event_type=heartbeat     │
   └────────────┬─────────────────────────────────────────┘
                ▼
   ┌──────────────────────────────────────────────────────┐
   │  GitHub Actions (heart = scheduled-dispatch.yml)     │
   │  • self-loop 2h, check Gist mỗi 30s, fire workflow   │
   │  • backup cron */15 + 5,20,35,50 (multi-offset)      │
   │  • watchdog */20 + 7,27,47 + 13,33,53 (3 offset)     │
   │  • heartbeat.yml accept event ngoài → resurrect      │
   └────────────┬─────────────────────────────────────────┘
                ▼
   ┌──────────────────────────────────────────────────────┐
   │  Worker workflows: checkin / checkout / ot-creator   │
   │  / jpy-forecast / ot-report / schedule-generator …   │
   │  → gọi DokoKin API hoặc gửi mail/LINE                │
   └──────────────────────────────────────────────────────┘
```

- Repo **public** → GitHub Actions minutes = **unlimited** (không lo billing).
- Không có backend riêng. Mọi state nằm ở **Gist** hoặc **GitHub Actions logs**.

---

## 2. Files & directories quan trọng

### Frontend dashboard — `docs/`
| File | Vai trò |
|---|---|
| `docs/index.html` | Layout, 3 tab (Dashboard / Schedule / Settings), modals, **inline theme bootstrap** trong `<head>` để tránh FOUC |
| `docs/manifest.json` | PWA manifest (name, icons, standalone display, theme_color) — cần thiết để "Add to Home Screen" + biometric chỉ bật trong PWA mode |
| `docs/js/app.js` | Auth (vault encryption), router `navigate()`, `apiFetch()` (ETag cache), entry-point `showDashboard()`, bootstrap orchestration (Theme.init → biometric → CloudSync) |
| `docs/js/dashboard.js` | Adaptive polling engine (1s/15s/60s), `refresh()` workflow runs, CloudSync pull on focus/visibility |
| `docs/js/schedule.js` | CRUD schedule Gist, precision setTimeout dispatcher, location field |
| `docs/js/settings.js` | PAT/passphrase, Location Settings, CloudSync status, Biometric status, **Theme switcher** (Auto/Light/Dark) |
| `docs/js/ot-planner.js` | OT Planner — CRUD OT requests trong Gist `ot-requests.json`, conflict detect + auto-fix cross-midnight, **OT Optimizer rev3** (pure-night greedy đạt full 75h) |
| `docs/js/ot-salary.js` | OT salary calculator (¥/h breakdown, payslip baseline, insurance grades) |
| `docs/js/locations.js` | Built-in locations + user-defined |
| **`docs/js/cloud-sync.js`** | Cross-device settings sync via Gist `user-settings.json` — LWW, debounced push, ETag pull, `applyToUI()` re-render hub |
| **`docs/js/biometric.js`** | WebAuthn Face ID / Touch ID / Windows Hello unlock — 2 tiers (PRF crypto-bound + gate fallback). PWA-only. |
| **`docs/js/theme.js`** | Light/Dark/Auto theme controller — applies `data-theme` attribute, listens `prefers-color-scheme`, syncs via CloudSync |
| `docs/js/icons.js`, `no-autofill.js` | Tiện ích (Lucide icon paths + autofill prevention) |
| `docs/css/style.css` | Single CSS file. `:root` (dark default) + `[data-theme="light"]` block. `--tint` var (255/0) flips white overlays automatically. |

### Backend logic — `.github/scripts/`
| File | Vai trò |
|---|---|
| `gh_checkin.py` | Checkin/checkout DokoKin, gửi email + LINE on failure |
| `gh_ot_creator.py` | Tự tạo OT request từ `schedule.json` (cửa sổ 7 ngày) |
| `ot_report.py` | Báo cáo OT cuối tháng |
| `schedule.json` | Lịch OT pending + working hours |
| `generate_schedule.py` | Sinh `schedule.json` từ template |
| `daily_validation.py` | Sanity check trạng thái hằng ngày |
| `token_monitor.py` | Kiểm tra Azure refresh token sắp hết hạn |
| `line_notify.py` | Helper push LINE notification |

### Workflows — `.github/workflows/`
| File | Trigger | Mục đích |
|---|---|---|
| **`scheduled-dispatch.yml`** | self-loop 2h + cron `*/15` + `5,20,35,50` | 🫀 **Trái tim** — đọc Gist mỗi 30s, dispatch worker đúng giờ. Multi-cron offset chống cron-skip. |
| `dispatcher-watchdog.yml` | cron `*/20` + `7,27,47` + `13,33,53` | Hồi sinh dispatcher nếu chết quá 10 phút. Email alert khi gap ≥25 phút. |
| **`heartbeat.yml`** | `repository_dispatch` event_type=`heartbeat` | Nhận ping từ external (CF Worker / cron-job.org). Resurrect dispatcher nếu silent >7 phút. Email alert khi gap ≥20 phút. |
| `auto-checkin.yml` | dispatch | Worker checkin (location, lat/long override) |
| `auto-checkout.yml` | dispatch | Worker checkout (allow re-run nếu now > prev_CO) |
| `auto-ot-creator.yml` | dispatch (10:00 JST) | Worker Auto Request OT — **luôn gửi email summary** |
| `jpy-forecast.yml` | cron | Dự báo tỉ giá JPY/VND |
| `ot-report.yml`, `schedule-generator.yml`, `token-monitor.yml`, `daily-validation.yml` | cron / dispatch | Báo cáo & maintenance |
| `deploy-pages.yml` | push `docs/**` | Deploy PWA |

### Skills — `.github/skills/`
Tham khảo SKILL.md trước khi đụng vào lĩnh vực tương ứng:
- **`dokokin-auto-checkin/`** — script gốc chạy local, **reference implementation** cho DokoKin API (đặc biệt `auto_checkin.py` — đúng field name `displayStartWorkingTime` / `displayEndWorkingTime`)
- **`dokokin-azure-login/`** — Azure AD PKCE flow, redirect URI `msauth.com.fjp.portal://auth`
- **`ot-salary-optimizer/`** — tối ưu OT theo lương
- **`rakuraku-suica-expense/`** — nộp chi phí Suica qua Playwright MCP
- **`suica-pdf-editor/`** — sửa/regenerate PDF Suica
- **`japanese-ocr/`** — OCR Tesseract (jpn / jpn_vert) khi vision tools bị chặn

---

## 3. Key knowledge — đừng quên những điểm này

### DokoKin API
- Base: `https://api.fjpservice.com/api/`
- Header bắt buộc: `Authorization: Bearer <token>`, `Module: KINTAI`
- **Field name đúng** khi đọc trạng thái dakoku (đã bug 1 lần):
  - `startWorkingTime` / `endWorkingTime` (raw)
  - `displayStartWorkingTime` / `displayEndWorkingTime` (string hiển thị)
  - ❌ KHÔNG có `checkinDate` / `checkinTime` / `checkoutDate` / `checkoutTime`
- Endpoint chính: `POST api/token`, `POST api/dakoku`, `GET api/dakoku/me/{date}`, `GET api/dakoku/workplace`
- `checkin_type` (cũng dùng làm `checkoutType` khi CO): 1=CheckIn (FJP Office), 2=DirectCustomer, 3=NoGPS, 5=CheckInWFH, 6=WFH NoGPS
- **`TotalOfBreakTime` is decimal HOURS as a double** (matches Flutter app `convertToDouble(h,m) = h + m/60`). E.g. user picks 01:00 → send `1.0`; 00:45 → `0.75`; no break → `0.0`. ⛔ KHÔNG gửi raw minutes — server interpret 60 thành 60 GIỜ và display "60:00".
- **🚨 Working Place mapping (timesheet column)**: Backend `FJP.DakokuSync/TimesheetImporter.GetWorkingType` auto-derive từ cặp `(CheckinType, CheckoutType)` + cờ `IsCheckinDakoku = (lat==0 && lon==0)`:
  - **type 1 + type 1 + lat=0/lon=0 (cả CI và CO)** → WorkingType=1 = **FJP Office**
  - **type 5 + type 5/6** (with or without GPS) → WorkingType=2 = **WFH**
  - **type 2/4 paired** → WorkingType=0 = **Customer Office**
  - **type 1+5 hoặc 5+1** (office side cần lat=0) → WorkingType=3 = **WFH & FJP Office**
  - **mọi combo khác** (vd type=1 + real GPS, hoặc CI=1 CO=5 mà CI có GPS) → WorkingType=-1 → **cột Working Place TRỐNG** trên timesheet ❌
  - **Quyết định cho `gh_checkin.py` (user prefs)**: luôn dùng `type=2` (DirectCustomer/DirectHome) bất kể `location_key` → timesheet luôn hiển thị "Customer Office". Real GPS coords vẫn gửi bình thường.
  - ⛔ KHÔNG hardcode type=1 — sẽ làm Working Place trống do mismatch IsCheckinDakoku rule.

### 🚨 Kintai business rules — RẤT QUAN TRỌNG (đừng vi phạm khi sửa schedule)

**Rule 1 — 1 ngày chỉ checkin được 1 lần.** DokoKin không cho phép 2 lần checkin cùng ngày. CI buổi sáng đã "mở phiên làm việc" cho cả ngày, **bao gồm cả OT đêm cùng ngày** (vd CI 09:00 cover OT 22:00-03:30).

  → Khi workday đó có OT đêm: **CHỈ có 1 CI lúc 09:00**, KHÔNG được thêm CI lúc 22:00.
  → `generate_schedule.py` đã làm đúng (xem line 93-104: workday+OT → 1 CI + 1 CO next-day 03:30).
  → Khi review/sửa schedule, nếu thấy 2 entries `action: checkin` cùng ngày → **BUG**.

**Rule 2 — Checkout = ĐÓNG PHIÊN làm việc của workday đó. Không thể "mở lại".**

  Khi gọi `POST api/dakoku` với CO, DokoKin set `endWorkingTime` của workday hiện tại = thời điểm CO. **Mọi giờ làm việc/OT SAU CO time đều KHÔNG được tính.** Re-run CO sau đó chỉ có thể UPDATE giờ ra **muộn hơn** (cùng workday), KHÔNG thể bắt đầu lại session.

  → **Hệ quả nguy hiểm với OT vắt qua nửa đêm**: nếu workday có OT request (vd 22:00→03:30 hôm sau) mà có CO firing TRƯỚC giờ OT kết thúc (vd 18:00 cùng ngày, hoặc thậm chí 21:00), workday sẽ **bị đóng tại CO time đó** → **OT bị mất hoàn toàn** mặc dù OT request đã được approve.

  → Ví dụ: ngày T2 CI 09:00, OT request 22:00→03:30(T3). Nếu CO recurring 18:00 (T2) fire trước → endWorkingTime=18:00 → khi 22:00 đến không có "session đang mở" để OT cộng vào. Dù CO 03:30(T3) có chạy đúng cũng vô nghĩa.

  → **Cửa sổ CO hợp lệ cho workday-có-OT-cross-midnight**: CHỈ trong khoảng **[OT_end_time, ~04:00 next-day]**. CO sớm hơn → mất OT. CO muộn hơn ~04:00 → DokoKin coi là ngày mới → fail.

  → **Cửa sổ CO hợp lệ cho workday thường (không OT)**: bất kỳ thời điểm nào sau giờ vào, idempotent re-run OK (chỉ update giờ ra muộn hơn).

  → **Quy tắc cứng khi schedule**:
     - Recurring weekday CO 18:00 (mặc định) → **PHẢI skip** trên những ngày có OT vắt qua nửa đêm (dùng field `skip_dates: [YYYY-MM-DD, ...]` trong recurrence của Gist entry).
     - Trên các ngày đó, thay bằng explicit `once` CO entry tại giờ kết thúc OT (vd 00:00+1, 03:30+1).
     - Mỗi khi tạo OT request cross-midnight cho workday → **đồng thời** thêm date đó vào `skip_dates` của recurring 18:00 CO.

**Rule 3 — Saturday/Sunday OT là exception cho Rule 1**: cuối tuần KHÔNG có CI sáng mặc định, nên OT cuối tuần CẦN có CI riêng tại giờ bắt đầu OT (Sat 22:00, Sun 14:30). Đây không phải "CI lần 2".

**Rule 4 — Checkout idempotency**: cho phép re-run nếu `now > previous_CO` (update giờ ra muộn hơn). Checkin thì skip nếu đã có (Rule 1).

**Implications cho UI/automation**:
- Schedule grid không cảnh báo về double-CI vì generator đã đúng — nhưng nếu user tự thêm recurring CI 22:00 weekly trên cùng workday đã có CI 09:00, sẽ fail tại API. UI cân nhắc warning (TODO).
- OT auto-request (`gh_ot_creator.py`) chỉ tạo OT **request** (申請), KHÔNG tạo CI/CO → không ảnh hưởng Rule 1.
- Dispatcher self-loop không hiểu domain rules — nó dispatch đúng giờ trong Gist. Trách nhiệm "không tạo entry sai" thuộc về generator + người tạo schedule thủ công.

### Azure AD
- App ID `f5be0f68-7285-4365-b979-10af0f3f4106`
- Tenant `f01e930a-b52e-42b1-b70f-a8882b5d043b`
- Scope `api://{AZURE_APP_ID}/openid user.read offline_access`
- Flow: OAuth2 Auth Code + PKCE (public client). Redirect URI = mobile `msauth.com.fjp.portal://auth`.
- **Refresh token rotate**: workflow detect → set output `token_rotated=true` + `new_refresh_token` → step kế `gh secret set AZURE_REFRESH_TOKEN`. Cần secret `GH_PAT` (PAT có scope `repo`).
- Refresh token sống ~90 ngày. Nếu chết → re-run skill `--setup`.

### Schedule Gist
- ID: `abc2a47c0a396025a72a6580227ff493`
- File: `scheduled-runs.json` (dispatcher source of truth — array của entries `once`/`recurring`)
- File: `ot-requests.json` (OT Planner source of truth — array của `{id, date, start, end, hours, reason, kintai_created_at?, auto_skip_date?, auto_co_id?}`). Authoritative khi tồn tại (kể cả empty array). `gh_ot_creator.py` đọc file này qua GH_PAT, sau mỗi run write-back `kintai_created_at` (ISO ts JST, idempotent) cho entries đã tạo HOẶC đã tồn tại trong DokoKin. Fallback `schedule.json:pending_ot` nếu Gist read fail / file missing. Window tạo OT: `[today-1d, today+7d]` (DokoKin cho phép 1 day backward).
- Entry types: `once`, `daily`, `weekly`, `monthly`
- **Lịch sử**: entries `once` đã chạy → set `dispatched: true` + `last_run`, **không xóa** (giữ cho UI hiển thị history)
- UI: `renderScheduledQueue` filter `activeEntries`, `renderScheduleTable` show all
- **Day-of-week convention**: Python Mon=0, JS/Gist Sun=0 → khi convert dùng `js_dow = (dow + 1) % 7 if dow < 6 else 0`

### Scheduled-dispatch (trái tim)
- Self-loop **2h** (default `LOOP_MINUTES=120`): vòng lặp `while elapsed < 7200`, mỗi 30s đọc Gist (qua ETag), dispatch entries quá hạn
- **Cold-start sweep**: log explicit `📋 Cold-start: N overdue entries detected` ở iter đầu để debug post-incident
- Cuối loop: `gh workflow run` chính nó để chain liên tục
- **Code load tại t=0**: trong khi loop chạy, fix mới push KHÔNG áp dụng. Phải cancel run hiện tại + trigger thủ công nếu cần áp dụng gấp.
- **6-layer redundancy** (xem section 10.7):
  1. Cloudflare Worker `*/2` → `repository_dispatch`
  2. cron-job.org `*/5` → `repository_dispatch`
  3. Self-chain (loop 2h re-trigger)
  4. Backup cron `*/15` + `5,20,35,50`
  5. Watchdog `*/20` + 2 offsets
  6. Manual `workflow_dispatch`

### Notification rules
- **Checkin/checkout/Auto Request OT**: luôn gửi mail summary (trừ `skip` cho checkin/checkout)
- **Auto Request OT status badges**: ✅ CREATED / ℹ️ UP-TO-DATE / ⏳ WAITING / 🚨 ERROR / 💤 NO-OP
- **LINE Notify** chỉ kích hoạt `on: failure()` cho worker quan trọng (checkin)
- Helper: `send_email()` dùng SMTP Gmail port 587, secrets `SMTP_USER` / `SMTP_PASS` / `NOTIFY_EMAIL`

### Frontend rules
- **Script load order**: `app.js` → `dashboard.js` → `schedule.js` → `settings.js`. Init code phải nằm trong `DOMContentLoaded` (đã từng bug silent ReferenceError).
- `navigate('#dashboard')` cũng phải gọi `refresh()` + `startPolling()` (defense-in-depth)
- `apiFetch()` dùng in-memory ETag cache → 304 trả cache (tiết kiệm rate limit)
- `isPolling` re-entrancy guard ở đầu `refresh()` — phải đảm bảo reset trong `finally`
- Vault encryption: PBKDF2(passphrase) → AES-GCM mã hoá PAT trong `localStorage`
- Session token (PAT) lưu `sessionStorage` để survive reload nhưng clear khi đóng tab

### Time & locale
- TZ toàn bộ system: **Asia/Tokyo (JST = UTC+9)**. Mọi datetime so sánh phải tz-aware.
- Format ngày user-facing: `YYYY-MM-DD HH:mm JST`
- Workflow YAML: `env: TZ: Asia/Tokyo`

---

## 4. Secrets cần thiết

| Secret | Dùng cho |
|---|---|
| `AZURE_REFRESH_TOKEN` | Azure AD refresh (auto-rotate) |
| `GH_PAT` | Classic PAT, scope `repo` + `gist` + `workflow` — cập nhật secret khi token rotate, dispatch workflow từ frontend |
| `SMTP_USER`, `SMTP_PASS` | Gmail SMTP gửi mail (`SMTP_PASS` = App Password) |
| `NOTIFY_EMAIL` | Email người nhận thông báo |
| `LINE_NOTIFY_TOKEN` | LINE Notify push (failure) |

---

## 5. Conventions & rules

### Code style
- Python stdlib only (workflows tránh `pip install` để chạy nhanh)
- JS vanilla, no framework. Tailwind CDN cho utility classes.
- Comments: chỉ comment khi cần làm rõ. Tránh comment thừa.
- Identifiers tiếng Anh. Log message có thể tiếng Việt khi user-facing.

### Git
- Commit message: subject ngắn (≤72 char), kèm body giải thích **lý do** + **scope**
- Trailer bắt buộc: `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`
- ⚠️ Có dev thứ 2 ("Đào Minh Tú") cùng push lên `main` — luôn `git pull --rebase` trước push, kiểm tra commit lạ
- ⛔ **Không commit secrets**, token, log file `.azure_tokens.json`, `auto_checkin.log` (đã `.gitignore`)

### Workflow
- Luôn có `timeout-minutes` (worker thường ≤5 phút)
- Dùng `sparse-checkout` để clone gọn
- `concurrency` group để tránh race (vd checkin/checkout)
- Pass secrets qua `env:`, không inline trong `run:`

### Idempotency
- **Checkin**: skip nếu đã có CI hôm nay
- **Checkout**: cho phép re-run nếu `now > previous_CO` (overwrite được)
- **Auto Request OT**: skip entry nếu đã tồn tại trong KINTAI

---

## 6. Khi gặp lỗi — checklist

1. **Schedule không dispatch** → check `scheduled-dispatch` còn chạy không, watchdog logs, Gist có entry đúng không
2. **"No record" sai** → check field name DokoKin API (`startWorkingTime` vs `checkinTime`)
3. **Token expired (401)** → re-run skill `--setup` để renew refresh token rồi `gh secret set`
4. **Dashboard không load** → console log `ReferenceError`? Check script load order + `DOMContentLoaded`
5. **Workflow fix không có hiệu lực** → dispatcher 2h loop dùng code cũ → cancel + re-trigger
6. **Rate limit GitHub API** → kiểm tra ETag caching hoạt động không (`X-Cache-Status: 304`)

---

## 7. References

- DokoKin Skill: `.github/skills/dokokin-auto-checkin/SKILL.md`
- Azure Login Skill: `.github/skills/dokokin-azure-login/SKILL.md`
- Script gốc reference: `.github/skills/dokokin-auto-checkin/scripts/auto_checkin.py`
- Lịch may 2026: `.github/skills/dokokin-auto-checkin/may2026-schedule.md`

---

## 8. UI / Design System

Dashboard là một **PWA dark-mode-only** (`<html class="dark">`), mobile-first, không build step — phục vụ trực tiếp từ GitHub Pages.

### Stack
| Layer | Tool | Notes |
|---|---|---|
| CSS framework | **Tailwind CSS v3** (CDN: `cdn.tailwindcss.com`) | Cấu hình inline trong `<script>tailwind.config = …</script>` (xem `index.html` line ~17) |
| Design system | **shadcn/ui tokens** (color + radius + spacing scale) | Không dùng React components — port sang vanilla HTML/CSS |
| Font sans | **Inter** (400/500/600/700) — Google Fonts | `--font-sans` |
| Font mono | **JetBrains Mono** (400/500/600/700) | `--font-mono` — dùng cho time, JSON, ID |
| Icons | **Lucide-style SVG** inline (`docs/js/icons.js`) | Không phải lib ngoài — `ICON_PATHS` map + helper `ICON(name, size, extraClass)`. Thêm icon mới: thêm path vào `ICON_PATHS`. |
| Animations | Tailwind keyframes + custom CSS | `shimmer`, `fade-in`, `modal-in`, `page-in`, `sheet-up` |
| Static HTML | Tailwind utility classes trực tiếp | Style trong `<class="...">` |
| JS-generated HTML | CSS classes + CSS variables từ `style.css` | Để dễ thay theme/token một chỗ |

### Design tokens — `:root` trong `style.css`
**Colors** (dark theme):
- Background scale: `--background #09090b` → `--card #0a0a0a` → `--muted #171717` → `--secondary #1e1e1e`
- Foreground: `--foreground #fafafa`, `--muted-foreground #a1a1aa`
- Brand: `--primary #3b82f6` (blue), `--ring` same
- Semantic: `--green #22c55e`, `--red #ef4444`, `--yellow #eab308`, `--purple #a855f7`, `--orange #f97316` + matching `*-subtle` rgba 0.1
- Borders: `--border rgba(255,255,255,0.08)`, `--input rgba(255,255,255,0.12)`

**Spacing** (4px base):
- `--sp-1`..`--sp-8` = 4 / 8 / 12 / 16 / 20 / 24 / 32 px

**Radius**:
- `--radius-sm 0.375rem` / `--radius-md 0.5rem` / `--radius-lg 0.625rem` (default) / `--radius-xl 0.875rem` / `--radius-full 9999px`

**Typography scale**:
- `--fs-xs 12px` / `--fs-sm 13px` / `--fs-base 14px` / `--fs-md 16px`

**Shadows**:
- `--shadow-sm`, `--shadow-md`, `--shadow-lg`, `--shadow-glow` (blue focus ring)

**Motion**:
- `--duration-fast 150ms` / `--duration-normal 200ms` / `--duration-slow 300ms`
- `--ease-out cubic-bezier(0.16, 1, 0.3, 1)` — chuẩn shadcn easing

### Component patterns (đã port từ shadcn/ui)
| Component | Tên class chính | File định nghĩa |
|---|---|---|
| Card | `.card` + `.card-header` / `.card-body` / `.card-footer` | `style.css` |
| Button | `.btn`, `.btn-primary`, `.btn-secondary`, `.btn-ghost`, `.btn-destructive` | `style.css` |
| Input | `.input`, `.select`, `.textarea` | `style.css` |
| Badge / Status | `.status-badge`, `.status-running`, `.status-success`, `.status-failure` | `style.css` |
| Modal / Dialog | `.modal` + `.modal-content` (animation `modal-in`) | `style.css` |
| Toast | `#toast` + `.toast.show` + variants `error`/`warning` | `style.css` + `toast()` trong `app.js` |
| Tabs | `.tabs-trigger.nav-item` + `aria-selected` | `index.html` + `navigate()` |
| Live indicator | `.live-indicator.active/paused/error` | `style.css` + `updateLiveIndicator()` |
| Page transition | `.page` + `.page.active` (animation `page-in`) | `style.css` |

### Quy tắc khi thêm UI
1. **Ưu tiên Tailwind utility** cho HTML tĩnh (`<div class="flex gap-2 …">`)
2. **Dùng CSS variable** (`var(--primary)`) khi viết CSS hoặc JS-generated style — KHÔNG hardcode hex để giữ tính nhất quán
3. **Icon mới**: thêm path SVG vào `ICON_PATHS` trong `icons.js` (giữ stroke-width 2, 24×24 viewBox)
4. **Animation mới**: định nghĩa keyframe trong `tailwind.config.keyframes` HOẶC `style.css` `@keyframes`
5. **Accessibility**: giữ `role`, `aria-label`, `aria-selected` trên tabs/buttons/dialogs
6. **Mobile-first**: test với DevTools mobile emulator. Có `--mobile-nav-height 72px` cho bottom nav. Viewport `user-scalable=no` để PWA giống native.
7. **Không thêm dark-mode toggle** — app cố tình dark-only (đỡ phức tạp + match brand)
8. **Không import UI lib nặng** (React/Vue/Svelte/Material) — giữ zero-build, dependency tối thiểu
9. **Scrollable element BẮT BUỘC dùng shadcn ScrollArea look** ([reference](https://ui.shadcn.com/docs/components/radix/scroll-area)) — KHÔNG để default scrollbar của browser xuất hiện ở bất kỳ surface nào. Khi thêm container có `overflow:auto/scroll/y/x`:
   - **Cách 1** (preferred, static class): thêm selector vào `:where()` selector list trong `style.css` block đánh dấu `shadcn/ui ScrollArea` (~line 1700). Lưu ý: list được lặp 6 lần (base + 5 webkit pseudo-elements) → grep + sửa hết, hoặc dùng PowerShell `.Replace(...)` 1 lượt.
   - **Cách 2** (dynamic/JS-injected content): thêm attribute `data-scroll-area` vào element thay vì class — selector list đã có `[data-scroll-area]` ở cuối.
   - **Cách 3** (full Radix wrapper, log/large content): dùng `<div class="scroll-area"><div class="scroll-area-viewport">…</div></div>`.
   - ⛔ **KHÔNG viết per-element `::-webkit-scrollbar` rules** — duplicate với global treatment, sẽ override không nhất quán; nếu cần customize width thì thêm CSS var override trên element đó.
   - ⛔ Code review checklist: mỗi PR có thêm `overflow:auto/scroll` mới → reviewer PHẢI verify element đã xuất hiện trong `:where()` list HOẶC có `data-scroll-area`.

### Quy tắc áp dụng Design System triệt để

Dự án dùng **shadcn/ui design system** (port sang vanilla HTML/CSS — không React). Mọi component UI mới HOẶC chỉnh sửa component cũ PHẢI tuân thủ:

1. **Tokens, không hardcode**:
   - Color → `var(--primary)`, `var(--muted-foreground)`, `var(--border)`, `rgba(var(--tint),X)`… (không `#fff`, không `rgba(255,255,255,X)`)
   - Spacing → `var(--sp-1..8)` (4/8/12/16/20/24/32px) — không `padding:13px`
   - Radius → `var(--radius-sm/md/lg/xl/full)` — không `border-radius:7px`
   - Font size → `var(--fs-xs/sm/base/md)` — không `font-size:11px`
   - Motion → `var(--duration-fast/normal/slow)` + `var(--ease-out)`
   - Shadow → `var(--shadow-sm/md/lg/glow)`

2. **Component primitives có sẵn — KHÔNG tự viết lại từ đầu**:
   | Cần | Class/wrapper |
   |---|---|
   | Container | `.card` + `.card-header/body/footer` |
   | Button | `.btn` + variant (`btn-primary`, `btn-secondary`, `btn-ghost`, `btn-destructive`) |
   | Input/select/textarea | `.input`, `.select`, `.textarea` |
   | Badge/Status | `.status-badge` + `.status-running/success/failure` |
   | Modal | `.modal` + `.modal-content` (animation `modal-in`) |
   | Toast | `toast()` helper trong `app.js` |
   | Tabs | `.tabs-trigger` + `aria-selected` |
   | **Scrollable** | shadcn ScrollArea (xem rule 9) |
   | **Spinner / loading** | `.ai-thinking-spinner` (conic-gradient ring) hoặc `.ai-spin` |

3. **Refactor trước khi tạo mới**: trước khi viết 1 component CSS mới, grep `style.css` xem đã có primitive tương tự chưa. Nếu có → dùng/extend. Nếu phải tạo mới → đặt tên + tokens nhất quán với existing.

4. **Cấm tuyệt đối**:
   - ⛔ Inline `style="..."` cho thuộc tính UI (color/font/spacing) — chỉ chấp nhận inline cho dynamic giá trị JS tính ra (vd `transform: translate(${x}px)`)
   - ⛔ `!important` trừ khi defeat third-party (Tailwind CDN edge case) — phải comment giải thích
   - ⛔ Hardcode hex/rgba ngoài file `style.css` `:root` definitions
   - ⛔ Custom scrollbar per-element (xem rule 9)
   - ⛔ Custom font stack ngoài `--font-sans` (Inter) và `--font-mono` (JetBrains Mono)

5. **Khi review/diff CSS mới**:
   - Grep PR diff cho `#[0-9a-f]{3,6}` → flag hardcoded color
   - Grep cho `px;` ở properties UI → flag arbitrary spacing (cho phép `1px` border, `0` reset)
   - Grep cho `::-webkit-scrollbar` ngoài block global → flag scroll-area violation
   - Grep cho `font-family:` ngoài `:root` + `.ai-code/.ai-inline-code` → flag custom font

### PWA assets
- `theme-color` = `#09090b` (match background)
- `apple-mobile-web-app-capable=yes` + `status-bar-style=black-translucent`
- TODO: chưa có service worker / manifest.json đầy đủ — chỉ là "Add to Home Screen" capable

### External CDN dependencies (cần kết nối internet để dashboard chạy)
| URL | Purpose |
|---|---|
| `https://cdn.tailwindcss.com` | Tailwind runtime |
| `https://fonts.googleapis.com/css2?family=Inter…JetBrains+Mono…` | Web fonts |
| `https://api.github.com/*` | GitHub REST API (workflows, runs, gists) |

---

## 9. System Design — core components & flows

### 9.1 Vai trò các thành phần (separation of concerns)

| Layer | Trách nhiệm | KHÔNG được làm |
|---|---|---|
| **PWA (`docs/`)** | UI, CRUD Gist schedule, dispatch workflow on-demand qua GitHub API, hiển thị status | Gọi DokoKin API trực tiếp (PAT không có quyền), giữ state ngoài Gist/sessionStorage |
| **Gist** | Source of truth cho lịch chạy + history | Lưu secret/PII (chỉ public Gist) |
| **`scheduled-dispatch.yml`** | Trigger worker đúng giờ (server-side) | Thực thi business logic (chỉ dispatch) |
| **Worker workflows** | 1 nghiệp vụ duy nhất / 1 lần chạy, idempotent, exit code rõ ràng | Phụ thuộc state từ run trước (mỗi run là ephemeral) |
| **Skill scripts** (`.github/skills/*/scripts`) | Reference impl chạy local, **không được import trực tiếp** bởi workflow | Auto-trigger từ Actions (chỉ chạy thủ công local) |

### 9.2 Core flow #1 — User tạo Once Schedule trên UI

```
User clicks "Add Schedule"
  └─► docs/js/schedule.js: addScheduledRun()
        ├─ Validate form (datetime > now, workflow chosen, location nếu cần)
        ├─ Fetch Gist hiện tại (apiFetch với ETag cache)
        ├─ Append entry { id, type:'once', workflow, datetime, location, ... }
        ├─ PATCH Gist với JSON mới
        └─ scheduleNextDispatch(entries)   ← precision setTimeout client-side
              └─ Nếu entry sẽ fire trong < 5 phút:
                  setTimeout(clientSideDispatchOverdue, delay_ms)
                  → dispatch chính xác đến milisecond khi user mở dashboard
```

**Đảm bảo đúng giờ qua nhiều cơ chế chồng nhau** (6 layer redundancy, xem section 10.7):
1. **External heartbeat** — Cloudflare Worker `*/2` + cron-job.org `*/5` → `repository_dispatch` → resurrect dispatcher (off-GitHub, không bị cron-skip)
2. **Client setTimeout** — dispatch chính xác tại millisecond nếu user đang mở tab
3. **Server self-loop** (`scheduled-dispatch.yml` 2h loop, check Gist mỗi 30s) — không cần user mở browser
4. **Backup cron** `*/15` + `5,20,35,50` (multi-offset chống cron skip)
5. **Watchdog** `*/20` + `7,27,47` + `13,33,53` — 3 cron offset độc lập
6. **Manual** `gh workflow run` (last resort)

→ **Worst case latency** sau ngày 21/5/2026: ~10 phút (5min CF cron + 7min silence threshold). **Best case**: 0ms (client setTimeout). **Trước đây từng có gap 9 giờ** khi GitHub cron skip → motivated 6-layer design.

### 9.3 Core flow #2 — Scheduled dispatch loop (heart of system)

```
[T=0] scheduled-dispatch.yml triggered (cron */15, 5,20,35,50, workflow_dispatch hoặc self-chain)
  │
  ├─► Job timeout 350 phút (loop chạy 120 phút = 2h)
  │
  ├─► COLD-START SWEEP (iter 0): log số entry quá hạn để debug post-incident
  │
  ├─► LOOP (every 30s):
  │     ├─ GET Gist (If-None-Match: <etag>)
  │     │    └─ 304 → dùng cached
  │     │    └─ 200 → parse, save etag
  │     ├─ For each entry:
  │     │    ├─ Compute next_fire_time (theo type: once/daily/weekly/monthly)
  │     │    ├─ If now >= next_fire_time AND not yet dispatched in this cycle:
  │     │    │    ├─ POST /repos/{owner}/{repo}/actions/workflows/{wf}/dispatches
  │     │    │    │     with inputs: { location, latitude, longitude }
  │     │    │    ├─ Mark once-entry: dispatched=true, last_run=now
  │     │    │    └─ PATCH Gist với updated entries (KHÔNG xóa entry)
  │     │    └─ Daily/weekly/monthly: chỉ update last_run, không mark dispatched
  │     └─ sleep 30s
  │
  └─► [T=2h] Loop kết thúc → gh workflow run scheduled-dispatch.yml (self re-chain)
        → Chain liên tục, "trái tim" không bao giờ ngưng
```

**Lý do dùng self-loop thay vì cron `*/1`**:
- Cron GitHub thường trễ 5-30 phút khi workflow ít được sử dụng (đã từng skip 9 giờ liên tục)
- Self-loop = 1 process duy nhất, đảm bảo check liên tục mỗi 30s
- Tiết kiệm minute (1 run 2h ≈ 120 min, vs 120 cron run riêng cũng = 120 min nhưng có overhead startup mỗi lần)

**Lý do giảm 5h → 2h** (commit 7d4ad96): chain-failure gap window thu nhỏ 2.5×. Nếu self-chain fail (rare), backup cron / external pinger sẽ catch trong vòng phút thay vì 5h. Overhead startup ~10s/run × 12 run/ngày = 120s/ngày — negligible.

**Caveat quan trọng**: code Python được load tại t=0 của loop. **Fix mới push KHÔNG áp dụng** cho loop đang chạy. Phải cancel run + manual trigger nếu fix gấp.

### 9.4 Core flow #3 — Worker (checkin example)

```
auto-checkin.yml triggered (workflow_dispatch)
  │
  ├─ inputs: { location, latitude, longitude }
  ├─ env.TZ=Asia/Tokyo, secrets injected
  │
  └─► gh_checkin.py main():
        ├─ Refresh Azure AD token (POST oauth2/v2.0/token, grant=refresh_token)
        │    └─ Nếu refresh_token rotate → set GITHUB_OUTPUT token_rotated=true
        ├─ Exchange Azure token → DokoKin API token (POST api/token)
        ├─ Resolve location → GPS coordinates (override > schedule.json > default)
        ├─ Get current dakoku status (GET api/dakoku/me/{today})
        │    └─ Đọc startWorkingTime / endWorkingTime ⚠️ (không phải checkinTime)
        ├─ Idempotency check:
        │    ├─ Checkin: skip nếu đã có CI hôm nay
        │    └─ Checkout: skip CHỈ KHI prev_CO >= now (cho phép update)
        ├─ POST api/dakoku với { lat, lng, type: checkin_type }
        ├─ Verify status sau khi action
        ├─ send_email(subject với emoji status, body=LOG_LINES + HTML)
        └─ Nếu fail → exit 1 → step "LINE Notify on failure" fire
        
  Post-job:
    ├─ Nếu token_rotated → gh secret set AZURE_REFRESH_TOKEN <new>
    └─ Workflow run logs hiển thị trong PWA dashboard qua GH API
```

### 9.5 Core flow #4 — Dashboard live polling (adaptive)

```
showDashboard() (sau auth/restore session)
  ├─► startPolling() → schedulePoll() (setTimeout pollInterval=15s)
  └─► refresh() (immediate first call)
        │
        ├─ if isPolling: return    ← re-entrancy guard
        ├─ isPolling = true
        ├─ try:
        │    ├─ if hasRunningWorkflows:
        │    │    └─ FAST PATH: 2 API calls (in_progress + recent), merge
        │    │       → POLL_FAST=1s khi có run đang chạy
        │    └─ else:
        │       └─ NORMAL: per-workflow fetch (4 calls Promise.all)
        │          → POLL_NORMAL=15s
        ├─ Render workflowGrid + recentRuns
        ├─ hasRunningWorkflows = any(run.status in [in_progress, queued])
        ├─ adjustPollRate() → reschedule với interval mới
        ├─ detectStatusChanges() → toast khi workflow chuyển trạng thái
        └─ finally: isPolling = false

Visibility events:
  ├─ document.hidden → POLL_SLOW=60s, indicator='paused'
  ├─ visible again → restore tốc độ + refresh ngay
  └─ window.focus → refresh ngay (kể cả khi đang isPolling chạy)
```

**Tối ưu**: dùng **ETag cache trong-memory** (`Map<url, {etag, data}>`). GitHub API 304 không trả body → trả cached data → tiết kiệm rate limit (5000 req/h cho authenticated).

### 9.6 Core flow #5 — Resilience (multi-layer)

```
LAYER 1: External pingers (off-GitHub, most reliable)
  ├─ Cloudflare Worker `dokokin-heartbeat` cron */2
  │    URL: https://dokokin-heartbeat.workflow-dashboard.workers.dev
  │    Source: cloudflare-worker/heartbeat.js
  │    POSTs `repository_dispatch` event_type=heartbeat
  └─ cron-job.org HTTP cronjob every 5 min
       Same payload, same endpoint
                       ▼
heartbeat.yml (on: repository_dispatch)
  ├─ Check dispatcher state + recent runs
  ├─ If silent > 7 min: POST /dispatches → resurrect
  └─ If silent ≥ 20 min: send_alert email

LAYER 2: GitHub-side watchdog (3 cron offsets)
dispatcher-watchdog.yml (cron */20, 7,27,47, 13,33,53)
  ├─ Same logic as heartbeat
  └─ If silent ≥ 25 min: send_alert email

LAYER 3: Dispatcher backup cron (2 offsets)
scheduled-dispatch.yml (cron */15, 5,20,35,50)
  └─ Auto-fire even if self-chain breaks
```

→ Hệ thống self-healing 6-layer, không cần monitor thủ công. Email alert tự động kích hoạt khi gap vượt threshold (xem section 10.7 chi tiết).

### 9.7 Data model — Gist `scheduled-runs.json`

```jsonc
{
  "entries": [
    {
      "id": "uuid-1",
      "type": "once",                     // once | daily | weekly | monthly
      "workflow": "auto-checkin.yml",
      "datetime": "2026-05-19T09:00:00+09:00",  // ISO với tz
      "location": "office",               // optional
      "latitude": "35.649213",            // optional override
      "longitude": "139.7...",            // optional override
      "note": "test schedule",
      "created_at": "2026-05-18T19:25:00+09:00",
      "dispatched": false,                // chỉ với type=once
      "last_run": null                    // ISO timestamp khi dispatch lần cuối
    },
    {
      "id": "uuid-2",
      "type": "weekly",
      "workflow": "auto-checkout.yml",
      "time": "18:00",                    // HH:MM JST
      "days_of_week": [1, 2, 3, 4, 5],   // JS convention: Sun=0
      ...
    }
  ],
  "locations": {                          // user-defined (built-in trong locations.js)
    "client-A": { "name": "Client A office", "lat": "...", "lng": "..." }
  }
}
```

### 9.8 Security model

| Asset | Storage | Encryption |
|---|---|---|
| GitHub PAT | `localStorage` của browser | AES-GCM với key derive từ passphrase qua PBKDF2 (100k iterations) |
| Active session token | `sessionStorage` | Plain (survive reload, clear tab close) |
| Azure refresh token | GitHub Secrets | GitHub native encryption, auto-rotate via `gh secret set` |
| API tokens (Azure, DokoKin) | Memory only trong worker run | Không persist |
| Gist content | Public Gist | Không lưu PII/secret (chỉ schedule metadata) |

**Auto-lock**: dashboard tự logout sau 30 phút idle (clear `sessionToken`).

### 9.9 Tại sao thiết kế "weird" như này?

| Decision | Lý do |
|---|---|
| Không backend / không DB | Tận dụng GitHub free tier 100%, repo public = unlimited Actions minutes |
| Gist làm storage | API có sẵn, có ETag, có version history, miễn phí |
| Self-loop thay vì cron */1 | Cron GitHub trễ + min interval 5 min cho new workflow |
| Worker tách riêng từng nghiệp vụ | Dễ debug, retry độc lập, idempotent dễ verify |
| PWA dark-only zero-build | Triển khai 1 click qua GH Pages, không cần CI build |
| Skill local + Worker GH Actions song song | Skill = reference impl + emergency manual; Worker = production automation |

---

## 10. 🫀 Scheduled Run Dispatcher — deep dive

> **Đây là component quan trọng NHẤT của hệ thống.** Mọi schedule (checkin/checkout/OT/forecast) đều phụ thuộc vào nó. Khi đụng đến file `scheduled-dispatch.yml`, đọc kỹ section này trước.

### 10.1 Hồ sơ kỹ thuật

| Thuộc tính | Giá trị |
|---|---|
| File | `.github/workflows/scheduled-dispatch.yml` |
| Workflow name | `Scheduled Run Dispatcher` |
| Runner | `ubuntu-latest` |
| Job timeout | **350 phút** (5h50m, cao hơn loop để cho buffer cleanup) |
| Loop duration | **120 phút mặc định** (2h, có thể override qua `loop_minutes` input, max ~330) |
| Check interval | **30 giây** (`CHECK_INTERVAL_SEC = 30`) |
| Permissions | `contents: read`, `actions: write` (cần `actions:write` để dispatch worker) |
| Concurrency | `group: scheduled-dispatch`, `cancel-in-progress: false` (không cancel run đang chạy khi trigger mới) |
| Triggers | `cron: '*/15 * * * *'` + `cron: '5,20,35,50 * * * *'` (multi-offset backup) + `workflow_dispatch` (self re-chain) |
| Dependencies | Chỉ Python stdlib (`urllib`, `json`, `time`, `datetime`) — không `pip install` để cold-start nhanh |
| Secrets | `GH_PAT` (PAT classic với scope `repo` + `workflow` + `gist`) |
| State | Stateless trong từng run; persistent state trong Gist + ETag cache trong-process |

### 10.2 Anatomy — 2 steps trong job

```
job: dispatch
├── step 1: "Self-looping dispatcher (checks every 30s)"
│   └── inline Python script (~150 lines, heredoc `python3 << 'EOF'`)
│       runs the 5h loop
│
└── step 2: "Re-trigger self (chain next run)"   ← always() runs even on failure
    ├── gh api .../workflows/scheduled-dispatch.yml/enable --method PUT
    │   (giữ workflow enabled — GitHub auto-disable workflow 60 ngày không hoạt động)
    └── gh workflow run scheduled-dispatch.yml --ref main
        (tự chain → loop tiếp tục vô tận)
```

### 10.3 The main loop (pseudocode)

```python
loop_start = now()
loop_end   = loop_start + 5h
iteration  = 0
gist_etag  = None       # ETag cache (in-process)
cached_runs = None      # data cache khi server trả 304

while now() < loop_end:
    iteration += 1
    try:
        triggered = process_runs()    # ← core logic, xem 10.4
        if triggered > 0:
            log(f"[iter {iteration}] dispatched {triggered}")
    except Exception as e:
        log(f"[iter {iteration}] error: {e}")    # nuốt exception, không crash loop
    sleep(min(30s, time_remaining))

# Loop ended — step 2 chain next run
```

**Đặc điểm quan trọng**:
- ✅ Exception trong iteration KHÔNG crash loop (try/except wrap)
- ✅ Sleep tối đa = `min(30s, remaining)` → không sleep quá thời gian loop_end
- ✅ Iteration count + dispatch count log mỗi vòng → dễ trace
- ❌ KHÔNG có graceful shutdown signal handler (SIGTERM → loop chết, step 2 vẫn fire vì `if: always()`)

### 10.4 `process_runs()` — core algorithm

```python
def process_runs() -> int:
    runs = gist_read()                        # ETag conditional GET
    if not runs: return 0
    now     = utc_now()
    now_jst = now.astimezone(JST)
    triggered = 0; changed = False
    
    for entry in runs:
        # Build inputs cho workflow dispatch
        inputs = {}
        if entry.get('location'):     inputs['location']  = entry['location']
        if entry.get('location_lat'): inputs['latitude']  = str(entry['location_lat'])
        if entry.get('location_lon'): inputs['longitude'] = str(entry['location_lon'])
        
        if entry['type'] == 'recurring':
            # daily / weekdays / weekly / monthly
            if should_run_recurring(entry, now_jst):
                dispatch_workflow(entry['workflow'], "[recurring]", inputs)
                entry['last_run'] = now.isoformat()   # mark, KHÔNG mark dispatched
                triggered += 1; changed = True
        else:    # 'once'
            if entry.get('dispatched'):     continue   # skip, giữ history
            run_at = parse_iso(entry['run_at'])
            if run_at <= now:
                dispatch_workflow(entry['workflow'], "[one-time]", inputs)
                entry['dispatched'] = True            # mark dispatched
                entry['last_run']   = now.isoformat()
                triggered += 1; changed = True
    
    if changed: gist_write(runs)              # PATCH Gist với entries đã update
    return triggered
```

**Invariants** (đừng phá vỡ khi sửa):
1. **Once entries KHÔNG bị xóa** sau khi dispatch → set `dispatched: true` + `last_run`. UI dùng để hiển thị history.
2. **Recurring entries CHỈ chạy 1 lần / ngày** — `should_run_recurring()` check `last_run.date() == today`.
3. **Cửa sổ "đúng giờ"**: entry chỉ fire khi `now >= run_at` (one-time) hoặc `now >= sched_dt` (recurring). KHÔNG có tolerance window (worst-case 30s latency là OK).
4. **Inputs build từ entry fields**: `location`, `location_lat`, `location_lon` → worker nhận qua `inputs.{location,latitude,longitude}`.

### 10.5 Recurrence patterns (`should_run_recurring`)

| Pattern | Field | Logic |
|---|---|---|
| `daily` | — | Mỗi ngày, tại `time` |
| `weekdays` | — | Mon-Fri (JS DOW `[1,2,3,4,5]`), tại `time` |
| `weekly` | `days: [int]` | Các DOW chỉ định (JS: Sun=0), tại `time` |
| `monthly` | `dates: [int]` | Các ngày trong tháng (1-31), tại `time` |

Validation chung:
- `enabled: false` → skip
- `start_date` / `end_date` (YYYY-MM-DD) → ràng buộc cửa sổ
- `last_run` cùng ngày → skip (đảm bảo 1 lần/ngày)
- `now < sched_dt` (chưa tới giờ) → skip

⚠️ **DOW convention pitfall**: Python `weekday()` Mon=0..Sun=6. Gist/JS Sun=0..Sat=6. Conversion line 136:
```python
js_dow = (dow + 1) % 7 if dow < 6 else 0
```

### 10.6 ETag caching strategy

```python
# Trong gist_read():
if gist_etag:
    req.add_header('If-None-Match', gist_etag)
try:
    resp = urlopen(req)
    gist_etag   = resp.headers.get('ETag')
    cached_runs = parse(resp)
    return cached_runs
except HTTPError as e:
    if e.code == 304 and cached_runs is not None:
        return cached_runs     # ← server không trả body, dùng cache
```

**Lợi ích**: GitHub không tính 304 vào rate limit. Với check 30s × 600 iter = 1200 req/h → vẫn dưới 5000/h limit. **Quan trọng**: ETag chỉ tồn tại trong process — chain next run = reset cache (lần đầu là 200 OK lại).

### 10.7 3 cơ chế redundancy chống chết

```
┌─────────────────────────────────────────────────────────────┐
│  Level 0: EXTERNAL PINGERS (off-GitHub, most reliable)      │
│  • Cloudflare Worker cron */2 (workflow-dashboard.workers.dev) │
│  • cron-job.org HTTP cronjob every 5 min                    │
│  → POST repository_dispatch event_type=heartbeat            │
│  ✓ Không phụ thuộc GitHub cron infrastructure               │
│  ✓ Catch dispatcher gap trong < 7 phút                      │
│  ✗ Nếu cả 2 service ngoài đều down → fallback xuống Level 1 │
└─────────────────────────────────────────────────────────────┘
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  Level 1: HEARTBEAT WORKFLOW (heartbeat.yml)                │
│  Triggered bởi repository_dispatch từ Level 0               │
│  ✓ Resurrect dispatcher nếu silent > 7 phút                 │
│  ✓ Email alert nếu gap ≥ 20 phút                            │
│  ✗ Cần Level 0 push event mới chạy                          │
└─────────────────────────────────────────────────────────────┘
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  Level 2: SELF-CHAIN (primary in-dispatcher)                │
│  Step 2 cuối job → gh workflow run self                     │
│  ✓ Liên tục 24/7, ~12 chain transitions/day với loop 2h     │
│  ✗ Chết nếu: workflow disabled, GH_PAT hết hạn, gh fail     │
└─────────────────────────────────────────────────────────────┘
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  Level 3: BACKUP CRON (multi-offset)                        │
│  cron: '*/15 * * * *' + '5,20,35,50 * * * *'                │
│  ✓ 2 pattern offset → giảm cron-skip risk                   │
│  ✗ GitHub cron có thể trễ 5-30 phút                         │
└─────────────────────────────────────────────────────────────┘
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  Level 4: WATCHDOG (dispatcher-watchdog.yml, 3 offsets)     │
│  cron: '*/20 *' + '7,27,47 *' + '13,33,53 *'                │
│  ✓ Detect dead dispatcher + resurrect + email alert ≥25min  │
│  ✗ Watchdog cũng chết → cần Level 0 hoặc manual             │
└─────────────────────────────────────────────────────────────┘
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  Level 5: MANUAL (last resort)                              │
│  gh workflow run scheduled-dispatch.yml --ref main          │
│  hoặc click "Run workflow" trong Actions UI                 │
└─────────────────────────────────────────────────────────────┘
```

**Sự cố gốc** (2026-05-20): GitHub Actions cron skip 9 giờ → backup cron */15 và watchdog */20 đều fail → entry checkout 03:30 JST chỉ fire lúc 04:33 JST khi dispatcher tự hồi sinh nhờ tolerance window. Sau sự cố, thêm Level 0 (external pingers) + multi-offset cron + email alerts để đảm bảo gap > 10 phút yêu cầu đồng thời 3 hệ thống độc lập đều fail.

### 10.8 Lifecycle timeline ví dụ

```
T=00:00  cron fire → Run #100 bắt đầu
T=00:00  loop iter 1: read Gist (200 OK, ETag=W/"abc")
T=00:30  loop iter 2: read Gist (304 Not Modified, dùng cache)
…
T=09:00  loop iter ~1080: phát hiện entry "auto-checkin 09:00"
         → POST /dispatches auto-checkin.yml { inputs: {location:office} }
         → Worker #500 (auto-checkin) trigger song song
T=09:00  PATCH Gist với entry.last_run=09:00:30
T=09:01  loop iter ~1082: should_run_recurring → False (last_run today)
…
T=05:00  loop kết thúc (300 min)
T=05:00  step 2: gh workflow run self → Run #101 bắt đầu
T=05:00  Run #101 chain seamlessly, không gap
```

### 10.9 Failure modes & cách xử lý

| Triệu chứng | Nguyên nhân | Fix |
|---|---|---|
| Schedule không fire | Dispatcher chết, không có run in_progress | Watchdog resurrect tự động ≤ 20 min, hoặc manual trigger |
| Fix code không có hiệu lực | Loop đang chạy dùng code load tại T=0 | **Cancel run hiện tại** + manual trigger (KHÔNG đợi 5h) |
| Entry fire 2 lần | Race giữa client setTimeout + server loop | Server check `entry.dispatched` ngăn dup; client cũng check |
| Gist write 409 conflict | Concurrent PATCH (rất hiếm) | Iter tiếp theo sẽ refetch + retry tự nhiên |
| Workflow bị disable | 60 ngày không activity | Step 2 luôn gọi `gh api enable` trước re-dispatch |
| GH_PAT hết hạn | Token expire | Update secret + manual trigger; cân nhắc dùng fine-grained PAT |
| Loop iter trễ > 30s | Network slow tới `api.github.com` | Bình thường — loop dùng `sleep(min(30, remaining))`, dispatch chỉ trễ vài giây |

### 10.10 Quy tắc khi sửa `scheduled-dispatch.yml`

1. ⛔ **KHÔNG xóa step 2** (self re-chain) — sẽ làm gãy chuỗi, chỉ còn lại backup cron 15 min latency.
2. ⛔ **KHÔNG remove `if: always()`** trên step 2 — phải re-chain kể cả khi step 1 fail.
3. ⛔ **KHÔNG remove `concurrency: cancel-in-progress: false`** — nếu cancel, watchdog trigger sẽ kill loop đang chạy.
4. ⛔ **KHÔNG bỏ multi-offset cron** (`*/15` + `5,20,35,50`) — single pattern dễ bị GitHub skip cùng lúc (xem incident 2026-05-20).
5. ⚠️ **KHÔNG đổi `CHECK_INTERVAL_SEC` < 10s** — sẽ làm tăng rate limit consumption và tăng noise log.
6. ⚠️ **KHÔNG đổi `loop_minutes` > 330** — job timeout 350m, cần buffer cho step 2.
7. ⚠️ **KHÔNG tăng `loop_minutes` > 240** — chain-failure gap window quá lớn, làm giảm giá trị của Level 0/3/4 redundancy.
8. ⚠️ Sau khi push fix → **manually cancel** run hiện tại + trigger lại (xem 10.9 fix #2).
9. ✅ Mỗi lần thêm field mới vào entry → update cả `process_runs` (server), `addScheduledRun` (client schedule.js), và data model trong section 9.7.
10. ✅ Mỗi lần thêm pattern recurrence → update `should_run_recurring` + UI form + docs.
11. ✅ Log mọi action (dispatch, gist write, error) — log là source of truth khi debug.
12. ✅ Test bằng cách tạo entry `once` cho 2 phút sau → quan sát Actions log → verify dispatch happens trong 30-60s.

### 10.11 Quy tắc khi sửa `heartbeat.yml` / `dispatcher-watchdog.yml`

1. ⛔ **KHÔNG bỏ multi-cron offset** trong watchdog — đó là phòng tuyến cuối cùng nếu external pingers down.
2. ⛔ **KHÔNG change concurrency group `heartbeat`** — group này dedupe khi 2 external pingers fire gần nhau (e.g. CF Worker và cron-job.org cùng trigger).
3. ⚠️ **KHÔNG giảm `MAX_SILENCE_MIN`** xuống dưới 5 — sẽ false-positive khi dispatcher đang giữa 2 chain transition.
4. ⚠️ **Email alert thresholds** (heartbeat 20min, watchdog 25min) chọn để tránh noise — sửa cẩn thận.
5. ✅ Nếu thay external pinger (e.g. UptimeRobot thay cron-job.org), KHÔNG cần đổi `heartbeat.yml` — chỉ cần POST đúng `event_type=heartbeat` là chạy.

### 10.12 Quy tắc khi sửa `cloudflare-worker/heartbeat.js`

1. ⛔ **KHÔNG hardcode PAT trong code** — luôn dùng `env.GH_PAT` (set qua `wrangler secret put`).
2. ⛔ **KHÔNG đổi cron `*/2` lên < 1 phút** — sẽ vượt CF free tier 100k req/day.
3. ⚠️ Khi đổi `REPO` (fork/rename), update cả `wrangler.toml [vars]` lẫn `heartbeat.yml` matcher.
4. ✅ Deploy: `cd cloudflare-worker && wrangler deploy` (cần wrangler login trước).
5. ✅ Test endpoint: `curl https://dokokin-heartbeat.<sub>.workers.dev/` → trả `heartbeat → 204` nếu OK.
6. ✅ Monitor: `wrangler tail` cho live log.

### 10.13 Monitoring & observability

- **GitHub Actions logs**: stdout từ Python loop → search keywords `🔹 One-time`, `🔁 Recurring`, `✅ Triggered`, `❌`, `📋 Cold-start`
- **Dashboard "Live" indicator**: nếu thấy nhiều run của `Scheduled Run Dispatcher` liên tiếp = healthy
- **External Heartbeat workflow**: nên có ~30 run/giờ (CF */2 = 30, + cron-job.org */5 = 12, dedupe bởi concurrency group còn ~30-40 run/giờ)
- **Email alerts**: 
  - `🚨 Dispatcher gap Xmin — resurrected by heartbeat` (heartbeat ≥20min)
  - `🚨 Dispatcher gap Xmin — resurrected by watchdog` (watchdog ≥25min)
  - Nhận được = có incident → check GitHub status page, PAT scope, CF Worker logs (`wrangler tail`)
- **CF Worker dashboard**: https://dash.cloudflare.com → Workers → dokokin-heartbeat → Logs / Analytics
- **cron-job.org**: dashboard hiển thị HTTP status code (mong đợi 204) trong tab History
- **Gist version history**: GitHub Gist tự track mọi PATCH → `https://gist.github.com/<user>/abc2a47c…/revisions`


---

## 11. ☁️ Cross-device Sync (CloudSync)

**File**: `docs/js/cloud-sync.js`. Shipped May 19 2026.

**Mục đích**: đồng bộ user-level settings giữa các thiết bị (máy chính, iPhone PWA, tablet) qua cùng 1 GitHub PAT/Gist. Auth & vault vẫn local-only.

### Storage
- **Cùng Gist** `abc2a47c0a396025a72a6580227ff493`, file mới `user-settings.json`
- Rolling backup `user-settings.json.bak` được ghi atomically trong cùng 1 PATCH
- Schema:
  ```jsonc
  {
    "_version": 1,
    "_updated_at": "2026-05-19T17:25:00+09:00",  // ISO timestamp LWW
    "_updated_by": "chrome-win-a7f2",            // device fingerprint
    "settings": {
      "locations":       { ... },   // workflow_locations_v1
      "ot_profile":      { ... },   // ot_takehome_profile_v1
      "notif_prefs":     { ... },   // wf_dash_notif_prefs
      "schedule_filter": { ... },   // sched_pip_filter_v1
      "theme":           "auto"     // wf_dash_theme (string scalar)
    }
  }
  ```

### 5 keys được sync (CHỈ 5 này — đừng đoán)
| localStorage key | shortKey trong Gist | Module owner |
|---|---|---|
| `workflow_locations_v1` | `locations` | locations.js |
| `ot_takehome_profile_v1` | `ot_profile` | ot-planner.js |
| `wf_dash_notif_prefs` | `notif_prefs` | app.js |
| `sched_pip_filter_v1` | `schedule_filter` | schedule.js |
| `wf_dash_theme` | `theme` | theme.js |

### Conflict resolution
- **Last-Write-Wins** trên `_updated_at` (ISO ms)
- `localStorage.wf_dash_settings_updated_at` track timestamp đã apply lần cuối → idempotent pull
- **First-time-on-device** (no local timestamp) → adopt remote bất kể, không hỏi
- **Caveat**: 2 devices edit trong cùng debounce window 3s → có thể mất 1 nhánh. Với 1 user/multi-device là chấp nhận được.

### Triggers
| Event | Action |
|---|---|
| `showDashboard()` (after auth) | init + register 5 keys + pull |
| `window.focus` | pull (silent nếu unchanged) |
| `visibilitychange` → visible | pull |
| `setItem` của 1 trong 5 keys → bất kỳ module nào | `CloudSync.markDirty()` → debounced 3s → push |
| Settings card "Cross-device Sync" buttons | force pull/push |

### Mutex / safety
- `_pullPromise` mutex — concurrent pulls join cùng 1 promise
- `_pushing` flag — chặn parallel push, chỉ 1 PATCH at a time
- ETag cache — 304 Not Modified → dùng cached, không tốn rate limit

### `applyToUI()` — single re-render hub
Sau khi pull thành công, gọi list defensive các render fn (typeof + try/catch wrap). **Khi thêm setting mới được sync → phải thêm render fn tương ứng vào list này**, nếu không UI sẽ ko refresh sau pull.

```javascript
// docs/js/cloud-sync.js applyToUI() body
const calls = [
  'renderLocationList',     // locations.js
  'renderNotifSettings',    // app.js
  'renderOtBudget', 'renderOtStats', 'renderOtCalendar', 'renderOtList',
  'renderScheduleTable', 'renderScheduleCalendar',
  'renderThemeStatus',      // settings.js
];
```

**Theme là special**: được apply TRƯỚC khi render children để colors đúng từ frame đầu.

### Quy tắc khi sửa
1. ⛔ **KHÔNG đổi tên key** localStorage hoặc shortKey — sẽ break tất cả devices đã sync
2. ⛔ **KHÔNG xóa key cũ** khỏi `register()` calls — devices cũ vẫn ghi → sẽ lệch
3. ⚠️ Thêm key mới → register ở `app.js` showDashboard + thêm render fn vào `applyToUI`
4. ⚠️ Schema migration → bump `_version` + handle ở pull side, KHÔNG break v1
5. ✅ Mọi `setItem` cho 5 keys trên → gọi `CloudSync.markDirty()` ngay sau

---

## 11.5. 🛡️ GitHub API Worker Proxy (optional PAT hiding)

**Files**: `worker/src/index.js`, `worker/wrangler.toml`, `worker/README.md`. Shipped May 23 2026.

**Why**: Browser previously sent `Authorization: Bearer ghp_*` to `api.github.com` on every fetch → PAT visible in DevTools Network, leakable via screenshare/extensions. Worker holds PAT server-side as Cloudflare-encrypted secret, browser only knows the Worker URL.

### Flow
```
Browser ──fetch(<worker>/repos/...)──▶ Cloudflare Worker
                                         │ verify Origin (CORS allowlist)
                                         │ verify route (regex allowlist)
                                         │ verify method (GET/PATCH only)
                                         │ inject Authorization: Bearer <PAT>
                                         ▼
                                       api.github.com
```

### Defense layers (single-user app, no shared secret needed)
1. **Origin allowlist** (CORS) — `ALLOWED_ORIGIN` var; non-matching origins get 403 (browser-only check, curl-bypassable but limits XSS damage)
2. **Route allowlist** — only `/repos/{OWNER}/{REPO}/*`, `/gists/{specific GIST_ID}`, `/user`, `/rate_limit`
3. **Method allowlist** — gists: PATCH only (no DELETE); repos actions: GET + POST (dispatch/cancel)
4. **GIST_ID hardcoded** — even if Worker URL leaks, only OUR gist is touchable
5. **Health endpoint** `/__health` returns `ok` (no auth) for Settings "Test" button

### Client wiring — fetch monkey-patch
**File**: `docs/js/cloud-sync.js` top (runs BEFORE app.js + all page modules). Monkey-patches `window.fetch`:
- If `localStorage.wf_dash_gh_proxy_url` is set AND URL starts with `https://api.github.com/`
- → rewrite URL to `<proxy>/...` + strip `Authorization` header (Worker injects)
- Otherwise pass through unchanged (backward-compat — works without Worker)

**Why monkey-patch**: 30+ direct `fetch(\`${API}...\`)` callers across page modules (dashboard.js, schedule.js, ot-planner.js, timesheet.js, settings.js, ai-*.js). Monkey-patch = 1 localized change vs 30+ refactors. Side-effect surface bounded by URL prefix check.

### Settings UI
**File**: `docs/js/settings.js` — `renderProxyStatus()`, `testProxy()`, `saveProxyUrl()`, `clearProxyUrl()`.
Card in `index.html` (between Cross-device Sync and About) has URL input + Test/Save/Disable buttons. **Test** calls `/__health` (reachability) then `/user` (PAT validation). User must reload after Save.

### Deploy
See `worker/README.md` 5-step guide. Requires Cloudflare account (free), `wrangler` CLI, ~10 min. Set GITHUB_PAT via `wrangler secret put GITHUB_PAT` (never in wrangler.toml).

### Gotchas
1. ⛔ **Don't put GITHUB_PAT in wrangler.toml** — only in secrets
2. ⛔ **Don't allow `*` origin** — defeats CORS check
3. ⚠️ Worker free tier = 100k req/day; current usage ~1-2k/day — plenty of headroom
4. ⚠️ When adding new GitHub API routes the dashboard hits → add to `buildRouteRules(env)` in worker/src/index.js
5. ⚠️ Suica fare proxy (`cloudflare-worker-fare/`) is a SEPARATE Worker for a different upstream — don't conflate
6. ✅ Backward-compat: empty proxy URL = direct API (current behavior). Migration is opt-in per user.

---

## 12. 🔐 Biometric Auto-Unlock (Face ID / Touch ID / Windows Hello)

**File**: `docs/js/biometric.js`. Shipped May 19 2026. **PWA-only**.

### Tier 1 — PRF (crypto-bound, iOS 18+ / Chrome 119+ / macOS recent)
- WebAuthn PRF extension derive 32-byte secret deterministic từ authenticator
- PAT được AES-GCM encrypt bằng PRF key
- Authenticator chết = key chết = PAT không decrypt được (defense-in-depth thật)
- Probe pattern khi enroll: create credential → immediate assertion với same prfSalt để test PRF có thực sự work (một số authenticators chỉ trả PRF tại assert-time)

### Tier 2 — Gate (fallback cho browser cũ)
- Random AES key + encrypted PAT đều stored local
- Key CHỈ được release sau `navigator.credentials.get()` thành công với `userVerification: 'required'`
- Là UI gate, không phải crypto bind. Equivalent practical security cho personal device PWAs.

### Storage (single localStorage entry)
```js
'wf_dash_biometric' = {
  v: 2,
  tier: 'prf' | 'gate',
  credentialId: '<b64url>',
  payload: { /* tier-specific encrypted blob */ }
}
```

### Auth ceremonies
- **Create**: `{ authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'required' }`
- **Assert**: `allowCredentials: [{ id: credentialId, type: 'public-key' }]`
- `rp.id` = `window.location.hostname` (works on `*.github.io`)

### PWA-only gating (CRITICAL)
`Biometric.isPwa()` check 4 conditions:
1. `matchMedia('(display-mode: standalone)')`
2. `matchMedia('(display-mode: fullscreen)')`
3. `matchMedia('(display-mode: minimal-ui)')`
4. `navigator.standalone === true` (iOS Safari)

Nếu KHÔNG phải PWA:
- Settings card "Biometric Auto-Unlock" → `display: none` (toàn bộ card biến mất)
- Auth screen Face ID button → ẩn
- Bootstrap auto-trigger → silent skip
- `enrollBiometric()` API → toast "Install as PWA first"

**Lý do PWA-only**: trong browser tab thường, user đã có thể paste passphrase ở đâu cũng được, không có ích bảo mật. iOS Safari ngoài standalone cũng có flaky UX cho WebAuthn assertions.

### Triggers
| Event | Action |
|---|---|
| `bootstrap()` khi có vault nhưng no session | `tryBiometricAutoUnlock()` — silent fail về passphrase form nếu user cancel |
| User tap nút "Unlock with Face ID" trên auth screen | `unlockWithBiometric()` (toast on error) |
| Settings → "Enable on this device" | `enrollBiometric(sessionToken)` — yêu cầu phải đang unlocked |
| Settings → "Disable on this device" | confirm dialog → `Biometric.disable()` |

### iOS Safari caveat
Auto-triggered `credentials.get()` trong bootstrap có thể bị block không có user gesture. Vẫn có nút explicit "Unlock with Face ID" trên auth screen làm primary path → tap = user gesture → reliable.

### Quy tắc khi sửa
1. ⛔ Đừng bỏ check `isPwa()` ở Settings render — sẽ leak UI ra browser tab
2. ⛔ Đừng đổi `STORE_KEY` = `'wf_dash_biometric'` — devices đã enroll sẽ mất
3. ⚠️ Đổi tier schema → bump `v` field, handle backward compat khi load
4. ⚠️ `rp.id` thay đổi (vd domain mới) = tất cả credentials cũ vô hiệu → user phải re-enroll

---

## 13. 🎨 Theme System (Light / Dark / Auto)

**File**: `docs/js/theme.js`. Shipped May 19 2026.

### Mode persisted ∈ {auto, dark, light}
- localStorage `wf_dash_theme`
- `auto` = follow `prefers-color-scheme` (mặc định khi chưa set)
- Synced cross-device qua CloudSync (key thứ 5)

### Resolution
- `Theme.getMode()` → raw value
- `Theme.resolve(mode)` → 'dark' | 'light' (auto → systemPref)
- `Theme.apply(mode)` → set `data-theme="<resolved>"` trên `<html>` + cập nhật `<meta name="theme-color">`

### CSS architecture — single source of truth
- `:root` (default dark) định nghĩa tất cả color vars + `--tint: 255,255,255`
- `[data-theme="light"]` block override toàn bộ + `--tint: 0,0,0`
- **42 hardcoded `rgba(255,255,255,X)`** trong style.css đã được rewrite → `rgba(var(--tint),X)` → 1 toggle flip tất cả hover/border/scrim overlays
- `color-scheme: dark/light` cho native form controls + scrollbars auto-adapt
- Light palette dùng shadcn defaults: bg `#ffffff`, fg `#09090b`, muted `#f4f4f5`, primary `#2563eb` (blue-600), softer shadows

### Tailwind CDN config
Colors được map sang CSS vars qua `'var(--card)'`, `'var(--foreground)'`, vv → utility classes `bg-card`, `text-foreground`, `border-border`... đều follow theme tự động. **Trade-off**: tailwind opacity modifiers (`bg-muted/50`) sẽ fallback về full opacity vì CSS var không phân tích được alpha — chỉ 4 chỗ dùng, chấp nhận.

`darkMode` retargeted `[data-theme="dark"]` (chứ ko phải class) — phòng future `dark:` utilities.

### FOUC prevention
Inline `<script>` trong `<head>` (TRƯỚC khi tailwind CDN + style.css load):
```js
var mode = localStorage.getItem('wf_dash_theme') || 'auto';
var resolved = mode === 'auto'
  ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
  : mode;
document.documentElement.setAttribute('data-theme', resolved);
```
→ First paint đã đúng theme, không có flash.

### Live OS-pref subscription
`Theme.init()` subscribe `matchMedia('(prefers-color-scheme: light)').addEventListener('change', ...)` → khi user đổi iOS/Windows theme, PWA flip realtime nếu đang ở Auto mode.

### Settings UI
Card "Appearance" trên đầu Settings page → 3 nút segmented Auto / Light / Dark. Nút active có `.is-active` class (primary background). Help text dưới hiển thị resolved system pref khi Auto.

### Quy tắc khi sửa
1. ⛔ KHÔNG hardcode hex màu mới trong style.css — luôn dùng `var(--*)` để hoạt động ở cả 2 themes
2. ⛔ KHÔNG dùng `rgba(255,255,255,X)` — dùng `rgba(var(--tint),X)`
3. ⚠️ Thêm semantic color mới → định nghĩa ở CẢ `:root` VÀ `[data-theme="light"]`
4. ⚠️ Tailwind color mới → thêm vào tailwind config cũng phải dạng `var(--*)`
5. ✅ Test ở cả 2 themes trước khi commit (mở DevTools → Application → Local Storage → set `wf_dash_theme: 'light'` → reload)

---

## 14. 💰 OT Optimizer rev3 (pure-night greedy)

**File**: `docs/js/ot-planner.js`. Shipped May 19 2026 (commits `602a1f8` → `f486cb7`).

### Mục đích
Suggest OT schedule tối ưu lương cho 1 tháng, respect cap 75h/month + 12h/day. Dùng trong OT Planner page → modal "OT Optimizer".

### Rate analysis (vì sao pure-night thắng)
| Shift type | Multiplier | ¥/h | Notes |
|---|---|---|---|
| Sun pure-night 22:00→04:00 (6h) | 1.25 + 0.10 Sun + 0.25 Night = **1.60×** | **¥2,500** | Best |
| Wk pure-night 22:00→04:00 (6h) | 1.25 + 0.25 Night = **1.50×** | **¥2,344** | 2nd |
| Sun day 12h shift | mixed avg | ¥2,289 | Worse |
| Sun 12h with break | 11h paid | ¥2,110 | Worst |

→ **6h shift = sweet spot**: Labor Law §34 chỉ require break khi working hours STRICTLY > 6h → 6h shift không cần trừ 60min break → tận dụng full hours.

### Algorithm
1. **Candidates**: cho mỗi ngày trong tháng → 1 candidate `22:00→04:00 (6h)` (Sun và Wk dùng cùng template)
2. **Enum mix**: `(k_sun_full, k_wk_full) ≤ floor(cap/6)` + optional partial last shift trong `[3, 6)` giờ
3. **Score**: vì rateSun > rateWk → ưu tiên Sundays trước
4. **Partial materialize**: clone candidate kế tiếp, override `end = '22:00 + partialHours'`, recompute gross qua `calcOtBreakdown`
5. Result example (June 2026, target 75h): **4 Sun×6h + 8 Wk×6h + 1 Wk×3h = 75.0h / ¥179,573** (+¥6,908 vs rev2 knapsack)

### UI
- Modal "OT Optimizer" trong OT Planner
- Input: target income (¥) hoặc max budget
- Output: bảng (date, time, hours, income, status="queued") + summary projected total + estimated net take-home delta (qua ot-salary engine)
- Apply button: bulk-create OT requests via Gist write

### Constraints
- 75h/month hard cap (Labor Law)
- 12h/day cap mỗi date
- Respect existing requests (subtract from remaining budget)
- KHÔNG suggest cho past dates
- Cross-midnight handling: 22:00→04:00 attribute hours về ngày bắt đầu (workday đó)

### Quy tắc khi sửa
1. ⛔ KHÔNG suggest > 75h tổng — Labor Law violation
2. ⛔ KHÔNG break Rule 2 kintai (xem section 3): nếu suggest cross-midnight cho workday đã có recurring CO 18:00 → phải đồng thời thêm `skip_dates` hoặc explicit CO entry, nếu không OT sẽ bị mất
3. ⚠️ Thay đổi rate table → cập nhật cả `ot-salary.js` (calc engine) lẫn rate analysis ở đây
4. ✅ Test với month boundary (cuối tháng) để đảm bảo partial shift không cross sang tháng sau gây sai stats

---

## 15. 📋 Session changelog (May 19 2026)

Major features delivered hôm nay:

| # | Feature | Files | Key commits |
|---|---|---|---|
| 1 | OT Optimizer rev3 (pure-night greedy, full 75h) | `ot-planner.js` | `602a1f8`, `c5d7778`, `f486cb7` |
| 2 | CloudSync module + Settings card | `cloud-sync.js` (new), `app.js`, `dashboard.js`, `settings.js`, 4× setItem callsites | `f7216e5`, `07092d2`, `c88f139` |
| 3 | Biometric Face ID auto-unlock (WebAuthn 2-tier) | `biometric.js` (new), `app.js`, `settings.js`, `icons.js`, `index.html` | `fe5cdfd`, `e47e91f` (PWA-only gating) |
| 4 | PWA manifest.json | `docs/manifest.json` (new) | `2220fff` |
| 5 | Light / Dark / Auto theme system | `theme.js` (new), `style.css` (42 rgba rewrites + light block), `index.html` (Tailwind config + FOUC bootstrap), `settings.js` | `e61ace4`, `33ab018`, `b4766bf`, `5b73d7b` |
| 6 | Misc UI polish | scrollbar shadcn-style, tab border flash, run-item hover, favicon zap | `94bd1b0`, `b2516fe`, `e329462`, `7e9ec67` |

### Module load order (current, in `index.html`)
```
icons.js?v=42 → no-autofill.js?v=26 → theme.js?v=1 → locations.js?v=27
  → biometric.js?v=2 → cloud-sync.js?v=4 → app.js?v=33
  → dashboard.js?v=28 → schedule.js?v=27 → ot-salary.js?v=37
  → ot-planner.js?v=49 → settings.js?v=31
style.css?v=46
```

### Bootstrap orchestration trong `app.js bootstrap()`
1. `Theme.init()` — apply persisted/auto theme + subscribe OS pref
2. `updateNotifBtn()`
3. Path branch:
   - Có session restorable → `showDashboard()` (sẽ init CloudSync)
   - Không có vault → setup form
   - Có vault, no session → focus passphrase + `tryBiometricAutoUnlock()` (silent skip nếu non-PWA hoặc not enrolled)

---

## 16. 🤖 AI Coach (OT Coach) — Phase 1

**Shipped**: May 23 2026 trên branch `feat/ai-coach-p1`. Read-only assistant giúp Tan quản lý OT, lương, chấm công qua chat.

### Mục đích
- **In-PWA AI assistant** cho OT/salary/schedule Q&A, hoàn toàn read-only (Phase 1)
- **Zero backend** — dùng GitHub Models (OpenAI-compatible), free tier với existing `GH_PAT`
- **Knowledge**: DokoKin context, kintai rules, OT rate multipliers, labor law, GH workflow history
- **Output**: Vietnamese tiếng Việt, ngắn gọn (≤200 từ, table cho ≥3 items)
- **Storage**: conversation lưu `sessionStorage` (ephemeral, cleared on logout), không persist

### Architecture — User → AI Agent → GitHub Models → Tool Loop

```
┌─ User composes message (aiComposerInput) ──┐
│ rate-limit check (10 msg/60s token bucket) │
└──────────────────────┬──────────────────────┘
                       ▼
┌────────────────────────────────────────────┐
│  AIAgent.sendMessage(text)                 │
│  • Append to sessionStorage ai_conv_v1     │
│  • systemPrompt() injected + message list  │
├────────────────────────────────────────────┤
│  runToolLoop() — max 3 hops:               │
│  1. Streaming request → GitHub Models      │
│     (SSE parser with TextDecoder stream)   │
│  2. Last hop: tool_choice='none' (final)   │
│  3. Parse tool_calls → executeToolLoop()   │
│     (max 8s timeout per tool via Race)     │
│  4. Append tool results → message list     │
│  5. Re-stream with context → loop          │
├────────────────────────────────────────────┤
│  Tool execution (AITools registry):        │
│  • get_today_status (workflow proxy)       │
│  • list_schedule (Gist entries)            │
│  • list_ot_requests (Gist OT list)         │
│  • calc_ot_breakdown (¥ calculator)        │
│  • summarize_month_ot (monthly summary)    │
│  • get_workflow_runs (diagnosis)           │
└──────────────────────┬──────────────────────┘
                       ▼
┌────────────────────────────────────────────┐
│  Render (renderMarkdown + renderMessage)   │
│  • Escape-first whitelist HTML             │
│  • Tool pills (.ai-tool-pill) collapsible  │
│  • Scroll to bottom + typing indicator     │
└────────────────────────────────────────────┘
```

### Module load order (append to existing chain)
```
icons.js?v=42 → no-autofill.js?v=26 → theme.js?v=1 → locations.js?v=27
  → biometric.js?v=2 → cloud-sync.js?v=4 → app.js?v=33
  → dashboard.js?v=28 → schedule.js?v=27 → ot-salary.js?v=37
  → ot-planner.js?v=49 → ai-tools.js?v=1 → ai-agent.js?v=1 → settings.js?v=31
style.css?v=47 (+ 200 LOC AI COACH section)
```

### 6 Tools — read-only (Phase 1)

| # | Tool name | Purpose | Args | Returns | Wraps |
|---|---|---|---|---|---|
| 1 | **get_today_status** | Check CI/CO workflow run status hôm nay (JST proxy) | _(none)_ | `{date_jst, checkin, checkout, note}` | `apiFetch` → GH API workflow_runs |
| 2 | **list_schedule** | List Gist scheduled-runs.json entries (one-time + recurring) | `from` (YYYY-MM-DD), `to`, `workflow` | `{count, entries: [{id, type, workflow, run_at, time, days, dates, enabled, ...}]}` | `apiFetch` + Gist parse |
| 3 | **list_ot_requests** | List Gist ot-requests.json cho tháng chỉ định | `month` (YYYY-MM, default: current JST) | `{month, count, total_hours, cap_hours, cap_remaining_hours, requests}` | Gist parse + filter |
| 4 | **calc_ot_breakdown** | Tính gross ¥ breakdown cho list OT shifts | `requests` (array `{date, start, end}`) | `{count, total_hours, total_gross_yen, per_shift}` | `window.OT_SALARY.calcOtBreakdown()` |
| 5 | **summarize_month_ot** | Tóm tắt OT toàn tháng (gross + hours + cap) | `month` (YYYY-MM) | `{month, count, total_hours, cap_remaining, gross_yen, breakdown_yen, hours_breakdown}` | list_ot + OT_SALARY.calcMonthlySummary |
| 6 | **get_workflow_runs** | Fetch recent runs cho diagnosis (status, conclusion, logs) | `workflow` (file/name), `limit` (1–20, default 10) | `{count, runs: [{workflow, status, conclusion, event, created_at, html_url}]}` | `apiFetch` → GH API actions/workflows/.../runs |

### Conversation lifecycle

**Storage**:
- `sessionStorage ai_conv_v1` — messages array (user/assistant/tool roles), ephemeral ≤ 40 turns ≈ 160 messages max
- `sessionStorage ai_model_v1` — selected model (gpt-4o-mini default)
- `localStorage ai_rate_v1` — token bucket `{start, count}` (10 req/60s)

**Clearing**:
- `clearSession()` (logout / auto-lock 30min idle) → `AIAgent.clearConv()` → wipe sessionStorage + `convVersion++`
- Race protection: mỗi `sendMessage()` capture `convVersion` → `isStale()` guard ở async resume points

**Invariants**:
- ⛔ KHÔNG persist conversation sang `localStorage` (cross-auth boundary risk)
- Conv KHÔNG xoá sau khi clear — nó được tạo lại fresh từ empty lần tiếp theo user chat
- Multi-message-in-flight: `isStreaming` flag + `currentAbort` prevent race

### Tool loop — max 3 hops, last-hop forces finale

```python
for hop in range(MAX_TOOL_HOPS=3):
    # Streaming request (streaming SSE → TextDecoder stream-safe)
    response = streamRequest(
        body={
            messages: [system_prompt, ...messages],
            tools: getToolSchemas(),
            tool_choice: 'none' if hop==2 else 'auto',  # Last hop no tools
            temperature: 0.3,
            max_tokens: 1500
        }
    )
    
    # Parse deltas + accumulate tool_calls
    for delta in stream_deltas:
        assistantMsg.content += delta.content
        if delta.tool_calls: accumulateCalls(toolAccum, delta)
    
    # Tool execution (max 8s per tool)
    if finishReason == 'tool_calls':
        for toolCall in toolAccum:
            result = await executeTool(name, args)  # 8s timeout via Promise.race
            messages.append({ role: 'tool', tool_call_id, content: result })
        continue  # next hop with tool results
    else:
        break  # model stopped with finish_reason='stop'
```

**Validation**: arg schema (type + required only, lenient for AI inputs)

### Streaming — SSE parser với UTF-8 stream safety

```javascript
const reader = response.body.getReader();
const decoder = new TextDecoder();  // stream: true = multi-byte safe
let buffer = '';
while (!done) {
  const { value, done } = await reader.read();
  buffer += decoder.decode(value, { stream: true });
  // Parse data: {...} lines
  // onDelta(chunk) += content
  // onToolCallDelta(deltas) for tool accum
}
```

**Caveat**: hàm `streamRequest` throw khi HTTP !ok (401, 429, 5xx) → catch tại `sendMessage` level

### Rate limiting — 10 messages / 60s token bucket

```javascript
localStorage.ai_rate_v1 = { start: <ms>, count: <n> }
if (count >= RATE_LIMIT_MAX) {
    waitMs = RATE_LIMIT_WINDOW_MS - (now - start)
    show toast: "⏳ Hết quota cục bộ — thử lại sau ${Math.ceil(waitMs/1000)}s"
    return  // send() aborted
}
```

Quota reset mỗi 60s. Kiểm tra trước khi append message + stream.

### Markdown renderer — escape-first, whitelist HTML

```javascript
// 1. esc() escape &<>" trước
// 2. Allowlist transform (escape vào vừa rồi):
//    - bold **text** → <strong>text</strong>
//    - inline code `text` → <code class="ai-inline-code">text</code>
//    - code blocks ```lang\n...\n``` → <pre><code>...</code></pre>
//    - tables | header | row | → <table><thead/tbody>
//    - headings ## ## → <h3/h4>
//    - links [text](http...) → <a href="..." target="_blank">
//    - lists - item / 1. item
//    - paragraphs (double \n)
// 3. innerHTML = html (safe because no <script>, onclick)
```

**Allowlist tags** (KHÔNG bao giờ inline script): `p`, `strong`, `em`, `code`, `pre`, `ul`, `ol`, `li`, `h3`, `h4`, `table`, `thead`, `tbody`, `tr`, `th`, `td`, `a` (http(s) only)

### UI components

| Component | CSS class | Where |
|---|---|---|
| AI nav tab | `.nav-item` + sparkles icon | Bottom nav (4th tab) |
| Page container | `.page#page-ai` + `.ai-page-wrap` | Full height flex column |
| Header | `.card` + model select `<select>` + clear button | Sticky top |
| Chat scroll area | `#aiChatScroll.ai-chat-scroll` | Flex 1, smooth scroll |
| Empty state | `#aiEmpty.ai-empty` + 4 suggested `.ai-suggest-chip` | Center when `messages.length==0` |
| User message | `.ai-msg.ai-msg-user` + `.ai-bubble.ai-bubble-user` | Right-aligned blue bubble |
| AI message | `.ai-msg.ai-msg-ai` + `.ai-bubble.ai-bubble-ai` | Left-aligned muted bubble |
| Tool pills | `details.ai-tool-pill` (collapsible) | Above AI bubble, shows args + result |
| Typing indicator | `.ai-typing` + `.typing-dots` + 3 animated dots | Pending AI response |
| Composer | `form.ai-composer.card` + textarea + send button | Sticky bottom (z-index 5) |
| Rate limit / errors | `.ai-composer-meta` (red/yellow text) | Below composer |

**Composer behavior**:
- Auto-grow textarea (`maxHeight: 180px`)
- Enter = send, Shift+Enter = newline
- Send button disabled while `isStreaming`
- Focus trên vào AI page (`navigate('ai')`)

### CSS additions (~200 LOC ở cuối `style.css`)

- `.ai-page-wrap` — flex container, min-height calc
- `.ai-header-icon`, `.ai-model-select` — header UI
- `.ai-chat-scroll` — scroll area + gap
- `.ai-empty`, `.ai-empty-icon`, `.ai-empty-title`, `.ai-empty-sub`, `.ai-suggestions` — empty state
- `.ai-msg`, `.ai-msg-user`, `.ai-msg-ai` — message rows + animation fade-in
- `.ai-bubble`, `.ai-bubble-user`, `.ai-bubble-ai`, `.ai-bubble-muted` — bubble styling (primary / muted bg)
- `.ai-bubble p/strong/em/a`, `.ai-h`, `.ai-list`, `.ai-inline-code`, `.ai-code`, `.ai-table` — markdown-rendered content
- `.ai-typing`, `.typing-dots` (i) — typing animation @keyframes typingDot
- `.ai-tool-pill`, `.ai-tool-pill > summary`, `.ai-tool-name`, `.ai-tool-status`, `.ai-tool-body`, `.ai-tool-label`, `.ai-tool-json` — collapsible tool details
- `.ai-composer`, `.ai-composer-input`, `.ai-composer-send`, `.ai-composer-meta` — sticky composer form

### Security model

| Asset | Storage | Encryption | Scope |
|---|---|---|---|
| GitHub PAT | `sessionStorage` (gốc từ vault unlock) | In-memory only này lần | Sent as `Authorization: Bearer <token>` qua HTTPS |
| System prompt + context | Memory only (mỗi request tạo lại) | KHÔNG lưu | Include TODAY_JST, DokoKin rules, kintai context |
| Conversation | `sessionStorage ai_conv_v1` | Plain JSON | Cleartext (personal device, same security as vault) |
| Tool results | `sessionStorage` (part of conv) | Plain | Không re-send ngoài qua HTTPS |
| Model selection | `sessionStorage ai_model_v1` | Plain | Non-sensitive (model name only) |
| Rate bucket | `localStorage ai_rate_v1` | Plain | Timestamp + count, KHÔNG secret |

**Never**:
- ⛔ Log raw PAT ngoài sessionStorage gốc
- ⛔ Persist conversation sang localStorage
- ⛔ Send PII (employee code, specific dates) trong API key, chỉ headers

### Storage keys table

| Key | Where | Purpose | Cleared on |
|---|---|---|---|
| `ai_conv_v1` | sessionStorage | Message array (40-turn cap) | Page close / logout / `clearConv()` |
| `ai_model_v1` | sessionStorage | Selected model (gpt-4o-mini) | Page close |
| `ai_rate_v1` | localStorage | Rate bucket `{start, count}` | Manual (`localStorage.clear()` or 60s rotation) |

**Lưu ý**: `ai_conv_v1` và `ai_model_v1` khác với `sessionToken` (PAT lưu ở sessionStorage nhưng KHÔNG có key cố định — nó dùng closure scope trong `app.js`)

### Failure modes & fixes

| Symptom | Cause | Fix |
|---|---|---|
| 401 Unauthorized | PAT expired or wrong scope | Logout + re-auth. Check GH_PAT secret có `repo:read_all`, `gist:read_all` |
| 429 Too Many Requests | GitHub API rate limit exceeded (5000/h) | Client-side rate limit bucket không trigger? Check `rateConsume()` logic. Mỗi message = 1 rate, tool exec = thêm 1-2 |
| Network timeout (>8s) | Tool exec hung (apiFetch stall) | Tool wrapper có Promise.race(timeout), nên error `Tool X timed out after 8000ms`. Retry user message |
| "Chưa đăng nhập" error | `sessionToken` undefined khi stream start | Vault lock auto-logout? Clear tab + re-login |
| Streaming partial message | SSE decoder incomplete (network cut) | TextDecoder stream-safe nên UTF-8 OK, nhưng network break = early EOF. Re-send message (new conv entry) |
| Tool result null/empty | Tool exec fail (Gist not readable, calc error) | Tool return `{error: "..."}` → system prompt direct model to explain. User see error message + retry |
| "Conversation too long" | `messages.length > MAX_HISTORY_TURNS * 4` | Auto-trim oldest. `saveConv()` slice last 160. User continue, older context lost |

### Quy tắc khi sửa

1. ⛔ **KHÔNG bao giờ log/persist sessionToken (PAT) ngoài sessionStorage gốc** — violation is RCE risk. Session token = raw PAT dùng cho API, chỉ giữ trong closure + sessionStorage.
2. ⛔ **KHÔNG đổi shape của tool result mà không update system prompt** — model expectations baked in ("phase OT", "¥", table format, etc.). Thay đổi result schema → update system prompt context.
3. ⚠️ **Thêm tool mới → đăng ký trong TOOLS array `ai-tools.js` + cập nhật system prompt** `ai-agent.js` nếu tool mở context mới + bump version `ai-tools.js` cache
4. ⛔ **Mutation tools (tạo/sửa/xóa Gist hoặc DokoKin) → BỊ CẤM Phase 1**, để dành cho P3 với confirm dialog. Phase 1 = read-only proxy chỉ.
5. ⛔ **KHÔNG truyền raw HTML/markdown của AI result vào innerHTML mà không qua `esc()` + whitelist** — XSS vector. Model có thể output script tags (hallucinate), PHẢI esc trước + render safe.
6. ⚠️ **Mỗi async resume point trong `runToolLoop` PHẢI có `if (isStale()) return` guard** — xem fix race ở commit 2cb5792. Khi `clearConv()` bump `convVersion` mid-flight, running loop bail out gracefully.
7. ⛔ **Tool exec PHẢI wrap trong `Promise.race` với timeout (default 8s)** — tránh hang UI khi Gist API slow. Error message "Tool X timed out after 8000ms" user-visible + recoverable.
8. ⛔ **Conv KHÔNG được persist sang localStorage** (tránh leak qua auth boundary). `sessionStorage` only, cleared on page close + logout.
9. ⛔ **Markdown renderer: chỉ allowlist tags**, KHÔNG bao giờ inline-script/onclick/onerror. Audit list: p/strong/em/code/pre/ul/ol/li/h3/h4/table/a (http(s)). Model có thể output malicious HTML, esc-first + whitelist = safe.
10. ⚠️ **Khi thêm provider mới (Anthropic, Groq, OpenAI direct)** → giữ `API_URL` constant + cờ provider, KHÔNG hard-fork toàn bộ `ai-agent.js`. Refactor: `getAPIUrl()` factory, `getHeaders()` per-provider.

### References
- Implementation: `docs/js/ai-tools.js` (~340 LOC tool registry), `docs/js/ai-agent.js` (~440 LOC chat orchestrator)
- Integration: `docs/index.html` (page-ai tab, aiComposer), `docs/css/style.css` (AI COACH section ~200 LOC), `docs/js/app.js` (navigate hook + clearConv)
- Modules wrapped: `apiFetch()` (GH API), `GIST_ID` + Gist files, `window.OT_SALARY`, `WORKFLOWS` list
- System prompt: JST-aware, DokoKin context injected per-request (TODAY_JST, kintai rules, rate multipliers)
- PR/commits: phase 1 shipped May 23 2026 (`feat/ai-coach-p1` branch)

---

## 17. AI Anomaly Detective (Phase 2)

**Trigger**: cron `0 22 * * *` UTC = **07:00 JST daily** + manual `workflow_dispatch`.

### What it scans (last 7 days by default)
- DokoKin dakoku records (GET /api/dakoku/me/{date})
- Gist scheduled-runs.json (schedule entries)
- Gist ot-requests.json (OT requests)
- Azure token expiry estimate

### Anomaly classes detected

| # | Class | Severity | Signal |
|---|---|---|---|
| A1 | Cross-midnight OT unprotected | Critical | OT cross-midnight + date NOT in skip_dates of recurring CO |
| A2 | Missing checkout | High | startWorkingTime set, endWorkingTime null, date < today |
| A3 | CO before OT end (Rule 2 violation) | Critical | endWorkingTime < OT end time on same workday |
| A5 | Undispatched once entry | Medium | type=once, dispatched=false, run_at < now-1h |
| A7 | Azure token expiring soon | Medium | Token expiry < 14 days |

### File locations
| File | Role |
|---|---|
| .github/scripts/ai_client.py | Shared OpenAI-compatible HTTP client (stdlib, retries) |
| .github/scripts/anomaly_rules.py | Pure detection functions + inline assert tests |
| .github/scripts/ai_anomaly_check.py | Main orchestrator (load, detect, summarize, notify) |
| .github/workflows/ai-anomaly-check.yml | Workflow (cron + dispatch) |

### How to add a new rule
1. Add detect_aX_name() in anomaly_rules.py (pure, no I/O)
2. Return list of {class, severity, date, summary, context}
3. Call from run_all()
4. Add inline asserts
5. Add loader in ai_anomaly_check.py if new data needed

### CLI flags
- --dry-run: no notifications
- --days N: custom lookback
- --always-email: email even on all-clear
- --fixture path.json: use local test data

### Env requirements
AZURE_REFRESH_TOKEN, GH_PAT, SMTP_USER, SMTP_PASS, NOTIFY_EMAIL, LINE_NOTIFY_TOKEN, AI_API_BASE

---

## 18. AI Natural-Language Schedule Editor (P3)

**Files**: `ai-validators.js`, `ai-audit.js`, `ai-proposals.js`, `ai-tools.js` (mutation tools), `ai-agent.js` (system prompt + modal trigger).

### Architecture: PROPOSE-then-APPLY

AI **never** writes Gist directly. Every mutation follows:
1. User asks in natural language (e.g. "tao OT thu 5 22:00-03:30")
2. AI calls `propose_*` tool → returns proposal object (validated, diffed)
3. Proposal stored in `window.AIProposals._pending` Map
4. After AI stream completes, confirmation modal auto-opens showing all pending proposals
5. User reviews diff, checks/unchecks items, clicks Apply
6. `AIProposals.applyProposals()` executes atomic Gist PATCH with ETag retry
7. Audit entry logged to localStorage ring buffer (max 100)

### Tools (6 mutation tools)

| Tool | Target file | Description |
|---|---|---|
| `propose_create_schedule_once` | scheduled-runs.json | Create one-time schedule entry |
| `propose_create_schedule_recurring` | scheduled-runs.json | Create recurring schedule |
| `propose_create_ot_request` | ot-requests.json | Create OT + auto-detect Rule 2 conflict |
| `propose_update_schedule` | scheduled-runs.json | Update existing entry by ID |
| `propose_delete_schedule` | scheduled-runs.json | Delete (REFUSES if dispatched=true) |
| `propose_add_skip_date` | scheduled-runs.json | Add skip_date to recurring entry |

### Safety guarantees

- **Atomic PATCH**: grouped by target file, ETag retry on 412
- **Audit ring buffer**: localStorage `ai_audit_v1`, max 100, supports rollback of last apply
- **Rate limit**: max 5 `propose_*` calls per user message (enforced in tool exec)
- **Hard refuse**: cannot delete dispatched entries (enforced in tool, not just prompt)
- **Validation**: all proposals run through `AIValidators` before presentation
- **Cross-midnight auto-detect**: OT proposals automatically include `add_skip_date` sub-action for conflicting recurring CO entries (Rule 2)

### How to add a new propose_* tool

1. Add exec function in `ai-tools.js` (read Gist, validate, return proposal object)
2. Register in TOOLS array with OpenAI function-calling schema
3. Add corresponding validation in `ai-validators.js` if needed
4. Add `_applyDiff` case in `ai-proposals.js` for the new `kind`
5. Update system prompt in `ai-agent.js` if new rules apply
6. Bump `ai-tools.js` version in `index.html`

### Quy tac khi sua

1. ⛔ AI NEVER calls `apiFetch` PATCH directly — all mutations go through `AIProposals.applyProposals()`
2. ⛔ Do not remove `_checkRateLimit()` guard from propose tools
3. ⚠️ Adding new target file → update `_applyToFile` Gist content wrapper logic
4. ⚠️ Modal a11y: keep `role=dialog`, `aria-modal`, ESC close, focus management
5. ✅ Test with both create + delete + cross-midnight OT (the full Rule 2 flow)
