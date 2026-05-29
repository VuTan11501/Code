// cloud-sync.js — cross-device sync of user settings via Gist.
//
// Schema v2 (per-key LWW):
// ─────────────────────────
// {
//   _version: 2,
//   _updated_at: <ISO>,          // max of all per_key timestamps (v1 compat)
//   _updated_by: <device>,       // device that last pushed any key
//   settings: {
//     locations:       { ... },
//     ot_profile:      { ... },
//     notif_prefs:     { ... },
//     schedule_filter: { ... },
//     theme:           "auto"
//   },
//   per_key: {
//     locations:       { updated_at: <ISO>, updated_by: <device> },
//     ot_profile:      { updated_at: <ISO>, updated_by: <device> },
//     notif_prefs:     { updated_at: <ISO>, updated_by: <device> },
//     schedule_filter: { updated_at: <ISO>, updated_by: <device> },
//     theme:           { updated_at: <ISO>, updated_by: <device> }
//   }
// }
//
// Pull: per-key merge — only apply remote keys whose per_key[k].updated_at
//       is newer than our local per-key timestamp.
// Push: only bump per_key[k].updated_at for keys whose value changed since
//       last pull (tracked via in-memory _lastPulledValues).
// Migration: v1 docs get all per_key timestamps set to the v1 _updated_at.
//
// Public API:
//   CloudSync.init({ getToken, toast })   — boot
//   CloudSync.register(key, label)        — declare a localStorage key to sync
//   CloudSync.pull({ force, silent })     — fetch + apply if remote newer
//   CloudSync.push()                       — immediate write (debounced via markDirty)
//   CloudSync.markDirty()                  — schedule a 3s-debounced push
//   CloudSync.lastSyncedAt()               — Date | null (last successful pull)
//   CloudSync.deviceId()                   — device fingerprint string
//   CloudSync.getProxyUrl() / setProxyUrl() — Cloudflare Worker proxy URL
//
// Safety: rolling backup `user-settings.json.bak` saved atomically in same PATCH.
// Re-entrancy: push() is mutex-locked; concurrent markDirty calls collapse into 1.

// ═══════════════════════════════════════════════════════════════════
// GitHub API Worker proxy — fetch() monkey-patch
// ───────────────────────────────────────────────────────────────────
// When the user configures a Cloudflare Worker URL in Settings, ALL outgoing
// `https://api.github.com/*` requests are transparently rewritten to go
// through the Worker. The Worker holds the PAT as a server-side secret and
// injects the Authorization header, so DevTools Network never shows the PAT.
//
// We monkey-patch fetch (instead of refactoring 30+ call sites) because:
//   - There are 30+ direct `fetch(`${API}...`)` callers across page modules.
//   - All such calls share the same rewrite rule (api.github.com → proxy).
//   - Touching every callsite is risky; monkey-patching is one localized change.
//
// Safety: rewrite ONLY fires when (a) URL starts with https://api.github.com/
// AND (b) proxy URL is set. Other fetch calls (Gist raw, fonts, etc.) are
// untouched. We also strip the Authorization header on rewritten requests so
// the PAT is never sent client-side (the Worker injects it).
// ═══════════════════════════════════════════════════════════════════
(function patchFetch() {
  if (window.__ghFetchPatched) return;
  window.__ghFetchPatched = true;
  const PROXY_KEY = 'wf_dash_gh_proxy_url';
  const GH_API = 'https://api.github.com';
  const origFetch = window.fetch.bind(window);

  function proxyUrl() {
    try { return (localStorage.getItem(PROXY_KEY) || '').trim().replace(/\/+$/, ''); }
    catch { return ''; }
  }

  window.fetch = function ghFetchProxy(input, init) {
    const proxy = proxyUrl();
    if (!proxy) return origFetch(input, init);

    // Extract URL string regardless of input type (string | URL | Request)
    let urlStr;
    if (typeof input === 'string') urlStr = input;
    else if (input instanceof URL) urlStr = input.toString();
    else if (input instanceof Request) urlStr = input.url;
    else return origFetch(input, init);

    if (!urlStr.startsWith(GH_API + '/')) return origFetch(input, init);

    const newUrl = proxy + urlStr.slice(GH_API.length);
    // Strip Authorization header — Worker injects the PAT server-side.
    const newInit = { ...(init || {}) };
    if (newInit.headers) {
      // Normalize to a plain object copy so we can delete cleanly
      const h = newInit.headers instanceof Headers
        ? Object.fromEntries(newInit.headers.entries())
        : Array.isArray(newInit.headers)
          ? Object.fromEntries(newInit.headers)
          : { ...newInit.headers };
      delete h['Authorization']; delete h['authorization'];
      newInit.headers = h;
    }
    // If input was a Request object, we lose its body unless we re-wrap.
    // For our codebase, callers pass strings; Request-object callers are rare.
    if (input instanceof Request) {
      // Re-derive method/body from the Request
      return origFetch(new Request(newUrl, input));
    }
    return origFetch(newUrl, newInit);
  };
})();

window.CloudSync = (function () {
  const GIST_ID = 'abc2a47c0a396025a72a6580227ff493';
  const FILE = 'user-settings.json';
  const BAK_FILE = 'user-settings.json.bak';
  const TS_KEY = 'wf_dash_settings_updated_at';           // v1 compat (global)
  const PERKEY_PREFIX = 'wf_dash_settings_perkey_';       // v2 per-key timestamps
  const DEV_KEY = 'wf_dash_device_id';
  const PREFIX = 'wf_dash_';                 // stripped when serializing keys
  const DEBOUNCE_MS = 3000;

  const REGISTERED = [];                     // [{ key, label, shortKey }]
  let _getToken = null;
  let _toast = (msg) => console.log('[CloudSync]', msg);
  let _etag = null;
  let _cachedRemote = null;
  let _lastPulled = null;
  let _lastPushedAt = null;
  let _pushTimer = null;
  let _pushing = false;
  let _pullPromise = null;
  // v2: track values from last pull to detect which keys changed locally
  const _lastPulledValues = new Map();       // shortKey → JSON string of value
  // Shared gist cache — any caller (CloudSync.pull, insights.js,
  // checkTokenScopes, etc.) can reuse the same fetched body instead of
  // hitting GitHub API in parallel for the same gist on page load.
  let _gistBody = null;        // last parsed JSON of /gists/{id}
  let _gistScopes = '';        // value of X-OAuth-Scopes from same response
  let _gistTokenExpiry = '';   // value of github-authentication-token-expiration
  let _gistFetchedAt = 0;      // Date.now() of last successful body fetch
  let _gistInflight = null;    // Promise dedupe — concurrent callers share this

  function _deviceId() {
    let id = localStorage.getItem(DEV_KEY);
    if (!id) {
      const ua = navigator.userAgent || 'Browser';
      const m = ua.match(/(Chrome|Firefox|Safari|Edge|Opera)\/[\d.]+/);
      const browser = m ? m[1] : 'Browser';
      const platform = /Mobile/.test(ua) ? 'Mobile' : (/Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Device');
      id = `${browser}-${platform}-${Math.random().toString(36).slice(2, 7)}`;
      localStorage.setItem(DEV_KEY, id);
    }
    return id;
  }

  function init(opts) {
    _getToken = opts.getToken || _getToken;
    if (typeof opts.toast === 'function') _toast = opts.toast;
  }

  function register(key, label, shortKey) {
    if (REGISTERED.find(r => r.key === key)) return;
    // Allow explicit shortKey (recommended); else fall back to stripping known prefixes.
    const sk = shortKey || key.replace(/^(wf_dash_|workflow_|ot_takehome_|ot_|sched_)/, '');
    REGISTERED.push({ key, label: label || sk, shortKey: sk });
  }

  // ─── GitHub API proxy support ─────────────────────────
  // If the user configured a Cloudflare Worker proxy URL in Settings, all
  // GitHub API requests are routed through it. The proxy injects the PAT
  // server-side so the browser never sends Authorization in DevTools.
  // Falls back to direct api.github.com when no proxy is configured.
  const PROXY_KEY = 'wf_dash_gh_proxy_url';
  function _proxyUrl() {
    try { return (localStorage.getItem(PROXY_KEY) || '').trim().replace(/\/+$/, ''); }
    catch { return ''; }
  }
  // Rewrite https://api.github.com/X → <proxy>/X. Worker also accepts /gh/X prefix.
  function _rewriteUrl(url) {
    const proxy = _proxyUrl();
    if (!proxy) return url;
    if (url.startsWith('https://api.github.com/')) {
      return proxy + url.slice('https://api.github.com'.length);
    }
    return url;
  }

  async function _ghFetch(url, options = {}) {
    const proxied = _rewriteUrl(url);
    const usingProxy = proxied !== url;
    const headers = {
      'Accept': 'application/vnd.github+json',
      ...(options.headers || {}),
    };
    // Only attach Authorization when going DIRECT — proxy injects it server-side.
    if (!usingProxy) {
      const token = typeof _getToken === 'function' ? _getToken() : _getToken;
      if (!token) throw new Error('no token');
      headers['Authorization'] = 'Bearer ' + token;
    }
    // Retry on transient errors (429, 5xx, network blip). Idempotent ops
    // (GET, HEAD) get up to 3 attempts; mutations (PATCH/POST/PUT/DELETE) only
    // retry on connection errors (NEVER on 5xx — server may have committed).
    const method = (options.method || 'GET').toUpperCase();
    const isIdempotent = method === 'GET' || method === 'HEAD';
    const maxAttempts = options.maxAttempts ?? (isIdempotent ? 3 : 1);
    let lastErr = null;
    let res = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        res = await fetch(proxied, { ...options, headers });
      } catch (e) {
        lastErr = e;
        if (attempt < maxAttempts - 1) {
          await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt) + Math.floor(Math.random() * 250)));
          continue;
        }
        throw e;
      }
      if (isIdempotent && (res.status === 429 || (res.status >= 500 && res.status < 600))) {
        if (attempt < maxAttempts - 1) {
          const ra = res.headers.get('Retry-After');
          const reset = res.headers.get('X-RateLimit-Reset');
          let delay = 500 * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
          if (ra && !isNaN(Number(ra))) delay = Math.min(8000, Number(ra) * 1000);
          else if (reset) delay = Math.min(8000, Math.max(0, parseInt(reset, 10) * 1000 - Date.now()));
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
      }
      break;
    }
    if (!res) throw lastErr || new Error('_ghFetch: no response');
    return res;
  }

  function _localTs() { return localStorage.getItem(TS_KEY) || ''; }
  function _setLocalTs(ts) { localStorage.setItem(TS_KEY, ts); }

  // v2 per-key timestamp helpers
  function _localPerKeyTs(shortKey) { return localStorage.getItem(PERKEY_PREFIX + shortKey) || ''; }
  function _setLocalPerKeyTs(shortKey, ts) { localStorage.setItem(PERKEY_PREFIX + shortKey, ts); }

  function _collectLocal() {
    const settings = {};
    REGISTERED.forEach(r => {
      const raw = localStorage.getItem(r.key);
      if (raw === null || raw === '') return;
      try { settings[r.shortKey] = JSON.parse(raw); }
      catch { settings[r.shortKey] = raw; }
    });
    return settings;
  }

  function _applyRemote(settings) {
    let applied = 0;
    REGISTERED.forEach(r => {
      if (!Object.prototype.hasOwnProperty.call(settings, r.shortKey)) return;
      const v = settings[r.shortKey];
      if (v === null || v === undefined) {
        localStorage.removeItem(r.key);
      } else {
        const out = (typeof v === 'string') ? v : JSON.stringify(v);
        localStorage.setItem(r.key, out);
      }
      applied++;
    });
    return applied;
  }

  // Internal GET /gists/{id} with ETag + in-flight dedupe.
  // Concurrent callers all await the same promise. On 304 the previously
  // cached body is reused. On 200 the body + scopes header are stored.
  // Returns { body, scopes, status, fromCache }.
  async function _loadGistRaw(opts = {}) {
    const maxAge = (typeof opts.maxAgeMs === 'number') ? opts.maxAgeMs : 0;
    if (!opts.force && _gistBody && maxAge > 0 && (Date.now() - _gistFetchedAt) < maxAge) {
      return { body: _gistBody, scopes: _gistScopes, status: 200, fromCache: true };
    }
    if (_gistInflight) return _gistInflight;
    if (!_getToken || !_getToken()) return { body: null, scopes: '', status: 0, error: 'no_token' };
    _gistInflight = (async () => {
      try {
        const headers = (_etag && !opts.force) ? { 'If-None-Match': _etag } : {};
        const resp = await _ghFetch(`https://api.github.com/gists/${GIST_ID}`, { headers });
        const scopes = resp.headers.get('X-OAuth-Scopes') || _gistScopes;
        _gistScopes = scopes;
        // Fine-grained PATs return their expiry as an ISO date string in this
        // custom header on every authenticated response. Classic ghp_ tokens
        // don't include it.
        const exp = resp.headers.get('github-authentication-token-expiration') || _gistTokenExpiry;
        _gistTokenExpiry = exp;
        if (resp.status === 304) {
          _gistFetchedAt = Date.now();
          return { body: _gistBody, scopes, expiry: _gistTokenExpiry, status: 304, fromCache: true };
        }
        if (!resp.ok) {
          return { body: null, scopes, expiry: _gistTokenExpiry, status: resp.status, error: 'http_' + resp.status };
        }
        _etag = resp.headers.get('ETag') || _etag;
        const data = await resp.json();
        _gistBody = data;
        _gistFetchedAt = Date.now();
        return { body: data, scopes, expiry: _gistTokenExpiry, status: 200, fromCache: false };
      } catch (e) {
        return { body: null, scopes: _gistScopes, expiry: _gistTokenExpiry, status: 0, error: String(e.message || e) };
      } finally {
        _gistInflight = null;
      }
    })();
    return _gistInflight;
  }

  async function pull(opts = {}) {
    if (_pullPromise) return _pullPromise;
    if (!_getToken || !_getToken()) return { skipped: 'no_token' };
    _pullPromise = (async () => {
      try {
        const res = await _loadGistRaw({ force: opts.force });
        if (res.status === 304) return { changed: false, cached: true };
        if (res.error || !res.body) throw new Error('GET gist ' + (res.error || 'no_body'));
        const data = res.body;
        const file = data.files && data.files[FILE];
        const fileContent = window.readGistFile ? await window.readGistFile(file) : (file && file.content) || '';
        if (!fileContent) return { changed: false, empty: true };
        let remote;
        try { remote = JSON.parse(fileContent); }
        catch (e) { return { error: 'parse_error' }; }
        _cachedRemote = remote;

        const remoteVersion = remote._version || 1;
        const remoteAt = remote._updated_at || '';
        const fromDevice = remote._updated_by || 'another device';

        // Build per_key metadata (migrate v1 → v2 if needed)
        let perKey = remote.per_key || {};
        if (remoteVersion < 2 || !remote.per_key) {
          // v1 doc: stamp all keys with the single _updated_at
          const fallbackTs = remoteAt || new Date().toISOString();
          REGISTERED.forEach(r => {
            if (!perKey[r.shortKey]) {
              perKey[r.shortKey] = { updated_at: fallbackTs, updated_by: fromDevice };
            }
          });
          console.info('CloudSync: migrated v1 doc → v2 per_key timestamps');
        }

        // Per-key merge
        let applied = 0;
        const settings = remote.settings || {};
        REGISTERED.forEach(r => {
          if (!Object.prototype.hasOwnProperty.call(settings, r.shortKey)) return;
          const remoteKeyMeta = perKey[r.shortKey] || {};
          const remoteKeyTs = remoteKeyMeta.updated_at || remoteAt || '';
          const localKeyTs = _localPerKeyTs(r.shortKey);

          // First-time on this device (no local per-key ts) → adopt remote
          const firstTime = !localKeyTs;
          if (!opts.force && !firstTime && remoteKeyTs && remoteKeyTs <= localKeyTs) {
            // Local is newer or equal — keep local
            if (remoteKeyTs < localKeyTs) {
              console.info(`CloudSync: kept local ${r.shortKey} (local newer)`);
            }
            return;
          }

          // Apply remote value
          const v = settings[r.shortKey];
          if (v === null || v === undefined) {
            localStorage.removeItem(r.key);
          } else {
            const out = (typeof v === 'string') ? v : JSON.stringify(v);
            localStorage.setItem(r.key, out);
          }
          // Update per-key timestamp + snapshot for push diff
          if (remoteKeyTs) _setLocalPerKeyTs(r.shortKey, remoteKeyTs);
          const valStr = (v === null || v === undefined) ? '' : (typeof v === 'string' ? v : JSON.stringify(v));
          _lastPulledValues.set(r.shortKey, valStr);
          applied++;
        });

        // Also populate _lastPulledValues for keys we didn't apply (local newer)
        // so push() can diff against them
        REGISTERED.forEach(r => {
          if (!_lastPulledValues.has(r.shortKey)) {
            const raw = localStorage.getItem(r.key);
            _lastPulledValues.set(r.shortKey, raw || '');
          }
        });

        // Update global timestamp (v1 compat) to max of per_key
        if (remoteAt) _setLocalTs(remoteAt);
        _lastPulled = new Date();

        const sameDevice = fromDevice === _deviceId();
        if (applied > 0 && !opts.silent && !sameDevice) {
          _toast(`⬇ Synced ${applied} setting${applied === 1 ? '' : 's'} from ${fromDevice}`);
          window.dispatchEvent(new CustomEvent('cloudsync:applied', { detail: { applied, from: fromDevice } }));
        }
        return { changed: applied > 0, applied, from: fromDevice, at: remoteAt };
      } catch (e) {
        console.warn('[CloudSync] pull failed:', e);
        return { error: String(e.message || e) };
      } finally {
        _pullPromise = null;
      }
    })();
    return _pullPromise;
  }

  function markDirty() {
    if (_pushTimer) clearTimeout(_pushTimer);
    _pushTimer = setTimeout(() => { push(); }, DEBOUNCE_MS);
  }

  async function push() {
    if (_pushing) return { skipped: 'in_progress' };
    if (!_getToken || !_getToken()) return { skipped: 'no_token' };
    _pushing = true;
    try {
      // Re-read existing to build rolling backup + preserve per_key from remote
      let backupContent = null;
      let existingPerKey = {};
      try {
        const cur = await _ghFetch(`https://api.github.com/gists/${GIST_ID}`);
        if (cur.ok) {
          const data = await cur.json();
          const f = data.files && data.files[FILE];
          const bc = window.readGistFile ? await window.readGistFile(f) : (f && f.content) || '';
          if (bc) {
            backupContent = bc;
            try {
              const parsed = JSON.parse(bc);
              existingPerKey = parsed.per_key || {};
            } catch {}
          }
        }
      } catch {}
      const settings = _collectLocal();
      if (!Object.keys(settings).length) return { skipped: 'empty' };

      const now = new Date().toISOString();
      const device = _deviceId();

      // Build per_key: only bump timestamp for keys that changed since last pull
      const perKey = {};
      REGISTERED.forEach(r => {
        const currentVal = localStorage.getItem(r.key) || '';
        const lastPulledVal = _lastPulledValues.get(r.shortKey);
        const hasChanged = lastPulledVal === undefined || currentVal !== lastPulledVal;

        if (hasChanged) {
          perKey[r.shortKey] = { updated_at: now, updated_by: device };
          // Update snapshot so next push won't re-stamp
          _lastPulledValues.set(r.shortKey, currentVal);
          // Update local per-key timestamp
          _setLocalPerKeyTs(r.shortKey, now);
        } else {
          // Keep existing remote metadata for this key
          perKey[r.shortKey] = existingPerKey[r.shortKey] || { updated_at: now, updated_by: device };
        }
      });

      // _updated_at = max of all per_key timestamps (v1 backward compat)
      let maxTs = now;
      Object.values(perKey).forEach(meta => {
        if (meta.updated_at && meta.updated_at > maxTs) maxTs = meta.updated_at;
      });

      const body = {
        _version: 2,
        _updated_at: maxTs,
        _updated_by: device,
        settings,
        per_key: perKey,
      };
      const files = {
        [FILE]: { content: JSON.stringify(body, null, 2) },
      };
      if (backupContent) {
        const bak = { _backup_at: now, _backup_by: device, content: JSON.parse(backupContent) };
        files[BAK_FILE] = { content: JSON.stringify(bak, null, 2) };
      }
      const resp = await _ghFetch(`https://api.github.com/gists/${GIST_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files }),
      });
      if (!resp.ok) throw new Error('PATCH HTTP ' + resp.status);
      _setLocalTs(maxTs);
      _lastPushedAt = new Date();
      _etag = null; // force re-fetch next pull
      window.dispatchEvent(new CustomEvent('cloudsync:pushed', { detail: { at: maxTs } }));
      return { ok: true, at: maxTs };
    } catch (e) {
      console.warn('[CloudSync] push failed:', e);
      return { error: String(e.message || e) };
    } finally {
      _pushing = false;
    }
  }

  // Public shared-cache API — used by insights.js, checkTokenScopes(),
  // and any future caller that needs the raw gist body to avoid duplicate
  // /gists/{id} requests on page load.
  async function fetchGist(opts = {}) { return _loadGistRaw(opts); }
  function getCachedGist() {
    return { body: _gistBody, scopes: _gistScopes, expiry: _gistTokenExpiry, fetchedAt: _gistFetchedAt };
  }
  function getTokenExpiry() { return _gistTokenExpiry; }
  function invalidateGist() {
    _gistBody = null; _gistFetchedAt = 0; _etag = null;
  }

  return {
    init, register, pull, push, markDirty,
    fetchGist, getCachedGist, getTokenExpiry, invalidateGist,
    // Proxy helpers — also used by app.js apiFetch and Settings UI
    getProxyUrl: _proxyUrl,
    setProxyUrl: (url) => {
      try {
        const clean = (url || '').trim().replace(/\/+$/, '');
        if (clean) localStorage.setItem(PROXY_KEY, clean);
        else localStorage.removeItem(PROXY_KEY);
        // Invalidate ETag cache — proxy scope changed, cached 304s no longer valid.
        if (typeof window.__clearEtagCache === 'function') window.__clearEtagCache();
      } catch {}
    },
    rewriteUrl: _rewriteUrl,
    lastSyncedAt: () => _lastPulled,
    lastPushedAt: () => _lastPushedAt,
    deviceId: _deviceId,
    listRegistered: () => REGISTERED.slice(),
    // Convenience: re-render UI bits that depend on synced settings.
    // Call after a successful pull on the active page.
    applyToUI: function () {
      // Theme: use smooth transition if this is the first CloudSync pull (tentative state).
      // After first pull settles, subsequent changes apply instantly.
      if (window.Theme) {
        try {
          const mode = window.Theme.getMode();
          if (!window.Theme.isSettled()) {
            window.Theme.applyWithTransition(mode);
            window.Theme.markSettled();
          } else {
            window.Theme.apply(mode);
          }
        } catch {}
      }
      const calls = [
        'renderLocationList',        // locations.js
        'renderNotifSettings',       // app.js
        'renderOtBudget',            // ot-planner.js (uses ot_profile)
        'renderOtStats',             // ot-planner.js
        'renderOtCalendar',          // ot-planner.js (also calls budget+stats)
        'renderOtList',              // ot-planner.js
        'renderScheduleTable',       // schedule.js (pip filter applies here)
        'renderScheduleCalendar',    // schedule.js
        'renderThemeStatus',         // settings.js
        'renderInfraToggle',         // dashboard.js (visible cards / order)
        'renderCardPicker',          // dashboard.js (customize modal body)
        'applyDashboardSettingsFromCloud', // dashboard.js — re-render grid if visible
      ];
      for (const name of calls) {
        const fn = window[name];
        if (typeof fn === 'function') { try { fn(); } catch (e) { console.warn('[CloudSync] re-render', name, e); } }
      }
    },
  };
})();
