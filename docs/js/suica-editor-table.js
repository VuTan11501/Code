// ═══════════════════════════════════════════════════
//  Suica Editor Table
//  Tabular renderer reading from SuicaEditorStore.
//  Columns: datetime / kind / station / fare / balance / actions.
//  Inline editing for datetime / station / fare (kind via <select>).
//  Save via store.updateEntry(id, patch); delete via store.removeEntry(id).
//
//  Public API (window.SuicaEditorTable):
//    init({ container, store })
//    render()
//    destroy()
// ═══════════════════════════════════════════════════
;(function () {
  'use strict';

  var KINDS = ['入', '出', '物販', 'オートチャージ'];

  var _container = null;
  var _store     = null;
  var _unsub     = null;
  var _editingId = null;     // id of row currently in edit mode
  var _clickHandler = null;
  var _submitHandler = null;

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

  // 'YYYY-MM-DDTHH:mm:ss' -> 'YYYY-MM-DDTHH:mm' (HTML datetime-local format).
  function toLocalInput(dt) {
    if (typeof dt !== 'string') return '';
    return dt.length >= 16 ? dt.slice(0, 16) : dt;
  }

  function viewRowHtml(e) {
    var dtDisplay = (e.datetime || '').replace('T', ' ');
    return ''
      + '<tr data-row-id="' + esc(e.id) + '" class="suica-tbl-row">'
      +   '<td class="suica-tbl-dt">' + esc(dtDisplay) + '</td>'
      +   '<td><span class="status-badge">' + esc(e.kind) + '</span></td>'
      +   '<td>' + esc(e.station || '—') + '</td>'
      +   '<td class="suica-tbl-num">' + esc(fmtYen(e.fare_yen)) + '</td>'
      +   '<td class="suica-tbl-num">' + esc(fmtYen(e.balance_yen)) + '</td>'
      +   '<td class="suica-tbl-actions">'
      +     '<button type="button" class="btn btn-outline sm" data-tbl-edit="' + esc(e.id) + '">Edit</button> '
      +     '<button type="button" class="btn btn-outline sm danger-outline" data-tbl-delete="' + esc(e.id) + '">Delete</button>'
      +   '</td>'
      + '</tr>';
  }

  function editRowHtml(e) {
    var kindOpts = KINDS.map(function (k) {
      var sel = k === e.kind ? ' selected' : '';
      return '<option value="' + esc(k) + '"' + sel + '>' + esc(k) + '</option>';
    }).join('');

    return ''
      + '<tr data-row-id="' + esc(e.id) + '" class="suica-tbl-row is-editing">'
      +   '<td colspan="6">'
      +     '<form class="suica-tbl-edit-form" data-tbl-form="' + esc(e.id) + '">'
      +       '<label class="suica-tbl-field">'
      +         '<span>Datetime</span>'
      +         '<input type="datetime-local" class="input" name="datetime" step="60" '
      +                'value="' + esc(toLocalInput(e.datetime)) + '" required>'
      +       '</label>'
      +       '<label class="suica-tbl-field">'
      +         '<span>Kind</span>'
      +         '<select class="input" name="kind">' + kindOpts + '</select>'
      +       '</label>'
      +       '<label class="suica-tbl-field">'
      +         '<span>Station</span>'
      +         '<input type="text" class="input" name="station" '
      +                'value="' + esc(e.station || '') + '">'
      +       '</label>'
      +       '<label class="suica-tbl-field">'
      +         '<span>Fare (¥)</span>'
      +         '<input type="number" class="input" name="fare_yen" min="0" step="1" '
      +                'value="' + esc(String(e.fare_yen || 0)) + '">'
      +       '</label>'
      +       '<div class="suica-tbl-edit-actions">'
      +         '<button type="submit" class="btn primary sm">Save</button> '
      +         '<button type="button" class="btn btn-outline sm" data-tbl-cancel="' + esc(e.id) + '">Cancel</button>'
      +       '</div>'
      +       '<div class="suica-tbl-edit-error" data-tbl-error hidden></div>'
      +     '</form>'
      +   '</td>'
      + '</tr>';
  }

  function render() {
    if (!_container || !_store) return;
    var state   = _store.getState();
    var entries = state.entries || [];

    if (entries.length === 0) {
      _container.innerHTML = ''
        + '<div class="card border-border">'
        +   '<div class="card-body suica-tbl-empty">'
        +     '<p class="muted">No entries yet. Add entries from the wizard or the calendar view.</p>'
        +   '</div>'
        + '</div>';
      return;
    }

    var rowsHtml = '';
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      rowsHtml += (e.id === _editingId) ? editRowHtml(e) : viewRowHtml(e);
    }

    _container.innerHTML = ''
      + '<div class="suica-tbl-wrap" data-scroll-area>'
      +   '<table class="suica-tbl">'
      +     '<thead><tr>'
      +       '<th>Datetime</th><th>Kind</th><th>Station</th>'
      +       '<th class="suica-tbl-num">Fare</th>'
      +       '<th class="suica-tbl-num">Balance</th>'
      +       '<th class="suica-tbl-actions">Actions</th>'
      +     '</tr></thead>'
      +     '<tbody>' + rowsHtml + '</tbody>'
      +   '</table>'
      + '</div>';
  }

  function showError(formEl, msg) {
    if (!formEl) return;
    var box = formEl.querySelector('[data-tbl-error]');
    if (!box) return;
    if (msg) {
      box.textContent = msg;
      box.hidden = false;
    } else {
      box.textContent = '';
      box.hidden = true;
    }
  }

  function onClick(ev) {
    var t = ev.target;
    if (!t || !_container.contains(t)) return;

    var editBtn = t.closest && t.closest('[data-tbl-edit]');
    if (editBtn) {
      _editingId = editBtn.getAttribute('data-tbl-edit');
      render();
      return;
    }
    var cancelBtn = t.closest && t.closest('[data-tbl-cancel]');
    if (cancelBtn) {
      _editingId = null;
      render();
      return;
    }
    var delBtn = t.closest && t.closest('[data-tbl-delete]');
    if (delBtn) {
      var id = delBtn.getAttribute('data-tbl-delete');
      if (id && _store && typeof _store.removeEntry === 'function') {
        if (_editingId === id) _editingId = null;
        _store.removeEntry(id);
      }
      return;
    }
  }

  function onSubmit(ev) {
    var form = ev.target;
    if (!form || !form.matches || !form.matches('[data-tbl-form]')) return;
    ev.preventDefault();
    if (!_store || typeof _store.updateEntry !== 'function') return;

    var id   = form.getAttribute('data-tbl-form');
    var data = new FormData(form);

    // datetime-local gives 'YYYY-MM-DDTHH:mm'; store accepts that (validator
    // canonicalizes to :00 seconds).
    var dt      = (data.get('datetime') || '').toString();
    var kind    = (data.get('kind') || '').toString();
    var station = (data.get('station') || '').toString();
    var fareRaw = (data.get('fare_yen') || '').toString().trim();

    // Strict fare parsing: plain decimal integer text only.
    // Rejects '', '1e2', '1.5', '-1', '+1', '01', '0x10', ' 1 ', 'abc'.
    // Number()/Number.isInteger would still accept '1e2' (=== 100), so we
    // gate on a digits-only regex BEFORE numeric conversion.
    if (fareRaw === '') {
      showError(form, 'Fare is required.');
      return;
    }
    if (!/^(0|[1-9]\d*)$/.test(fareRaw)) {
      showError(form, 'Fare must be a plain non-negative integer (digits only — no decimals, signs, or scientific notation).');
      return;
    }
    var fare = Number(fareRaw);
    if (!Number.isFinite(fare) || !Number.isInteger(fare) || fare < 0) {
      showError(form, 'Fare must be a non-negative integer.');
      return;
    }

    var patch = {
      datetime: dt.length === 16 ? (dt + ':00') : dt,
      kind:     kind,
      station:  station,
      fare_yen: fare
    };

    try {
      var ok = _store.updateEntry(id, patch);
      if (!ok) {
        showError(form, 'Entry not found.');
        return;
      }
      _editingId = null;
      // store subscribe triggers re-render
    } catch (err) {
      showError(form, (err && err.message) ? err.message : String(err));
    }
  }

  function renderFatal(container, msg) {
    if (!container) return;
    container.innerHTML = ''
      + '<div class="card border-border">'
      +   '<div class="card-body">'
      +     '<p class="status-badge status-failure">SuicaEditorTable: ' + esc(msg) + '</p>'
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
    var required = ['getState', 'subscribe', 'removeEntry', 'updateEntry'];
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

    _clickHandler  = onClick;
    _submitHandler = onSubmit;
    _container.addEventListener('click', _clickHandler);
    _container.addEventListener('submit', _submitHandler);
    _unsub = _store.subscribe(function () { render(); });
    render();
  }

  function destroy() {
    if (_unsub) { try { _unsub(); } catch (_) {} _unsub = null; }
    if (_container) {
      if (_clickHandler)  _container.removeEventListener('click',  _clickHandler);
      if (_submitHandler) _container.removeEventListener('submit', _submitHandler);
    }
    _clickHandler  = null;
    _submitHandler = null;
    _container = null;
    _store     = null;
    _editingId = null;
  }

  window.SuicaEditorTable = {
    init:    init,
    render:  render,
    destroy: destroy
  };
})();
