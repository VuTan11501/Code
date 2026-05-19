// theme.js — Light/Dark/Auto theme controller.
// Source of truth: localStorage 'wf_dash_theme' ∈ {'auto','dark','light'}.
// data-theme attribute on <html> is always the RESOLVED theme ('dark'|'light').
// The inline bootstrap script in index.html applies the initial theme before
// CSS loads to avoid FOUC; this module handles toggling + system-pref watch.
window.Theme = (function () {
  const KEY = 'wf_dash_theme';
  const VALID = ['auto', 'dark', 'light'];

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

  return { getMode, resolve, apply, set, init, systemPref };
})();
