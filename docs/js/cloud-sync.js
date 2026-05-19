// cloud-sync.js — cross-device sync of user settings via Gist.
//
// Stores 4 localStorage keys (locations, ot_profile, notif_prefs, schedule_filter)
// in `user-settings.json` of the same Gist used for schedule + OT. Conflict
// resolution = last-write-wins on `_updated_at` timestamp. PAT vault is NEVER
// synced — passphrase is device-specific and that's the security boundary.
//
// Public API:
//   CloudSync.init({ getToken, toast })   — boot
//   CloudSync.register(key, label)        — declare a localStorage key to sync
//   CloudSync.pull({ force, silent })     — fetch + apply if remote newer
//   CloudSync.push()                       — immediate write (debounced via markDirty)
//   CloudSync.markDirty()                  — schedule a 3s-debounced push
//   CloudSync.lastSyncedAt()               — Date | null (last successful pull)
//   CloudSync.deviceId()                   — device fingerprint string
//
// Safety: rolling backup `user-settings.json.bak` saved atomically in same PATCH.
// Re-entrancy: push() is mutex-locked; concurrent markDirty calls collapse into 1.

window.CloudSync = (function () {
  const GIST_ID = 'abc2a47c0a396025a72a6580227ff493';
  const FILE = 'user-settings.json';
  const BAK_FILE = 'user-settings.json.bak';
  const TS_KEY = 'wf_dash_settings_updated_at';
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

  async function _ghFetch(url, options = {}) {
    const token = typeof _getToken === 'function' ? _getToken() : _getToken;
    if (!token) throw new Error('no token');
    const headers = {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/vnd.github+json',
      ...(options.headers || {}),
    };
    return fetch(url, { ...options, headers });
  }

  function _localTs() { return localStorage.getItem(TS_KEY) || ''; }
  function _setLocalTs(ts) { localStorage.setItem(TS_KEY, ts); }

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

  async function pull(opts = {}) {
    if (_pullPromise) return _pullPromise;
    if (!_getToken || !_getToken()) return { skipped: 'no_token' };
    _pullPromise = (async () => {
      try {
        const headers = (_etag && !opts.force) ? { 'If-None-Match': _etag } : {};
        const resp = await _ghFetch(`https://api.github.com/gists/${GIST_ID}`, { headers });
        if (resp.status === 304) return { changed: false, cached: true };
        if (!resp.ok) throw new Error('GET gist HTTP ' + resp.status);
        _etag = resp.headers.get('ETag');
        const data = await resp.json();
        const file = data.files && data.files[FILE];
        if (!file || !file.content) return { changed: false, empty: true };
        let remote;
        try { remote = JSON.parse(file.content); }
        catch (e) { return { error: 'parse_error' }; }
        _cachedRemote = remote;
        const remoteAt = remote._updated_at || '';
        const localAt = _localTs();
        // First-time on this device with no local timestamp → adopt remote regardless.
        // Otherwise only adopt if remote is strictly newer.
        const firstTime = !localAt;
        if (!opts.force && !firstTime && remoteAt && remoteAt <= localAt) {
          return { changed: false, reason: 'local_newer_or_equal', remoteAt, localAt };
        }
        const applied = _applyRemote(remote.settings || {});
        if (remoteAt) _setLocalTs(remoteAt);
        _lastPulled = new Date();
        const fromDevice = remote._updated_by || 'another device';
        const sameDevice = fromDevice === _deviceId();
        if (applied > 0 && !opts.silent && !sameDevice) {
          _toast(`⬇ Synced ${applied} setting${applied === 1 ? '' : 's'} from ${fromDevice}`);
          // Notify listeners so UIs can re-render
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
      // Re-read existing to build rolling backup atomically
      let backupContent = null;
      try {
        const cur = await _ghFetch(`https://api.github.com/gists/${GIST_ID}`);
        if (cur.ok) {
          const data = await cur.json();
          const f = data.files && data.files[FILE];
          if (f && f.content) backupContent = f.content;
        }
      } catch {}
      const settings = _collectLocal();
      // If nothing to write (no registered keys ever populated), skip
      if (!Object.keys(settings).length) return { skipped: 'empty' };
      const now = new Date().toISOString();
      const body = {
        _version: 1,
        _updated_at: now,
        _updated_by: _deviceId(),
        settings,
      };
      const files = {
        [FILE]: { content: JSON.stringify(body, null, 2) },
      };
      if (backupContent) {
        const bak = { _backup_at: now, _backup_by: _deviceId(), content: JSON.parse(backupContent) };
        files[BAK_FILE] = { content: JSON.stringify(bak, null, 2) };
      }
      const resp = await _ghFetch(`https://api.github.com/gists/${GIST_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files }),
      });
      if (!resp.ok) throw new Error('PATCH HTTP ' + resp.status);
      _setLocalTs(now);
      _lastPushedAt = new Date();
      _etag = null; // force re-fetch next pull
      window.dispatchEvent(new CustomEvent('cloudsync:pushed', { detail: { at: now } }));
      return { ok: true, at: now };
    } catch (e) {
      console.warn('[CloudSync] push failed:', e);
      return { error: String(e.message || e) };
    } finally {
      _pushing = false;
    }
  }

  return {
    init, register, pull, push, markDirty,
    lastSyncedAt: () => _lastPulled,
    lastPushedAt: () => _lastPushedAt,
    deviceId: _deviceId,
    listRegistered: () => REGISTERED.slice(),
  };
})();
