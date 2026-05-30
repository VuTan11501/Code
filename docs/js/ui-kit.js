// ui-kit.js — shared UX primitives: haptics, empty-state, bottom-sheet,
// pull-to-refresh, and a tiny shared month store used to keep the OT and
// Timesheet tabs in sync. Loaded early (before page modules) so every
// screen can rely on window.UIKit.
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  // ─── Haptics ──────────────────────────────────────
  // Short vibration patterns. Android/supported browsers use the Vibration
  // API; iOS Safari/PWA has no Vibration API so we fall back to Apple's hidden
  // <input switch> trick (toggling it via a label emits a real system haptic
  // on iOS 17.4+). No-op when the user prefers reduced motion.
  const HAPTIC_PATTERNS = {
    light: 8, medium: 16, heavy: 28, select: 5,
    success: [10, 40, 12], warning: [18, 28, 18], error: [24, 32, 24, 32],
  };
  let _iosHapticLabel = null;
  function _iosHapticTick() {
    try {
      if (!_iosHapticLabel) {
        const label = document.createElement('label');
        label.setAttribute('aria-hidden', 'true');
        label.style.display = 'none';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.setAttribute('switch', '');   // Apple switch control → haptic on toggle
        label.appendChild(input);
        (document.body || document.documentElement).appendChild(label);
        _iosHapticLabel = label;
      }
      _iosHapticLabel.click();   // toggles the switch → iOS system haptic
    } catch { /* ignore */ }
  }
  let _lastHapticAt = 0;
  function haptic(kind = 'light') {
    try {
      if (reducedMotion()) return;
      const now = Date.now();
      // Dedupe rapid duplicate events from a single gesture (e.g. the global
      // press-haptic plus an explicit action-haptic fired back-to-back).
      if (now - _lastHapticAt < 40) return;
      _lastHapticAt = now;
      if ('vibrate' in navigator && typeof navigator.vibrate === 'function') {
        navigator.vibrate(HAPTIC_PATTERNS[kind] || HAPTIC_PATTERNS.light);
        return;
      }
      _iosHapticTick();   // iOS fallback
    } catch { /* ignore */ }
  }

  // Global tap feedback: a light haptic on press for common interactive
  // controls, so every button / tab / cell tap feels responsive — not just the
  // handful of spots that call haptic() explicitly. Capture + passive keeps it
  // cheap; the throttle inside haptic() prevents double-buzz with explicit calls.
  const _TAP_SEL = 'button, .btn, [role="button"], .nav-item, .tabs-trigger, '
    + '.ot-cell:not(.ot-cell-empty), .filter-chip, .switch, a.btn, label.btn, '
    + '.stat-chip, .toggle';
  document.addEventListener('pointerdown', (e) => {
    const t = (e.target && e.target.closest) ? e.target.closest(_TAP_SEL) : null;
    if (!t || t.disabled || t.getAttribute('aria-disabled') === 'true') return;
    haptic('light');
  }, { passive: true, capture: true });

  // ─── Empty state ──────────────────────────────────
  // Returns a shadcn-style empty-state HTML string. `action` (optional) is
  // { label, onclick } where onclick is a global handler expression to match
  // the existing inline-handler pattern used across page modules.
  function emptyStateHTML(opts = {}) {
    const { icon = 'inbox', title = '', sub = '', action = null } = opts;
    const iconHTML = (typeof ICON === 'function')
      ? ICON(icon, 26)
      : `<span data-icon="${esc(icon)}" data-size="26"></span>`;
    let actionHTML = '';
    if (action && action.label) {
      const onclick = action.onclick ? ` onclick="${esc(action.onclick)}"` : '';
      actionHTML = `<button type="button" class="btn sm primary uikit-empty-action"${onclick}>${esc(action.label)}</button>`;
    }
    return `<div class="uikit-empty" role="status">`
      + `<div class="uikit-empty-icon" aria-hidden="true">${iconHTML}</div>`
      + (title ? `<div class="uikit-empty-title">${esc(title)}</div>` : '')
      + (sub ? `<div class="uikit-empty-sub">${esc(sub)}</div>` : '')
      + actionHTML
      + `</div>`;
  }

  // ─── Bottom sheet ─────────────────────────────────
  // Reuses the existing .modal-overlay/.modal markup which CSS already turns
  // into a bottom sheet on mobile (align-items:flex-end + sheetUp animation).
  const _openSheets = [];
  function openSheet(opts = {}) {
    const { title = '', bodyHTML = '', node = null, actions = [], onClose = null, className = '' } = opts;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay open uikit-sheet' + (className ? ' ' + className : '');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    if (title) overlay.setAttribute('aria-label', title);

    const modal = document.createElement('div');
    modal.className = 'modal uikit-sheet-modal';

    const header = document.createElement('div');
    header.className = 'modal-header';
    header.innerHTML = `<h3>${esc(title)}</h3>`
      + `<button type="button" class="modal-close" aria-label="Close">&times;</button>`;
    modal.appendChild(header);

    const body = document.createElement('div');
    body.className = 'modal-body';
    if (node) body.appendChild(node); else body.innerHTML = bodyHTML;
    modal.appendChild(body);

    if (actions && actions.length) {
      const footer = document.createElement('div');
      footer.className = 'modal-footer uikit-sheet-footer';
      actions.forEach(a => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn ' + (a.variant || '');
        btn.textContent = a.label;
        btn.addEventListener('click', () => {
          try { a.onClick && a.onClick(); } catch (e) { console.warn('[sheet action]', e); }
          if (a.close !== false) close();
        });
        footer.appendChild(btn);
      });
      modal.appendChild(footer);
    }

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    document.body.classList.add('modal-open');

    let closed = false;
    function onKey(e) { if (e.key === 'Escape') close(); }
    function onOverlayClick(e) { if (e.target === overlay) close(); }
    function close() {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey);
      try { overlay.remove(); } catch { /* ignore */ }
      const i = _openSheets.indexOf(ctl);
      if (i >= 0) _openSheets.splice(i, 1);
      if (!_openSheets.length && !document.querySelector('.modal-overlay.open')) {
        document.body.classList.remove('modal-open');
      }
      try { onClose && onClose(); } catch { /* ignore */ }
    }

    header.querySelector('.modal-close').addEventListener('click', close);
    overlay.addEventListener('click', onOverlayClick);
    document.addEventListener('keydown', onKey);
    haptic('select');

    const ctl = { close, el: overlay, body };
    _openSheets.push(ctl);
    requestAnimationFrame(() => {
      const f = modal.querySelector('button:not(.modal-close), [href], input, select, textarea');
      try { (f || modal.querySelector('.modal-close')).focus(); } catch { /* ignore */ }
    });
    return ctl;
  }

  // ─── Shared month store (OT ↔ Timesheet sync) ─────
  let _sharedMonth = null; // { y, m } where m is 0-indexed
  function getSharedMonth() { return _sharedMonth ? { ..._sharedMonth } : null; }
  function setSharedMonth(y, m) {
    if (typeof y !== 'number' || typeof m !== 'number') return;
    _sharedMonth = { y, m };
  }

  // ─── Pull-to-refresh ──────────────────────────────
  const _refreshers = {};
  function registerRefresh(page, fn) { _refreshers[page] = fn; }
  function _activePage() {
    const el = document.querySelector('.page.active');
    return el ? el.id.replace('page-', '') : null;
  }
  function mountPullToRefresh() {
    if (window._uikitPtrMounted) return;
    window._uikitPtrMounted = true;

    const THRESH = 64;   // px of *pull* (after damping) to trigger
    const MAX = 96;
    const DAMP = 0.5;

    const ind = document.createElement('div');
    ind.className = 'uikit-ptr';
    ind.setAttribute('aria-hidden', 'true');
    ind.innerHTML = `<div class="uikit-ptr-spinner">`
      + (typeof ICON === 'function' ? ICON('refresh', 18) : '') + `</div>`;
    document.body.appendChild(ind);

    let startY = 0, pulling = false, dist = 0, armed = false;

    function eligible() {
      const page = _activePage();
      if (!page || page === 'ai' || !_refreshers[page]) return false;
      if (document.body.classList.contains('modal-open')) return false;
      return (window.scrollY || document.documentElement.scrollTop || 0) <= 0;
    }
    // Publish both the raw pull (px) and a normalised progress (0→1+ at the
    // trigger point) so CSS can drive opacity, icon rotation and scale smoothly.
    function setPull(px) {
      ind.style.setProperty('--ptr', px + 'px');
      ind.style.setProperty('--ptr-p', (px / THRESH).toFixed(3));
    }

    window.addEventListener('touchstart', (e) => {
      if (!eligible() || e.touches.length !== 1) { pulling = false; return; }
      startY = e.touches[0].clientY; pulling = true; dist = 0; armed = false;
    }, { passive: true });

    window.addEventListener('touchmove', (e) => {
      if (!pulling) return;
      dist = e.touches[0].clientY - startY;
      if (dist <= 0) {
        setPull(0);
        if (armed) { armed = false; ind.classList.remove('ready'); }
        return;
      }
      const pull = Math.min(MAX, dist * DAMP);
      setPull(pull);
      const nowArmed = pull >= THRESH;
      if (nowArmed !== armed) {
        armed = nowArmed;
        ind.classList.toggle('ready', armed);
        // Detent "click" the instant we cross the trigger point — this is the
        // tactile cue telling the user they can release now. (Android only;
        // iOS Safari has no Vibration API, so this is a silent no-op there.)
        if (armed) haptic('light');
      }
    }, { passive: true });

    window.addEventListener('touchend', async () => {
      if (!pulling) return;
      const trigger = armed;
      pulling = false;
      armed = false;
      ind.classList.remove('ready');
      if (trigger) {
        ind.classList.add('refreshing');
        setPull(52);
        haptic('success');
        try {
          const fn = _refreshers[_activePage()];
          if (fn) await fn();
        } catch (err) { console.warn('[ptr] refresh failed', err); }
        ind.classList.remove('refreshing');
      }
      setPull(0);
    }, { passive: true });
  }

  window.UIKit = {
    haptic,
    emptyStateHTML,
    openSheet,
    registerRefresh,
    mountPullToRefresh,
    getSharedMonth,
    setSharedMonth,
    reducedMotion,
  };

  if (document.readyState !== 'loading') mountPullToRefresh();
  else document.addEventListener('DOMContentLoaded', mountPullToRefresh);
})();
