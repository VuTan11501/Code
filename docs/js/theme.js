// theme.js — Light/Dark/Auto theme controller.
// Source of truth: localStorage 'wf_dash_theme' ∈ {'auto','dark','light'}.
// data-theme attribute on <html> is always the RESOLVED theme ('dark'|'light').
// The inline bootstrap script in index.html applies the initial theme before
// CSS loads to avoid FOUC; this module handles toggling + system-pref watch.
window.Theme = (function () {
  const KEY = 'wf_dash_theme';
  const VALID = ['auto', 'dark', 'light'];
  // Track whether CloudSync has settled the first pull. Until then the local
  // theme is "tentative" and we apply transitions if remote differs.
  let _settled = false;
  let _settleTimer = null;

  function getMode() {
    const v = localStorage.getItem(KEY);
    return VALID.includes(v) ? v : 'auto';
  }

  function systemPref() {
    try {
      return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    } catch { return 'dark'; }
  }

  function resolve(mode) {
    return mode === 'auto' ? systemPref() : mode;
  }

  function apply(mode) {
    mode = VALID.includes(mode) ? mode : 'auto';
    const resolved = resolve(mode);
    document.documentElement.setAttribute('data-theme', resolved);
    const meta = document.getElementById('themeColorMeta') || document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', resolved === 'light' ? '#ffffff' : '#09090b');
    document.dispatchEvent(new CustomEvent('themechange', { detail: { mode, resolved } }));
  }

  // Apply with a 300ms CSS transition (used when CloudSync pulls a different theme
  // while first paint was tentative). Avoids hard flicker.
  function applyWithTransition(mode) {
    const prevResolved = document.documentElement.getAttribute('data-theme');
    const nextResolved = resolve(VALID.includes(mode) ? mode : 'auto');
    if (prevResolved === nextResolved) { apply(mode); return; }
    document.documentElement.classList.add('theme-transitioning');
    apply(mode);
    setTimeout(() => document.documentElement.classList.remove('theme-transitioning'), 350);
  }

  // Mark theme as settled (CloudSync has pulled or timeout elapsed).
  function markSettled() { _settled = true; if (_settleTimer) { clearTimeout(_settleTimer); _settleTimer = null; } }
  function isSettled() { return _settled; }

  function set(mode) {
    if (!VALID.includes(mode)) mode = 'auto';
    localStorage.setItem(KEY, mode);
    apply(mode);
    if (window.CloudSync && typeof window.CloudSync.markDirty === 'function') {
      try { window.CloudSync.markDirty(); } catch {}
    }
  }

  function init() {
    apply(getMode());
    // Auto-settle after 2s if CloudSync hasn't pulled yet (avoid indefinite tentative state)
    _settleTimer = setTimeout(markSettled, 2000);
    // Inject CSS rule for smooth theme transitions (avoids hard flicker on CloudSync pull)
    try {
      const style = document.createElement('style');
      style.textContent = '.theme-transitioning, .theme-transitioning * { transition: background-color 300ms ease, color 300ms ease, border-color 300ms ease !important; }';
      document.head.appendChild(style);
    } catch {}
    // React to OS theme switches when in auto mode
    try {
      const mq = window.matchMedia('(prefers-color-scheme: light)');
      const handler = () => { if (getMode() === 'auto') apply('auto'); };
      if (mq.addEventListener) mq.addEventListener('change', handler);
      else if (mq.addListener) mq.addListener(handler); // Safari < 14
    } catch {}
    // React to other tabs / CloudSync pulls
    window.addEventListener('storage', (e) => {
      if (e.key === KEY) apply(getMode());
    });
  }

  return { getMode, resolve, apply, applyWithTransition, set, init, systemPref, markSettled, isSettled };
})();
