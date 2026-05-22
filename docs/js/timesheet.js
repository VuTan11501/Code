// ═══════════════════════════════════════════════════
//  TIMESHEET VIEWER + LOST-OT DETECTOR
//  Reads `timesheet-history.json` from Gist (populated by
//  .github/workflows/timesheet-fetch.yml). Highlights days where actual
//  recognized working time < OT request → flags "lost OT yen" so user
//  can submit a Working Time Change request before payroll cutoff.
// ═══════════════════════════════════════════════════
const TS_FILE = 'timesheet-history.json';
const TS_FETCH_WF = 'timesheet-fetch.yml';

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
};

// ─── Init ───────────────────────────────────────────
function initTimesheetPage() {
  if (!_tsState.initialized) {
    _tsState.initialized = true;
    const now = jstNow();
    _tsState.viewYear = now.getFullYear();
    _tsState.viewMonth = now.getMonth();
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
  renderTimesheet();
}

function tsGoToday() {
  const now = jstNow();
  _tsState.viewYear = now.getFullYear();
  _tsState.viewMonth = now.getMonth();
  renderTimesheet();
}

// ─── Helpers ────────────────────────────────────────
function _tsKey() {
  return `${_tsState.viewYear}-${String(_tsState.viewMonth + 1).padStart(2, '0')}`;
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

// Lost-OT for one day: requested OT minutes that did NOT get recognized.
// Returns: { lostMin, sundayLostMin, nightLostMin }
//
// • `otNormal + otSat + otSun` = total recognized OT (otMidnight is a subset
//   per ot-salary.js — overlaps with the others; don't double-count).
// • Sunday premium (+10%) applies to entire lost block if isSunday (matches
//   the OT engine, which buckets by REQUEST START DATE day-of-week).
// • Night premium (+25%) applies to the lost portion of midnight hours,
//   computed as max(0, requested midnight − actual midnight recognized).
function _calcLostForDay(d) {
  const req = _hhmmToMin(d.otRequest);
  if (req <= 0) return { lostMin: 0, sundayLostMin: 0, nightLostMin: 0 };
  const actual = _hhmmToMin(d.otNormal) + _hhmmToMin(d.otSat) + _hhmmToMin(d.otSun);
  const gap = req - actual;
  if (gap <= LOST_OT_TOLERANCE_MIN) {
    return { lostMin: 0, sundayLostMin: 0, nightLostMin: 0 };
  }
  // Night portion lost: per-day requested midnight − actual recognized midnight
  // (both are hours floats from the raw API → minutes).
  const reqMidMin    = Math.round((d.otRequestMidNum || 0) * 60);
  const actualMidMin = Math.round((d.actualMidNum    || 0) * 60);
  const nightLostMin = Math.max(0, Math.min(gap, reqMidMin - actualMidMin));
  const sundayLostMin = d.isSunday ? gap : 0;
  return { lostMin: gap, sundayLostMin, nightLostMin };
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

  if (!snap) {
    if (summaryEl) summaryEl.innerHTML = `
      <div class="card bg-card border border-border rounded-lg p-4 text-center text-muted-foreground">
        <div class="text-sm">No timesheet data for ${key}.</div>
        <div class="text-xs mt-1">Click <strong>Sync DokoKin</strong> to pull the latest.</div>
      </div>`;
    if (tableBody) tableBody.innerHTML =
      `<tr><td colspan="12" class="text-center text-muted-foreground py-8">No data</td></tr>`;
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

  // "Billable extra" OT = total OT minus the ~10.24h already covered by the
  // ¥20,000/month fixed allowance. If the result is ≤ 0, no extra is being
  // paid above the fixed amount yet.
  let totalOTSecondary = '';
  if (window.OT_SALARY && totalOTMin > 0) {
    const fixedHoursMin = Math.round(window.OT_SALARY.FIXED_ALLOWANCE_HOURS * 60);
    const billableMin = totalOTMin - fixedHoursMin;
    const fixedHoursLabel = _minToHhmm(fixedHoursMin);
    const billableLabel = billableMin > 0 ? _minToHhmm(billableMin) : `−${_minToHhmm(-billableMin)}`;
    const tip = `Billable extra OT (paid on top of the ¥20,000 fixed allowance). `
              + `Fixed allowance covers ~${fixedHoursLabel} OT (= 20,000 / (1,563 × 1.25)). `
              + (billableMin > 0
                  ? `You're ${billableLabel} above that → extra paid line on payslip.`
                  : `You're still under that — no extra paid OT line this month.`);
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
  let chipsHtml = '';
  for (const [label, val, aux] of chips) {
    chipsHtml += `
      <div class="ts-chip">
        <div class="ts-chip-label">${label}</div>
        <div class="ts-chip-value">${val}${aux || ''}</div>
      </div>`;
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
        if (isLost) {
          const dayYen = _lostYenFromDay(parts);
          const lines = [
            `Lost ${_minToHhmm(lost)} (≈ ¥${dayYen.toLocaleString('en-US')} gross)`,
            `Checkin/out didn't fully cover the OT request range.`,
            `Requested: ${d.otRequest || '—'} · Recognized: ${_minToHhmm(_hhmmToMin(d.otNormal) + _hhmmToMin(d.otSat) + _hhmmToMin(d.otSun))}`,
          ];
          if (parts.sundayLostMin > 0) lines.push(`+10% Sunday on ${_minToHhmm(parts.sundayLostMin)}`);
          if (parts.nightLostMin > 0)  lines.push(`+25% Night on ${_minToHhmm(parts.nightLostMin)}`);
          const tip = lines.join(' · ').replace(/"/g, '&quot;');
          deltaCell = `<td class="ts-cell ts-cell-delta text-destructive font-semibold tooltip-trigger" data-tooltip="${tip}">−${_minToHhmm(lost)}</td>`;
        } else {
          deltaCell = (d.otRequest && _hhmmToMin(d.otRequest) > 0)
            ? `<td class="ts-cell ts-cell-delta text-success tooltip-trigger" data-tooltip="OT request fully covered by checkin/out ✓">✓</td>`
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
    }
  }

  const countEl = document.getElementById('tsRowCount');
  if (countEl) {
    countEl.textContent = `${details.length} day${details.length > 1 ? 's' : ''}` +
      (lostDays.length ? ` · ${lostDays.length} flagged` : '');
  }
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
      body: JSON.stringify({ ref: 'main', inputs: { months_keep: '6' } }),
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
