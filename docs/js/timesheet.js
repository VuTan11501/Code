// ═══════════════════════════════════════════════════
//  TIMESHEET VIEWER + LOST-OT DETECTOR
//  Reads `timesheet-history.json` from Gist (populated by
//  .github/workflows/timesheet-fetch.yml). Highlights days where actual
//  recognized working time < OT request → flags "lost OT yen" so user
//  can submit a Working Time Change request before payroll cutoff.
// ═══════════════════════════════════════════════════
const TS_FILE = 'timesheet-history.json';
const TS_FETCH_WF = 'timesheet-fetch.yml';
const PAYSLIP_FETCH_WF = 'payslip-fetch.yml';
const TS_ACTION_WF = 'timesheet-action.yml';

// Tolerance: anything ≤ this is "rounding noise", not a real loss.
// DokoKin rounds to the minute; 5 min covers minor clock drift.
const LOST_OT_TOLERANCE_MIN = 5;

let _tsState = {
  initialized: false,
  months: {},          // { "YYYY-MM": {fetched_at, summary, details:[...]} }
  account: '',
  updatedAt: '',
  viewYear: null,
  viewMonth: null,     // 0-indexed
  calculatedKey: null, // month key with a successful Calculate this session (gates Save Draft)
};

// ─── Init ───────────────────────────────────────────
function initTimesheetPage() {
  if (!_tsState.initialized) {
    _tsState.initialized = true;
    // Adopt shared month from UIKit if available (ux-x4)
    if (typeof UIKit !== 'undefined' && typeof UIKit.getSharedMonth === 'function') {
      const shared = UIKit.getSharedMonth();
      if (shared && /^\d{4}-\d{2}$/.test(shared)) {
        const [sy, sm] = shared.split('-').map(Number);
        _tsState.viewYear = sy;
        _tsState.viewMonth = sm - 1;
      } else {
        const now = jstNow();
        _tsState.viewYear = now.getFullYear();
        _tsState.viewMonth = now.getMonth();
      }
    } else {
      const now = jstNow();
      _tsState.viewYear = now.getFullYear();
      _tsState.viewMonth = now.getMonth();
    }
  }
  loadTimesheetData();
}

async function loadTimesheetData(opts) {
  const isManual = !!(opts && opts.refresh);
  const tableBody = document.getElementById('tsTableBody');
  const summaryEl = document.getElementById('tsSummary');
  if (!Object.keys(_tsState.months).length) {
    if (summaryEl) summaryEl.innerHTML = _tsSummarySkeleton();
    if (tableBody) tableBody.innerHTML = _tsTableSkeleton(8);
  }
  const refreshBtn = document.getElementById('tsRefreshBtn');
  if (isManual && refreshBtn) refreshBtn.classList.add('is-loading');
  try {
    const gist = await apiFetch(`/gists/${GIST_ID}`);
    const f = gist.files && gist.files[TS_FILE];
    let content = (f && f.content) || '';
    // GitHub truncates large file content in the Gist JSON response (~240KB).
    // Fall back to raw_url for the full body.
    if (f && f.truncated && f.raw_url) {
      try {
        const r = await fetch(f.raw_url, { cache: 'no-store' });
        if (r.ok) content = await r.text();
      } catch { /* keep truncated content as last resort */ }
    }
    let raw = null;
    if (content) {
      try { raw = JSON.parse(content); }
      catch { raw = null; }
    }
    if (raw && typeof raw === 'object' && raw.months) {
      _tsState.months = raw.months || {};
      _tsState.account = raw.account || '';
      _tsState.updatedAt = raw.updated_at || '';
    } else {
      _tsState.months = {};
    }
    // Also load payslip history (used to render Salary chip with real or
    // estimated net take-home). Same gist file as the OT planner uses.
    _tsState.payslips = [];
    const payFile = gist.files && gist.files['payslip-history.json'];
    if (payFile) {
      let payContent = payFile.content || '';
      if (payFile.truncated && payFile.raw_url) {
        try {
          const r = await fetch(payFile.raw_url, { cache: 'no-store' });
          if (r.ok) payContent = await r.text();
        } catch { /* ignore */ }
      }
      if (payContent) {
        try {
          const parsed = JSON.parse(payContent) || {};
          _tsState.payslips = Array.isArray(parsed.payslips) ? parsed.payslips : [];
        } catch { /* ignore */ }
      }
    }
    renderTimesheet();
  } catch (e) {
    if (summaryEl) summaryEl.innerHTML =
      `<div class="empty text-destructive text-sm p-5 text-center">Failed to load: ${e.message}</div>`;
    if (tableBody) tableBody.innerHTML =
      `<tr><td colspan="12" class="text-center text-destructive py-6">Failed: ${e.message}</td></tr>`;
  } finally {
    if (refreshBtn) refreshBtn.classList.remove('is-loading');
  }
}

// ─── Navigation ─────────────────────────────────────
function tsNavMonth(delta) {
  let y = _tsState.viewYear;
  let m = _tsState.viewMonth + delta;
  while (m < 0) { m += 12; y -= 1; }
  while (m > 11) { m -= 12; y += 1; }
  _tsState.viewYear = y;
  _tsState.viewMonth = m;
  // ux-x4: broadcast month change
  if (typeof UIKit !== 'undefined' && typeof UIKit.setSharedMonth === 'function') {
    UIKit.setSharedMonth(`${y}-${String(m + 1).padStart(2, '0')}`);
  }
  renderTimesheet();
}

function tsGoToday() {
  const now = jstNow();
  _tsState.viewYear = now.getFullYear();
  _tsState.viewMonth = now.getMonth();
  // ux-x4: broadcast month change
  if (typeof UIKit !== 'undefined' && typeof UIKit.setSharedMonth === 'function') {
    UIKit.setSharedMonth(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`);
  }
  renderTimesheet();
}

// ─── Helpers ────────────────────────────────────────
function _tsKey() {
  return `${_tsState.viewYear}-${String(_tsState.viewMonth + 1).padStart(2, '0')}`;
}

// Save Draft is gated behind a successful Calculate for the *currently
// viewed* month (mirrors DokoKin's own Calculate → Save Draft flow).
function _refreshSaveDraftState() {
  const btn = document.getElementById('tsSaveDraftBtn');
  if (!btn) return;
  const ready = _tsState.calculatedKey === _tsKey();
  btn.disabled = !ready;
  btn.setAttribute('data-tooltip', ready
    ? 'Calculate then save month as Draft (一時保存) on DokoKin — does NOT submit'
    : 'Bấm Calculate trước để bật Save Draft');
}

// "HH:MM" → minutes. Returns 0 for falsy/invalid.
function _hhmmToMin(s) {
  if (!s || typeof s !== 'string') return 0;
  const m = s.match(/^(-?)(\d{1,3}):(\d{2})$/);
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
}

function _minToHhmm(min) {
  const sign = min < 0 ? '-' : '';
  const a = Math.abs(Math.round(min));
  const h = Math.floor(a / 60);
  const mm = a % 60;
  return `${sign}${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

// Lost-OT for one day: requested OT minutes that did NOT get worked
// (the user wasn't physically present long enough to cover the OT span).
// Returns: { lostMin, sundayLostMin, nightLostMin }
//
// **Design (rewritten 2026-05-29 evening):** Lost detection is now purely
// presence-based. It compares `actualWorking` (physical clock-in/out span
// minus breaks) against `workingHours` (expected total = standard + OT
// request, per DokoKin). If presence covers expected within tolerance →
// not lost.
//
// We deliberately ignore credit fields (`otNormal/otSat/otSun`) and the
// `hasUnapprovedOT` flag for the lost-vs-OK decision:
//   • Credit only appears after manager approval + nightly batch. A day
//     worked yesterday with credit=0 is NOT lost — it's awaiting approval,
//     and approval is paperwork, not work that can be "missed".
//   • The lost concept exists to catch the case where auto-checkout fires
//     before the planned OT end-time, cutting presence short. That's
//     entirely a presence (in/out) issue, independent of approval.
//
// Premium math (Sunday +10%, Night +25%) is applied when we DO call it
// lost, using the requested midnight portion as an upper bound.
function _calcLostForDay(d) {
  const req = _hhmmToMin(d.otRequest);
  if (req <= 0) return { lostMin: 0, sundayLostMin: 0, nightLostMin: 0 };
  // Skip future dates: OT for days that haven't happened yet can't be "lost".
  if (d.date) {
    const today = new Date();
    const todayKey = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
    if (d.date > todayKey) return { lostMin: 0, sundayLostMin: 0, nightLostMin: 0 };
  }

  const actualWorkMin = _hhmmToMin(d.actualWorking);
  // Expected total presence the user planned to put in:
  //   standard hours (8h on weekdays, 0h on Sat/Sun/holidays) + OT request.
  //
  // We cannot use d.workingHours from DokoKin here — it reflects what was
  // ACTUALLY counted (≈ actualWorking minus breaks), NOT what was planned.
  // Comparing actualWorking to workingHours would always be ~zero and
  // hide every Lost case (e.g. 05-17 Sun: workingHours=actualWorking=10:32
  // even though the user requested 12h of OT and was 1:28 short).
  const stdMin = (d.isSunday || d.isSaturday || d.isHoliday) ? 0 : (8 * 60);
  const expected = stdMin + req;

  const gap = expected - actualWorkMin;
  if (gap <= LOST_OT_TOLERANCE_MIN) {
    return { lostMin: 0, sundayLostMin: 0, nightLostMin: 0 };
  }
  // Cap lost minutes at the requested OT amount — presence shortfall
  // beyond the OT portion is missing standard hours, not lost OT.
  const lostMin = Math.min(gap, req);

  const reqMidMin    = Math.round((d.otRequestMidNum || 0) * 60);
  const actualMidMin = Math.round((d.actualMidNum    || 0) * 60);
  const midGap       = Math.max(0, reqMidMin - actualMidMin);
  const nightLostMin = Math.min(lostMin, midGap || reqMidMin);
  const sundayLostMin = d.isSunday ? lostMin : 0;
  return { lostMin, sundayLostMin, nightLostMin };
}

// Back-compat shim for any callers still using the old signature.
function _calcLostMinForDay(d) { return _calcLostForDay(d).lostMin; }

// Yen value of one day's lost OT — applies same 3-line formula as
// OT_SALARY.calcMonthlySummary: base 125% + Sunday +10% + Night +25%.
function _lostYenFromDay(parts) {
  if (!parts || !parts.lostMin || !window.OT_SALARY) return 0;
  const S = window.OT_SALARY.SALARY;
  const w = S.HOURLY_WAGE;
  const baseLine   = Math.floor((parts.lostMin       / 60) * w * S.OT_BASE_RATE);
  const sundayLine = Math.floor((parts.sundayLostMin / 60) * w * S.SUNDAY_PREMIUM);
  const nightLine  = Math.floor((parts.nightLostMin  / 60) * w * S.NIGHT_PREMIUM);
  return baseLine + sundayLine + nightLine;
}

// Aggregate yen for whole-month totals (matches payslip line-level floor math).
function _lostYenFromTotals(t) {
  if (!t || !window.OT_SALARY) return 0;
  const S = window.OT_SALARY.SALARY;
  const w = S.HOURLY_WAGE;
  return Math.floor((t.lostMin       / 60) * w * S.OT_BASE_RATE)
       + Math.floor((t.sundayLostMin / 60) * w * S.SUNDAY_PREMIUM)
       + Math.floor((t.nightLostMin  / 60) * w * S.NIGHT_PREMIUM);
}

// ─── Render ─────────────────────────────────────────
function renderTimesheet() {
  const monthLabel = document.getElementById('tsMonthLabel');
  if (monthLabel) {
    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    monthLabel.textContent =
      `${monthNames[_tsState.viewMonth]} ${_tsState.viewYear}`;
  }
  const key = _tsKey();
  const snap = _tsState.months[key];
  const summaryEl = document.getElementById('tsSummary');
  const tableBody = document.getElementById('tsTableBody');
  const updEl = document.getElementById('tsUpdatedAt');
  if (updEl) {
    updEl.textContent = _tsState.updatedAt
      ? `Synced ${_tsState.updatedAt.replace('T', ' ').slice(0, 16)} JST`
      : '';
  }
  _refreshSaveDraftState();

  if (!snap) {
    if (summaryEl) summaryEl.innerHTML = `
      <div class="card bg-card border border-border rounded-lg p-6 text-center">
        <div class="text-base font-semibold mb-1">No timesheet data for ${key}</div>
        <div class="text-sm text-muted-foreground mb-4">Pull the latest from DokoKin to see your recognized hours and lost OT.</div>
        <button class="btn primary" onclick="syncTimesheetFromDokoKin && syncTimesheetFromDokoKin()">
          <span data-icon="sparkles" data-size="14"></span> Sync DokoKin now
        </button>
      </div>`;
    if (tableBody) tableBody.innerHTML =
      `<tr><td colspan="12" class="text-center text-muted-foreground py-8">No data yet — tap <strong>Sync DokoKin</strong> above to fetch.</td></tr>`;
    // Re-render any newly-inserted data-icon spans
    if (typeof renderIcons === 'function') renderIcons();
    return;
  }

  // Compute lost-OT
  const details = Array.isArray(snap.details) ? snap.details : [];
  const totals = { lostMin: 0, sundayLostMin: 0, nightLostMin: 0 };
  const lostDays = [];
  for (const d of details) {
    const parts = _calcLostForDay(d);
    if (parts.lostMin > 0) {
      totals.lostMin       += parts.lostMin;
      totals.sundayLostMin += parts.sundayLostMin;
      totals.nightLostMin  += parts.nightLostMin;
      lostDays.push({ ...d, ...parts });
    }
  }
  const totalLostYen = _lostYenFromTotals(totals);

  // ── Summary card ──
  const s = snap.summary || {};
  // API doesn't always populate displayTotalOTHours — compute from weekday+Sat+Sun.
  const totalOTMin = _hhmmToMin(s.displayOvertimeHours)
                   + _hhmmToMin(s.displayHolidayOvertimeHours)
                   + _hhmmToMin(s.displaySundayOvertimeHours);
  const totalOT = totalOTMin > 0 ? _minToHhmm(totalOTMin) : (s.displayTotalOTHours || '—');

  // "Billable extra" OT = total OT minus the 10h baseline already covered by
  // the ¥20,000/month fixed allowance. If the result is ≤ 0, no extra is
  // being paid above the fixed amount yet.
  let totalOTSecondary = '';
  if (totalOTMin > 0) {
    const FIXED_BASE_MIN = 10 * 60;  // round 10h baseline (per user preference)
    const billableMin = totalOTMin - FIXED_BASE_MIN;
    const billableLabel = billableMin > 0 ? _minToHhmm(billableMin) : `−${_minToHhmm(-billableMin)}`;
    const tip = `Billable extra OT = total OT − 10h (fixed allowance baseline ¥20,000/month). `
              + (billableMin > 0
                  ? `You're ${billableLabel} above 10h → extra paid line on payslip.`
                  : `You're still under 10h — no extra paid OT line this month.`);
    totalOTSecondary = `<span class="ts-chip-aux tooltip-trigger" data-tooltip="${tip.replace(/"/g,'&quot;')}">${billableLabel}</span>`;
  }

  const chips = [
    ['Working hours', s.displayTotalWorkingHours || '—'],
    ['Actual', s.displayTotalActualWorkingTime || '—'],
    ['OT request', s.displayOTRequestHours || '—'],
    ['OT total', totalOT, totalOTSecondary],
    ['OT weekday', s.displayOvertimeHours || '—'],
    ['OT midnight', s.displayNightWorkingHours || '—'],
    ['OT Sat/Hol', s.displayHolidayOvertimeHours || '—'],
    ['OT Sun', s.displaySundayOvertimeHours || '—'],
  ];

  // ── Salary chip (mirrors ot-planner.js Net take-home pattern) ──
  // Computes OT gross from the recognized hours, then either uses the actual
  // payslip if present, or estimates from the latest baseline payslip.
  if (window.OT_SALARY) {
    const SAL = window.OT_SALARY.SALARY;
    const w = SAL.HOURLY_WAGE;
    const totalH  = totalOTMin / 60;
    const sundayH = _hhmmToMin(s.displaySundayOvertimeHours) / 60;
    const nightH  = _hhmmToMin(s.displayNightWorkingHours) / 60;
    const baseOTLine   = Math.floor(totalH  * w * SAL.OT_BASE_RATE);
    const sundayLine   = Math.floor(sundayH * w * SAL.SUNDAY_PREMIUM);
    const nightLine    = Math.floor(nightH  * w * SAL.NIGHT_PREMIUM);
    const otGross      = baseOTLine + sundayLine + nightLine + SAL.FIXED_ALLOWANCE_YEN;
    const F = window.OT_SALARY.formatYen;

    const realSlip = window.OT_SALARY.findPayslipForWorkMonth(_tsState.payslips, key);
    const baseline = window.OT_SALARY.pickBaselineForWorkMonth(_tsState.payslips, key);
    const payDateStr = window.OT_SALARY.formatPayDate(key);
    const eyeIcon = (window.ICON ? window.ICON('eye', 14) : '👁');

    let salaryVal, salaryTip, salaryExtras = '';
    if (realSlip && realSlip.take_home != null) {
      const eyeBtn = `<button class="ts-chip-eye ot-takehome-clickable" data-payslip-month="${key}" aria-label="View payslip detail">${eyeIcon}</button>`;
      salaryVal = `${F(realSlip.take_home)} <span class="ts-chip-badge ts-chip-badge-actual">act.</span>`;
      salaryExtras = eyeBtn;
      salaryTip = `Actual take-home for work month ${key}\n`
                + `(paid ${payDateStr} · payslip ${realSlip.month})\n`
                + `• Gross: ${F(realSlip.gross || 0)}\n`
                + `• Take-home: ${F(realSlip.take_home)}\n`
                + `(All deductions applied: insurance, taxes, rent, fees)\n`
                + `Click 👁 for full breakdown.`;
    } else if (baseline) {
      const est = window.OT_SALARY.calcFullMonthEstimate(otGross, baseline, { basicSalaryIndex: 1.0 });
      const eyeBtn = `<button class="ts-chip-eye ot-takehome-clickable" data-payslip-month="${key}" data-payslip-estimate="1" aria-label="View payslip estimate">${eyeIcon}</button>`;
      salaryVal = `${F(est.takeHome)} <span class="ts-chip-badge">est.</span>`;
      salaryExtras = eyeBtn;
      salaryTip = `Estimated take-home for work month ${key}\n`
                + `(will be paid ${payDateStr} · baseline: payslip ${baseline.month})\n`
                + `• Total gross: ${F(est.gross)}\n`
                + `  · contract: ${F(est.contractGross)}\n`
                + `  · OT (incl. ¥20k fixed): ${F(est.otGross)}\n`
                + `• − Insurance: ${F(est.insuranceTotal)}\n`
                + `• − Income tax: ${F(est.incomeTax)}\n`
                + `• − Resident tax: ${F(est.residentTax)}\n`
                + `• − Company receivables: ${F(est.companyReceivables)}\n`
                + `= ${F(est.takeHome)}`;
    } else {
      salaryVal = `${F(otGross)} <span class="ts-chip-badge">OT gross</span>`;
      salaryTip = `OT gross only (no payslip baseline available — add a payslip in OT Planner first):\n`
                + `• Base 125% × ${totalH.toFixed(2)}h: ${F(baseOTLine)}\n`
                + (sundayLine ? `• Sunday +10% × ${sundayH.toFixed(2)}h: ${F(sundayLine)}\n` : '')
                + (nightLine  ? `• Night +25% × ${nightH.toFixed(2)}h: ${F(nightLine)}\n` : '')
                + `• Fixed allowance: ${F(SAL.FIXED_ALLOWANCE_YEN)}\n`
                + `= ${F(otGross)} (gross, pre-tax)`;
    }
    chips.push(['Salary', { html: salaryVal, tip: salaryTip, cls: 'ts-chip-salary', extras: salaryExtras }]);
  }

  let chipsHtml = '';
  for (const c of chips) {
    const label = c[0];
    const val = c[1];
    const aux = c[2] || '';
    if (val && typeof val === 'object') {
      const tip = (val.tip || '').replace(/"/g, '&quot;');
      const extras = val.extras ? `<div class="ts-chip-label-extras">${val.extras}</div>` : '';
      chipsHtml += `
        <div class="ts-chip ${val.cls || ''} tooltip-trigger" data-tooltip="${tip}">
          <div class="ts-chip-label-row">
            <div class="ts-chip-label">${label}</div>
            ${extras}
          </div>
          <div class="ts-chip-value">${val.html}</div>
        </div>`;
    } else {
      chipsHtml += `
        <div class="ts-chip">
          <div class="ts-chip-label">${label}</div>
          <div class="ts-chip-value">${val}${aux}</div>
        </div>`;
    }
  }

  let lostHtml = '';
  if (totals.lostMin > 0) {
    const yen = '¥' + totalLostYen.toLocaleString('en-US');
    const hhmm = _minToHhmm(totals.lostMin);
    const premiumNote = [];
    if (totals.sundayLostMin > 0) premiumNote.push(`Sun ${_minToHhmm(totals.sundayLostMin)} +10%`);
    if (totals.nightLostMin > 0)  premiumNote.push(`Night ${_minToHhmm(totals.nightLostMin)} +25%`);
    const noteHtml = premiumNote.length
      ? `<div class="ts-lost-sub" style="opacity:.75;font-size:.8em">incl. ${premiumNote.join(' · ')}</div>`
      : '';
    lostHtml = `
      <div class="ts-lost-card" role="alert">
        <div class="ts-lost-head">
          <span class="ts-lost-icon">⚠️</span>
          <div>
            <div class="ts-lost-title">Lost OT detected — ${lostDays.length} day${lostDays.length > 1 ? 's' : ''}</div>
            <div class="ts-lost-sub">${hhmm} requested but not recognized → <strong>${yen}</strong> gross (est.)</div>
            ${noteHtml}
          </div>
        </div>
        <div class="ts-lost-hint">
          Likely cause: checkin late or checkout early vs OT request.
          Fix via DokoKin → <em>勤務時間変更</em> (Working time change) before payroll cutoff.
        </div>
      </div>`;
  }

  if (summaryEl) {
    summaryEl.innerHTML = `
      ${lostHtml}
      <div class="ts-summary-grid">${chipsHtml}</div>`;
  }

  // ── Per-day table ──
  if (tableBody) {
    if (!details.length) {
      tableBody.innerHTML =
        `<tr><td colspan="12" class="text-center text-muted-foreground py-8">No days</td></tr>`;
    } else {
      let rows = '';
      const today = (() => {
        const n = jstNow();
        return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`;
      })();
      for (const d of details) {
        const parts = _calcLostForDay(d);
        const lost = parts.lostMin;
        const isLost = lost > 0;
        const isToday = d.date === today;
        const dayClass = d.isSunday ? 'ts-dow-sun'
                       : d.isHoliday ? 'ts-dow-hol'
                       : d.isSaturday ? 'ts-dow-sat' : '';
        const rowClass = [
          isLost ? 'ts-row-lost' : '',
          isToday ? 'ts-row-today' : '',
        ].filter(Boolean).join(' ');
        let deltaCell;
        const isFuture = d.date && d.date > today;
        if (isLost) {
          const dayYen = _lostYenFromDay(parts);
          const reqMin = _hhmmToMin(d.otRequest);
          const stdMin = (d.isSunday || d.isSaturday || d.isHoliday) ? 0 : (8 * 60);
          const expectedHhmm = _minToHhmm(stdMin + reqMin);
          const lines = [
            `Lost ${_minToHhmm(lost)} (≈ ¥${dayYen.toLocaleString('en-US')} gross)`,
            `Check-in/out didn't fully cover the OT request range.`,
            `Requested: ${d.otRequest || '—'} · Worked: ${d.actualWorking || '—'} / Expected: ${expectedHhmm}`,
          ];
          if (parts.sundayLostMin > 0) lines.push(`+10% Sunday on ${_minToHhmm(parts.sundayLostMin)}`);
          if (parts.nightLostMin > 0)  lines.push(`+25% Night on ${_minToHhmm(parts.nightLostMin)}`);
          const tip = lines.join('\n').replace(/"/g, '&quot;');
          // T2: tappable lost-OT cell opens action sheet
          const cellId = `ts-lost-${d.date}`;
          deltaCell = `<td class="ts-cell ts-cell-delta text-destructive font-semibold tooltip-trigger ts-lost-tap" data-tooltip="${tip}" id="${cellId}" data-date="${d.date}">−${_minToHhmm(lost)}</td>`;
        } else if (isFuture && d.otRequest && _hhmmToMin(d.otRequest) > 0) {
          deltaCell = `<td class="ts-cell ts-cell-delta text-muted-foreground tooltip-trigger" data-tooltip="Future date — OT not yet worked, lost status unknown">?</td>`;
        } else {
          deltaCell = (d.otRequest && _hhmmToMin(d.otRequest) > 0)
            ? `<td class="ts-cell ts-cell-delta text-success tooltip-trigger" data-tooltip="Check-in/out covered the OT span ✓">✓</td>`
            : `<td class="ts-cell ts-cell-delta text-muted-foreground">—</td>`;
        }
        const dateLabel = d.date ? d.date.slice(5) : '—';   // MM-DD
        rows += `
          <tr class="${rowClass}">
            <td class="ts-cell ts-cell-date">${dateLabel}</td>
            <td class="ts-cell ${dayClass}">${d.dow || ''}</td>
            <td class="ts-cell">${d.in || ''}</td>
            <td class="ts-cell">${d.out || ''}</td>
            <td class="ts-cell text-muted-foreground">${d.break || ''}</td>
            <td class="ts-cell">${d.actualWorking || ''}</td>
            <td class="ts-cell font-medium">${d.otRequest || ''}</td>
            <td class="ts-cell">${d.otNormal || ''}</td>
            <td class="ts-cell">${d.otMidnight || ''}</td>
            <td class="ts-cell">${d.otSat || ''}</td>
            <td class="ts-cell">${d.otSun || ''}</td>
            ${deltaCell}
          </tr>`;
      }
      tableBody.innerHTML = rows;
      // T2: attach click handlers for lost-OT tappable cells
      tableBody.querySelectorAll('.ts-lost-tap').forEach(cell => {
        cell.style.cursor = 'pointer';
        cell.addEventListener('click', () => _openLostOtSheet(cell.dataset.date, details));
      });
    }
  }

  const countEl = document.getElementById('tsRowCount');
  if (countEl) {
    countEl.textContent = `${details.length} day${details.length > 1 ? 's' : ''}` +
      (lostDays.length ? ` · ${lostDays.length} flagged` : '');
  }
}

// ─── T2: Lost-OT action sheet ───────────────────────
function _openLostOtSheet(date, details) {
  if (typeof UIKit === 'undefined' || typeof UIKit.openSheet !== 'function') return;
  const d = details.find(x => x.date === date);
  if (!d) return;
  const parts = _calcLostForDay(d);
  if (parts.lostMin <= 0) return;

  const dayYen = _lostYenFromDay(parts);
  const reqMin = _hhmmToMin(d.otRequest);
  const stdMin = (d.isSunday || d.isSaturday || d.isHoliday) ? 0 : (8 * 60);
  const expectedHhmm = _minToHhmm(stdMin + reqMin);

  // Determine likely cause
  let cause = '';
  if (!d.out) {
    cause = 'Chưa checkout — phiên làm việc chưa đóng, hệ thống không ghi nhận giờ ra.';
  } else if (!d.in) {
    cause = 'Thiếu checkin — không có giờ vào, không tính được thời gian làm.';
  } else {
    cause = 'Checkout quá sớm so với thời gian OT request. Giờ làm thực tế không đủ cover OT đã đăng ký.';
  }

  let breakdownHtml = `
    <div style="margin-bottom:var(--sp-3)">
      <div style="font-size:var(--fs-sm);color:var(--muted-foreground);margin-bottom:var(--sp-1)">Nguyên nhân</div>
      <div style="font-size:var(--fs-base)">${cause}</div>
    </div>
    <div class="now-strip" style="margin-bottom:var(--sp-3)">
      <div class="now-item"><span style="color:var(--muted-foreground)">OT request</span> <strong>${d.otRequest || '—'}</strong></div>
      <div class="now-item"><span style="color:var(--muted-foreground)">Giờ thực tế</span> <strong>${d.actualWorking || '—'}</strong></div>
      <div class="now-item"><span style="color:var(--muted-foreground)">Cần đạt</span> <strong>${expectedHhmm}</strong></div>
      <div class="now-item"><span style="color:var(--muted-foreground)">CI/CO</span> <strong>${d.in || '?'} → ${d.out || '?'}</strong></div>
    </div>
    <div class="now-strip">
      <div class="now-item"><span style="color:var(--red)">Mất</span> <strong style="color:var(--red)">${_minToHhmm(parts.lostMin)}</strong></div>
      <div class="now-item"><span style="color:var(--red)">≈ Gross</span> <strong style="color:var(--red)">¥${dayYen.toLocaleString('en-US')}</strong></div>
    </div>`;

  if (parts.sundayLostMin > 0 || parts.nightLostMin > 0) {
    let premiums = '';
    if (parts.sundayLostMin > 0) premiums += `<div class="now-item">Sun +10%: ${_minToHhmm(parts.sundayLostMin)}</div>`;
    if (parts.nightLostMin > 0) premiums += `<div class="now-item">Night +25%: ${_minToHhmm(parts.nightLostMin)}</div>`;
    breakdownHtml += `<div class="now-strip" style="margin-top:var(--sp-2)">${premiums}</div>`;
  }

  breakdownHtml += `
    <div style="margin-top:var(--sp-4);padding:var(--sp-3);background:var(--muted);border-radius:var(--radius-md);font-size:var(--fs-sm);color:var(--muted-foreground)">
      💡 Khắc phục: vào DokoKin → 勤務時間変更 (Working time change) để sửa giờ ra trước payroll cutoff. Hoặc tạo lịch CO bù trong tab Schedule.
    </div>`;

  UIKit.openSheet({
    title: `OT bị mất — ${date}`,
    bodyHTML: breakdownHtml,
    actions: [
      { label: 'Hiểu nguyên nhân', variant: 'secondary', close: true },
    ],
  });
}

// ─── Sync (dispatch workflow) ───────────────────────
async function syncTimesheetFromDokoKin() {
  if (!sessionToken) {
    toast('🔒 Unlock first', 'error');
    return;
  }

  const btn = document.getElementById('tsSyncBtn');
  const orig = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `${ICON('refresh', 14, 'animate-spin')} Pulling…`;
  }
  try {
    const res = await fetch(
      `${API}/repos/${OWNER}/${REPO}/actions/workflows/${TS_FETCH_WF}/dispatches`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${sessionToken}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: 'main', inputs: { months_keep: '24' } }),
    });
    if (res.status !== 204) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${body ? ': ' + body.slice(0, 80) : ''}`);
    }
    toast('☁️ Pull dispatched — waiting for workflow…');
    await _waitForTimesheetFetchRun();
    await loadTimesheetData({ refresh: true });
    toast('✅ Timesheet synced', 'success');
  } catch (e) {
    toast(`❌ Sync failed: ${e.message}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = orig;
    }
  }
}

async function _waitForTimesheetFetchRun() {
  const start = Date.now();
  const TIMEOUT_MS = 3 * 60 * 1000;
  await new Promise(r => setTimeout(r, 4000));
  while (Date.now() - start < TIMEOUT_MS) {
    try {
      const data = await apiFetch(
        `/repos/${OWNER}/${REPO}/actions/workflows/${TS_FETCH_WF}/runs?per_page=1&event=workflow_dispatch`);
      const run = data && data.workflow_runs && data.workflow_runs[0];
      if (run && run.status === 'completed') return run;
    } catch { /* ignore transient */ }
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error('Timed out waiting for Timesheet Fetch run');
}

// ─── Sync payslip (dispatch workflow) ───────────────
// Re-fetches the payslip for a specific work-month from FJP (POST
// /api/payroll/salary/{year}/{month}) and updates payslip-history.json.
// `workYearMonth` is "YYYY-MM" of the WORK month (e.g. "2026-04"). The
// workflow's input `year_month` is the PAY month — i.e. work+1.
async function syncPayslipFromFJP(workYearMonth, opts = {}) {
  if (!sessionToken) {
    toast('🔒 Unlock first', 'error');
    return;
  }
  // workYearMonth optional — defaults to currently-viewed month.
  let wym = workYearMonth;
  if (!wym && _tsState.viewYear != null) {
    wym = `${_tsState.viewYear}-${String(_tsState.viewMonth + 1).padStart(2, '0')}`;
  }
  if (!wym) {
    toast('❌ No month selected', 'error');
    return;
  }
  // Convert work-month → pay-month (work + 1 month).
  let payYM = wym;
  if (window.OT_SALARY && typeof window.OT_SALARY.workMonthToPayMonth === 'function') {
    payYM = window.OT_SALARY.workMonthToPayMonth(wym);
  }
  const force = opts.force !== false;  // default true (user explicitly asked to re-fetch)
  const btn = opts.btn || document.getElementById('tsSyncPayslipBtn');
  const orig = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `${ICON('refresh', 14, 'animate-spin')} Fetching…`;
  }
  try {
    const res = await fetch(
      `${API}/repos/${OWNER}/${REPO}/actions/workflows/${PAYSLIP_FETCH_WF}/dispatches`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${sessionToken}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: 'main', inputs: {
        year_month: payYM,
        months_back: '0',
        force: force ? 'true' : 'false',
      }}),
    });
    if (res.status !== 204) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${body ? ': ' + body.slice(0, 80) : ''}`);
    }
    toast(`☁️ Pulling payslip ${payYM} (work ${wym}) — waiting…`);
    await _waitForPayslipFetchRun();
    await loadTimesheetData({ refresh: true });
    toast(`✅ Payslip ${payYM} synced`, 'success');
  } catch (e) {
    toast(`❌ Payslip sync failed: ${e.message}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = orig;
    }
  }
}

async function _waitForPayslipFetchRun() {
  const start = Date.now();
  const TIMEOUT_MS = 3 * 60 * 1000;
  await new Promise(r => setTimeout(r, 4000));
  while (Date.now() - start < TIMEOUT_MS) {
    try {
      const data = await apiFetch(
        `/repos/${OWNER}/${REPO}/actions/workflows/${PAYSLIP_FETCH_WF}/runs?per_page=1&event=workflow_dispatch`);
      const run = data && data.workflow_runs && data.workflow_runs[0];
      if (run && run.status === 'completed') {
        if (run.conclusion !== 'success') {
          throw new Error(`Workflow ${run.conclusion || 'failed'} — see Actions tab`);
        }
        return run;
      }
    } catch (err) {
      if (err && /Workflow/.test(err.message)) throw err;
    }
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error('Timed out waiting for Payslip Fetch run');
}

// ─── Timesheet Calculate / Save Draft (write actions) ───
// Dispatch `timesheet-action.yml` which calls DokoKin's FES
// /api/timesheet/{calculate,save} endpoints. Writes go through Actions
// (PAT can't call DokoKin directly). `calculate` recomputes server-side
// totals; `calc-save` recomputes THEN persists as Draft (status=1, 一時保存).
// Submit (申請) is intentionally NOT wired — user does that on DokoKin.

async function _dispatchTimesheetAction(action, opts = {}) {
  const year = _tsState.viewYear;
  const month = _tsState.viewMonth + 1;
  if (year == null) throw new Error('No month selected');
  const inputs = {
    action,
    year: String(year),
    month: String(month),
    account: _tsState.account || 'tanvc',
  };
  if (opts.force) inputs.force = 'true';
  const res = await fetch(
    `${API}/repos/${OWNER}/${REPO}/actions/workflows/${TS_ACTION_WF}/dispatches`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${sessionToken}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref: 'main', inputs }),
  });
  if (res.status !== 204) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}${body ? ': ' + body.slice(0, 80) : ''}`);
  }
}

async function _waitForTimesheetActionRun() {
  const start = Date.now();
  const TIMEOUT_MS = 4 * 60 * 1000;
  await new Promise(r => setTimeout(r, 2000));
  while (Date.now() - start < TIMEOUT_MS) {
    try {
      const data = await apiFetch(
        `/repos/${OWNER}/${REPO}/actions/workflows/${TS_ACTION_WF}/runs?per_page=1&event=workflow_dispatch`);
      const run = data && data.workflow_runs && data.workflow_runs[0];
      if (run && run.status === 'completed') return run; // caller inspects conclusion
    } catch { /* ignore transient */ }
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error('Timed out waiting for Timesheet Action run');
}

// action=calculate — recompute server totals, then re-pull to reflect them.
async function recalcTimesheet() {
  if (!sessionToken) { toast('🔒 Unlock first', 'error'); return; }
  const btn = document.getElementById('tsRecalcBtn');
  const orig = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `${ICON('refresh', 14, 'animate-spin')} Calculating…`;
  }
  try {
    await _dispatchTimesheetAction('calculate');
    toast('🧮 Calculate dispatched — waiting…');
    const run = await _waitForTimesheetActionRun();
    if (run.conclusion !== 'success') {
      throw new Error('Calculate failed — see Actions / email');
    }
    _tsState.calculatedKey = _tsKey();
    _refreshSaveDraftState();
    toast('🧮 Recalculated — refreshing…', 'success');
    // The action already wrote the recalculated month into the Gist cache,
    // so just reload from Gist — no second timesheet-fetch workflow needed.
    await loadTimesheetData({ refresh: true });
  } catch (e) {
    toast(`❌ ${e.message}`, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = orig; }
  }
}

// action=calc-save — confirm modal showing viewed-month totals, then
// recompute + persist Draft on DokoKin.
function calcAndSaveTimesheetDraft() {
  if (!sessionToken) { toast('🔒 Unlock first', 'error'); return; }
  if (_tsState.viewYear == null) { toast('❌ No month selected', 'error'); return; }
  if (_tsState.calculatedKey !== _tsKey()) {
    toast('🧮 Bấm Calculate trước', 'warning');
    return;
  }
  const key = _tsKey();
  const snap = _tsState.months[key];
  const s = (snap && snap.summary) || {};
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const monthLabel = `${monthNames[_tsState.viewMonth]} ${_tsState.viewYear}`;
  const rows = [
    ['Working hours', s.displayTotalWorkingHours],
    ['Actual worked', s.displayTotalActualWorkingTime],
    ['OT request', s.displayOTRequestHours],
    ['OT weekday', s.displayOvertimeHours],
    ['OT Sat/Hol', s.displayHolidayOvertimeHours],
    ['OT Sun', s.displaySundayOvertimeHours],
  ];
  const tableRows = rows.map(([k, v]) =>
    `<tr><td style="padding:4px 12px 4px 0;color:var(--muted-foreground)">${k}</td>`
    + `<td style="padding:4px 0;font-family:var(--font-mono);text-align:right">${(v && String(v).trim()) || '—'}</td></tr>`
  ).join('');
  const bodyHTML =
    `<p style="margin:0 0 var(--sp-3);font-size:var(--fs-sm);color:var(--muted-foreground)">`
    + `Recompute &amp; save <strong style="color:var(--foreground)">${monthLabel}</strong> as `
    + `<strong style="color:var(--foreground)">Draft (一時保存)</strong> on DokoKin. `
    + `This will <strong style="color:var(--foreground)">not</strong> submit (申請) — review on DokoKin before submitting.</p>`
    + `<table style="width:100%;border-collapse:collapse;font-size:var(--fs-sm)">${tableRows}</table>`
    + `<p style="margin:var(--sp-3) 0 0;font-size:var(--fs-xs);color:var(--muted-foreground)">`
    + `Pre-save guards run server-side; if anomalies are found the save is blocked and you'll get an email.</p>`;
  UIKit.openSheet({
    title: `Calculate & Save Draft`,
    bodyHTML,
    actions: [
      { label: 'Cancel', variant: 'btn-outline sm' },
      { label: 'Calculate & Save', variant: 'primary', onClick: () => _runCalcSaveTimesheet() },
    ],
  });
}

async function _runCalcSaveTimesheet(opts = {}) {
  const btn = document.getElementById('tsSaveDraftBtn');
  const orig = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `${ICON('refresh', 14, 'animate-spin')} Saving…`;
  }
  try {
    await _dispatchTimesheetAction('calc-save', opts);
    toast('💾 Calculate & Save dispatched — waiting…');
    const run = await _waitForTimesheetActionRun();
    if (run.conclusion !== 'success') {
      throw new Error('Not saved — blocked by guard or error. Check email / Actions.');
    }
    toast('✅ Draft saved on DokoKin — refreshing…', 'success');
    // Action already pushed the saved month into the Gist cache → reload direct.
    await loadTimesheetData({ refresh: true });
  } catch (e) {
    toast(`❌ ${e.message}`, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = orig; }
  }
}

// ─── Skeletons ──────────────────────────────────────
function _tsSummarySkeleton() {
  let chips = '';
  for (let i = 0; i < 8; i++) {
    chips += `<div class="skeleton" style="height:48px;border-radius:var(--radius-md)"></div>`;
  }
  return `<div class="ts-summary-grid">${chips}</div>`;
}

function _tsTableSkeleton(n) {
  let html = '';
  for (let i = 0; i < n; i++) {
    let tds = '';
    for (let j = 0; j < 12; j++) {
      tds += `<td class="px-2 py-2"><div class="skeleton" style="height:12px;width:80%"></div></td>`;
    }
    html += `<tr>${tds}</tr>`;
  }
  return html;
}

// Expose for HTML inline handlers
window.initTimesheetPage = initTimesheetPage;
window.loadTimesheetData = loadTimesheetData;
window.tsNavMonth = tsNavMonth;
window.tsGoToday = tsGoToday;
window.syncTimesheetFromDokoKin = syncTimesheetFromDokoKin;
window.syncPayslipFromFJP = syncPayslipFromFJP;
window.recalcTimesheet = recalcTimesheet;
window.calcAndSaveTimesheetDraft = calcAndSaveTimesheetDraft;
