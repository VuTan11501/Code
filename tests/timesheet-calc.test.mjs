// Unit tests for lost-OT detection (docs/js/timesheet.js).
// These functions diagnose the original "May payslip wrong" bug — getting
// them wrong silently underreports lost yen.
import { describe, it, expect, beforeAll } from 'vitest';
import { loadDocsScripts } from './_loader.mjs';

let ctx;
beforeAll(() => {
  // ot-salary.js MUST load first because timesheet's yen helpers read window.OT_SALARY.
  ctx = loadDocsScripts(['ot-salary.js', 'timesheet.js']);
});

function getFn(name) {
  // The script-mode files declare functions as global `function _foo() {}`.
  // In a vm context these become bindings on the context's global object, so
  // we eval the name to retrieve the reference.
  // eslint-disable-next-line no-new-func
  return ctx[name];
}

describe('_hhmmToMin', () => {
  let fn;
  beforeAll(() => { fn = getFn('_hhmmToMin'); });

  it('parses standard HH:MM', () => {
    expect(fn('00:00')).toBe(0);
    expect(fn('01:30')).toBe(90);
    expect(fn('10:00')).toBe(600);
    expect(fn('236:12')).toBe(236 * 60 + 12); // monthly aggregate
  });

  it('parses negative HH:MM', () => {
    expect(fn('-01:30')).toBe(-90);
  });

  it('returns 0 for falsy/invalid', () => {
    expect(fn('')).toBe(0);
    expect(fn(null)).toBe(0);
    expect(fn(undefined)).toBe(0);
    expect(fn('abc')).toBe(0);
    expect(fn('1:2')).toBe(0); // missing zero-pad on minutes
  });
});

describe('_calcLostForDay', () => {
  let fn;
  beforeAll(() => { fn = getFn('_calcLostForDay'); });

  it('returns 0 lost when actual presence meets expected (std 8h + OT)', () => {
    // Weekday: expected = 8h std + 3h OT = 11h. Actual 11h → no shortfall.
    const r = fn({ date: '2020-01-01', otRequest: '03:00', actualWorking: '11:00' });
    expect(r.lostMin).toBe(0);
  });

  it('returns 0 within tolerance (<= 5 min)', () => {
    // 11h expected, 10:55 actual → 5min gap → within tolerance.
    const r = fn({ date: '2020-01-01', otRequest: '03:00', actualWorking: '10:55' });
    expect(r.lostMin).toBe(0);
  });

  it('flags lost minutes when presence is short by more than tolerance', () => {
    // Weekday expected 11h, actual 10h → 60min short, capped at OT request.
    const r = fn({ date: '2020-01-01', otRequest: '03:00', actualWorking: '10:00' });
    expect(r.lostMin).toBe(60);
    expect(r.sundayLostMin).toBe(0);
  });

  it('applies sunday flag to entire lost block', () => {
    // Sunday: std=0, expected = 4h OT. Actual 1h → 3h (180min) lost, all Sunday.
    const r = fn({ date: '2020-01-05', isSunday: true, otRequest: '04:00', actualWorking: '01:00' });
    expect(r.lostMin).toBe(180);
    expect(r.sundayLostMin).toBe(180);
  });

  it('computes night-lost portion from per-day midnight numbers', () => {
    // Weekday expected 11h, actual 9h → 2h lost. Requested 2h midnight, got 0 →
    // night-lost = 2h (capped by the overall lost amount).
    const r = fn({
      date: '2020-01-01', otRequest: '03:00', actualWorking: '09:00',
      otRequestMidNum: 2, actualMidNum: 0,
    });
    expect(r.lostMin).toBe(120);
    expect(r.nightLostMin).toBe(120);
  });

  it('skips future dates entirely', () => {
    const r = fn({ date: '9999-12-31', otRequest: '03:00', otNormal: '00:00' });
    expect(r.lostMin).toBe(0);
  });

  it('returns 0 if no request', () => {
    const r = fn({ date: '2020-01-01', otRequest: '00:00', otNormal: '00:00' });
    expect(r.lostMin).toBe(0);
  });
});

describe('_lostYenFromTotals', () => {
  let fn;
  beforeAll(() => { fn = getFn('_lostYenFromTotals'); });

  it('returns 0 for empty totals', () => {
    expect(fn(null)).toBe(0);
    expect(fn({ lostMin: 0, sundayLostMin: 0, nightLostMin: 0 })).toBe(0);
  });

  it('uses 125% base rate for weekday lost', () => {
    // 60 min weekday lost, no sunday, no night
    const yen = fn({ lostMin: 60, sundayLostMin: 0, nightLostMin: 0 });
    const expected = Math.floor(1 * 1563 * 1.25); // ¥1,953
    expect(yen).toBe(expected);
  });

  it('adds sunday +10% and night +25% on top of base 125%', () => {
    // 120 min lost, all sunday, 60 min night
    const yen = fn({ lostMin: 120, sundayLostMin: 120, nightLostMin: 60 });
    const base   = Math.floor(2 * 1563 * 1.25);
    const sunday = Math.floor(2 * 1563 * 0.10);
    const night  = Math.floor(1 * 1563 * 0.25);
    expect(yen).toBe(base + sunday + night);
  });
});
