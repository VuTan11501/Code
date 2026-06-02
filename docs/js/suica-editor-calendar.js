// ═══════════════════════════════════════════════════
//  Suica Editor Calendar
//  Day-grouped renderer reading from SuicaEditorStore.
//  Renders one card per date with count + total debit (出+物販).
//  Clicking a day expands the entry list with a delete action per entry.
//
//  Public API (window.SuicaEditorCalendar):
//    init({ container, store })
//    render()
//    destroy()
// ═══════════════════════════════════════════════════
;(function () {
  'use strict';

  var KIND_OUT  = '出';
  var KIND_SHOP = '物販';

  var _container = null;
  var _store     = null;
  var _unsub     = null;
  var _expanded  = Object.create(null); // { 'YYYY-MM-DD': true }
  var _clickHandler = null;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtYen(n) {
    var v = Number(n) || 0;
    return '¥' + v.toLocaleString('en-US');
  }

  function groupByDate(entries) {
    var map = Object.create(null);
    var order = [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var d = (e.datetime || '').slice(0, 10);
      if (!d) continue;
      if (!map[d]) { map[d] = []; order.push(d); }
      map[d].push(e);
    }
    order.sort();
    return { order: order, map: map };
  }

  function debitTotal(list) {
    var sum = 0;
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (e.kind === KIND_OUT || e.kind === KIND_SHOP) {
        sum += Number(e.fare_yen) || 0;
      }
    }
    return sum;
  }

  function dayHeaderHtml(date, list) {
    var isOpen  = !!_expanded[date];
    var count   = list.length;
    var debit   = debitTotal(list);
    var chevron = isOpen ? '▾' : '▸';
    return ''
      + '<button type="button" class="suica-cal-day-header" '
      +         'data-cal-toggle="' + esc(date) + '" '
      +         'aria-expanded="' + (isOpen ? 'true' : 'false') + '">'
      +   '<span class="suica-cal-chevron" aria-hidden="true">' + chevron + '</span>'
      +   '<span class="suica-cal-date">' + esc(date) + '</span>'
      +   '<span class="status-badge">' + count + ' entries</span>'
      +   '<span class="suica-cal-debit">' + esc(fmtYen(debit)) + '</span>'
      + '</button>';
  }

  function entryRowHtml(e) {
    var time = (e.datetime || '').slice(11, 16);
    return ''
      + '<li class="suica-cal-entry" data-entry-id="' + esc(e.id) + '">'
      +   '<span class="suica-cal-time">' + esc(time) + '</span>'
      +   '<span class="status-badge">' + esc(e.kind) + '</span>'
      +   '<span class="suica-cal-station">' + esc(e.station || '—') + '</span>'
      +   '<span class="suica-cal-fare">' + esc(fmtYen(e.fare_yen)) + '</span>'
      +   '<span class="suica-cal-balance">' + esc(fmtYen(e.balance_yen)) + '</span>'
      +   '<button type="button" class="btn btn-outline sm danger-outline" '
      +           'data-cal-delete="' + esc(e.id) + '" '
      +           'aria-label="Delete entry">Delete</button>'
      + '</li>';
  }

  function render() {
    if (!_container || !_store) return;
    var state   = _store.getState();
    var entries = state.entries || [];
    if (entries.length === 0) {
      _container.innerHTML = ''
        + '<div class="card border-border">'
        +   '<div class="card-body suica-cal-empty">'
        +     '<p class="muted">No entries yet. Add entries from the wizard or the table view.</p>'
        +   '</div>'
        + '</div>';
      return;
    }

    var grouped = groupByDate(entries);
    var html = '<div class="suica-cal-wrap" data-scroll-area>';
    for (var i = 0; i < grouped.order.length; i++) {
      var d    = grouped.order[i];
      var list = grouped.map[d];
      var open = !!_expanded[d];
      html += '<div class="card border-border suica-cal-day' + (open ? ' is-open' : '') + '">';
      html += dayHeaderHtml(d, list);
      if (open) {
        html += '<ul class="suica-cal-entries">';
        for (var j = 0; j < list.length; j++) html += entryRowHtml(list[j]);
        html += '</ul>';
      }
      html += '</div>';
    }
    html += '</div>';
    _container.innerHTML = html;
  }

  function onClick(ev) {
    var t = ev.target;
    if (!t || !_container.contains(t)) return;

    var toggleBtn = t.closest && t.closest('[data-cal-toggle]');
    if (toggleBtn) {
      var date = toggleBtn.getAttribute('data-cal-toggle');
      _expanded[date] = !_expanded[date];
      render();
      return;
    }

    var delBtn = t.closest && t.closest('[data-cal-delete]');
    if (delBtn) {
      var id = delBtn.getAttribute('data-cal-delete');
      if (id && _store && typeof _store.removeEntry === 'function') {
        _store.removeEntry(id);
        // store subscribe will trigger re-render
      }
      return;
    }
  }

  function renderFatal(container, msg) {
    if (!container) return;
    container.innerHTML = ''
      + '<div class="card border-border">'
      +   '<div class="card-body">'
      +     '<p class="status-badge status-failure">SuicaEditorCalendar: ' + esc(msg) + '</p>'
      +   '</div>'
      + '</div>';
  }

  function init(opts) {
    destroy();
    opts = opts || {};
    var container = opts.container || null;
    var store     = opts.store     || null;
    if (!container) return;
    if (!store) {
      renderFatal(container, 'store is required (init({container, store})).');
      return;
    }
    var required = ['getState', 'subscribe', 'removeEntry'];
    var missing  = [];
    for (var i = 0; i < required.length; i++) {
      if (typeof store[required[i]] !== 'function') missing.push(required[i]);
    }
    if (missing.length) {
      renderFatal(container, 'store is missing required method(s): ' + missing.join(', ') + '.');
      return;
    }

    _container = container;
    _store     = store;

    _clickHandler = onClick;
    _container.addEventListener('click', _clickHandler);
    _unsub = _store.subscribe(function () { render(); });
    render();
  }

  function destroy() {
    if (_unsub) { try { _unsub(); } catch (_) {} _unsub = null; }
    if (_container && _clickHandler) {
      _container.removeEventListener('click', _clickHandler);
    }
    _clickHandler = null;
    _container = null;
    _store     = null;
    _expanded  = Object.create(null);
  }

  window.SuicaEditorCalendar = {
    init:    init,
    render:  render,
    destroy: destroy
  };
})();
