// ═══════════════════════════════════════════════════
//  CONFIGURATION
// ═══════════════════════════════════════════════════
const OWNER = 'VuTan11501';
const REPO = 'Code';
const API = 'https://api.github.com';
const GIST_ID = 'abc2a47c0a396025a72a6580227ff493';
const WORKFLOWS = [
  { id: 277782817, name: 'Auto Checkin', icon: '📥', iconName: 'logIn', file: 'auto-checkin.yml' },
  { id: 278639767, name: 'Auto Checkout', icon: '📤', iconName: 'logOut', file: 'auto-checkout.yml' },
  { id: 277802136, name: 'Auto Request OT', icon: '⏰', iconName: 'hourglass', file: 'auto-ot-creator.yml' },
  { id: 278223037, name: 'JPY Forecast', icon: '💹', iconName: 'barChart', file: 'jpy-forecast.yml' },
  { id: 279267238, name: 'OT History Fetch', icon: '📊', iconName: 'refresh', file: 'ot-history-fetch.yml' },
];
const AUTO_LOCK_MS = 15 * 60 * 1000;

const SCHEDULE = {
  'Auto Checkin': [
    { days: [1,2,3,4,5], time: '09:00', label: 'Workday CI' },
    { days: [0,1,2,3,4,5,6], time: '22:00', label: 'Night OT CI' },
    { days: [0], time: '14:30', label: 'Sunday OT CI' },
  ],
  'Auto Checkout': [
    { days: [1,2,3,4,5], time: '18:00', label: 'Workday CO' },
    { days: [0,1,2,3,4,5,6], time: '00:00', label: 'Midnight CO' },
    { days: [0,1,2,3,4,5,6], time: '03:30', label: 'Night OT CO' },
  ],
  'JPY Forecast': [
    { days: [1,2,3,4,5], time: '07:30', label: 'Daily Report' },
  ],
  'Auto Request OT': [
    { days: [0,1,2,3,4,5,6], time: '10:00', label: 'Auto OT' },
  ],
};

// ═══════════════════════════════════════════════════
//  CRYPTO: AES-256-GCM with PBKDF2 key derivation
// ═══════════════════════════════════════════════════
const STORAGE_KEY = 'wf_dash_vault';
const SESSION_KEY = 'wf_dash_session';
let sessionToken = null;

// Restore session from sessionStorage (survives reload, cleared on tab close)
function restoreSession() {
  const saved = sessionStorage.getItem(SESSION_KEY);
  if (saved) {
    sessionToken = saved;
    return true;
  }
  return false;
}

function saveSession(token) {
  sessionToken = token;
  sessionStorage.setItem(SESSION_KEY, token);
}

function clearSession() {
  sessionToken = null;
  sessionStorage.removeItem(SESSION_KEY);
  if (typeof cachedGithubUser !== 'undefined') cachedGithubUser = null;
}

async function deriveKey(passphrase, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptToken(token, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const enc = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(token));
  const combined = new Uint8Array(salt.length + iv.length + new Uint8Array(ciphertext).length);
  combined.set(salt, 0);
  combined.set(iv, salt.length);
  combined.set(new Uint8Array(ciphertext), salt.length + iv.length);
  return btoa(String.fromCharCode(...combined));
}

async function decryptToken(stored, passphrase) {
  const combined = Uint8Array.from(atob(stored), c => c.charCodeAt(0));
  const salt = combined.slice(0, 16);
  const iv = combined.slice(16, 28);
  const ciphertext = combined.slice(28);
  const key = await deriveKey(passphrase, salt);
  const dec = new TextDecoder();
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return dec.decode(plaintext);
}

// ═══════════════════════════════════════════════════
//  AUTH FLOW
// ═══════════════════════════════════════════════════
function hasVault() { return !!localStorage.getItem(STORAGE_KEY); }

function switchTab(tab) {
  const tabs = document.querySelectorAll('#authTabs .tabs-trigger');
  tabs.forEach(t => t.classList.remove('active'));
  if (tab === 'setup') {
    document.getElementById('setupForm').style.display = 'block';
    document.getElementById('unlockForm').style.display = 'none';
    if (tabs[1]) tabs[1].classList.add('active');
  } else {
    document.getElementById('setupForm').style.display = 'none';
    document.getElementById('unlockForm').style.display = 'block';
    if (tabs[0]) tabs[0].classList.add('active');
  }
}

async function setup() {
  const token = document.getElementById('newToken').value.trim();
  const pass = document.getElementById('newPass').value;
  const confirm = document.getElementById('confirmPass').value;
  const errEl = document.getElementById('setupError');

  if (!token) { errEl.textContent = 'PAT is required'; errEl.style.display = 'block'; return; }
  if (pass.length < 6) { errEl.textContent = 'Passphrase must be 6+ characters'; errEl.style.display = 'block'; return; }
  if (pass !== confirm) { errEl.textContent = 'Passphrases do not match'; errEl.style.display = 'block'; return; }

  try {
    const encrypted = await encryptToken(token, pass);
    localStorage.setItem(STORAGE_KEY, encrypted);
    saveSession(token);
    showDashboard();
    toast('✅ Setup complete! Dashboard unlocked.');
  } catch (e) {
    errEl.textContent = 'Encryption failed: ' + e.message;
    errEl.style.display = 'block';
  }
}

async function unlock() {
  const pass = document.getElementById('passphrase').value;
  const errEl = document.getElementById('unlockError');
  const stored = localStorage.getItem(STORAGE_KEY);

  if (!stored) { switchTab('setup'); return; }

  try {
    const token = await decryptToken(stored, pass);
    saveSession(token);
    showDashboard();
  } catch {
    errEl.style.display = 'block';
    document.getElementById('passphrase').value = '';
    document.getElementById('passphrase').focus();
  }
}

function lock() {
  clearSession();
  stopAutoLock();
  stopPolling();
  updateLiveIndicator('paused', 0);
  document.getElementById('dashboard').style.display = 'none';
  document.getElementById('authScreen').style.display = 'flex';
  document.getElementById('passphrase').value = '';
  document.getElementById('passphrase').focus();
}

function showDashboard() {
  document.getElementById('authScreen').style.display = 'none';
  document.getElementById('dashboard').style.display = 'block';
  // Always start on dashboard when first entering (ignore stale hash from PWA reopen)
  const validPages = ['dashboard', 'schedule', 'settings'];
  const hashPage = location.hash.replace('#', '');
  const target = validPages.includes(hashPage) ? location.hash : '#dashboard';
  // On fresh login/restore, always go to dashboard
  if (!window._hasNavigated) {
    window._hasNavigated = true;
    navigate('#dashboard');
  } else {
    navigate(target);
  }
  startAutoLock();
  startPolling();
  refresh();
  // Check token scopes (non-blocking)
  checkTokenScopes();
  // Cross-device settings sync — pull on unlock (non-blocking)
  if (window.CloudSync) {
    window.CloudSync.init({ getToken: () => sessionToken, toast: (m) => toast(m) });
    window.CloudSync.register('workflow_locations_v1',  'Locations',                 'locations');
    window.CloudSync.register('ot_takehome_profile_v1', 'OT Profile',                'ot_profile');
    window.CloudSync.register('wf_dash_notif_prefs',    'Notification preferences',  'notif_prefs');
    window.CloudSync.register('sched_pip_filter_v1',    'Schedule filter',           'schedule_filter');
    window.CloudSync.pull().then(r => {
      if (r && r.applied) window.CloudSync.applyToUI();
    });
  }
}

async function checkTokenScopes() {
  if (!sessionToken) return;
  try {
    const res = await fetch(`${API}/gists/${GIST_ID}`, {
      method: 'HEAD',
      headers: { 'Authorization': `Bearer ${sessionToken}`, 'Accept': 'application/vnd.github+json' },
    });
    const scopes = res.headers.get('X-OAuth-Scopes') || '';
    if (!scopes.includes('gist')) {
      toast('⚠️ PAT thiếu scope "gist" — Schedule sẽ không tạo được. Cập nhật token tại Settings.', 'warning');
    }
  } catch {}
}

// ═══════════════════════════════════════════════════
//  ROUTER
// ═══════════════════════════════════════════════════
function navigate(hash) {
  const page = hash.replace('#', '') || 'dashboard';
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => {
    n.classList.remove('active');
    n.setAttribute('aria-selected', 'false');
  });
  const target = document.getElementById('page-' + page);
  const nav = document.querySelector(`[data-page="${page}"]`);
  if (target) target.classList.add('active');
  if (nav) {
    nav.classList.add('active');
    nav.setAttribute('aria-selected', 'true');
  }

  // Initialize page-specific content
  if (page === 'schedule' && typeof initSchedulePage === 'function') initSchedulePage();
  if (page === 'ot' && typeof initOtPlannerPage === 'function') initOtPlannerPage();
  if (page === 'settings' && typeof initSettingsPage === 'function') initSettingsPage();
  if (page === 'dashboard' && typeof refresh === 'function' && sessionToken) {
    // Ensure dashboard always has fresh data when entering the tab.
    // Guards against any scenario where polling didn't start or stalled.
    refresh();
    if (typeof startPolling === 'function' && !pollTimer) startPolling();
  }
}

window.addEventListener('hashchange', () => {
  if (sessionToken) navigate(location.hash);
});

// ═══════════════════════════════════════════════════
//  TOAST
// ═══════════════════════════════════════════════════
let toastTimer = null;
function toast(msg, cls) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (cls ? ' ' + cls : '');
  clearTimeout(toastTimer);
  // Errors persist longer
  const duration = cls === 'error' ? 8000 : cls === 'warning' ? 6000 : 4000;
  toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

// ═══════════════════════════════════════════════════
//  UI CONFIRM (shadcn-style dialog — replaces window.confirm)
// ═══════════════════════════════════════════════════
let _uiConfirmResolve = null;
let _uiConfirmKeyHandler = null;

function uiConfirm(opts = {}) {
  const {
    title = 'Confirm',
    message = 'Are you sure?',
    confirmText = 'Confirm',
    cancelText = 'Cancel',
    danger = false,
  } = (typeof opts === 'string' ? { message: opts } : opts);

  return new Promise(resolve => {
    const dlg = document.getElementById('uiConfirmDialog');
    if (!dlg) { resolve(window.confirm(message)); return; }
    document.getElementById('uiConfirmTitle').textContent = title;
    document.getElementById('uiConfirmMessage').textContent = message;
    const okBtn = document.getElementById('uiConfirmOkBtn');
    const cancelBtn = document.getElementById('uiConfirmCancelBtn');
    okBtn.textContent = confirmText;
    cancelBtn.textContent = cancelText;
    okBtn.className = 'btn sm ' + (danger ? 'danger' : 'primary');
    _uiConfirmResolve = resolve;
    dlg.classList.add('open');
    // Focus the safe button (cancel) by default
    setTimeout(() => cancelBtn.focus(), 50);
    // ESC to cancel, Enter to confirm
    _uiConfirmKeyHandler = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); _uiConfirmClose(false); }
      else if (e.key === 'Enter') { e.preventDefault(); _uiConfirmClose(true); }
    };
    document.addEventListener('keydown', _uiConfirmKeyHandler);
  });
}

function _uiConfirmClose(value) {
  const dlg = document.getElementById('uiConfirmDialog');
  if (dlg) dlg.classList.remove('open');
  if (_uiConfirmKeyHandler) {
    document.removeEventListener('keydown', _uiConfirmKeyHandler);
    _uiConfirmKeyHandler = null;
  }
  const r = _uiConfirmResolve;
  _uiConfirmResolve = null;
  if (r) r(!!value);
}

// Wire up buttons + overlay click on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  const dlg = document.getElementById('uiConfirmDialog');
  if (!dlg) return;
  document.getElementById('uiConfirmOkBtn').addEventListener('click', () => _uiConfirmClose(true));
  document.getElementById('uiConfirmCancelBtn').addEventListener('click', () => _uiConfirmClose(false));
  dlg.addEventListener('click', (e) => { if (e.target === dlg) _uiConfirmClose(false); });
});

// Replacement for the inline "delete vault" handler (was using window.confirm in HTML)
async function deleteVault() {
  const ok = await uiConfirm({
    title: 'Delete vault?',
    message: 'This will permanently delete the vault and all stored data. This cannot be undone.',
    confirmText: 'Delete vault',
    danger: true,
  });
  if (!ok) return;
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem('wf_dash_vault_meta');
  lock();
  toast('Vault deleted', 'warning');
}

// ═══════════════════════════════════════════════════
//  API & UTILITIES
// ═══════════════════════════════════════════════════
// ETag cache for conditional requests (304 = no change, very fast)
const etagCache = new Map(); // path → { etag, data }

async function apiFetch(path, opts = {}) {
  const headers = { 'Accept': 'application/vnd.github+json' };
  if (sessionToken) headers['Authorization'] = `Bearer ${sessionToken}`;

  // Use ETag for conditional request if available
  const cached = etagCache.get(path);
  if (cached?.etag && !opts.noCache) {
    headers['If-None-Match'] = cached.etag;
  }

  const res = await fetch(`${API}${path}`, { headers });

  // 304 Not Modified — return cached data (no bandwidth used)
  if (res.status === 304 && cached?.data) {
    return cached.data;
  }

  if (res.status === 403) {
    const remaining = res.headers.get('X-RateLimit-Remaining');
    const reset = res.headers.get('X-RateLimit-Reset');
    if (remaining === '0') {
      const resetTime = reset ? new Date(parseInt(reset) * 1000).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo' }) : '?';
      throw new Error(`Rate limit exceeded. Resets at ${resetTime} JST.`);
    }
    throw new Error('API 403 Forbidden');
  }
  if (!res.ok) throw new Error(`API ${res.status}`);

  const data = await res.json();

  // Cache ETag for next request
  const etag = res.headers.get('ETag');
  if (etag) {
    etagCache.set(path, { etag, data });
  }

  return data;
}

function timeAgo(dateStr) {
  const diff = (Date.now() - new Date(dateStr).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function conclusionClass(c) {
  if (c === 'success') return 'success';
  if (c === 'failure') return 'failure';
  if (c === 'cancelled' || c === 'skipped') return 'skipped';
  return 'in_progress';
}

function jstNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
}

function formatDate(y, m, d) {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// ═══════════════════════════════════════════════════
//  AUTO-LOCK TIMEOUT (15 minutes)
// ═══════════════════════════════════════════════════
let autoLockTimer = null;
let lastActivity = Date.now();

function resetActivity() {
  lastActivity = Date.now();
  const el = document.getElementById('toast');
  if (el && el.textContent.startsWith('🔒 Auto-lock')) el.classList.remove('show');
}

function startAutoLock() {
  const events = ['click', 'keypress', 'mousemove', 'touchstart', 'scroll'];
  events.forEach(e => document.addEventListener(e, resetActivity, { passive: true }));
  lastActivity = Date.now();
  autoLockTimer = setInterval(checkAutoLock, 1000);
}

function stopAutoLock() {
  clearInterval(autoLockTimer);
  autoLockTimer = null;
  const events = ['click', 'keypress', 'mousemove', 'touchstart', 'scroll'];
  events.forEach(e => document.removeEventListener(e, resetActivity));
}

function checkAutoLock() {
  if (!sessionToken) return;
  const elapsed = Date.now() - lastActivity;
  const remaining = AUTO_LOCK_MS - elapsed;

  if (remaining <= 0) {
    lock();
    toast('🔒 Locked due to inactivity', 'warning');
    return;
  }

  if (remaining <= 60000) {
    const secs = Math.ceil(remaining / 1000);
    const el = document.getElementById('toast');
    el.textContent = `🔒 Auto-lock in ${secs}s — tap to stay`;
    el.className = 'toast show warning';
  }
}

// ═══════════════════════════════════════════════════
//  PUSH NOTIFICATIONS
// ═══════════════════════════════════════════════════
// Design goals:
//  - No spam when opening PWA: first load = silent seed, not notify
//  - No duplicate noti across reloads: localStorage persistence
//  - No old noti: only notify completions within FRESH_WINDOW_MIN
//  - Auto-dedupe per workflow: tag = workflow id so newer replaces older
//  - Clickable: tapping noti opens the run URL
//  - Self-cleaning: drop stale IDs after 7 days

const NOTIF_STORE_KEY = 'wf_seen_runs_v2';
const FRESH_WINDOW_MIN = 10;            // only notify completions ≤ 10 min old
const SEEN_TTL_DAYS = 7;                // forget run IDs after a week
const MAX_NOTIFY_PER_REFRESH = 3;       // safety: never blast > 3 noti at once
let isFirstRefresh = true;              // suppress noti on initial seed

let notifPermission = (typeof Notification !== 'undefined') ? Notification.permission : 'default';

// ─── Notification preferences (persisted) ───
const NOTIF_PREFS_KEY = 'wf_dash_notif_prefs';
const DEFAULT_NOTIF_PREFS = {
  enabled: true,           // master mute switch (browsers don't expose a programmatic revoke)
  onFailure: true,         // 🔴 alert when a run fails
  onSuccess: false,        // 🟢 alert when a run completes successfully
  onStart: false,          // 🟡 alert when a run starts/is queued
  requireInteraction: true,  // failure stays on screen until dismissed
  sound: true,             // 🔊 play a sound with the notification
};

// ─── Notification sound (WebAudio synth, no external files) ───
let _notifAudioCtx = null;
function _getAudioCtx() {
  if (_notifAudioCtx) return _notifAudioCtx;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    _notifAudioCtx = new Ctx();
  } catch { return null; }
  return _notifAudioCtx;
}
// kind: 'failure' | 'success' | 'start' | 'test'
function playNotifSound(kind = 'test') {
  const prefs = getNotifPrefs();
  if (!prefs.sound) return;
  const ctx = _getAudioCtx();
  if (!ctx) return;
  if (ctx.state === 'suspended') { try { ctx.resume(); } catch {} }
  // Sequence of {freq, start, dur, gain} notes
  let seq;
  if (kind === 'failure')      seq = [{f: 520, t: 0,    d: 0.18, g: 0.18}, {f: 330, t: 0.20, d: 0.30, g: 0.18}];
  else if (kind === 'success') seq = [{f: 660, t: 0,    d: 0.12, g: 0.16}, {f: 880, t: 0.13, d: 0.12, g: 0.16}, {f: 1175, t: 0.26, d: 0.20, g: 0.16}];
  else if (kind === 'start')   seq = [{f: 780, t: 0,    d: 0.10, g: 0.14}];
  else                         seq = [{f: 880, t: 0,    d: 0.12, g: 0.16}, {f: 1175, t: 0.13, d: 0.18, g: 0.16}];
  const now = ctx.currentTime;
  for (const n of seq) {
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(n.f, now + n.t);
      // simple ADSR-ish envelope
      gain.gain.setValueAtTime(0.0001, now + n.t);
      gain.gain.exponentialRampToValueAtTime(n.g, now + n.t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + n.t + n.d);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + n.t);
      osc.stop(now + n.t + n.d + 0.02);
    } catch {}
  }
}
function getNotifPrefs() {
  try {
    const raw = localStorage.getItem(NOTIF_PREFS_KEY);
    return { ...DEFAULT_NOTIF_PREFS, ...(raw ? JSON.parse(raw) : {}) };
  } catch { return { ...DEFAULT_NOTIF_PREFS }; }
}
function saveNotifPrefs(prefs) {
  try { localStorage.setItem(NOTIF_PREFS_KEY, JSON.stringify(prefs)); } catch {}
  if (window.CloudSync) window.CloudSync.markDirty();
}
function toggleNotifPref(key) {
  const p = getNotifPrefs();
  p[key] = !p[key];
  saveNotifPrefs(p);
  if (key === 'enabled') updateNotifBtn(); else renderNotifSettings();
  toast(`${p[key] ? 'Enabled' : 'Disabled'} ${key.replace(/^on/, '').toLowerCase()} notifications`);
}

function updateNotifBtn() {
  const btn = document.getElementById('notifBtn');
  if (!btn) return;
  const prefs = getNotifPrefs();
  const masterOn = prefs.enabled !== false;
  btn.innerHTML = ICON('bell', 18);
  const fullyOn = (notifPermission === 'granted') && masterOn;
  btn.setAttribute('aria-pressed', fullyOn ? 'true' : 'false');
  btn.setAttribute('data-state', fullyOn ? 'on' : 'off');
  if (notifPermission === 'granted' && masterOn)       { btn.setAttribute('data-tooltip', 'Notifications: ON (click to mute)');  btn.style.opacity = '1';   }
  else if (notifPermission === 'granted' && !masterOn) { btn.setAttribute('data-tooltip', 'Notifications: Muted (click to unmute)'); btn.style.opacity = '0.5'; }
  else if (notifPermission === 'denied')               { btn.setAttribute('data-tooltip', 'Notifications: Blocked by browser'); btn.style.opacity = '0.4'; }
  else                                                  { btn.setAttribute('data-tooltip', 'Enable notifications');               btn.style.opacity = '0.7'; }
  renderNotifSettings();
}

function onNotifBtnClick() {
  if (!('Notification' in window)) { toast('⚠️ Notifications not supported on this device'); return; }
  if (notifPermission === 'denied') {
    toast('🔕 Blocked by browser. Open site settings (lock icon) to allow.', 'warning');
    return;
  }
  if (notifPermission !== 'granted') {
    requestNotifPermission();
    return;
  }
  // Already granted — toggle the local master mute switch
  const p = getNotifPrefs();
  p.enabled = !(p.enabled !== false);
  saveNotifPrefs(p);
  updateNotifBtn();
  toast(p.enabled ? '🔔 Notifications unmuted' : '🔕 Notifications muted');
}

// Render the Notifications card body (status pill + prefs switches or enable button)
function renderNotifSettings() {
  const body = document.getElementById('notifCardBody');
  if (!body) return;

  // Status pill
  let pill;
  if (notifPermission === 'granted') {
    pill = `<span class="status-badge status-success" style="display:inline-flex;align-items:center;gap:6px"><span data-icon="check" data-size="12"></span> Granted</span>`;
  } else if (notifPermission === 'denied') {
    pill = `<span class="status-badge status-failure" style="display:inline-flex;align-items:center;gap:6px"><span data-icon="x" data-size="12"></span> Blocked by browser</span>`;
  } else {
    pill = `<span class="status-badge" style="background:rgba(161,161,170,0.1);color:var(--muted-foreground);display:inline-flex;align-items:center;gap:6px"><span data-icon="bell" data-size="12"></span> Not requested</span>`;
  }

  const statusRow = `<div class="flex items-center justify-between mb-3"><span class="text-xs text-muted-foreground">Permission</span>${pill}</div>`;

  // Body content depending on state
  let inner;
  if (notifPermission === 'granted') {
    const p = getNotifPrefs();
    const sw = (key, label, desc, iconName, color) => `
      <div class="flex items-start justify-between gap-3 py-2.5 border-t border-border first:border-t-0">
        <div class="flex items-start gap-2.5 min-w-0">
          <span data-icon="${iconName}" data-size="14" style="color:${color};margin-top:2px;flex-shrink:0"></span>
          <div class="min-w-0">
            <div class="text-sm font-medium">${label}</div>
            <div class="text-xs text-muted-foreground mt-0.5">${desc}</div>
          </div>
        </div>
        <div class="sched-toggle ${p[key] ? 'active' : ''}" role="switch" aria-checked="${p[key]}" tabindex="0" onclick="toggleNotifPref('${key}')" onkeydown="if(event.key===' '||event.key==='Enter'){event.preventDefault();toggleNotifPref('${key}')}" data-tooltip="${p[key] ? 'Disable' : 'Enable'}"></div>
      </div>`;
    inner = `
      <div>
        ${sw('enabled',   'Enabled',         'Master switch. Turn off to mute all notifications without revoking browser permission.', 'bell', 'var(--primary)')}
        ${sw('onFailure', 'Failure alerts',  'Notify when a workflow run fails.',                              'alert',  'var(--red)')}
        ${sw('onSuccess', 'Success alerts',  'Notify when a workflow run completes successfully.',             'check',  'var(--green)')}
        ${sw('onStart',   'Start alerts',    'Notify when a new workflow run starts (queued or in_progress).', 'play',   'var(--blue, #3b82f6)')}
        ${sw('requireInteraction', 'Sticky failure alerts', 'Failure notifications stay on screen until dismissed.', 'lockKeyhole', 'var(--yellow)')}
        ${sw('sound',              'Sound',                  'Play a short tone with each notification.',             'bell',    'var(--purple)')}
      </div>
      <div class="flex gap-2 mt-3 pt-3 border-t border-border">
        <button class="btn btn-outline sm" onclick="testNotification()" type="button"><span data-icon="bell" data-size="14"></span> Send test</button>
        <button class="btn btn-outline sm" onclick="playNotifSound('test')" type="button" data-tooltip="Preview notification sound"><span data-icon="bell" data-size="14"></span> Test sound</button>
      </div>`;
  } else if (notifPermission === 'denied') {
    inner = `<div class="text-xs text-muted-foreground leading-relaxed">Notifications were blocked. To re-enable, open your browser's site settings for this page (lock icon in address bar) and set <strong>Notifications</strong> to <em>Allow</em>, then reload.</div>`;
  } else {
    inner = `<div class="flex flex-col gap-2"><button class="btn btn-outline sm" onclick="requestNotifPermission()" type="button" style="align-self:flex-start"><span data-icon="bell" data-size="14"></span> Enable Notifications</button><div class="text-xs text-muted-foreground">Browser will ask for permission. You can fine-tune what to be alerted about after granting.</div></div>`;
  }

  body.innerHTML = statusRow + inner;
  if (window.renderIcons) window.renderIcons(body);
}

function testNotification() {
  showNotification({
    title: '🔔 Test notification',
    body: 'If you can see this, notifications are working correctly.',
    tag: 'notif-test-' + Date.now(),
    soundKind: 'test',
  });
  toast('Test notification sent');
}

async function requestNotifPermission() {
  if (!('Notification' in window)) { toast('⚠️ Notifications not supported on this device'); return; }
  try {
    const result = await Notification.requestPermission();
    notifPermission = result;
    updateNotifBtn();
    if (result === 'granted') {
      toast('🔔 Notifications enabled');
      showNotification({
        title: '✅ Notifications Active',
        body: 'You will get a ping only when a workflow fails.',
        tag: 'notif-welcome',
      });
    }
    else if (result === 'denied') toast('🔕 Notifications blocked by browser. Check Settings.');
    else toast('⚠️ Permission dismissed');
  } catch (e) {
    toast(`⚠️ ${e.message}`, 'warning');
  }
}

// Unified notification API. opts: { title, body, tag, url, requireInteraction }
async function showNotification(opts) {
  if (notifPermission !== 'granted') return;
  const prefs = getNotifPrefs();
  if (prefs.enabled === false) return;   // master mute
  const { title, body, tag, url, requireInteraction, soundKind } = opts;
  // Play our own synthesized tone (independent of OS notification sound)
  try { playNotifSound(soundKind || 'test'); } catch {}
  const options = {
    body,
    tag: tag || ('wf-' + Date.now()),
    renotify: false,                     // don't vibrate again when replacing same tag
    icon: 'icon-192.png',                // fallback gracefully if missing
    badge: 'icon-192.png',
    data: { url: url || location.href, ts: Date.now() },
    requireInteraction: !!requireInteraction,
    silent: false,
  };
  try {
    const reg = await navigator.serviceWorker?.ready;
    if (reg) {
      await reg.showNotification(title, options);
    } else {
      const n = new Notification(title, options);
      if (url) n.onclick = () => { window.open(url, '_blank'); n.close(); };
    }
  } catch {
    try {
      const n = new Notification(title, { body, tag });
      if (url) n.onclick = () => { window.open(url, '_blank'); n.close(); };
    } catch {}
  }
}

// ── Persistent "seen runs" store (localStorage, TTL 7d) ──
function loadSeenRuns() {
  try {
    const raw = localStorage.getItem(NOTIF_STORE_KEY);
    if (!raw) return {};
    const store = JSON.parse(raw);
    // Drop expired
    const cutoff = Date.now() - SEEN_TTL_DAYS * 86400_000;
    const cleaned = {};
    for (const [id, ts] of Object.entries(store)) {
      if (ts > cutoff) cleaned[id] = ts;
    }
    return cleaned;
  } catch { return {}; }
}

function saveSeenRuns(store) {
  try { localStorage.setItem(NOTIF_STORE_KEY, JSON.stringify(store)); } catch {}
}

function markRunSeen(store, id) {
  store[String(id)] = Date.now();
}

function isRunSeen(store, id) {
  return Object.prototype.hasOwnProperty.call(store, String(id));
}

// Format relative time, e.g. "2m ago"
function relTimeShort(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function checkForNewFailures(allRuns) {
  // Misnomer: now handles failure / success / start notifications based on user prefs.
  const store = loadSeenRuns();
  const now = Date.now();
  const freshCutoff = now - FRESH_WINDOW_MIN * 60_000;
  const prefs = getNotifPrefs();

  // First refresh after page load: seed everything silently, no notifications.
  if (isFirstRefresh) {
    for (const r of allRuns) {
      // Seed completed AND in_progress/queued so we don't blast on first poll
      markRunSeen(store, r.id + ':' + (r.status === 'completed' ? r.conclusion : r.status));
      if (r.status === 'completed') markRunSeen(store, r.id);    // legacy key for back-compat
    }
    saveSeenRuns(store);
    isFirstRefresh = false;
    return;
  }

  if (notifPermission !== 'granted') {
    // Mark everything seen so we don't backlog on grant later
    for (const r of allRuns) {
      markRunSeen(store, r.id + ':' + (r.status === 'completed' ? r.conclusion : r.status));
      if (r.status === 'completed') markRunSeen(store, r.id);
    }
    saveSeenRuns(store);
    return;
  }

  let notified = 0;
  const tryNotify = (r, kind) => {
    if (notified >= MAX_NOTIFY_PER_REFRESH) return;
    const wf = r._wf || {};
    const wfName = wf.name || 'Workflow';
    const icon = wf.icon || '⚙️';
    const titles = {
      failure: `${icon} ${wfName} failed`,
      success: `${icon} ${wfName} succeeded`,
      start:   `${icon} ${wfName} started`,
    };
    showNotification({
      title: titles[kind],
      body: `Run #${r.run_number} • ${r.event} • ${relTimeShort(r.updated_at || r.created_at)}`,
      tag: `wf-${kind}-${wf.id || 'unknown'}`,
      url: r.html_url,
      requireInteraction: kind === 'failure' && prefs.requireInteraction,
      soundKind: kind,
    });
    notified++;
  };

  // FAILURES
  if (prefs.onFailure) {
    const newFailures = allRuns
      .filter(r => r.status === 'completed' && r.conclusion === 'failure' && !isRunSeen(store, r.id + ':failure'))
      .sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at));
    for (const r of newFailures) {
      const completedAt = new Date(r.updated_at || r.created_at).getTime();
      if (completedAt >= freshCutoff) tryNotify(r, 'failure');
      markRunSeen(store, r.id + ':failure');
      markRunSeen(store, r.id);    // legacy
    }
  } else {
    // Still seed so toggling on later doesn't backlog
    for (const r of allRuns.filter(r => r.status === 'completed' && r.conclusion === 'failure')) {
      markRunSeen(store, r.id + ':failure');
      markRunSeen(store, r.id);
    }
  }

  // SUCCESSES
  if (prefs.onSuccess) {
    const newSucc = allRuns
      .filter(r => r.status === 'completed' && r.conclusion === 'success' && !isRunSeen(store, r.id + ':success'))
      .sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at));
    for (const r of newSucc) {
      const completedAt = new Date(r.updated_at || r.created_at).getTime();
      if (completedAt >= freshCutoff) tryNotify(r, 'success');
      markRunSeen(store, r.id + ':success');
    }
  } else {
    for (const r of allRuns.filter(r => r.status === 'completed' && r.conclusion === 'success')) {
      markRunSeen(store, r.id + ':success');
    }
  }

  // STARTS
  if (prefs.onStart) {
    const newStarts = allRuns
      .filter(r => (r.status === 'in_progress' || r.status === 'queued') && !isRunSeen(store, r.id + ':start'))
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    for (const r of newStarts) {
      const createdAt = new Date(r.created_at).getTime();
      if (createdAt >= freshCutoff) tryNotify(r, 'start');
      markRunSeen(store, r.id + ':start');
    }
  } else {
    for (const r of allRuns.filter(r => r.status === 'in_progress' || r.status === 'queued')) {
      markRunSeen(store, r.id + ':start');
    }
  }

  saveSeenRuns(store);
}

if ('serviceWorker' in navigator) {
  // Bump query string to force update of stale SW on existing PWA installs
  navigator.serviceWorker.register('sw.js?v=23').catch(() => {});
}

// ═══════════════════════════════════════════════════
//  INIT  (wait for ALL scripts to load before init —
//   otherwise dashboard.js symbols like startPolling/
//   refresh aren't defined yet when app.js executes,
//   causing a silent ReferenceError in showDashboard()
//   and the dashboard never starts polling on reload.)
// ═══════════════════════════════════════════════════
function bootstrap() {
  updateNotifBtn();
  if (restoreSession()) {
    // Session survived reload — go straight to dashboard
    showDashboard();
  } else if (!hasVault()) {
    switchTab('setup');
    document.getElementById('authDesc').textContent = 'First time? Set up your encrypted vault.';
  } else {
    document.getElementById('passphrase').focus();
    // Try biometric auto-unlock if enrolled on this device
    tryBiometricAutoUnlock();
  }
}

async function tryBiometricAutoUnlock() {
  if (!window.Biometric || !window.Biometric.isPwa() || !window.Biometric.isEnabled()) {
    updateBiometricButton();
    return;
  }
  updateBiometricButton();
  // Auto-trigger Face ID on app open if enrolled
  try {
    const token = await window.Biometric.unlock();
    if (token) {
      saveSession(token);
      showDashboard();
      toast('🔓 Unlocked with biometric');
    }
  } catch (e) {
    console.log('[Biometric] auto-unlock skipped:', e.message || e);
    // Silent fallback — user can tap passphrase or button
  }
}

async function unlockWithBiometric() {
  if (!window.Biometric || !window.Biometric.isEnabled()) {
    toast('Biometric not enrolled on this device', 'warning');
    return;
  }
  try {
    const token = await window.Biometric.unlock();
    saveSession(token);
    showDashboard();
    toast('🔓 Unlocked with biometric');
  } catch (e) {
    toast('❌ Biometric unlock failed: ' + (e.message || e), 'error');
  }
}

function updateBiometricButton() {
  const btn = document.getElementById('biometricUnlockBtn');
  if (!btn) return;
  if (window.Biometric && window.Biometric.isPwa() && window.Biometric.isEnabled()) {
    btn.style.display = 'flex';
  } else {
    btn.style.display = 'none';
  }
}

async function enrollBiometric() {
  if (!window.Biometric) return;
  if (!window.Biometric.isPwa()) {
    toast('⚠️ Install the dashboard as a PWA (Add to Home Screen) to enable biometric unlock', 'warning');
    return;
  }
  if (!await window.Biometric.isPlatformAuthenticatorAvailable()) {
    toast('❌ Face ID / Touch ID / Windows Hello not available on this device', 'error');
    return;
  }
  if (!sessionToken) { toast('Unlock with passphrase first', 'warning'); return; }
  try {
    const r = await window.Biometric.enroll(sessionToken);
    if (r.ok) {
      toast(`✅ Biometric enabled (${r.tier === 'prf' ? 'crypto-bound' : 'gated'})`);
      if (typeof renderBiometricStatus === 'function') renderBiometricStatus();
    }
  } catch (e) {
    toast('❌ Enrollment failed: ' + (e.message || e), 'error');
  }
}

function disableBiometric() {
  if (!window.Biometric) return;
  if (!confirm('Disable biometric auto-unlock on this device? You\'ll need to enter passphrase on next launch.')) return;
  window.Biometric.disable();
  toast('Biometric disabled on this device');
  if (typeof renderBiometricStatus === 'function') renderBiometricStatus();
  updateBiometricButton();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  // DOM already parsed (scripts at end of body) — but defer to next tick
  // so any remaining <script> tags after this one finish executing first.
  setTimeout(bootstrap, 0);
}

// ─── Body scroll-lock when any modal/dialog overlay is open ───
(function initScrollLock() {
  function syncScrollLock() {
    const hasOpen = document.querySelector('.modal-overlay.open, .dialog-overlay.open, .spinner-overlay.open');
    document.body.classList.toggle('modal-open', !!hasOpen);
  }
  const observer = new MutationObserver(syncScrollLock);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'], subtree: true });
  // Also listen on DOMContentLoaded in case overlays exist at load
  document.addEventListener('DOMContentLoaded', syncScrollLock);
})();

// ─── Global tooltip portal (shadcn-style) ───
// Any element with [data-tooltip] gets a floating tooltip on hover/focus.
(function initTooltipPortal() {
  let tip = null;
  let currentTrigger = null;
  let hideTimer = null;

  function ensureTip() {
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'tooltip-portal';
      tip.setAttribute('role', 'tooltip');
      document.body.appendChild(tip);
    }
    return tip;
  }

  function position(trigger) {
    const el = ensureTip();
    const r = trigger.getBoundingClientRect();
    // measure
    el.style.left = '0px';
    el.style.top = '0px';
    el.classList.remove('below');
    const tr = el.getBoundingClientRect();
    const margin = 8;
    let top = r.top - tr.height - 6;
    let below = false;
    if (top < margin) {
      top = r.bottom + 6;
      below = true;
    }
    let left = r.left + r.width / 2 - tr.width / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - tr.width - margin));
    const arrowX = (r.left + r.width / 2) - left;
    el.style.left = left + 'px';
    el.style.top = top + 'px';
    el.style.setProperty('--arrow-x', arrowX + 'px');
    if (below) el.classList.add('below');
  }

  function show(trigger) {
    const text = trigger.getAttribute('data-tooltip');
    if (!text) return;
    // If element opts into "only-when-truncated" mode and text isn't actually
    // overflowing, skip the tooltip (avoids redundant hover boxes on short text).
    if (trigger.hasAttribute('data-tooltip-truncate-only')) {
      if (trigger.scrollWidth <= trigger.clientWidth + 1) return;
    }
    clearTimeout(hideTimer);
    currentTrigger = trigger;
    const el = ensureTip();
    el.textContent = text;
    el.classList.remove('visible');
    requestAnimationFrame(() => {
      position(trigger);
      el.classList.add('visible');
    });
  }

  function hide() {
    if (!tip) return;
    currentTrigger = null;
    tip.classList.remove('visible');
  }

  document.addEventListener('mouseover', (e) => {
    const t = e.target.closest('[data-tooltip]');
    if (t && t !== currentTrigger) show(t);
  });
  document.addEventListener('mouseout', (e) => {
    const t = e.target.closest('[data-tooltip]');
    if (t && t === currentTrigger) {
      hideTimer = setTimeout(hide, 80);
    }
  });
  document.addEventListener('focusin', (e) => {
    const t = e.target.closest('[data-tooltip]');
    if (t) show(t);
  });
  document.addEventListener('focusout', (e) => {
    const t = e.target.closest('[data-tooltip]');
    if (t && t === currentTrigger) hide();
  });
  window.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
})();
