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

// ═══════════════════════════════════════════════════
//  DRAG-AND-DROP CARD ORDER PERSISTENCE
// ═══════════════════════════════════════════════════
const CARD_ORDER_KEY = 'wf_dash_card_order';

function loadCardOrder() {
  try {
    const raw = localStorage.getItem(CARD_ORDER_KEY);
    if (!raw) return null;
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : null;
  } catch { return null; }
}

function saveCardOrder(arr) {
  try { localStorage.setItem(CARD_ORDER_KEY, JSON.stringify(arr)); } catch {}
  if (window.CloudSync) window.CloudSync.markDirty();
}

function clearCardOrder() {
  try { localStorage.removeItem(CARD_ORDER_KEY); } catch {}
  if (window.CloudSync) window.CloudSync.markDirty();
}

function applyCardOrder(workflowList) {
  const saved = loadCardOrder();
  if (!saved || !saved.length) return workflowList;
  const fileSet = new Set(workflowList.map(w => w.file));
  const ordered = [];
  // Known files in saved order
  for (const file of saved) {
    const wf = workflowList.find(w => w.file === file);
    if (wf) ordered.push(wf);
  }
  // Unknown files appended in original order
  for (const wf of workflowList) {
    if (!saved.includes(wf.file)) ordered.push(wf);
  }
  return ordered;
}

// Dashboard workflow visibility — default: 3 core cards only.
// Each user picks which workflows appear via the Customize panel.
const DASH_VISIBLE_CARDS_KEY = 'wf_dash_visible_cards';
const DASH_SHOW_INFRA_KEY = 'wf_dash_show_infra';   // legacy (pre-customize) — read for one-time migration
const DASH_DEFAULT_VISIBLE = ['auto-checkin.yml', 'auto-checkout.yml', 'auto-ot-creator.yml'];

function getVisibleCardSet() {
  try {
    const raw = localStorage.getItem(DASH_VISIBLE_CARDS_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return new Set(arr);
    }
  } catch {}
  // One-time migration from old infra toggle: 'show infra' = all; else defaults.
  try {
    if (localStorage.getItem(DASH_SHOW_INFRA_KEY) === '1') {
      return new Set(WORKFLOWS_ALL.map(w => w.file));
    }
  } catch {}
  return new Set(DASH_DEFAULT_VISIBLE);
}

function saveVisibleCardSet(set) {
  try { localStorage.setItem(DASH_VISIBLE_CARDS_KEY, JSON.stringify([...set])); } catch {}
  if (window.CloudSync) window.CloudSync.markDirty();
}

function hasCustomVisibility() {
  try { return !!localStorage.getItem(DASH_VISIBLE_CARDS_KEY); } catch { return false; }
}

function getDashboardWorkflows() {
  const visible = getVisibleCardSet();
  // Preserve WORKFLOWS_ALL order so toggling visibility doesn't shuffle cards.
  return WORKFLOWS_ALL.filter(w => visible.has(w.file));
}

function toggleCardVisibility(file) {
  const set = getVisibleCardSet();
  const wasHiding = set.has(file);
  if (wasHiding) {
    if (set.size <= 1) {
      if (typeof toast === 'function') toast('At least one workflow must remain visible', 'warning');
      return;
    }
    set.delete(file);
  } else {
    set.add(file);
  }
  saveVisibleCardSet(set);
  renderInfraToggle();
  renderCardPicker();
  const grid = document.getElementById('workflowGrid');
  if (grid) grid.innerHTML = '<div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div>';
  if (typeof refresh === 'function') refresh();
  // Only offer undo when HIDING — adding back is trivial via the same picker.
  if (wasHiding && typeof undoableToast === 'function') {
    const wf = (typeof WORKFLOWS_ALL !== 'undefined') && WORKFLOWS_ALL.find(w => w.file === file);
    const label = wf ? (wf.name || wf.file) : file;
    undoableToast(`Hid "${label}"`, () => {
      const s2 = getVisibleCardSet();
      s2.add(file);
      saveVisibleCardSet(s2);
      renderInfraToggle();
      renderCardPicker();
      if (typeof refresh === 'function') refresh();
    });
  }
}

function resetCardVisibility() {
  // Snapshot for undo
  const prevVisible = (() => { try { return localStorage.getItem(DASH_VISIBLE_CARDS_KEY); } catch { return null; } })();
  const prevInfra = (() => { try { return localStorage.getItem(DASH_SHOW_INFRA_KEY); } catch { return null; } })();
  const prevOrder = (() => { try { return localStorage.getItem(CARD_ORDER_KEY); } catch { return null; } })();
  try { localStorage.removeItem(DASH_VISIBLE_CARDS_KEY); localStorage.removeItem(DASH_SHOW_INFRA_KEY); } catch {}
  if (window.CloudSync) window.CloudSync.markDirty();
  renderInfraToggle();
  renderCardPicker();
  const grid = document.getElementById('workflowGrid');
  if (grid) grid.innerHTML = '<div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div>';
  if (typeof refresh === 'function') refresh();
  if (typeof undoableToast === 'function') {
    undoableToast('Dashboard layout reset', () => {
      try {
        if (prevVisible != null) localStorage.setItem(DASH_VISIBLE_CARDS_KEY, prevVisible);
        if (prevInfra != null) localStorage.setItem(DASH_SHOW_INFRA_KEY, prevInfra);
        if (prevOrder != null) localStorage.setItem(CARD_ORDER_KEY, prevOrder);
      } catch {}
      if (window.CloudSync) window.CloudSync.markDirty();
      renderInfraToggle();
      renderCardPicker();
      if (typeof refresh === 'function') refresh();
    });
  }
}

let _cardPickerOpen = false;

// Called by CloudSync.applyToUI() after a remote pull updates
// wf_dash_card_order or wf_dash_visible_cards. Re-render the toggle
// bar + customize modal, then re-render the grid if dashboard is
// currently visible.
function applyDashboardSettingsFromCloud() {
  try { renderInfraToggle(); } catch {}
  try { if (_cardPickerOpen) renderCardPicker(); } catch {}
  const page = document.getElementById('page-dashboard');
  if (page && page.classList.contains('active') && typeof refresh === 'function') {
    refresh();
  }
}
if (typeof window !== 'undefined') window.applyDashboardSettingsFromCloud = applyDashboardSettingsFromCloud;

function openCardPicker() {
  _cardPickerOpen = true;
  const modal = document.getElementById('dashCustomizeModal');
  if (modal) modal.classList.add('open');
  renderCardPicker();
  renderInfraToggle();
}
function closeCardPicker() {
  _cardPickerOpen = false;
  const modal = document.getElementById('dashCustomizeModal');
  if (modal) modal.classList.remove('open');
  renderInfraToggle();
}
function toggleCardPicker() {
  if (_cardPickerOpen) closeCardPicker(); else openCardPicker();
}

function renderCardPicker() {
  const body = document.getElementById('dashCustomizeBody');
  const footer = document.getElementById('dashCustomizeFooter');
  if (!body || !footer) return;
  const visible = getVisibleCardSet();
  const row = (wf) => {
    const on = visible.has(wf.file);
    return `<label class="card-picker-row${on ? ' on' : ''}">
      <input type="checkbox" ${on ? 'checked' : ''} onchange="toggleCardVisibility('${wf.file}')">
      <span class="card-picker-name">${ICON(wf.iconName || 'play', 14)} ${wf.name}</span>
      <span class="card-picker-file">${wf.file}</span>
    </label>`;
  };
  body.innerHTML = `
    <div class="card-picker-hint text-xs text-muted-foreground" style="margin-bottom:10px;">
      Choose which workflow cards appear on the dashboard. Showing
      <strong>${visible.size}</strong> / ${WORKFLOWS_ALL.length}.
    </div>
    <div class="card-picker-section">
      <div class="card-picker-section-title">Core (${WORKFLOWS.length})</div>
      ${WORKFLOWS.map(row).join('')}
    </div>
    <div class="card-picker-section">
      <div class="card-picker-section-title">Infrastructure (${WORKFLOWS_INFRA.length})</div>
      ${WORKFLOWS_INFRA.map(row).join('')}
    </div>
  `;
  footer.innerHTML = `
    <button class="btn sm btn-outline" onclick="resetCardVisibility()" data-tooltip="Show only Auto Checkin / Checkout / Request OT">${ICON('undo', 12)} Reset to defaults</button>
    <button class="btn sm primary" onclick="closeCardPicker()">Done</button>
  `;
}

// Backdrop click + Esc close — wired once on first script execution.
document.addEventListener('click', (e) => {
  const m = document.getElementById('dashCustomizeModal');
  if (m && m.classList.contains('open') && e.target === m) closeCardPicker();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const m = document.getElementById('dashCustomizeModal');
  if (m && m.classList.contains('open')) closeCardPicker();
});

function renderInfraToggle() {
  const bar = document.getElementById('dashInfraToggleBar');
  if (!bar) return;
  const visibleCount = getVisibleCardSet().size;
  const hasCustomOrder = !!localStorage.getItem(CARD_ORDER_KEY);
  bar.innerHTML = `
    <span class="dash-infra-label">Showing <strong>${visibleCount}</strong> / ${WORKFLOWS_ALL.length} workflows</span>
    ${hasCustomOrder ? `<button class="btn sm btn-outline" onclick="resetCardOrder()" data-tooltip="Restore default card order">${ICON('undo', 12)} Reset order</button>` : ''}
    <button type="button"
            class="btn sm"
            onclick="openCardPicker()"
            data-tooltip="Choose which workflows appear on the dashboard">
      ${ICON('settings', 12)} Customize
    </button>
  `;
}
const RUN_EVENT_MAP = {
  workflow_dispatch:    { short: '▶ Manual',  full: 'Manually triggered (workflow_dispatch)' },
  schedule:             { short: '⏰ Cron',    full: 'Scheduled by cron (schedule)' },
  repository_dispatch:  { short: '📡 API',    full: 'External API call (repository_dispatch)' },
  workflow_run:         { short: '↪ Chained', full: 'Triggered by another workflow (workflow_run)' },
  push:                 { short: '⬆ Push',    full: 'Triggered by git push' },
  pull_request:         { short: '⇄ PR',      full: 'Pull request event' },
  pull_request_target:  { short: '⇄ PR',      full: 'Pull request (target) event' },
  release:              { short: '🚀 Release',full: 'Release event' },
  issues:               { short: '🐛 Issue',  full: 'Issue event' },
  issue_comment:        { short: '💬 Comment',full: 'Issue comment event' },
  check_run:            { short: '✓ Check',   full: 'Check run event' },
  check_suite:          { short: '✓ Suite',   full: 'Check suite event' },
  deployment:           { short: '🚢 Deploy', full: 'Deployment event' },
  deployment_status:    { short: '🚢 Status', full: 'Deployment status event' },
  fork:                 { short: '🍴 Fork',   full: 'Repository forked' },
  create:               { short: '+ Create',  full: 'Branch/tag created' },
  delete:               { short: '✕ Delete',  full: 'Branch/tag deleted' },
  page_build:           { short: '📄 Pages',  full: 'GitHub Pages build' },
  status:               { short: '● Status',  full: 'Commit status event' },
  dynamic:              { short: '⚡ Dynamic',full: 'Dynamic (computed at runtime)' },
};
function formatRunEvent(ev) {
  if (!ev) return '';
  const m = RUN_EVENT_MAP[ev];
  if (m) return `<span class="run-event" data-tooltip="${m.full}">${m.short}</span>`;
  // Fallback: prettify unknown event by replacing underscores and capitalizing.
  const pretty = ev.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  return `<span class="run-event" data-tooltip="${ev}">${pretty}</span>`;
}

function resetCardOrder() {
  clearCardOrder();
  renderInfraToggle();
  if (typeof refresh === 'function') refresh();
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
function statusBadge(runs, wf) {
  if (!runs.length) return '<span class="status-badge status-skipped">No runs</span>';
  const last = runs[0];
  const isHeartbeat = wf && wf.file === 'scheduled-dispatch.yml';
  if (last.status === 'in_progress' || last.status === 'queued') {
    if (isHeartbeat) {
      return '<span class="status-badge status-beating"><span class="heart-beat">♥</span> Beating</span>';
    }
    return '<span class="status-badge status-running">● Running</span>';
  }
  if (last.conclusion === 'success') {
    if (isHeartbeat) return '<span class="status-badge status-success"><span class="heart-idle">♥</span> Alive</span>';
    return '<span class="status-badge status-success">✓ Success</span>';
  }
  if (last.conclusion === 'failure')
    return '<span class="status-badge status-failure">✗ Failed</span>';
  if (last.conclusion === 'cancelled')
    return '<span class="status-badge status-skipped">⊘ Cancelled</span>';
  if (last.conclusion === 'skipped')
    return '<span class="status-badge status-skipped">↷ Skipped</span>';
  if (last.conclusion === 'neutral')
    return '<span class="status-badge status-skipped">◐ Neutral</span>';
  if (last.conclusion === 'timed_out')
    return '<span class="status-badge status-failure">⏱ Timed out</span>';
  if (last.conclusion === 'action_required')
    return '<span class="status-badge status-failure">! Action required</span>';
  if (last.conclusion === 'startup_failure')
    return '<span class="status-badge status-failure">✗ Startup failed</span>';
  // Fallback: prefer status over null conclusion.
  const label = last.conclusion || last.status || 'pending';
  return `<span class="status-badge status-skipped">${label.charAt(0).toUpperCase() + label.slice(1).replace(/_/g, ' ')}</span>`;
}

function successRate(runs) {
  const completed = runs.filter(r => r.status === 'completed');
  if (!completed.length) return '—';
  const success = completed.filter(r => r.conclusion === 'success').length;
  return `${Math.round(success / completed.length * 100)}%`;
}

function renderWorkflowCard(wf, runs) {
  const lastRuns = runs.slice(0, 2);
  return `
    <div class="card workflow-card" draggable="true" data-wf-file="${wf.file}">
      <span class="workflow-drag-handle">${ICON('moreVertical', 14)}</span>
      <div class="card-header">
        <h2>${ICON(wf.iconName || 'play', 16)} ${wf.name}</h2>
        ${statusBadge(runs, wf)}
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
          ${lastRuns.map((r, i) => {
            const title = r.display_title || r.name || `Run #${r.run_number}`;
            const titleEsc = title.replace(/"/g, '&quot;');
            return `
            <li class="run-item" onclick="openLogModal(${r.id}, '${wf.icon} ${wf.name} #${r.run_number}', '${r.status}')">
              <span class="run-dot ${conclusionClass(r.conclusion || r.status)}"></span>
              <span class="run-name" data-tooltip="${titleEsc}" data-tooltip-truncate-only tabindex="0">${title}</span>
              <span class="run-meta">
                ${formatRunEvent(r.event)}
                <a class="run-num" href="${r.html_url}" target="_blank" onclick="event.stopPropagation()">#${r.run_number}</a>
                <span class="run-time">${timeAgo(r.created_at)}</span>
              </span>
            </li>
          `;}).join('')}
          ${lastRuns.length === 0 ? '<li class="run-item run-item-empty">No runs yet</li>' : ''}
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

  // 🛡️ Confirm popup for kintai triggers — checkin/checkout records the
  // CURRENT time on DokoKin, so an accidental click at 2am gets logged as
  // a 2am checkin and requires manual deletion. Always confirm with the
  // exact JST time being recorded.
  if (file === 'auto-checkin.yml' || file === 'auto-checkout.yml') {
    const isCheckin = file === 'auto-checkin.yml';
    const nowFmt = new Date().toLocaleString('ja-JP', {
      timeZone: 'Asia/Tokyo', weekday: 'short',
      month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
    // Soft warn outside normal kintai hours (JST). Office hours roughly
    // 07:00-11:00 for checkin, 17:00-23:00 for checkout.
    const jstHour = parseInt(new Date().toLocaleString('en-US', {
      timeZone: 'Asia/Tokyo', hour: '2-digit', hour12: false,
    }), 10);
    const offHours = isCheckin
      ? (jstHour < 6 || jstHour > 11)
      : (jstHour < 16 || jstHour > 23);
    const action = isCheckin ? 'CHECKIN' : 'CHECKOUT';
    const emoji = isCheckin ? '📥' : '📤';
    const message =
      `${emoji} Sẽ ghi nhận ${action} lúc:\n\n` +
      `🕐 ${nowFmt} JST\n` +
      `📍 Office (GPS mặc định)\n\n` +
      (offHours
        ? `⚠️ Đang ngoài giờ làm việc — hãy chắc chắn đây là điều bạn muốn (record sai sẽ phải xoá thủ công trên DokoKin).\n\n`
        : ``) +
      `Tiếp tục?`;
    const ok = await uiConfirm({
      title: `Xác nhận ${action}`,
      message,
      confirmText: isCheckin ? '📥 Checkin' : '📤 Checkout',
      cancelText: 'Huỷ',
      danger: offHours,
    });
    if (!ok) return;
  }

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
    //
    // 401 workaround: fetch follows the 302 and Chrome forwards our
    // `Authorization: Bearer <gh_token>` to Azure Blob, which rejects it (401).
    // If the final response.url is NOT api.github.com, the API itself succeeded
    // and we just hit the blob-storage auth bounce → retry the blob URL with no
    // Authorization header (the presigned URL embeds its own SAS in the query).
    let r = await fetch(`${API}/repos/${OWNER}/${REPO}/actions/jobs/${jobId}/logs`, {
      headers: { 'Authorization': `Bearer ${sessionToken}` }
    });
    if (r.status === 401 && r.url && !/api\.github\.com/.test(r.url)) {
      r = await fetch(r.url); // re-fetch blob URL sans Authorization
    }
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
    const activeWorkflows = applyCardOrder(getDashboardWorkflows());
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
            ${formatRunEvent(r.event)}
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

// ═══════════════════════════════════════════════════
//  DRAG-AND-DROP REORDERING (HTML5 DnD, delegated)
// ═══════════════════════════════════════════════════
(function initDragDrop() {
  let dragSrcFile = null;
  let currentOverCard = null;
  let _dragGhost = null;
  // rAF-throttle dragover hit-testing to avoid layout thrashing on every
  // mousemove (browsers fire dragover ~60-120 Hz which used to cause the
  // visible lag while dragging).
  let pendingOverTarget = null;
  let rafScheduled = false;

  function nearestCard(el) {
    return el ? el.closest('.workflow-card') : null;
  }

  function processPendingOver() {
    rafScheduled = false;
    const card = pendingOverTarget;
    pendingOverTarget = null;
    if (!card || card.dataset.wfFile === dragSrcFile) {
      if (currentOverCard) { currentOverCard.classList.remove('drag-over'); currentOverCard = null; }
      return;
    }
    if (card !== currentOverCard) {
      if (currentOverCard) currentOverCard.classList.remove('drag-over');
      card.classList.add('drag-over');
      currentOverCard = card;
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const grid = document.getElementById('workflowGrid');
    if (!grid) return;

    grid.addEventListener('dragstart', (e) => {
      const card = nearestCard(e.target);
      if (!card) return;
      dragSrcFile = card.dataset.wfFile;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragSrcFile);
      // Create an off-screen CLONE for the drag image. If we pass the
      // real card to setDragImage, browsers visually keep the card at
      // its original screen position throughout the drag and only
      // release it on the next frame after drop — which surfaces as a
      // "1s lag before the card snaps to the new spot". A clone leaves
      // the real DOM node free to be reordered the instant drop fires.
      try {
        const rect = card.getBoundingClientRect();
        const clone = card.cloneNode(true);
        clone.style.position = 'absolute';
        clone.style.top = '-10000px';
        clone.style.left = '-10000px';
        clone.style.width = rect.width + 'px';
        clone.style.pointerEvents = 'none';
        clone.classList.remove('dragging');
        document.body.appendChild(clone);
        _dragGhost = clone;
        e.dataTransfer.setDragImage(clone, e.clientX - rect.left, e.clientY - rect.top);
      } catch {}
      // Apply .dragging on the next frame so the captured drag-image
      // clone above doesn't include our outline/shadow styles.
      requestAnimationFrame(() => card.classList.add('dragging'));
    });

    grid.addEventListener('dragend', (e) => {
      const card = nearestCard(e.target);
      if (card) card.classList.remove('dragging');
      // Defensive: clear any leftover .dragging in case dragend target shifted
      grid.querySelectorAll('.workflow-card.dragging').forEach(c => c.classList.remove('dragging'));
      if (currentOverCard) currentOverCard.classList.remove('drag-over');
      if (_dragGhost) { try { _dragGhost.remove(); } catch {} _dragGhost = null; }
      dragSrcFile = null;
      currentOverCard = null;
      pendingOverTarget = null;
    });

    grid.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      pendingOverTarget = nearestCard(e.target);
      if (!rafScheduled) {
        rafScheduled = true;
        requestAnimationFrame(processPendingOver);
      }
    });

    grid.addEventListener('dragleave', (e) => {
      const card = nearestCard(e.target);
      if (card && card === currentOverCard) {
        const rect = card.getBoundingClientRect();
        if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
          card.classList.remove('drag-over');
          currentOverCard = null;
        }
      }
    });

    grid.addEventListener('drop', (e) => {
      e.preventDefault();
      const srcFile = e.dataTransfer.getData('text/plain');
      const targetCard = nearestCard(e.target);
      if (!targetCard) return;
      const targetFile = targetCard.dataset.wfFile;
      if (!srcFile || !targetFile || srcFile === targetFile) return;

      // Compute new order using full list
      const baseline = applyCardOrder(WORKFLOWS_ALL.slice());
      const srcIdx = baseline.findIndex(w => w.file === srcFile);
      if (srcIdx === -1) return;
      const item = baseline.splice(srcIdx, 1)[0];
      const targetIdx = baseline.findIndex(w => w.file === targetFile);
      if (targetIdx === -1) return;
      baseline.splice(targetIdx, 0, item);

      saveCardOrder(baseline.map(w => w.file));

      // Reorder existing DOM nodes in-place instead of triggering a full
      // refresh() (which would re-fetch GitHub API for every workflow —
      // the main cause of perceived lag after a drop). The cards already
      // hold their own runs state; just move them.
      const srcEl = grid.querySelector(`.workflow-card[data-wf-file="${srcFile}"]`);
      const targetEl = grid.querySelector(`.workflow-card[data-wf-file="${targetFile}"]`);
      if (srcEl && targetEl && srcEl !== targetEl) {
        // Insert src BEFORE target when dropping onto a card earlier in
        // the list, AFTER when dropping onto one later — matches the
        // splice logic above.
        const srcPos = Array.from(grid.children).indexOf(srcEl);
        const targetPos = Array.from(grid.children).indexOf(targetEl);
        if (srcPos < targetPos) targetEl.after(srcEl);
        else                    targetEl.before(srcEl);
      }
      renderInfraToggle();
    });
  });
})();