// Cloudflare Worker: external heartbeat pinger for DokoKin dispatcher.
//
// What it does: runs on Cloudflare's cron (independent of GitHub Actions),
// sends a `repository_dispatch` event with type=heartbeat to the GitHub repo
// every 2 minutes. The repo's `heartbeat.yml` workflow then verifies the
// scheduled-dispatcher is alive and resurrects it if not.
//
// Why: GitHub Actions native cron is best-effort and can be skipped during
// load. Cloudflare Workers Cron Triggers are highly reliable. Combining
// both layers means a multi-hour dispatcher gap is essentially impossible.
//
// Free tier: 100,000 requests/day. We use ~720/day (every 2min). Plenty.
//
// ─── DEPLOYMENT ──────────────────────────────────────────────────────────
//
// 1. Install Wrangler:    npm install -g wrangler
// 2. Login:               wrangler login
// 3. From this directory: wrangler secret put GH_PAT       (paste classic PAT
//                                                            with 'repo' scope)
// 4. Edit wrangler.toml [vars] REPO if your repo name changes
// 5. Deploy:              wrangler deploy
//
// To verify after deploy:
//   wrangler tail              # live log streaming
//   - Should see "✅ heartbeat → 204" every 2 minutes.
//
// To pause:
//   wrangler deployments list
//   wrangler delete            # or comment out [triggers] in wrangler.toml + redeploy
//
// ─── COST ────────────────────────────────────────────────────────────────
// 720 invocations/day. Cloudflare free plan: 100,000/day. ~0.7% utilization.

// Map cron expression → repository_dispatch event_type.
// Add new daily/periodic triggers here without changing dispatch logic.
const CRON_EVENT_MAP = {
  '*/2 * * * *': 'heartbeat',              // dispatcher liveness check
  '0 22 * * *':  'anomaly_check_daily',    // 07:00 JST → AI anomaly scan
};

// Endpoints that fire CI/CO from Siri Shortcuts (or any HTTP client).
// Each maps an HTTP path → repository_dispatch event_type and supplies a
// default `location` in client_payload that the worker workflow forwards
// to gh_checkin.py via FORCE_LOCATION. Override with `?location=home`.
const ACTION_ENDPOINTS = {
  '/checkin':  { event: 'manual_checkin',  defaultLocation: 'office' },
  '/checkout': { event: 'manual_checkout', defaultLocation: 'home' },
};

async function dispatchEvent(repo, token, eventType, clientPayload) {
  const body = { event_type: eventType };
  if (clientPayload && Object.keys(clientPayload).length) {
    body.client_payload = clientPayload;
  }
  const resp = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
    method: 'POST',
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'cf-worker-dokokin-heartbeat',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify(body),
  });
  return resp;
}

// Constant-time-ish string compare for the shared-secret token.
// Workers don't expose crypto.timingSafeEqual, so we implement it manually.
function tokenMatches(presented, expected) {
  if (!presented || !expected || presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < presented.length; i++) {
    diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

export default {
  async scheduled(event, env, ctx) {
    const repo = env.REPO || 'VuTan11501/Code';
    const token = env.GH_PAT;
    if (!token) {
      console.error('❌ GH_PAT secret not configured');
      return;
    }
    const eventType = CRON_EVENT_MAP[event.cron] || 'heartbeat';
    try {
      const resp = await dispatchEvent(repo, token, eventType, null);
      if (resp.status === 204) {
        console.log(`✅ ${eventType} → 204 (${repo}, cron="${event.cron}")`);
      } else {
        const text = await resp.text();
        console.warn(`⚠️ ${eventType} → ${resp.status}: ${text.slice(0, 200)}`);
      }
    } catch (err) {
      console.error(`❌ ${eventType} fetch failed: ${err.message}`);
    }
  },

  // HTTP endpoint — used by Siri Shortcuts and manual ad-hoc fires.
  //
  //   GET /checkin                           → CI at default location (office)
  //   GET /checkin?location=home             → CI at home
  //   GET /checkout                          → CO at default location (home)
  //   GET /checkout?location=office          → CO at office
  //   GET /?event=anomaly_check_daily        → fire arbitrary event_type
  //   GET /                                  → fire heartbeat (default)
  //
  // All endpoints require `Authorization: Bearer <WORKER_AUTH_TOKEN>` header
  // OR `?token=<...>` query param. WORKER_AUTH_TOKEN is set via:
  //   wrangler secret put WORKER_AUTH_TOKEN
  // and embedded in the Siri Shortcut URL (private to your iCloud).
  async fetch(request, env, ctx) {
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405 });
    }

    const repo = env.REPO || 'VuTan11501/Code';
    const ghToken = env.GH_PAT;
    const expectedAuth = env.WORKER_AUTH_TOKEN;
    if (!ghToken) {
      return new Response('GH_PAT not configured', { status: 500 });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    // ── Auth ──────────────────────────────────────────────
    // Skip auth only for GET / with no params (legacy heartbeat ping).
    const isLegacyHeartbeatPing =
      path === '/' && url.searchParams.size === 0;
    if (!isLegacyHeartbeatPing) {
      if (!expectedAuth) {
        return new Response('WORKER_AUTH_TOKEN not configured', { status: 500 });
      }
      const presented =
        (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim() ||
        url.searchParams.get('token') || '';
      if (!tokenMatches(presented, expectedAuth)) {
        return new Response('Unauthorized\n', { status: 401 });
      }
    }

    // ── Action endpoints (/checkin, /checkout) ───────────
    const action = ACTION_ENDPOINTS[path];
    if (action) {
      const location = url.searchParams.get('location') || action.defaultLocation;
      const payload = { location, source: 'cf-worker', triggered_at: new Date().toISOString() };
      try {
        const resp = await dispatchEvent(repo, ghToken, action.event, payload);
        const ok = resp.status === 204;
        const body = ok
          ? `✅ ${action.event} (${location}) dispatched\n`
          : `❌ ${action.event} → ${resp.status}: ${(await resp.text()).slice(0, 200)}\n`;
        return new Response(body, {
          status: ok ? 200 : resp.status,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      } catch (err) {
        return new Response(`❌ dispatch failed: ${err.message}\n`, { status: 500 });
      }
    }

    // ── Generic /?event=... fallback ─────────────────────
    if (path === '/') {
      const eventType = url.searchParams.get('event') || 'heartbeat';
      const resp = await dispatchEvent(repo, ghToken, eventType, null);
      return new Response(`${eventType} → ${resp.status}\n`, {
        status: resp.status === 204 ? 200 : resp.status,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    return new Response(`Unknown path: ${path}\n`, { status: 404 });
  },
};
