// ═══════════════════════════════════════════════════
//  SCHEDULE PAGE — Calendar, Scheduled Runs, Pickers
// ═══════════════════════════════════════════════════
let scheduleInitialized = false;
let dispatchTimer = null;

function initSchedulePage() {
  // ── One-time setup (calendars, modal wiring, listeners) ──
  if (!scheduleInitialized) {
    scheduleInitialized = true;
    // Calendar will be rendered dynamically when Gist data loads
    renderScheduleCalendar(null);
    initCalendar('calPicker', 'schedDate', 'schedDateInput', { allowPast: false });
    initCalendar('calPickerStart', 'schedStartDate', 'schedStartDateInput', { allowPast: true });
    initCalendar('calPickerEnd', 'schedEndDate', 'schedEndDateInput', { allowPast: true });
    // Edit modal calendars (mirror create form)
    initCalendar('editCalPicker', 'editSchedDate', 'editSchedDateInput', { allowPast: false });
    initCalendar('editCalPickerStart', 'editSchedStartDate', 'editSchedStartDateInput', { allowPast: true });
    initCalendar('editCalPickerEnd', 'editSchedEndDate', 'editSchedEndDateInput', { allowPast: true });
    renderMonthDateGrid('sched');
  }

  // ── Always refresh on every visit: default Date+Time = NOW (JST) ──
  refreshSchedDefaults();
  loadScheduledRuns();
}

function refreshSchedDefaults() {
  const now = jstNow();
  TIME_STATE.sched.h = now.getHours();
  TIME_STATE.sched.m = now.getMinutes();
  selectedHour = now.getHours();
  selectedMinute = now.getMinutes();
  renderTimePicker('sched');
  initNativeTimeInput('sched');
  // Sync mobile native input even if already bound
  const nativeInput = document.getElementById('schedTimeNative');
  if (nativeInput) {
    nativeInput.value = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  }
  const todayStr = formatDate(now.getFullYear(), now.getMonth(), now.getDate());
  calSelect('calPicker', todayStr);
}

/**
 * Compute when the next entry should fire (ms from now).
 * Returns null if no upcoming entries.
 */
function computeNextFireDelay(entries) {
  if (!entries || !entries.length) return null;
  const now = Date.now();
  const nowJST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  let nextMs = Infinity;

  for (const e of entries) {
    if (e.type === 'once' && e.run_at && !e.dispatched) {
      const t = new Date(e.run_at).getTime();
      if (t > now - 30000 && t < nextMs) nextMs = t;
    } else if (e.type === 'recurring' && e.enabled !== false) {
      const r = e.recurrence || {};
      const [h, m] = (r.time || '00:00').split(':').map(Number);
      // Find next occurrence within next 48h
      for (let dayOffset = 0; dayOffset < 2; dayOffset++) {
        const d = new Date(nowJST);
        d.setDate(d.getDate() + dayOffset);
        d.setHours(h, m, 0, 0);
        if (d.getTime() <= now) continue;
        // Check pattern match
        const dow = d.getDay();
        let match = false;
        if (r.pattern === 'daily') match = true;
        else if (r.pattern === 'weekdays') match = [1,2,3,4,5].includes(dow);
        else if (r.pattern === 'weekly') match = (r.days || []).includes(dow);
        else if (r.pattern === 'monthly') match = (r.dates || []).includes(d.getDate());
        if (match) {
          // Check already ran on that day
          if (e.last_run) {
            const lastRunJST = new Date(new Date(e.last_run).toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
            if (lastRunJST.toDateString() === d.toDateString()) continue;
          }
          if (d.getTime() < nextMs) nextMs = d.getTime();
          break;
        }
      }
    }
  }

  if (nextMs === Infinity) return null;
  // Add small jitter past target to ensure server time has passed (30s buffer)
  return Math.max(0, nextMs - now + 30000);
}

/**
 * Schedule a precise wake-up to dispatch the next entry.
 * Re-schedules itself after each fire.
 */
function scheduleNextDispatch(entries) {
  if (dispatchTimer) { clearTimeout(dispatchTimer); dispatchTimer = null; }
  const delay = computeNextFireDelay(entries);
  if (delay === null) {
    // Nothing upcoming — fallback: re-check in 5 min
    dispatchTimer = setTimeout(checkAndDispatchOverdue, 5 * 60 * 1000);
    return;
  }
  // Cap delay at 5 min so we don't sleep forever (in case entries change)
  const wake = Math.min(delay, 5 * 60 * 1000);
  dispatchTimer = setTimeout(checkAndDispatchOverdue, wake);
}

async function checkAndDispatchOverdue() {
  dispatchTimer = null;
  if (!sessionToken) {
    // Try again later in case user just unlocked
    dispatchTimer = setTimeout(checkAndDispatchOverdue, 60 * 1000);
    return;
  }
  try {
    const gist = await apiFetch(`/gists/${GIST_ID}`);
    const file = gist.files['scheduled-runs.json'];
    if (!file) {
      scheduleNextDispatch([]);
      return;
    }
    const entries = JSON.parse(file.content);
    const hadDispatches = await clientSideDispatchOverdue(entries);
    if (hadDispatches) {
      renderScheduleCalendar(entries);
      renderScheduledQueue(entries);
    }
    scheduleNextDispatch(entries);
  } catch {
    // On error, retry in 1 min
    dispatchTimer = setTimeout(checkAndDispatchOverdue, 60 * 1000);
  }
}

// ═══════════════════════════════════════════════════
//  SCHEDULE CALENDAR (Weekly overview — interactive)
// ═══════════════════════════════════════════════════
let _calendarEntries = [];      // cached for pip-action handlers
let _pressTimer = null;          // long-press detection
let _pressMoved = false;

const PIP_FILTER_KEY = 'sched_pip_filter_v1';
const PIP_TYPES = [
  { key: 'checkin',  label: 'Checkin',  match: f => f.includes('checkin') },
  { key: 'checkout', label: 'Checkout', match: f => f.includes('checkout') },
  { key: 'ot',       label: 'OT',       match: f => f.includes('ot-creator') || f.includes('ot-report') },
  { key: 'forecast', label: 'Forecast', match: f => f.includes('forecast') || f.includes('jpy') },
];
function _loadPipFilter() {
  try { return JSON.parse(localStorage.getItem(PIP_FILTER_KEY)) || {}; } catch { return {}; }
}
function _savePipFilter(f) { try { localStorage.setItem(PIP_FILTER_KEY, JSON.stringify(f)); } catch {} }
function _pipTypeOf(wfFile) {
  const t = PIP_TYPES.find(t => t.match(wfFile || ''));
  return t ? t.key : 'forecast';
}
function togglePipFilter(key) {
  const f = _loadPipFilter();
  f[key] = f[key] === false;     // toggle (default visible = true)
  _savePipFilter(f);
  renderScheduleCalendar(_calendarEntries);
}

function renderScheduleCalendar(gistEntries) {
  const container = document.getElementById('scheduleCalendar');
  if (!container) return;

  _calendarEntries = gistEntries || [];
  closePipPopover();

  const filter = _loadPipFilter();
  const isHidden = (k) => filter[k] === true;     // hidden when explicitly true

  // Build pip records: { entryIdx, dayIdx, time, name, wfFile, enabled, typeKey }
  const pips = [];
  const typeCounts = { checkin: 0, checkout: 0, ot: 0, forecast: 0 };
  for (let i = 0; i < _calendarEntries.length; i++) {
    const entry = _calendarEntries[i];
    if (entry.type !== 'recurring') continue;
    const r = entry.recurrence || {};
    const wf = WORKFLOWS.find(w => w.file === entry.workflow);
    const name = wf ? wf.name : entry.workflow;
    const typeKey = _pipTypeOf(entry.workflow);
    let days = [];
    if (r.pattern === 'daily') days = [0,1,2,3,4,5,6];
    else if (r.pattern === 'weekdays') days = [1,2,3,4,5];
    else if (r.pattern === 'weekly') days = r.days || [];
    else continue;
    if (!days.length) continue;
    const time = r.time || '00:00';
    for (const d of days) {
      pips.push({ entryIdx: i, dayIdx: d, time, name, wfFile: entry.workflow, enabled: entry.enabled !== false, typeKey });
      if (entry.enabled !== false) typeCounts[typeKey] = (typeCounts[typeKey] || 0) + 1;
    }
  }
  const visiblePips = pips.filter(p => !isHidden(p.typeKey));

  // Stats
  const activeEntries = _calendarEntries.filter(e => e.enabled !== false && (e.type === 'recurring' || (e.type === 'once' && !e.dispatched))).length;
  const oneTimePending = _calendarEntries.filter(e => e.type === 'once' && !e.dispatched).length;
  const nextDelay = (typeof computeNextFireDelay === 'function') ? computeNextFireDelay(_calendarEntries) : null;
  const nextStr = (nextDelay && nextDelay > 0) ? _formatCountdown(nextDelay) : '—';
  const weekRuns = visiblePips.filter(p => p.enabled).length;     // visible recurring runs/week

  // Collect unique times. Always include common slots so empty grid still useful.
  const baseTimes = ['09:00', '12:00', '18:00', '22:00'];
  const timeSet = new Set(baseTimes);
  for (const p of visiblePips) timeSet.add(p.time);
  const times = [...timeSet].sort();

  const nowJST = jstNow();
  const todayDow = nowJST.getDay();
  const nowMin = nowJST.getHours() * 60 + nowJST.getMinutes();
  let nextTimeIdx = -1;
  for (let i = 0; i < times.length; i++) {
    const [h, m] = times[i].split(':').map(Number);
    if (h * 60 + m >= nowMin) { nextTimeIdx = i; break; }
  }

  const dayNames = ['S','M','T','W','T','F','S'];
  let html = '';

  // Stats bar
  html += `<div class="schedule-stats">
    <div class="stat-chip"><span class="stat-num">${activeEntries}</span><span class="stat-lbl">active</span></div>
    <div class="stat-chip"><span class="stat-num">${weekRuns}</span><span class="stat-lbl">runs/week</span></div>
    <div class="stat-chip"><span class="stat-num">${oneTimePending}</span><span class="stat-lbl">one-time</span></div>
    <div class="stat-chip stat-chip-next"><span class="stat-num">${nextStr}</span><span class="stat-lbl">next run</span></div>
  </div>`;

  // Filter chips
  html += '<div class="schedule-filter">';
  for (const t of PIP_TYPES) {
    const count = typeCounts[t.key] || 0;
    const hidden = isHidden(t.key);
    html += `<button type="button" class="filter-chip filter-${t.key}${hidden ? ' off' : ''}" onclick="togglePipFilter('${t.key}')" title="${hidden ? 'Show' : 'Hide'} ${t.label}">
      <span class="filter-dot"></span>${t.label}<span class="filter-count">${count}</span>
    </button>`;
  }
  html += '</div>';

  // Grid
  html += '<div class="schedule-grid-wrapper"><div class="schedule-grid">';
  html += '<div class="schedule-cell header"></div>';
  for (let d = 0; d < 7; d++) {
    const cls = d === todayDow ? 'header today-col' : 'header';
    html += `<div class="schedule-cell ${cls}">${dayNames[d]}</div>`;
  }
  for (let ti = 0; ti < times.length; ti++) {
    const time = times[ti];
    const rowCls = ti === nextTimeIdx ? 'time-label next-time' : 'time-label';
    html += `<div class="schedule-cell ${rowCls}" title="${ti === nextTimeIdx ? 'Next upcoming slot' : ''}">${time}</div>`;
    for (let day = 0; day < 7; day++) {
      const cellPips = visiblePips.filter(p => p.dayIdx === day && p.time === time);
      const isToday = day === todayDow;
      const isNext = ti === nextTimeIdx;
      const classes = ['schedule-cell', 'sc-slot'];
      if (isToday) classes.push('today-col');
      if (isToday && isNext) classes.push('now-slot');
      if (cellPips.length === 0) classes.push('empty-slot');
      const onclick = cellPips.length === 0
        ? `onclick="quickAddRecurring(${day}, '${time}')"`
        : '';
      html += `<div class="${classes.join(' ')}" ${onclick} title="${cellPips.length === 0 ? 'Tap to add' : ''}">`;
      for (const p of cellPips) {
        const dimmed = p.enabled ? '' : ' disabled';
        html += `<span class="schedule-pip ${p.typeKey}${dimmed}" data-entry="${p.entryIdx}" title="${p.name}${p.enabled ? '' : ' (disabled)'}">${p.name.split(' ').slice(-1)[0]}</span>`;
      }
      html += '</div>';
    }
  }
  html += '</div>';
  html += '<div class="schedule-legend">';
  html += '<span class="legend-item"><span class="legend-dot today-col"></span>Today</span>';
  html += '<span class="legend-item"><span class="legend-dot next-time"></span>Next slot</span>';
  html += '<span class="legend-item text-muted">Tap empty cell to add · Tap pip for actions · Long-press to toggle</span>';
  html += '</div></div>';
  container.innerHTML = html;

  // Wire up pip interactions
  container.querySelectorAll('.schedule-pip[data-entry]').forEach(pip => {
    const entryIdx = parseInt(pip.getAttribute('data-entry'));
    pip.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      _pressMoved = false;
      _pressTimer = setTimeout(() => {
        _pressTimer = null;
        toggleRecurringEnabled(entryIdx, pip);
      }, 550);
    });
    pip.addEventListener('pointermove', () => { _pressMoved = true; });
    pip.addEventListener('pointerup', (e) => {
      e.stopPropagation();
      if (_pressTimer) {
        clearTimeout(_pressTimer); _pressTimer = null;
        if (!_pressMoved) openPipActions(entryIdx, pip);
      }
    });
    pip.addEventListener('pointercancel', () => {
      if (_pressTimer) { clearTimeout(_pressTimer); _pressTimer = null; }
    });
  });

  document.addEventListener('click', _outsidePopoverHandler, { capture: true });
}

function _formatCountdown(ms) {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms/1000))}s`;
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60), m = min % 60;
  if (h < 24) return m ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24), hr = h % 24;
  return hr ? `${d}d ${hr}h` : `${d}d`;
}

function _outsidePopoverHandler(e) {
  const pop = document.getElementById('pipActionsPopover');
  if (pop && !pop.contains(e.target) && !e.target.closest('.schedule-pip')) {
    closePipPopover();
  }
}

function closePipPopover() {
  const pop = document.getElementById('pipActionsPopover');
  if (pop) pop.remove();
}

function openPipActions(entryIdx, pipEl) {
  closePipPopover();
  const entry = _calendarEntries[entryIdx];
  if (!entry) return;
  const wf = WORKFLOWS.find(w => w.file === entry.workflow);
  const name = wf ? wf.name : entry.workflow;
  const enabled = entry.enabled !== false;
  const time = entry.recurrence?.time || '';

  // Per-entry next-fire countdown
  let nextFireStr = '';
  if (typeof computeNextFireDelay === 'function') {
    const d = computeNextFireDelay([entry]);
    if (d && d > 0) nextFireStr = ` · next in ${_formatCountdown(d)}`;
  }

  const pop = document.createElement('div');
  pop.id = 'pipActionsPopover';
  pop.className = 'pip-popover';
  pop.innerHTML = `
    <div class="pip-popover-header">
      <div class="pip-popover-title">${wf?.icon || '⚙️'} ${name}</div>
      <div class="pip-popover-sub text-muted">${time} · ${describeRecurrence(entry.recurrence || {})}${nextFireStr}</div>
    </div>
    <div class="pip-popover-actions">
      <button class="btn sm" onclick="runScheduledNow(${entryIdx})">${ICON('play', 14)} Run now</button>
      <button class="btn sm" onclick="openEditSchedModal(${entryIdx}); closePipPopover();">${ICON('edit', 14)} Edit</button>
      <button class="btn sm" onclick="duplicateScheduledRun(${entryIdx})">${ICON('copy', 14)} Duplicate</button>
      <button class="btn sm" onclick="toggleRecurringEnabled(${entryIdx})">${ICON(enabled ? 'pause' : 'play', 14)} ${enabled ? 'Disable' : 'Enable'}</button>
      <button class="btn danger sm pip-action-wide" onclick="deleteScheduledRun(${entryIdx}); closePipPopover();">${ICON('trash', 14)} Delete</button>
    </div>
  `;
  document.body.appendChild(pop);

  // Position popover below pip, clamped to viewport
  const rect = pipEl.getBoundingClientRect();
  const popRect = pop.getBoundingClientRect();
  let top = rect.bottom + 6 + window.scrollY;
  let left = rect.left + (rect.width / 2) - (popRect.width / 2) + window.scrollX;
  const maxLeft = window.innerWidth - popRect.width - 8;
  if (left < 8) left = 8;
  if (left > maxLeft) left = maxLeft;
  // Flip above if no room below
  if (rect.bottom + popRect.height + 16 > window.innerHeight) {
    top = rect.top - popRect.height - 6 + window.scrollY;
  }
  pop.style.top = `${top}px`;
  pop.style.left = `${left}px`;
}

async function toggleRecurringEnabled(entryIdx, pipEl) {
  closePipPopover();
  try {
    const entries = await loadEntriesFromGist();
    if (!entries[entryIdx]) return;
    entries[entryIdx].enabled = entries[entryIdx].enabled === false ? true : false;
    await saveToGist(entries);
    toast(entries[entryIdx].enabled ? '▶ Enabled' : '⏸ Disabled');
    loadScheduledRuns();
  } catch (e) { toast(`❌ ${e.message}`); }
}

async function runScheduledNow(entryIdx) {
  closePipPopover();
  const entry = _calendarEntries[entryIdx];
  if (!entry) return;
  if (!sessionToken) { toast('⚠️ Not authenticated'); return; }
  try {
    const inputs = {};
    if (entry.location) inputs.location = entry.location;
    if (entry.location_lat != null) inputs.latitude = String(entry.location_lat);
    if (entry.location_lon != null) inputs.longitude = String(entry.location_lon);
    const res = await fetch(`${API}/repos/${OWNER}/${REPO}/actions/workflows/${entry.workflow}/dispatches`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${sessionToken}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'main', inputs: Object.keys(inputs).length ? inputs : undefined }),
    });
    if (res.status === 204) {
      const wf = WORKFLOWS.find(w => w.file === entry.workflow);
      toast(`✅ Dispatched: ${wf ? wf.name : entry.workflow}`);
    } else {
      toast(`❌ Failed (${res.status})`);
    }
  } catch (e) { toast(`❌ ${e.message}`); }
}

async function duplicateScheduledRun(entryIdx) {
  closePipPopover();
  try {
    const entries = await loadEntriesFromGist();
    const src = entries[entryIdx];
    if (!src) { toast('⚠️ Entry not found'); return; }
    const copy = JSON.parse(JSON.stringify(src));
    copy.created = new Date().toISOString();
    if (copy.type === 'once') {
      copy.dispatched = false;
      delete copy.last_run;
    } else {
      delete copy.last_run;
    }
    copy.note = (copy.note ? copy.note + ' ' : '') + '(copy)';
    entries.push(copy);
    await saveToGist(entries);
    toast('📋 Duplicated');
    loadScheduledRuns();
  } catch (e) { toast(`❌ ${e.message}`); }
}

function quickAddRecurring(dayIdx, time) {
  closePipPopover();
  // Pre-fill the Add form with weekly pattern + selected day + selected time
  const typeEl = document.getElementById('schedType');
  if (typeEl) { typeEl.value = 'recurring'; typeof toggleScheduleType === 'function' && toggleScheduleType('recurring'); }
  const patternEl = document.getElementById('schedPattern');
  if (patternEl) { patternEl.value = 'weekly'; typeof togglePatternUI === 'function' && togglePatternUI('sched'); }
  // Tick the day checkbox
  document.querySelectorAll('#weeklyDaysField input[type=checkbox]').forEach(cb => {
    cb.checked = parseInt(cb.value) === dayIdx;
  });
  // Set time
  const [h, m] = time.split(':').map(Number);
  if (typeof setTimeState === 'function') {
    setTimeState('sched', h, m);
    if (typeof renderTimePicker === 'function') renderTimePicker('sched');
    if (typeof updateTimeDisplay === 'function') updateTimeDisplay('sched');
  }
  const timeInput = document.getElementById('schedTime');
  if (timeInput) timeInput.value = time;
  // Scroll to form and flash
  const form = document.querySelector('.scheduler-form');
  if (form) {
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    form.classList.add('form-flash');
    setTimeout(() => form.classList.remove('form-flash'), 1200);
  }
  const dayName = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dayIdx];
  toast(`📝 Pre-filled: every ${dayName} at ${time}`);
}

// ═══════════════════════════════════════════════════
//  CUSTOM CALENDAR PICKER
// ═══════════════════════════════════════════════════
class CalendarPicker {
  constructor(containerId, inputId, displayInputId, options = {}) {
    this.container = document.getElementById(containerId);
    this.input = document.getElementById(inputId);
    this.displayInput = document.getElementById(displayInputId);
    this.allowPast = options.allowPast || false;
    const now = jstNow();
    this.year = now.getFullYear();
    this.month = now.getMonth();
    this.selected = null;
    this.todayStr = formatDate(now.getFullYear(), now.getMonth(), now.getDate());
    this.render();
  }

  render() {
    const firstDay = new Date(this.year, this.month, 1).getDay();
    const daysInMonth = new Date(this.year, this.month + 1, 0).getDate();
    const monthName = new Date(this.year, this.month).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    let html = `<div class="cal-nav">
      <button onclick="calNav('${this.container.id}', -1)">‹</button>
      <span class="cal-month">${monthName}</span>
      <button onclick="calNav('${this.container.id}', 1)">›</button>
    </div>`;
    html += '<div class="cal-grid">';
    const dows = ['Su','Mo','Tu','We','Th','Fr','Sa'];
    for (const d of dows) html += `<div class="cal-dow">${d}</div>`;

    for (let i = 0; i < firstDay; i++) html += '<div class="cal-day empty"></div>';

    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = formatDate(this.year, this.month, day);
      const dow = new Date(this.year, this.month, day).getDay();
      const isToday = dateStr === this.todayStr;
      const isSelected = dateStr === this.selected;
      const isPast = !this.allowPast && dateStr < this.todayStr;
      const cls = ['cal-day', isToday ? 'today' : '', isSelected ? 'selected' : '', isPast ? 'disabled' : '', dow === 0 ? 'sun' : '', dow === 6 ? 'sat' : ''].filter(Boolean).join(' ');
      const click = isPast ? '' : `onclick="calSelect('${this.container.id}', '${dateStr}')"`;
      html += `<div class="${cls}" ${click}>${day}</div>`;
    }
    html += '</div>';
    this.container.innerHTML = html;
  }

  navigate(offset) {
    this.month += offset;
    if (this.month > 11) { this.month = 0; this.year++; }
    if (this.month < 0) { this.month = 11; this.year--; }
    this.render();
  }

  select(dateStr) {
    this.selected = dateStr;
    this.input.value = dateStr;
    if (this.displayInput) this.displayInput.value = dateStr;
    this.render();
  }
}

const calendarInstances = {};

function initCalendar(containerId, inputId, displayInputId, options) {
  calendarInstances[containerId] = new CalendarPicker(containerId, inputId, displayInputId, options);
}

function calNav(containerId, offset) { calendarInstances[containerId]?.navigate(offset); }
function calSelect(containerId, dateStr) { calendarInstances[containerId]?.select(dateStr); }

function togglePicker(bodyId) {
  const body = document.getElementById(bodyId);
  const isOpen = body.classList.contains('open');
  document.querySelectorAll('.cal-picker-body.open, .time-picker-body.open').forEach(el => {
    if (el.id !== bodyId) el.classList.remove('open');
  });
  body.classList.toggle('open', !isOpen);

  // ── FIX: scrollTop on a hidden wheel doesn't take effect, so re-sync now
  // that the popover is visible. Map body id → prefix.
  if (!isOpen) {
    let prefix = null;
    if (bodyId === 'timePickerBody') prefix = 'sched';
    else if (bodyId === 'editTimePickerBody') prefix = 'editSched';
    if (prefix) {
      // Defer one frame so layout/visibility flush before scroll positioning.
      requestAnimationFrame(() => syncWheelScroll(prefix));
    }
  }
}

function syncWheelScroll(prefix) {
  const ids = _timeIds(prefix);
  const st = TIME_STATE[prefix];
  const itemHeight = 44;
  const hCol = document.getElementById(ids.wheelH);
  const mCol = document.getElementById(ids.wheelM);
  if (hCol) {
    hCol.scrollTop = st.h * itemHeight;
    hCol.querySelectorAll('.wheel-item').forEach((el, i) => el.classList.toggle('active', i === st.h));
  }
  if (mCol) {
    mCol.scrollTop = st.m * itemHeight;
    mCol.querySelectorAll('.wheel-item').forEach((el, i) => el.classList.toggle('active', i === st.m));
  }
}

document.addEventListener('click', function(e) {
  if (!e.target.closest('.cal-picker') && !e.target.closest('.time-picker')) {
    document.querySelectorAll('.cal-picker-body.open, .time-picker-body.open').forEach(el => el.classList.remove('open'));
  }
});

// ═══════════════════════════════════════════════════
//  iOS-STYLE WHEEL TIME PICKER
// ═══════════════════════════════════════════════════
// Per-prefix state ('sched' = create form, 'editSched' = edit modal)
const TIME_STATE = {
  sched: { h: 9, m: 0 },
  editSched: { h: 9, m: 0 },
};

// Backward-compat globals (read-only mirrors of sched state)
let selectedHour = 9;
let selectedMinute = 0;

const TIME_PRESETS = [
  { label: '7:30', h: 7, m: 30, desc: 'JPY Report' },
  { label: '9:00', h: 9, m: 0, desc: 'Checkin' },
  { label: '14:30', h: 14, m: 30, desc: 'Sun OT CI' },
  { label: '18:00', h: 18, m: 0, desc: 'Checkout' },
  { label: '22:00', h: 22, m: 0, desc: 'Night OT CI' },
  { label: '3:30', h: 3, m: 30, desc: 'Night OT CO' },
];

function _timeIds(prefix) {
  if (prefix === 'editSched') {
    return {
      container: 'editTimePicker',
      wheelH: 'editWheelHour',
      wheelM: 'editWheelMinute',
      hidden: 'editSchedTime',
      input: 'editSchedTimeInput',
      native: 'editSchedTimeNative',
    };
  }
  return {
    container: 'timePicker',
    wheelH: 'wheelHour',
    wheelM: 'wheelMinute',
    hidden: 'schedTime',
    input: 'schedTimeInput',
    native: 'schedTimeNative',
  };
}

function renderTimePicker(prefix = 'sched') {
  const ids = _timeIds(prefix);
  const container = document.getElementById(ids.container);
  if (!container) return;
  const st = TIME_STATE[prefix];
  updateTimeDisplay(prefix);

  let html = `<div class="wheel-picker-container">
    <div class="wheel-picker-highlight"></div>
    <div class="wheel-column" id="${ids.wheelH}"></div>
    <div class="wheel-separator">:</div>
    <div class="wheel-column" id="${ids.wheelM}"></div>
  </div>`;

  html += '<div class="time-presets"><div class="time-presets-label">Quick presets</div><div class="time-presets-grid">';
  for (const p of TIME_PRESETS) {
    const sel = (st.h === p.h && st.m === p.m) ? ' selected' : '';
    html += `<div class="time-preset${sel}" onclick="pickPreset(${p.h},${p.m},'${prefix}')">${p.label} <span class="text-muted">${p.desc}</span></div>`;
  }
  html += '</div></div>';
  container.innerHTML = html;

  initWheel(ids.wheelH, 24, st.h, (val) => { TIME_STATE[prefix].h = val; if (prefix === 'sched') selectedHour = val; updateTimeDisplay(prefix); });
  initWheel(ids.wheelM, 60, st.m, (val) => { TIME_STATE[prefix].m = val; if (prefix === 'sched') selectedMinute = val; updateTimeDisplay(prefix); });
}

function updateTimeDisplay(prefix = 'sched') {
  const ids = _timeIds(prefix);
  const st = TIME_STATE[prefix];
  const timeStr = `${String(st.h).padStart(2,'0')}:${String(st.m).padStart(2,'0')}`;
  const hidden = document.getElementById(ids.hidden);
  if (hidden) hidden.value = timeStr;
  const dispInput = document.getElementById(ids.input);
  if (dispInput) dispInput.value = timeStr;
  const nativeInput = document.getElementById(ids.native);
  if (nativeInput && nativeInput.value !== timeStr) nativeInput.value = timeStr;
}

function initNativeTimeInput(prefix = 'sched') {
  const ids = _timeIds(prefix);
  const nativeInput = document.getElementById(ids.native);
  if (!nativeInput || nativeInput.dataset.boundNative === '1') return;
  nativeInput.dataset.boundNative = '1';
  const st = TIME_STATE[prefix];
  const timeStr = `${String(st.h).padStart(2,'0')}:${String(st.m).padStart(2,'0')}`;
  nativeInput.value = timeStr;
  nativeInput.addEventListener('change', () => {
    const v = nativeInput.value;
    if (!v) return;
    const [h, m] = v.split(':').map(Number);
    TIME_STATE[prefix].h = h;
    TIME_STATE[prefix].m = m;
    if (prefix === 'sched') { selectedHour = h; selectedMinute = m; }
    updateTimeDisplay(prefix);
  });
}

function setTimeState(prefix, h, m) {
  TIME_STATE[prefix].h = h;
  TIME_STATE[prefix].m = m;
  if (prefix === 'sched') { selectedHour = h; selectedMinute = m; }
}

function initWheel(id, count, initialIndex, onChange) {
  const col = document.getElementById(id);
  if (!col) return;

  // Generate items
  let html = '';
  for (let i = 0; i < count; i++) {
    const label = String(i).padStart(2, '0');
    html += `<div class="wheel-item" data-index="${i}">${label}</div>`;
  }
  col.innerHTML = html;

  const itemHeight = 44;
  const visibleItems = 5;
  const padding = itemHeight * Math.floor(visibleItems / 2);

  col.style.paddingTop = padding + 'px';
  col.style.paddingBottom = padding + 'px';
  col.scrollTop = initialIndex * itemHeight;

  let scrollTimeout;
  col.addEventListener('scroll', () => {
    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(() => {
      const index = Math.round(col.scrollTop / itemHeight);
      const clamped = Math.max(0, Math.min(count - 1, index));
      col.scrollTo({ top: clamped * itemHeight, behavior: 'smooth' });
      col.querySelectorAll('.wheel-item').forEach((el, i) => {
        el.classList.toggle('active', i === clamped);
      });
      onChange(clamped);
    }, 80);
  }, { passive: true });

  col.querySelectorAll('.wheel-item')[initialIndex]?.classList.add('active');

  col.querySelectorAll('.wheel-item').forEach((item) => {
    item.addEventListener('click', () => {
      const idx = parseInt(item.dataset.index);
      col.scrollTo({ top: idx * itemHeight, behavior: 'smooth' });
    });
  });
}

function pickPreset(h, m, prefix = 'sched') {
  setTimeState(prefix, h, m);
  updateTimeDisplay(prefix);
  const ids = _timeIds(prefix);
  const hCol = document.getElementById(ids.wheelH);
  const mCol = document.getElementById(ids.wheelM);
  if (hCol) hCol.scrollTo({ top: h * 44, behavior: 'smooth' });
  if (mCol) mCol.scrollTo({ top: m * 44, behavior: 'smooth' });
  hCol?.querySelectorAll('.wheel-item').forEach((el, i) => el.classList.toggle('active', i === h));
  mCol?.querySelectorAll('.wheel-item').forEach((el, i) => el.classList.toggle('active', i === m));
}

// Keep old functions for backward compat
function pickHour(h) { setTimeState('sched', h, TIME_STATE.sched.m); renderTimePicker('sched'); }
function pickMinute(m) { setTimeState('sched', TIME_STATE.sched.h, m); renderTimePicker('sched'); }

// ═══════════════════════════════════════════════════
//  MONTHLY DATE GRID PICKER
// ═══════════════════════════════════════════════════
const MONTH_DATES_STATE = {
  sched: new Set(),
  editSched: new Set(),
};
// Backward-compat
let selectedMonthDates = MONTH_DATES_STATE.sched;

function _monthGridId(prefix) {
  return prefix === 'editSched' ? 'editMonthDateGrid' : 'monthDateGrid';
}

function renderMonthDateGrid(prefix = 'sched') {
  const container = document.getElementById(_monthGridId(prefix));
  if (!container) return;
  const set = MONTH_DATES_STATE[prefix];
  let html = '';
  for (let d = 1; d <= 31; d++) {
    const sel = set.has(d) ? ' selected' : '';
    html += `<div class="md-btn${sel}" onclick="toggleMonthDate(${d},'${prefix}')">${d}</div>`;
  }
  container.innerHTML = html;
}

function toggleMonthDate(d, prefix = 'sched') {
  const set = MONTH_DATES_STATE[prefix];
  if (set.has(d)) set.delete(d);
  else set.add(d);
  renderMonthDateGrid(prefix);
}

function getSelectedMonthDates(prefix = 'sched') {
  return [...MONTH_DATES_STATE[prefix]].sort((a, b) => a - b);
}

// ═══════════════════════════════════════════════════
//  SCHEDULE TYPE TOGGLE
// ═══════════════════════════════════════════════════
function toggleScheduleType(type) {
  document.getElementById('onceFields').style.display = type === 'once' ? 'block' : 'none';
  document.getElementById('recurFields').style.display = type === 'recurring' ? 'block' : 'none';
}

function toggleLocationField() {
  const wf = document.getElementById('schedWorkflow').value;
  const show = ['auto-checkin.yml', 'auto-checkout.yml'].includes(wf);
  document.getElementById('schedLocationField').style.display = show ? '' : 'none';
}

function toggleEditLocationField() {
  const wf = document.getElementById('editSchedWorkflow').value;
  const show = ['auto-checkin.yml', 'auto-checkout.yml'].includes(wf);
  document.getElementById('editLocationField').style.display = show ? '' : 'none';
}

function togglePatternUI(prefix = 'sched') {
  const prefixCap = prefix === 'editSched' ? 'editSched' : 'sched';
  const pattern = document.getElementById(prefixCap + 'Pattern').value;
  const weeklyId = prefix === 'editSched' ? 'editWeeklyDaysField' : 'weeklyDaysField';
  const monthlyId = prefix === 'editSched' ? 'editMonthlyDatesField' : 'monthlyDatesField';
  const weeklyEl = document.getElementById(weeklyId);
  const monthlyEl = document.getElementById(monthlyId);
  if (weeklyEl) weeklyEl.style.display = pattern === 'weekly' ? 'block' : 'none';
  if (monthlyEl) monthlyEl.style.display = pattern === 'monthly' ? 'block' : 'none';
}

// ═══════════════════════════════════════════════════
//  SCHEDULED RUNS CRUD (Gist-based storage)
// ═══════════════════════════════════════════════════
async function loadScheduledRuns() {
  const queue = document.getElementById('schedulerQueue');
  if (!queue) return;
  try {
    const gist = await apiFetch(`/gists/${GIST_ID}`);
    const file = gist.files['scheduled-runs.json'];
    const entries = file ? JSON.parse(file.content) : [];
    // Client-side fallback: dispatch overdue runs directly
    await clientSideDispatchOverdue(entries);
    // Update calendar visualization with live data
    renderScheduleCalendar(entries);
    renderScheduledQueue(entries);
    // Smart wake-up: schedule a precise timer for the next upcoming entry
    scheduleNextDispatch(entries);
  } catch (e) {
    if (e.message.includes('404')) {
      queue.innerHTML = '<div class="empty">No scheduled runs yet</div>';
    } else {
      queue.innerHTML = `<div class="empty">⚠️ ${e.message}</div>`;
    }
    // Clear table on error/empty
    scheduleTableData = [];
    renderScheduleTable();
  }
}

// Fallback: if GitHub cron hasn't fired, dispatch overdue runs from the browser
async function clientSideDispatchOverdue(entries) {
  if (!sessionToken || !entries.length) return false;
  const now = new Date();
  const nowJST = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  const todayStr = formatDate(nowJST.getFullYear(), nowJST.getMonth(), nowJST.getDate());
  let dispatched = 0;

  for (const entry of entries) {
    if (entry.type === 'once' && entry.run_at && !entry.dispatched) {
      const runAt = new Date(entry.run_at);
      // If run_at has passed (with 30s tolerance — quick enough for user-created entries)
      if (now - runAt > 30000) {
        try {
          const inputs = entry.location ? { location: entry.location } : {};
          const res = await fetch(`${API}/repos/${OWNER}/${REPO}/actions/workflows/${entry.workflow}/dispatches`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${sessionToken}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
            body: JSON.stringify({ ref: 'main', inputs }),
          });
          if (res.status === 204) {
            toast(`✅ Dispatched: ${(WORKFLOWS.find(w=>w.file===entry.workflow)||{}).name || entry.workflow.replace('.yml','')}`);
            entry.dispatched = true;
            entry.last_run = now.toISOString();
            dispatched++;
          }
        } catch {}
      }
    } else if (entry.type === 'recurring' && entry.enabled !== false) {
      const r = entry.recurrence || {};
      const schedTime = r.time || '00:00';
      const [h, m] = schedTime.split(':').map(Number);
      const schedDt = new Date(nowJST);
      schedDt.setHours(h, m, 0, 0);

      const diffMin = (nowJST - schedDt) / 60000;
      if (diffMin < 2) continue;

      // Already ran today?
      if (entry.last_run) {
        const lastRunJST = new Date(new Date(entry.last_run).toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
        const lastRunDate = formatDate(lastRunJST.getFullYear(), lastRunJST.getMonth(), lastRunJST.getDate());
        if (lastRunDate === todayStr) continue;
      }

      // Check day-of-week pattern
      const dow = nowJST.getDay();
      let shouldRun = false;
      if (r.pattern === 'daily') shouldRun = true;
      else if (r.pattern === 'weekdays') shouldRun = [1,2,3,4,5].includes(dow);
      else if (r.pattern === 'weekly') shouldRun = (r.days || []).includes(dow);
      else if (r.pattern === 'monthly') shouldRun = (r.dates || []).includes(nowJST.getDate());

      if (shouldRun) {
        try {
          const inputs = entry.location ? { location: entry.location } : {};
          const res = await fetch(`${API}/repos/${OWNER}/${REPO}/actions/workflows/${entry.workflow}/dispatches`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${sessionToken}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
            body: JSON.stringify({ ref: 'main', inputs }),
          });
          if (res.status === 204) {
            toast(`✅ Dispatched: ${(WORKFLOWS.find(w=>w.file===entry.workflow)||{}).name || entry.workflow.replace('.yml','')}`);
            entry.last_run = now.toISOString();
            dispatched++;
          }
        } catch {}
      }
    }
  }

  // Only save if we actually dispatched something (in-place update, no entry removal)
  if (dispatched > 0) {
    try { await saveToGist(entries); } catch {}
  }
  return dispatched > 0;
}

function renderScheduledQueue(entries) {
  // Store data for table (full history)
  scheduleTableData = entries;

  // Queue shows only ACTIVE entries (not dispatched once entries)
  const activeEntries = entries
    .map((e, origIdx) => ({ e, origIdx }))
    .filter(({ e }) => !(e.type === 'once' && e.dispatched));

  // Render queue cards
  const queue = document.getElementById('schedulerQueue');
  if (!activeEntries.length) {
    queue.innerHTML = '<div class="empty">No active scheduled runs</div>';
    renderScheduleTable();
    return;
  }

  // Compute next fire time for each entry
  const nowJST = jstNow();
  const todayDow = nowJST.getDay(); // 0=Sun

  queue.innerHTML = activeEntries.map(({ e: entry, origIdx: i }) => {
    const wf = WORKFLOWS.find(w => w.file === entry.workflow);
    const wfName = wf?.name || entry.workflow.replace('.yml', '');
    const iconName = wf?.iconName || 'settings';
    const isOnce = entry.type === 'once';
    const enabled = entry.enabled !== false;
    const toggleCls = enabled ? 'sched-toggle active' : 'sched-toggle';

    // Build display label: use note as primary label if available
    const label = entry.note || wfName;
    const sublabel = isOnce
      ? `${entry.run_at?.slice(0,16).replace('T',' ')} JST`
      : describeRecurrence(entry.recurrence);

    // Compute next fire info
    let nextInfo = '';
    if (!isOnce && enabled) {
      const r = entry.recurrence || {};
      const [h, m] = (r.time || '00:00').split(':').map(Number);
      const schedToday = new Date(nowJST);
      schedToday.setHours(h, m, 0, 0);
      const alreadyPassed = nowJST > schedToday;

      // Check if already ran today
      const lastRun = entry.last_run;
      let ranToday = false;
      if (lastRun) {
        const lrJST = new Date(new Date(lastRun).toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
        ranToday = lrJST.toDateString() === nowJST.toDateString();
      }

      if (ranToday) {
        nextInfo = `<span class="sched-status done">${ICON('check', 11)} Done today</span>`;
      } else if (alreadyPassed) {
        nextInfo = `<span class="sched-status overdue">${ICON('hourglass', 11)} Pending</span>`;
      } else {
        const diff = Math.round((schedToday - nowJST) / 60000);
        nextInfo = `<span class="sched-status upcoming">In ${diff}m</span>`;
      }
    } else if (isOnce) {
      const runAt = new Date(entry.run_at);
      if (runAt < nowJST) nextInfo = `<span class="sched-status overdue">${ICON('hourglass', 11)} Pending dispatch</span>`;
      else {
        const diff = Math.round((runAt - nowJST) / 60000);
        const label2 = diff < 60 ? `In ${diff}m` : diff < 1440 ? `In ${Math.round(diff/60)}h` : `In ${Math.round(diff/1440)}d`;
        nextInfo = `<span class="sched-status upcoming">${label2}</span>`;
      }
    }

    return `<div class="sched-item${!enabled ? ' disabled' : ''}">
      <div class="sched-item-main">
        <span class="sched-icon">${ICON(iconName, 18)}</span>
        <div class="sched-item-info">
          <span class="sched-label">${label}</span>
          <span class="sched-sublabel">${sublabel}</span>
        </div>
        ${nextInfo}
      </div>
      <div class="sched-item-actions">
        ${!isOnce ? `<div class="${toggleCls}" role="switch" aria-checked="${enabled}" tabindex="0" onclick="toggleScheduleEntry(${i})" title="${enabled ? 'Disable' : 'Enable'}"></div>` : ''}
        <button class="btn danger sm" onclick="deleteScheduledRun(${i})" title="Delete">${ICON('trash', 14)}</button>
      </div>
    </div>`;
  }).join('');

  // Also render the data table (shows all entries, including history)
  renderScheduleTable();
}

function describeRecurrence(r) {
  if (!r) return '';
  const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  let desc = `${r.time} `;
  if (r.pattern === 'daily') desc += 'Every day';
  else if (r.pattern === 'weekdays') desc += 'Mon–Fri';
  else if (r.pattern === 'weekly') desc += (r.days || []).map(d => dayNames[d]).join(', ');
  else if (r.pattern === 'monthly') desc += `Day ${(r.dates || []).join(', ')}`;
  return desc;
}

// ─── Gist Helper ───
async function saveToGist(entries) {
  const res = await fetch(`${API}/gists/${GIST_ID}`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${sessionToken}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: { 'scheduled-runs.json': { content: JSON.stringify(entries, null, 2) } } }),
  });
  if (!res.ok) {
    if (res.status === 403) {
      const scopes = res.headers.get('X-OAuth-Scopes') || '';
      if (!scopes.includes('gist')) {
        throw new Error('PAT thiếu scope "gist". Vào Settings → tokens → thêm scope gist');
      }
      const remaining = res.headers.get('X-RateLimit-Remaining');
      if (remaining === '0') {
        throw new Error('Rate limit exceeded. Thử lại sau vài phút.');
      }
      throw new Error('403 Forbidden — kiểm tra PAT có scope: gist');
    }
    throw new Error(`Gist update failed (${res.status})`);
  }
  return res.json();
}

async function loadEntriesFromGist() {
  const gist = await apiFetch(`/gists/${GIST_ID}`);
  const file = gist.files['scheduled-runs.json'];
  return file ? JSON.parse(file.content) : [];
}

async function addScheduledRun() {
  if (!sessionToken) { toast('⚠️ Not authenticated'); return; }
  const workflow = document.getElementById('schedWorkflow').value;
  const type = document.getElementById('schedType').value;
  const time = document.getElementById('schedTime').value;
  const note = document.getElementById('schedNote').value.trim();
  const location = document.getElementById('schedLocation').value;
  const needsLocation = ['auto-checkin.yml', 'auto-checkout.yml'].includes(workflow);

  let entry;

  if (type === 'once') {
    const date = document.getElementById('schedDate').value;
    if (!date) { toast('⚠️ Pick a date'); return; }
    if (!time) { toast('⚠️ Pick a time'); return; }
    const runAt = `${date}T${time}:00+09:00`;
    entry = { type: 'once', workflow, run_at: runAt, note: note || undefined, created: new Date().toISOString() };
  } else {
    const pattern = document.getElementById('schedPattern').value;
    const startDate = document.getElementById('schedStartDate').value;
    const endDate = document.getElementById('schedEndDate').value;

    const recurrence = { pattern, time };

    if (pattern === 'weekly') {
      const days = [...document.querySelectorAll('#weeklyDaysField input:checked')].map(el => parseInt(el.value));
      if (!days.length) { toast('⚠️ Select at least one day'); return; }
      recurrence.days = days;
    } else if (pattern === 'weekdays') {
      recurrence.days = [1, 2, 3, 4, 5];
    } else if (pattern === 'monthly') {
      const dates = getSelectedMonthDates();
      if (!dates.length) { toast('⚠️ Select at least one day of month'); return; }
      recurrence.dates = dates;
    }

    if (startDate) recurrence.start_date = startDate;
    if (endDate) recurrence.end_date = endDate;

    entry = { type: 'recurring', workflow, recurrence, enabled: true, note: note || undefined, created: new Date().toISOString() };
  }

  // Add location (key + lat/lon snapshot) for checkin/checkout workflows
  if (needsLocation) {
    entry.location = location;
    const loc = (typeof getLocation === 'function') ? getLocation(location) : null;
    if (loc) {
      entry.location_lat = loc.lat;
      entry.location_lon = loc.lon;
    }
  }

  await saveScheduledEntry(entry);
}

async function saveScheduledEntry(newEntry) {
  try {
    const entries = await loadEntriesFromGist();
    entries.push(newEntry);
    await saveToGist(entries);
    toast('✅ Schedule added');
    loadScheduledRuns();
  } catch (e) { toast(`❌ ${e.message}`); }
}

async function deleteScheduledRun(index) {
  if (!confirm('Delete this scheduled run?')) return;
  try {
    const entries = await loadEntriesFromGist();
    entries.splice(index, 1);
    await saveToGist(entries);
    toast('🗑 Removed');
    loadScheduledRuns();
  } catch (e) { toast(`❌ ${e.message}`); }
}

async function toggleScheduleEntry(index) {
  try {
    const entries = await loadEntriesFromGist();
    entries[index].enabled = !entries[index].enabled;
    await saveToGist(entries);
    loadScheduledRuns();
  } catch (e) { toast(`❌ ${e.message}`); }
}

// ═══════════════════════════════════════════════════
//  SCHEDULE DATA TABLE (paginated, 10/page, shadcn pagination)
// ═══════════════════════════════════════════════════
let scheduleTableData = [];
let tablePage = 1;
const TABLE_PAGE_SIZE = 10;

function resetTablePage() { tablePage = 1; renderScheduleTable(); }
function goToTablePage(p) {
  const total = getFilteredEntries().length;
  const pages = Math.max(1, Math.ceil(total / TABLE_PAGE_SIZE));
  tablePage = Math.max(1, Math.min(pages, p));
  renderScheduleTable();
  // Scroll table into view so the user sees the new page
  document.getElementById('scheduleTable')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function getFilteredEntries() {
  const filterType = document.getElementById('tableFilterType')?.value || 'all';
  const filterWf = document.getElementById('tableFilterWf')?.value || 'all';
  let filtered = scheduleTableData;
  if (filterType !== 'all') filtered = filtered.filter(e => e.type === filterType);
  if (filterWf !== 'all') filtered = filtered.filter(e => e.workflow === filterWf);
  return filtered;
}

function renderPagination(totalItems, currentPage, pageSize) {
  const nav = document.getElementById('schedulePagination');
  if (!nav) return;
  const totalPages = Math.ceil(totalItems / pageSize);
  if (totalPages <= 1) { nav.innerHTML = ''; return; }

  // Build set of page numbers to show: 1, current-1, current, current+1, last + ellipsis
  const pages = new Set([1, totalPages, currentPage - 1, currentPage, currentPage + 1]);
  const visible = [...pages].filter(p => p >= 1 && p <= totalPages).sort((a, b) => a - b);

  const items = [];
  // Previous
  items.push(currentPage > 1
    ? `<li><a class="pagination-link pagination-prev" href="#" onclick="event.preventDefault();goToTablePage(${currentPage - 1})" aria-label="Go to previous page">${ICON('chevronLeft', 14)}<span>Previous</span></a></li>`
    : `<li><span class="pagination-link pagination-prev disabled" aria-disabled="true">${ICON('chevronLeft', 14)}<span>Previous</span></span></li>`);

  // Page numbers with ellipsis
  let prev = 0;
  for (const p of visible) {
    if (p - prev > 1) {
      items.push(`<li><span class="pagination-ellipsis" aria-hidden="true">&hellip;</span></li>`);
    }
    const active = p === currentPage;
    items.push(active
      ? `<li><span class="pagination-link active" aria-current="page">${p}</span></li>`
      : `<li><a class="pagination-link" href="#" onclick="event.preventDefault();goToTablePage(${p})" aria-label="Go to page ${p}">${p}</a></li>`);
    prev = p;
  }

  // Next
  items.push(currentPage < totalPages
    ? `<li><a class="pagination-link pagination-next" href="#" onclick="event.preventDefault();goToTablePage(${currentPage + 1})" aria-label="Go to next page"><span>Next</span>${ICON('chevronRight', 14)}</a></li>`
    : `<li><span class="pagination-link pagination-next disabled" aria-disabled="true"><span>Next</span>${ICON('chevronRight', 14)}</span></li>`);

  nav.innerHTML = `<ul class="pagination-list">${items.join('')}</ul>`;
}

function renderScheduleTable() {
  const tbody = document.getElementById('scheduleTableBody');
  const countEl = document.getElementById('tableCount');
  if (!tbody) return;

  const filtered = getFilteredEntries();
  const totalPages = Math.max(1, Math.ceil(filtered.length / TABLE_PAGE_SIZE));
  if (tablePage > totalPages) tablePage = totalPages;
  if (tablePage < 1) tablePage = 1;
  const start = (tablePage - 1) * TABLE_PAGE_SIZE;
  const pageItems = filtered.slice(start, start + TABLE_PAGE_SIZE);

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="text-center py-8"><div class="text-muted-foreground text-sm flex items-center justify-center gap-2">${ICON('clipboard', 16)} No schedules found</div><div class="text-xs text-muted-foreground mt-1 opacity-60">Create your first automated workflow run above</div></td></tr>`;
    if (countEl) countEl.textContent = '0 entries';
    renderPagination(0, 1, TABLE_PAGE_SIZE);
    return;
  }

  const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  tbody.innerHTML = pageItems.map((entry) => {
    const realIdx = scheduleTableData.indexOf(entry);
    const wf = WORKFLOWS.find(w => w.file === entry.workflow);
    const wfName = wf ? `<span class="inline-flex items-center gap-1.5">${ICON(wf.iconName || 'play', 14)} ${wf.name}</span>` : entry.workflow;
    const isOnce = entry.type === 'once';

    // Schedule description
    let schedDesc = '';
    if (isOnce) {
      schedDesc = entry.run_at ? entry.run_at.slice(0, 16).replace('T', ' ') + ' JST' : '—';
    } else if (entry.recurrence) {
      const r = entry.recurrence;
      schedDesc = r.time + ' ';
      if (r.pattern === 'daily') schedDesc += 'Every day';
      else if (r.pattern === 'weekdays') schedDesc += 'Mon–Fri';
      else if (r.pattern === 'weekly') schedDesc += (r.days || []).map(d => dayNames[d]).join(', ');
      else if (r.pattern === 'monthly') schedDesc += 'Day ' + (r.dates || []).join(', ');
    }

    // Status
    const enabled = entry.enabled !== false;
    let statusBadge = '';
    if (isOnce) {
      if (entry.dispatched) {
        statusBadge = `<span class="badge-enabled">${ICON('check', 11)} Dispatched</span>`;
      } else {
        const isPast = entry.run_at && new Date(entry.run_at) < new Date();
        statusBadge = isPast
          ? `<span class="badge-warning">${ICON('hourglass', 11)} Pending dispatch</span>`
          : '<span class="badge-enabled">Pending</span>';
      }
    } else {
      statusBadge = enabled
        ? '<span class="badge-enabled">Active</span>'
        : '<span class="badge-disabled">Disabled</span>';
    }

    // Created date
    const created = entry.created ? new Date(entry.created).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';

    return `<tr>
      <td data-label="#" class="text-muted-foreground font-mono">${realIdx + 1}</td>
      <td data-label="Type"><span class="badge-${entry.type}">${isOnce ? 'Once' : 'Recurring'}</span></td>
      <td data-label="Workflow" class="font-medium">${wfName}</td>
      <td data-label="Schedule" class="font-mono text-xs">${schedDesc}</td>
      <td data-label="Note" class="text-muted-foreground">${entry.note || '—'}</td>
      <td data-label="Status">${statusBadge}</td>
      <td data-label="Created" class="text-muted-foreground text-xs">${created}</td>
      <td class="actions-cell"><div class="actions-cell">
        <button class="btn sm" onclick="openEditSchedModal(${realIdx})" title="Edit">${ICON('edit', 14)}</button>
        <button class="btn danger sm" onclick="deleteScheduledRun(${realIdx})" title="Delete">${ICON('trash', 14)}</button>
      </div></td>
    </tr>`;
  }).join('');

  if (countEl) {
    const showingFrom = start + 1;
    const showingTo = Math.min(start + TABLE_PAGE_SIZE, filtered.length);
    countEl.textContent = filtered.length > TABLE_PAGE_SIZE
      ? `Showing ${showingFrom}–${showingTo} of ${filtered.length}${filtered.length !== scheduleTableData.length ? ` (filtered from ${scheduleTableData.length})` : ''}`
      : `${filtered.length} of ${scheduleTableData.length} entries`;
  }

  renderPagination(filtered.length, tablePage, TABLE_PAGE_SIZE);
}

// ═══════════════════════════════════════════════════
//  EDIT SCHEDULE MODAL
// ═══════════════════════════════════════════════════
function openEditSchedModal(index) {
  const entry = scheduleTableData[index];
  if (!entry) return;

  document.getElementById('editSchedIndex').value = index;
  document.getElementById('editSchedWorkflow').value = entry.workflow;
  document.getElementById('editSchedType').value = entry.type;
  document.getElementById('editSchedNote').value = entry.note || '';
  document.getElementById('editSchedLocation').value = entry.location || 'office';
  toggleEditLocationField();
  toggleEditType(entry.type);

  // Enabled toggle (only meaningful for recurring; harmless for once)
  const enabledToggle = document.getElementById('editSchedEnabled');
  const enabled = entry.enabled !== false;
  enabledToggle.classList.toggle('active', enabled);
  enabledToggle.setAttribute('aria-checked', enabled);

  // Reset edit state
  MONTH_DATES_STATE.editSched = new Set();
  document.querySelectorAll('.editWeeklyDay').forEach(cb => cb.checked = false);

  let timeStr = '09:00';
  let dateStr = '';

  if (entry.type === 'once') {
    if (entry.run_at) {
      // run_at format: YYYY-MM-DDTHH:MM:SS+09:00
      dateStr = entry.run_at.slice(0, 10);
      timeStr = entry.run_at.slice(11, 16);
      calSelect('editCalPicker', dateStr);
    }
    document.getElementById('editSchedPattern').value = 'daily';
  } else if (entry.recurrence) {
    const r = entry.recurrence;
    document.getElementById('editSchedPattern').value = r.pattern || 'daily';
    timeStr = r.time || '09:00';

    if (r.days && Array.isArray(r.days)) {
      document.querySelectorAll('.editWeeklyDay').forEach(cb => {
        cb.checked = r.days.includes(parseInt(cb.value));
      });
    }
    if (r.dates && Array.isArray(r.dates)) {
      MONTH_DATES_STATE.editSched = new Set(r.dates);
    }
    if (r.start_date) calSelect('editCalPickerStart', r.start_date);
    if (r.end_date) calSelect('editCalPickerEnd', r.end_date);
  }

  // Set time state and render time picker / native input
  const [h, m] = timeStr.split(':').map(Number);
  TIME_STATE.editSched.h = h;
  TIME_STATE.editSched.m = m;
  renderTimePicker('editSched');
  initNativeTimeInput('editSched');
  renderMonthDateGrid('editSched');
  togglePatternUI('editSched');

  document.getElementById('editSchedModal').classList.add('open');
}

function closeEditSchedModal() {
  document.getElementById('editSchedModal').classList.remove('open');
}

function toggleEditType(type) {
  document.getElementById('editOnceFields').style.display = type === 'once' ? 'contents' : 'none';
  document.getElementById('editRecurFields').style.display = type === 'recurring' ? 'contents' : 'none';
}

async function saveEditSchedule() {
  const index = parseInt(document.getElementById('editSchedIndex').value);
  if (isNaN(index) || !scheduleTableData[index]) { toast('❌ Invalid entry'); return; }

  const workflow = document.getElementById('editSchedWorkflow').value;
  const type = document.getElementById('editSchedType').value;
  const note = document.getElementById('editSchedNote').value.trim() || undefined;
  const location = document.getElementById('editSchedLocation').value;
  const time = document.getElementById('editSchedTime').value;
  const needsLocation = ['auto-checkin.yml', 'auto-checkout.yml'].includes(workflow);
  const enabled = document.getElementById('editSchedEnabled').classList.contains('active');

  let updatedEntry;

  if (type === 'once') {
    const date = document.getElementById('editSchedDate').value;
    if (!date) { toast('⚠️ Pick a date'); return; }
    if (!time) { toast('⚠️ Pick a time'); return; }
    const runAt = `${date}T${time}:00+09:00`;
    updatedEntry = { type: 'once', workflow, run_at: runAt, note, created: scheduleTableData[index].created || new Date().toISOString() };
  } else {
    if (!time) { toast('⚠️ Set a time'); return; }
    const pattern = document.getElementById('editSchedPattern').value;
    const startDate = document.getElementById('editSchedStartDate').value;
    const endDate = document.getElementById('editSchedEndDate').value;
    const recurrence = { pattern, time };

    if (pattern === 'weekly') {
      const days = [...document.querySelectorAll('.editWeeklyDay:checked')].map(el => parseInt(el.value));
      if (!days.length) { toast('⚠️ Select at least one day'); return; }
      recurrence.days = days;
    } else if (pattern === 'weekdays') {
      recurrence.days = [1, 2, 3, 4, 5];
    } else if (pattern === 'monthly') {
      const dates = getSelectedMonthDates('editSched');
      if (!dates.length) { toast('⚠️ Select at least one day of month'); return; }
      recurrence.dates = dates;
    }

    if (startDate) recurrence.start_date = startDate;
    if (endDate) recurrence.end_date = endDate;

    updatedEntry = { type: 'recurring', workflow, recurrence, enabled, note, created: scheduleTableData[index].created || new Date().toISOString() };
  }

  if (needsLocation) {
    updatedEntry.location = location;
    const loc = (typeof getLocation === 'function') ? getLocation(location) : null;
    if (loc) {
      updatedEntry.location_lat = loc.lat;
      updatedEntry.location_lon = loc.lon;
    }
  }

  try {
    const entries = await loadEntriesFromGist();
    entries[index] = updatedEntry;
    await saveToGist(entries);
    toast('✅ Schedule updated');
    closeEditSchedModal();
    loadScheduledRuns();
  } catch (e) { toast(`❌ ${e.message}`); }
}
