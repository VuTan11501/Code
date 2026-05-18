// ═══════════════════════════════════════════════════
//  SCHEDULE PAGE — Calendar, Scheduled Runs, Pickers
// ═══════════════════════════════════════════════════
let scheduleInitialized = false;

function initSchedulePage() {
  if (scheduleInitialized) return;
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
  // Default date = today, time = current JST time
  const now = jstNow();
  TIME_STATE.sched.h = now.getHours();
  TIME_STATE.sched.m = now.getMinutes();
  TIME_STATE.editSched.h = now.getHours();
  TIME_STATE.editSched.m = now.getMinutes();
  selectedHour = now.getHours();
  selectedMinute = now.getMinutes();
  renderTimePicker('sched');
  initNativeTimeInput('sched');
  renderMonthDateGrid('sched');
  const todayStr = formatDate(now.getFullYear(), now.getMonth(), now.getDate());
  calSelect('calPicker', todayStr);
  loadScheduledRuns();
}

// ═══════════════════════════════════════════════════
//  SCHEDULE CALENDAR (Weekly overview — dynamic from Gist)
// ═══════════════════════════════════════════════════
function renderScheduleCalendar(gistEntries) {
  const container = document.getElementById('scheduleCalendar');
  if (!container) return;

  // Build schedule map from Gist entries (dynamic) merged with hardcoded fallback
  const dynamicSchedule = {};
  const entries = gistEntries || [];

  for (const entry of entries) {
    if (entry.type !== 'recurring' || entry.enabled === false) continue;
    const r = entry.recurrence || {};
    const wf = WORKFLOWS.find(w => w.file === entry.workflow);
    const name = wf ? wf.name : entry.workflow;
    if (!dynamicSchedule[name]) dynamicSchedule[name] = [];

    let days = [];
    if (r.pattern === 'daily') days = [0,1,2,3,4,5,6];
    else if (r.pattern === 'weekdays') days = [1,2,3,4,5];
    else if (r.pattern === 'weekly') days = r.days || [];

    if (days.length > 0) {
      dynamicSchedule[name].push({ days, time: r.time || '00:00', label: entry.note || r.time || '' });
    }
  }

  // Use dynamic if available, fallback to hardcoded SCHEDULE
  const schedule = Object.keys(dynamicSchedule).length > 0 ? dynamicSchedule : SCHEDULE;

  const dayNames = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  const allTimes = new Set();
  for (const [, sched] of Object.entries(schedule)) {
    for (const e of sched) allTimes.add(e.time);
  }
  const times = [...allTimes].sort();

  let html = '<div class="schedule-grid-wrapper"><div class="schedule-grid">';
  html += '<div class="schedule-cell header"></div>';
  for (const d of dayNames) html += `<div class="schedule-cell header">${d}</div>`;

  for (const time of times) {
    html += `<div class="schedule-cell time-label">${time}</div>`;
    for (let day = 0; day < 7; day++) {
      html += '<div class="schedule-cell">';
      for (const [name, sched] of Object.entries(schedule)) {
        for (const e of sched) {
          if (e.time === time && e.days.includes(day)) {
            const cls = name.includes('Checkin') ? 'checkin' : 'forecast';
            html += `<span class="schedule-pip ${cls}" title="${name}">${e.label}</span>`;
          }
        }
      }
      html += '</div>';
    }
  }
  html += '</div></div>';
  container.innerHTML = html;
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
  if (!sessionToken || !entries.length) return;
  const now = new Date();
  const nowJST = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  const todayStr = formatDate(nowJST.getFullYear(), nowJST.getMonth(), nowJST.getDate());
  let dispatched = 0;

  for (const entry of entries) {
    if (entry.type === 'once' && entry.run_at && !entry.dispatched) {
      const runAt = new Date(entry.run_at);
      // If run_at has passed (with 1 min tolerance)
      if (now - runAt > 60000) {
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
}

function renderScheduledQueue(entries) {
  // Store data for table
  scheduleTableData = entries;

  // Render queue cards
  const queue = document.getElementById('schedulerQueue');
  if (!entries.length) { queue.innerHTML = '<div class="empty">No scheduled runs</div>'; renderScheduleTable(); return; }

  // Compute next fire time for each entry
  const nowJST = jstNow();
  const todayDow = nowJST.getDay(); // 0=Sun

  queue.innerHTML = entries.map((entry, i) => {
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
      if (entry.dispatched) {
        nextInfo = `<span class="sched-status done">${ICON('check', 11)} Dispatched</span>`;
      } else {
        const runAt = new Date(entry.run_at);
        if (runAt < nowJST) nextInfo = `<span class="sched-status overdue">${ICON('hourglass', 11)} Pending dispatch</span>`;
        else {
          const diff = Math.round((runAt - nowJST) / 60000);
          const label2 = diff < 60 ? `In ${diff}m` : diff < 1440 ? `In ${Math.round(diff/60)}h` : `In ${Math.round(diff/1440)}d`;
          nextInfo = `<span class="sched-status upcoming">${label2}</span>`;
        }
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

  // Also render the data table
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
//  SCHEDULE DATA TABLE
// ═══════════════════════════════════════════════════
let scheduleTableData = [];

function renderScheduleTable() {
  const tbody = document.getElementById('scheduleTableBody');
  const countEl = document.getElementById('tableCount');
  if (!tbody) return;

  const filterType = document.getElementById('tableFilterType')?.value || 'all';
  const filterWf = document.getElementById('tableFilterWf')?.value || 'all';

  let filtered = scheduleTableData;
  if (filterType !== 'all') filtered = filtered.filter(e => e.type === filterType);
  if (filterWf !== 'all') filtered = filtered.filter(e => e.workflow === filterWf);

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="text-center py-8"><div class="text-muted-foreground text-sm flex items-center justify-center gap-2">${ICON('clipboard', 16)} No schedules found</div><div class="text-xs text-muted-foreground mt-1 opacity-60">Create your first automated workflow run above</div></td></tr>`;
    if (countEl) countEl.textContent = '0 entries';
    return;
  }

  const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  tbody.innerHTML = filtered.map((entry, filteredIdx) => {
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

  if (countEl) countEl.textContent = `${filtered.length} of ${scheduleTableData.length} entries`;
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
