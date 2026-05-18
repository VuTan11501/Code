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
  }
});

window.addEventListener('focus', () => {
  if (sessionToken && !isPolling) refresh();
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
        <div class="health-name">${wf.icon} ${wf.name}</div>
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
  const last5 = runs.slice(0, 5);
  return `
    <div class="card">
      <div class="card-header">
        <h2>${wf.icon} ${wf.name}</h2>
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
          ${last5.map(r => `
            <li class="run-item" onclick="openLogModal(${r.id}, '${wf.icon} ${wf.name} #${r.run_number}', '${r.status}')">
              <span class="run-dot ${conclusionClass(r.conclusion || r.status)}"></span>
              <a href="${r.html_url}" target="_blank" onclick="event.stopPropagation()">#${r.run_number}</a>
              <span class="run-event">${r.event}</span>
              <span class="run-time">${timeAgo(r.created_at)}</span>
            </li>
          `).join('')}
          ${last5.length === 0 ? '<li class="run-item" style="color:var(--muted-foreground);cursor:default">No runs yet</li>' : ''}
        </ul>
        <div class="trigger-actions">
          <button class="btn primary sm" onclick="triggerWorkflow('${wf.file}')">▶ Trigger</button>
          <a class="btn sm" href="https://github.com/${OWNER}/${REPO}/actions/workflows/${wf.file}" target="_blank">View →</a>
        </div>
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════════════════
//  TRIGGER & CANCEL
// ═══════════════════════════════════════════════════
async function triggerWorkflow(file) {
  if (!sessionToken) { toast('⚠️ Not authenticated'); return; }
  try {
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
}

async function cancelWorkflowRun(runId) {
  if (!sessionToken) { toast('⚠️ Not authenticated'); return; }
  if (!confirm('Cancel this workflow run?')) return;
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
}

async function loadRunJobs(runId, container, status) {
  try {
    const data = await apiFetch(`/repos/${OWNER}/${REPO}/actions/runs/${runId}/jobs`);
    const jobs = data.jobs || [];
    let html = '';

    const isRunning = status === 'in_progress' || status === 'queued';
    if (isRunning) {
      html += `<div style="margin-bottom:12px; padding-bottom:12px; border-bottom:1px solid var(--border)">
        <button class="btn danger" onclick="cancelWorkflowRun(${runId})" style="width:100%">⏹ Cancel this run</button>
      </div>`;
    }

    if (!jobs.length) { container.innerHTML = html + '<div class="empty">No jobs found.</div>'; return; }

    html += jobs.map(j => {
      const dur = j.completed_at && j.started_at
        ? Math.round((new Date(j.completed_at) - new Date(j.started_at)) / 1000) : null;
      const durStr = dur !== null ? (dur >= 60 ? `${Math.floor(dur/60)}m ${dur%60}s` : `${dur}s`) : 'running…';
      return `<div class="job-item">
        <div class="job-head">
          <span class="run-dot ${conclusionClass(j.conclusion || j.status)}"></span>
          <span class="job-name">${j.name}</span>
          <span class="status-badge status-${conclusionClass(j.conclusion || j.status)}">${j.conclusion || j.status}</span>
        </div>
        <div class="job-meta">
          <span>⏱ ${durStr}</span>
          <a href="${j.html_url}" target="_blank">View full log →</a>
        </div>
      </div>`;
    }).join('');

    container.innerHTML = html;
  } catch (e) {
    container.innerHTML = `<div class="empty">❌ Failed: ${e.message}</div>`;
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
    let results;

    if (hasRunningWorkflows) {
      // Fast path: single API call for all runs (saves rate limit)
      const data = await apiFetch(`/repos/${OWNER}/${REPO}/actions/runs?per_page=20&status=in_progress`);
      const completedData = await apiFetch(`/repos/${OWNER}/${REPO}/actions/runs?per_page=20`);
      const allRecentRuns = completedData.workflow_runs || [];
      const runningRuns = data.workflow_runs || [];
      // Merge: running first, then recent (dedup by id)
      const seen = new Set();
      const merged = [];
      for (const r of [...runningRuns, ...allRecentRuns]) {
        if (!seen.has(r.id)) { seen.add(r.id); merged.push(r); }
      }
      // Group by workflow
      results = WORKFLOWS.map(wf => ({
        wf,
        runs: merged.filter(r => r.workflow_id === wf.id).slice(0, 10)
      }));
    } else {
      // Normal path: per-workflow fetch
      results = await Promise.all(
        WORKFLOWS.map(wf =>
          apiFetch(`/repos/${OWNER}/${REPO}/actions/workflows/${wf.id}/runs?per_page=10`)
            .then(data => ({ wf, runs: data.workflow_runs || [] }))
            .catch(() => ({ wf, runs: [] }))
        )
      );
    }

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
          <span style="font-weight:500">${r._wf.icon} ${r._wf.name}</span>
          <span class="run-event">${r.event}</span>
          <a href="${r.html_url}" target="_blank" onclick="event.stopPropagation()">#${r.run_number}</a>
          <span class="run-time">${timeAgo(r.created_at)}</span>
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
          <div style="font-size:32px;margin-bottom:var(--sp-3)">⚠️</div>
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
