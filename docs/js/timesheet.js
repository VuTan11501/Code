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
    let raw = null;
    if (f && f.content) {
      try { raw = JSON.parse(f.content); }
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
// `otNormal + otSat + otSun` = total actual OT hours (otMidnight is a subset
// per ot-salary.js — overlaps with the others; don't double-count).
function _calcLostMinForDay(d) {
  const req = _hhmmToMin(d.otRequest);
  if (req <= 0) return 0;
  const actual = _hhmmToMin(d.otNormal) + _hhmmToMin(d.otSat) + _hhmmToMin(d.otSun);
  const gap = req - actual;
  return gap > LOST_OT_TOLERANCE_MIN ? gap : 0;
}

// Yen value of N minutes of lost OT at the base rate (125%).
// Premiums (Sun +10%, Night +25%) ignored on purpose: lost OT could be ANY
// kind, and base is the conservative floor estimate.
function _lostYenFromMin(min) {
  if (!min || !window.OT_SALARY) return 0;
  const S = window.OT_SALARY.SALARY;
  return Math.floor((min / 60) * S.HOURLY_WAGE * S.OT_BASE_RATE);
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
  let totalLostMin = 0;
  const lostDays = [];
  for (const d of details) {
    const lost = _calcLostMinForDay(d);
    if (lost > 0) {
      totalLostMin += lost;
      lostDays.push({ ...d, lostMin: lost });
    }
  }
  const totalLostYen = _lostYenFromMin(totalLostMin);

  // ── Summary card ──
  const s = snap.summary || {};
  const chips = [
    ['Standard', s.displayStandardWorkingHour || '—'],
    ['Working hours', s.displayTotalWorkingHours || '—'],
    ['Actual', s.displayTotalActualWorkingTime || '—'],
    ['OT request', s.displayOTRequestHours || '—'],
    ['OT normal', s.displayWeekdayNormalOvertime || '—'],
    ['OT midnight', s.displayWeekdayLateNightOvertime || '—'],
    ['OT Sat/Hol', s.displayHolidaysWorkingTime || '—'],
    ['OT Sun', s.displaySundayWorkingTime || '—'],
    ['Lack', s.displayWeekdayNoWorkingTime || '—'],
  ];
  let chipsHtml = '';
  for (const [label, val] of chips) {
    chipsHtml += `
      <div class="ts-chip">
        <div class="ts-chip-label">${label}</div>
        <div class="ts-chip-value">${val}</div>
      </div>`;
  }

  let lostHtml = '';
  if (totalLostMin > 0) {
    const yen = '¥' + totalLostYen.toLocaleString('en-US');
    const hhmm = _minToHhmm(totalLostMin);
    lostHtml = `
      <div class="ts-lost-card" role="alert">
        <div class="ts-lost-head">
          <span class="ts-lost-icon">⚠️</span>
          <div>
            <div class="ts-lost-title">Lost OT detected — ${lostDays.length} day${lostDays.length > 1 ? 's' : ''}</div>
            <div class="ts-lost-sub">${hhmm} requested but not recognized → <strong>${yen}</strong> gross (est.)</div>
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
        const lost = _calcLostMinForDay(d);
        const isLost = lost > 0;
        const isToday = d.date === today;
        const dayClass = d.isSunday ? 'ts-dow-sun'
                       : d.isHoliday ? 'ts-dow-hol'
                       : d.isSaturday ? 'ts-dow-sat' : '';
        const rowClass = [
          isLost ? 'ts-row-lost' : '',
          isToday ? 'ts-row-today' : '',
        ].filter(Boolean).join(' ');
        const deltaCell = isLost
          ? `<td class="ts-cell ts-cell-delta text-destructive font-semibold" title="${_minToHhmm(lost)} OT requested but not recognized → ≈ ¥${_lostYenFromMin(lost).toLocaleString('en-US')}">−${_minToHhmm(lost)}</td>`
          : (d.otRequest && _hhmmToMin(d.otRequest) > 0
              ? `<td class="ts-cell ts-cell-delta text-success">✓</td>`
              : `<td class="ts-cell ts-cell-delta text-muted-foreground">—</td>`);
        const dateLabel = d.date ? d.date.slice(5) : '—';   // MM-DD
        rows += `
          <tr class="${rowClass}">
            <td class="ts-cell ts-cell-date">${dateLabel}</td>
            <td class="ts-cell ${dayClass}">${d.dow || ''}</td>
            <td class="ts-cell">${d.in || ''}</td>
            <td class="ts-cell">${d.out || ''}</td>
            <td class="ts-cell text-muted-foreground">${d.break || ''}</td>
            <td class="ts-cell">${d.actualWorking || ''}</td>
            <td class="ts-cell">${d.otNormal || ''}</td>
            <td class="ts-cell">${d.otMidnight || ''}</td>
            <td class="ts-cell">${d.otSat || ''}</td>
            <td class="ts-cell">${d.otSun || ''}</td>
            <td class="ts-cell font-medium">${d.otRequest || ''}</td>
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
  for (let i = 0; i < 9; i++) {
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
