// suica-wizard.js — controller for the Manual History Wizard.
// Wires SuicaEditorStore + SuicaEditorCalendar/Table + SuicaValidator and the
// batch action toolbar. Pure DOM + IIFE, no external deps.
;(function () {
  'use strict';

  var STEPS = 3;

  // ───── module state ────────────────────────────────────
  var _step      = 1;
  var _store     = null;
  var _calInited = false;
  var _tblInited = false;

  // ───── tiny helpers ────────────────────────────────────
  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function isYmd(s) {
    return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  }

  function getRangeFromInputs() {
    var from = $('manual-range-from');
    var to   = $('manual-range-to');
    return {
      from: from && from.value ? from.value : null,
      to:   to   && to.value   ? to.value   : null
    };
  }

  function rangeIsValid(r) {
    if (!r || !isYmd(r.from) || !isYmd(r.to)) return false;
    return r.from <= r.to;
  }

  // ───── step navigation ─────────────────────────────────
  function goTo(step) {
    if (step < 1 || step > STEPS) return;
    _step = step;

    var panels = document.querySelectorAll('[data-wizard-panel]');
    panels.forEach(function (p) {
      var s = parseInt(p.getAttribute('data-wizard-panel'), 10);
      p.classList.toggle('is-active', s === step);
    });

    var tabs = document.querySelectorAll('[data-wizard-step]');
    tabs.forEach(function (t) {
      var s = parseInt(t.getAttribute('data-wizard-step'), 10);
      var active = s === step;
      var done   = s < step;
      t.setAttribute('aria-selected', active ? 'true' : 'false');
      t.setAttribute('tabindex', active ? '0' : '-1');
      t.classList.toggle('is-active', active);
      t.classList.toggle('is-done', done);
    });

    if (step === 3) runValidationGate();
  }

  function tryAdvanceFromStep1() {
    var r = getRangeFromInputs();
    if (!rangeIsValid(r)) {
      flashRangeError('Choose a valid From / To date range (From must be ≤ To).');
      return false;
    }
    if (_store) _store.setRange(r);
    goTo(2);
    return true;
  }

  function flashRangeError(msg) {
    var host = $('manual-range-from');
    if (!host || !host.parentElement) { window.alert(msg); return; }
    // Reuse an inline status node beneath the range row, create on demand.
    var note = document.getElementById('manual-range-error');
    if (!note) {
      note = document.createElement('p');
      note.id = 'manual-range-error';
      note.className = 'text-xs text-[var(--red,#ef4444)] mt-1';
      var anchor = host.closest('.grid') || host.parentElement;
      anchor.parentElement.insertBefore(note, anchor.nextSibling);
    }
    note.textContent = msg;
    setTimeout(function () { if (note) note.textContent = ''; }, 4000);
  }

  // ───── store + renderers ───────────────────────────────
  function initStore() {
    if (!window.SuicaEditorStore || typeof window.SuicaEditorStore.createStore !== 'function') {
      return null;
    }
    return window.SuicaEditorStore.createStore({
      settings: {
        initial_balance: 3000,
        topup_threshold: 1000,
        topup_amount:    3000
      }
    });
  }

  function initRenderers() {
    var calEl = $('manual-editor-calendar');
    var tblEl = $('manual-editor-table');
    if (calEl && window.SuicaEditorCalendar && typeof window.SuicaEditorCalendar.init === 'function') {
      window.SuicaEditorCalendar.init({ container: calEl, store: _store });
      _calInited = true;
    }
    if (tblEl && window.SuicaEditorTable && typeof window.SuicaEditorTable.init === 'function') {
      window.SuicaEditorTable.init({ container: tblEl, store: _store });
      _tblInited = true;
    }
  }

  // ───── step 1 wiring ───────────────────────────────────
  function initStep1() {
    var from  = $('manual-range-from');
    var to    = $('manual-range-to');
    var blank = $('manual-start-blank');
    var next  = $('manual-step-next');

    function syncRange() {
      var r = getRangeFromInputs();
      if (_store && isYmd(r.from) && isYmd(r.to) && r.from <= r.to) {
        _store.setRange(r);
      }
    }

    if (from) from.addEventListener('change', syncRange);
    if (to)   to.addEventListener('change', syncRange);

    // The markup ships `manual-start-blank` as a checkbox. Honour the spec
    // intent: when the user opts in (checks the box) AND has a valid range,
    // clear any existing entries and advance to step 2.
    if (blank) {
      blank.addEventListener('change', function () {
        if (!blank.checked) return;
        var r = getRangeFromInputs();
        if (!rangeIsValid(r)) {
          flashRangeError('Pick a date range first, then check "Start blank".');
          blank.checked = false;
          return;
        }
        if (_store) {
          _store.setRange(r);
          _store.replaceEntries([]);
        }
        goTo(2);
      });
    }

    if (next) next.addEventListener('click', function () { tryAdvanceFromStep1(); });
  }

  // ───── step 2 batch actions ────────────────────────────
  function currentRange() {
    if (_store) {
      var s = _store.getState();
      if (s && s.range && isYmd(s.range.from) && isYmd(s.range.to)) return s.range;
    }
    var r = getRangeFromInputs();
    return rangeIsValid(r) ? r : null;
  }

  function promptInt(label, defVal) {
    var raw = window.prompt(label, String(defVal == null ? '' : defVal));
    if (raw == null) return null;
    var n = parseInt(String(raw).trim(), 10);
    return Number.isFinite(n) ? n : null;
  }

  function batchAdd() {
    if (!_store) return;
    var r = currentRange();
    if (!r) { flashRangeError('Set a valid date range before batch-adding.'); return; }
    var fare = promptInt('Fare per trip (yen) — applied to tap-out (出) leg:', 220);
    if (fare == null || fare <= 0) return;
    var outRaw = window.prompt('Origin station (tap-in 入):', '');
    if (outRaw == null) { flashToolbarStatus('Batch add cancelled.'); return; }
    var inRaw = window.prompt('Destination station (tap-out 出):', '');
    if (inRaw == null) { flashToolbarStatus('Batch add cancelled.'); return; }
    var outStation = String(outRaw).trim();
    var inStation  = String(inRaw).trim();
    if (!outStation || !inStation) {
      flashToolbarStatus('Batch add aborted: both origin and destination stations are required.');
      return;
    }
    var ids = _store.batchAddByDateRange({
      from: r.from,
      to:   r.to,
      daysOfWeek: [1, 2, 3, 4, 5],
      pattern: {
        outTime: '08:30',
        inTime:  '18:30',
        outStation: outStation,
        inStation:  inStation,
        fare_yen: fare
      }
    });
    flashToolbarStatus('Added ' + ids.length + ' entries across ' + r.from + ' → ' + r.to + '.');
  }

  function batchRemove() {
    if (!_store) return;
    var r = currentRange();
    if (!r) { flashRangeError('Set a valid date range before batch-removing.'); return; }
    var ok = window.confirm('Remove ALL entries between ' + r.from + ' and ' + r.to + '? This cannot be undone from the UI yet.');
    if (!ok) return;
    var n = _store.batchRemoveByDateRange({ from: r.from, to: r.to });
    flashToolbarStatus('Removed ' + n + ' entries.');
  }

  function duplicateWeek() {
    if (!_store) return;
    var src = window.prompt('Source week start (YYYY-MM-DD, any weekday is fine — copies 7 days from this date):', '');
    if (src == null) { flashToolbarStatus('Duplicate cancelled.'); return; }
    src = String(src).trim();
    if (!isYmd(src)) { flashToolbarStatus('Duplicate aborted: source must be YYYY-MM-DD.'); return; }
    var dst = window.prompt('Target week start (YYYY-MM-DD):', '');
    if (dst == null) { flashToolbarStatus('Duplicate cancelled.'); return; }
    dst = String(dst).trim();
    if (!isYmd(dst)) { flashToolbarStatus('Duplicate aborted: target must be YYYY-MM-DD.'); return; }
    var ids;
    try {
      ids = _store.duplicateWeekPattern({ sourceWeekStart: src, targetWeekStart: dst });
    } catch (err) {
      var msg = (err && err.message) ? err.message : String(err);
      flashToolbarStatus('Duplicate failed: ' + msg);
      return;
    }
    if (!ids || ids.length === 0) {
      flashToolbarStatus('Duplicate produced 0 entries (no source entries in that week).');
      return;
    }
    flashToolbarStatus('Duplicated ' + ids.length + ' entries from ' + src + ' → ' + dst + '.');
  }

  function recalcBalance() {
    if (!_store) return;
    var entries = _store.getState().entries;
    // replaceEntries triggers recomputeBalances + notify, which is the cheapest
    // public way to force a balance re-projection.
    _store.replaceEntries(entries);
    flashToolbarStatus('Recalculated balances for ' + entries.length + ' entries.');
  }

  function flashToolbarStatus(msg) {
    var host = document.getElementById('manual-toolbar-status');
    if (!host) {
      var toolbar = document.querySelector('#page-manual .toolbar') || document.querySelector('[data-wizard-panel="2"]');
      if (!toolbar) { console.info('[SuicaWizard]', msg); return; }
      host = document.createElement('p');
      host.id = 'manual-toolbar-status';
      host.className = 'text-xs text-muted-foreground mt-1';
      toolbar.appendChild(host);
    }
    host.textContent = msg;
    clearTimeout(host._t);
    host._t = setTimeout(function () { if (host) host.textContent = ''; }, 4500);
  }

  function initStep2Toolbar() {
    var add = $('manual-batch-add');
    var rm  = $('manual-batch-remove');
    var dup = $('manual-duplicate-week');
    var rc  = $('manual-recalc-balance');
    var next2 = $('manual-step-next-2');
    var back2 = $('manual-step-back');

    if (add) add.addEventListener('click', batchAdd);
    if (rm)  rm.addEventListener('click',  batchRemove);
    if (dup) dup.addEventListener('click', duplicateWeek);
    if (rc)  rc.addEventListener('click',  recalcBalance);
    if (next2) next2.addEventListener('click', function () { goTo(3); });
    if (back2) back2.addEventListener('click', function () { goTo(1); });
  }

  // ───── view toggle (calendar vs table) ─────────────────
  function initViewToggle() {
    var btnCal = $('manual-view-toggle-calendar');
    var btnTbl = $('manual-view-toggle-table');
    var elCal  = $('manual-editor-calendar');
    var elTbl  = $('manual-editor-table');
    if (!btnCal || !btnTbl || !elCal || !elTbl) return;

    function showView(view) {
      var isCal = view === 'calendar';
      elCal.classList.toggle('hidden', !isCal);
      elTbl.classList.toggle('hidden', isCal);
      btnCal.setAttribute('aria-pressed', isCal ? 'true' : 'false');
      btnTbl.setAttribute('aria-pressed', isCal ? 'false' : 'true');
      btnCal.classList.toggle('is-active', isCal);
      btnTbl.classList.toggle('is-active', !isCal);
    }

    btnCal.addEventListener('click', function () { showView('calendar'); });
    btnTbl.addEventListener('click', function () { showView('table'); });
    showView('calendar');
  }

  // ───── step 3 validation gate ──────────────────────────
  var CODE_LABELS = {
    INPUT:        'Input shape',
    BASIC_FIELDS: 'Field types & values',
    CHRONOLOGY:   'Chronology',
    PAIRING:      'Tap-in / tap-out pairing',
    RANGE:        'Date range',
    BALANCE:      'Balance arithmetic'
  };

  function runValidationGate() {
    var host = $('manual-validation-summary');
    var btn  = $('manual-export-pdf');
    if (!host) return;

    if (!_store || !window.SuicaValidator || typeof window.SuicaValidator.validateStrict !== 'function') {
      host.innerHTML = '<p class="status-badge status-failure">Validator or store unavailable — cannot evaluate.</p>';
      if (btn) { btn.disabled = true; btn.setAttribute('aria-disabled', 'true'); }
      return;
    }

    var state = _store.getState();
    var verdict = window.SuicaValidator.validateStrict(state.entries, {
      range:    state.range,
      settings: state.settings
    });

    host.innerHTML = renderVerdictHtml(verdict, state);

    if (btn) {
      var ok = !!verdict.ok;
      btn.disabled = !ok;
      btn.setAttribute('aria-disabled', ok ? 'false' : 'true');
    }
  }

  function renderVerdictHtml(verdict, state) {
    var count = state.entries.length;
    if (verdict.ok) {
      return ''
        + '<p class="status-badge status-success">All checks passed</p>'
        + '<p class="text-sm mt-2">' + count + ' entries validated across '
        + esc(state.range.from || '?') + ' → ' + esc(state.range.to || '?') + '.</p>'
        + '<p class="text-xs text-muted-foreground mt-1">Export is enabled.</p>';
    }

    var errors = verdict.errors || [];
    var grouped = (typeof window.SuicaValidator.groupErrors === 'function')
      ? window.SuicaValidator.groupErrors(errors)
      : fallbackGroup(errors);

    var html = ''
      + '<p class="status-badge status-failure">' + errors.length + ' issue'
      + (errors.length === 1 ? '' : 's') + ' found</p>'
      + '<p class="text-xs text-muted-foreground mt-1">'
      + count + ' entries checked across '
      + esc(state.range.from || '?') + ' → ' + esc(state.range.to || '?') + '.</p>'
      + '<div class="mt-3 space-y-2">';

    Object.keys(grouped).forEach(function (code) {
      var bucket = grouped[code] || [];
      var label = CODE_LABELS[code] || code;
      html += ''
        + '<details class="rounded-md border border-border bg-card/60">'
        +   '<summary class="cursor-pointer px-3 py-2 text-sm font-medium">'
        +     esc(label) + ' <span class="text-xs text-muted-foreground">(' + bucket.length + ')</span>'
        +   '</summary>'
        +   '<ul class="px-3 pb-2 pt-1 text-xs text-muted-foreground space-y-1">';
      for (var i = 0; i < Math.min(bucket.length, 25); i++) {
        var err = bucket[i] || {};
        html += '<li>• ' + esc(err.message || JSON.stringify(err)) + '</li>';
      }
      if (bucket.length > 25) {
        html += '<li class="text-muted-foreground/70">… ' + (bucket.length - 25) + ' more</li>';
      }
      html +=   '</ul>'
        + '</details>';
    });

    html += '</div><p class="text-xs text-muted-foreground mt-2">Resolve the issues above to enable export.</p>';
    return html;
  }

  function fallbackGroup(errors) {
    var out = {};
    for (var i = 0; i < errors.length; i++) {
      var e = errors[i] || {};
      var code = e.code || 'UNKNOWN';
      if (!out[code]) out[code] = [];
      out[code].push(e);
    }
    return out;
  }

  // ───── nav wiring (tabs + back/next that aren't step-specific) ─────
  function initNav() {
    var back3 = $('manual-step-back-3');
    if (back3) back3.addEventListener('click', function () { goTo(2); });

    var tabs = document.querySelectorAll('[data-wizard-step]');
    tabs.forEach(function (t) {
      t.addEventListener('click', function () {
        var s = parseInt(t.getAttribute('data-wizard-step'), 10);
        // Gate forward jumps from step 1 through the same range check.
        if (s > 1 && _step === 1) {
          if (!tryAdvanceFromStep1()) return;
          if (s === 2) return; // tryAdvanceFromStep1 already moved us there
        }
        goTo(s);
      });
    });
  }

  function initExport() {
    var btn = $('manual-export-pdf');
    if (!btn) return;
    btn.disabled = true;
    btn.setAttribute('aria-disabled', 'true');
    btn.addEventListener('click', onExportClick);
  }

  var _isExporting = false;

  function onExportClick(ev) {
    if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
    var btn = $('manual-export-pdf');
    if (_isExporting) { flashExportStatus('Export already in progress…', false); return; }
    if (!_store) { flashExportStatus('Store unavailable — cannot export.', true); return; }
    if (!window.SuicaValidator || typeof window.SuicaValidator.validateStrict !== 'function') {
      flashExportStatus('Validator unavailable — cannot export.', true);
      return;
    }

    var state = _store.getState();
    var verdict = window.SuicaValidator.validateStrict(state.entries, {
      range:    state.range,
      settings: state.settings
    });

    // Re-sync the gate so the summary + button reflect the freshest verdict.
    var host = $('manual-validation-summary');
    if (host) host.innerHTML = renderVerdictHtml(verdict, state);
    if (btn) {
      btn.disabled = !verdict.ok;
      btn.setAttribute('aria-disabled', verdict.ok ? 'false' : 'true');
    }
    if (!verdict.ok) {
      flashExportStatus('Export blocked: validation found ' + (verdict.errors || []).length + ' issue(s).', true);
      return;
    }

    var exporter = window.SuicaExport;
    if (!exporter || (typeof exporter !== 'function' && typeof exporter.exportPdf !== 'function' && typeof exporter.run !== 'function')) {
      flashExportStatus('PDF export module not loaded (window.SuicaExport missing).', true);
      return;
    }

    var payload = { entries: state.entries, range: state.range, settings: state.settings };
    try {
      var fn = (typeof exporter === 'function') ? exporter
             : (typeof exporter.exportPdf === 'function' ? exporter.exportPdf : exporter.run);
      var ret = fn(payload);
      if (ret && typeof ret.then === 'function') {
        _isExporting = true;
        if (btn) { btn.disabled = true; btn.setAttribute('aria-disabled', 'true'); }
        flashExportStatus('Export started…', false);
        var settle = function () {
          _isExporting = false;
          if (btn) { btn.disabled = false; btn.setAttribute('aria-disabled', 'false'); }
        };
        ret.then(function (result) {
            // New bridge returns {ok, historyDownloaded, pdfGenerated, message}.
            // Treat ok=false as a soft failure (still surface the message).
            if (result && typeof result === 'object' && 'ok' in result) {
              var msg = result.message || (result.ok ? 'Export complete.' : 'Export failed.');
              flashExportStatus(msg, !result.ok);
            } else {
              flashExportStatus('Export complete.', false);
            }
          })
          .catch(function (err) {
            var msg = (err && err.message) ? err.message : String(err);
            flashExportStatus('Export failed: ' + msg, true);
          })
          .then(settle, settle);
      } else if (ret && typeof ret === 'object' && 'ok' in ret) {
        var rmsg = ret.message || (ret.ok ? 'Export complete.' : 'Export failed.');
        flashExportStatus(rmsg, !ret.ok);
      } else {
        flashExportStatus('Export complete.', false);
      }
    } catch (err) {
      var msg = (err && err.message) ? err.message : String(err);
      flashExportStatus('Export failed: ' + msg, true);
    }
  }

  function flashExportStatus(msg, isError) {
    var host = document.getElementById('manual-export-status');
    if (!host) {
      var btn = $('manual-export-pdf');
      var anchor = btn ? btn.parentElement : null;
      if (!anchor) { console.info('[SuicaWizard][export]', msg); return; }
      host = document.createElement('p');
      host.id = 'manual-export-status';
      host.className = 'text-xs mt-2';
      anchor.appendChild(host);
    }
    host.textContent = msg;
    host.style.color = isError ? 'var(--red, #ef4444)' : 'var(--muted-foreground)';
    clearTimeout(host._t);
    host._t = setTimeout(function () { if (host) host.textContent = ''; }, 5000);
  }

  // ───── bootstrap ───────────────────────────────────────
  function init() {
    _store = initStore();
    if (!_store) {
      console.warn('[SuicaWizard] SuicaEditorStore unavailable; controller running in nav-only mode.');
    } else {
      initRenderers();
    }
    initNav();
    initStep1();
    initStep2Toolbar();
    initViewToggle();
    initExport();
    goTo(1);
  }

  window.SuicaWizard = {
    init: init,
    goTo: goTo,
    currentStep: function () { return _step; },
    getStore: function () { return _store; }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
