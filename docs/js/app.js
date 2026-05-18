// ═══════════════════════════════════════════════════
//  CONFIGURATION
// ═══════════════════════════════════════════════════
const OWNER = 'VuTan11501';
const REPO = 'Code';
const API = 'https://api.github.com';
const GIST_ID = 'abc2a47c0a396025a72a6580227ff493';
const WORKFLOWS = [
  { id: 277782817, name: 'Auto Checkin/Checkout', icon: '🕐', file: 'auto-checkin.yml' },
  { id: 277802136, name: 'Auto OT Creator', icon: '⏰', file: 'auto-ot.yml' },
  { id: 278223037, name: 'JPY Forecast Daily Report', icon: '💹', file: 'jpy-forecast.yml' },
];
const AUTO_LOCK_MS = 15 * 60 * 1000;

const SCHEDULE = {
  'Auto Checkin/Checkout': [
    { days: [1,2,3,4,5], time: '09:00', label: 'Workday CI' },
    { days: [1,2,3,4,5], time: '18:00', label: 'Workday CO' },
    { days: [0,1,2,3,4,5,6], time: '22:00', label: 'Night OT CI' },
    { days: [0,1,2,3,4,5,6], time: '00:00', label: 'Midnight CO' },
    { days: [0,1,2,3,4,5,6], time: '03:30', label: 'Night OT CO' },
    { days: [0], time: '14:30', label: 'Sunday OT CI' },
  ],
  'JPY Forecast Daily Report': [
    { days: [1,2,3,4,5], time: '07:30', label: 'Daily Report' },
  ],
  'Auto OT Creator': [
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
//  API & UTILITIES
// ═══════════════════════════════════════════════════
async function apiFetch(path) {
  const headers = { 'Accept': 'application/vnd.github+json' };
  if (sessionToken) headers['Authorization'] = `Bearer ${sessionToken}`;
  const res = await fetch(`${API}${path}`, { headers });
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
  return res.json();
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
let notifPermission = (typeof Notification !== 'undefined') ? Notification.permission : 'default';

function updateNotifBtn() {
  const btn = document.getElementById('notifBtn');
  if (!btn) return;
  if (notifPermission === 'granted') { btn.textContent = '🔔'; btn.title = 'Notifications: ON'; }
  else if (notifPermission === 'denied') { btn.textContent = '🔕'; btn.title = 'Notifications: Blocked'; }
  else { btn.textContent = '🔔'; btn.title = 'Enable notifications'; }
}

async function requestNotifPermission() {
  if (!('Notification' in window)) { toast('⚠️ Notifications not supported on this device'); return; }
  try {
    const result = await Notification.requestPermission();
    notifPermission = result;
    updateNotifBtn();
    if (result === 'granted') {
      toast('🔔 Notifications enabled');
      // Test notification via ServiceWorker for PWA compatibility
      showNotification('✅ Notifications Active', 'You will be notified when workflows fail.');
    }
    else if (result === 'denied') toast('🔕 Notifications blocked by browser. Check Settings.');
    else toast('⚠️ Permission dismissed');
  } catch (e) {
    toast(`⚠️ ${e.message}`, 'warning');
  }
}

async function showNotification(title, body, tag) {
  if (notifPermission !== 'granted') return;
  try {
    // Prefer ServiceWorker notification (works in PWA/iOS)
    const reg = await navigator.serviceWorker?.ready;
    if (reg) {
      await reg.showNotification(title, { body, tag: tag || 'wf-' + Date.now(), icon: '⚡' });
    } else {
      // Fallback to Notification constructor (desktop)
      new Notification(title, { body, tag });
    }
  } catch {
    // Silent fail if notifications not available
    try { new Notification(title, { body, tag }); } catch {}
  }
}

function checkForNewFailures(allRuns) {
  if (notifPermission !== 'granted') return;
  const knownStr = sessionStorage.getItem('wf_known_failures') || '[]';
  const knownIds = new Set(JSON.parse(knownStr));
  const newFailures = allRuns.filter(r =>
    r.status === 'completed' && r.conclusion === 'failure' && !knownIds.has(r.id)
  );
  for (const r of newFailures) {
    const wf = r._wf || {};
    showNotification(
      `❌ ${wf.name || 'Workflow'} Failed`,
      `Run #${r.run_number} failed (${r.event})`,
      `wf-fail-${r.id}`
    );
  }
  const allFailIds = allRuns.filter(r => r.status === 'completed' && r.conclusion === 'failure').map(r => r.id);
  sessionStorage.setItem('wf_known_failures', JSON.stringify(allFailIds));
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// ═══════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════
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
