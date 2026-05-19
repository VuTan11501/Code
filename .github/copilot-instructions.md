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
   │  GitHub Actions (heart = scheduled-dispatch.yml)     │
   │  • self-loop 5h, check Gist mỗi 30s, fire workflow   │
   │  • fallback cron */15, watchdog độc lập */20         │
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
| `docs/index.html` | Layout, 3 tab (Dashboard / Schedule / Settings), modals |
| `docs/js/app.js` | Auth (vault encryption), router `navigate()`, `apiFetch()` (ETag cache), entry-point `showDashboard()` |
| `docs/js/dashboard.js` | Adaptive polling engine (1s/15s/60s), `refresh()` workflow runs |
| `docs/js/schedule.js` | CRUD schedule Gist, precision setTimeout dispatcher, location field |
| `docs/js/settings.js` | PAT/passphrase, Location Settings (GPS) |
| `docs/js/ot-planner.js` | OT Planner page — CRUD OT requests trong Gist `ot-requests.json`, conflict detect + auto-fix cross-midnight |
| `docs/js/locations.js` | Built-in locations (`office`, `home`, NEC Tamagawa …) + user-defined |
| `docs/js/icons.js`, `no-autofill.js` | Tiện ích |

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
| **`scheduled-dispatch.yml`** | self-loop + cron `*/15` | 🫀 **Trái tim** — đọc Gist mỗi 30s, dispatch worker đúng giờ |
| `dispatcher-watchdog.yml` | cron `*/20` | Hồi sinh dispatcher nếu chết quá 10 phút |
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
- `checkin_type`: 1=office GPS, 2=direct customer, 3=noGPS, 5=WFH, 6=WFH noGPS

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
- Self-loop ~5h: vòng lặp `while elapsed < 18000`, mỗi 30s đọc Gist (qua ETag), dispatch entries quá hạn
- Cuối loop: `gh workflow run` chính nó để chain liên tục
- **Code load tại t=0**: trong khi loop chạy, fix mới push KHÔNG áp dụng. Phải cancel run hiện tại + trigger thủ công nếu cần áp dụng gấp.
- Backup: cron `*/15` + watchdog độc lập (`dispatcher-watchdog.yml`) `*/20`

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
5. **Workflow fix không có hiệu lực** → dispatcher 5h loop dùng code cũ → cancel + re-trigger
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

**Đảm bảo đúng giờ qua 3 cơ chế chồng nhau** (redundancy):
1. **Client setTimeout** — dispatch chính xác tại millisecond nếu user đang mở tab
2. **Server self-loop** (`scheduled-dispatch.yml` 5h loop, check Gist mỗi 30s) — không cần user mở browser
3. **Backup cron `*/15`** + **watchdog `*/20`** — phòng cả 2 cái trên chết

→ **Worst case latency**: ~30 giây (server loop interval). **Best case**: 0ms (client setTimeout).

### 9.3 Core flow #2 — Scheduled dispatch loop (heart of system)

```
[T=0] scheduled-dispatch.yml triggered (cron */15 hoặc workflow_dispatch hoặc self-chain)
  │
  ├─► Job timeout 350 phút (loop chạy 300 phút = 5h)
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
  └─► [T=5h] Loop kết thúc → gh workflow run scheduled-dispatch.yml (self re-chain)
        → Chain liên tục, "trái tim" không bao giờ ngưng
```

**Lý do dùng self-loop thay vì cron `*/1`**:
- Cron GitHub thường trễ 5-30 phút khi workflow ít được sử dụng
- Self-loop = 1 process duy nhất, đảm bảo check liên tục mỗi 30s
- Tiết kiệm minute (1 run 5h ≈ 300 min, vs 300 cron run riêng cũng = 300 min nhưng có overhead startup mỗi lần)

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

### 9.6 Core flow #5 — Resilience (watchdog)

```
dispatcher-watchdog.yml (cron */20)
  │
  ├─ Fetch recent runs của scheduled-dispatch.yml
  ├─ Check:
  │    ├─ Có run nào status=in_progress?
  │    └─ Run mới nhất created_at có trong vòng 10 phút?
  │
  └─► If KHÔNG có run live AND no recent activity:
        └─ POST /actions/workflows/scheduled-dispatch.yml/dispatches
           → Hồi sinh trái tim
        └─ Gửi mail alert "Dispatcher was dead, resurrected"
```

→ Hệ thống self-healing, không cần monitor thủ công.

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
| Job timeout | **350 phút** (5h50m, cao hơn loop 50 phút để cho buffer cleanup) |
| Loop duration | **300 phút mặc định** (5h, có thể override qua `loop_minutes` input, max ~330) |
| Check interval | **30 giây** (`CHECK_INTERVAL_SEC = 30`) |
| Permissions | `contents: read`, `actions: write` (cần `actions:write` để dispatch worker) |
| Concurrency | `group: scheduled-dispatch`, `cancel-in-progress: false` (không cancel run đang chạy khi trigger mới) |
| Triggers | `cron: '*/15 * * * *'` (backup) + `workflow_dispatch` (self re-chain) |
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
│  Level 1: SELF-CHAIN (primary)                              │
│  Step 2 cuối job → gh workflow run self                     │
│  ✓ Liên tục 24/7                                            │
│  ✗ Chết nếu: workflow bị disable, GH_PAT hết hạn, gh fail   │
└─────────────────────────────────────────────────────────────┘
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  Level 2: BACKUP CRON (every 15 min)                        │
│  cron: '*/15 * * * *' trong on.schedule                     │
│  ✓ Bắt được lúc chain chết                                  │
│  ✗ GitHub cron có thể trễ 5-30 phút, latency tệ            │
└─────────────────────────────────────────────────────────────┘
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  Level 3: WATCHDOG (dispatcher-watchdog.yml, every 20 min)  │
│  Workflow độc lập, scan recent runs                         │
│  ✓ Detect dead dispatcher + resurrect + email alert         │
│  ✗ Watchdog cũng chết → cần manual intervention             │
└─────────────────────────────────────────────────────────────┘
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  Level 4: MANUAL (last resort)                              │
│  gh workflow run scheduled-dispatch.yml --ref main          │
│  hoặc click "Run workflow" trong Actions UI                 │
└─────────────────────────────────────────────────────────────┘
```

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
4. ⚠️ **KHÔNG đổi `CHECK_INTERVAL_SEC` < 10s** — sẽ làm tăng rate limit consumption và tăng noise log.
5. ⚠️ **KHÔNG đổi `loop_minutes` > 330** — job timeout 350m, cần buffer cho step 2.
6. ⚠️ Sau khi push fix → **manually cancel** run hiện tại + trigger lại (xem 10.9 fix #2).
7. ✅ Mỗi lần thêm field mới vào entry → update cả `process_runs` (server), `addScheduledRun` (client schedule.js), và data model trong section 9.7.
8. ✅ Mỗi lần thêm pattern recurrence → update `should_run_recurring` + UI form + docs.
9. ✅ Log mọi action (dispatch, gist write, error) — log là source of truth khi debug.
10. ✅ Test bằng cách tạo entry `once` cho 2 phút sau → quan sát Actions log → verify dispatch happens trong 30-60s.

### 10.11 Monitoring & observability

- **GitHub Actions logs**: stdout từ Python loop → search keywords `🔹 One-time`, `🔁 Recurring`, `✅ Triggered`, `❌`
- **Dashboard "Live" indicator**: nếu thấy nhiều run của `Scheduled Run Dispatcher` liên tiếp = healthy
- **Watchdog email**: nếu nhận được `🚨 Dispatcher was dead, resurrected` → check WHY (PAT? rate limit?)
- **Gist version history**: GitHub Gist tự track mọi PATCH → `https://gist.github.com/<user>/abc2a47c…/revisions`
