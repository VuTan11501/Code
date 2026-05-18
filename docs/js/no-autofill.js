// ═══════════════════════════════════════════════════
//  DISABLE BROWSER AUTOFILL / AUTOCOMPLETE / SPELLCHECK
//  Applied globally to all inputs, selects, textareas, forms.
//  Covers both static markup and dynamically rendered nodes.
// ═══════════════════════════════════════════════════
(function () {
  const FIELD_SELECTOR = 'input, select, textarea';

  function disable(el) {
    if (!el || el.dataset.noAutofillApplied === '1') return;
    const tag = el.tagName;
    // Random token defeats Chrome heuristic that ignores autocomplete="off" on logins.
    const token = 'off-' + Math.random().toString(36).slice(2, 8);
    el.setAttribute('autocomplete', token);
    el.setAttribute('autocorrect', 'off');
    el.setAttribute('autocapitalize', 'off');
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      el.setAttribute('spellcheck', 'false');
    }
    el.dataset.noAutofillApplied = '1';
  }

  function disableAllIn(root) {
    if (!root) return;
    if (root.matches && root.matches(FIELD_SELECTOR)) disable(root);
    if (root.querySelectorAll) {
      root.querySelectorAll(FIELD_SELECTOR).forEach(disable);
      root.querySelectorAll('form').forEach(f => f.setAttribute('autocomplete', 'off'));
    }
  }

  function init() {
    disableAllIn(document);
    const mo = new MutationObserver(muts => {
      for (const m of muts) {
        m.addedNodes.forEach(n => {
          if (n.nodeType === 1) disableAllIn(n);
        });
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
