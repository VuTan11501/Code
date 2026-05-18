// ═══════════════════════════════════════════════════
//  SCHEDULE PAGE — Calendar, Scheduled Runs, Pickers
// ═══════════════════════════════════════════════════
let scheduleInitialized = false;

function initSchedulePage() {
  if (scheduleInitialized) return;
  scheduleInitialized = true;
  renderScheduleCalendar();
  initCalendar('calPicker', 'schedDate', 'schedDateInput', { allowPast: false });
  initCalendar('calPickerStart', 'schedStartDate', 'schedStartDateInput', { allowPast: true });
  initCalendar('calPickerEnd', 'schedEndDate', 'schedEndDateInput', { allowPast: true });
  renderTimePicker();
  renderMonthDateGrid();
  // Select tomorrow by default
  const now = jstNow();
  const tmr = new Date(now); tmr.setDate(tmr.getDate() + 1);
  const tmrStr = formatDate(tmr.getFullYear(), tmr.getMonth(), tmr.getDate());
  calSelect('calPicker', tmrStr);
  loadScheduledRuns();
}

// ═══════════════════════════════════════════════════
//  SCHEDULE CALENDAR (Weekly overview)
// ═══════════════════════════════════════════════════
function renderScheduleCalendar() {
  const container = document.getElementById('scheduleCalendar');
  if (!container) return;
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const allTimes = new Set();
  for (const [, entries] of Object.entries(SCHEDULE)) {
    for (const e of entries) allTimes.add(e.time);
  }
  const times = [...allTimes].sort();

  let html = '<div class="schedule-grid-wrapper"><div class="schedule-grid">';
  html += '<div class="schedule-cell header"></div>';
  for (const d of dayNames) html += `<div class="schedule-cell header">${d}</div>`;

  for (const time of times) {
    html += `<div class="schedule-cell time-label">${time}</div>`;
    for (let day = 0; day < 7; day++) {
      html += '<div class="schedule-cell">';
      for (const [name, entries] of Object.entries(SCHEDULE)) {
        for (const e of entries) {
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
//  CUSTOM TIME PICKER
// ═══════════════════════════════════════════════════
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

function renderTimePicker() {
  const container = document.getElementById('timePicker');
  if (!container) return;
  const timeStr = `${String(selectedHour).padStart(2,'0')}:${String(selectedMinute).padStart(2,'0')}`;
  document.getElementById('schedTime').value = timeStr;
  const dispInput = document.getElementById('schedTimeInput');
  if (dispInput) dispInput.value = timeStr;

  let html = `<div class="time-display">${timeStr}</div>`;
  html += '<div class="time-section"><div class="time-section-label">Hour</div><div class="time-grid">';
  for (let h = 0; h < 24; h++) {
    const sel = h === selectedHour ? ' selected' : '';
    html += `<div class="time-btn${sel}" onclick="pickHour(${h})">${String(h).padStart(2,'0')}</div>`;
  }
  html += '</div></div>';

  html += '<div class="time-section"><div class="time-section-label">Minute</div><div class="time-grid">';
  for (const m of [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]) {
    const sel = m === selectedMinute ? ' selected' : '';
    html += `<div class="time-btn${sel}" onclick="pickMinute(${m})">:${String(m).padStart(2,'0')}</div>`;
  }
  html += '</div></div>';

  html += '<div class="time-presets"><div class="time-presets-label">Quick presets</div><div class="time-presets-grid">';
  for (const p of TIME_PRESETS) {
    const sel = (selectedHour === p.h && selectedMinute === p.m) ? ' selected' : '';
    html += `<div class="time-preset${sel}" onclick="pickPreset(${p.h},${p.m})">${p.label}<br><small style="opacity:0.7">${p.desc}</small></div>`;
  }
  html += '</div></div>';
  container.innerHTML = html;
}

function pickHour(h) { selectedHour = h; renderTimePicker(); }
function pickMinute(m) { selectedMinute = m; renderTimePicker(); }
function pickPreset(h, m) { selectedHour = h; selectedMinute = m; renderTimePicker(); }

// ═══════════════════════════════════════════════════
//  MONTHLY DATE GRID PICKER
// ═══════════════════════════════════════════════════
let selectedMonthDates = new Set();

function renderMonthDateGrid() {
  const container = document.getElementById('monthDateGrid');
  if (!container) return;
  let html = '';
  for (let d = 1; d <= 31; d++) {
    const sel = selectedMonthDates.has(d) ? ' selected' : '';
    html += `<div class="md-btn${sel}" onclick="toggleMonthDate(${d})">${d}</div>`;
  }
  container.innerHTML = html;
}

function toggleMonthDate(d) {
  if (selectedMonthDates.has(d)) selectedMonthDates.delete(d);
  else selectedMonthDates.add(d);
  renderMonthDateGrid();
}

function getSelectedMonthDates() { return [...selectedMonthDates].sort((a, b) => a - b); }

// ═══════════════════════════════════════════════════
//  SCHEDULE TYPE TOGGLE
// ═══════════════════════════════════════════════════
function toggleScheduleType(type) {
  document.getElementById('onceFields').style.display = type === 'once' ? 'block' : 'none';
  document.getElementById('recurFields').style.display = type === 'recurring' ? 'block' : 'none';
}

function togglePatternUI() {
  const pattern = document.getElementById('schedPattern').value;
  document.getElementById('weeklyDaysField').style.display = pattern === 'weekly' ? 'block' : 'none';
  document.getElementById('monthlyDatesField').style.display = pattern === 'monthly' ? 'block' : 'none';
}

// ═══════════════════════════════════════════════════
//  SCHEDULED RUNS CRUD
// ═══════════════════════════════════════════════════
async function loadScheduledRuns() {
  const queue = document.getElementById('schedulerQueue');
  if (!queue) return;
  try {
    const data = await apiFetch(`/repos/${OWNER}/${REPO}/contents/.github/scheduled-runs.json`);
    const content = JSON.parse(atob(data.content));
    const entries = Array.isArray(content) ? content : [];
    renderScheduledQueue(entries, data.sha);
  } catch (e) {
    if (e.message.includes('404')) {
      queue.innerHTML = '<div class="empty">No scheduled runs yet</div>';
    } else {
      queue.innerHTML = `<div class="empty">⚠️ ${e.message}</div>`;
    }
  }
}

function renderScheduledQueue(entries, sha) {
  const queue = document.getElementById('schedulerQueue');
  if (!entries.length) { queue.innerHTML = '<div class="empty">No scheduled runs</div>'; return; }

  queue.dataset.sha = sha;
  queue.innerHTML = entries.map((entry, i) => {
    const wfName = WORKFLOWS.find(w => w.file === entry.workflow)?.name || entry.workflow;
    const icon = WORKFLOWS.find(w => w.file === entry.workflow)?.icon || '⚙️';
    const isOnce = entry.type === 'once';
    const desc = isOnce ? `${entry.run_at?.slice(0,16).replace('T',' ')} JST` : describeRecurrence(entry.recurrence);
    const enabled = entry.enabled !== false;
    const toggleCls = enabled ? 'sched-toggle active' : 'sched-toggle';

    return `<div class="sched-item">
      <span class="sched-type ${entry.type}">${isOnce ? 'Once' : 'Recurring'}</span>
      <span class="sched-wf">${icon} ${wfName}</span>
      <span class="sched-time">${desc}</span>
      ${entry.note ? `<span class="sched-note">${entry.note}</span>` : ''}
      ${!isOnce ? `<div class="${toggleCls}" onclick="toggleScheduleEntry(${i})"></div>` : ''}
      <button class="btn danger sm" onclick="deleteScheduledRun(${i})">🗑</button>
    </div>`;
  }).join('');
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

async function addScheduledRun() {
  if (!sessionToken) { toast('⚠️ Not authenticated'); return; }
  const workflow = document.getElementById('schedWorkflow').value;
  const type = document.getElementById('schedType').value;
  const time = document.getElementById('schedTime').value;
  const note = document.getElementById('schedNote').value.trim();

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

  await saveScheduledEntry(entry);
}

async function saveScheduledEntry(newEntry) {
  try {
    let entries = [];
    let sha = null;
    try {
      const data = await apiFetch(`/repos/${OWNER}/${REPO}/contents/.github/scheduled-runs.json`);
      entries = JSON.parse(atob(data.content));
      sha = data.sha;
    } catch {}

    entries.push(newEntry);
    const content = btoa(unescape(encodeURIComponent(JSON.stringify(entries, null, 2))));

    const body = { message: `sched: add ${newEntry.type} run`, content };
    if (sha) body.sha = sha;

    const res = await fetch(`${API}/repos/${OWNER}/${REPO}/contents/.github/scheduled-runs.json`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${sessionToken}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      toast('✅ Schedule added');
      loadScheduledRuns();
    } else {
      toast(`❌ Failed to save (${res.status})`);
    }
  } catch (e) { toast(`❌ ${e.message}`); }
}

async function deleteScheduledRun(index) {
  if (!confirm('Delete this scheduled run?')) return;
  try {
    const data = await apiFetch(`/repos/${OWNER}/${REPO}/contents/.github/scheduled-runs.json`);
    const entries = JSON.parse(atob(data.content));
    entries.splice(index, 1);

    const content = btoa(unescape(encodeURIComponent(JSON.stringify(entries, null, 2))));
    const res = await fetch(`${API}/repos/${OWNER}/${REPO}/contents/.github/scheduled-runs.json`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${sessionToken}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'sched: remove entry', content, sha: data.sha }),
    });

    if (res.ok) { toast('🗑 Removed'); loadScheduledRuns(); }
    else toast(`❌ Failed (${res.status})`);
  } catch (e) { toast(`❌ ${e.message}`); }
}

async function toggleScheduleEntry(index) {
  try {
    const data = await apiFetch(`/repos/${OWNER}/${REPO}/contents/.github/scheduled-runs.json`);
    const entries = JSON.parse(atob(data.content));
    entries[index].enabled = !entries[index].enabled;

    const content = btoa(unescape(encodeURIComponent(JSON.stringify(entries, null, 2))));
    const res = await fetch(`${API}/repos/${OWNER}/${REPO}/contents/.github/scheduled-runs.json`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${sessionToken}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'sched: toggle entry', content, sha: data.sha }),
    });

    if (res.ok) { loadScheduledRuns(); }
    else toast(`❌ Failed (${res.status})`);
  } catch (e) { toast(`❌ ${e.message}`); }
}
