// ═══════════════════════════════════════════════════
//  CONFIGURATION
// ═══════════════════════════════════════════════════
const OWNER = 'VuTan11501';
const REPO = 'Code';
const API = 'https://api.github.com';
const GIST_ID = 'abc2a47c0a396025a72a6580227ff493';
const WORKFLOWS = [
  { name: 'Auto Checkin', icon: '📥', iconName: 'logIn', file: 'auto-checkin.yml' },
  { name: 'Auto Checkout', icon: '📤', iconName: 'logOut', file: 'auto-checkout.yml' },
  { name: 'Auto Request OT', icon: '⏰', iconName: 'hourglass', file: 'auto-ot-creator.yml' },
  { name: 'JPY Forecast', icon: '💹', iconName: 'barChart', file: 'jpy-forecast.yml' },
  { name: 'OT History Fetch', icon: '📊', iconName: 'refresh', file: 'ot-history-fetch.yml' },
  { name: 'Timesheet Fetch', icon: '🗓️', iconName: 'calendar', file: 'timesheet-fetch.yml' },
  { name: 'Payslip Fetch', icon: '💰', iconName: 'wallet', file: 'payslip-fetch.yml' },
  { name: 'OT Report', icon: '📋', iconName: 'clipboard', file: 'ot-report.yml' },
  { name: 'Schedule Generator', icon: '🧮', iconName: 'calendarPlus', file: 'schedule-generator.yml' },
  { name: 'Token Monitor', icon: '🔑', iconName: 'key', file: 'token-monitor.yml' },
  { name: 'Azure Reauth', icon: '🔐', iconName: 'lockKeyhole', file: 'azure-reauth.yml' },
  { name: 'Daily Validation', icon: '✅', iconName: 'check', file: 'daily-validation.yml' },
  { name: 'AI Anomaly Check', icon: '🤖', iconName: 'bot', file: 'ai-anomaly-check.yml' },
  { name: 'AI Monthly Insight', icon: '✨', iconName: 'sparkles', file: 'ai-monthly-insight.yml' },
];
const WORKFLOWS_INFRA = [
  { name: 'Scheduled Dispatch', icon: '🎯', iconName: 'target', file: 'scheduled-dispatch.yml', infra: true },
  { name: 'Dispatcher Watchdog', icon: '🐕', iconName: 'eye', file: 'dispatcher-watchdog.yml', infra: true },
  { name: 'Heartbeat', icon: '💓', iconName: 'zap', file: 'heartbeat.yml', infra: true },
  { name: 'Deploy Pages', icon: '🚀', iconName: 'upload', file: 'deploy-pages.yml', infra: true },
  { name: 'Copilot Setup', icon: '🛠️', iconName: 'settings', file: 'copilot-setup-steps.yml', infra: true },
];
const WORKFLOWS_ALL = [...WORKFLOWS, ...WORKFLOWS_INFRA];
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
  // Clear AI conversation on logout/auto-lock — never persist chat across auth boundary
  if (window.AIAgent && typeof window.AIAgent.clearAllConvs === 'function') {
    try { window.AIAgent.clearAllConvs(); } catch {}
  } else if (window.AIAgent && typeof window.AIAgent.clearConv === 'function') {
    try { window.AIAgent.clearConv(); } catch {}
  }
  try { sessionStorage.removeItem('ai_conv_v1'); } catch {}
  try { localStorage.removeItem('ai_current_conv_v1'); } catch {}
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
  // Honour the URL hash on reload so users stay on the page they were
  // viewing. Only fall back to #dashboard when no valid hash is set
  // (e.g. fresh login, or PWA reopened from the home-screen icon).
  const validPages = ['dashboard', 'schedule', 'ai', 'ot', 'timesheet', 'settings'];
  const hashPage = location.hash.replace('#', '');
  const target = validPages.includes(hashPage) ? location.hash : '#dashboard';
  navigate(target);
  startAutoLock();
  startPolling();
  refresh();
  // Check token scopes (non-blocking)
  checkTokenScopes();
  // Latest monthly AI insight widget on dashboard (non-blocking).
  // AI scripts are lazy-loaded, so wait for them before rendering.
  ensurePageScripts('ai').then(() => {
    try { if (window.AIInsights) window.AIInsights.renderLatestInsight(); } catch {}
  });
  // Cross-device settings sync — pull on unlock (non-blocking)
  if (window.CloudSync) {
    window.CloudSync.init({ getToken: () => sessionToken, toast: (m) => toast(m) });
    window.CloudSync.register('workflow_locations_v1',  'Locations',                 'locations');
    window.CloudSync.register('ot_takehome_profile_v1', 'OT Profile',                'ot_profile');
    window.CloudSync.register('wf_dash_notif_prefs',    'Notification preferences',  'notif_prefs');
    window.CloudSync.register('sched_pip_filter_v1',    'Schedule filter',           'schedule_filter');
    window.CloudSync.register('wf_dash_theme',          'Theme (light/dark/auto)',   'theme');
    window.CloudSync.register('wf_dash_card_order',     'Dashboard card order',      'dash_order');
    window.CloudSync.register('wf_dash_visible_cards',  'Dashboard visible cards',   'dash_visible');
    window.CloudSync.pull().then(r => {
      if (r && r.applied) window.CloudSync.applyToUI();
    });
  }
}

async function checkTokenScopes() {
  if (!sessionToken) return;
  try {
    // Reuse the shared gist fetch (CloudSync.pull fires moments after) so
    // we don't fire an extra HEAD just to read X-OAuth-Scopes. fetchGist
    // returns the scopes header from the same response.
    if (window.CloudSync && typeof window.CloudSync.fetchGist === 'function') {
      const res = await window.CloudSync.fetchGist({ maxAgeMs: 60_000 });
      const scopes = (res && res.scopes) || '';
      if (scopes && !scopes.includes('gist')) {
        toast('⚠️ PAT thiếu scope "gist" — Schedule sẽ không tạo được. Cập nhật token tại Settings.', 'warning');
      }
      // Fine-grained PAT expiry warning — fires once per session if expiry
      // is within EXPIRY_WARN_DAYS. The header `github-authentication-token-
      // expiration` is only set for fine-grained PATs; classic ghp_ tokens
      // are silent (user warned via setup-form hint instead).
      const expiry = (res && res.expiry) || '';
      if (expiry && !window._tokenExpiryWarned) {
        const dt = Date.parse(expiry);
        if (!isNaN(dt)) {
          const daysLeft = Math.floor((dt - Date.now()) / (24 * 60 * 60 * 1000));
          const EXPIRY_WARN_DAYS = 14;
          if (daysLeft <= 0) {
            toast(`⚠️ PAT đã hết hạn (${expiry.slice(0,10)}) — cập nhật token tại Settings`, 'error', { duration: 15000 });
            window._tokenExpiryWarned = true;
          } else if (daysLeft <= EXPIRY_WARN_DAYS) {
            toast(`🔑 PAT hết hạn trong ${daysLeft} ngày (${expiry.slice(0,10)}) — đổi token sớm tại Settings`, 'warning', { duration: 10000 });
            window._tokenExpiryWarned = true;
          }
        }
      }
      return;
    }
    // Fallback (CloudSync not loaded for some reason)
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
// Per-tab scroll position memory — restored when returning to a tab so the
// page doesn't keep the scroll offset of the previously visible tab. Lives
// in-memory only (intentional: fresh reload always lands at the top).
const _tabScroll = Object.create(null);

// Measure the top nav-bar's bottom edge (only on desktop where it's in-flow)
// and expose it as a CSS variable so the AI page can position itself BELOW
// the nav instead of covering it. On mobile the nav is `position:fixed;
// bottom:0`, so its rect.top is near viewport bottom — we detect that and
// emit 0 (the CSS @media handles the bottom offset separately).
function updateAiTopOffset() {
  const nav = document.querySelector('.nav-bar');
  if (!nav) {
    document.documentElement.style.setProperty('--ai-top-offset', '0px');
    document.documentElement.style.setProperty('--nav-actual-height', '0px');
    return;
  }
  let offset = 0;
  let navHeight = 0;
  try {
    const cs = window.getComputedStyle(nav);
    const isFixed = cs.position === 'fixed';
    const rect = nav.getBoundingClientRect();
    navHeight = Math.max(0, Math.round(rect.height));
    if (!isFixed) {
      // rect.bottom is the y of the nav's bottom in the viewport. Clamp
      // to non-negative in case the nav is scrolled offscreen for any reason.
      offset = Math.max(0, Math.round(rect.bottom));
    }
  } catch {}
  document.documentElement.style.setProperty('--ai-top-offset', offset + 'px');
  // Expose the actual measured nav height so mobile bottom anchors can
  // subtract the real value instead of the hardcoded --mobile-nav-height
  // (which doesn't account for safe-area, font-size, or future layout
  // changes). Already includes the nav's own safe-area padding via
  // getBoundingClientRect().
  document.documentElement.style.setProperty('--nav-actual-height', navHeight + 'px');
}
// Re-measure on resize (orientation change, devtools open, etc.)
window.addEventListener('resize', () => {
  // Always re-measure: --nav-actual-height is consumed by the AI page
  // bottom anchor on mobile and needs to stay accurate even before the
  // user navigates to the AI tab for the first time.
  updateAiTopOffset();
});
// Initial measurement once the nav is in the DOM so mobile bottom
// anchors have a real value from the very first layout pass.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', updateAiTopOffset);
} else {
  updateAiTopOffset();
}

// Track visualViewport so AI composer + page can adjust when the soft
// keyboard opens. Pairs with `interactive-widget=resizes-visual` viewport
// meta which keeps the layout viewport stable (fixes the Android Chrome
// autofill-bar gap bug) at the cost of the keyboard now overlaying the
// composer. We compensate by pushing the composer up by the keyboard
// height via a CSS var (--kb-inset) consumed in style.css.
//
// Robust strategy: every time visualViewport reports anything (resize,
// scroll, animation frame), re-check document.activeElement. If the
// composer textarea is not currently focused, --kb-inset is forced to
// 0 regardless of vv.height. This handles cases where the keyboard
// dismisses without firing blur (Android back-gesture, autofill bar
// lingering) and prevents the page-bottom anchor from shrinking the
// AI page after the keyboard is gone.
(function trackKeyboardInset() {
  const root = document.documentElement;
  root.style.setProperty('--kb-inset', '0px');
  const vv = window.visualViewport;
  if (!vv) return;

  const update = () => {
    const ae = document.activeElement;
    const isComposer =
      ae && (ae.id === 'aiComposerInput' ||
             (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT') &&
             ae.closest && ae.closest('#page-ai'));
    let inset = 0;
    if (isComposer) {
      inset = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    }
    root.style.setProperty('--kb-inset', inset + 'px');
  };

  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  // focusin/out re-check too, with a delayed pass to catch late layout settles
  document.addEventListener('focusin', update);
  document.addEventListener('focusout', () => {
    update();
    setTimeout(update, 80);
    setTimeout(update, 250);
  });
  // Defensive: poll once a second while AI page is active to catch any
  // edge case the events miss (keyboard dismissed without blur, etc).
  setInterval(() => {
    if (document.body.classList.contains('ai-page-active')) update();
  }, 1000);
  update();
})();

// ─── Page-script readiness ─────────────────────────────────────────────
// All page scripts are loaded up-front with `defer`, so by the time
// `navigate()` runs they are already parsed and their init functions
// exist. We keep `ensurePageScripts` as a no-op promise for forward
// compatibility (any caller still using it just gets an immediate
// resolve).
function ensurePageScripts(_page) { return Promise.resolve(); }

function navigate(hash) {
  const page = hash.replace('#', '') || 'dashboard';

  const scriptsReady = ensurePageScripts(page);

  // Remember the scroll position of the tab we're leaving (if any).
  // For the AI page, scroll lives in an internal container (#aiChatScroll)
  // because the page itself is viewport-locked.
  const prevActive = document.querySelector('.page.active');
  if (prevActive && prevActive.id) {
    if (prevActive.id === 'page-ai') {
      const ac = document.getElementById('aiChatScroll');
      _tabScroll[prevActive.id] = ac ? ac.scrollTop : 0;
    } else {
      _tabScroll[prevActive.id] = window.scrollY || document.documentElement.scrollTop || 0;
    }
  }

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

  // Toggle body class so CSS can lock body scroll + size #page-ai to the
  // viewport when the AI tab is active. Must happen BEFORE init so the
  // chat scroll container has its final size when renderAll() runs.
  document.body.classList.toggle('ai-page-active', page === 'ai');
  if (page === 'ai') updateAiTopOffset();

  // Initialize page-specific content. Page-specific scripts are lazy-
  // loaded, so wait for them to be ready before calling init functions
  // that may not exist yet on first navigation to this tab.
  scriptsReady.then(() => {
    if (page === 'schedule' && typeof initSchedulePage === 'function') initSchedulePage();
    if (page === 'ot' && typeof initOtPlannerPage === 'function') initOtPlannerPage();
    if (page === 'timesheet' && typeof initTimesheetPage === 'function') initTimesheetPage();
    if (page === 'ai' && window.AIAgent && typeof window.AIAgent.mount === 'function') window.AIAgent.mount();
    if (page === 'settings' && typeof initSettingsPage === 'function') initSettingsPage();
  });
  if (page === 'dashboard' && typeof refresh === 'function' && sessionToken) {
    // Ensure dashboard always has fresh data when entering the tab.
    // Guards against any scenario where polling didn't start or stalled.
    refresh();
    if (typeof startPolling === 'function' && !pollTimer) startPolling();
  }

  // Restore scroll for the entered tab on the next frame so layout from
  // the init calls above has settled. The AI page restores its inner
  // scroll container instead of the window. We use hasOwnProperty so
  // a legitimately-saved scrollTop of 0 isn't treated as "no memory".
  const hasSaved = target && Object.prototype.hasOwnProperty.call(_tabScroll, target.id);
  const restoreTo = hasSaved ? _tabScroll[target.id] : null;
  requestAnimationFrame(() => {
    if (page === 'ai') {
      const ac = document.getElementById('aiChatScroll');
      if (ac) ac.scrollTop = (restoreTo != null) ? restoreTo : ac.scrollHeight;
      try { window.scrollTo({ top: 0, left: 0, behavior: 'instant' }); } catch { window.scrollTo(0, 0); }
    } else {
      const top = restoreTo != null ? restoreTo : 0;
      try { window.scrollTo({ top, left: 0, behavior: 'instant' }); }
      catch { window.scrollTo(0, top); }
    }
  });
}

window.addEventListener('hashchange', () => {
  if (sessionToken) navigate(location.hash);
});

// ═══════════════════════════════════════════════════
//  TOAST
// ═══════════════════════════════════════════════════
// ═══════════════════════════════════════════════════
//  TOAST (stack of up to 3 visible)
// ═══════════════════════════════════════════════════
// Replaces the legacy single-slot toast. Each call appends a new
// .toast-item child; older ones are pushed up. When the stack exceeds
// MAX_VISIBLE, the oldest fades out early. Returns the toast element so
// callers can dismiss programmatically (e.g. for undoableToast).
const TOAST_MAX_VISIBLE = 3;
function toast(msg, cls, opts = {}) {
  const stack = document.getElementById('toastStack');
  if (!stack) return null;
  const duration = opts.duration ?? (cls === 'error' ? 8000 : cls === 'warning' ? 6000 : 4000);
  const item = document.createElement('div');
  item.className = 'toast-item' + (cls ? ' ' + cls : '');
  item.setAttribute('role', cls === 'error' ? 'alert' : 'status');
  const msgEl = document.createElement('div');
  msgEl.className = 'toast-msg';
  msgEl.textContent = msg;
  item.appendChild(msgEl);
  const actions = document.createElement('div');
  actions.className = 'toast-actions';
  if (typeof opts.onUndo === 'function') {
    const undoBtn = document.createElement('button');
    undoBtn.type = 'button';
    undoBtn.className = 'toast-undo';
    undoBtn.textContent = opts.undoLabel || 'Undo';
    undoBtn.addEventListener('click', () => {
      try { opts.onUndo(); } catch (e) { console.warn('[toast] undo handler failed', e); }
      dismiss();
    });
    actions.appendChild(undoBtn);
  }
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'toast-close';
  closeBtn.setAttribute('aria-label', 'Dismiss');
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', () => dismiss());
  actions.appendChild(closeBtn);
  item.appendChild(actions);
  stack.appendChild(item);

  // Trigger CSS transition
  requestAnimationFrame(() => item.classList.add('show'));

  // Evict oldest if over cap
  const items = stack.querySelectorAll('.toast-item');
  if (items.length > TOAST_MAX_VISIBLE) {
    items[0]._dismiss && items[0]._dismiss();
  }

  let dismissed = false;
  function dismiss() {
    if (dismissed) return;
    dismissed = true;
    clearTimeout(timer);
    item.classList.remove('show');
    setTimeout(() => { try { item.remove(); } catch {} }, 250);
  }
  item._dismiss = dismiss;
  const timer = setTimeout(dismiss, duration);
  return { dismiss };
}

// Convenience: toast with undo button. Pattern:
//   undoableToast('Card hidden', () => restoreCard(id))
function undoableToast(msg, onUndo, opts = {}) {
  return toast(msg, opts.cls || 'success', {
    duration: opts.duration || 6000,
    undoLabel: opts.undoLabel || 'Undo',
    onUndo,
  });
}

// ═══════════════════════════════════════════════════
//  BUTTON SPINNER WRAPPER
// ═══════════════════════════════════════════════════
// Wraps an async action so the triggering button shows the same shadcn-
// style spinner used by other Refresh/Sync buttons (icon swap + disable
// + label). The button is restored even if `fn()` throws.
//   await withBtnSpinner('myBtnId', () => loadFoo({refresh:true}), 'Refreshing…')
async function withBtnSpinner(btnIdOrEl, fn, label = 'Loading…') {
  const btn = typeof btnIdOrEl === 'string' ? document.getElementById(btnIdOrEl) : btnIdOrEl;
  const orig = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    const iconHtml = (typeof ICON === 'function') ? ICON('refresh', 14, 'animate-spin') : '';
    btn.innerHTML = `${iconHtml} ${label}`;
  }
  try { return await fn(); }
  finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = orig;
    }
  }
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

// Sleep helper used by the retry/backoff path.
function _apiSleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Decide how long to wait before retrying a failed GitHub call.
// Honors Retry-After (seconds OR HTTP-date) and X-RateLimit-Reset (unix sec).
// Falls back to exponential 500ms → 1s → 2s with jitter.
function _apiRetryDelay(resp, attempt) {
  const cap = 8000;  // never sleep more than 8s in a single attempt
  if (resp) {
    const ra = resp.headers.get('Retry-After');
    if (ra) {
      const n = Number(ra);
      if (!isNaN(n)) return Math.min(cap, n * 1000);
      const dt = Date.parse(ra);
      if (!isNaN(dt)) return Math.min(cap, Math.max(0, dt - Date.now()));
    }
    if (resp.status === 403 || resp.status === 429) {
      const reset = resp.headers.get('X-RateLimit-Reset');
      if (reset) {
        const ms = Math.max(0, parseInt(reset, 10) * 1000 - Date.now());
        if (ms > 0) return Math.min(cap, ms);
      }
    }
  }
  const base = 500 * Math.pow(2, attempt);  // 500, 1000, 2000
  const jitter = Math.floor(Math.random() * 250);
  return Math.min(cap, base + jitter);
}

async function apiFetch(path, opts = {}) {
  const headers = { 'Accept': 'application/vnd.github+json' };

  // Route through Cloudflare Worker proxy if configured (PAT stays server-side).
  // Falls back to direct api.github.com call with Bearer token when not set.
  const proxyUrl = (window.CloudSync && window.CloudSync.getProxyUrl)
    ? window.CloudSync.getProxyUrl() : '';
  const fullUrl = proxyUrl ? `${proxyUrl}${path}` : `${API}${path}`;
  if (!proxyUrl && sessionToken) headers['Authorization'] = `Bearer ${sessionToken}`;

  // Use ETag for conditional request if available
  const cached = etagCache.get(path);
  if (cached?.etag && !opts.noCache) {
    headers['If-None-Match'] = cached.etag;
  }

  const maxAttempts = opts.maxAttempts ?? 3;
  let lastErr = null;
  let res = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      res = await fetch(fullUrl, { headers });
    } catch (e) {
      // Network error — retry (offline blip, DNS hiccup)
      lastErr = e;
      if (attempt < maxAttempts - 1) {
        await _apiSleep(_apiRetryDelay(null, attempt));
        continue;
      }
      throw e;
    }

    // Transient: 429 Too Many Requests OR 5xx → retry with backoff
    if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
      if (attempt < maxAttempts - 1) {
        await _apiSleep(_apiRetryDelay(res, attempt));
        continue;
      }
    }
    break;
  }

  if (!res) throw lastErr || new Error('apiFetch: no response');

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

// ═══════════════════════════════════════════════════
//  THEME TOGGLE (dark / light)
// ═══════════════════════════════════════════════════
function getTheme() {
  return localStorage.getItem('wf_dash_theme') || 'dark';
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === 'dark' ? '#09090b' : '#ffffff';
  const iconEl = document.getElementById('themeIcon');
  if (iconEl) {
    iconEl.setAttribute('data-icon', theme === 'dark' ? 'sun' : 'moon');
    iconEl.removeAttribute('data-icon-rendered');
    renderIcons(iconEl.parentElement);
  }
}

function toggleTheme() {
  const next = getTheme() === 'dark' ? 'light' : 'dark';
  localStorage.setItem('wf_dash_theme', next);
  applyTheme(next);
}

// Apply saved theme on load
(function initTheme() {
  applyTheme(getTheme());
})();

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
  // Workflows that should NEVER trigger notifications (too frequent / heartbeat-style).
  const NOTIF_MUTED_WORKFLOWS = new Set(['scheduled-dispatch.yml']);
  const tryNotify = (r, kind) => {
    if (notified >= MAX_NOTIFY_PER_REFRESH) return;
    const wf = r._wf || {};
    if (wf.file && NOTIF_MUTED_WORKFLOWS.has(wf.file)) return;
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
      tag: `wf-${kind}-${wf.file || wf.id || 'unknown'}`,
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
  navigator.serviceWorker.register('sw.js?v=26').then((reg) => {
    // Listen for the SW telling us a new version is active.
    navigator.serviceWorker.addEventListener('message', (ev) => {
      const data = ev.data || {};
      if (data.type === 'sw-updated') {
        // Only show the reload toast if we already had a controller before
        // (i.e. this is an UPDATE, not the very first install).
        if (window._swSeenController) {
          if (typeof toast === 'function') {
            toast('🔄 New version available', 'success', {
              duration: 15000,
              undoLabel: 'Reload',
              onUndo: () => window.location.reload(),
            });
          }
        }
        window._swSeenController = true;
      }
    });
    // Track whether we boot with a controller (so the first sw-updated
    // message after install doesn't trigger a toast on the very first load).
    window._swSeenController = !!navigator.serviceWorker.controller;
  }).catch(() => {});
}

// ═══════════════════════════════════════════════════
//  INIT  (wait for ALL scripts to load before init —
//   otherwise dashboard.js symbols like startPolling/
//   refresh aren't defined yet when app.js executes,
//   causing a silent ReferenceError in showDashboard()
//   and the dashboard never starts polling on reload.)
// ═══════════════════════════════════════════════════
function bootstrap() {
  if (window.Theme && typeof window.Theme.init === 'function') {
    try { window.Theme.init(); } catch {}
  }
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

async function disableBiometric() {
  if (!window.Biometric) return;
  const ok = await (typeof uiConfirm === 'function'
    ? uiConfirm({ title: 'Tắt biometric unlock?', message: 'Lần mở app tiếp theo bạn sẽ phải nhập passphrase.', confirmText: 'Tắt', cancelText: 'Hủy', danger: true })
    : Promise.resolve(window.confirm('Disable biometric auto-unlock on this device?')));
  if (!ok) return;
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

// (keyboard shortcuts appended below)

// ═══════════════════════════════════════════════════════════════════
// Keyboard shortcuts
// ───────────────────────────────────────────────────────────────────
// - `g` then `d/o/t/s/a/x` within 800ms → navigate (Dashboard/Ot/Timesheet/Schedule/Ai/settings)
// - `cmd+k` or `ctrl+k` → quick-switcher modal
// - `?` → show shortcut cheatsheet
// Skipped while typing in inputs/textareas/contenteditable.
// ═══════════════════════════════════════════════════════════════════
(function() {
  const NAV = {
    d: 'dashboard', o: 'ot', t: 'timesheet', s: 'schedule', a: 'ai', x: 'settings',
  };
  const NAV_LABELS = {
    dashboard: 'Dashboard', ot: 'OT', timesheet: 'Timesheet',
    schedule: 'Schedule', ai: 'AI Assistant', settings: 'Settings',
  };

  let gPending = false;
  let gTimer = null;

  function isTyping(el) {
    if (!el) return false;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    if (el.isContentEditable) return true;
    return false;
  }

  function go(page) {
    if (typeof navigate === 'function') {
      location.hash = '#' + page;
    }
  }

  function openQuickSwitcher() {
    if (document.getElementById('quickSwitcher')) return;
    const overlay = document.createElement('div');
    overlay.id = 'quickSwitcher';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:9999;display:flex;align-items:flex-start;justify-content:center;padding-top:15vh;backdrop-filter:blur(2px)';
    overlay.innerHTML = `
      <div style="background:var(--card,#fff);color:var(--foreground,#000);border:1px solid var(--border,#ccc);border-radius:12px;width:min(420px,92vw);box-shadow:0 12px 32px rgba(0,0,0,.25);overflow:hidden">
        <input id="qsInput" type="text" placeholder="Jump to page…" autocomplete="off"
          style="width:100%;padding:14px 16px;border:0;outline:0;background:transparent;color:inherit;font-size:15px;border-bottom:1px solid var(--border,#ccc)">
        <ul id="qsList" role="listbox" style="list-style:none;margin:0;padding:6px 0;max-height:50vh;overflow:auto"></ul>
      </div>`;
    document.body.appendChild(overlay);

    const items = Object.entries(NAV_LABELS).map(([page, label]) => ({ page, label }));
    let idx = 0;

    const input = overlay.querySelector('#qsInput');
    const list = overlay.querySelector('#qsList');

    function render() {
      const q = input.value.trim().toLowerCase();
      const filtered = items.filter(i => !q || i.label.toLowerCase().includes(q) || i.page.includes(q));
      if (idx >= filtered.length) idx = 0;
      list.innerHTML = filtered.map((it, i) => `
        <li role="option" data-page="${it.page}" data-i="${i}"
          style="padding:10px 16px;cursor:pointer;font-size:14px;${i === idx ? 'background:var(--accent,#eee)' : ''}">
          ${it.label}
          <span style="float:right;opacity:.5;font-size:12px">g ${Object.entries(NAV).find(([_,p])=>p===it.page)?.[0] || ''}</span>
        </li>`).join('') || '<li style="padding:14px 16px;opacity:.6;font-size:13px">No match</li>';
      list.querySelectorAll('li[data-page]').forEach(li => {
        li.addEventListener('click', () => { close(); go(li.dataset.page); });
        li.addEventListener('mousemove', () => { idx = parseInt(li.dataset.i, 10); render(); });
      });
      return filtered;
    }

    function close() { overlay.remove(); }

    input.addEventListener('input', render);
    input.addEventListener('keydown', (e) => {
      const filtered = items.filter(i => {
        const q = input.value.trim().toLowerCase();
        return !q || i.label.toLowerCase().includes(q) || i.page.includes(q);
      });
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); idx = Math.min(filtered.length - 1, idx + 1); render(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); idx = Math.max(0, idx - 1); render(); return; }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (filtered[idx]) { close(); go(filtered[idx].page); }
      }
    });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    render();
    setTimeout(() => input.focus(), 0);
  }

  function showCheatsheet() {
    if (typeof toast !== 'function') return;
    toast(
      '⌨️ <strong>g d</strong> Dashboard · <strong>g o</strong> OT · <strong>g t</strong> Timesheet · <strong>g s</strong> Schedule · <strong>g a</strong> AI · <strong>g x</strong> Settings · <strong>⌘/Ctrl K</strong> Quick switcher',
      '', { duration: 6000 }
    );
  }

  document.addEventListener('keydown', (e) => {
    // ⌘K / Ctrl+K — quick switcher (works even in inputs, like VSCode)
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      openQuickSwitcher();
      return;
    }
    if (isTyping(e.target)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    // `?` cheatsheet
    if (e.key === '?') { e.preventDefault(); showCheatsheet(); return; }

    if (gPending) {
      const page = NAV[e.key.toLowerCase()];
      gPending = false;
      clearTimeout(gTimer);
      if (page) { e.preventDefault(); go(page); }
      return;
    }
    if (e.key === 'g' || e.key === 'G') {
      gPending = true;
      gTimer = setTimeout(() => { gPending = false; }, 800);
    }
  });
})();