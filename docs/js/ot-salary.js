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
  // Cross-midnight: end <= start means rollover.
  if (endMin <= startMin) { endMin += 24 * 60; }

  // Determine paid duration:
  //  - If ot.hours present, trust it (it's the API-authoritative value, already
  //    accounting for any break deduction or 12h/day cap).
  //  - If absent, clamp the raw span to MAX_HOURS_PER_DAY (defensive — without
  //    ot.hours we cannot know the break, but DokoKin will never pay >12h/day).
  const rawSpan = endMin - startMin;
  let paidMin = rawSpan;
  if (ot.hours != null && !isNaN(ot.hours)) {
    const capMin = Math.round(Number(ot.hours) * 60);
    if (capMin > 0) paidMin = Math.min(rawSpan, capMin);
  } else {
    paidMin = Math.min(rawSpan, SALARY.MAX_HOURS_PER_DAY * 60);
  }
  endMin = startMin + paidMin;

  // Start-date day-of-week — used by salary engine for SUNDAY classification
  // because DokoKin/payslip attribute Sunday premium by REQUEST START DATE
  // (see gh_ot_creator.py: sundayWorkingtime = ot_hours if is_sun else 0).
  const startDow = _dayOfWeekJST(ot.date);

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
      dayOfWeek: _dayOfWeekJST(dateStr),    // calendar-day dow (for display)
      startDow,                              // start-date dow (for Sunday rate)
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
// IMPORTANT: SUNDAY classification by START DATE (matches DokoKin payload
// `sundayWorkingtime = ot_hours if is_sun else 0`), not by calendar segment.
// NIGHT is segment-based (matches gh_ot_creator.calculate_night_hours which
// counts minute-by-minute overlap with 22:00-05:00 across the whole window).
function calcOtBreakdown(ot) {
  const segments = splitOtByDay(ot);
  let totalMin = 0, sundayMin = 0, nightMin = 0;
  const startIsSunday = segments.length > 0 && segments[0].startDow === 0;
  for (const s of segments) {
    totalMin += s.minutes;
    nightMin += s.nightMinutes;
  }
  if (startIsSunday) sundayMin = totalMin;     // entire OT counts as Sunday
  const w = SALARY.HOURLY_WAGE;
  const baseOT = (totalMin / 60) * w * SALARY.OT_BASE_RATE;
  const sundayPremium = (sundayMin / 60) * w * SALARY.SUNDAY_PREMIUM;
  const nightPremium = (nightMin / 60) * w * SALARY.NIGHT_PREMIUM;
  // Use Math.floor per payslip evidence (Apr 2026 line 3.8: 54.52*1563*1.25 =
  // 106519.5 → payslip shows 106,512, consistent with floor on exact minutes).
  // Each line individually floored, then summed → matches payslip line-level math.
  return {
    totalHours: totalMin / 60,
    sundayHours: sundayMin / 60,
    nightHours: nightMin / 60,
    weekdayHours: (totalMin - sundayMin) / 60,
    baseOT, sundayPremium, nightPremium,
    gross: Math.floor(baseOT) + Math.floor(sundayPremium) + Math.floor(nightPremium),
    segments,
  };
}

// ─── Monthly summary (rounds at line-level, like payslip) ───
function calcMonthlySummary(otList) {
  let totalMin = 0, sundayMin = 0, nightMin = 0;
  for (const ot of (otList || [])) {
    const segs = splitOtByDay(ot);
    if (segs.length === 0) continue;
    const startIsSunday = segs[0].startDow === 0;
    let entryTotal = 0, entryNight = 0;
    for (const s of segs) {
      entryTotal += s.minutes;
      entryNight += s.nightMinutes;
    }
    totalMin += entryTotal;
    nightMin += entryNight;
    if (startIsSunday) sundayMin += entryTotal;   // entire entry attributed to Sunday line
  }
  const w = SALARY.HOURLY_WAGE;
  // Floor per-line (matches payslip math; standard rounding overcounts vs payslip).
  const baseOTLine = Math.floor((totalMin / 60) * w * SALARY.OT_BASE_RATE);
  const sundayLine = Math.floor((sundayMin / 60) * w * SALARY.SUNDAY_PREMIUM);
  const nightLine = Math.floor((nightMin / 60) * w * SALARY.NIGHT_PREMIUM);
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
    fixedAllowanceYen: SALARY.FIXED_ALLOWANCE_YEN,
    fixedAllowanceHours: FIXED_ALLOWANCE_HOURS,
    netExtra: gross,
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

// ═══════════════════════════════════════════════════
//  DEDUCTIONS & TAKE-HOME (Phase 3)
//  Calibrated against real Apr 2026 payslip (TanVC, FJP).
//  ★ ALL FIGURES = ESTIMATE. Final payslip may differ ¥500–¥2000
//    due to year-end adjustment, bonus months, table rounding.
//  Profile fields are configurable in localStorage (Settings later).
// ═══════════════════════════════════════════════════

const DEDUCTIONS = Object.freeze({
  // Insurance rates (Apr 2026 payslip line 4.1-4.3)
  HEALTH_RATE: 0.0475,           // 4.75% × standardInsuranceAmount
  WELFARE_RATE: 0.0915,          // 9.15% × standardInsuranceAmount
  UNEMPLOYMENT_RATE: 0.005,      // 0.5% × grossIncome (scales with OT)
  // Defaults — override via profile
  STANDARD_INSURANCE_AMOUNT: 280000,   // line 1.8 (fixed by 標準報酬月額 revision)
  CONTRACT_GROSS: 270000,              // line 1.x sum (basic + life design + fixed allowance)
  RESIDENT_TAX: 4300,                  // line 4.7 (prev-year basis, configurable)
  TRAVEL_ALLOWANCE: 0,                 // line 3.7
});

// ─── Japan 2025 源泉徴収月額表 甲欄 (dependents=0) ───
// Source: National Tax Agency 「令和7年分 源泉徴収税額表」 甲欄
// Calibrated anchor points: tax for "社会保険料控除後の給与等の金額" (A).
// Linear interpolation between points. Matches Apr 2026 payslip A=351,790
// → ~11,950 (payslip shows 11,730, Δ ≈¥200, within estimate band).
// For dependents > 0, subtract a flat allowance per dependent (rough).
const _INCOME_TAX_TABLE = [
  // [A_yen, monthly_tax_yen]
  [0,        0],
  [88000,    0],
  [105000,   280],
  [125000,   460],
  [150000,   700],
  [175000,   980],
  [200000,   1310],
  [225000,   1750],
  [250000,   2310],
  [275000,   3550],
  [300000,   4800],
  [325000,   6210],
  [350000,   11950],   // bracket transition (10% → next slope)
  [380000,   14570],
  [420000,   18290],
  [460000,   21860],
  [500000,   26500],
  [550000,   31570],
  [600000,   38400],
  [700000,   51300],
  [800000,   64600],
  [900000,   78900],
  [1000000,  93200],
  [1500000,  174300],
  [2000000,  254300],
];
const _DEPENDENT_ALLOWANCE_YEN = 31667;   // ≈ ¥380k/12, rough per-dep monthly deduction

function _incomeTaxMonthlyWithholding(A, dependents = 0) {
  if (!isFinite(A) || A <= 0) return 0;
  const table = _INCOME_TAX_TABLE;
  let tax;
  if (A <= table[0][0]) tax = 0;
  else if (A >= table[table.length - 1][0]) {
    // Extrapolate with last slope
    const [a2, t2] = table[table.length - 1];
    const [a1, t1] = table[table.length - 2];
    const slope = (t2 - t1) / (a2 - a1);
    tax = t2 + (A - a2) * slope;
  } else {
    for (let i = 0; i < table.length - 1; i++) {
      const [a1, t1] = table[i];
      const [a2, t2] = table[i + 1];
      if (A >= a1 && A <= a2) {
        tax = t1 + (A - a1) * (t2 - t1) / (a2 - a1);
        break;
      }
    }
  }
  // Adjust for dependents (allowance subtracted from each band)
  tax -= dependents * _DEPENDENT_ALLOWANCE_YEN * 0.10;   // rough — full table per-dep is complex
  return Math.max(0, Math.floor(tax));
}

// ─── Full monthly take-home estimate ───
// grossIncome = total of line 3 on payslip (base + OT + allowances, EXCL company receivable line 5).
// Returns object with all components. Does NOT model company receivable (rent/management fee),
// which varies and is deducted in line 5 of payslip after net.
function calcMonthlyEstimate(grossIncome, profile = {}) {
  const p = {
    standardInsurance: profile.standardInsurance ?? DEDUCTIONS.STANDARD_INSURANCE_AMOUNT,
    residentTax:       profile.residentTax       ?? DEDUCTIONS.RESIDENT_TAX,
    travelAllowance:   profile.travelAllowance   ?? DEDUCTIONS.TRAVEL_ALLOWANCE,
    dependents:        profile.dependents        ?? 0,
  };
  const health      = Math.floor(p.standardInsurance * DEDUCTIONS.HEALTH_RATE);
  const welfare     = Math.floor(p.standardInsurance * DEDUCTIONS.WELFARE_RATE);
  const unemployment = Math.floor(grossIncome * DEDUCTIONS.UNEMPLOYMENT_RATE);
  const insuranceTotal = health + welfare + unemployment;
  const taxableForWithholding = grossIncome - insuranceTotal - p.travelAllowance;
  const incomeTax = _incomeTaxMonthlyWithholding(taxableForWithholding, p.dependents);
  const totalDeductions = insuranceTotal + incomeTax + p.residentTax;
  const takeHome = grossIncome - totalDeductions;
  return {
    grossIncome,
    health, welfare, unemployment,
    insuranceTotal,
    taxableForWithholding,
    incomeTax,
    residentTax: p.residentTax,
    totalDeductions,
    takeHome,
  };
}

// ─── DELTA take-home from a given OT gross amount ───
// Uses two-state full-estimate to capture bracket transitions correctly.
// `currentMonthOtGross` = OT income already in the month (so marginal stacks).
function calcTakeHomeDelta(otGrossDelta, profile = {}, currentMonthOtGross = 0) {
  const p = profile;
  const contractGross = (p && p.contractGross) ?? DEDUCTIONS.CONTRACT_GROSS;
  const baseTotalGross = contractGross + currentMonthOtGross;
  const withExtraGross = baseTotalGross + otGrossDelta;
  const base = calcMonthlyEstimate(baseTotalGross, p);
  const withExtra = calcMonthlyEstimate(withExtraGross, p);
  return {
    grossDelta: otGrossDelta,
    takeHomeDelta: withExtra.takeHome - base.takeHome,
    insuranceDelta: withExtra.insuranceTotal - base.insuranceTotal,
    taxDelta: withExtra.incomeTax - base.incomeTax,
    effectiveKeepRate: otGrossDelta > 0
      ? (withExtra.takeHome - base.takeHome) / otGrossDelta
      : 0,
    base, withExtra,
  };
}

// Expose for ot-planner.js (vanilla, no module system)
window.OT_SALARY = {
  SALARY, FIXED_ALLOWANCE_HOURS, DEDUCTIONS,
  splitOtByDay, calcOtBreakdown, calcMonthlySummary,
  calcMonthlyEstimate, calcTakeHomeDelta,
  formatYen, formatHours,
};
