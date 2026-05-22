// ═══════════════════════════════════════════════════════════════════
// FJP Workflow Dashboard — GitHub API Proxy (Cloudflare Worker)
// ═══════════════════════════════════════════════════════════════════
// Holds the GitHub PAT as a Worker secret so it never leaves the
// server. Browser sends UN-authenticated requests; Worker injects the
// token and forwards to api.github.com.
//
// Defense layers (in order):
//   1. Origin allowlist  — only requests from the GH Pages site (or
//      localhost in dev) are honored. Browsers enforce this via CORS;
//      this stops casual XHR abuse from other websites.
//   2. Route allowlist   — only the specific endpoints the dashboard
//      actually uses are forwarded. Limits damage if the worker URL
//      leaks (no `DELETE /repos/...` allowed, no arbitrary user repos).
//   3. Gist allowlist    — only the configured GIST_ID is touchable.
//   4. Read-only by default — POST/PATCH only allowed on safe routes.
//
// Setup:
//   1. `npm install -g wrangler && wrangler login`
//   2. `wrangler secret put GITHUB_PAT`   ← paste fine-grained PAT
//   3. Edit `wrangler.toml`: set ALLOWED_ORIGIN, REPO_OWNER, REPO_NAME, GIST_ID
//   4. `wrangler deploy`
//   5. Copy the worker URL → paste into Dashboard Settings → "Proxy URL"
// ═══════════════════════════════════════════════════════════════════

const GITHUB_API = 'https://api.github.com';

// Paths that are always safe to forward (any method allowed for these).
// All path matching is prefix-based and respects the configured repo + gist.
function buildRouteRules(env) {
  const owner = env.REPO_OWNER || '';
  const repo = env.REPO_NAME || '';
  const gistId = env.GIST_ID || '';
  return [
    // Repo-scoped routes (only the configured repo) — used for workflow runs,
    // dispatches, artifacts, contents, etc.
    {
      test: (p) => owner && repo && p.startsWith(`/repos/${owner}/${repo}/`),
      methods: ['GET', 'HEAD', 'POST', 'PATCH', 'PUT'],
    },
    // Gist read/write — only the configured Gist.
    {
      test: (p) => gistId && (p === `/gists/${gistId}` || p.startsWith(`/gists/${gistId}/`)),
      methods: ['GET', 'HEAD', 'PATCH'],
    },
    // Identity-only — used to verify token validity in Settings.
    {
      test: (p) => p === '/user',
      methods: ['GET', 'HEAD'],
    },
    // Rate-limit introspection (no side effects).
    {
      test: (p) => p === '/rate_limit',
      methods: ['GET', 'HEAD'],
    },
  ];
}

function isAllowedOrigin(origin, env) {
  if (!origin) return false;
  const list = (env.ALLOWED_ORIGIN || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.some((allowed) => {
    if (allowed === '*') return true;
    if (allowed.endsWith('/*')) return origin.startsWith(allowed.slice(0, -2));
    return origin === allowed;
  });
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, PATCH, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Content-Type, If-None-Match, If-Match',
    'Access-Control-Expose-Headers':
      'ETag, X-OAuth-Scopes, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After, github-authentication-token-expiration',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function deny(message, status, origin) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin || '*'),
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);

    // Preflight
    if (request.method === 'OPTIONS') {
      if (!isAllowedOrigin(origin, env)) return deny('Origin not allowed', 403, '*');
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // Health check (no auth needed, no GitHub call)
    if (url.pathname === '/__health') {
      return new Response('ok', { status: 200, headers: corsHeaders(origin || '*') });
    }

    // Enforce origin on every real request
    if (!isAllowedOrigin(origin, env)) {
      return deny('Origin not allowed', 403, origin || '*');
    }

    // Strip a `/gh` prefix if the client uses one (cleaner URLs)
    let path = url.pathname;
    if (path.startsWith('/gh/')) path = path.slice(3);
    if (path === '/gh') path = '/';

    // Route allowlist
    const rules = buildRouteRules(env);
    const rule = rules.find((r) => r.test(path));
    if (!rule) return deny(`Route not allowed: ${path}`, 403, origin);
    if (!rule.methods.includes(request.method)) {
      return deny(`Method ${request.method} not allowed for ${path}`, 405, origin);
    }

    if (!env.GITHUB_PAT) return deny('Worker not configured (no PAT)', 500, origin);

    // Forward to GitHub. Preserve query string + body. Inject PAT.
    const ghUrl = GITHUB_API + path + url.search;
    const fwdHeaders = new Headers();
    fwdHeaders.set('Authorization', `Bearer ${env.GITHUB_PAT}`);
    fwdHeaders.set('Accept', request.headers.get('Accept') || 'application/vnd.github+json');
    fwdHeaders.set('User-Agent', 'fjp-dashboard-proxy');
    const passThrough = ['Content-Type', 'If-None-Match', 'If-Match'];
    for (const h of passThrough) {
      const v = request.headers.get(h);
      if (v) fwdHeaders.set(h, v);
    }

    const init = {
      method: request.method,
      headers: fwdHeaders,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      // Important so the body stream is forwardable
      ...(['GET', 'HEAD'].includes(request.method) ? {} : { duplex: 'half' }),
    };

    let ghResp;
    try {
      ghResp = await fetch(ghUrl, init);
    } catch (e) {
      return deny(`Upstream fetch failed: ${e.message}`, 502, origin);
    }

    // Mirror GitHub response with CORS headers added. Preserve rate-limit
    // and conditional-request headers so the client can still see them.
    const respHeaders = new Headers(ghResp.headers);
    for (const [k, v] of Object.entries(corsHeaders(origin))) {
      respHeaders.set(k, v);
    }
    // Strip the upstream Authorization echo if any (defense in depth)
    respHeaders.delete('Authorization');

    return new Response(ghResp.body, {
      status: ghResp.status,
      statusText: ghResp.statusText,
      headers: respHeaders,
    });
  },
};
