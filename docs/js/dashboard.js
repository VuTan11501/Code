// ═══════════════════════════════════════════════════
//  REALTIME ADAPTIVE POLLING ENGINE
// ═══════════════════════════════════════════════════
const POLL_FAST = 1000;
const POLL_NORMAL = 15000;
const POLL_SLOW = 60000;
let pollInterval = POLL_NORMAL;
let pollTimer = null;
let isPolling = false;
let lastRunStates = {};
let hasRunningWorkflows = false;
let consecutiveErrors = 0;

// Dashboard workflow visibility — default: core only. Toggle persists in localStorage.
const DASH_SHOW_INFRA_KEY = 'wf_dash_show_infra';
function dashShowInfra() {
  try { return localStorage.getItem(DASH_SHOW_INFRA_KEY) === '1'; } catch { return false; }
}
function getDashboardWorkflows() {
  return dashShowInfra() ? WORKFLOWS_ALL : WORKFLOWS;
}
function toggleDashInfra(ev) {
  const next = !dashShowInfra();
  try { localStorage.setItem(DASH_SHOW_INFRA_KEY, next ? '1' : '0'); } catch {}
  renderInfraToggle();
  // Wipe grid skeletons so the new card set replaces cleanly.
  const grid = document.getElementById('workflowGrid');
  if (grid) grid.innerHTML = '<div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div>';
  if (typeof refresh === 'function') refresh();
}
function renderInfraToggle() {
  const bar = document.getElementById('dashInfraToggleBar');
  if (!bar) return;
  const on = dashShowInfra();
  bar.innerHTML = `
    <span class="dash-infra-label">Showing <strong>${on ? WORKFLOWS_ALL.length : WORKFLOWS.length}</strong> / ${WORKFLOWS_ALL.length} workflows</span>
    <span class="dash-infra-hint">Show infrastructure</span>
    <button type="button"
            class="switch ${on ? 'active' : ''}"
            role="switch"
            aria-checked="${on}"
            aria-label="Toggle infrastructure workflows"
            onclick="toggleDashInfra()"
            data-tooltip="${on ? 'Hide infrastructure workflows (heartbeat, dispatcher, deploy-pages, etc.)' : 'Also show infrastructure workflows (heartbeat, dispatcher, deploy-pages, etc.)'}">
      <span class="switch-thumb"></span>
    </button>
  `;
}

function updateLiveIndicator(status, interval) {
  const el = document.getElementById('liveIndicator');
  const statusEl = document.getElementById('liveStatus');
  const intervalEl = document.getElementById('liveInterval');
  if (!el) return;
  el.className = 'live-indicator ' + status;
  if (status === 'active') {
    statusEl.textContent = hasRunningWorkflows ? 'Streaming' : 'Live';
    intervalEl.textContent = interval < 2000 ? 'realtime' : `${Math.round(interval / 1000)}s`;
  } else if (status === 'paused') {
    statusEl.textContent = 'Paused';
    intervalEl.textContent = 'tab hidden';
  } else if (status === 'error') {
    statusEl.textContent = 'Error';
    intervalEl.textContent = 'retrying...';
  }
}

function startPolling() {
  stopPolling();
  pollInterval = POLL_NORMAL;
  updateLiveIndicator('active', pollInterval);
  renderInfraToggle();
  schedulePoll();
}

function stopPolling() {
  clearTimeout(pollTimer);
  pollTimer = null;
}

function schedulePoll() {
  clearTimeout(pollTimer);
  if (!sessionToken) return;
  pollTimer = setTimeout(async () => {
    await refresh();
    schedulePoll();
  }, pollInterval);
}

function adjustPollRate() {
  const newInterval = hasRunningWorkflows ? POLL_FAST : POLL_NORMAL;
  if (newInterval !== pollInterval) {
    pollInterval = newInterval;
    updateLiveIndicator('active', pollInterval);
    clearTimeout(pollTimer);
    schedulePoll();
  }
}

// Page Visibility API
document.addEventListener('visibilitychange', () => {
  if (!sessionToken) return;
  if (document.hidden) {
    clearTimeout(pollTimer);
    pollInterval = POLL_SLOW;
    updateLiveIndicator('paused', pollInterval);
    schedulePoll();
  } else {
    pollInterval = hasRunningWorkflows ? POLL_FAST : POLL_NORMAL;
    updateLiveIndicator('active', pollInterval);
    refresh();
    schedulePoll();
    // Pull settings from cloud — another device may have edited while we were away
    if (window.CloudSync) {
      window.CloudSync.pull().then(r => { if (r && r.applied) window.CloudSync.applyToUI(); });
    }
  }
});

window.addEventListener('focus', () => {
  if (sessionToken && !isPolling) refresh();
  if (sessionToken && window.CloudSync) {
    window.CloudSync.pull().then(r => { if (r && r.applied) window.CloudSync.applyToUI(); });
  }
});

// Detect status changes
function detectStatusChanges(allRuns) {
  const changes = [];
  for (const r of allRuns) {
    const prev = lastRunStates[r.id];
    const current = r.conclusion || r.status;
    if (prev && prev !== current) changes.push({ run: r, from: prev, to: current });
    lastRunStates[r.id] = current;
  }
  for (const ch of changes) {
    const wf = ch.run._wf || {};
    if (ch.to === 'success' && ch.from !== 'success')
      toast(`✅ ${wf.icon || ''} ${wf.name || 'Workflow'} #${ch.run.run_number} completed`);
    else if (ch.to === 'failure')
      toast(`❌ ${wf.icon || ''} ${wf.name || 'Workflow'} #${ch.run.run_number} failed`, 'error');
    else if ((ch.from === 'queued' || ch.from === 'waiting') && ch.to === 'in_progress')
      toast(`🔄 ${wf.icon || ''} ${wf.name || 'Workflow'} #${ch.run.run_number} started`);
  }
  if (changes.length > 0) {
    document.querySelectorAll('.card').forEach(card => card.classList.add('status-change-flash'));
    setTimeout(() => document.querySelectorAll('.card').forEach(card => card.classList.remove('status-change-flash')), 1000);
  }
}

// ═══════════════════════════════════════════════════
//  HEALTH SCORE BAR
// ═══════════════════════════════════════════════════
function renderHealthBar(workflowResults) {
  const el = document.getElementById('healthBar');
  if (!el) return;
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

  el.innerHTML = workflowResults.map(({ wf, runs }) => {
    const recent = runs.filter(r => new Date(r.created_at).getTime() >= sevenDaysAgo);
    const completed = recent.filter(r => r.status === 'completed');
    const passed = completed.filter(r => r.conclusion === 'success').length;
    const pct = completed.length ? Math.round(passed / completed.length * 100) : -1;
    const display = pct < 0 ? '—' : pct + '%';
    const color = pct < 0 ? 'var(--muted-foreground)' : pct >= 90 ? 'var(--green)' : pct >= 70 ? 'var(--yellow)' : 'var(--red)';
    const circ = 2 * Math.PI * 20;
    const offset = pct < 0 ? circ : circ - (circ * pct / 100);

    return `<div class="health-item">
      <div class="health-ring">
        <svg viewBox="0 0 48 48" aria-hidden="true">
          <circle class="ring-bg" cx="24" cy="24" r="20"/>
          <circle class="ring-fg" cx="24" cy="24" r="20" stroke="${color}"
            stroke-dasharray="${circ}" stroke-dashoffset="${offset}"/>
        </svg>
        <span class="health-pct" style="color:${color}">${display}</span>
      </div>
      <div class="health-info">
        <div class="health-name">${ICON(wf.iconName || 'play', 14)} ${wf.name}</div>
        <div class="health-detail">${passed}/${completed.length} passed (7d)</div>
      </div>
    </div>`;
  }).join('');
}

// ═══════════════════════════════════════════════════
//  WORKFLOW CARDS
// ═══════════════════════════════════════════════════
function statusBadge(runs) {
  if (!runs.length) return '<span class="status-badge status-skipped">No runs</span>';
  const last = runs[0];
  if (last.status === 'in_progress' || last.status === 'queued')
    return '<span class="status-badge status-running">● Running</span>';
  if (last.conclusion === 'success')
    return '<span class="status-badge status-success">✓ Success</span>';
  if (last.conclusion === 'failure')
    return '<span class="status-badge status-failure">✗ Failed</span>';
  return `<span class="status-badge status-skipped">${last.conclusion || 'unknown'}</span>`;
}

function successRate(runs) {
  const completed = runs.filter(r => r.status === 'completed');
  if (!completed.length) return '—';
  const success = completed.filter(r => r.conclusion === 'success').length;
  return `${Math.round(success / completed.length * 100)}%`;
}

function renderWorkflowCard(wf, runs) {
  const last5 = runs.slice(0, 4);
  return `
    <div class="card">
      <div class="card-header">
        <h2>${ICON(wf.iconName || 'play', 18)} ${wf.name}</h2>
        ${statusBadge(runs)}
      </div>
      <div class="card-body">
        <div class="stats-row">
          <div class="stat">
            <div class="stat-value">${successRate(runs.slice(0, 10))}</div>
            <div class="stat-label">Success (10 runs)</div>
          </div>
          <div class="stat">
            <div class="stat-value">${runs.length ? timeAgo(runs[0].created_at) : '—'}</div>
            <div class="stat-label">Last Run</div>
          </div>
        </div>
        <ul class="run-list">
          ${last5.map((r, i) => {
            const title = r.display_title || r.name || `Run #${r.run_number}`;
            const titleEsc = title.replace(/"/g, '&quot;');
            return `
            <li class="run-item${i >= 2 ? ' hide-mobile' : ''}" onclick="openLogModal(${r.id}, '${wf.icon} ${wf.name} #${r.run_number}', '${r.status}')">
              <span class="run-dot ${conclusionClass(r.conclusion || r.status)}"></span>
              <span class="run-name" data-tooltip="${titleEsc}" data-tooltip-truncate-only tabindex="0">${title}</span>
              <span class="run-meta">
                <span class="run-event">${r.event}</span>
                <a class="run-num" href="${r.html_url}" target="_blank" onclick="event.stopPropagation()">#${r.run_number}</a>
                <span class="run-time">${timeAgo(r.created_at)}</span>
              </span>
            </li>
          `;}).join('')}
          ${last5.length === 0 ? '<li class="run-item" style="color:var(--muted-foreground);cursor:default">No runs yet</li>' : ''}
        </ul>
        <div class="trigger-actions">
          <button class="btn primary sm" onclick="triggerWorkflow('${wf.file}', event)">▶ Trigger</button>
          <a class="btn sm" href="https://github.com/${OWNER}/${REPO}/actions/workflows/${wf.file}" target="_blank">View →</a>
        </div>
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════════════════
//  TRIGGER & CANCEL
// ═══════════════════════════════════════════════════
async function triggerWorkflow(file, ev) {
  if (!sessionToken) { toast('⚠️ Not authenticated'); return; }
  const btn = ev && ev.currentTarget;
  const origHtml = btn ? btn.innerHTML : '';

  // ⚠️ Pre-flight check: warn if checkout would forfeit scheduled OT hours.
  if (file === 'auto-checkout.yml' && typeof getPendingCheckoutAhead === 'function') {
    const w = await getPendingCheckoutAhead();
    if (w) {
      const nowFmt = new Date().toLocaleString('ja-JP', {
        timeZone: 'Asia/Tokyo', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
      });
      const hoursLost = w.hoursLost.toFixed(1);
      const message =
        `Hôm nay đã có lịch checkout TỰ ĐỘNG tại ${w.otEndTime} ` +
        `(thường là CO cho OT vắt qua nửa đêm).\n\n` +
        `Nếu trigger checkout NGAY BÂY GIỜ (${nowFmt} JST), DokoKin sẽ đóng ` +
        `workday tại thời điểm này — bạn sẽ MẤT ~${hoursLost}h và lịch CO ` +
        `tự động sau đó có thể chỉ push end-time muộn hơn chứ không reopen được session.\n\n` +
        (w.note ? `📝 Note: ${w.note}\n\n` : '') +
        `Vẫn muốn checkout sớm?`;
      const ok = await uiConfirm({
        title: '⚠️ Cảnh báo: có lịch CO sau, OT có thể bị mất',
        message,
        confirmText: 'Vẫn checkout',
        cancelText: 'Huỷ',
        danger: true,
      });
      if (!ok) return;
    }
  }

  try {
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `${ICON('refresh', 14, 'animate-spin')} Triggering…`;
    }
    const res = await fetch(`${API}/repos/${OWNER}/${REPO}/actions/workflows/${file}/dispatches`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${sessionToken}`, 'Accept': 'application/vnd.github+json' },
      body: JSON.stringify({ ref: 'main' }),
    });
    if (res.status === 204) {
      toast('✅ Workflow triggered! Refreshing…');
      hasRunningWorkflows = true;
      adjustPollRate();
      let attempts = 0;
      const pollForNew = async () => {
        attempts++;
        await refresh();
        if (attempts < 5 && !document.querySelector('.status-badge.status-running')) {
          setTimeout(pollForNew, 3000);
        }
      };
      setTimeout(pollForNew, 2000);
    }
    else toast(`❌ Failed (${res.status})`);
  } catch (e) { toast(`❌ ${e.message}`); }
  finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origHtml;
    }
  }
}

async function cancelWorkflowRun(runId) {
  if (!sessionToken) { toast('⚠️ Not authenticated'); return; }
  if (!await uiConfirm({ title: 'Cancel run?', message: 'Cancel this workflow run?', confirmText: 'Cancel run', danger: true })) return;
  try {
    const res = await fetch(`${API}/repos/${OWNER}/${REPO}/actions/runs/${runId}/cancel`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${sessionToken}`, 'Accept': 'application/vnd.github+json' },
    });
    if (res.status === 202) {
      toast('✅ Workflow cancelled');
      closeLogModal();
      setTimeout(refresh, 1500);
    } else {
      toast(`❌ Cancel failed (${res.status})`);
    }
  } catch (e) { toast(`❌ ${e.message}`); }
}

// ═══════════════════════════════════════════════════
//  LOG MODAL
// ═══════════════════════════════════════════════════
function openLogModal(runId, title, status) {
  const overlay = document.getElementById('logModal');
  const body = document.getElementById('logModalBody');
  document.getElementById('logModalTitle').textContent = title || 'Run Logs';
  body.innerHTML = '<div class="empty">Loading jobs…</div>';
  overlay.classList.add('open');
  loadRunJobs(runId, body, status);
}

function closeLogModal() {
  document.getElementById('logModal').classList.remove('open');
  // Stop any in-flight polls
  if (_logModalRefreshTimer) { clearTimeout(_logModalRefreshTimer); _logModalRefreshTimer = null; }
  if (typeof _jobLogPolls !== 'undefined') {
    _jobLogPolls.forEach(t => clearInterval(t));
    _jobLogPolls.clear();
  }
  if (typeof _jobLogCache !== 'undefined') _jobLogCache.clear();
  if (typeof _jobStepsMap !== 'undefined') _jobStepsMap.clear();
}

async function loadRunJobs(runId, container, status) {
  try {
    const data = await apiFetch(`/repos/${OWNER}/${REPO}/actions/runs/${runId}/jobs`);
    const jobs = data.jobs || [];
    const isRunning = status === 'in_progress' || status === 'queued';

    let html = '';
    if (isRunning) {
      html += `<div class="logs-cancel-bar">
        <button class="btn danger sm" onclick="cancelWorkflowRun(${runId})">⏹ Cancel this run</button>
      </div>`;
    }

    if (!jobs.length) { container.innerHTML = html + '<div class="empty">No jobs found.</div>'; return; }

    jobs.forEach((j, idx) => {
      const jobRunning = j.status === 'in_progress' || j.status === 'queued';
      const tsId = `ts-${j.id}`;
      const toolbar = `<div class="job-toolbar">
        <button class="btn btn-outline sm" type="button" onclick="copyFullJobLog(this, ${j.id})">Copy log</button>
        <div class="shadcn-field">
          <input type="checkbox" id="${tsId}" class="shadcn-checkbox peer" checked onchange="toggleAllTimestamps(this, ${j.id})">
          <label for="${tsId}" class="shadcn-label">timestamps</label>
        </div>
        <a class="log-external" href="${j.html_url}" target="_blank" rel="noopener">Open on GitHub ↗</a>
      </div>`;
      if (jobs.length > 1) {
        const jCls = conclusionClass(j.conclusion || j.status);
        html += `<div class="job-heading">
          <span class="run-dot ${jCls}"></span>
          <span class="job-name">${escapeHtml(j.name)}</span>
          <span class="status-badge status-${jCls}">${j.conclusion || j.status}</span>
          ${toolbar}
        </div>`;
      } else {
        html += `<div class="job-heading-mini">${toolbar}</div>`;
      }

      html += `<div class="steps-list" data-job-id="${j.id}">`;
      _jobStepsMap.set(String(j.id), j.steps || []);
      (j.steps || []).forEach(s => {
        const sd = (s.completed_at && s.started_at)
          ? Math.round((new Date(s.completed_at) - new Date(s.started_at)) / 1000) : null;
        const sDurStr = sd !== null ? (sd >= 60 ? `${Math.floor(sd/60)}m ${sd%60}s` : `${sd}s`) : (s.status === 'in_progress' ? 'running…' : '—');
        const sCls = conclusionClass(s.conclusion || s.status);
        const icon = sCls === 'success' ? '✓' : sCls === 'failure' ? '✗' : sCls === 'skipped' ? '○' : sCls === 'in_progress' ? '●' : '–';
        const hasLog = sCls !== 'skipped' && s.status !== 'queued';
        const stepNum = s.number;
        html += `
          <div class="step-block step-${sCls}${hasLog ? '' : ' no-log'}" data-job-id="${j.id}" data-step-num="${stepNum}" data-step-name="${escapeHtml(s.name)}" data-started="${s.started_at || ''}" data-completed="${s.completed_at || ''}">
            <button type="button" class="step-row" ${hasLog ? `onclick="toggleStepLog(this)"` : `disabled aria-disabled="true"`} aria-expanded="false">
              <span class="step-icon">${icon}</span>
              <span class="step-name">${escapeHtml(s.name)}</span>
              <span class="step-duration">${sDurStr}</span>
              ${hasLog ? '<span class="step-chevron" aria-hidden="true">▾</span>' : ''}
            </button>
            ${hasLog ? `<div class="step-log-body" data-loaded="0"></div>` : ''}
          </div>`;
      });
      html += '</div>';
    });

    container.innerHTML = html;

    if (isRunning) {
      _logModalRefreshTimer = setTimeout(() => loadRunJobs(runId, container, status), 5000);
    }
  } catch (e) {
    container.innerHTML = `<div class="empty">❌ Failed: ${escapeHtml(e.message)}</div>`;
  }
}

let _logModalRefreshTimer = null;
const _jobLogPolls = new Map(); // key → timer
const _jobLogCache = new Map(); // jobId → parsed log
const _jobStepsMap = new Map(); // jobId → steps[]

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

async function toggleStepLog(btn) {
  const block = btn.closest('.step-block');
  const body = block.querySelector('.step-log-body');
  if (!body) return;
  const open = block.classList.toggle('open');
  btn.setAttribute('aria-expanded', String(open));
  if (!open) return;

  const jobId = block.dataset.jobId;
  const stepName = block.dataset.stepName;
  const stepNum = parseInt(block.dataset.stepNum, 10);
  const allSteps = _jobStepsMap.get(String(jobId)) || [];
  const currentStep = allSteps.find(s => s.number === stepNum) || { name: stepName, number: stepNum };

  if (body.dataset.loaded !== '1') {
    body.innerHTML = '<div class="log-loading">Fetching log…</div>';
    const cache = await ensureJobLogCache(jobId);
    if (cache.error) {
      body.innerHTML = `<div class="log-loading">❌ ${escapeHtml(cache.error)}</div>`;
      return;
    }
    const lines = sliceStepLines(cache, allSteps, currentStep);
    renderStepLog(body, lines, stepName);
    body.dataset.loaded = '1';
  }

  const stepRunning = block.classList.contains('step-in_progress');
  if (stepRunning && !_jobLogPolls.has(`${jobId}:${stepNum}`)) {
    const t = setInterval(async () => {
      _jobLogCache.delete(jobId);
      const cache = await ensureJobLogCache(jobId);
      if (!cache.error) {
        const lines = sliceStepLines(cache, allSteps, currentStep);
        renderStepLog(body, lines, stepName);
      }
    }, 4000);
    _jobLogPolls.set(`${jobId}:${stepNum}`, t);
  }
}

async function ensureJobLogCache(jobId) {
  if (_jobLogCache.has(jobId)) return _jobLogCache.get(jobId);
  try {
    // NOTE: do NOT set Accept: text/plain — GitHub responds 415.
    // Default Accept works; endpoint 302-redirects to Azure Blob (text/plain).
    const r = await fetch(`${API}/repos/${OWNER}/${REPO}/actions/jobs/${jobId}/logs`, {
      headers: { 'Authorization': `Bearer ${sessionToken}` }
    });
    if (r.status === 404) {
      const empty = { raw: '', groups: [], error: null, notReady: true };
      return empty;
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const raw = await r.text();
    const parsed = parseJobLog(raw);
    _jobLogCache.set(jobId, parsed);
    return parsed;
  } catch (e) {
    return { error: e.message };
  }
}

// Parse raw job log into timestamped lines + detect step boundaries via
// ##[group]Run X / ##[group]Post X / ##[group]Cleaning up / ##[group]Complete job markers.
// This mirrors GitHub UI's own log slicing.
function parseJobLog(raw) {
  const cleaned = raw.replace(/\x1b\[[0-9;]*m/g, ''); // strip ANSI
  const rawLines = cleaned.split(/\r?\n/);
  const lines = rawLines.map(ln => {
    if (!ln) return { ts: '', txt: '' };
    const m = ln.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z) ?(.*)$/);
    return m ? { ts: m[1], txt: m[2] } : { ts: '', txt: ln };
  });

  // Find boundary markers
  const boundaries = []; // {index, kind: 'run'|'post'|'cleanup', name}
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].txt;
    let m;
    if ((m = t.match(/^##\[group\]Run (.+)$/))) {
      boundaries.push({ index: i, kind: 'run', name: m[1].trim() });
    } else if ((m = t.match(/^##\[group\]Post Run (.+)$/))) {
      boundaries.push({ index: i, kind: 'post', name: m[1].trim() });
    } else if ((m = t.match(/^##\[group\]Post (.+)$/))) {
      boundaries.push({ index: i, kind: 'post', name: m[1].trim() });
    } else if (/^##\[group\](Cleaning up orphan processes|Complete job)/i.test(t)) {
      boundaries.push({ index: i, kind: 'cleanup', name: '' });
    }
  }
  return { raw: cleaned, lines, boundaries, error: null };
}

// Slice lines for a step using the GitHub-style group boundaries.
// allSteps = full j.steps array; currentStep = the step we want logs for.
function sliceStepLines(cache, allSteps, currentStep) {
  if (!cache || !cache.lines) return [];
  const { lines, boundaries } = cache;
  const name = currentStep.name || '';
  const nameLc = name.toLowerCase();

  // "Set up job": everything before the first boundary
  if (/^set up job$/i.test(name)) {
    const end = boundaries.length ? boundaries[0].index : lines.length;
    return lines.slice(0, end);
  }
  // "Complete job": last cleanup boundary → end
  if (/^complete job$/i.test(name)) {
    const ups = boundaries.filter(b => b.kind === 'cleanup');
    if (ups.length) return lines.slice(ups[ups.length - 1].index);
    return [];
  }
  // "Post <Step Name>": match by suffix among post boundaries
  if (/^post\s+/i.test(name)) {
    const suffix = name.replace(/^post\s+/i, '').toLowerCase();
    const posts = boundaries.filter(b => b.kind === 'post');
    let hit = posts.find(b => b.name.toLowerCase().includes(suffix) || suffix.includes(b.name.toLowerCase()));
    if (!hit) {
      // Fallback: positional match among post boundaries
      const postSteps = allSteps.filter(s => /^post\s+/i.test(s.name) && s.conclusion !== 'skipped');
      const idx = postSteps.findIndex(s => s.number === currentStep.number);
      if (idx >= 0 && idx < posts.length) hit = posts[idx];
    }
    if (!hit) return [];
    const next = boundaries.find(b => b.index > hit.index);
    return lines.slice(hit.index, next ? next.index : lines.length);
  }

  // Regular user step: match by name suffix in run boundaries, fall back to positional
  const runs = boundaries.filter(b => b.kind === 'run');
  let hit = runs.find(b => b.name.toLowerCase().includes(nameLc) || nameLc.includes(b.name.toLowerCase()));
  if (!hit) {
    // Positional: nth runnable step ↔ nth run boundary
    const runSteps = allSteps.filter(s =>
      !/^set up job$/i.test(s.name) &&
      !/^post\s+/i.test(s.name) &&
      !/^complete job$/i.test(s.name) &&
      s.conclusion !== 'skipped'
    );
    const idx = runSteps.findIndex(s => s.number === currentStep.number);
    if (idx >= 0 && idx < runs.length) hit = runs[idx];
  }
  if (!hit) return [];
  // End at next run/post/cleanup boundary
  const next = boundaries.find(b => b.index > hit.index);
  return lines.slice(hit.index, next ? next.index : lines.length);
}

function renderStepLog(body, lines, stepName) {
  if (!lines || lines.length === 0) {
    body.innerHTML = '<div class="log-loading">No log output for this step.</div>';
    return;
  }
  const html = ['<div class="scroll-area" data-slot="scroll-area"><div class="scroll-area-viewport" data-slot="scroll-area-viewport"><pre class="log-pre"><code>'];
  for (const ln of lines) {
    const txt = ln.txt;
    if (!txt && !ln.ts) { html.push('\n'); continue; }
    if (/^##\[endgroup\]/.test(txt)) continue; // suppress endgroup markers
    let cls = 'log-line';
    let clean = txt;
    if (/^##\[group\]/.test(txt)) {
      cls += ' log-group';
      clean = '▸ ' + txt.replace(/^##\[group\]/, '');
    } else if (/^##\[error\]/.test(txt)) {
      cls += ' log-error';
      clean = txt.replace(/^##\[error\]/, '');
    } else if (/^##\[warning\]/.test(txt)) {
      cls += ' log-warn';
      clean = txt.replace(/^##\[warning\]/, '');
    } else if (/^##\[command\]/.test(txt)) {
      cls += ' log-cmd';
      clean = '$ ' + txt.replace(/^##\[command\]/, '');
    } else if (/^##\[section\]/.test(txt)) {
      cls += ' log-group';
      clean = txt.replace(/^##\[section\]/, '');
    } else if (/\b(error|failed|exception|traceback)\b/i.test(txt)) {
      cls += ' log-error';
    } else if (/\bwarning\b/i.test(txt)) {
      cls += ' log-warn';
    }
    html.push(`<span class="${cls}">`);
    if (ln.ts) html.push(`<span class="log-ts">${ln.ts.substring(11, 19)}</span> `);
    html.push(escapeHtml(clean));
    html.push('</span>\n');
  }
  html.push('</code></pre></div></div>');
  body.innerHTML = html.join('');
  const vp = body.querySelector('.scroll-area-viewport');
  if (vp) vp.scrollTop = vp.scrollHeight;
}

function toggleAllTimestamps(cb, jobId) {
  const list = document.querySelector(`.steps-list[data-job-id="${jobId}"]`);
  if (list) list.classList.toggle('hide-ts', !cb.checked);
}

async function copyFullJobLog(btn, jobId) {
  const old = btn.textContent;
  btn.textContent = 'Loading…'; btn.disabled = true;
  try {
    const cache = await ensureJobLogCache(jobId);
    const text = (cache && cache.raw) ? cache.raw : '';
    if (!text) throw new Error(cache && cache.error ? cache.error : 'No log yet');
    await navigator.clipboard.writeText(text);
    btn.textContent = 'Copied!';
  } catch (e) {
    btn.textContent = '❌ ' + (e.message || 'Failed');
  } finally {
    setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 1400);
  }
}

document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLogModal(); });
document.getElementById('logModal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeLogModal();
});

// ═══════════════════════════════════════════════════
//  MAIN REFRESH
// ═══════════════════════════════════════════════════
async function refresh() {
  if (isPolling) return;
  isPolling = true;
  const grid = document.getElementById('workflowGrid');
  const recentEl = document.getElementById('recentRuns');

  try {
    // Per-workflow fetch — ETag conditional GETs keep this cheap (304 not counted heavily).
    // Previously had a "fast path" using global /actions/runs?per_page=20, but high-frequency
    // workflows (scheduled-dispatch self-loop) dominated the 20-slot pool, leaving other
    // cards empty whenever a trigger happened. Per-workflow guarantees each card has its data.
    const activeWorkflows = getDashboardWorkflows();
    const results = await Promise.all(
      activeWorkflows.map(wf =>
        apiFetch(`/repos/${OWNER}/${REPO}/actions/workflows/${wf.file}/runs?per_page=10`)
          .then(data => ({ wf, runs: data.workflow_runs || [] }))
          .catch(() => ({ wf, runs: [] }))
      )
    );

    const allRuns = [];
    if (grid) {
      grid.innerHTML = results.map(({ wf, runs }) => {
        allRuns.push(...runs.map(r => ({ ...r, _wf: wf })));
        return renderWorkflowCard(wf, runs);
      }).join('');
    } else {
      results.forEach(({ wf, runs }) => allRuns.push(...runs.map(r => ({ ...r, _wf: wf }))));
    }

    allRuns.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    if (recentEl) {
      recentEl.innerHTML = allRuns.slice(0, 12).map(r => `
        <li class="run-item" onclick="openLogModal(${r.id}, '${r._wf.icon} ${r._wf.name} #${r.run_number}', '${r.status}')">
          <span class="run-dot ${conclusionClass(r.conclusion || r.status)}"></span>
          <span class="run-name">${r._wf.icon} ${r._wf.name}</span>
          <span class="run-meta">
            <span class="run-event">${r.event}</span>
            <a class="run-num" href="${r.html_url}" target="_blank" onclick="event.stopPropagation()">#${r.run_number}</a>
            <span class="run-time">${timeAgo(r.created_at)}</span>
          </span>
        </li>
      `).join('');
    }

    document.getElementById('lastUpdate').textContent = `Updated: ${new Date().toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo' })} JST`;

    hasRunningWorkflows = allRuns.some(r => r.status === 'in_progress' || r.status === 'queued');
    adjustPollRate();
    detectStatusChanges(allRuns);
    checkForNewFailures(allRuns);

    consecutiveErrors = 0;
    if (!document.hidden) updateLiveIndicator('active', pollInterval);
  } catch (e) {
    consecutiveErrors++;
    updateLiveIndicator('error', pollInterval);
    if (grid) {
      grid.innerHTML = `<div class="card" style="grid-column:1/-1">
        <div class="card-body" style="text-align:center;padding:var(--sp-8)">
          <div style="margin-bottom:var(--sp-3);display:flex;justify-content:center">${ICON('alert', 32)}</div>
          <div style="font-weight:600;margin-bottom:var(--sp-2)">${e.message}</div>
          <div class="text-muted" style="font-size:var(--fs-sm)">Retrying automatically… (attempt ${consecutiveErrors})</div>
        </div>
      </div>`;
    }
    if (consecutiveErrors === 1) toast(`❌ ${e.message}`, 'error');
  } finally {
    isPolling = false;
  }
}
