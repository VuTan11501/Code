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
  RESIDENT_TAX: 19200,                 // line 4.7 — revised Jun 2026 (FY2026 basis; was ¥4,300)
  TRAVEL_ALLOWANCE: 0,                 // line 3.7
});

// ─── Japan 源泉徴収月額表 甲欄 (dependents=0) ───
// CALIBRATED against TanVC's real payslip history (FJP, 22 monthly slips
// 2024-08 → 2026-06). Anchors are actual (A, tax) pairs from payslips:
//
//   PRIMARY (2026 table — used for OT estimates today):
//     • Jan 2026: A=  83,901 → ¥0       (under 88k threshold)
//     • Apr 2026: A= 351,790 → ¥11,730
//     • Jun 2026: A= 388,729 → ¥14,670  ← NEW (May work, Jun payslip)
//     • Mar 2026: A= 510,168 → ¥29,660
//     • Feb 2026: A= 534,526 → ¥33,580
//
//   SECONDARY (2025 H2 — fills lower brackets where 2026 has no data;
//   2025 rates are slightly higher than 2026 for the same A, so this is
//   a mildly conservative approximation):
//     • Jul 2025: A= 226,815 → ¥5,680
//     • Sep 2025: A= 252,083 → ¥6,640
//     • Oct 2025: A= 295,658 → ¥8,140
//
// 2024 H2 data deliberately excluded (distorted by 定額減税 ¥30k tax cut).
// Linear interpolation between points. Accuracy: exact at anchors, ±¥300
// elsewhere in the 200k–540k range. Above 600k extrapolated at ~16%.
const _INCOME_TAX_TABLE = [
  // [A_yen, monthly_tax_yen]
  [0,        0],
  [88000,    0],
  [105000,   700],
  [150000,   2500],
  [200000,   4500],
  [226815,   5680],    // 2025-H2 anchor
  [252083,   6640],    // 2025-H2 anchor
  [295658,   8140],    // 2025-H2 anchor
  [351790,   11730],   // ★ 2026 anchor — Apr 2026 payslip
  [388729,   14670],   // ★ 2026 anchor — Jun 2026 payslip (A=taxable from May work)
  [510168,   29660],   // ★ 2026 anchor — Mar 2026 payslip
  [534526,   33580],   // ★ 2026 anchor — Feb 2026 payslip
  [600000,   44100],   // extrap (~16% marginal)
  [700000,   60100],
  [800000,   76100],
  [900000,   92100],
  [1000000,  108100],
  [1500000,  198100],
  [2000000,  288100],
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

// ─── Full-month NET take-home: uses real payslip as fixed-cost baseline ───
// Inputs:
//   otGross         — total OT gross income for the month (from calcMonthlySummary)
//   baselinePayslip — most recent parsed payslip object (from payslip-history.json)
//                     used to extract "fixed-ish" components: rent, mgmt fee,
//                     resident tax, standard insurance amount, etc.
//   opts.basicSalaryIndex — override the 2.3 "Basic salary index" (default 1.0,
//                           which means full month worked)
//
// Returns full breakdown matching payslip lines:
//   gross           — base contract × index + fixed allowance + OT gross
//   insurance_total — health + welfare (from baseline) + unemployment (computed)
//   income_tax      — from calibrated _INCOME_TAX_TABLE
//   resident_tax    — from baseline
//   total_deductions, net_after_tax (line 7)
//   company_receivables — copied from baseline (rent, net fee, mgmt fee, …)
//   take_home       — line 8 equivalent
function calcFullMonthEstimate(otGross, baselinePayslip, opts = {}) {
  const idx = Number(opts.basicSalaryIndex ?? 1.0);
  const baseA = baselinePayslip?.contract?.basic_a ?? 195000;
  const baseB = baselinePayslip?.contract?.basic_b ?? 55000;
  const fixedAllow = baselinePayslip?.contract?.fixed_allowance ?? 20000;
  const stdIns = baselinePayslip?.contract?.standard_insurance
    ?? baselinePayslip?.deductions?.insurance_total
    ?? DEDUCTIONS.STANDARD_INSURANCE_AMOUNT;
  const health = baselinePayslip?.deductions?.health_insurance
    ?? Math.floor(stdIns * DEDUCTIONS.HEALTH_RATE);
  const welfare = baselinePayslip?.deductions?.welfare_insurance
    ?? Math.floor(stdIns * DEDUCTIONS.WELFARE_RATE);
  const residentTax = baselinePayslip?.deductions?.resident_tax ?? DEDUCTIONS.RESIDENT_TAX;
  const travelAllow = baselinePayslip?.contract?.travel_allowance ?? DEDUCTIONS.TRAVEL_ALLOWANCE;
  const companyRecv = baselinePayslip?.company_receivables?.total ?? 0;

  // Gross: base scales with index, OT is already month-actual
  const contractGross = Math.floor((baseA + baseB + fixedAllow) * idx);
  const gross = contractGross + Math.round(otGross);

  // Unemployment scales with gross
  const unemployment = Math.floor(gross * DEDUCTIONS.UNEMPLOYMENT_RATE);
  const insuranceTotal = health + welfare + unemployment;

  // Income tax (calibrated table)
  const taxable = gross - insuranceTotal - travelAllow;
  const incomeTax = _incomeTaxMonthlyWithholding(taxable, opts.dependents ?? 0);

  const totalDeductions = insuranceTotal + incomeTax + residentTax;
  const netAfterTax = gross - totalDeductions;
  const takeHome = netAfterTax - companyRecv;

  return {
    estimated: true,
    basicSalaryIndex: idx,
    contractGross,
    otGross: Math.round(otGross),
    gross,
    health, welfare, unemployment,
    insuranceTotal,
    taxable,
    incomeTax,
    residentTax,
    totalDeductions,
    companyReceivables: companyRecv,
    netAfterTax,
    takeHome,
  };
}

// Lookup most recent payslip from a parsed payslip-history list.
// Returns the latest non-bonus monthly slip whose month <= targetMonth ('YYYY-MM'),
// or the most recent one if no target given.
function pickBaselinePayslip(payslips, targetMonth) {
  if (!Array.isArray(payslips) || !payslips.length) return null;
  const monthlies = payslips.filter(p => p && !p.bonus && p.month && p.take_home);
  if (!monthlies.length) return null;
  monthlies.sort((a, b) => (a.month < b.month ? -1 : 1));
  if (!targetMonth) return monthlies[monthlies.length - 1];
  // Find latest with month < targetMonth (so estimates use PRIOR slip, not current)
  let best = null;
  for (const p of monthlies) {
    if (p.month < targetMonth) best = p;
    else break;
  }
  return best || monthlies[0];
}

// Convenience: find exact-match payslip for a month
function findPayslipForMonth(payslips, month) {
  if (!Array.isArray(payslips) || !month) return null;
  return payslips.find(p => p && p.month === month && !p.bonus) || null;
}

// ─── PAYROLL CYCLE HELPERS ───────────────────────────────────────────────
// At FJP the salary cycle is: work done in month X (incl. all OT) is paid
// on day 22 of month X+1. So `payslip.month` (= pay-date month) corresponds
// to work done in `payslip.month − 1`. Use these helpers whenever the
// surrounding code thinks in terms of WORK MONTH (e.g. timesheet view, OT
// planner calendar) instead of pay-date.
const PAY_DAY_OF_MONTH = 22;
function _shiftMonth(ym, delta) {
  if (!ym) return ym;
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function workMonthToPayMonth(workMonth) { return _shiftMonth(workMonth, 1); }
function payMonthToWorkMonth(payMonth)  { return _shiftMonth(payMonth, -1); }

// Find payslip whose work-month equals `workMonth` (i.e. payslip.month = wm+1)
function findPayslipForWorkMonth(payslips, workMonth) {
  return findPayslipForMonth(payslips, workMonthToPayMonth(workMonth));
}

// Latest baseline payslip representing work strictly older than `workMonth`.
// Equivalent to pickBaselinePayslip(payslips, payMonth(workMonth)) so the
// real payslip for `workMonth` (if any) is excluded.
function pickBaselineForWorkMonth(payslips, workMonth) {
  return pickBaselinePayslip(payslips, workMonthToPayMonth(workMonth));
}

// Returns "May 22, 2026" given workMonth "2026-04" (pay date for that work)
function formatPayDate(workMonth) {
  const pay = workMonthToPayMonth(workMonth);
  if (!pay) return '';
  const [y, m] = pay.split('-').map(Number);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[m - 1]} ${PAY_DAY_OF_MONTH}, ${y}`;
}

// Expose for ot-planner.js (vanilla, no module system)
window.OT_SALARY = {
  SALARY, FIXED_ALLOWANCE_HOURS, DEDUCTIONS, PAY_DAY_OF_MONTH,
  splitOtByDay, calcOtBreakdown, calcMonthlySummary,
  calcMonthlyEstimate, calcTakeHomeDelta,
  calcFullMonthEstimate, pickBaselinePayslip, findPayslipForMonth,
  workMonthToPayMonth, payMonthToWorkMonth,
  findPayslipForWorkMonth, pickBaselineForWorkMonth, formatPayDate,
  formatYen, formatHours,
};
