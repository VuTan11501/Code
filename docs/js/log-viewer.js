/**
 * docs/js/log-viewer.js — shared, page-agnostic workflow-run log viewer.
 *
 * The dashboard page (js/dashboard.js) has long had a rich step-by-step log
 * modal for GitHub Actions runs (per-step expand/collapse, timestamp toggle,
 * copy-full-log, live polling). The Suica generator page previously had only
 * a flat <pre> dump of the last 600 log lines, which made it hard to see
 * which step was running or to debug a specific failure.
 *
 * This module factors the dashboard's renderer into a standalone, reusable
 * widget. Call window.LogViewer.open(...) to show the modal:
 *
 *   window.LogViewer.open({
 *     token: '<GitHub PAT>',
 *     owner: 'VuTan11501',
 *     repo:  'Code',
 *     runId: 12345678,
 *     status: 'in_progress',   // optional; enables live refresh + cancel btn
 *     title: 'Suica PDF run',  // optional
 *   });
 *
 * It owns its own DOM, cache, and polling timers — does NOT depend on
 * dashboard.js, OWNER/REPO globals, sessionToken, apiFetch, etc.
 */
(function () {
  'use strict';

  const API = 'https://api.github.com';

  // ────────────────────────────────────────────────────────────
  // Per-open state. Reset on close().
  // ────────────────────────────────────────────────────────────
  let _ctx = null;                 // { token, owner, repo, runId, status }
  let _runRefreshTimer = null;     // polls /jobs every 5s while run is active
  const _jobLogCache = new Map();  // jobId → { raw, lines, boundaries }
  const _jobStepsMap = new Map();  // jobId → steps[] (latest from API)
  const _stepPollTimers = new Map(); // `${jobId}:${stepNum}` → interval id

  // ────────────────────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function conclusionClass(c) {
    if (c === 'success') return 'success';
    if (c === 'failure' || c === 'cancelled' || c === 'timed_out') return 'failure';
    if (c === 'skipped') return 'skipped';
    if (c === 'in_progress') return 'in_progress';
    if (c === 'queued' || c === 'waiting' || c === 'pending') return 'queued';
    return 'pending';
  }

  // ────────────────────────────────────────────────────────────
  // Log parsing — port of dashboard.js parseJobLog/sliceStepLines
  // ────────────────────────────────────────────────────────────
  function parseJobLog(raw) {
    const cleaned = raw.replace(/\x1b\[[0-9;]*m/g, '');
    const rawLines = cleaned.split(/\r?\n/);
    const lines = rawLines.map(ln => {
      if (!ln) return { ts: '', txt: '' };
      const m = ln.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z) ?(.*)$/);
      return m ? { ts: m[1], txt: m[2] } : { ts: '', txt: ln };
    });
    const boundaries = [];
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

  function sliceStepLines(cache, allSteps, currentStep) {
    if (!cache || !cache.lines) return [];
    const { lines, boundaries } = cache;
    const name = currentStep.name || '';
    const nameLc = name.toLowerCase();
    if (/^set up job$/i.test(name)) {
      const end = boundaries.length ? boundaries[0].index : lines.length;
      return lines.slice(0, end);
    }
    if (/^complete job$/i.test(name)) {
      const ups = boundaries.filter(b => b.kind === 'cleanup');
      if (ups.length) return lines.slice(ups[ups.length - 1].index);
      return [];
    }
    if (/^post\s+/i.test(name)) {
      const suffix = name.replace(/^post\s+/i, '').toLowerCase();
      const posts = boundaries.filter(b => b.kind === 'post');
      let hit = posts.find(b => b.name.toLowerCase().includes(suffix) || suffix.includes(b.name.toLowerCase()));
      if (!hit) {
        const postSteps = allSteps.filter(s => /^post\s+/i.test(s.name) && s.conclusion !== 'skipped');
        const idx = postSteps.findIndex(s => s.number === currentStep.number);
        if (idx >= 0 && idx < posts.length) hit = posts[idx];
      }
      if (!hit) return [];
      const next = boundaries.find(b => b.index > hit.index);
      return lines.slice(hit.index, next ? next.index : lines.length);
    }
    const runs = boundaries.filter(b => b.kind === 'run');
    let hit = runs.find(b => b.name.toLowerCase().includes(nameLc) || nameLc.includes(b.name.toLowerCase()));
    if (!hit) {
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
    const next = boundaries.find(b => b.index > hit.index);
    return lines.slice(hit.index, next ? next.index : lines.length);
  }

  function renderStepLog(body, lines) {
    if (!lines || lines.length === 0) {
      body.innerHTML = '<div class="log-loading">No log output for this step.</div>';
      return;
    }
    const html = ['<div class="scroll-area" data-slot="scroll-area"><div class="scroll-area-viewport" data-slot="scroll-area-viewport"><pre class="log-pre"><code>'];
    for (const ln of lines) {
      const txt = ln.txt;
      if (!txt && !ln.ts) { html.push('\n'); continue; }
      if (/^##\[endgroup\]/.test(txt)) continue;
      let cls = 'log-line';
      let clean = txt;
      if (/^##\[group\]/.test(txt)) { cls += ' log-group'; clean = '▸ ' + txt.replace(/^##\[group\]/, ''); }
      else if (/^##\[error\]/.test(txt)) { cls += ' log-error'; clean = txt.replace(/^##\[error\]/, ''); }
      else if (/^##\[warning\]/.test(txt)) { cls += ' log-warn'; clean = txt.replace(/^##\[warning\]/, ''); }
      else if (/^##\[command\]/.test(txt)) { cls += ' log-cmd'; clean = '$ ' + txt.replace(/^##\[command\]/, ''); }
      else if (/^##\[section\]/.test(txt)) { cls += ' log-group'; clean = txt.replace(/^##\[section\]/, ''); }
      else if (/\b(error|failed|exception|traceback)\b/i.test(txt)) cls += ' log-error';
      else if (/\bwarning\b/i.test(txt)) cls += ' log-warn';
      html.push(`<span class="${cls}">`);
      if (ln.ts) html.push(`<span class="log-ts">${ln.ts.substring(11, 19)}</span> `);
      html.push(esc(clean));
      html.push('</span>\n');
    }
    html.push('</code></pre></div></div>');
    body.innerHTML = html.join('');
    const vp = body.querySelector('.scroll-area-viewport');
    if (vp) vp.scrollTop = vp.scrollHeight;
  }

  // ────────────────────────────────────────────────────────────
  // Job log fetch (paged-once, then cached for the lifetime of the modal)
  // ────────────────────────────────────────────────────────────
  async function ensureJobLogCache(jobId) {
    if (_jobLogCache.has(jobId)) return _jobLogCache.get(jobId);
    try {
      const r = await fetch(`${API}/repos/${_ctx.owner}/${_ctx.repo}/actions/jobs/${jobId}/logs`, {
        headers: { 'Authorization': `Bearer ${_ctx.token}` },
      });
      if (r.status === 404) return { raw: '', lines: [], boundaries: [], notReady: true };
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const raw = await r.text();
      const parsed = parseJobLog(raw);
      _jobLogCache.set(jobId, parsed);
      return parsed;
    } catch (e) {
      return { error: e.message };
    }
  }

  // ────────────────────────────────────────────────────────────
  // Public-via-onclick handlers (registered on window so inline
  // onclick="lvToggleStepLog(this)" attributes work from generated HTML)
  // ────────────────────────────────────────────────────────────
  async function lvToggleStepLog(btn) {
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
      if (cache.error) { body.innerHTML = `<div class="log-loading">❌ ${esc(cache.error)}</div>`; return; }
      const lines = sliceStepLines(cache, allSteps, currentStep);
      renderStepLog(body, lines);
      body.dataset.loaded = '1';
    }

    // Live-poll while step is in progress
    const stepRunning = block.classList.contains('step-in_progress');
    const key = `${jobId}:${stepNum}`;
    if (stepRunning && !_stepPollTimers.has(key)) {
      const t = setInterval(async () => {
        _jobLogCache.delete(jobId);
        const cache = await ensureJobLogCache(jobId);
        if (!cache.error) renderStepLog(body, sliceStepLines(cache, allSteps, currentStep));
      }, 4000);
      _stepPollTimers.set(key, t);
    }
  }

  function lvToggleAllTimestamps(cb, jobId) {
    const list = document.querySelector(`.steps-list[data-job-id="${jobId}"]`);
    if (list) list.classList.toggle('hide-ts', !cb.checked);
  }

  async function lvCopyFullJobLog(btn, jobId) {
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

  async function lvCancelRun() {
    if (!_ctx || !_ctx.runId) return;
    if (!confirm('Cancel this workflow run?')) return;
    try {
      await fetch(`${API}/repos/${_ctx.owner}/${_ctx.repo}/actions/runs/${_ctx.runId}/cancel`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${_ctx.token}`, 'Accept': 'application/vnd.github+json' },
      });
    } catch (_) { /* fire and forget; UI will reflect via next poll */ }
  }

  // ────────────────────────────────────────────────────────────
  // Loader — fetches /runs/:id/jobs and re-renders the step list.
  // While the run is queued/in_progress, polls every 5s.
  // ────────────────────────────────────────────────────────────
  async function loadRunJobs(container) {
    if (!_ctx) return;
    try {
      const r = await fetch(`${API}/repos/${_ctx.owner}/${_ctx.repo}/actions/runs/${_ctx.runId}/jobs`, {
        headers: { 'Authorization': `Bearer ${_ctx.token}`, 'Accept': 'application/vnd.github+json' },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const jobs = data.jobs || [];
      const isRunning = _ctx.status === 'in_progress' || _ctx.status === 'queued';

      let html = '';
      if (isRunning) {
        html += `<div class="logs-cancel-bar">
          <button class="btn danger sm" type="button" onclick="window.lvCancelRun()">⏹ Cancel this run</button>
        </div>`;
      }

      if (!jobs.length) { container.innerHTML = html + '<div class="empty">Waiting for job to start…</div>'; }
      else {
        jobs.forEach(j => {
          const tsId = `ts-${j.id}`;
          const toolbar = `<div class="job-toolbar">
            <button class="btn btn-outline sm" type="button" onclick="window.lvCopyFullJobLog(this, ${j.id})">Copy log</button>
            <div class="shadcn-field">
              <input type="checkbox" id="${tsId}" class="shadcn-checkbox peer" checked onchange="window.lvToggleAllTimestamps(this, ${j.id})">
              <label for="${tsId}" class="shadcn-label">timestamps</label>
            </div>
            <a class="log-external" href="${j.html_url}" target="_blank" rel="noopener">Open on GitHub ↗</a>
          </div>`;
          if (jobs.length > 1) {
            const jCls = conclusionClass(j.conclusion || j.status);
            html += `<div class="job-heading">
              <span class="run-dot ${jCls}"></span>
              <span class="job-name">${esc(j.name)}</span>
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
              <div class="step-block step-${sCls}${hasLog ? '' : ' no-log'}" data-job-id="${j.id}" data-step-num="${stepNum}" data-step-name="${esc(s.name)}" data-started="${s.started_at || ''}" data-completed="${s.completed_at || ''}">
                <button type="button" class="step-row" ${hasLog ? `onclick="window.lvToggleStepLog(this)"` : `disabled aria-disabled="true"`} aria-expanded="false">
                  <span class="step-icon">${icon}</span>
                  <span class="step-name">${esc(s.name)}</span>
                  <span class="step-duration">${sDurStr}</span>
                  ${hasLog ? '<span class="step-chevron" aria-hidden="true">▾</span>' : ''}
                </button>
                ${hasLog ? `<div class="step-log-body" data-loaded="0"></div>` : ''}
              </div>`;
          });
          html += '</div>';
        });
      }

      // Patch DOM in-place: if step structure changed (e.g., step transitioned
      // from queued → in_progress → success), re-render; otherwise leave any
      // expanded step bodies untouched. Simple approach: always re-render but
      // remember which steps were open and re-open them after.
      const openKeys = new Set();
      container.querySelectorAll('.step-block.open').forEach(b => {
        openKeys.add(`${b.dataset.jobId}:${b.dataset.stepNum}`);
      });
      container.innerHTML = html;
      openKeys.forEach(key => {
        const [jid, snum] = key.split(':');
        const block = container.querySelector(`.step-block[data-job-id="${jid}"][data-step-num="${snum}"]`);
        if (block) {
          const btnEl = block.querySelector('.step-row');
          // lvToggleStepLog flips state from closed→open and triggers a fresh
          // render (cache-backed, so cheap). Don't pre-set .open or aria —
          // the toggle handles both.
          if (btnEl) lvToggleStepLog(btnEl);
        }
      });

      // Update overall run status from the jobs list
      const conclusions = jobs.map(j => j.conclusion);
      const allDone = jobs.length > 0 && jobs.every(j => j.status === 'completed');
      if (allDone) _ctx.status = jobs.some(c => c === 'failure') ? 'completed' : 'completed';
      else _ctx.status = jobs.some(j => j.status === 'in_progress') ? 'in_progress' : 'queued';

      const stillRunning = jobs.length === 0 || jobs.some(j => j.status === 'in_progress' || j.status === 'queued');
      if (stillRunning) {
        _runRefreshTimer = setTimeout(() => loadRunJobs(container), 5000);
      }
    } catch (e) {
      container.innerHTML = `<div class="empty">❌ Failed to load jobs: ${esc(e.message)}</div>`;
    }
  }

  // ────────────────────────────────────────────────────────────
  // Modal lifecycle
  // ────────────────────────────────────────────────────────────
  function ensureModal() {
    let modal = document.getElementById('lvLogModal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'lvLogModal';
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal" style="max-width: 1000px; width: 95vw; max-height: 88vh;">
        <div class="modal-header">
          <h3 class="lv-title">Run Logs</h3>
          <button type="button" class="modal-close lv-close" aria-label="Close">×</button>
        </div>
        <div class="modal-body dialog-body" id="lvLogBody" style="overflow:auto;">
          <div class="empty">Loading jobs…</div>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.querySelector('.lv-close').addEventListener('click', close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });
    return modal;
  }

  function open(opts) {
    if (!opts || !opts.token || !opts.owner || !opts.repo || !opts.runId) {
      console.error('[LogViewer.open] missing required fields', opts);
      return;
    }
    // Reset any prior state from a previous open()
    close({ keepModal: true });
    _ctx = {
      token: opts.token, owner: opts.owner, repo: opts.repo,
      runId: opts.runId, status: opts.status || 'in_progress',
    };
    const modal = ensureModal();
    modal.querySelector('.lv-title').textContent = opts.title || 'Run Logs';
    modal.classList.add('open');
    const body = modal.querySelector('#lvLogBody');
    body.innerHTML = '<div class="empty">Loading jobs…</div>';
    loadRunJobs(body);
  }

  function close(opts) {
    const modal = document.getElementById('lvLogModal');
    if (modal && (!opts || !opts.keepModal)) modal.classList.remove('open');
    if (_runRefreshTimer) { clearTimeout(_runRefreshTimer); _runRefreshTimer = null; }
    _stepPollTimers.forEach(t => clearInterval(t));
    _stepPollTimers.clear();
    _jobLogCache.clear();
    _jobStepsMap.clear();
    _ctx = null;
  }

  // Esc to close
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });

  // ────────────────────────────────────────────────────────────
  // Public surface
  // ────────────────────────────────────────────────────────────
  window.LogViewer = { open, close };
  // Inline-onclick bridges (required because we use string template HTML)
  window.lvToggleStepLog = lvToggleStepLog;
  window.lvToggleAllTimestamps = lvToggleAllTimestamps;
  window.lvCopyFullJobLog = lvCopyFullJobLog;
  window.lvCancelRun = lvCancelRun;
})();
