// ═══════════════════════════════════════════════════
//  OT PLANNER — Manage OT requests + conflict auto-fix
//  Storage: Gist file `ot-requests.json` (same Gist as scheduled-runs.json)
//  Phase 3: schema is {requests: [...], templates: [...]} (legacy array still read).
// ═══════════════════════════════════════════════════
const OT_FILE = 'ot-requests.json';
const PAYSLIP_FILE = 'payslip-history.json';
const OT_CHECKOUT_WF = 'auto-checkout.yml';
const OT_CREATOR_WF = 'auto-ot-creator.yml';
const OT_HISTORY_FETCH_WF = 'ot-history-fetch.yml';
const OT_CREATION_WINDOW_DAYS = 7;   // forward: today + 7 days
const OT_BACKWARD_DAYS = 1;          // backward: today - 1 day (yesterday allowed)

// Built-in templates — merged at render time, not persisted in Gist.
const BUILTIN_TEMPLATES = Object.freeze([
  { id: 'builtin-night',      builtin: true, name: '🌙 Night shift',     start: '22:00', end: '03:30', reason: 'task shishin',         preferredDays: [1,2,3,4,5,6] },
  { id: 'builtin-sunday-12h', builtin: true, name: '☀️ Sunday Full 12h', start: '15:30', end: '03:30', reason: 'Sunday OT — full day', preferredDays: [0] },
  { id: 'builtin-weekend-evening', builtin: true, name: '🌆 Weekend evening', start: '18:00', end: '23:30', reason: 'Weekend OT', preferredDays: [0,6] },
]);

let _otState = {
  initialized: false,
  requests: [],          // array of OT entries
  templates: [],         // user-defined templates (Gist-persisted)
  scheduleEntries: [],   // cached scheduled-runs.json (for conflict checks)
  payslips: [],          // parsed payslip-history.json {payslips:[...]}
  viewYear: null,
  viewMonth: null,       // 0-indexed
  editId: null,
  optimizerResults: [],  // last optimizer suggestions (in-memory)
};

// ─── Init ───
function initOtPlannerPage() {
  if (!_otState.initialized) {
    _otState.initialized = true;
    const now = jstNow();
    _otState.viewYear = now.getFullYear();
    _otState.viewMonth = now.getMonth();
    // Click delegation for take-home widget → open payslip detail modal
    document.addEventListener('click', (e) => {
      const tgt = e.target.closest('.ot-takehome-clickable');
      if (tgt) {
        e.preventDefault();
        const month = tgt.getAttribute('data-payslip-month');
        const isEst = tgt.getAttribute('data-payslip-estimate') === '1';
        openPayslipDetail(month, isEst);
      }
    });
  }
  loadOtData();
}

async function loadOtData(opts) {
  const isManualRefresh = !!(opts && opts.refresh);
  const grid = document.getElementById('otCalendar');
  const tbody = document.getElementById('otTableBody');
  const hasData = Array.isArray(_otState.requests) && _otState.requests.length > 0;
  // Show skeleton only on initial load (when no data exists yet).
  // On manual refresh, keep current rows visible to avoid layout jump.
  if (!hasData) {
    if (grid) grid.innerHTML = _otCalendarSkeleton();
    if (tbody) tbody.innerHTML = _otTableSkeleton(6);
    const statsEl = document.getElementById('otStats');
    if (statsEl && !statsEl.children.length) statsEl.innerHTML = _otStatsSkeleton();
    const budgetEl = document.getElementById('otBudget');
    if (budgetEl && !budgetEl.children.length) budgetEl.innerHTML = _otBudgetSkeleton();
  }
  const refreshBtn = document.getElementById('otRefreshBtn');
  if (isManualRefresh && refreshBtn) refreshBtn.classList.add('is-loading');
  try {
    const gist = await apiFetch(`/gists/${GIST_ID}`);
    // OT requests file — Phase 3 wrapper {requests, templates} OR legacy array.
    const otFile = gist.files && gist.files[OT_FILE];
    let raw = null;
    const otContent = window.readGistFile ? await window.readGistFile(otFile) : (otFile && otFile.content) || '';
    if (otContent) {
      try { raw = JSON.parse(otContent); }
      catch { raw = null; }
    }
    if (Array.isArray(raw)) {
      _otState.requests = raw;
      _otState.templates = [];
    } else if (raw && typeof raw === 'object') {
      _otState.requests = Array.isArray(raw.requests) ? raw.requests : [];
      _otState.templates = Array.isArray(raw.templates) ? raw.templates : [];
    } else {
      _otState.requests = [];
      _otState.templates = [];
    }
    // Scheduled entries (for conflict detection)
    const schedFile = gist.files && gist.files['scheduled-runs.json'];
    const schedContent = window.readGistFile ? await window.readGistFile(schedFile) : (schedFile && schedFile.content) || '';
    if (schedContent) {
      try {
        const parsed = JSON.parse(schedContent) || [];
        // Defensive: accept both bare array (current) and {entries:[...]} wrapper
        _otState.scheduleEntries = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.entries) ? parsed.entries : []);
      }
      catch { _otState.scheduleEntries = []; }
    } else {
      _otState.scheduleEntries = [];
    }
    // Payslip history (for real net take-home display)
    const payFile = gist.files && gist.files[PAYSLIP_FILE];
    const payContent = window.readGistFile ? await window.readGistFile(payFile) : (payFile && payFile.content) || '';
    if (payContent) {
      try {
        const parsed = JSON.parse(payContent) || {};
        _otState.payslips = Array.isArray(parsed.payslips) ? parsed.payslips : [];
      }
      catch { _otState.payslips = []; }
    } else {
      _otState.payslips = [];
    }
    renderOtCalendar();
    renderOtList();
  } catch (e) {
    if (!hasData) {
      if (grid) grid.innerHTML = `<div class="empty text-destructive text-sm p-5 text-center">Failed to load: ${e.message}</div>`;
      if (tbody) tbody.innerHTML = `<tr><td colspan="8" class="text-center text-destructive py-6">Failed: ${e.message}</td></tr>`;
    } else {
      toast(`❌ Refresh failed: ${e.message}`, 'error');
    }
  } finally {
    if (refreshBtn) refreshBtn.classList.remove('is-loading');
  }
}

// ─── Skeleton loaders ───
function _otCalendarSkeleton() {
  const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  let html = '<div class="ot-cal-header">';
  for (const dn of dayNames) html += `<div class="ot-cal-dn">${dn}</div>`;
  html += '</div><div class="ot-cal-body">';
  for (let i = 0; i < 35; i++) html += '<div class="ot-cell skeleton" style="opacity:0.55"></div>';
  html += '</div>';
  return html;
}

function _otTableSkeleton(rows) {
  const widths = ['18px', '70px', '90px', '32px', '60px', '55%', '90px', '110px'];
  let html = '';
  for (let r = 0; r < rows; r++) {
    let tds = '';
    widths.forEach((w) => {
      tds += `<td class="px-4 py-3"><div class="skeleton" style="height:14px;width:${w};max-width:100%"></div></td>`;
    });
    html += `<tr>${tds}</tr>`;
  }
  return html;
}

function _otStatsSkeleton() {
  let chips = '';
  for (let i = 0; i < 4; i++) {
    chips += `<div class="skeleton" style="height:28px;width:${80 + i * 20}px;border-radius:var(--radius-full)"></div>`;
  }
  return `<div class="flex flex-wrap gap-2">${chips}</div>`;
}

function _otBudgetSkeleton() {
  return `<div class="card bg-card border border-border rounded-lg p-4 mb-4">
    <div class="flex items-center justify-between mb-3">
      <div class="skeleton" style="height:16px;width:120px"></div>
      <div class="skeleton" style="height:16px;width:80px"></div>
    </div>
    <div class="skeleton" style="height:8px;width:100%;border-radius:var(--radius-full);margin-bottom:12px"></div>
    <div class="flex gap-4">
      <div class="skeleton" style="height:32px;width:33%;border-radius:var(--radius-md)"></div>
      <div class="skeleton" style="height:32px;width:33%;border-radius:var(--radius-md)"></div>
      <div class="skeleton" style="height:32px;width:33%;border-radius:var(--radius-md)"></div>
    </div>
  </div>`;
}

// ─── Calendar render ───
function otNavMonth(delta) {
  let y = _otState.viewYear;
  let m = _otState.viewMonth + delta;
  while (m < 0) { m += 12; y -= 1; }
  while (m > 11) { m -= 12; y += 1; }
  _otState.viewYear = y;
  _otState.viewMonth = m;
  renderOtCalendar();
  renderOtList();
}

function otGoToday() {
  const now = jstNow();
  _otState.viewYear = now.getFullYear();
  _otState.viewMonth = now.getMonth();
  renderOtCalendar();
  renderOtList();
}

function _otCreationWindow() {
  // DokoKin OT API rule: window = [today - 1 day, today + 7 days].
  // The overtime request only accepts 1 day backward (yesterday is OK).
  const now = jstNow();
  const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  const min = new Date(now); min.setDate(min.getDate() - OT_BACKWARD_DAYS);
  const minStr = `${min.getFullYear()}-${String(min.getMonth()+1).padStart(2,'0')}-${String(min.getDate()).padStart(2,'0')}`;
  const max = new Date(now); max.setDate(max.getDate() + OT_CREATION_WINDOW_DAYS);
  const maxStr = `${max.getFullYear()}-${String(max.getMonth()+1).padStart(2,'0')}-${String(max.getDate()).padStart(2,'0')}`;
  return { today, minStr, maxStr, maxDays: OT_CREATION_WINDOW_DAYS, backwardDays: OT_BACKWARD_DAYS };
}

function _addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
}

function _daysBetween(fromStr, toStr) {
  const [y1, m1, d1] = fromStr.split('-').map(Number);
  const [y2, m2, d2] = toStr.split('-').map(Number);
  const a = new Date(y1, m1 - 1, d1).getTime();
  const b = new Date(y2, m2 - 1, d2).getTime();
  return Math.round((b - a) / 86400000);
}

function _nextAutoCreateTime() {
  // Auto OT Creator workflow runs daily at 10:00 JST. Return next occurrence.
  const now = jstNow();
  const next = new Date(now);
  next.setHours(10, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next;
}

function _humanizeUntil(target) {
  const now = jstNow();
  const diffMin = Math.max(0, Math.round((target - now) / 60000));
  if (diffMin < 60) return `${diffMin}m`;
  const h = Math.round(diffMin / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  return `${d}d`;
}

function _isDateInWindow(dateStr) {
  const w = _otCreationWindow();
  return dateStr >= w.minStr && dateStr <= w.maxStr;
}

function _showOutOfWindowToast(dateStr) {
  const w = _otCreationWindow();
  const isPast = dateStr < w.minStr;
  if (isPast) {
    toast(`📅 ${dateStr} quá cũ — DokoKin chỉ tạo OT ngược tối đa 1 ngày (từ ${w.minStr} trở đi)`, 'warning');
  } else {
    toast(`📅 ${dateStr} vượt cửa sổ 7 ngày — chỉ có thể tạo OT đến ${w.maxStr}`, 'warning');
  }
}

// ─── Read-only mode for past-month views ───
// DokoKin only accepts OT changes from yesterday onward, so when the user
// navigates the calendar to a past month, hide mutation actions to make
// the view clearly "history-only".
function _isViewMonthPast() {
  const now = jstNow();
  const curY = now.getFullYear();
  const curM = now.getMonth();
  const vY = _otState.viewYear;
  const vM = _otState.viewMonth;
  if (vY == null || vM == null) return false;
  return (vY < curY) || (vY === curY && vM < curM);
}

function _updateOtMutationButtons() {
  const isPast = _isViewMonthPast();
  const ids = ['otAddBtn', 'otOptBtn', 'otTplBtn', 'otSyncBtn'];
  const tip = 'View only — past month. Switch to current/future month to edit.';
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (isPast) {
      el.setAttribute('disabled', '');
      el.classList.add('is-readonly');
      el.setAttribute('data-tooltip', tip);
    } else {
      el.removeAttribute('disabled');
      el.classList.remove('is-readonly');
      // Restore original tooltips
      if (id === 'otAddBtn') el.removeAttribute('data-tooltip');
      if (id === 'otOptBtn') el.setAttribute('data-tooltip', 'Suggest optimal OT schedule for this month');
      if (id === 'otTplBtn') el.setAttribute('data-tooltip', 'Manage OT templates');
      if (id === 'otSyncBtn') el.setAttribute('data-tooltip', 'Trigger Auto OT Creator now (~60–90s)');
    }
  }
  // Refresh button — relabel to "Pull from DokoKin" in past-month view
  const refreshBtn = document.getElementById('otRefreshBtn');
  if (refreshBtn) {
    if (isPast) {
      refreshBtn.innerHTML = `${ICON('refresh', 14)} Pull from DokoKin`;
      refreshBtn.setAttribute('data-tooltip', 'Fetch fresh OT data from DokoKin API for this month');
    } else {
      refreshBtn.innerHTML = `${ICON('refresh', 14)} Refresh`;
      refreshBtn.setAttribute('data-tooltip', 'Refresh from Gist');
    }
  }
}

// Smart refresh: past months pull fresh data from DokoKin via the
// ot-history-fetch workflow; current/future months just re-read the Gist
// (which is updated continuously by Auto OT Creator).
async function refreshOtData() {
  const btn = document.getElementById('otRefreshBtn');
  const origHtml = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `${ICON('refresh', 14, 'animate-spin')} Refreshing…`;
  }
  try {
    if (_isViewMonthPast()) {
      await pullOtFromDokoKin();
    } else {
      await loadOtData({ refresh: true });
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origHtml;
    }
  }
}

async function pullOtFromDokoKin() {
  if (typeof sessionToken === 'undefined' || !sessionToken) {
    toast('⚠️ Not authenticated', 'error');
    return;
  }
  const now = jstNow();
  // How many months back from current month to the view month, +1 to include
  // current month (the script always re-fetches the current month anyway).
  const monthsBack = (now.getFullYear() - _otState.viewYear) * 12 +
                     (now.getMonth() - _otState.viewMonth) + 1;
  const btn = document.getElementById('otRefreshBtn');
  const origHtml = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `${ICON('refresh', 14, 'animate-spin')} Pulling…`;
  }
  _showOtPullOverlay(`Pulling ${monthsBack} month${monthsBack > 1 ? 's' : ''} from DokoKin…`);
  try {
    const res = await fetch(`${API}/repos/${OWNER}/${REPO}/actions/workflows/${OT_HISTORY_FETCH_WF}/dispatches`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${sessionToken}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ref: 'main',
        inputs: {
          months_back: String(monthsBack),
          clean_seeds: 'false',
          fetch_timesheet: 'true',
        },
      }),
    });
    if (res.status !== 204) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${body ? ': ' + body.slice(0, 80) : ''}`);
    }
    toast(`☁️ Pull dispatched (${monthsBack}mo) — waiting for workflow…`);
    // Poll the workflow run until it completes, then reload Gist.
    await _waitForOtHistoryFetchRun();
    await loadOtData({ refresh: true });
    toast('✅ Synced from DokoKin', 'success');
  } catch (e) {
    toast(`❌ Pull failed: ${e.message}`, 'error');
  } finally {
    _hideOtPullOverlay();
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origHtml;
    }
  }
}

// Poll the latest OT History Fetch run until it leaves "in_progress"/"queued".
// Returns when the run completes (success or failure). Times out at 3 min.
async function _waitForOtHistoryFetchRun() {
  const overlay = document.getElementById('otPullOverlay');
  const start = Date.now();
  const TIMEOUT_MS = 3 * 60 * 1000;
  // Brief delay so the dispatch propagates into a visible run
  await new Promise(r => setTimeout(r, 4000));
  while (Date.now() - start < TIMEOUT_MS) {
    try {
      const data = await apiFetch(`/repos/${OWNER}/${REPO}/actions/workflows/${OT_HISTORY_FETCH_WF}/runs?per_page=1&event=workflow_dispatch`);
      const run = data && data.workflow_runs && data.workflow_runs[0];
      if (run) {
        const elapsed = Math.floor((Date.now() - start) / 1000);
        if (overlay) {
          const sub = overlay.querySelector('.spinner-overlay-sub');
          if (sub) sub.textContent = `Run #${run.run_number} · ${run.status} · ${elapsed}s`;
        }
        if (run.status === 'completed') return run;
      }
    } catch { /* ignore transient errors */ }
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error('Timed out waiting for OT History Fetch run');
}

function _showOtPullOverlay(label) {
  let overlay = document.getElementById('otPullOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'otPullOverlay';
    overlay.className = 'spinner-overlay';
    overlay.innerHTML = `
      <div class="spinner-overlay-content">
        <div class="spinner-ring" role="status" aria-label="Loading"></div>
        <div class="spinner-overlay-label"></div>
        <div class="spinner-overlay-sub text-xs text-muted-foreground"></div>
      </div>`;
    // Mount inside the OT page so it overlays only that area
    const otPage = document.getElementById('page-ot') || document.body;
    otPage.appendChild(overlay);
  }
  const lbl = overlay.querySelector('.spinner-overlay-label');
  if (lbl) lbl.textContent = label || 'Loading…';
  const sub = overlay.querySelector('.spinner-overlay-sub');
  if (sub) sub.textContent = 'Dispatching workflow…';
  overlay.classList.add('open');
}

function _hideOtPullOverlay() {
  const overlay = document.getElementById('otPullOverlay');
  if (overlay) overlay.classList.remove('open');
}

function renderOtCalendar() {
  const grid = document.getElementById('otCalendar');
  if (!grid) return;
  renderOtStats();
  renderOtBudget();
  _updateOtMutationButtons();
  const y = _otState.viewYear, m = _otState.viewMonth;
  const monthLabel = document.getElementById('otMonthLabel');
  const monthName = new Date(y, m, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
  if (monthLabel) monthLabel.textContent = monthName;

  const firstDow = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const todayJ = jstNow();
  const isCurrentMonth = todayJ.getFullYear() === y && todayJ.getMonth() === m;
  const win = _otCreationWindow();

  const byDate = {};
  _otState.requests.forEach(ot => {
    if (!byDate[ot.date]) byDate[ot.date] = [];
    byDate[ot.date].push(ot);
  });

  const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  let html = '<div class="ot-cal-header">';
  for (const dn of dayNames) html += `<div class="ot-cal-dn">${dn}</div>`;
  html += '</div><div class="ot-cal-body">';

  for (let i = 0; i < firstDow; i++) html += '<div class="ot-cell ot-cell-empty"></div>';
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const ots = byDate[dateStr] || [];
    const isToday = isCurrentMonth && todayJ.getDate() === d;
    const inWindow = _isDateInWindow(dateStr);
    const isPast = dateStr < win.today;
    const isPastMonth = _isViewMonthPast();
    const classes = ['ot-cell'];
    if (ots.length) classes.push('has-ot');
    if (isToday) classes.push('is-today');
    if (!inWindow) classes.push('is-disabled');
    if (isPast) classes.push('is-past');
    const totalH = ots.reduce((s, o) => s + (o.hours || 0), 0);
    const hasConflict = ots.some(o => detectConflict(o).hasConflict);
    if (hasConflict) classes.push('has-conflict');
    let click;
    if (isPastMonth) {
      click = ots.length
        ? `toast('📅 ${dateStr}: ${ots.length} OT entr${ots.length === 1 ? 'y' : 'ies'} (past month, view only)', 'info')`
        : `toast('📅 Past month — view only', 'info')`;
    } else {
      if (ots.length) {
        // Day already has OT → edit the first one (use table or Add button for a 2nd entry)
        click = `openOtForm(null, '${ots[0].id}')`;
      } else {
        click = inWindow
          ? `openOtForm('${dateStr}')`
          : `_showOutOfWindowToast('${dateStr}')`;
      }
    }
    const label = `${dateStr}${ots.length ? `, ${ots.length} OT` : ''}${!inWindow && !ots.length ? ' (không thể tạo)' : ''}`;
    html += `<div class="${classes.join(' ')}" onclick="${click}" role="button" tabindex="0" aria-label="${label}" aria-disabled="${!inWindow && !ots.length}">`;
    html += `<div class="ot-cell-num">${d}</div>`;
    if (ots.length) {
      html += `<div class="ot-badge" title="${totalH}h total">${totalH}h</div>`;
      if (hasConflict) html += `<div class="ot-cell-warn" title="Conflict detected">${ICON('alertTriangle', 11)}</div>`;
    }
    html += '</div>';
  }
  html += '</div>';
  grid.innerHTML = html;
}

// ─── Table render ───
function renderOtList() {
  const tbody = document.getElementById('otTableBody');
  const countEl = document.getElementById('otTableCount');
  if (!tbody) return;
  const w = _otCreationWindow();
  const minStr = w.minStr;

  // Filter to the currently viewed month
  const y = _otState.viewYear, m = _otState.viewMonth;
  const monthPrefix = `${y}-${String(m + 1).padStart(2, '0')}-`;
  const monthName = new Date(y, m, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
  const inMonth = (_otState.requests || []).filter(o => o.date && o.date.startsWith(monthPrefix));

  // Within the month: actionable (date >= yesterday) first, then past
  const upcoming = inMonth
    .filter(o => o.date >= minStr)
    .sort((a,b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
  const past = inMonth
    .filter(o => o.date < minStr)
    .sort((a,b) => b.date.localeCompare(a.date));
  const all = [...upcoming, ...past];

  if (countEl) {
    const created = inMonth.filter(o => !!o.kintai_created_at).length;
    countEl.textContent = `${all.length} entr${all.length === 1 ? 'y' : 'ies'} in ${monthName} (${created} created)`;
  }

  if (!all.length) {
    tbody.innerHTML = `
      <tr><td colspan="8" class="text-center text-muted-foreground py-10">
        <div class="text-base font-semibold mb-1" style="color:var(--foreground)">No OT requests in ${monthName}</div>
        <div class="text-sm mb-4">Plan a new OT block or pull existing ones from DokoKin.</div>
        <div class="flex gap-2 justify-center flex-wrap">
          <button class="btn primary sm" onclick="openOtForm && openOtForm()"><span data-icon="plus" data-size="14"></span> Add OT</button>
          <button class="btn sm" onclick="syncOtWithDokoKin && syncOtWithDokoKin()"><span data-icon="sparkles" data-size="14"></span> Sync DokoKin</button>
        </div>
      </td></tr>`;
    if (typeof renderIcons === 'function') renderIcons();
    return;
  }

  tbody.innerHTML = all.map((ot, idx) => _renderOtRow(ot, idx, ot.date < minStr)).join('');
}

function _renderOtRow(ot, idx, isPast) {
  const conf = detectConflict(ot);
  const crossMid = ot.end < ot.start;
  const dayName = new Date(ot.date + 'T00:00:00+09:00').toLocaleString('en-US', { weekday: 'short' });
  const fixed = !!ot.auto_co_id;
  const created = !!ot.kintai_created_at;
  const inWindow = _isDateInWindow(ot.date);

  // Status badge palette aligned with Schedule tab tokens:
  //   blue (badge-once)        = upcoming / will-fire (Pending in window, Queued out of window)
  //   green (badge-enabled)    = active in DokoKin (Created)
  //   purple (badge-recurring) = system-generated artifact (Auto-fixed CO)
  //   yellow (badge-warning)   = needs attention (Conflict)
  //   grey (badge-disabled)    = past / inactive
  let statusBadge;
  if (isPast) {
    if (created) {
      const ts = String(ot.kintai_created_at).slice(0, 16).replace('T', ' ');
      statusBadge = `<span class="badge-disabled" data-tooltip="Was created in DokoKin at ${_esc(ts)} JST">${ICON('check', 11)} Past · Created</span>`;
    } else {
      statusBadge = `<span class="badge-disabled" data-tooltip="Past date — not actionable">${ICON('check', 11)} Past</span>`;
    }
  } else if (conf.hasConflict) {
    statusBadge = `<span class="badge-warning" data-tooltip="${_esc(conf.message)}">${ICON('alertTriangle', 11)} Conflict</span>`;
  } else if (created) {
    const ts = String(ot.kintai_created_at).slice(0, 16).replace('T', ' ');
    statusBadge = `<span class="badge-enabled" data-tooltip="Created in DokoKin at ${_esc(ts)} JST">${ICON('check', 11)} Created</span>`;
  } else if (fixed) {
    statusBadge = `<span class="badge-recurring" data-tooltip="Cross-midnight CO auto-scheduled">${ICON('sparkles', 11)} Auto-fixed</span>`;
  } else if (inWindow) {
    // In creation window — normally will be auto-created at next 10:00 JST run.
    // BUT if the OT start time has already passed (or is imminent within 60min),
    // waiting until tomorrow 10:00 is wasteful — prompt the user to sync now.
    const next = _nextAutoCreateTime();
    const until = _humanizeUntil(next);
    const tipTs = `${next.getFullYear()}-${String(next.getMonth()+1).padStart(2,'0')}-${String(next.getDate()).padStart(2,'0')} 10:00 JST`;
    const startDt = new Date(`${ot.date}T${ot.start}:00+09:00`);
    const now = jstNow();
    const minsUntilStart = (startDt - now) / 60000;
    if (minsUntilStart <= 60) {
      statusBadge = `<span class="badge-warning" role="button" tabindex="0"
        onclick="syncOtWithDokoKin()" style="cursor:pointer"
        data-tooltip="OT start time is past or imminent — click to push to DokoKin now (next auto-run is at ${_esc(tipTs)})"
        >${ICON('alertTriangle', 11)} Sync now</span>`;
    } else {
      statusBadge = `<span class="badge-once" data-tooltip="Will auto-create on ${_esc(tipTs)} via Auto OT Creator">${ICON('hourglass', 11)} Pending · auto in ${until}</span>`;
    }
  } else {
    // Outside 7-day window — queued, becomes eligible (date - 7 days)
    const eligible = _addDays(ot.date, -OT_CREATION_WINDOW_DAYS);
    const todayStr = _todayJSTStr();
    const daysUntil = Math.max(1, _daysBetween(todayStr, eligible));
    statusBadge = `<span class="badge-once" style="opacity:0.75" data-tooltip="Eligible from ${_esc(eligible)} — auto-creates that morning at 10:00 JST">${ICON('clock', 11)} Queued · in ${daysUntil}d</span>`;
  }

  const timeCell = `${ot.start} <span class="text-muted-foreground">→</span> ${ot.end}` +
    (crossMid ? ` <span class="text-purple" style="color:var(--purple);font-size:10px">+1d</span>` : '');

  const reasonRaw = ot.reason || '—';
  const reasonCell = reasonRaw.length <= 30
    ? _esc(reasonRaw)
    : `<span class="tooltip-trigger" tabindex="0" data-tooltip="${_esc(reasonRaw)}" aria-label="${_esc(reasonRaw)}">${_esc(reasonRaw.slice(0, 30))}…</span>`;

  const fixBtn = (!isPast && conf.canAutoFix && !fixed)
    ? `<button class="btn sm" style="color:var(--orange);border-color:rgba(249,115,22,0.32)" onclick="autoFixOtConflict('${ot.id}')" data-tooltip="Auto-fix conflict">${ICON('sparkles', 14)}</button>`
    : '';

  const delTip = isPast
    ? (created
        ? 'Delete (local entry only — already pushed to DokoKin; manually remove there if needed)'
        : 'Delete past entry')
    : 'Delete';
  const actionsCell = isPast
    ? `<div class="actions-cell">
        <span class="badge-readonly" data-tooltip="Past month — view only">${ICON('eye', 14)}</span>
        <button class="btn danger sm" onclick="deleteOtRequest('${ot.id}')" data-tooltip="${_esc(delTip)}">${ICON('trash', 14)}</button>
      </div>`
    : `<div class="actions-cell">
        ${fixBtn}
        <button class="btn sm" onclick="openOtForm(null, '${ot.id}')" data-tooltip="Edit">${ICON('edit', 14)}</button>
        <button class="btn danger sm" onclick="deleteOtRequest('${ot.id}')" data-tooltip="Delete">${ICON('trash', 14)}</button>
      </div>`;

  return `<tr${isPast ? ' class="opacity-60"' : ''}>
    <td data-label="#" class="text-muted-foreground font-mono">${idx + 1}</td>
    <td data-label="Date">
      <div class="flex flex-col leading-tight">
        <span class="font-mono">${ot.date}</span>
        <span class="text-xs text-muted-foreground">${dayName}</span>
      </div>
    </td>
    <td data-label="Time" class="font-mono text-xs">${timeCell}</td>
    <td data-label="Hours" class="font-mono font-medium">${ot.hours}h</td>
    <td data-label="Income" class="font-mono text-right" data-tooltip="${_esc(_otIncomeTooltip(ot))}">${_otIncomeCell(ot)}</td>
    <td data-label="Reason" class="text-muted-foreground">${reasonCell}</td>
    <td data-label="Status">${statusBadge}</td>
    <td class="actions-cell">${actionsCell}</td>
  </tr>`;
}

function _esc(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function _todayJSTStr() {
  const n = jstNow();
  return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`;
}

// ─── Conflict detection ───
// Returns { hasConflict, message, canAutoFix, schedIdx, targetDate, coTime }
function detectConflict(ot) {
  if (!ot || !ot.date || !ot.start || !ot.end) return { hasConflict: false };
  const crossMid = ot.end < ot.start;
  if (!crossMid) {
    // Same-day OT: check if any recurring CO falls within [start, end]
    const block = _findCoInRange(ot.date, ot.start, ot.end);
    if (block) {
      return { hasConflict: true, canAutoFix: false,
        message: `Recurring CO at ${block.time} falls inside OT window (${ot.start}-${ot.end}). Will close session early.` };
    }
    return { hasConflict: false };
  }
  // Cross-midnight: end time on next day
  const target = _nextDateStr(ot.date);
  // Check for any recurring CO on ot.date between [start..23:59] OR between [00:00..end] on target
  // The dangerous one is the recurring 18:00 CO on ot.date (closes session before OT starts logging end-time)
  // More precisely: any recurring CO on ot.date that fires AFTER work was open (CI happened already)
  // Use heuristic: any recurring CO on ot.date with time < ot.start AND time >= "12:00" (i.e. afternoon CO)
  // OR with time between [00:00, end] on target_date (would close before OT ends)
  let earlyCo = null;
  for (const e of _otState.scheduleEntries) {
    if (e.type !== 'recurring' || e.workflow !== OT_CHECKOUT_WF || e.enabled === false) continue;
    const r = e.recurrence || {};
    if (!_matchesPattern(r, ot.date)) continue;
    if (r.skip_dates && r.skip_dates.includes(ot.date)) continue;
    const t = r.time || '';
    // CO time on ot.date AFTER noon AND BEFORE ot.start → will close session early
    if (t >= '12:00' && t < ot.start) {
      earlyCo = { time: t, entry: e };
      break;
    }
  }
  if (earlyCo) {
    return {
      hasConflict: true, canAutoFix: true,
      schedIdx: _otState.scheduleEntries.indexOf(earlyCo.entry),
      targetDate: target, coTime: ot.end, ot,
      message: `Recurring CO at ${earlyCo.time} on ${ot.date} will end work BEFORE OT (${ot.start}). Auto-fix: skip ${ot.date} + add once-CO at ${target} ${ot.end}.`,
    };
  }
  // No conflict but cross-midnight → still informational (already handled by Night OT CO)
  return { hasConflict: false };
}

function _findCoInRange(dateStr, startHHMM, endHHMM) {
  for (const e of _otState.scheduleEntries) {
    if (e.type !== 'recurring' || e.workflow !== OT_CHECKOUT_WF || e.enabled === false) continue;
    const r = e.recurrence || {};
    if (!_matchesPattern(r, dateStr)) continue;
    if (r.skip_dates && r.skip_dates.includes(dateStr)) continue;
    const t = r.time || '';
    if (t > startHHMM && t <= endHHMM) return { time: t, entry: e };
  }
  return null;
}

function _matchesPattern(r, dateStr) {
  const d = new Date(dateStr + 'T00:00:00+09:00');
  const dow = d.getDay();
  const date = d.getDate();
  if (r.pattern === 'daily') return true;
  if (r.pattern === 'weekdays') return dow >= 1 && dow <= 5;
  if (r.pattern === 'weekly') return (r.days || []).includes(dow);
  if (r.pattern === 'monthly') return (r.dates || []).includes(date);
  return false;
}

function _nextDateStr(dateStr) {
  const d = new Date(dateStr + 'T00:00:00+09:00');
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// ─── Modal ───
function openOtForm(dateStr, existingId) {
  const modal = document.getElementById('otFormModal');
  if (!modal) return;
  _otState.editId = existingId || null;
  document.getElementById('otFormTitle').textContent = existingId ? 'Edit OT Request' : 'New OT Request';
  // Constrain date input to creation window (only for new entries)
  const dateInput = document.getElementById('otFormDate');
  const win = _otCreationWindow();
  if (existingId) {
    // editing — allow any date (past included for delete/fix scenarios)
    dateInput.removeAttribute('min');
    dateInput.removeAttribute('max');
  } else {
    dateInput.min = win.today;
    dateInput.max = win.maxStr;
  }
  if (existingId) {
    const ot = _otState.requests.find(o => o.id === existingId);
    if (!ot) return;
    document.getElementById('otFormDate').value = ot.date;
    document.getElementById('otFormStart').value = ot.start;
    document.getElementById('otFormEnd').value = ot.end;
    document.getElementById('otFormReason').value = ot.reason || '';
  } else {
    const initial = (dateStr && _isDateInWindow(dateStr)) ? dateStr : win.today;
    document.getElementById('otFormDate').value = initial;
    document.getElementById('otFormStart').value = '22:00';
    document.getElementById('otFormEnd').value = '03:30';
    document.getElementById('otFormReason').value = '';
  }
  _updateOtFormPreview();
  refreshOtFormTemplateDropdown();
  modal.classList.add('open');
}

function closeOtForm() {
  const m = document.getElementById('otFormModal');
  if (m) m.classList.remove('open');
  _otState.editId = null;
}

function _computeHours(start, end) {
  if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) return 0;
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  let mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins <= 0) mins += 24 * 60; // cross-midnight
  return Math.round(mins / 6) / 10; // round to 0.1h
}

function _updateOtFormPreview() {
  const start = document.getElementById('otFormStart').value;
  const end = document.getElementById('otFormEnd').value;
  const date = document.getElementById('otFormDate').value;
  const hours = _computeHours(start, end);
  const crossMid = end < start;
  const hoursEl = document.getElementById('otFormHours');
  if (hoursEl) hoursEl.textContent = hours ? `${hours}h` : '—';
  // Conflict preview
  const preview = document.getElementById('otFormPreview');
  if (preview && date && start && end) {
    const fake = { id: 'preview', date, start, end, hours };
    const conf = detectConflict(fake);
    if (conf.hasConflict) {
      preview.innerHTML = `<div class="ot-form-warn">${ICON('alertTriangle', 13)} <span>${_esc(conf.message)}</span></div>`;
    } else if (crossMid) {
      preview.innerHTML = `<div class="ot-form-info">${ICON('moon', 13)} Cross-midnight: ends ${_nextDateStr(date)} ${end}</div>`;
    } else {
      preview.innerHTML = '';
    }
  }
  _renderOtFormIncome(date, start, end, hours);
}

// ─── Income preview + suggest-best-slot ───────────────────────────
function _renderOtFormIncome(date, start, end, hours) {
  const el = document.getElementById('otFormIncome');
  if (!el) return;
  const S = window.OT_SALARY;
  if (!S || !date || !start || !end || !hours || hours <= 0) {
    el.className = 'ot-form-income is-empty';
    el.innerHTML = `${ICON('calculator', 13)} <span>Pick date + start/end to estimate OT income</span>`;
    return;
  }
  let br;
  try {
    br = S.calcOtBreakdown({ date, start, end, hours });
  } catch (e) {
    el.className = 'ot-form-income is-empty';
    el.innerHTML = `<span style="color:var(--red)">Income calc failed: ${_esc(e.message)}</span>`;
    return;
  }
  // Find best alternative slot at the same duration
  const best = _findBestOtSlot(date, hours);
  const uplift = best && best.gross > br.gross ? best.gross - br.gross : 0;
  const upliftPct = br.gross > 0 ? (uplift / br.gross * 100) : 0;
  const yen = S.formatYen;
  const sameAsCurrent = best && best.start === start && best.end === end;

  el.className = 'ot-form-income';
  el.innerHTML = `
    <div class="ot-form-income-header">
      <span>${ICON('coins', 14)} <strong>Estimated income</strong></span>
      <span class="ot-form-income-gross">${yen(br.gross)}</span>
    </div>
    <div class="ot-form-income-rows">
      <span class="lbl">Base OT (125%)</span><span class="hrs">${br.totalHours.toFixed(2)}h</span><span class="yen">${yen(Math.floor(br.baseOT))}</span>
      ${br.nightHours > 0 ? `<span class="lbl">+ Night (22-05)</span><span class="hrs">${br.nightHours.toFixed(2)}h</span><span class="yen">+${yen(Math.floor(br.nightPremium))}</span>` : ''}
      ${br.sundayHours > 0 ? `<span class="lbl">+ Sunday all-day</span><span class="hrs">${br.sundayHours.toFixed(2)}h</span><span class="yen">+${yen(Math.floor(br.sundayPremium))}</span>` : ''}
    </div>
    <div class="ot-form-income-suggest">
      <div class="ot-form-income-suggest-info">
        ${sameAsCurrent
          ? `✅ Already the highest-paying ${hours}h slot for this date`
          : best
            ? `Best ${hours}h slot: <strong>${best.start}→${best.end}</strong> → ${yen(best.gross)} <span class="ot-form-income-uplift">(+${yen(uplift)}, +${upliftPct.toFixed(1)}%)</span>`
            : `No alternative slot found`}
      </div>
      <button type="button" class="btn-suggest" onclick="applyOtBestSlot()" ${(!best || sameAsCurrent) ? 'disabled' : ''}>💡 Apply</button>
    </div>
  `;
}

// Brute-force search: try every 15-min start, same duration as current,
// pick the start that yields max gross income. Cheap enough (~96 candidates).
function _findBestOtSlot(date, hours) {
  const S = window.OT_SALARY;
  if (!S || !date || !hours || hours <= 0) return null;
  const durationMin = Math.round(hours * 60);
  if (durationMin <= 0 || durationMin > 24 * 60) return null;
  let best = null;
  for (let m = 0; m < 24 * 60; m += 15) {
    const sh = Math.floor(m / 60), sm = m % 60;
    const start = `${String(sh).padStart(2, '0')}:${String(sm).padStart(2, '0')}`;
    const endMin = (m + durationMin) % (24 * 60);
    const eh = Math.floor(endMin / 60), em = endMin % 60;
    const end = `${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}`;
    if (start === end) continue;
    let br;
    try { br = S.calcOtBreakdown({ date, start, end, hours }); }
    catch { continue; }
    if (!best || br.gross > best.gross) {
      best = { start, end, gross: br.gross };
    }
  }
  return best;
}

function applyOtBestSlot() {
  const date = document.getElementById('otFormDate').value;
  const start = document.getElementById('otFormStart').value;
  const end = document.getElementById('otFormEnd').value;
  const hours = _computeHours(start, end);
  const best = _findBestOtSlot(date, hours);
  if (!best) return toast('⚠️ No alternative slot found', 'warning');
  document.getElementById('otFormStart').value = best.start;
  document.getElementById('otFormEnd').value = best.end;
  _updateOtFormPreview();
  toast(`💡 Applied best slot: ${best.start}→${best.end}`, 'success');
}

async function submitOtForm() {
  const date = document.getElementById('otFormDate').value;
  const start = document.getElementById('otFormStart').value;
  const end = document.getElementById('otFormEnd').value;
  const reason = document.getElementById('otFormReason').value.trim();
  if (!date) return toast('⚠️ Pick a date', 'warning');
  // Only enforce window for NEW entries — existing entries can be edited/deleted even if past
  if (!_otState.editId && !_isDateInWindow(date)) {
    _showOutOfWindowToast(date);
    return;
  }
  if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) return toast('⚠️ Invalid time', 'warning');
  if (start === end) return toast('⚠️ Start and end must differ', 'warning');
  if (reason.length < 3) return toast('⚠️ Reason must be ≥ 3 chars', 'warning');
  const hours = _computeHours(start, end);
  if (hours <= 0) return toast('⚠️ Cannot compute hours', 'warning');

  // Warn for same-day OT for today + after 10:00 JST (creator window risk)
  const todayStr = _todayJSTStr();
  const nowJ = jstNow();
  if (date === todayStr && nowJ.getHours() >= 10 && !_otState.editId) {
    const ok = await uiConfirm({
      title: 'Late OT for today',
      message: 'OT Creator already ran at 10:00 JST today.\n\nIf this OT is not yet in DokoKin, you may need to trigger "Auto Request OT" workflow manually from Dashboard, or create it in the FJP portal.',
      okText: 'Save anyway',
      danger: false,
    });
    if (!ok) return;
  }

  try {
    // Re-fetch latest before mutating (merge-safe)
    await loadOtData();
    let entries = [..._otState.requests];
    if (_otState.editId) {
      const idx = entries.findIndex(o => o.id === _otState.editId);
      if (idx < 0) throw new Error('Entry not found (already deleted?)');
      const prev = entries[idx];
      entries[idx] = { ...prev, date, start, end, hours, reason, updated_at: new Date().toISOString() };
    } else {
      // Duplicate check
      const dup = entries.find(o => o.date === date && o.start === start && o.end === end);
      if (dup) {
        const ok = await uiConfirm({
          title: 'Duplicate OT?',
          message: `An OT for ${date} ${start}-${end} already exists.\n\nSave another anyway?`,
          okText: 'Save duplicate',
        });
        if (!ok) return;
      }
      entries.push({
        id: _otId(),
        date, start, end, hours, reason,
        created_at: new Date().toISOString(),
      });
    }
    await _saveOtRequests(entries);
    closeOtForm();
    toast('✓ OT saved', 'success');
    await loadOtData();
  } catch (e) {
    toast(`⚠️ ${e.message}`, 'error');
  }
}

async function deleteOtRequest(id) {
  const ot = _otState.requests.find(o => o.id === id);
  if (!ot) return;
  const hasFix = !!ot.auto_co_id;
  const msg = hasFix
    ? `Delete OT ${ot.date} ${ot.start}-${ot.end}?\n\nThis will also revert auto-fix:\n• Remove skip-date from recurring CO\n• Remove once-CO entry`
    : `Delete OT ${ot.date} ${ot.start}-${ot.end}?`;
  const ok = await uiConfirm({ title: 'Delete OT?', message: msg, okText: 'Delete', danger: true });
  if (!ok) return;
  try {
    await loadOtData();
    const entries = _otState.requests.filter(o => o.id !== id);
    // Revert auto-fix if any
    if (hasFix) {
      await _revertAutoFix(ot);
    }
    await _saveOtRequests(entries);
    toast('✓ Deleted', 'success');
    await loadOtData();
  } catch (e) {
    toast(`⚠️ ${e.message}`, 'error');
  }
}

async function autoFixOtConflict(id) {
  const ot = _otState.requests.find(o => o.id === id);
  if (!ot) return;
  if (ot.auto_co_id) return toast('Already fixed', 'warning');
  const conf = detectConflict(ot);
  if (!conf.hasConflict || !conf.canAutoFix) return toast('Nothing to fix', 'warning');
  const ok = await uiConfirm({
    title: 'Apply auto-fix?',
    message: `${conf.message}\n\nThis will modify your scheduled-runs.json:\n• Add skip-date "${ot.date}" to recurring CO\n• Create once-CO at ${conf.targetDate} ${conf.coTime}`,
    okText: 'Apply fix',
  });
  if (!ok) return;
  try {
    // Re-fetch latest (merge-safe)
    await loadOtData();
    const sched = [..._otState.scheduleEntries];
    // Find the recurring CO entry that conflicts (re-detect on fresh data)
    const freshConf = detectConflict(ot);
    if (!freshConf.canAutoFix) throw new Error('Conflict no longer exists (data changed)');
    const recurringEntry = sched[freshConf.schedIdx];
    if (!recurringEntry) throw new Error('Recurring CO entry vanished');
    // Idempotent: add skip_date if not present
    recurringEntry.recurrence = recurringEntry.recurrence || {};
    recurringEntry.recurrence.skip_dates = recurringEntry.recurrence.skip_dates || [];
    if (!recurringEntry.recurrence.skip_dates.includes(ot.date)) {
      recurringEntry.recurrence.skip_dates.push(ot.date);
    }
    // Idempotent: only add once-CO if no matching entry already
    const onceRunAt = `${freshConf.targetDate}T${freshConf.coTime}:00+09:00`;
    const onceId = `ot-fix-${ot.id}`;
    const existingOnce = sched.find(e => e.type === 'once' && e.id === onceId);
    if (!existingOnce) {
      sched.push({
        id: onceId,
        type: 'once',
        workflow: OT_CHECKOUT_WF,
        run_at: onceRunAt,
        note: `Auto-fix CO for OT ${ot.date} ${ot.start}-${ot.end}`,
        created: new Date().toISOString(),
        enabled: true,
      });
    }
    // Update OT entry metadata
    const newOtList = _otState.requests.map(o => o.id === ot.id
      ? { ...o, auto_skip_date: ot.date, auto_co_id: onceId, auto_co_at: onceRunAt }
      : o);
    // Save both files in one PATCH (atomic)
    await _saveBoth(sched, newOtList);
    toast('✓ Auto-fix applied', 'success');
    await loadOtData();
  } catch (e) {
    toast(`⚠️ ${e.message}`, 'error');
  }
}

async function _revertAutoFix(ot) {
  if (!ot.auto_co_id) return;
  const sched = [..._otState.scheduleEntries];
  // Remove once-CO entry
  const filtered = sched.filter(e => !(e.type === 'once' && e.id === ot.auto_co_id));
  // Remove skip_date from recurring CO entries
  for (const e of filtered) {
    if (e.type === 'recurring' && e.workflow === OT_CHECKOUT_WF && e.recurrence && Array.isArray(e.recurrence.skip_dates)) {
      e.recurrence.skip_dates = e.recurrence.skip_dates.filter(d => d !== ot.auto_skip_date);
    }
  }
  _otState.scheduleEntries = filtered;
  // Save scheduled-runs.json now; ot-requests.json will be saved by caller
  await _saveScheduledRuns(filtered);
}

// ─── Gist save helpers ───
function _otId() {
  return 'ot_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

async function _saveOtRequests(arr) {
  // Phase 3: write wrapper {requests, templates}, preserving current templates.
  return _saveOtStore(arr, _otState.templates);
}

async function _saveOtTemplates(tpls) {
  return _saveOtStore(_otState.requests, tpls);
}

async function _saveOtStore(requests, templates) {
  const payload = {
    requests: Array.isArray(requests) ? requests : [],
    templates: Array.isArray(templates) ? templates : [],
  };
  const res = await fetch(`${API}/gists/${GIST_ID}`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${sessionToken}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: { [OT_FILE]: { content: JSON.stringify(payload, null, 2) } } }),
  });
  if (!res.ok) throw new Error(`Gist update failed (${res.status})`);
  return res.json();
}

async function _saveScheduledRuns(arr) {
  const res = await fetch(`${API}/gists/${GIST_ID}`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${sessionToken}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: { 'scheduled-runs.json': { content: JSON.stringify(arr, null, 2) } } }),
  });
  if (!res.ok) throw new Error(`Gist update failed (${res.status})`);
  return res.json();
}

async function _saveBoth(sched, ots) {
  const otPayload = {
    requests: Array.isArray(ots) ? ots : [],
    templates: _otState.templates || [],
  };
  const res = await fetch(`${API}/gists/${GIST_ID}`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${sessionToken}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: {
      'scheduled-runs.json': { content: JSON.stringify(sched, null, 2) },
      [OT_FILE]: { content: JSON.stringify(otPayload, null, 2) },
    } }),
  });
  if (!res.ok) throw new Error(`Gist update failed (${res.status})`);
  return res.json();
}

// ─── Sync with DokoKin API (manual trigger of Auto OT Creator workflow) ───
async function syncOtWithDokoKin() {
  if (typeof sessionToken === 'undefined' || !sessionToken) {
    toast('⚠️ Not authenticated', 'error');
    return;
  }
  const btn = document.getElementById('otSyncBtn');
  const origHtml = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `${ICON('refresh', 14, 'animate-spin')} Syncing…`;
  }
  try {
    const res = await fetch(`${API}/repos/${OWNER}/${REPO}/actions/workflows/${OT_CREATOR_WF}/dispatches`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${sessionToken}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: 'main' }),
    });
    if (res.status === 204) {
      toast('☁️ Sync dispatched — DokoKin status will refresh in ~60–90s');
      // Auto-refresh after 90s to pick up new kintai_created_at marks
      setTimeout(() => loadOtData({ refresh: true }), 90000);
    } else {
      const body = await res.text().catch(() => '');
      toast(`❌ Sync failed (${res.status})${body ? ': ' + body.slice(0, 80) : ''}`, 'error');
    }
  } catch (e) {
    toast(`❌ ${e.message}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origHtml;
    }
  }
}
// ─── Stats bar (mirrors Schedule tab's schedule-stats pattern) ───
function renderOtStats() {
  const host = document.getElementById('otStats');
  if (!host) return;
  const y = _otState.viewYear;
  const m = _otState.viewMonth;
  const monthPrefix = `${y}-${String(m + 1).padStart(2, '0')}-`;
  const todayStr = _todayJSTStr();

  const monthEntries = (_otState.requests || []).filter(o => o.date && o.date.startsWith(monthPrefix));
  const totalHours = monthEntries.reduce((s, o) => s + (Number(o.hours) || 0), 0);
  const createdCount = monthEntries.filter(o => !!o.kintai_created_at).length;
  const monthTotal = monthEntries.length;

  // Next OT: nearest upcoming entry globally (start datetime in JST)
  const now = jstNow();
  let nextEntry = null;
  let nextMs = Infinity;
  for (const o of (_otState.requests || [])) {
    if (!o.date || !o.start) continue;
    if (o.date < todayStr) continue;
    const [hh, mm] = o.start.split(':').map(Number);
    const [yy, mo, dd] = o.date.split('-').map(Number);
    const dt = new Date(yy, mo - 1, dd, hh || 0, mm || 0, 0);
    const delta = dt - now;
    if (delta > 0 && delta < nextMs) { nextMs = delta; nextEntry = o; }
  }
  const nextStr = nextEntry ? _formatOtCountdown(nextMs) : '—';
  const nextTooltip = nextEntry
    ? `Next: ${nextEntry.date} ${nextEntry.start}→${nextEntry.end} (${nextEntry.hours}h)`
    : 'No upcoming OT';

  // Format hours nicely (e.g. 12h, 7.5h)
  const hoursDisplay = totalHours === Math.floor(totalHours)
    ? `${totalHours}h`
    : `${totalHours.toFixed(1)}h`;

  const createdRatio = monthTotal > 0 ? `${createdCount}/${monthTotal}` : '0/0';

  // Income chip — uses salary engine for current month-view entries
  const sal = (window.OT_SALARY && window.OT_SALARY.calcMonthlySummary)
    ? window.OT_SALARY.calcMonthlySummary(monthEntries)
    : null;
  const incomeStr = sal ? window.OT_SALARY.formatYen(sal.gross) : '—';
  const incomeTip = sal
    ? `Monthly OT income (gross):\n• Base OT 125%: ${window.OT_SALARY.formatYen(sal.baseOTLine)}\n• Sunday +10%: ${window.OT_SALARY.formatYen(sal.sundayLine)}\n• Night +25%: ${window.OT_SALARY.formatYen(sal.nightLine)}\nPaid IN ADDITION to fixed allowance ¥20,000/mo.`
    : 'Salary engine unavailable';

  // Take-home chip — real payslip if available, else estimate from baseline
  let takeHomeStr = '—', takeHomeTip = 'No payslip data', takeHomeBadge = '';
  if (window.OT_SALARY && sal) {
    const realSlip = window.OT_SALARY.findPayslipForWorkMonth(_otState.payslips, monthPrefix.slice(0, 7));
    const baseline = window.OT_SALARY.pickBaselineForWorkMonth(_otState.payslips, monthPrefix.slice(0, 7));
    const wmKey = monthPrefix.slice(0, 7);
    const payDateStr = window.OT_SALARY.formatPayDate(wmKey);
    if (realSlip && realSlip.take_home != null) {
      takeHomeStr = window.OT_SALARY.formatYen(realSlip.take_home);
      takeHomeBadge = ' ✓';
      takeHomeTip = `Actual take-home for work month ${wmKey}\n(paid ${payDateStr} · payslip ${realSlip.month}):\n• Gross: ${window.OT_SALARY.formatYen(realSlip.gross || 0)}\n• Take-home: ${window.OT_SALARY.formatYen(realSlip.take_home)}\n(All deductions applied: insurance, taxes, rent, fees)`;
    } else if (baseline) {
      const est = window.OT_SALARY.calcFullMonthEstimate(sal.gross, baseline, { basicSalaryIndex: 1.0 });
      takeHomeStr = window.OT_SALARY.formatYen(est.takeHome);
      takeHomeTip = `Estimated take-home for work month ${wmKey}\n(will be paid ${payDateStr} · baseline: payslip ${baseline.month})\n• Total gross: ${window.OT_SALARY.formatYen(est.gross)}\n• − Insurance: ${window.OT_SALARY.formatYen(est.insuranceTotal)}\n• − Income tax: ${window.OT_SALARY.formatYen(est.incomeTax)}\n• − Resident tax: ${window.OT_SALARY.formatYen(est.residentTax)}\n• − Company receivables: ${window.OT_SALARY.formatYen(est.companyReceivables)}\n= ${window.OT_SALARY.formatYen(est.takeHome)}`;
    }
  }

  host.innerHTML = `
    <div class="stat-chip" data-tooltip="OT entries in this month view"><span class="stat-num">${monthTotal}</span><span class="stat-lbl">entries</span></div>
    <div class="stat-chip" data-tooltip="Total OT hours in this month view"><span class="stat-num">${hoursDisplay}</span><span class="stat-lbl">hours</span></div>
    <div class="stat-chip" data-tooltip="Already created in DokoKin / total this month"><span class="stat-num">${createdRatio}</span><span class="stat-lbl">created</span></div>
    <div class="stat-chip stat-chip-income" data-tooltip="${_esc(incomeTip)}"><span class="stat-num">${incomeStr}</span><span class="stat-lbl">OT income</span></div>
    <div class="stat-chip stat-chip-takehome" data-tooltip="${_esc(takeHomeTip)}"><span class="stat-num">${takeHomeStr}${takeHomeBadge}</span><span class="stat-lbl">take-home</span></div>
  `;
}

function _formatOtCountdown(ms) {
  if (!ms || ms <= 0) return '—';
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  if (h < 24) {
    const rm = totalMin % 60;
    return rm ? `${h}h ${rm}m` : `${h}h`;
  }
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}

// ═══════════════════════════════════════════════════
//  Salary integration helpers (Phase 2)
// ═══════════════════════════════════════════════════
function _otIncomeCell(ot) {
  if (!window.OT_SALARY) return '—';
  const b = window.OT_SALARY.calcOtBreakdown(ot);
  return window.OT_SALARY.formatYen(b.gross);
}

function _otIncomeTooltip(ot) {
  if (!window.OT_SALARY) return '';
  const b = window.OT_SALARY.calcOtBreakdown(ot);
  const F = window.OT_SALARY.formatYen;
  const H = window.OT_SALARY.formatHours;
  const lines = [`Gross OT for this entry: ${F(b.gross)}`];
  lines.push(`• Base 125%: ${H(b.totalHours)} → ${F(b.baseOT)}`);
  if (b.sundayHours > 0) lines.push(`• Sunday +10%: ${H(b.sundayHours)} → ${F(b.sundayPremium)}`);
  if (b.nightHours > 0) lines.push(`• Night +25%: ${H(b.nightHours)} → ${F(b.nightPremium)}`);
  if (b.segments && b.segments.length > 1) {
    lines.push(`(Cross-midnight: ${b.segments.length} day segments)`);
  }
  return lines.join('\n');
}

function renderOtBudget() {
  const host = document.getElementById('otBudget');
  if (!host || !window.OT_SALARY) return;
  const y = _otState.viewYear;
  const m = _otState.viewMonth;
  const monthPrefix = `${y}-${String(m + 1).padStart(2, '0')}-`;
  const entries = (_otState.requests || []).filter(o => o.date && o.date.startsWith(monthPrefix));
  const sal = window.OT_SALARY.calcMonthlySummary(entries);
  const S = window.OT_SALARY.SALARY;
  const F = window.OT_SALARY.formatYen;
  const H = window.OT_SALARY.formatHours;

  const hoursPct = Math.min(100, sal.hoursPctMonth * 100);
  const nightPct = Math.min(100, sal.nightPctRemark * 100);
  const hoursCls = sal.hoursPctMonth >= 0.9 ? 'is-danger' : (sal.hoursPctMonth >= 0.75 ? 'is-warning' : '');
  const nightCls = sal.nightPctRemark >= 1 ? 'is-danger' : (sal.nightPctRemark >= 0.85 ? 'is-warning' : '');

  const monthName = new Date(y, m, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
  const monthKey = `${y}-${String(m + 1).padStart(2, '0')}`;
  const today = jstNow();
  const todayMonthKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  const isPastMonth = monthKey < todayMonthKey;

  // Net take-home: prefer real payslip when available; otherwise estimate
  // using the latest payslip as fixed-cost baseline (insurance, rent, …).
  const realSlip = window.OT_SALARY.findPayslipForWorkMonth(_otState.payslips, monthKey);
  const baseline = window.OT_SALARY.pickBaselineForWorkMonth(_otState.payslips, monthKey);
  let netHtml = '';
  if (realSlip && realSlip.take_home != null) {
    // ━━ ACTUAL from payslip ━━
    netHtml = `
      <div class="ot-budget-takehome" data-payslip-month="${monthKey}">
        <span class="ot-takehome-label">${ICON('wallet', 12)} Net take-home <span class="ot-takehome-est ot-real-badge">actual</span></span>
        <span class="ot-takehome-val">${F(realSlip.take_home)}<button class="ot-takehome-eye ot-takehome-clickable" data-payslip-month="${monthKey}" aria-label="View payslip detail">${ICON('eye', 14)}</button></span>
      </div>`;
  } else if (baseline) {
    // ━━ ESTIMATE using baseline payslip fixed components ━━
    // For past months with no slip yet: index=1.0. For current month: estimate
    // index from working day ratio elapsed (rough). For future months: index=1.0.
    let idx = 1.0;
    if (monthKey === todayMonthKey) {
      // Rough: don't reduce index — assume user will work the rest of the month.
      idx = 1.0;
    }
    const est = window.OT_SALARY.calcFullMonthEstimate(sal.gross, baseline, { basicSalaryIndex: idx });
    netHtml = `
      <div class="ot-budget-takehome" data-payslip-month="${monthKey}" data-payslip-estimate="1">
        <span class="ot-takehome-label">${ICON('wallet', 12)} Net take-home <span class="ot-takehome-est">est.</span></span>
        <span class="ot-takehome-val">${F(est.takeHome)}<button class="ot-takehome-eye ot-takehome-clickable" data-payslip-month="${monthKey}" data-payslip-estimate="1" aria-label="View payslip detail">${ICON('eye', 14)}</button></span>
      </div>`;
  } else {
    // ━━ No payslip data at all — fall back to OT-delta only ━━
    const profile = _otGetProfile();
    const delta = window.OT_SALARY.calcTakeHomeDelta(sal.gross, profile);
    const keepPct = delta.effectiveKeepRate > 0 ? (delta.effectiveKeepRate * 100).toFixed(1) : '—';
    netHtml = `
      <div class="ot-budget-takehome">
        <span class="ot-takehome-label">${ICON('wallet', 12)} Net OT delta <span class="ot-takehome-est">est.</span></span>
        <span class="ot-takehome-val">${F(delta.takeHomeDelta)} <span class="ot-takehome-pct">(${keepPct}%)</span></span>
      </div>`;
  }

  host.innerHTML = `
    <div class="ot-budget-card">
      <div class="ot-budget-header">
        <div class="ot-budget-title">${ICON('hourglass', 14)} Budget · ${monthName}</div>
        <div class="ot-budget-gross" data-tooltip="Gross OT income (base 125% + Sunday +10% + night +25%) — paid IN ADDITION to fixed allowance ¥20,000/mo">${F(sal.gross)}</div>
      </div>
      <div class="ot-budget-row">
        <div class="ot-budget-row-label">
          <span>Monthly hours</span>
          <span class="ot-budget-row-val">${H(sal.totalHours)} / ${S.MAX_HOURS_PER_MONTH}h</span>
        </div>
        <div class="ot-progress ${hoursCls}">
          <div class="ot-progress-fill" style="width:${hoursPct}%"></div>
        </div>
      </div>
      <div class="ot-budget-row">
        <div class="ot-budget-row-label">
          <span>Night hours (22:00–05:00)</span>
          <span class="ot-budget-row-val">${H(sal.nightHours)} / ${S.NIGHT_REMARK_THRESHOLD}h</span>
        </div>
        <div class="ot-progress ${nightCls}">
          <div class="ot-progress-fill" style="width:${nightPct}%"></div>
        </div>
      </div>
      ${netHtml}
      <div class="ot-budget-breakdown">
        <span data-tooltip="125% rate on all OT hours — ${F(sal.baseOTLine)}">${ICON('clock', 11)} Base ${F(sal.baseOTLine)}</span>
        <span data-tooltip="+10% extra on Sunday hours">☀️ Sun ${H(sal.sundayHours)} · ${F(sal.sundayLine)}</span>
        <span data-tooltip="+25% extra on night-zone hours">🌙 Night ${H(sal.nightHours)} · ${F(sal.nightLine)}</span>
        <span data-tooltip="Fixed allowance paid monthly regardless of OT done">💴 Fixed allowance ${F(S.FIXED_ALLOWANCE_YEN)}</span>
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════════════════
//  Phase 3 — Profile (take-home calc inputs), Templates, Optimizer
// ═══════════════════════════════════════════════════

const OT_PROFILE_KEY = 'ot_takehome_profile_v1';

function _otGetProfile() {
  try {
    const raw = localStorage.getItem(OT_PROFILE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  // Defaults match Apr 2026 payslip for TanVC
  return {
    contractGross: 270000,
    standardInsurance: 280000,
    residentTax: 4300,
    travelAllowance: 0,
    dependents: 0,
  };
}

function _otSaveProfile(p) {
  try { localStorage.setItem(OT_PROFILE_KEY, JSON.stringify(p)); } catch {}
  if (window.CloudSync) window.CloudSync.markDirty();
}

// ─── Templates ───
function _allTemplates() {
  const user = (_otState.templates || []).map(t => ({ ...t, builtin: false }));
  return [...BUILTIN_TEMPLATES, ...user];
}

function _otTemplateOptions(currentDate) {
  const dow = currentDate ? new Date(currentDate + 'T00:00:00').getDay() : null;
  const all = _allTemplates();
  const opts = ['<option value="">— Select a template (optional) —</option>'];
  for (const t of all) {
    const recommended = (dow != null && t.preferredDays && t.preferredDays.includes(dow)) ? ' ★' : '';
    const safeId = _esc(t.id);
    opts.push(`<option value="${safeId}">${_esc(t.name)} (${t.start}→${t.end})${recommended}</option>`);
  }
  return opts.join('');
}

function refreshOtFormTemplateDropdown() {
  const sel = document.getElementById('otFormTemplate');
  if (!sel) return;
  const dateEl = document.getElementById('otFormDate');
  sel.innerHTML = _otTemplateOptions(dateEl ? dateEl.value : null);
}

function applyOtTemplate() {
  const sel = document.getElementById('otFormTemplate');
  if (!sel || !sel.value) return;
  const tpl = _allTemplates().find(t => t.id === sel.value);
  if (!tpl) return;
  document.getElementById('otFormStart').value = tpl.start;
  document.getElementById('otFormEnd').value = tpl.end;
  const reasonEl = document.getElementById('otFormReason');
  if (!reasonEl.value || reasonEl.value === reasonEl.dataset.lastTemplateReason) {
    reasonEl.value = tpl.reason || '';
  }
  reasonEl.dataset.lastTemplateReason = tpl.reason || '';
  _updateOtFormPreview();
}

function openOtTemplateManager() {
  const modal = document.getElementById('otTemplateModal');
  if (!modal) return;
  renderOtTemplateList();
  modal.classList.add('open');
}

function closeOtTemplateManager() {
  const m = document.getElementById('otTemplateModal');
  if (m) m.classList.remove('open');
}

function renderOtTemplateList() {
  const host = document.getElementById('otTemplateList');
  if (!host) return;
  const all = _allTemplates();
  const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  let html = '';
  for (const t of all) {
    const daysStr = (t.preferredDays && t.preferredDays.length)
      ? t.preferredDays.map(d => dayNames[d]).join(', ')
      : '—';
    const badge = t.builtin
      ? '<span class="status-badge status-info" data-tooltip="Built-in (read-only)">built-in</span>'
      : '<span class="status-badge status-success">custom</span>';
    const actions = t.builtin ? '' : `
      <button class="btn sm btn-ghost btn-icon" onclick="deleteOtTemplate('${_esc(t.id)}')" data-tooltip="Delete"><span data-icon="trash" data-size="13"></span></button>
    `;
    html += `
      <div class="ot-template-row">
        <div class="ot-template-info">
          <div class="ot-template-name">${_esc(t.name)} ${badge}</div>
          <div class="ot-template-meta">${t.start}→${t.end} · ${daysStr} · "${_esc(t.reason || '')}"</div>
        </div>
        <div class="ot-template-actions">${actions}</div>
      </div>
    `;
  }
  host.innerHTML = html || '<div class="empty text-muted-foreground text-sm p-3 text-center">No templates yet</div>';
  // Re-render icons in injected HTML
  if (typeof renderIcons === 'function') renderIcons(host);
}

async function addOtTemplate() {
  const name = document.getElementById('otTplName').value.trim();
  const start = document.getElementById('otTplStart').value;
  const end = document.getElementById('otTplEnd').value;
  const reason = document.getElementById('otTplReason').value.trim();
  const dayCbs = document.querySelectorAll('input[name="otTplDay"]:checked');
  const preferredDays = Array.from(dayCbs).map(c => Number(c.value));
  if (!name) return toast('⚠️ Name required', 'warning');
  if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) return toast('⚠️ Invalid time', 'warning');
  if (start === end) return toast('⚠️ Start and end must differ', 'warning');
  const tpl = {
    id: 'tpl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name, start, end, reason, preferredDays,
    created_at: new Date().toISOString(),
  };
  try {
    const next = [...(_otState.templates || []), tpl];
    await _saveOtTemplates(next);
    _otState.templates = next;
    document.getElementById('otTplName').value = '';
    document.getElementById('otTplReason').value = '';
    document.querySelectorAll('input[name="otTplDay"]').forEach(c => c.checked = false);
    renderOtTemplateList();
    refreshOtFormTemplateDropdown();
    toast('✓ Template added', 'success');
  } catch (e) {
    toast(`⚠️ ${e.message}`, 'error');
  }
}

async function deleteOtTemplate(id) {
  const tpl = (_otState.templates || []).find(t => t.id === id);
  if (!tpl) return;
  const ok = await uiConfirm({
    title: 'Delete template?',
    message: `"${tpl.name}" will be removed.`,
    okText: 'Delete',
    danger: true,
  });
  if (!ok) return;
  try {
    const next = (_otState.templates || []).filter(t => t.id !== id);
    await _saveOtTemplates(next);
    _otState.templates = next;
    renderOtTemplateList();
    refreshOtFormTemplateDropdown();
    toast('✓ Deleted', 'success');
  } catch (e) {
    toast(`⚠️ ${e.message}`, 'error');
  }
}

// ─── Optimizer ───
// Strategy (post-knapsack rev2): pack 22:00→04:00 PURE-NIGHT 6h shifts.
// Rate analysis (¥/h):
//   - Sunday pure-night : 1.25 + 0.10 + 0.25 = 1.60×  → ¥2,500/h
//   - Weekday pure-night: 1.25         + 0.25 = 1.50×  → ¥2,344/h
//   - Sunday daytime    : 1.25 + 0.10         = 1.35×  → ¥2,110/h
// Sundays first (highest rate), then weekdays. Labor Law §34 break only
// triggers when working hours STRICTLY > 6h, so 6.0h shifts are break-free.
// Last shift may be partial in [3, 6) hours so we hit the cap exactly.
function _otOptimizerCandidates(year, monthZeroIdx, existingByDate) {
  const daysInMonth = new Date(year, monthZeroIdx + 1, 0).getDate();
  const todayStr = _todayJSTStr();
  const sun = [], wk = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(monthZeroIdx + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (dateStr < todayStr) continue;            // can't optimize past
    if (existingByDate[dateStr]) continue;       // skip days with existing OT
    const dow = new Date(year, monthZeroIdx, d).getDay();
    const isSun = dow === 0;
    const start = '22:00';
    const end = '04:00';                          // 6h pure-night
    const hours = 6;
    const ot = { date: dateStr, start, end, hours, reason: 'optimizer' };
    const breakdown = window.OT_SALARY.calcOtBreakdown(ot);
    const conf = detectConflict(ot);
    const item = {
      date: dateStr, dow, start, end, hours,
      kind: isSun ? 'sun' : 'wk',
      gross: breakdown.gross,
      ratio: breakdown.gross / hours,
      hasConflict: conf.hasConflict,
      conflictMsg: conf.message || '',
    };
    if (conf.hasConflict) continue;
    (isSun ? sun : wk).push(item);
  }
  const byDate = (a, b) => a.date < b.date ? -1 : 1;
  sun.sort(byDate); wk.sort(byDate);
  return { sun, wk };
}

// Greedy fill subject to hour cap. Since rateSun > rateWk and both shifts
// are 6h pure-night, optimal is: pack Sundays first up to min(num_sun,
// floor(cap/6)), then weekdays. Allow ONE partial last shift in [3,6) to
// consume the exact remainder.
// Returns { picks: [{kind, hours}, ...indexed by slot order], k_sun, k_wk,
// gross, hours, partial }. Materialization (which dates) is done by caller.
function _pickOptimalMix(sun, wk, remainingHours, target, maxMode) {
  const rateSun = sun[0]?.ratio || 0;
  const rateWk  = wk[0]?.ratio || 0;
  const grossSun6 = sun[0]?.gross || 0;
  const grossWk6  = wk[0]?.gross || 0;

  // Helper: given a (k_sun, k_wk_full, partialKind, partialHours), build candidate.
  const mk = (ks, kwFull, pKind, pHrs) => {
    let gross = ks * grossSun6 + kwFull * grossWk6;
    if (pKind === 'sun') gross += pHrs * rateSun;
    else if (pKind === 'wk') gross += pHrs * rateWk;
    const hours = ks * 6 + kwFull * 6 + (pKind ? pHrs : 0);
    return { k_sun: ks, k_wk: kwFull + (pKind === 'wk' ? 1 : 0),
             k_sun_total: ks + (pKind === 'sun' ? 1 : 0),
             partialKind: pKind, partialHours: pHrs || 0,
             gross, hours };
  };
  const better = (a, b) => {
    if (maxMode) return b.gross > a.gross ? b : a;
    // target mode: smallest gross >= target; else largest below
    if (b.gross >= target && a.gross < target) return b;
    if (a.gross >= target && b.gross < target) return a;
    if (a.gross >= target && b.gross >= target) return b.gross < a.gross ? b : a;
    return b.gross > a.gross ? b : a;
  };

  // Build candidate set: enumerate all (k_sun_full, k_wk_full, partial) packings
  // satisfying caps. Small search space (~num_sun × num_wk = ~80 combos).
  let best = mk(0, 0, null, 0);
  const numSun = sun.length, numWk = wk.length;
  for (let ks = 0; ks <= Math.min(numSun, Math.floor(remainingHours / 6 + 1e-9)); ks++) {
    const afterSun = ks * 6;
    const wkBudget = remainingHours - afterSun;
    const maxKwFull = Math.min(numWk, Math.floor(wkBudget / 6 + 1e-9));
    for (let kw = 0; kw <= maxKwFull; kw++) {
      const used = afterSun + kw * 6;
      const leftover = remainingHours - used;
      // Try no partial
      best = better(best, mk(ks, kw, null, 0));
      // Try partial weekday (if slot available, ≥3h, <6h)
      if (kw < numWk && leftover >= 3 && leftover < 6 + 1e-9) {
        const pHrs = Math.min(leftover, 6 - 0.01);  // strictly <6 to stay break-free; but we already split full vs partial
        // Actually use exact leftover (which is <6 here)
        best = better(best, mk(ks, kw, 'wk', leftover));
      }
      // Try partial sunday (only if extra Sun slots remain beyond ks)
      if (ks < numSun && leftover >= 3 && leftover < 6 + 1e-9) {
        best = better(best, mk(ks, kw, 'sun', leftover));
      }
    }
  }
  return best;
}

function runOtOptimizer() {
  const targetEl = document.getElementById('otOptTarget');
  const targetHoursEl = document.getElementById('otOptTargetHours');
  const maxMode = document.getElementById('otOptMax').checked;
  const target = maxMode ? Infinity : Math.max(0, Number(targetEl.value) || 0);
  const targetHours = maxMode ? Infinity : Math.max(0, Number(targetHoursEl.value) || Infinity);

  const y = _otState.viewYear;
  const m = _otState.viewMonth;
  const monthPrefix = `${y}-${String(m + 1).padStart(2, '0')}-`;
  const existing = (_otState.requests || []).filter(o => o.date && o.date.startsWith(monthPrefix));
  const existingByDate = {};
  existing.forEach(o => { existingByDate[o.date] = true; });

  const sal = window.OT_SALARY.calcMonthlySummary(existing);
  const S = window.OT_SALARY.SALARY;
  let remainingHours = S.MAX_HOURS_PER_MONTH - sal.totalHours;

  // Also cap by target hours if specified
  if (targetHours !== Infinity) {
    remainingHours = Math.min(remainingHours, Math.max(0, targetHours - sal.totalHours));
  }

  if (remainingHours <= 0) {
    document.getElementById('otOptResults').innerHTML =
      `<div class="empty text-warning text-sm p-3 text-center">${ICON('alertTriangle', 14)} Monthly budget already full: ${sal.totalHours}/${S.MAX_HOURS_PER_MONTH}h. Nothing to optimize.</div>`;
    return;
  }
  if (!maxMode && target <= sal.gross && targetHours === Infinity) {
    document.getElementById('otOptResults').innerHTML =
      `<div class="empty text-success text-sm p-3 text-center">${ICON('check', 14)} Target ${window.OT_SALARY.formatYen(target)} already met (current ${window.OT_SALARY.formatYen(sal.gross)}).</div>`;
    return;
  }

  const { sun, wk } = _otOptimizerCandidates(y, m, existingByDate);
  // For target mode, target is OT-GROSS-DELTA needed (UI hint says "Target income")
  // Existing gross already counted; subtract from target to get delta required.
  const targetDelta = maxMode ? Infinity : Math.max(0, target - sal.gross);
  const mix = _pickOptimalMix(sun, wk, remainingHours, targetDelta, maxMode);

  // Materialize: pick first k_sun_total Sundays (or k_sun if no partial),
  // first k_wk weekdays. If partial, replace LAST slot of the partialKind
  // with a shorter shift (22:00 → end = 22:00 + partialHours).
  const sunFullCount = mix.k_sun;
  const wkFullCount = mix.partialKind === 'wk' ? mix.k_wk - 1 : mix.k_wk;
  const selected = [];
  for (let i = 0; i < sunFullCount; i++) selected.push({ ...sun[i] });
  for (let i = 0; i < wkFullCount; i++) selected.push({ ...wk[i] });
  if (mix.partialKind === 'sun' && sunFullCount < sun.length) {
    const base = sun[sunFullCount];
    const endHr = (22 + mix.partialHours) % 24;
    const endHH = String(Math.floor(endHr)).padStart(2,'0');
    const endMM = String(Math.round((endHr - Math.floor(endHr)) * 60)).padStart(2,'0');
    const partOt = { date: base.date, start: '22:00', end: `${endHH}:${endMM}`, hours: mix.partialHours, reason: 'optimizer' };
    const bd = window.OT_SALARY.calcOtBreakdown(partOt);
    selected.push({ ...base, start: partOt.start, end: partOt.end, hours: mix.partialHours, gross: bd.gross, ratio: bd.gross / mix.partialHours });
  }
  if (mix.partialKind === 'wk' && wkFullCount < wk.length) {
    const base = wk[wkFullCount];
    const endHr = (22 + mix.partialHours) % 24;
    const endHH = String(Math.floor(endHr)).padStart(2,'0');
    const endMM = String(Math.round((endHr - Math.floor(endHr)) * 60)).padStart(2,'0');
    const partOt = { date: base.date, start: '22:00', end: `${endHH}:${endMM}`, hours: mix.partialHours, reason: 'optimizer' };
    const bd = window.OT_SALARY.calcOtBreakdown(partOt);
    selected.push({ ...base, start: partOt.start, end: partOt.end, hours: mix.partialHours, gross: bd.gross, ratio: bd.gross / mix.partialHours });
  }
  selected.sort((a, b) => a.date < b.date ? -1 : 1);

  _otState.optimizerResults = selected;
  renderOtOptimizerResults(selected, {
    projHours: sal.totalHours + mix.hours,
    projGross: sal.gross + mix.gross,
    currentGross: sal.gross,
    currentHours: sal.totalHours,
    target, maxMode,
  });
}

function renderOtOptimizerResults(selected, ctx) {
  const host = document.getElementById('otOptResults');
  if (!host) return;
  const F = window.OT_SALARY.formatYen;
  const H = window.OT_SALARY.formatHours;
  const win = _otCreationWindow();

  if (!selected.length) {
    host.innerHTML = `<div class="empty text-muted-foreground text-sm p-3 text-center">No eligible days found (all booked/conflicted, or target not reachable within 75h cap).</div>`;
    return;
  }

  const profile = _otGetProfile();
  const deltaTotal = window.OT_SALARY.calcTakeHomeDelta(ctx.projGross - ctx.currentGross, profile, ctx.currentGross);

  let rows = '';
  for (let i = 0; i < selected.length; i++) {
    const c = selected[i];
    const isQueued = c.date > win.maxStr;
    const isInWindow = !isQueued && c.date >= win.today;
    const statusBadge = isQueued
      ? `<span class="status-badge status-pending" data-tooltip="Beyond DokoKin +7d window — saved to Gist, auto-created when in range">queued</span>`
      : `<span class="status-badge status-info" data-tooltip="Within DokoKin window — Auto OT Creator picks up at next 10:00 JST run">eligible</span>`;
    const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    rows += `
      <tr>
        <td class="px-3 py-2"><input type="checkbox" class="ot-opt-cb" data-idx="${i}" checked></td>
        <td class="px-3 py-2 font-mono text-xs">${c.date} <span class="text-muted-foreground">${dayNames[c.dow]}</span></td>
        <td class="px-3 py-2 font-mono text-xs">${c.start}→${c.end}</td>
        <td class="px-3 py-2 text-right">${H(c.hours)}</td>
        <td class="px-3 py-2 text-right font-mono">${F(c.gross)}</td>
        <td class="px-3 py-2">${statusBadge}</td>
      </tr>
    `;
  }
  host.innerHTML = `
    <div class="ot-opt-summary">
      <div class="ot-opt-summary-row">
        <span>Current</span>
        <span><strong>${H(ctx.currentHours)}</strong> · ${F(ctx.currentGross)}</span>
      </div>
      <div class="ot-opt-summary-row is-projected">
        <span>+ Suggested (${selected.length} days)</span>
        <span><strong>${H(ctx.projHours - ctx.currentHours)}</strong> · +${F(ctx.projGross - ctx.currentGross)}</span>
      </div>
      <div class="ot-opt-summary-row is-total">
        <span>Projected total</span>
        <span><strong>${H(ctx.projHours)}</strong> · ${F(ctx.projGross)}</span>
      </div>
      <div class="ot-opt-summary-row is-takehome" data-tooltip="Net take-home delta (estimate, ±¥500)">
        <span>${ICON('wallet', 12)} Est. net take-home delta</span>
        <span><strong>${F(deltaTotal.takeHomeDelta)}</strong> <span class="text-muted-foreground">(keep ${(deltaTotal.effectiveKeepRate * 100).toFixed(1)}%)</span></span>
      </div>
    </div>
    <div class="sched-table-wrap overflow-x-auto rounded-lg border border-border mt-3">
      <table class="sched-table w-full text-sm">
        <thead><tr class="bg-muted/50 border-b border-border">
          <th class="px-3 py-2 text-left"><input type="checkbox" id="otOptCbAll" checked onchange="document.querySelectorAll('.ot-opt-cb').forEach(c=>c.checked=this.checked)"></th>
          <th class="px-3 py-2 text-left text-xs font-medium text-muted-foreground uppercase">Date</th>
          <th class="px-3 py-2 text-left text-xs font-medium text-muted-foreground uppercase">Time</th>
          <th class="px-3 py-2 text-right text-xs font-medium text-muted-foreground uppercase">Hours</th>
          <th class="px-3 py-2 text-right text-xs font-medium text-muted-foreground uppercase">Income</th>
          <th class="px-3 py-2 text-left text-xs font-medium text-muted-foreground uppercase">Status</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <button class="btn primary w-full mt-3" onclick="applyOtOptimizer()"><span data-icon="save" data-size="14"></span> Apply Selected</button>
  `;
  if (typeof renderIcons === 'function') renderIcons(host);
}

async function applyOtOptimizer() {
  const checked = Array.from(document.querySelectorAll('.ot-opt-cb:checked'))
    .map(c => Number(c.dataset.idx))
    .filter(i => !isNaN(i));
  if (!checked.length) return toast('⚠️ Select at least 1 row', 'warning');
  const toAdd = checked.map(i => _otState.optimizerResults[i]).filter(Boolean);
  const ok = await uiConfirm({
    title: `Apply ${toAdd.length} OT request${toAdd.length > 1 ? 's' : ''}?`,
    message: `These will be saved to Gist. Entries within DokoKin's +7d window are picked up by the next Auto OT Creator run (10:00 JST daily); later dates are queued until they enter the window.`,
    okText: 'Apply',
  });
  if (!ok) return;
  try {
    await loadOtData();
    const existing = [..._otState.requests];
    for (const c of toAdd) {
      // Double-check no duplicate (race-safe after re-fetch)
      if (existing.some(o => o.date === c.date)) continue;
      existing.push({
        id: _otId(),
        date: c.date, start: c.start, end: c.end, hours: c.hours,
        reason: c.start === '15:30' ? 'Sunday OT — full day' : 'task shishin',
        created_at: new Date().toISOString(),
        created_by: 'optimizer',
      });
    }
    await _saveOtRequests(existing);
    closeOtOptimizer();
    toast(`✓ Applied ${toAdd.length} OT entries`, 'success');
    await loadOtData();
  } catch (e) {
    toast(`⚠️ ${e.message}`, 'error');
  }
}

function openOtOptimizer() {
  const modal = document.getElementById('otOptModal');
  if (!modal) return;
  document.getElementById('otOptResults').innerHTML =
    `<div class="empty text-muted-foreground text-sm p-3 text-center">Set a target income and click "Suggest schedule".</div>`;
  modal.classList.add('open');
}

function closeOtOptimizer() {
  const m = document.getElementById('otOptModal');
  if (m) m.classList.remove('open');
  _otState.optimizerResults = [];
}

function _toggleOtOptTarget() {
  const max = document.getElementById('otOptMax').checked;
  const inp = document.getElementById('otOptTarget');
  const inpH = document.getElementById('otOptTargetHours');
  if (inp) inp.disabled = max;
  if (inpH) inpH.disabled = max;
}
// ═══════════════════════════════════════════════════
//  PAYSLIP DETAIL MODAL — full breakdown like steps-list
// ═══════════════════════════════════════════════════
function openPayslipDetail(monthKey, isEstimate) {
  const body = document.getElementById('otPayslipBody');
  const titleEl = document.getElementById('otPayslipTitle');
  const modal = document.getElementById('otPayslipModal');
  if (!body || !modal) return;
  const F = window.OT_SALARY.formatYen;

  let slip = window.OT_SALARY.findPayslipForWorkMonth(_otState.payslips, monthKey);
  let source = 'actual';
  if (!slip || isEstimate) {
    // Build a synthetic "slip" from estimate
    const baseline = window.OT_SALARY.pickBaselineForWorkMonth(_otState.payslips, monthKey);
    if (!baseline) {
      body.innerHTML = '<div class="empty text-muted-foreground text-sm p-4 text-center">No payslip data available.</div>';
      modal.classList.add('open');
      return;
    }
    const monthPrefix = monthKey + '-';
    const entries = (_otState.requests || []).filter(o => o.date && o.date.startsWith(monthPrefix));
    const sal = window.OT_SALARY.calcMonthlySummary(entries);
    const est = window.OT_SALARY.calcFullMonthEstimate(sal.gross, baseline, { basicSalaryIndex: 1.0 });
    slip = {
      month: monthKey,
      bonus: false,
      estimated: true,
      baselineMonth: baseline.month,
      contract: baseline.contract,
      work: {
        ot_hours: sal.totalHours, sunday_hours: sal.sundayHours,
        night_hours: sal.nightHours, basic_index: 1.0,
      },
      gross: est.gross,
      gross_breakdown: {
        basic_a_paid: baseline.contract?.basic_a || 0,
        basic_b_paid: baseline.contract?.basic_b || 0,
        fixed_allowance_paid: baseline.contract?.fixed_allowance || 0,
        ot_allowance: Math.round(sal.baseOTLine || 0),
        sunday_ot_allowance: Math.round(sal.sundayLine || 0),
        night_allowance: Math.round(sal.nightLine || 0),
      },
      deductions: {
        health_insurance: est.health, welfare_insurance: est.welfare,
        unemployment_insurance: est.unemployment, insurance_total: est.insuranceTotal,
        income_tax: est.incomeTax, resident_tax: est.residentTax,
        total_payable_to_gov: est.insuranceTotal + est.incomeTax + est.residentTax,
        taxable_income: est.taxable,
      },
      company_receivables: baseline.company_receivables,
      net_after_tax: est.netAfterTax,
      take_home: est.takeHome,
    };
    source = 'estimate';
  }

  titleEl.innerHTML = `${ICON('wallet', 18)} Payslip ${slip.month} ` +
    (source === 'estimate'
      ? `<span class="ot-takehome-est" style="margin-left:6px">est. (baseline ${slip.baselineMonth})</span>`
      : `<span class="ot-takehome-est ot-real-badge" style="margin-left:6px">actual</span>`);

  const c = slip.contract || {};
  const w = slip.work || {};
  const gb = slip.gross_breakdown || {};
  const d = slip.deductions || {};
  const cr = slip.company_receivables || {};

  const section = (title, lines, totalLabel, totalVal, totalCls) => {
    let html = `<div class="payslip-section"><div class="payslip-section-head">${title}</div>`;
    for (const ln of lines) {
      if (ln.value == null) continue;
      html += `<div class="payslip-row"><span class="payslip-label">${ln.label}</span><span class="payslip-val">${typeof ln.value === 'number' ? F(ln.value) : ln.value}</span></div>`;
    }
    if (totalLabel) {
      html += `<div class="payslip-row payslip-total ${totalCls||''}"><span class="payslip-label">${totalLabel}</span><span class="payslip-val">${F(totalVal)}</span></div>`;
    }
    return html + '</div>';
  };

  let html = '';

  const stdIns = c.standard_insurance || window.OT_SALARY.DEDUCTIONS.STANDARD_INSURANCE_AMOUNT;
  const HR = window.OT_SALARY.DEDUCTIONS.HEALTH_RATE;
  const WR = window.OT_SALARY.DEDUCTIONS.WELFARE_RATE;
  const UR = window.OT_SALARY.DEDUCTIONS.UNEMPLOYMENT_RATE;

  // ── Section 1: Work / Attendance ──
  html += section('Work / Attendance (勤怠)', [
    { label: 'Standard hours (所定労働)', value: w.standard_hours ? `${w.standard_hours}h` : null },
    { label: 'Month hours worked (実働)', value: w.month_hours ? `${w.month_hours}h` : null },
    { label: 'Basic index (出勤率)', value: (w.basic_index ?? 1).toFixed(2) },
    { label: 'OT hours (残業)', value: w.ot_hours != null ? `${(w.ot_hours).toFixed(2)}h` : null },
    { label: 'Sunday hours (日曜)', value: w.sunday_hours ? `${(w.sunday_hours).toFixed(2)}h` : null },
    { label: 'Night hours 22:00–05:00 (深夜)', value: w.night_hours ? `${(w.night_hours).toFixed(2)}h` : null },
    { label: 'Other OT hours', value: w.other_ot_hours ? `${(w.other_ot_hours).toFixed(2)}h` : null },
    { label: 'Hourly wage (時給単価)', value: c.hourly_wage ? `¥${c.hourly_wage.toLocaleString()}` : null },
  ], null, null, null);

  // ── Section 2: Contract base + gross breakdown ──
  const contractLines = [
    { label: 'Basic salary A (基本給A)', value: gb.basic_a_paid ?? c.basic_a },
    { label: 'Basic salary B (基本給B / DC)', value: gb.basic_b_paid ?? c.basic_b },
    { label: 'Fixed allowance (固定残業手当)', value: gb.fixed_allowance_paid ?? c.fixed_allowance },
  ];
  if (c.housing_allowance) contractLines.push({ label: 'Housing allowance (住宅手当)', value: c.housing_allowance });
  if (c.family_allowance) contractLines.push({ label: 'Family allowance (家族手当)', value: c.family_allowance });
  if (c.other_allowance) contractLines.push({ label: 'Other allowance', value: c.other_allowance });
  contractLines.push({ label: 'Travel allowance (通勤手当)', value: c.travel_allowance ?? 0 });
  html += section('Earnings — contract (支給)', contractLines, null, null, null);

  // ── Section 3: OT income ──
  const otLines = [
    { label: `Base OT 125% — ${(w.ot_hours||0).toFixed(2)}h`, value: gb.ot_allowance },
  ];
  if (w.sunday_hours) otLines.push({ label: `Sunday +10% — ${(w.sunday_hours).toFixed(2)}h`, value: gb.sunday_ot_allowance });
  if (w.night_hours) otLines.push({ label: `Night +25% — ${(w.night_hours).toFixed(2)}h`, value: gb.night_allowance });
  if (gb.other_ot_allowance) otLines.push({ label: 'Other OT allowance', value: gb.other_ot_allowance });
  if (gb.other_income) otLines.push({ label: 'Other income', value: gb.other_income });
  html += section('Earnings — OT (残業手当)', otLines, 'Gross income (総支給額)', slip.gross, 'is-income');

  // ── Section 4: Deductions — insurance ──
  html += section('Deductions — insurance (控除・社保)', [
    { label: `Health ins. (健康保険 ${(HR*100).toFixed(2)}% × ¥${stdIns.toLocaleString()})`, value: d.health_insurance },
    { label: `Welfare ins. (厚生年金 ${(WR*100).toFixed(2)}% × ¥${stdIns.toLocaleString()})`, value: d.welfare_insurance },
    { label: `Unemployment ins. (雇用保険 ${(UR*100).toFixed(1)}% × Gross)`, value: d.unemployment_insurance },
  ], 'Total insurance (社保合計)', d.insurance_total, 'is-deduction');

  // ── Section 5: Deductions — taxes ──
  html += section('Deductions — taxes (控除・税)', [
    { label: 'Taxable income (課税対象額)', value: d.taxable_income },
    { label: 'Income tax (源泉徴収 甲欄)', value: d.income_tax },
    { label: 'Resident tax (住民税)', value: d.resident_tax },
  ], 'Total to government (公租公課)', d.total_payable_to_gov, 'is-deduction');

  // ── Section 6: Subtotal — net after tax ──
  html += `<div class="payslip-section">
    <div class="payslip-row payslip-subtotal">
      <span class="payslip-label">= Net after tax (差引支給額)</span>
      <span class="payslip-val">${F(slip.net_after_tax)}</span>
    </div>
  </div>`;

  // ── Section 7: Company receivables ──
  if (cr && (cr.total || (cr.items && cr.items.length))) {
    const items = (cr.items || []).map(it => ({ label: it.label || `Item ${it.sub}`, value: it.value }));
    html += section('Company receivables (立替金控除)', items, 'Total receivables', cr.total || 0, 'is-deduction');
  }

  // ── Section 8: Company payable (if any) ──
  if (slip.company_payable) {
    html += `<div class="payslip-section">
      <div class="payslip-row"><span class="payslip-label">Company payable (会社立替金)</span><span class="payslip-val">${F(slip.company_payable)}</span></div>
    </div>`;
  }

  // ── Grand total ──
  const crTotal = (cr && cr.total) ? cr.total : 0;
  html += `<div class="payslip-section payslip-final">
    <div class="payslip-row payslip-grand-total">
      <span class="payslip-label">${ICON('wallet', 14)} Take-home (振込額)</span>
      <span class="payslip-val">${F(slip.take_home)}</span>
    </div>
    <div class="payslip-formula">
      振込額 = 総支給額 − 社保 − 所得税 − 住民税 − 立替金<br>
      <span class="payslip-formula-nums">${F(slip.gross)} − ${F(d.insurance_total)} − ${F(d.income_tax)} − ${F(d.resident_tax)} − ${F(crTotal)} = <strong>${F(slip.take_home)}</strong></span>
    </div>
    <div class="payslip-formula" style="margin-top:4px;opacity:0.7">
      標準報酬月額: ¥${stdIns.toLocaleString()}
    </div>
  </div>`;

  if (source === 'estimate') {
    html += `<div class="text-xs text-muted-foreground mt-3" style="line-height:1.5">
      ★ Estimated using payslip <strong>${slip.baselineMonth}</strong> as fixed-cost baseline.
      OT income from this month's entries. Final payslip is authoritative.
    </div>`;
  }

  body.innerHTML = html;
  modal.classList.add('open');
}

function closePayslipDetail() {
  const m = document.getElementById('otPayslipModal');
  if (m) m.classList.remove('open');
}
