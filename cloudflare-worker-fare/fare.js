// Suica fare proxy worker.
//
// Provides an HTTP API to the static GitHub Pages dashboard for verifying
// IC train fares between two stations in real time. Scrapes Yahoo!路線情報
// (https://transit.yahoo.co.jp/) because gh-pages cannot call it directly
// from the browser (CORS-blocked). Results are cached in KV for ~30 days
// to keep request volume to Yahoo very low.
//
// Endpoints:
//   GET  /fare?from=<kanji>&to=<kanji>     → { fare, source, route_count, ... }
//   GET  /health                            → { ok: true, cache: 'kv' }
//   OPTIONS *                               → CORS preflight
//
// Bindings required (wrangler.toml):
//   FARE_CACHE   — KV namespace, holds fare entries keyed "v1:<from>↔<to>"
//
// Environment-configurable:
//   CACHE_TTL_SEC   default 2592000 (30 days)
//   ALLOWED_ORIGIN  default "*" — restrict to your gh-pages origin in prod
//
// This worker does NOT require auth: it returns only public fare lookups
// (information that is freely searchable). Volume is rate-limited at the
// Yahoo source via our 1s minimum gap + KV cache.

const YAHOO_BASE = 'https://transit.yahoo.co.jp/search/result';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 12000;
const KEY_PREFIX = 'v1:';

// Regex from the Python YahooTransitClient (suica-history-generator skill),
// ported byte-for-byte so the same response format is parsed identically.
const RE_ROUTE_DETAIL_SPLIT = /<div class="routeDetail"/gi;
const RE_LEG_FARE = /<p\s+class="fare"[^>]*>\s*<span>\s*(\d[\d,]*)\s*円\s*<\/span>/gi;

function corsHeaders(env) {
  const origin = (env && env.ALLOWED_ORIGIN) || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function json(body, init = {}, env) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      ...corsHeaders(env),
      ...(init.headers || {}),
    },
  });
}

function err(status, message, env) {
  return json({ ok: false, error: message }, { status }, env);
}

function pairKey(a, b) {
  // Match the JS planner's pairKey: localeCompare('ja') for stable canonical form.
  const [x, y] = [a, b].sort((p, q) => p.localeCompare(q, 'ja'));
  return `${x}↔${y}`;
}

async function fetchYahoo(from, to) {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const params = new URLSearchParams({
    from, to,
    y: String(y), m, d,
    hh: '09', m1: '0', m2: '0',
    type: '1',        // 出発
    ticket: 'ic',     // IC fare
    expkind: '1',     // allow 特急 freely (but cheapest route picked anyway)
  });
  const url = `${YAHOO_BASE}?${params.toString()}`;
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ja,en;q=0.7',
      },
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      return { ok: false, status: resp.status, error: `Yahoo HTTP ${resp.status}` };
    }
    const html = await resp.text();
    const totals = extractRouteFares(html);
    if (!totals.length) {
      return { ok: false, status: 502, error: 'No fare rows in Yahoo response' };
    }
    const cheapest = Math.min(...totals);
    return { ok: true, fare: cheapest, route_count: totals.length };
  } catch (e) {
    return { ok: false, status: 504, error: String(e && e.message || e) };
  } finally {
    clearTimeout(tid);
  }
}

function extractRouteFares(html) {
  const totals = [];
  // Skip the first chunk (page header before any routeDetail).
  const blocks = html.split(RE_ROUTE_DETAIL_SPLIT).slice(1);
  for (const block of blocks) {
    let sum = 0;
    let hits = 0;
    RE_LEG_FARE.lastIndex = 0;
    let mm;
    while ((mm = RE_LEG_FARE.exec(block)) !== null) {
      const v = parseInt(mm[1].replace(/,/g, ''), 10);
      if (Number.isFinite(v)) { sum += v; hits++; }
    }
    if (hits > 0 && sum > 0) totals.push(sum);
  }
  return totals;
}

async function handleFare(url, env, ctx) {
  const from = (url.searchParams.get('from') || '').trim();
  const to = (url.searchParams.get('to') || '').trim();
  if (!from || !to) return err(400, 'from and to are required', env);
  if (from === to) return json({ ok: true, fare: 0, source: 'identity', from, to }, {}, env);

  const ttl = parseInt((env && env.CACHE_TTL_SEC) || '2592000', 10);
  const key = KEY_PREFIX + pairKey(from, to);

  // 1) KV cache
  if (env && env.FARE_CACHE) {
    const cached = await env.FARE_CACHE.get(key, { type: 'json' });
    if (cached && typeof cached.fare === 'number') {
      return json({
        ok: true, fare: cached.fare, source: 'cache',
        cached_at: cached.cached_at, original_source: cached.source || 'yahoo',
        route_count: cached.route_count || null,
        from, to,
      }, {}, env);
    }
  }

  // 2) Live scrape
  const r = await fetchYahoo(from, to);
  if (!r.ok) {
    return err(r.status || 502, r.error || 'Yahoo lookup failed', env);
  }
  const payload = {
    fare: r.fare,
    source: 'yahoo',
    route_count: r.route_count,
    cached_at: new Date().toISOString(),
  };
  // 3) Store in KV (best-effort; don't block response if write fails)
  if (env && env.FARE_CACHE) {
    ctx.waitUntil(env.FARE_CACHE.put(key, JSON.stringify(payload), { expirationTtl: ttl }));
  }
  return json({ ok: true, ...payload, from, to }, {}, env);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }
    if (request.method !== 'GET') {
      return err(405, 'GET only', env);
    }
    if (url.pathname === '/health') {
      return json({ ok: true, cache: env && env.FARE_CACHE ? 'kv' : 'none' }, {}, env);
    }
    if (url.pathname === '/fare') {
      return handleFare(url, env, ctx);
    }
    return err(404, 'Not found. Try /fare?from=東京&to=川崎', env);
  },
};
