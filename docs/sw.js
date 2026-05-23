// Service Worker for Workflow Dashboard.
//   * Push notifications: install/activate/notificationclick handlers below.
//   * Offline support:
//       - APP SHELL (HTML, bundle, CSS, icons, fonts) → cache-first with
//         background revalidation. App boots instantly even offline.
//       - GITHUB API (api.github.com) → network-first, 24h cache fallback.
//         Lets users browse while on flaky train wifi. Writes (non-GET)
//         are NEVER cached and always go through to network.
//       - Everything else passes through untouched.
//   * Update flow: new SW activates → postMessage {type:'sw-updated'} to
//     all clients. app.js shows a "Reload to update" toast.

const VERSION = 'wf-dash-v5';
const SHELL_CACHE = `${VERSION}-shell`;
const API_CACHE   = `${VERSION}-api`;
const API_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/tailwind.css',
  './css/style.css',
  './dist/app.bundle.min.js',
  './favicon/favicon.svg',
  './favicon/favicon-96x96.png',
  './favicon/web-app-manifest-192x192.png',
  './favicon/web-app-manifest-512x512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // Individual adds so a single 404 (e.g. renamed icon) doesn't tank install.
    await Promise.all(SHELL_ASSETS.map(async (url) => {
      try { await cache.add(new Request(url, { cache: 'reload' })); }
      catch (e) { console.warn('[sw] shell add failed', url, e); }
    }));
    // Activate immediately so first install becomes useful right away.
    // (Subsequent updates wait for an explicit skipWaiting message.)
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter(n => n.startsWith('wf-dash-') && !n.startsWith(VERSION))
        .map(n => caches.delete(n))
    );
    await self.clients.claim();
    const clients = await self.clients.matchAll({ includeUncontrolled: true });
    for (const c of clients) {
      try { c.postMessage({ type: 'sw-updated', version: VERSION }); } catch {}
    }
  })());
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'skipWaiting') self.skipWaiting();
  if (data.type === 'clearCaches') {
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))));
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.hostname === 'api.github.com' || url.hostname === 'gist.githubusercontent.com') {
    event.respondWith(networkFirstApi(req));
    return;
  }
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(cacheFirst(req, SHELL_CACHE));
    return;
  }
  if (url.origin === self.location.origin) {
    if (req.headers.get('range')) return;
    // Navigation / HTML shell: stale-while-revalidate with content-diff
    // detection. Instant paint from cache; if the network copy differs we
    // postMessage clients so app.js can surface the "Reload to update" toast
    // — meaning fresh CSP / HTML reaches users in ONE invisible reload cycle
    // without bumping VERSION every deploy.
    const isShell = req.mode === 'navigate' ||
      url.pathname === '/' || url.pathname.endsWith('/index.html');
    if (isShell) {
      event.respondWith(swrShell(req, SHELL_CACHE));
      return;
    }
    event.respondWith(cacheFirst(req, SHELL_CACHE));
    return;
  }
});

// In-flight revalidations keyed by URL — coalesces concurrent navigation
// requests so we only fire ONE fetch + ONE 'shell-updated' postMessage per
// SW lifecycle even if user opens multiple tabs simultaneously. Hash of last
// notified body also lives here to suppress duplicate notifications if cache
// fails to persist (Safari quota, private mode, etc.).
const _swrInFlight = new Map();
let _lastNotifiedHash = null;

async function _hashText(text) {
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
  } catch { return String(text.length); }
}

async function swrShell(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const key = req.url;
  let revalidate = _swrInFlight.get(key);
  if (!revalidate) {
    revalidate = (async () => {
      try {
        const resp = await fetch(req);
        if (!resp || !resp.ok || resp.type !== 'basic') return resp;
        if (cached) {
          const [oldText, newText] = await Promise.all([
            cached.clone().text(),
            resp.clone().text(),
          ]);
          if (oldText !== newText) {
            const newHash = await _hashText(newText);
            if (newHash !== _lastNotifiedHash) {
              _lastNotifiedHash = newHash;
              const clients = await self.clients.matchAll({ includeUncontrolled: true });
              for (const c of clients) {
                try { c.postMessage({ type: 'shell-updated', hash: newHash }); } catch {}
              }
            }
          }
        }
        await cache.put(req, resp.clone());
        return resp;
      } catch { return null; }
      finally { _swrInFlight.delete(key); }
    })();
    _swrInFlight.set(key, revalidate);
  }
  if (cached) return cached;
  // No cached copy yet — wait for network. Only fall back to the app shell
  // (index.html) if the network ALSO failed, so requests for other HTML pages
  // like suica.html still resolve to their actual content on first visit.
  const fresh = await revalidate;
  if (fresh) return fresh;
  const shellFallback = await cache.match('./index.html');
  if (shellFallback) return shellFallback;
  throw new Error('shell unavailable');
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const url = new URL(req.url);
  // Honor cache-busting query strings (e.g. `dist/app.bundle.min.js?v=5`) for
  // same-origin shell assets — without this, bumping ?v=N had no effect and
  // the OLD bundle kept being served even after a fresh deploy. Cross-origin
  // assets (fonts.gstatic.com) keep ignoreSearch because their URLs already
  // version themselves via path hashes.
  const sameOrigin = url.origin === self.location.origin;
  const matchOpts = sameOrigin ? {} : { ignoreSearch: true };
  const cached = await cache.match(req, matchOpts);
  if (cached) {
    fetch(req).then(resp => {
      if (resp && resp.ok && resp.type === 'basic') {
        cache.put(req, resp.clone()).catch(() => {});
      }
    }).catch(() => {});
    return cached;
  }
  try {
    const resp = await fetch(req);
    if (resp && resp.ok && (resp.type === 'basic' || resp.type === 'cors')) {
      cache.put(req, resp.clone()).catch(() => {});
    }
    return resp;
  } catch (e) {
    if (req.mode === 'navigate') {
      const shell = await cache.match('./index.html');
      if (shell) return shell;
    }
    throw e;
  }
}

async function networkFirstApi(req) {
  const cache = await caches.open(API_CACHE);
  try {
    const resp = await fetch(req);
    if (resp && resp.ok) {
      const stamped = await stampResponse(resp.clone());
      cache.put(req, stamped).catch(() => {});
    }
    return resp;
  } catch (e) {
    const cached = await cache.match(req);
    if (cached) {
      const age = freshnessAge(cached);
      if (age < API_CACHE_MAX_AGE_MS) return cached;
    }
    throw e;
  }
}

async function stampResponse(resp) {
  const headers = new Headers(resp.headers);
  headers.set('x-sw-cached-at', String(Date.now()));
  const body = await resp.blob();
  return new Response(body, { status: resp.status, statusText: resp.statusText, headers });
}

function freshnessAge(resp) {
  const ts = parseInt(resp.headers.get('x-sw-cached-at') || '0', 10);
  if (!ts) return Infinity;
  return Date.now() - ts;
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // If an existing window matches the target, focus it.
      for (const client of clientList) {
        try {
          if (client.url === targetUrl && 'focus' in client) return client.focus();
        } catch {}
      }
      // Otherwise focus any dashboard window and navigate, or open a new one.
      for (const client of clientList) {
        if (client.url.includes('/docs/') || client.url.endsWith('/')) {
          if ('navigate' in client) {
            return client.navigate(targetUrl).then(() => client.focus()).catch(() => client.focus());
          }
          if ('focus' in client) return client.focus();
        }
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});
