// ═══════════════════════════════════════════════════
//  OT PLANNER — Manage OT requests + conflict auto-fix
//  Storage: Gist file `ot-requests.json` (same Gist as scheduled-runs.json)
// ═══════════════════════════════════════════════════
const OT_FILE = 'ot-requests.json';
const OT_CHECKOUT_WF = 'auto-checkout.yml';
const OT_CREATOR_WF = 'auto-ot-creator.yml';
const OT_CREATION_WINDOW_DAYS = 7;   // forward: today + 7 days
const OT_BACKWARD_DAYS = 1;          // backward: today - 1 day (yesterday allowed)

let _otState = {
  initialized: false,
  requests: [],          // array of OT entries
  scheduleEntries: [],   // cached scheduled-runs.json (for conflict checks)
  viewYear: null,
  viewMonth: null,       // 0-indexed
  editId: null,
};

// ─── Init ───
function initOtPlannerPage() {
  if (!_otState.initialized) {
    _otState.initialized = true;
    const now = jstNow();
    _otState.viewYear = now.getFullYear();
    _otState.viewMonth = now.getMonth();
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
  }
  const refreshBtn = document.getElementById('otRefreshBtn');
  if (isManualRefresh && refreshBtn) refreshBtn.classList.add('is-loading');
  try {
    const gist = await apiFetch(`/gists/${GIST_ID}`);
    // OT requests file
    const otFile = gist.files && gist.files[OT_FILE];
    if (otFile && otFile.content) {
      try { _otState.requests = JSON.parse(otFile.content) || []; }
      catch { _otState.requests = []; }
    } else {
      _otState.requests = [];
    }
    if (!Array.isArray(_otState.requests)) _otState.requests = [];
    // Scheduled entries (for conflict detection)
    const schedFile = gist.files && gist.files['scheduled-runs.json'];
    if (schedFile && schedFile.content) {
      try { _otState.scheduleEntries = JSON.parse(schedFile.content) || []; }
      catch { _otState.scheduleEntries = []; }
    } else {
      _otState.scheduleEntries = [];
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

// ─── Calendar render ───
function otNavMonth(delta) {
  let y = _otState.viewYear;
  let m = _otState.viewMonth + delta;
  while (m < 0) { m += 12; y -= 1; }
  while (m > 11) { m -= 12; y += 1; }
  _otState.viewYear = y;
  _otState.viewMonth = m;
  renderOtCalendar();
}

function otGoToday() {
  const now = jstNow();
  _otState.viewYear = now.getFullYear();
  _otState.viewMonth = now.getMonth();
  renderOtCalendar();
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

function renderOtCalendar() {
  const grid = document.getElementById('otCalendar');
  if (!grid) return;
  renderOtStats();
  renderOtBudget();
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
    const classes = ['ot-cell'];
    if (ots.length) classes.push('has-ot');
    if (isToday) classes.push('is-today');
    if (!inWindow) classes.push('is-disabled');
    if (isPast) classes.push('is-past');
    const totalH = ots.reduce((s, o) => s + (o.hours || 0), 0);
    const hasConflict = ots.some(o => detectConflict(o).hasConflict);
    if (hasConflict) classes.push('has-conflict');
    const click = inWindow
      ? `openOtForm('${dateStr}')`
      : (ots.length ? `openOtForm(null, '${ots[0].id}')` : `_showOutOfWindowToast('${dateStr}')`);
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
  // Treat dates within the creation window (incl. yesterday) as "actionable".
  // Only dates strictly older than yesterday are "past" for badge/sort purposes.
  const minStr = w.minStr;
  const upcoming = _otState.requests
    .filter(o => o.date >= minStr)
    .sort((a,b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
  const past = _otState.requests
    .filter(o => o.date < minStr)
    .sort((a,b) => b.date.localeCompare(a.date));
  const all = [...upcoming, ...past];

  if (countEl) {
    const upN = upcoming.length, pastN = past.length;
    countEl.textContent = `${all.length} entr${all.length === 1 ? 'y' : 'ies'} (${upN} actionable, ${pastN} past)`;
  }

  if (!all.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted-foreground py-8">No OT requests. Tap "+ Add OT" or click a date on the calendar.</td></tr>';
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
    // In creation window — will be auto-created at next 10:00 JST run
    const next = _nextAutoCreateTime();
    const until = _humanizeUntil(next);
    const tipTs = `${next.getFullYear()}-${String(next.getMonth()+1).padStart(2,'0')}-${String(next.getDate()).padStart(2,'0')} 10:00 JST`;
    statusBadge = `<span class="badge-once" data-tooltip="Will auto-create on ${_esc(tipTs)} via Auto OT Creator">${ICON('hourglass', 11)} Pending · auto in ${until}</span>`;
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
    <td class="actions-cell"><div class="actions-cell">
      ${fixBtn}
      <button class="btn sm" onclick="openOtForm(null, '${ot.id}')" data-tooltip="Edit">${ICON('edit', 14)}</button>
      <button class="btn danger sm" onclick="deleteOtRequest('${ot.id}')" data-tooltip="Delete">${ICON('trash', 14)}</button>
    </div></td>
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
  const res = await fetch(`${API}/gists/${GIST_ID}`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${sessionToken}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: { [OT_FILE]: { content: JSON.stringify(arr, null, 2) } } }),
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
  const res = await fetch(`${API}/gists/${GIST_ID}`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${sessionToken}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: {
      'scheduled-runs.json': { content: JSON.stringify(sched, null, 2) },
      [OT_FILE]: { content: JSON.stringify(ots, null, 2) },
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

  host.innerHTML = `
    <div class="stat-chip" data-tooltip="OT entries in this month view"><span class="stat-num">${monthTotal}</span><span class="stat-lbl">entries</span></div>
    <div class="stat-chip" data-tooltip="Total OT hours in this month view"><span class="stat-num">${hoursDisplay}</span><span class="stat-lbl">hours</span></div>
    <div class="stat-chip" data-tooltip="Already created in DokoKin / total this month"><span class="stat-num">${createdRatio}</span><span class="stat-lbl">created</span></div>
    <div class="stat-chip stat-chip-income" data-tooltip="${_esc(incomeTip)}"><span class="stat-num">${incomeStr}</span><span class="stat-lbl">income</span></div>
    <div class="stat-chip stat-chip-next" data-tooltip="${_esc(nextTooltip)}"><span class="stat-num">${nextStr}</span><span class="stat-lbl">next OT</span></div>
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
        <div class="ot-progress ${hoursCls}" data-tooltip="Legal max ${S.MAX_HOURS_PER_MONTH}h/month per DokoKin">
          <div class="ot-progress-fill" style="width:${hoursPct}%"></div>
        </div>
      </div>
      <div class="ot-budget-row">
        <div class="ot-budget-row-label">
          <span>Night hours (22:00–05:00)</span>
          <span class="ot-budget-row-val">${H(sal.nightHours)} / ${S.NIGHT_REMARK_THRESHOLD}h</span>
        </div>
        <div class="ot-progress ${nightCls}" data-tooltip="≥${S.NIGHT_REMARK_THRESHOLD}h → 'Over 60H OT' remark on payslip">
          <div class="ot-progress-fill" style="width:${nightPct}%"></div>
        </div>
      </div>
      <div class="ot-budget-breakdown">
        <span data-tooltip="125% rate on all OT hours — ${F(sal.baseOTLine)}">${ICON('clock', 11)} Base ${F(sal.baseOTLine)}</span>
        <span data-tooltip="+10% extra on Sunday hours">☀️ Sun ${H(sal.sundayHours)} · ${F(sal.sundayLine)}</span>
        <span data-tooltip="+25% extra on night-zone hours">🌙 Night ${H(sal.nightHours)} · ${F(sal.nightLine)}</span>
        <span data-tooltip="Fixed allowance paid monthly regardless of OT done">💴 Fixed allowance ${F(S.FIXED_ALLOWANCE_YEN)}</span>
      </div>
    </div>
  `;
}