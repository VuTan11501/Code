# suica-fare-proxy

Cloudflare Worker giúp dashboard Suica trên GitHub Pages verify giá vé tàu
real-time bằng cách scrape Yahoo!路線情報 (CORS-blocked nếu gọi trực tiếp
từ browser). Kết quả cache 30 ngày trong KV để giảm load.

## Endpoint

```
GET /fare?from=鶴見&to=川崎
```

Response:

```json
{
  "ok": true,
  "fare": 199,
  "source": "yahoo",
  "route_count": 3,
  "cached_at": "2026-05-23T01:30:00.000Z",
  "from": "鶴見",
  "to": "川崎"
}
```

`source` có thể là:
- `yahoo` — vừa scrape live từ Yahoo Transit
- `cache` — đọc từ KV cache (response cũng có `original_source` + `cached_at`)
- `identity` — `from == to` → trả ¥0 ngay

## Deploy (lần đầu)

```bash
cd cloudflare-worker-fare
npm install -g wrangler        # nếu chưa có
wrangler login                  # OAuth vào CF account của bạn

# 1) Tạo KV namespace
wrangler kv:namespace create FARE_CACHE
# → copy "id" được in ra, paste vào wrangler.toml chỗ REPLACE_WITH_KV_NAMESPACE_ID

# 2) Deploy
wrangler deploy
# → in ra URL dạng https://suica-fare-proxy.<your-account>.workers.dev
```

## Cấu hình frontend

Trong `docs/js/suica-planner.js`, set `state.fareApiUrl`:

```js
state.fareApiUrl = 'https://suica-fare-proxy.<your-account>.workers.dev';
```

Hoặc inject qua `window.SUICA_FARE_API` trong `docs/suica.html` trước khi
load planner script:

```html
<script>window.SUICA_FARE_API = 'https://suica-fare-proxy.you.workers.dev';</script>
<script src="js/suica-planner.js?v=13" defer></script>
```

Khi unset, planner hoạt động như cũ (chỉ dùng static 3-tier — verified table
→ Dijkstra graph → distance bracket). Worker chỉ là **augment**, không phải
single point of failure.

## Lock down origin (production)

Sau khi deploy:

```bash
wrangler secret put ALLOWED_ORIGIN
# nhập: https://vutan11501.github.io
```

Hoặc edit `wrangler.toml` `[vars] ALLOWED_ORIGIN`.

## Cost

CF Workers free tier:
- 100K requests/ngày
- KV: 100K reads/ngày, 1K writes/ngày, 1GB storage

Với 30-day cache, một user dùng dashboard cả tháng chắc chỉ gây ~50-200 unique
OD lookups → cách rất xa giới hạn.

## Caveats

- Yahoo HTML có thể đổi structure. Nếu scraper hỏng, response sẽ là `502 No fare rows`
  → planner fallback về static estimate. Sửa regex trong `fare.js`.
- ToS Yahoo: dùng cho personal use, không bulk-scrape. Cache 30 ngày + 1
  request/lookup là hoàn toàn an toàn.
- Không có rate-limit per-IP trong worker hiện tại. Nếu deploy public, thêm
  `request.cf.colo` based throttling.
