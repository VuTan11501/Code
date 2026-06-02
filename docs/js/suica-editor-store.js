// ═══════════════════════════════════════════════════
//  Suica Editor Store
//  Canonical state container for the manual Suica history editor.
//  Holds: range, settings, entries[] (chronological), undo/redo history.
//  Exposed as `window.SuicaEditorStore.createStore(initialState?)`.
//
//  Entry shape (canonical):
//    {
//      id:          string,                  // unique
//      datetime:    'YYYY-MM-DDTHH:mm:ss',   // JST naive ISO
//      kind:        '入' | '出' | '物販' | 'オートチャージ',
//      station:     string,
//      fare_yen:    number,                  // positive integer
//      balance_yen: number                   // recomputed by store
//    }
//
//  No external dependencies. Vanilla IIFE module, strict mode.
// ═══════════════════════════════════════════════════
window.SuicaEditorStore = (function () {
  'use strict';

  const HISTORY_CAP = 20;

  const KIND_IN        = '入';
  const KIND_OUT       = '出';
  const KIND_SHOP      = '物販';
  const KIND_AUTOCHRG  = 'オートチャージ';
  const VALID_KINDS    = [KIND_IN, KIND_OUT, KIND_SHOP, KIND_AUTOCHRG];

  // ───── helpers ───────────────────────────────────────

  function deepClone(value) {
    if (value === null || value === undefined) return value;
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  let _idCounter = 0;
  function genId() {
    _idCounter += 1;
    return 'e_' + Date.now().toString(36) + '_' + _idCounter.toString(36);
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  function ymd(date) {
    return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
  }

  function makeDatetime(dateStr, timeStr) {
    // dateStr 'YYYY-MM-DD', timeStr 'HH:mm' or 'HH:mm:ss'
    const t = (timeStr || '00:00').length === 5 ? (timeStr + ':00') : timeStr;
    return dateStr + 'T' + t;
  }

  function parseDateOnly(str) {
    // Accept 'YYYY-MM-DD' (optionally followed by 'T...'); strict calendar
    // validation with round-trip check so '2024-02-31' is rejected rather than
    // silently rolled over to March 2 by JS Date normalization.
    if (typeof str !== 'string') {
      throw new Error('SuicaEditorStore: date must be a string, got ' + typeof str);
    }
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:T|$)/.exec(str);
    if (!m) {
      throw new Error('SuicaEditorStore: invalid date "' + str + '" (expected YYYY-MM-DD)');
    }
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) {
      throw new Error('SuicaEditorStore: invalid date "' + str + '" (out of range)');
    }
    const dt = new Date(y, mo - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) {
      throw new Error('SuicaEditorStore: invalid calendar date "' + str + '"');
    }
    return dt;
  }

  // Calendar-day arithmetic: add `days` to a Date via setDate component, so we
  // never traverse a DST boundary by adding 86_400_000 ms. Returns a new Date.
  function addDays(date, days) {
    const out = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    out.setDate(out.getDate() + days);
    return out;
  }

  // Strict full-datetime validator. Accepts 'YYYY-MM-DDTHH:mm' or
  // 'YYYY-MM-DDTHH:mm:ss'. Rejects impossible calendar dates (2024-02-31)
  // and out-of-range times (25:00, 12:60). Returns the canonical
  // 'YYYY-MM-DDTHH:mm:ss' string. Throws on any defect.
  function validateDatetime(str) {
    if (typeof str !== 'string') {
      throw new Error('SuicaEditorStore: datetime must be a string, got ' + typeof str);
    }
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(str);
    if (!m) {
      throw new Error('SuicaEditorStore: datetime must match YYYY-MM-DDTHH:mm[:ss], got "' + str + '"');
    }
    // parseDateOnly does the strict calendar round-trip check.
    parseDateOnly(m[1]);
    const hh = Number(m[2]);
    const mm = Number(m[3]);
    const ss = m[4] == null ? 0 : Number(m[4]);
    if (hh < 0 || hh > 23) {
      throw new Error('SuicaEditorStore: invalid hour in datetime "' + str + '"');
    }
    if (mm < 0 || mm > 59) {
      throw new Error('SuicaEditorStore: invalid minute in datetime "' + str + '"');
    }
    if (ss < 0 || ss > 59) {
      throw new Error('SuicaEditorStore: invalid second in datetime "' + str + '"');
    }
    return m[1] + 'T' + pad2(hh) + ':' + pad2(mm) + ':' + pad2(ss);
  }
  function diffDays(base, target) {
    const b = new Date(base.getFullYear(), base.getMonth(), base.getDate());
    const t = new Date(target.getFullYear(), target.getMonth(), target.getDate());
    // Use UTC midnight projection to avoid DST hour drift influencing rounding.
    const bUTC = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
    const tUTC = Date.UTC(t.getFullYear(), t.getMonth(), t.getDate());
    return Math.round((tUTC - bUTC) / 86400000);
  }

  function dateOnly(entry) {
    return entry.datetime.slice(0, 10);
  }

  function timeOnly(entry) {
    return entry.datetime.slice(11, 19) || '00:00:00';
  }

  function compareEntries(a, b) {
    if (a.datetime < b.datetime) return -1;
    if (a.datetime > b.datetime) return 1;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  }

  function sortEntries(entries) {
    entries.sort(compareEntries);
    return entries;
  }

  function normalizeEntry(raw) {
    if (!raw || typeof raw !== 'object') {
      throw new Error('SuicaEditorStore: entry must be an object');
    }
    const kind = raw.kind;
    if (VALID_KINDS.indexOf(kind) === -1) {
      throw new Error('SuicaEditorStore: invalid kind "' + kind + '"');
    }
    if (typeof raw.datetime !== 'string') {
      throw new Error('SuicaEditorStore: entry.datetime must be a string');
    }
    const dt = validateDatetime(raw.datetime);
    const fare = Number(raw.fare_yen || 0);
    if (!Number.isFinite(fare) || fare < 0) {
      throw new Error('SuicaEditorStore: fare_yen must be a non-negative number');
    }
    const fareInt = Math.round(fare);
    // Fare invariants (kept in sync with validator):
    //   入 must have fare_yen === 0 (tap-in never debits).
    //   出 / 物販 / オートチャージ must have fare_yen > 0
    //     (tap-out debits, purchase debits, auto-charge credits — all positive).
    if (kind === KIND_IN && fareInt !== 0) {
      throw new Error('SuicaEditorStore: 入 entry must have fare_yen === 0 (got ' + fareInt + ')');
    }
    if (kind !== KIND_IN && fareInt <= 0) {
      throw new Error('SuicaEditorStore: ' + kind + ' entry must have fare_yen > 0 (got ' + fareInt + ')');
    }
    return {
      id:          raw.id || genId(),
      datetime:    dt,
      kind:        kind,
      station:     String(raw.station == null ? '' : raw.station),
      fare_yen:    fareInt,
      balance_yen: Number.isFinite(Number(raw.balance_yen)) ? Math.round(Number(raw.balance_yen)) : 0
    };
  }

  // ───── balance recompute ─────────────────────────────

  function recomputeBalances(entries, settings) {
    const initial   = Math.round(Number(settings.initial_balance) || 0);
    const threshold = Math.round(Number(settings.topup_threshold) || 0);
    const topup     = Math.round(Number(settings.topup_amount) || 0);
    let balance = initial;

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const debits = (e.kind === KIND_OUT || e.kind === KIND_SHOP);
      const credits = (e.kind === KIND_IN || e.kind === KIND_AUTOCHRG);

      if (debits) {
        // Apply auto top-up if needed before debit
        if (topup > 0 && (balance - e.fare_yen) < threshold) {
          balance += topup;
        }
        balance -= e.fare_yen;
      } else if (credits && e.kind === KIND_AUTOCHRG) {
        // explicit auto-charge entry contributes its fare_yen as credit amount
        balance += e.fare_yen;
      }
      // KIND_IN (touch-in at gate) does not move balance.
      e.balance_yen = balance;
    }
  }

  // ───── default state ─────────────────────────────────

  function defaultState() {
    return {
      range: { from: null, to: null },
      settings: {
        initial_balance: 3000,
        topup_threshold: 1000,
        topup_amount:    3000,
        timezone:        'Asia/Tokyo'
      },
      entries: []
    };
  }

  function mergeInitial(initial) {
    const s = defaultState();
    if (!initial) return s;
    if (initial.range && typeof initial.range === 'object') {
      s.range.from = initial.range.from || null;
      s.range.to   = initial.range.to   || null;
    }
    if (initial.settings && typeof initial.settings === 'object') {
      Object.assign(s.settings, initial.settings);
    }
    if (Array.isArray(initial.entries)) {
      s.entries = initial.entries.map(normalizeEntry);
      sortEntries(s.entries);
    }
    return s;
  }

  // ───── store factory ─────────────────────────────────

  function createStore(initialState) {
    const state = mergeInitial(initialState);
    recomputeBalances(state.entries, state.settings);

    const subscribers = new Set();
    const undoStack = [];
    const redoStack = [];

    function snapshot() {
      return deepClone(state);
    }

    function pushHistory() {
      undoStack.push(snapshot());
      if (undoStack.length > HISTORY_CAP) undoStack.shift();
      redoStack.length = 0;
    }

    function notify() {
      const snap = snapshot();
      subscribers.forEach(function (fn) { fn(snap); });
    }

    function commit(mutator) {
      pushHistory();
      mutator();
      recomputeBalances(state.entries, state.settings);
      notify();
    }

    // ─── public API ───

    function getState() {
      return snapshot();
    }

    function subscribe(fn) {
      if (typeof fn !== 'function') {
        throw new Error('SuicaEditorStore.subscribe requires a function');
      }
      subscribers.add(fn);
      return function unsubscribe() { subscribers.delete(fn); };
    }

    function setRange(range) {
      const from = range && range.from ? String(range.from) : null;
      const to   = range && range.to   ? String(range.to)   : null;
      commit(function () {
        state.range.from = from;
        state.range.to   = to;
      });
    }

    function setSettings(partial) {
      if (!partial || typeof partial !== 'object') return;
      commit(function () {
        const allowed = ['initial_balance', 'topup_threshold', 'topup_amount', 'timezone'];
        for (let i = 0; i < allowed.length; i++) {
          const k = allowed[i];
          if (Object.prototype.hasOwnProperty.call(partial, k)) {
            state.settings[k] = partial[k];
          }
        }
      });
    }

    function replaceEntries(entries) {
      if (!Array.isArray(entries)) {
        throw new Error('SuicaEditorStore.replaceEntries requires an array');
      }
      const normalized = entries.map(normalizeEntry);
      sortEntries(normalized);
      commit(function () {
        state.entries = normalized;
      });
    }

    function addEntry(entry) {
      const norm = normalizeEntry(entry);
      commit(function () {
        state.entries.push(norm);
        sortEntries(state.entries);
      });
      return norm.id;
    }

    function updateEntry(id, patch) {
      if (!patch || typeof patch !== 'object') return false;
      const idx = state.entries.findIndex(function (e) { return e.id === id; });
      if (idx === -1) return false;
      const next = Object.assign({}, state.entries[idx], patch, { id: id });
      const norm = normalizeEntry(next);
      commit(function () {
        state.entries[idx] = norm;
        sortEntries(state.entries);
      });
      return true;
    }

    function removeEntry(id) {
      const idx = state.entries.findIndex(function (e) { return e.id === id; });
      if (idx === -1) return false;
      commit(function () {
        state.entries.splice(idx, 1);
      });
      return true;
    }

    // ─── batch utilities ───

    // batchAddByDateRange({ from, to, daysOfWeek:[1..6], pattern:{ outTime, inTime, outStation, inStation, fare_yen } })
    function batchAddByDateRange(opts) {
      if (!opts || !opts.from || !opts.to) {
        throw new Error('batchAddByDateRange requires {from, to}');
      }
      const from = parseDateOnly(opts.from);
      const to   = parseDateOnly(opts.to);

      const dows = Array.isArray(opts.daysOfWeek) && opts.daysOfWeek.length
        ? opts.daysOfWeek.map(Number)
        : [1, 2, 3, 4, 5];

      const pattern = opts.pattern || {};
      const outTime    = pattern.outTime    || '08:30';   // depart / 出
      const inTime     = pattern.inTime     || '18:30';   // return / 入
      const outStation = pattern.outStation || '';
      const inStation  = pattern.inStation  || '';
      const fare       = Math.round(Number(pattern.fare_yen || 0));

      const created = [];
      const cur = new Date(from.getTime());
      while (cur.getTime() <= to.getTime()) {
        if (dows.indexOf(cur.getDay()) !== -1) {
          const dateStr = ymd(cur);
          // Emit 入 (tap-in) BEFORE 出 (tap-out) so the validator's
          // chronological 入 -> 出 pairing rule is satisfied. The fare is
          // attached to the 出 leg (debit happens at tap-out, per Suica).
          created.push(normalizeEntry({
            datetime: makeDatetime(dateStr, outTime),
            kind:     KIND_IN,
            station:  outStation,
            fare_yen: 0
          }));
          created.push(normalizeEntry({
            datetime: makeDatetime(dateStr, inTime),
            kind:     KIND_OUT,
            station:  inStation,
            fare_yen: fare
          }));
        }
        cur.setDate(cur.getDate() + 1);
      }

      if (created.length === 0) return [];

      commit(function () {
        for (let i = 0; i < created.length; i++) state.entries.push(created[i]);
        sortEntries(state.entries);
      });
      return created.map(function (e) { return e.id; });
    }

    // batchRemoveByDateRange({ from, to, kind? })
    function batchRemoveByDateRange(opts) {
      if (!opts || !opts.from || !opts.to) {
        throw new Error('batchRemoveByDateRange requires {from, to}');
      }
      const from = opts.from;
      const to   = opts.to;
      const kindFilter = opts.kind || null;

      const kept = state.entries.filter(function (e) {
        const d = dateOnly(e);
        const inRange = d >= from && d <= to;
        if (!inRange) return true;
        if (kindFilter && e.kind !== kindFilter) return true;
        return false;
      });

      if (kept.length === state.entries.length) return 0;
      const removed = state.entries.length - kept.length;
      commit(function () {
        state.entries = kept;
      });
      return removed;
    }

    // duplicateWeekPattern({ sourceWeekStart:'YYYY-MM-DD', targetWeekStart:'YYYY-MM-DD' })
    // Copies all entries whose date falls within [source, source+6 days] to the
    // corresponding day of the target week, preserving time-of-day and pattern.
    function duplicateWeekPattern(opts) {
      if (!opts || !opts.sourceWeekStart || !opts.targetWeekStart) {
        throw new Error('duplicateWeekPattern requires {sourceWeekStart, targetWeekStart}');
      }
      const src = parseDateOnly(opts.sourceWeekStart);
      const dst = parseDateOnly(opts.targetWeekStart);

      // Source window = [src, src+6 days] inclusive, in calendar days.
      const srcEnd = addDays(src, 6);

      const sources = state.entries.filter(function (e) {
        const d = parseDateOnly(dateOnly(e));
        return d.getTime() >= src.getTime() && d.getTime() <= srcEnd.getTime();
      });

      if (sources.length === 0) return [];

      const created = sources.map(function (e) {
        const srcDay = parseDateOnly(dateOnly(e));
        const dayOffset = diffDays(src, srcDay);     // 0..6
        const tgtDay = addDays(dst, dayOffset);      // calendar-safe, DST-immune
        return normalizeEntry({
          datetime: makeDatetime(ymd(tgtDay), timeOnly(e).slice(0, 5)),
          kind:     e.kind,
          station:  e.station,
          fare_yen: e.fare_yen
        });
      });

      commit(function () {
        for (let i = 0; i < created.length; i++) state.entries.push(created[i]);
        sortEntries(state.entries);
      });
      return created.map(function (e) { return e.id; });
    }

    // ─── undo / redo ───

    function undo() {
      if (undoStack.length === 0) return false;
      redoStack.push(snapshot());
      if (redoStack.length > HISTORY_CAP) redoStack.shift();
      const prev = undoStack.pop();
      state.range    = prev.range;
      state.settings = prev.settings;
      state.entries  = prev.entries;
      recomputeBalances(state.entries, state.settings);
      notify();
      return true;
    }

    function redo() {
      if (redoStack.length === 0) return false;
      undoStack.push(snapshot());
      if (undoStack.length > HISTORY_CAP) undoStack.shift();
      const next = redoStack.pop();
      state.range    = next.range;
      state.settings = next.settings;
      state.entries  = next.entries;
      recomputeBalances(state.entries, state.settings);
      notify();
      return true;
    }

    return {
      getState:               getState,
      subscribe:              subscribe,
      setRange:               setRange,
      setSettings:            setSettings,
      replaceEntries:         replaceEntries,
      addEntry:               addEntry,
      updateEntry:            updateEntry,
      removeEntry:            removeEntry,
      batchAddByDateRange:    batchAddByDateRange,
      batchRemoveByDateRange: batchRemoveByDateRange,
      duplicateWeekPattern:   duplicateWeekPattern,
      undo:                   undo,
      redo:                   redo
    };
  }

  return {
    createStore: createStore,
    KINDS: {
      IN:         KIND_IN,
      OUT:        KIND_OUT,
      SHOP:       KIND_SHOP,
      AUTOCHARGE: KIND_AUTOCHRG
    }
  };
})();
