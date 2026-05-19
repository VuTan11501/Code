// ═══════════════════════════════════════════════════
//  OT PLANNER — Manage OT requests + conflict auto-fix
//  Storage: Gist file `ot-requests.json` (same Gist as scheduled-runs.json)
// ═══════════════════════════════════════════════════
const OT_FILE = 'ot-requests.json';
const OT_CHECKOUT_WF = 'auto-checkout.yml';

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

async function loadOtData() {
  const grid = document.getElementById('otCalendar');
  const tbody = document.getElementById('otTableBody');
  if (grid) grid.innerHTML = '<div class="empty text-muted-foreground text-sm p-5 text-center">Loading...</div>';
  if (tbody) tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted-foreground py-8">Loading...</td></tr>';
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
    if (grid) grid.innerHTML = `<div class="empty text-destructive text-sm p-5 text-center">Failed to load: ${e.message}</div>`;
    if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="text-center text-destructive py-6">Failed: ${e.message}</td></tr>`;
  }
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
  // OT API rule: only [today, today + 7 days] can be created via DokoKin API
  const now = jstNow();
  const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  const max = new Date(now); max.setDate(max.getDate() + 7);
  const maxStr = `${max.getFullYear()}-${String(max.getMonth()+1).padStart(2,'0')}-${String(max.getDate()).padStart(2,'0')}`;
  return { today, maxStr, maxDays: 7 };
}

function _isDateInWindow(dateStr) {
  const w = _otCreationWindow();
  return dateStr >= w.today && dateStr <= w.maxStr;
}

function _showOutOfWindowToast(dateStr) {
  const w = _otCreationWindow();
  const isPast = dateStr < w.today;
  if (isPast) {
    toast(`📅 ${dateStr} đã qua — DokoKin chỉ tạo OT cho hôm nay trở đi`, 'warning');
  } else {
    toast(`📅 ${dateStr} vượt cửa sổ 7 ngày — chỉ có thể tạo OT đến ${w.maxStr}`, 'warning');
  }
}

function renderOtCalendar() {
  const grid = document.getElementById('otCalendar');
  if (!grid) return;
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
  const todayStr = _todayJSTStr();
  // Show upcoming first (asc), then recent past (desc, all of them in table)
  const upcoming = _otState.requests
    .filter(o => o.date >= todayStr)
    .sort((a,b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
  const past = _otState.requests
    .filter(o => o.date < todayStr)
    .sort((a,b) => b.date.localeCompare(a.date));
  const all = [...upcoming, ...past];

  if (countEl) {
    const upN = upcoming.length, pastN = past.length;
    countEl.textContent = `${all.length} entr${all.length === 1 ? 'y' : 'ies'} (${upN} upcoming, ${pastN} past)`;
  }

  if (!all.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted-foreground py-8">No OT requests. Tap "+ Add OT" or click a date on the calendar.</td></tr>';
    return;
  }

  tbody.innerHTML = all.map((ot, idx) => _renderOtRow(ot, idx, ot.date < todayStr)).join('');
}

function _renderOtRow(ot, idx, isPast) {
  const conf = detectConflict(ot);
  const crossMid = ot.end < ot.start;
  const dayName = new Date(ot.date + 'T00:00:00+09:00').toLocaleString('en-US', { weekday: 'short' });
  const fixed = !!ot.auto_co_id;
  const created = !!ot.kintai_created_at;

  // Status badge — palette aligned with Schedule tab semantics:
  //   blue (badge-once)     = pending / awaiting (like an upcoming once-entry)
  //   green (badge-enabled) = created / active in DokoKin
  //   purple (badge-recurring) = system-generated artifact (auto-fixed CO)
  //   yellow (badge-warning) = needs attention (conflict)
  //   grey (badge-disabled) = past / no longer actionable
  let statusBadge;
  if (isPast) {
    statusBadge = `<span class="badge-disabled">${ICON('check', 11)} Past</span>`;
  } else if (conf.hasConflict) {
    statusBadge = `<span class="badge-warning" data-tooltip="${_esc(conf.message)}">${ICON('alertTriangle', 11)} Conflict</span>`;
  } else if (created) {
    const ts = String(ot.kintai_created_at).slice(0, 16).replace('T', ' ');
    statusBadge = `<span class="badge-enabled" data-tooltip="Created in DokoKin at ${_esc(ts)} JST">${ICON('check', 11)} Created</span>`;
  } else if (fixed) {
    statusBadge = `<span class="badge-recurring" data-tooltip="Cross-midnight CO auto-scheduled">${ICON('sparkles', 11)} Auto-fixed</span>`;
  } else {
    statusBadge = `<span class="badge-once">${ICON('hourglass', 11)} Pending</span>`;
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
