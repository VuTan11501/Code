// ═══════════════════════════════════════════════════
//  OT SALARY ENGINE — pure functions
//  Rates verified from real payslip (2026-04, FJP, TanVC):
//    - HOURLY_WAGE  = (BasicA + LifeDesign + DC) / 160 = ¥1,563
//    - OT base 125% on ALL hours
//    - +10% extra on Sunday hours
//    - +25% extra on night hours (22:00-05:00)
//    - Saturday = weekday (no holiday premium in actual payslip)
//    - Fixed OT allowance ¥20,000/mo paid REGARDLESS of OT done
// ═══════════════════════════════════════════════════

const SALARY = Object.freeze({
  HOURLY_WAGE: 1563,
  OT_BASE_RATE: 1.25,
  SUNDAY_PREMIUM: 0.10,
  NIGHT_PREMIUM: 0.25,
  MAX_HOURS_PER_DAY: 12,
  MAX_HOURS_PER_MONTH: 75,
  NIGHT_REMARK_THRESHOLD: 60,   // hours over → "over 60H OT" remark (no rate change per payslip)
  FIXED_ALLOWANCE_YEN: 20000,
});

// Hours covered by fixed allowance at the base rate.
// = 20000 / (1563 * 1.25) ≈ 10.24h
const FIXED_ALLOWANCE_HOURS = SALARY.FIXED_ALLOWANCE_YEN / (SALARY.HOURLY_WAGE * SALARY.OT_BASE_RATE);

// ─── Date helpers (avoid ISO parsing pitfalls) ───
function _parseYmd(dateStr) {
  // Returns local-midnight Date for the calendar date (browser TZ irrelevant
  // because we only use .getDay() which is local).
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function _addCalendarDays(dateStr, n) {
  const dt = _parseYmd(dateStr);
  dt.setDate(dt.getDate() + n);
  return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
}

function _dayOfWeekJST(dateStr) {
  // Local getDay() is safe when constructed via (y, m-1, d).
  return _parseYmd(dateStr).getDay();   // 0=Sun..6=Sat
}

// ─── Core: split OT request into per-calendar-day segments ───
// Generic loop, handles any duration (not just 2 days).
// Returns: [{date, dayOfWeek, minutes, nightMinutes}, ...]
function splitOtByDay(ot) {
  if (!ot || !ot.date || !ot.start || !ot.end) return [];
  const [sH, sM] = ot.start.split(':').map(Number);
  const [eH, eM] = ot.end.split(':').map(Number);
  const startMin = sH * 60 + sM;
  let endMin = eH * 60 + eM;
  // Cross-midnight: end <= start means rollover. 24:00 case (rare) treated as next day 00:00.
  if (endMin <= startMin) { endMin += 24 * 60; }

  // Honor `ot.hours` cap (DokoKin enforces max 12h/day; the stored hours field is
  // authoritative when smaller than the raw time span — clamp the effective window
  // so salary/night/sunday accounting matches what is actually paid).
  if (ot.hours != null && !isNaN(ot.hours)) {
    const capMin = Math.round(Number(ot.hours) * 60);
    if (capMin > 0 && capMin < (endMin - startMin)) {
      endMin = startMin + capMin;
    }
  }

  const segments = [];
  let cursor = startMin;
  let dateStr = ot.date;
  while (cursor < endMin) {
    const segEnd = Math.min(endMin, Math.ceil((cursor + 1) / (24 * 60)) * (24 * 60));
    const segStartLocal = cursor % (24 * 60);
    const segEndLocal = segEnd % (24 * 60) === 0 && segEnd > cursor ? 24 * 60 : (segEnd % (24 * 60));
    const minutes = segEnd - cursor;
    const nightMinutes = _nightOverlapMinutes(segStartLocal, segEndLocal);
    segments.push({
      date: dateStr,
      dayOfWeek: _dayOfWeekJST(dateStr),
      minutes,
      nightMinutes,
    });
    cursor = segEnd;
    if (cursor < endMin) {
      dateStr = _addCalendarDays(dateStr, 1);
    }
  }
  return segments;
}

// Night zone within a single calendar day = [00:00, 05:00) ∪ [22:00, 24:00)
// Inputs in minutes-of-day [0, 1440].
function _nightOverlapMinutes(startMin, endMin) {
  const zones = [[0, 300], [1320, 1440]];
  let total = 0;
  for (const [zs, ze] of zones) {
    total += Math.max(0, Math.min(endMin, ze) - Math.max(startMin, zs));
  }
  return total;
}

// ─── Per-entry breakdown (for table column display) ───
function calcOtBreakdown(ot) {
  const segments = splitOtByDay(ot);
  let totalMin = 0, sundayMin = 0, nightMin = 0;
  for (const s of segments) {
    totalMin += s.minutes;
    if (s.dayOfWeek === 0) sundayMin += s.minutes;
    nightMin += s.nightMinutes;
  }
  const w = SALARY.HOURLY_WAGE;
  const baseOT = (totalMin / 60) * w * SALARY.OT_BASE_RATE;
  const sundayPremium = (sundayMin / 60) * w * SALARY.SUNDAY_PREMIUM;
  const nightPremium = (nightMin / 60) * w * SALARY.NIGHT_PREMIUM;
  return {
    totalHours: totalMin / 60,
    sundayHours: sundayMin / 60,
    nightHours: nightMin / 60,
    weekdayHours: (totalMin - sundayMin) / 60,
    baseOT, sundayPremium, nightPremium,
    gross: Math.round(baseOT + sundayPremium + nightPremium),
    segments,
  };
}

// ─── Monthly summary (rounds at line-level, like payslip) ───
function calcMonthlySummary(otList) {
  let totalMin = 0, sundayMin = 0, nightMin = 0;
  for (const ot of (otList || [])) {
    const segs = splitOtByDay(ot);
    for (const s of segs) {
      totalMin += s.minutes;
      if (s.dayOfWeek === 0) sundayMin += s.minutes;
      nightMin += s.nightMinutes;
    }
  }
  const w = SALARY.HOURLY_WAGE;
  // Round per-line (payslip convention) then sum, so monthly matches payslip math.
  const baseOTLine = Math.round((totalMin / 60) * w * SALARY.OT_BASE_RATE);
  const sundayLine = Math.round((sundayMin / 60) * w * SALARY.SUNDAY_PREMIUM);
  const nightLine = Math.round((nightMin / 60) * w * SALARY.NIGHT_PREMIUM);
  const gross = baseOTLine + sundayLine + nightLine;
  return {
    totalHours: totalMin / 60,
    sundayHours: sundayMin / 60,
    nightHours: nightMin / 60,
    weekdayHours: (totalMin - sundayMin) / 60,
    baseOTLine,
    sundayLine,
    nightLine,
    gross,
    // Fixed allowance is paid regardless — show both gross (what's actually
    // earned from OT lines) and netExtra (what's NEW vs a no-OT month).
    fixedAllowanceYen: SALARY.FIXED_ALLOWANCE_YEN,
    fixedAllowanceHours: FIXED_ALLOWANCE_HOURS,
    netExtra: gross,   // gross OT lines are paid in addition to fixed allowance
    hoursPctMonth: (totalMin / 60) / SALARY.MAX_HOURS_PER_MONTH,
    nightPctRemark: (nightMin / 60) / SALARY.NIGHT_REMARK_THRESHOLD,
  };
}

// ─── Formatters ───
function formatYen(n) {
  if (n == null || isNaN(n)) return '¥0';
  return '¥' + Math.round(n).toLocaleString('en-US');
}

function formatHours(h) {
  if (h == null || isNaN(h)) return '0h';
  return h === Math.floor(h) ? `${h}h` : `${h.toFixed(2).replace(/\.?0+$/, '')}h`;
}

// Expose for ot-planner.js (vanilla, no module system)
window.OT_SALARY = {
  SALARY, FIXED_ALLOWANCE_HOURS,
  splitOtByDay, calcOtBreakdown, calcMonthlySummary,
  formatYen, formatHours,
};
