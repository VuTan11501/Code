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
| `auto-ot-creator.yml` | dispatch (10:00 JST) | Worker tạo OT — **luôn gửi email summary** |
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

### Azure AD
- App ID `f5be0f68-7285-4365-b979-10af0f3f4106`
- Tenant `f01e930a-b52e-42b1-b70f-a8882b5d043b`
- Scope `api://{AZURE_APP_ID}/openid user.read offline_access`
- Flow: OAuth2 Auth Code + PKCE (public client). Redirect URI = mobile `msauth.com.fjp.portal://auth`.
- **Refresh token rotate**: workflow detect → set output `token_rotated=true` + `new_refresh_token` → step kế `gh secret set AZURE_REFRESH_TOKEN`. Cần secret `GH_PAT` (PAT có scope `repo`).
- Refresh token sống ~90 ngày. Nếu chết → re-run skill `--setup`.

### Schedule Gist
- ID: `abc2a47c0a396025a72a6580227ff493`
- File: `scheduled-runs.json`
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
- **Checkin/checkout/OT-creator**: luôn gửi mail summary (trừ `skip` cho checkin/checkout)
- **OT-creator status badges**: ✅ CREATED / ℹ️ UP-TO-DATE / ⏳ WAITING / 🚨 ERROR / 💤 NO-OP
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
- **OT-creator**: skip entry nếu đã tồn tại trong KINTAI

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
