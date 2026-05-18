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
  // Default date = today, time = current JST time
  const now = jstNow();
  selectedHour = now.getHours();
  selectedMinute = now.getMinutes();
  renderTimePicker();
  renderMonthDateGrid();
  const todayStr = formatDate(now.getFullYear(), now.getMonth(), now.getDate());
  calSelect('calPicker', todayStr);
  loadScheduledRuns();
}

// ═══════════════════════════════════════════════════
//  SCHEDULE CALENDAR (Weekly overview)
// ═══════════════════════════════════════════════════
function renderScheduleCalendar() {
  const container = document.getElementById('scheduleCalendar');
  if (!container) return;
  const dayNames = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
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
//  iOS-STYLE WHEEL TIME PICKER
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
  updateTimeDisplay();

  let html = `<div class="wheel-picker-container">
    <div class="wheel-picker-highlight"></div>
    <div class="wheel-column" id="wheelHour"></div>
    <div class="wheel-separator">:</div>
    <div class="wheel-column" id="wheelMinute"></div>
  </div>`;

  html += '<div class="time-presets"><div class="time-presets-label">Quick presets</div><div class="time-presets-grid">';
  for (const p of TIME_PRESETS) {
    const sel = (selectedHour === p.h && selectedMinute === p.m) ? ' selected' : '';
    html += `<div class="time-preset${sel}" onclick="pickPreset(${p.h},${p.m})">${p.label} <span class="text-muted">${p.desc}</span></div>`;
  }
  html += '</div></div>';
  container.innerHTML = html;

  // Initialize wheel columns
  initWheel('wheelHour', 24, selectedHour, (val) => { selectedHour = val; updateTimeDisplay(); });
  initWheel('wheelMinute', 60, selectedMinute, (val) => { selectedMinute = val; updateTimeDisplay(); });
}

function updateTimeDisplay() {
  const timeStr = `${String(selectedHour).padStart(2,'0')}:${String(selectedMinute).padStart(2,'0')}`;
  document.getElementById('schedTime').value = timeStr;
  const dispInput = document.getElementById('schedTimeInput');
  if (dispInput) dispInput.value = timeStr;
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

  // Set padding so first/last items can center
  col.style.paddingTop = padding + 'px';
  col.style.paddingBottom = padding + 'px';

  // Scroll to initial selection
  col.scrollTop = initialIndex * itemHeight;

  // Handle scroll with snap
  let scrollTimeout;
  col.addEventListener('scroll', () => {
    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(() => {
      const index = Math.round(col.scrollTop / itemHeight);
      const clamped = Math.max(0, Math.min(count - 1, index));
      col.scrollTo({ top: clamped * itemHeight, behavior: 'smooth' });

      // Update selection highlighting
      col.querySelectorAll('.wheel-item').forEach((el, i) => {
        el.classList.toggle('active', i === clamped);
      });
      onChange(clamped);
    }, 80);
  }, { passive: true });

  // Mark initial active
  col.querySelectorAll('.wheel-item')[initialIndex]?.classList.add('active');

  // Click to select
  col.querySelectorAll('.wheel-item').forEach((item) => {
    item.addEventListener('click', () => {
      const idx = parseInt(item.dataset.index);
      col.scrollTo({ top: idx * itemHeight, behavior: 'smooth' });
    });
  });
}

function pickPreset(h, m) {
  selectedHour = h;
  selectedMinute = m;
  updateTimeDisplay();
  // Re-scroll wheels
  const hCol = document.getElementById('wheelHour');
  const mCol = document.getElementById('wheelMinute');
  if (hCol) hCol.scrollTo({ top: h * 44, behavior: 'smooth' });
  if (mCol) mCol.scrollTo({ top: m * 44, behavior: 'smooth' });
  // Update active states
  hCol?.querySelectorAll('.wheel-item').forEach((el, i) => el.classList.toggle('active', i === h));
  mCol?.querySelectorAll('.wheel-item').forEach((el, i) => el.classList.toggle('active', i === m));
}

// Keep old functions for backward compat
function pickHour(h) { selectedHour = h; renderTimePicker(); }
function pickMinute(m) { selectedMinute = m; renderTimePicker(); }

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
    // Client-side fallback: dispatch overdue one-time runs directly
    await clientSideDispatchOverdue(entries, data.sha);
    renderScheduledQueue(entries, data.sha);
  } catch (e) {
    if (e.message.includes('404')) {
      queue.innerHTML = '<div class="empty">No scheduled runs yet</div>';
    } else {
      queue.innerHTML = `<div class="empty">⚠️ ${e.message}</div>`;
    }
    // Clear table on error/empty
    scheduleTableData = [];
    scheduleTableSha = null;
    renderScheduleTable();
  }
}

// Fallback: if GitHub cron hasn't fired, dispatch overdue runs from the browser
async function clientSideDispatchOverdue(entries, sha) {
  if (!sessionToken || !entries.length) return;
  const now = new Date();
  const overdue = [];
  const remaining = [];

  for (const entry of entries) {
    if (entry.type === 'once' && entry.run_at) {
      const runAt = new Date(entry.run_at);
      // If run_at has passed (with 1 min tolerance) and it wasn't dispatched yet
      if (now - runAt > 60000) {
        overdue.push(entry);
      } else {
        remaining.push(entry);
      }
    } else {
      remaining.push(entry);
    }
  }

  if (!overdue.length) return;

  for (const entry of overdue) {
    try {
      const res = await fetch(`${API}/repos/${OWNER}/${REPO}/actions/workflows/${entry.workflow}/dispatches`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${sessionToken}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: 'main' }),
      });
      if (res.status === 204) {
        toast(`✅ Dispatched overdue: ${entry.workflow.replace('.yml','')}`);
      } else {
        remaining.push(entry); // keep for retry
      }
    } catch {
      remaining.push(entry);
    }
  }

  // Update the file to remove dispatched entries
  if (remaining.length !== entries.length) {
    const content = btoa(unescape(encodeURIComponent(JSON.stringify(remaining, null, 2))));
    try {
      await fetch(`${API}/repos/${OWNER}/${REPO}/contents/.github/scheduled-runs.json`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${sessionToken}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'sched: client-side dispatch overdue [skip ci]', content, sha }),
      });
    } catch {}
    // Reload to show updated queue
    entries.length = 0;
    remaining.forEach(e => entries.push(e));
  }
}

function renderScheduledQueue(entries, sha) {
  // Store data for table
  scheduleTableData = entries;
  scheduleTableSha = sha;

  // Render queue cards
  const queue = document.getElementById('schedulerQueue');
  if (!entries.length) { queue.innerHTML = '<div class="empty">No scheduled runs</div>'; renderScheduleTable(); return; }

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

// ═══════════════════════════════════════════════════
//  SCHEDULE DATA TABLE
// ═══════════════════════════════════════════════════
let scheduleTableData = [];
let scheduleTableSha = null;

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
    tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted-foreground py-8">No schedules found</td></tr>';
    if (countEl) countEl.textContent = '0 entries';
    return;
  }

  const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  tbody.innerHTML = filtered.map((entry, filteredIdx) => {
    const realIdx = scheduleTableData.indexOf(entry);
    const wf = WORKFLOWS.find(w => w.file === entry.workflow);
    const wfName = wf ? `${wf.icon} ${wf.name}` : entry.workflow;
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
      const isPast = entry.run_at && new Date(entry.run_at) < new Date();
      statusBadge = isPast
        ? '<span class="badge-disabled">Expired</span>'
        : '<span class="badge-enabled">Pending</span>';
    } else {
      statusBadge = enabled
        ? '<span class="badge-enabled">Active</span>'
        : '<span class="badge-disabled">Disabled</span>';
    }

    // Created date
    const created = entry.created ? new Date(entry.created).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';

    return `<tr>
      <td class="text-muted-foreground font-mono">${realIdx + 1}</td>
      <td><span class="badge-${entry.type}">${isOnce ? 'Once' : 'Recurring'}</span></td>
      <td class="font-medium">${wfName}</td>
      <td class="font-mono text-xs">${schedDesc}</td>
      <td class="text-muted-foreground">${entry.note || '—'}</td>
      <td>${statusBadge}</td>
      <td class="text-muted-foreground text-xs">${created}</td>
      <td><div class="actions-cell">
        <button class="btn sm" onclick="openEditSchedModal(${realIdx})" title="Edit">✏️</button>
        <button class="btn danger sm" onclick="deleteScheduledRun(${realIdx})" title="Delete">🗑</button>
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

  toggleEditType(entry.type);

  if (entry.type === 'once') {
    // Parse run_at to datetime-local format
    if (entry.run_at) {
      const dt = entry.run_at.slice(0, 16); // YYYY-MM-DDTHH:MM
      document.getElementById('editSchedDateTime').value = dt;
    }
  } else if (entry.recurrence) {
    const r = entry.recurrence;
    document.getElementById('editSchedPattern').value = r.pattern || 'daily';
    document.getElementById('editSchedTime').value = r.time || '09:00';
    document.getElementById('editSchedDays').value = (r.days || []).join(',');
    document.getElementById('editSchedDates').value = (r.dates || []).join(',');
    document.getElementById('editSchedEnabled').checked = entry.enabled !== false;
  }

  document.getElementById('editSchedModal').classList.add('open');
}

function closeEditSchedModal() {
  document.getElementById('editSchedModal').classList.remove('open');
}

function toggleEditType(type) {
  document.getElementById('editOnceFields').style.display = type === 'once' ? 'block' : 'none';
  document.getElementById('editRecurFields').style.display = type === 'recurring' ? 'block' : 'none';
}

async function saveEditSchedule() {
  const index = parseInt(document.getElementById('editSchedIndex').value);
  if (isNaN(index) || !scheduleTableData[index]) { toast('❌ Invalid entry'); return; }

  const workflow = document.getElementById('editSchedWorkflow').value;
  const type = document.getElementById('editSchedType').value;
  const note = document.getElementById('editSchedNote').value.trim() || undefined;

  let updatedEntry;

  if (type === 'once') {
    const dt = document.getElementById('editSchedDateTime').value;
    if (!dt) { toast('⚠️ Pick a date & time'); return; }
    const runAt = dt + ':00+09:00';
    updatedEntry = { type: 'once', workflow, run_at: runAt, note, created: scheduleTableData[index].created || new Date().toISOString() };
  } else {
    const pattern = document.getElementById('editSchedPattern').value;
    const time = document.getElementById('editSchedTime').value;
    if (!time) { toast('⚠️ Set a time'); return; }

    const recurrence = { pattern, time };
    const daysStr = document.getElementById('editSchedDays').value.trim();
    const datesStr = document.getElementById('editSchedDates').value.trim();

    if (pattern === 'weekly' || pattern === 'weekdays') {
      if (daysStr) recurrence.days = daysStr.split(',').map(d => parseInt(d.trim())).filter(d => !isNaN(d));
      else if (pattern === 'weekdays') recurrence.days = [1,2,3,4,5];
    }
    if (pattern === 'monthly' && datesStr) {
      recurrence.dates = datesStr.split(',').map(d => parseInt(d.trim())).filter(d => !isNaN(d));
    }

    const enabled = document.getElementById('editSchedEnabled').checked;
    updatedEntry = { type: 'recurring', workflow, recurrence, enabled, note, created: scheduleTableData[index].created || new Date().toISOString() };
  }

  // Save to GitHub
  try {
    const data = await apiFetch(`/repos/${OWNER}/${REPO}/contents/.github/scheduled-runs.json`);
    const entries = JSON.parse(atob(data.content));
    entries[index] = updatedEntry;

    const content = btoa(unescape(encodeURIComponent(JSON.stringify(entries, null, 2))));
    const res = await fetch(`${API}/repos/${OWNER}/${REPO}/contents/.github/scheduled-runs.json`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${sessionToken}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'sched: edit entry', content, sha: data.sha }),
    });

    if (res.ok) {
      toast('✅ Schedule updated');
      closeEditSchedModal();
      loadScheduledRuns();
    } else {
      toast(`❌ Failed (${res.status})`);
    }
  } catch (e) { toast(`❌ ${e.message}`); }
}
