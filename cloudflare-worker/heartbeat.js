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

export default {
  async scheduled(event, env, ctx) {
    const repo = env.REPO || 'VuTan11501/Code';
    const token = env.GH_PAT;
    if (!token) {
      console.error('❌ GH_PAT secret not configured');
      return;
    }
    const url = `https://api.github.com/repos/${repo}/dispatches`;
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Accept': 'application/vnd.github+json',
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'cf-worker-dokokin-heartbeat',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({ event_type: 'heartbeat' }),
      });
      if (resp.status === 204) {
        console.log(`✅ heartbeat → 204 (${repo})`);
      } else {
        const text = await resp.text();
        console.warn(`⚠️ heartbeat → ${resp.status}: ${text.slice(0, 200)}`);
      }
    } catch (err) {
      console.error(`❌ heartbeat fetch failed: ${err.message}`);
    }
  },

  // Optional HTTP endpoint for manual ping / health check.
  // GET https://<your-worker>.workers.dev/  → triggers heartbeat immediately.
  async fetch(request, env, ctx) {
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405 });
    }
    const repo = env.REPO || 'VuTan11501/Code';
    const token = env.GH_PAT;
    if (!token) {
      return new Response('GH_PAT not configured', { status: 500 });
    }
    const resp = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'cf-worker-dokokin-heartbeat',
      },
      body: JSON.stringify({ event_type: 'heartbeat' }),
    });
    return new Response(`heartbeat → ${resp.status}\n`, {
      status: resp.status === 204 ? 200 : resp.status,
      headers: { 'Content-Type': 'text/plain' },
    });
  },
};
