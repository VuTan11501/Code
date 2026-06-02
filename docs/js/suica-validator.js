// ═══════════════════════════════════════════════════
//  Suica Validator
//  Strict, pure validation for the manual Suica history editor.
//  Mirrors the balance-recompute semantics of suica-editor-store.js so the
//  same rules govern both authoring and validation. No DOM access.
//
//  Public API (window.SuicaValidator):
//    validateStrict(entries, ctx) -> { ok: boolean, errors: Error[] }
//    groupErrors(errors)          -> { [code]: Error[] }
//
//  Error shape:
//    { code, message, entryId?, datetime?, kind? }
//
//  ctx shape:
//    {
//      settings: { initial_balance, topup_threshold, topup_amount },
//      range:    { from: 'YYYY-MM-DD'|null, to: 'YYYY-MM-DD'|null }
//    }
//
//  Codes:
//    BASIC_FIELDS, CHRONOLOGY, PAIRING, BALANCE, RANGE, INPUT
// ═══════════════════════════════════════════════════
window.SuicaValidator = (function () {
  'use strict';

  const KIND_IN       = '入';
  const KIND_OUT      = '出';
  const KIND_SHOP     = '物販';
  const KIND_AUTOCHRG = 'オートチャージ';
  const VALID_KINDS   = [KIND_IN, KIND_OUT, KIND_SHOP, KIND_AUTOCHRG];

  const DT_RE   = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  function isObject(v) {
    return v !== null && typeof v === 'object';
  }

  // Strict integer coercion: accepts only finite values that are already
  // exact integers. Numeric strings like "100" are accepted; "100.5", "1e-1",
  // NaN, Infinity, booleans, objects → null. Prevents silent rounding of
  // decimal fares/balances.
  function asInt(v) {
    if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
    return n;
  }

  function dateOnly(dt) {
    return typeof dt === 'string' ? dt.slice(0, 10) : '';
  }

  // Canonicalize to YYYY-MM-DDTHH:mm:ss so two equal instants written at
  // different precisions ("10:00" vs "10:00:00") compare equal lexically.
  // Caller must have already validated format; we only pad seconds.
  function canonDt(s) {
    if (typeof s !== 'string') return '';
    return s.length === 16 ? (s + ':00') : s;
  }

  // Strict calendar+clock check. `s` already matched DT_RE / DATE_RE.
  // Verifies the date components round-trip through `new Date(...)` so
  // values like 2024-02-30 or 2024-13-01 are rejected, and rejects
  // hour/minute/second outside 00:00:00..23:59:59.
  function isRealDateTime(s) {
    if (typeof s !== 'string') return false;
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
    if (!m) return false;
    const y  = Number(m[1]);
    const mo = Number(m[2]);
    const d  = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
    const dt = new Date(y, mo - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return false;
    if (m[4] !== undefined) {
      const hh = Number(m[4]);
      const mm = Number(m[5]);
      const ss = m[6] !== undefined ? Number(m[6]) : 0;
      if (hh < 0 || hh > 23) return false;
      if (mm < 0 || mm > 59) return false;
      if (ss < 0 || ss > 59) return false;
    }
    return true;
  }

  // ───── basic field checks ────────────────────────────

  function checkBasicFields(entries, errors) {
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (!isObject(e)) {
        errors.push({
          code:    'BASIC_FIELDS',
          message: 'entry #' + i + ' is not an object'
        });
        continue;
      }
      const eid = e.id;

      if (VALID_KINDS.indexOf(e.kind) === -1) {
        errors.push({
          code:    'BASIC_FIELDS',
          entryId: eid,
          kind:    e.kind,
          message: 'invalid kind "' + e.kind + '" at #' + i +
                   ' (expected one of 入/出/物販/オートチャージ)'
        });
        // Skip kind-dependent checks; datetime + fare still validated below.
      }

      if (typeof e.datetime !== 'string' || !DT_RE.test(e.datetime) || !isRealDateTime(e.datetime)) {
        errors.push({
          code:     'BASIC_FIELDS',
          entryId:  eid,
          datetime: e.datetime,
          kind:     e.kind,
          message:  'entry #' + i + ' datetime must be a real YYYY-MM-DDTHH:mm[:ss]'
        });
      }

      const fare = asInt(e.fare_yen);
      if (fare === null || fare < 0) {
        errors.push({
          code:    'BASIC_FIELDS',
          entryId: eid,
          kind:    e.kind,
          message: 'entry #' + i + ' fare_yen must be a non-negative integer'
        });
      } else {
        // Per-kind fare rules.
        if (e.kind === KIND_IN && fare !== 0) {
          errors.push({
            code:    'BASIC_FIELDS',
            entryId: eid,
            kind:    e.kind,
            message: 'entry #' + i + ' (入) fare_yen must be 0 (touch-in is free)'
          });
        }
        if ((e.kind === KIND_OUT || e.kind === KIND_SHOP || e.kind === KIND_AUTOCHRG) && fare <= 0) {
          errors.push({
            code:    'BASIC_FIELDS',
            entryId: eid,
            kind:    e.kind,
            message: 'entry #' + i + ' (' + e.kind + ') fare_yen must be > 0'
          });
        }
      }

      // station required for gate taps
      if (e.kind === KIND_IN || e.kind === KIND_OUT) {
        const st = e.station;
        if (typeof st !== 'string' || st.trim() === '') {
          errors.push({
            code:    'BASIC_FIELDS',
            entryId: eid,
            kind:    e.kind,
            message: 'entry #' + i + ' (' + e.kind + ') requires a non-empty station'
          });
        }
      }

      // balance_yen, when present, must be a strict integer (store always
      // stores integers; a decimal here signals data corruption).
      if (e.balance_yen !== undefined && e.balance_yen !== null && asInt(e.balance_yen) === null) {
        errors.push({
          code:    'BASIC_FIELDS',
          entryId: eid,
          kind:    e.kind,
          message: 'entry #' + i + ' balance_yen must be an integer (got ' + e.balance_yen + ')'
        });
      }
    }
  }

  // ───── chronology ────────────────────────────────────

  function checkChronology(entries) {
    const out = [];
    for (let i = 1; i < entries.length; i++) {
      const prev = entries[i - 1];
      const cur  = entries[i];
      if (!isObject(prev) || !isObject(cur)) continue;
      if (typeof prev.datetime !== 'string' || typeof cur.datetime !== 'string') continue;
      const pDt = canonDt(prev.datetime);
      const cDt = canonDt(cur.datetime);
      if (cDt < pDt) {
        out.push({
          code:     'CHRONOLOGY',
          entryId:  cur.id,
          datetime: cur.datetime,
          kind:     cur.kind,
          message:  'entry #' + i + ' (' + cur.datetime + ') precedes previous (' + prev.datetime + ')'
        });
      }
    }
    return out;
  }

  // ───── pairing (入 opens, 出 closes; 物販/オートチャージ standalone) ─

  function checkPairing(entries, errors) {
    let openIdx = -1;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (!isObject(e)) continue;

      if (e.kind === KIND_IN) {
        if (openIdx !== -1) {
          const prev = entries[openIdx];
          errors.push({
            code:     'PAIRING',
            entryId:  e.id,
            datetime: e.datetime,
            kind:     e.kind,
            message:  '入 at #' + i + ' opens a new trip while previous 入 at #' +
                      openIdx + ' (' + (prev && prev.datetime) + ') is still open'
          });
        }
        openIdx = i;
      } else if (e.kind === KIND_OUT) {
        if (openIdx === -1) {
          errors.push({
            code:     'PAIRING',
            entryId:  e.id,
            datetime: e.datetime,
            kind:     e.kind,
            message:  'orphan 出 at #' + i + ' has no preceding 入'
          });
        } else {
          openIdx = -1;
        }
      }
      // 物販 / オートチャージ don't affect pairing state.
    }
    if (openIdx !== -1) {
      const e = entries[openIdx];
      errors.push({
        code:     'PAIRING',
        entryId:  e.id,
        datetime: e.datetime,
        kind:     e.kind,
        message:  'dangling 入 at #' + openIdx + ' (' + e.datetime + ') has no matching 出'
      });
    }
  }

  // ───── range ─────────────────────────────────────────

  function checkRange(entries, range, errors) {
    if (!range) return;
    const from = (typeof range.from === 'string' && DATE_RE.test(range.from) && isRealDateTime(range.from))
      ? range.from : null;
    const to   = (typeof range.to   === 'string' && DATE_RE.test(range.to)   && isRealDateTime(range.to))
      ? range.to   : null;
    if (!from && !to) return;

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (!isObject(e) || typeof e.datetime !== 'string') continue;
      if (!DT_RE.test(e.datetime) || !isRealDateTime(e.datetime)) continue;
      const d = dateOnly(e.datetime);
      if (from && d < from) {
        errors.push({
          code:     'RANGE',
          entryId:  e.id,
          datetime: e.datetime,
          kind:     e.kind,
          message:  'entry #' + i + ' date ' + d + ' precedes range.from ' + from
        });
      }
      if (to && d > to) {
        errors.push({
          code:     'RANGE',
          entryId:  e.id,
          datetime: e.datetime,
          kind:     e.kind,
          message:  'entry #' + i + ' date ' + d + ' exceeds range.to ' + to
        });
      }
    }
  }

  // ───── balance (mirrors store.recomputeBalances) ─────

  // Mirror suica-editor-store.js recomputeBalances exactly: each setting is
  // coerced via `Math.round(Number(x) || 0)` so non-integer settings round
  // (rather than fall back to 0) and the validator agrees with the store on
  // expected balances. asInt's strict-integer rule is intentionally NOT used
  // here; that strictness applies only to per-entry fare_yen / balance_yen.
  function coerceSetting(v) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n) : 0;
  }

  function checkBalance(entries, settings, errors) {
    const s = settings || {};
    const initial   = coerceSetting(s.initial_balance);
    const threshold = coerceSetting(s.topup_threshold);
    const topup     = coerceSetting(s.topup_amount);

    let balance = initial;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (!isObject(e) || VALID_KINDS.indexOf(e.kind) === -1) continue;
      const fare = asInt(e.fare_yen);
      if (fare === null || fare < 0) continue;  // BASIC_FIELDS already flagged

      if (e.kind === KIND_OUT || e.kind === KIND_SHOP) {
        if (topup > 0 && (balance - fare) < threshold) {
          balance += topup;
        }
        balance -= fare;
      } else if (e.kind === KIND_AUTOCHRG) {
        balance += fare;
      }
      // KIND_IN: no balance change.

      const stored = asInt(e.balance_yen);
      if (stored !== null && stored !== balance) {
        errors.push({
          code:     'BALANCE',
          entryId:  e.id,
          datetime: e.datetime,
          kind:     e.kind,
          message:  'entry #' + i + ' balance mismatch: stored=' + stored +
                    ' expected=' + balance
        });
      }
    }
  }

  // ───── public API ────────────────────────────────────

  function validateStrict(entries, ctx) {
    const context = ctx || {};
    if (!Array.isArray(entries)) {
      return {
        ok: false,
        errors: [{ code: 'INPUT', message: 'entries must be an array' }]
      };
    }

    // Chronology runs first so its errors appear at the head per spec.
    const chronoErrors = checkChronology(entries);

    const other = [];
    checkBasicFields(entries, other);
    checkPairing(entries, other);
    checkRange(entries, context.range || null, other);
    checkBalance(entries, context.settings || null, other);

    const errors = chronoErrors.concat(other);
    return { ok: errors.length === 0, errors: errors };
  }

  function groupErrors(errors) {
    const out = {};
    if (!Array.isArray(errors)) return out;
    for (let i = 0; i < errors.length; i++) {
      const err = errors[i];
      if (!err || typeof err.code !== 'string') continue;
      if (!out[err.code]) out[err.code] = [];
      out[err.code].push(err);
    }
    return out;
  }

  return {
    validateStrict: validateStrict,
    groupErrors:    groupErrors,
    KINDS: {
      IN:         KIND_IN,
      OUT:        KIND_OUT,
      SHOP:       KIND_SHOP,
      AUTOCHARGE: KIND_AUTOCHRG
    },
    CODES: {
      BASIC_FIELDS: 'BASIC_FIELDS',
      CHRONOLOGY:   'CHRONOLOGY',
      PAIRING:      'PAIRING',
      BALANCE:      'BALANCE',
      RANGE:        'RANGE',
      INPUT:        'INPUT'
    }
  };
})();
