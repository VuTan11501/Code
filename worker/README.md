# Cloudflare Worker — GitHub API Proxy

Giữ GitHub PAT trên server (Worker Secret) thay vì lộ trong DevTools Network của browser. Browser gọi Worker → Worker inject PAT → forward tới `api.github.com`.

## Vì sao cần?

Trước khi có Worker: mỗi request từ browser tới `https://api.github.com/...` đều có header `Authorization: Bearer ghp_xxx`. PAT này nhìn thấy ngay trong DevTools → Network → Request Headers. Bất kỳ ai mượn máy hoặc share screen đều có thể đánh cắp.

Sau khi có Worker: browser gọi `https://fjp-dashboard-proxy.<your>.workers.dev/repos/...` không kèm token. Worker đọc PAT từ Worker Secret (encrypted at rest, không bao giờ lộ trong response).

## Defense layers

1. **Origin allowlist** — chỉ chấp nhận request từ `https://vutan11501.github.io` (và localhost khi dev). Browser cross-origin sẽ bị CORS chặn.
2. **Route allowlist** — chỉ forward các path cụ thể: `/repos/{your-repo}/*`, `/gists/{your-gist-id}`, `/user`, `/rate_limit`. Tất cả khác → 403.
3. **Gist + Repo ID hardcode** — kể cả khi route shape match, nếu sai owner/gist-id → 403.
4. **Method allowlist per route** — gist chỉ cho PATCH (không DELETE).
5. **Worker rate limit** — Cloudflare áp 100k requests/day free tier.

Nếu Worker URL bị leak ra ngoài, attacker chỉ có thể thao tác trên đúng repo/gist của bạn — không phải toàn bộ account.

## Deploy lần đầu (5 phút)

### Yêu cầu
- Tài khoản Cloudflare (free tier OK)
- Node 18+ (cho `wrangler` CLI)

### Bước 1 — Cài Wrangler

```bash
npm install -g wrangler
wrangler login   # mở browser, login Cloudflare
```

### Bước 2 — Cấu hình

Mở `worker/wrangler.toml`, kiểm tra:
- `ALLOWED_ORIGIN` — origin của site bạn (GH Pages URL)
- `REPO_OWNER` / `REPO_NAME` — repo chứa workflows
- `GIST_ID` — gist dashboard dùng để sync state
- `GIST_ID_TIMESHEET` / `GIST_ID_PAYSLIP` — optional shard gist IDs (để trống nếu dùng 1 gist)

Nếu khác giá trị mặc định, sửa lại.

### Bước 3 — Lưu PAT làm Worker Secret

```bash
cd worker
wrangler secret put GITHUB_PAT
# paste fine-grained PAT có quyền: repo (Actions read+write, Contents read), gist
```

Secret được Cloudflare encrypt-at-rest, KHÔNG có cách nào export ra plaintext sau khi set.

### Bước 4 — Deploy

```bash
wrangler deploy
```

Output sẽ in URL kiểu `https://fjp-dashboard-proxy.<your-account>.workers.dev`.

### Bước 5 — Bật trong Dashboard

1. Mở dashboard → ⚙️ Settings
2. Tìm phần **GitHub API Proxy**
3. Dán Worker URL → bấm **Test** (sẽ gọi `/__health` rồi `/user`)
4. Bấm **Save** → reload trang

Từ giờ tất cả request GitHub đi qua Worker. Mở DevTools Network → không còn `Authorization: Bearer ghp_*`.

## Verify

Sau khi bật, vào DevTools → Network → reload page. Kiểm tra:
- ✅ Request URL → `<worker-url>/gists/...` thay vì `api.github.com/gists/...`
- ✅ Request Headers → KHÔNG có `Authorization`
- ✅ Response Headers → vẫn còn `X-OAuth-Scopes`, `X-RateLimit-*`, `ETag` (Worker forward đúng)

## Rotate / Tắt

**Rotate PAT** (PAT lộ, GitHub báo expired, v.v.):
```bash
cd worker
wrangler secret put GITHUB_PAT   # paste PAT mới
```
Không cần redeploy — secret apply ngay.

**Tắt Worker tạm thời** (hết quota, debug):
```bash
wrangler delete
```
Dashboard sẽ tự fallback gọi trực tiếp `api.github.com` (PAT vẫn được dùng trực tiếp, kém an toàn hơn nhưng không gãy app).

**Xoá hẳn**:
- Xoá Worker URL trong Settings → reload → trở lại direct mode.

## Cấu trúc file

```
worker/
├── src/
│   └── index.js      ← Worker code (fetch handler + route allowlist)
├── wrangler.toml     ← config (vars + bindings, KHÔNG chứa secrets)
└── README.md         ← file này
```

## Local development

```bash
cd worker
wrangler dev          # chạy local trên http://localhost:8787
```

Trong Settings của Dashboard, set Proxy URL = `http://localhost:8787` để test.

⚠️ `wrangler dev` đọc secrets từ `.dev.vars` (không commit). Tạo `.dev.vars` với:
```
GITHUB_PAT=ghp_xxx
```

## Troubleshooting

| Triệu chứng | Nguyên nhân | Fix |
|---|---|---|
| `403 Origin not allowed` | `ALLOWED_ORIGIN` trong `wrangler.toml` không khớp site | Sửa + redeploy |
| `403 Route not allowed` | Đường dẫn không nằm trong allowlist | Kiểm tra bạn có dùng đúng repo/gist trong config không |
| `500 Worker not configured (no PAT)` | Quên `wrangler secret put GITHUB_PAT` | Set secret rồi reload |
| `502 Upstream fetch failed` | GitHub down hoặc network | Đợi vài giây, retry |
| Dashboard vẫn lộ PAT | Quên dán URL vào Settings, hoặc URL sai | Vào Settings, dán đúng URL Worker, Test |
