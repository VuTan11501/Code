// ═══════════════════════════════════════════════════
//  UI TOAST — lightweight, zero-dep notification helper
//
//  Exposes window.showToast(message, opts?) for ad-hoc use anywhere.
//
//  opts = {
//    variant: 'info' | 'success' | 'warning' | 'error',  // default 'info'
//    duration: ms,                                       // default 4000, 0 = sticky
//    title: string,                                      // optional bold title above body
//    actionLabel: string, onAction: () => void,          // optional inline button
//  }
//
//  Stacks top-right (right-1, top-4 in viewport coords). Each toast is
//  click-to-dismiss. Respects prefers-reduced-motion. Aria-live=polite so
//  screen readers announce them.
// ═══════════════════════════════════════════════════
(function () {
  'use strict';

  if (window.showToast) return;  // idempotent — file may be included twice

  const HOST_ID = 'app-toast-host';
  const VARIANT_CLASSES = {
    info:    'status-info',
    success: 'status-success',
    warning: 'status-pending',
    error:   'status-failure',
  };
  const VARIANT_ICONS = {
    info:    'info',
    success: 'check',
    warning: 'alertTriangle',
    error:   'alert',
  };

  function ensureHost() {
    let host = document.getElementById(HOST_ID);
    if (!host) {
      host = document.createElement('div');
      host.id = HOST_ID;
      host.setAttribute('role', 'region');
      host.setAttribute('aria-label', 'Notifications');
      host.setAttribute('aria-live', 'polite');
      host.style.cssText = [
        'position:fixed',
        'top:1rem',
        'right:1rem',
        'z-index:1000',
        'display:flex',
        'flex-direction:column',
        'gap:.5rem',
        'max-width:min(380px, calc(100vw - 2rem))',
        'pointer-events:none',
      ].join(';');
      document.body.appendChild(host);
    }
    return host;
  }

  const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const MAX_VISIBLE = 5;
  function pruneStack(host) {
    // Toasts are children of host; non-toast helpers (badge) marked
    // data-toast-overflow get skipped. Keep newest MAX_VISIBLE; collapse the
    // rest into a small "+N earlier" pill at the top so the user knows they
    // were missed.
    const cards = Array.from(host.children).filter((c) => !c.dataset.toastOverflow);
    const excess = cards.length - MAX_VISIBLE;
    let badge = host.querySelector('[data-toast-overflow]');
    if (excess <= 0) { if (badge) badge.remove(); return; }
    // Dismiss the oldest ones immediately, keep the visual + count summary.
    cards.slice(0, excess).forEach((c) => { if (c.parentNode) c.parentNode.removeChild(c); });
    if (!badge) {
      badge = document.createElement('div');
      badge.dataset.toastOverflow = '1';
      badge.style.cssText = 'pointer-events:auto;padding:.25rem .5rem;border-radius:9999px;background:var(--muted, #1f2937);color:var(--muted-foreground, #9ca3af);font-size:.6875rem;font-weight:500;align-self:flex-end;cursor:pointer;opacity:.85;';
      badge.title = 'Dismiss';
      badge.addEventListener('click', () => badge.remove());
      host.insertBefore(badge, host.firstChild);
    }
    const prev = +(badge.dataset.count || 0);
    const next = prev + excess;
    badge.dataset.count = String(next);
    badge.textContent = `+${next} earlier notifications dismissed`;
  }

  function show(message, opts) {
    opts = opts || {};
    const variant = opts.variant || 'info';
    const duration = opts.duration === 0 ? 0 : (opts.duration || 4000);
    const host = ensureHost();

    const card = document.createElement('div');
    card.className = 'card';
    card.setAttribute('role', 'status');
    card.style.cssText = [
      'pointer-events:auto',
      'cursor:pointer',
      'padding:.625rem .75rem',
      'box-shadow:0 4px 12px rgba(0,0,0,.12)',
      'transform:translateY(-8px)',
      'opacity:0',
      'transition:' + (reduceMotion() ? 'none' : 'opacity .18s ease-out, transform .18s ease-out'),
    ].join(';');

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:flex-start;gap:.5rem;';

    const badge = document.createElement('span');
    badge.className = 'status-badge ' + (VARIANT_CLASSES[variant] || VARIANT_CLASSES.info);
    badge.style.cssText = 'flex:none;display:inline-flex;align-items:center;gap:.25rem;';
    badge.innerHTML = `<span data-icon="${VARIANT_ICONS[variant] || 'info'}" data-size="12"></span>`;
    row.appendChild(badge);

    const body = document.createElement('div');
    body.style.cssText = 'flex:1;min-width:0;font-size:.8125rem;line-height:1.35;';
    if (opts.title) {
      const t = document.createElement('div');
      t.textContent = opts.title;
      t.style.cssText = 'font-weight:600;margin-bottom:.125rem;';
      body.appendChild(t);
    }
    const msg = document.createElement('div');
    msg.textContent = message;
    msg.style.cssText = 'color:var(--muted-foreground, #6b7280);word-wrap:break-word;';
    body.appendChild(msg);
    row.appendChild(body);

    if (opts.actionLabel && typeof opts.onAction === 'function') {
      const action = document.createElement('button');
      action.type = 'button';
      action.className = 'btn btn-ghost sm';
      action.style.cssText = 'flex:none;font-size:.75rem;';
      action.textContent = opts.actionLabel;
      action.addEventListener('click', (e) => {
        e.stopPropagation();
        try { opts.onAction(); } catch (_) {}
        dismiss();
      });
      row.appendChild(action);
    }

    card.appendChild(row);
    host.appendChild(card);
    if (window.refreshIcons) window.refreshIcons(card);
    pruneStack(host);

    // Animate in
    requestAnimationFrame(() => {
      card.style.opacity = '1';
      card.style.transform = 'translateY(0)';
    });

    let dismissed = false;
    let timer = null;
    function dismiss() {
      if (dismissed) return;
      dismissed = true;
      if (timer) clearTimeout(timer);
      card.style.opacity = '0';
      card.style.transform = 'translateY(-8px)';
      setTimeout(() => { if (card.parentNode) card.parentNode.removeChild(card); }, reduceMotion() ? 0 : 180);
    }
    function update(newMessage, newOpts) {
      if (dismissed) return;
      newOpts = newOpts || {};
      if (typeof newMessage === 'string') msg.textContent = newMessage;
      if (newOpts.title) {
        let t = body.firstChild && body.firstChild !== msg ? body.firstChild : null;
        if (!t) {
          t = document.createElement('div');
          t.style.cssText = 'font-weight:600;margin-bottom:.125rem;';
          body.insertBefore(t, msg);
        }
        t.textContent = newOpts.title;
      }
      if (newOpts.variant && VARIANT_CLASSES[newOpts.variant]) {
        badge.className = 'status-badge ' + VARIANT_CLASSES[newOpts.variant];
        badge.innerHTML = `<span data-icon="${VARIANT_ICONS[newOpts.variant] || 'info'}" data-size="12"></span>`;
        if (window.refreshIcons) window.refreshIcons(badge);
      }
      if (typeof newOpts.duration === 'number') {
        if (timer) clearTimeout(timer);
        if (newOpts.duration > 0) timer = setTimeout(dismiss, newOpts.duration);
      }
    }
    card.addEventListener('click', dismiss);
    if (duration > 0) timer = setTimeout(dismiss, duration);

    return { dismiss, update };
  }

  window.showToast = show;
  // New rich-API exposed as `window.Toast` to avoid clobbering the legacy
  // `window.toast(msg, cls)` function declared in app.js (which 100+ callsites
  // and the smoke test still rely on).
  window.Toast = {
    info:    (m, o) => show(m, Object.assign({ variant: 'info' }, o)),
    success: (m, o) => show(m, Object.assign({ variant: 'success' }, o)),
    warning: (m, o) => show(m, Object.assign({ variant: 'warning' }, o)),
    error:   (m, o) => show(m, Object.assign({ variant: 'error', duration: 6000 }, o)),
  };
})();
