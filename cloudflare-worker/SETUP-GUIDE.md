# Setup Guide — Dispatcher Heartbeat (External Pingers)

Bạn cần làm 1 trong 2 (hoặc cả 2) để kích hoạt redundancy chống GitHub cron skip.

## Option A — Cloudflare Worker (khuyến nghị, 2-phút interval)

### Đã làm sẵn cho bạn
- ✅ `wrangler` 4.93 đã cài global trên máy
- ✅ Code worker + config sẵn sàng trong `cloudflare-worker/`
- ✅ `wrangler login` đã thử mở browser

### Bạn cần làm (5 phút)

```powershell
cd C:\Users\Admin\Desktop\Code\cloudflare-worker

# 1. Login (mở browser, click Allow)
wrangler login

# 2. Set GitHub PAT secret (paste khi được hỏi)
wrangler secret put GH_PAT
# → Paste classic PAT scope=repo (cùng PAT đã set trong GitHub repo secrets)

# 3. Deploy
wrangler deploy

# 4. Verify (live log stream, mỗi 2 phút sẽ thấy "✅ heartbeat → 204")
wrangler tail
```

**Nếu chưa có account Cloudflare**: đăng ký free tại https://dash.cloudflare.com/sign-up (chỉ cần email, không cần thẻ).

**Nếu chưa có classic PAT**:
- GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)
- Generate new token (classic), scope `repo` only
- Expiration: 1 year (hoặc no expiration)
- Copy token, dùng cho `wrangler secret put GH_PAT`

### Verify hoạt động

Sau `wrangler deploy`, vào https://github.com/VuTan11501/Code/actions/workflows/heartbeat.yml — sẽ thấy run mới mỗi 2 phút với label `repository_dispatch`.

---

## Option B — cron-job.org (interval 1-5 phút, không cần CLI)

Phương án dự phòng cho Option A, hoặc dùng song song để có 2 nguồn ping độc lập.

### Bạn cần làm (3 phút)

1. Đăng ký free tại https://cron-job.org (chỉ cần email)
2. Cronjobs → **Create cronjob**
3. **Common** tab:
   - Title: `DokoKin Heartbeat`
   - URL: `https://api.github.com/repos/VuTan11501/Code/dispatches`
   - Schedule: Every 5 minutes
4. **Advanced** tab:
   - Request method: `POST`
   - Request headers (3 dòng):
     ```
     Accept: application/vnd.github+json
     Authorization: Bearer ghp_xxx_your_classic_PAT
     Content-Type: application/json
     ```
   - Request body:
     ```json
     {"event_type":"heartbeat"}
     ```
5. Save & Enable

### Verify

Sau 5 phút, vào https://github.com/VuTan11501/Code/actions/workflows/heartbeat.yml — sẽ thấy run mới với event `repository_dispatch`.

cron-job.org cũng hiển thị status code 204 trong tab "History" của job.

---

## Lựa chọn

| Tiêu chí | Cloudflare Worker | cron-job.org |
|---|---|---|
| Setup time | ~5 phút (cần CLI) | ~3 phút (chỉ web) |
| Interval | 2 phút | 1 phút |
| Reliability | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| Free tier | 100k req/day | unlimited |
| Vendor lock | Cloudflare account | cron-job.org account |

→ **Khuyên dùng**: chỉ cần 1 trong 2. Nếu paranoid (như mình), chạy cả 2 song song — heartbeat workflow đã có concurrency group `heartbeat` nên trigger trùng lặp sẽ tự queue/skip.

## Disable nếu muốn

- **Cloudflare**: `wrangler delete` trong thư mục `cloudflare-worker/`
- **cron-job.org**: Toggle Disable trong dashboard
- **In-repo only**: không cần làm gì, `heartbeat.yml` chỉ chạy khi nhận event ngoài
