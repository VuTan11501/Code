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

function updateNotifBtn() {
  const btn = document.getElementById('notifBtn');
  if (!btn) return;
  if (notifPermission === 'granted') { btn.innerHTML = ICON('bell', 18); btn.title = 'Notifications: ON'; btn.style.opacity = '1'; }
  else if (notifPermission === 'denied') { btn.innerHTML = ICON('bell', 18); btn.title = 'Notifications: Blocked'; btn.style.opacity = '0.4'; }
  else { btn.innerHTML = ICON('bell', 18); btn.title = 'Enable notifications'; btn.style.opacity = '0.7'; }
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
  const { title, body, tag, url, requireInteraction } = opts;
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
  // Always update the seen store, but only notify if permissions granted & not first refresh
  const store = loadSeenRuns();
  const now = Date.now();
  const freshCutoff = now - FRESH_WINDOW_MIN * 60_000;

  // Find unseen completed failures
  const newFailures = allRuns
    .filter(r => r.status === 'completed' && r.conclusion === 'failure' && !isRunSeen(store, r.id))
    .sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at));

  // First refresh after page load: seed everything silently, no notifications.
  // This prevents the "open phone → flood of old failures" bug.
  if (isFirstRefresh) {
    for (const r of allRuns) {
      if (r.status === 'completed') markRunSeen(store, r.id);
    }
    saveSeenRuns(store);
    isFirstRefresh = false;
    return;
  }

  if (notifPermission !== 'granted') {
    // Still mark seen so we don't backlog if permission is granted later
    for (const r of newFailures) markRunSeen(store, r.id);
    saveSeenRuns(store);
    return;
  }

  // Only notify failures that completed within the fresh window
  let notified = 0;
  for (const r of newFailures) {
    const completedAt = new Date(r.updated_at || r.created_at).getTime();
    const isFresh = completedAt >= freshCutoff;
    if (isFresh && notified < MAX_NOTIFY_PER_REFRESH) {
      const wf = r._wf || {};
      const wfName = wf.name || 'Workflow';
      const icon = wf.icon || '⚙️';
      showNotification({
        title: `${icon} ${wfName} failed`,
        body: `Run #${r.run_number} • ${r.event} • ${relTimeShort(r.updated_at || r.created_at)}`,
        tag: `wf-fail-${wf.id || 'unknown'}`,       // per-workflow tag → newer replaces older
        url: r.html_url,
        requireInteraction: true,                    // stay on screen until user dismisses
      });
      notified++;
    }
    // Mark seen regardless (even if too old to notify) so we don't reconsider
    markRunSeen(store, r.id);
  }

  saveSeenRuns(store);
}

if ('serviceWorker' in navigator) {
  // Bump query string to force update of stale SW on existing PWA installs
  navigator.serviceWorker.register('sw.js?v=7').catch(() => {});
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
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  // DOM already parsed (scripts at end of body) — but defer to next tick
  // so any remaining <script> tags after this one finish executing first.
  setTimeout(bootstrap, 0);
}

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
