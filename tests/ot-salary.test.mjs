// Unit tests for the OT salary engine (docs/js/ot-salary.js).
// These pure functions drive the lost-OT detection and take-home estimates,
// so regressions here cause user-visible salary mistakes.
import { describe, it, expect, beforeAll } from 'vitest';
import { loadDocsScripts } from './_loader.mjs';

let OT;
beforeAll(() => {
  const ctx = loadDocsScripts(['ot-salary.js']);
  OT = ctx.window.OT_SALARY;
  if (!OT) throw new Error('OT_SALARY not exported');
});

describe('splitOtByDay', () => {
  it('returns one segment for a single-day weekday OT', () => {
    // 2026-05-07 is a Thursday
    const segs = OT.splitOtByDay({ date: '2026-05-07', start: '18:00', end: '21:00', hours: 3 });
    expect(segs).toHaveLength(1);
    expect(segs[0].minutes).toBe(180);
    expect(segs[0].nightMinutes).toBe(0);
    expect(segs[0].startDow).toBe(4); // Thu
  });

  it('splits across midnight into two calendar-day segments', () => {
    // 2026-05-07 21:00 → 2026-05-08 02:00 = 5h, with 22:00-02:00 = 4h night
    const segs = OT.splitOtByDay({ date: '2026-05-07', start: '21:00', end: '02:00', hours: 5 });
    expect(segs).toHaveLength(2);
    expect(segs[0].date).toBe('2026-05-07');
    expect(segs[1].date).toBe('2026-05-08');
    const totalMin = segs.reduce((a, s) => a + s.minutes, 0);
    const totalNight = segs.reduce((a, s) => a + s.nightMinutes, 0);
    expect(totalMin).toBe(300);
    expect(totalNight).toBe(240); // 22-24 (120) + 00-02 (120)
    // Sunday rate is keyed off the START day (Thu)
    expect(segs[0].startDow).toBe(4);
    expect(segs[1].startDow).toBe(4);
  });

  it('clamps paid minutes to ot.hours when present (break deduction)', () => {
    // Raw 3h span but only 2h paid (break deducted in DokoKin)
    const segs = OT.splitOtByDay({ date: '2026-05-07', start: '18:00', end: '21:00', hours: 2 });
    expect(segs[0].minutes).toBe(120);
  });

  it('returns [] for malformed input', () => {
    expect(OT.splitOtByDay(null)).toEqual([]);
    expect(OT.splitOtByDay({ date: '2026-05-07' })).toEqual([]);
  });
});

describe('calcOtBreakdown', () => {
  it('attributes entire OT to Sunday when start day is Sunday', () => {
    // 2026-05-10 is a Sunday
    const b = OT.calcOtBreakdown({ date: '2026-05-10', start: '09:00', end: '12:00', hours: 3 });
    expect(b.totalHours).toBe(3);
    expect(b.sundayHours).toBe(3);
    expect(b.nightHours).toBe(0);
    // weekday wage * 3h * 1.25 + sunday premium 3h * 0.10
    const w = OT.SALARY.HOURLY_WAGE;
    const expected = Math.floor(3 * w * 1.25) + Math.floor(3 * w * 0.10);
    expect(b.gross).toBe(expected);
  });

  it('weekday entry has no sunday premium', () => {
    const b = OT.calcOtBreakdown({ date: '2026-05-07', start: '18:00', end: '20:00', hours: 2 });
    expect(b.sundayHours).toBe(0);
    expect(b.weekdayHours).toBe(2);
  });

  it('adds night premium for 22:00-05:00 overlap', () => {
    // 21:00 → 24:00 = 3h, 2h of which is night (22-24)
    const b = OT.calcOtBreakdown({ date: '2026-05-07', start: '21:00', end: '00:00', hours: 3 });
    expect(b.nightHours).toBe(2);
  });
});

describe('calcMonthlySummary', () => {
  it('sums multiple entries with line-level floor', () => {
    const list = [
      { date: '2026-05-07', start: '18:00', end: '21:00', hours: 3 }, // 3h weekday
      { date: '2026-05-08', start: '18:00', end: '21:00', hours: 3 }, // 3h weekday
    ];
    const s = OT.calcMonthlySummary(list);
    expect(s.totalHours).toBe(6);
    expect(s.sundayHours).toBe(0);
    // 6h * 1563 * 1.25 = 11,722.5 → floor at line level (since both entries
    // independently contribute integer-minute hours, floor(6) is fine)
    const w = OT.SALARY.HOURLY_WAGE;
    expect(s.gross).toBe(Math.floor(6 * w * 1.25));
  });

  it('handles empty list', () => {
    expect(OT.calcMonthlySummary([]).gross).toBe(0);
    expect(OT.calcMonthlySummary(null).gross).toBe(0);
  });
});

describe('calcTakeHomeDelta', () => {
  it('returns 0 take-home for 0 gross delta', () => {
    const r = OT.calcTakeHomeDelta(0, {}, 0);
    expect(r.takeHomeDelta || 0).toBe(0);
  });

  it('take-home is positive and less than gross (taxes apply)', () => {
    const r = OT.calcTakeHomeDelta(10000, {}, 0);
    expect(r.takeHomeDelta).toBeGreaterThan(0);
    expect(r.takeHomeDelta).toBeLessThan(10000);
  });
});
