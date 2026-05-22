// ═══════════════════════════════════════════════════
//  SETTINGS PAGE
// ═══════════════════════════════════════════════════
let settingsInitialized = false;
const VAULT_META_KEY = 'wf_dash_vault_meta';
let cachedGithubUser = null;

function initSettingsPage() {
  settingsInitialized = true;
  renderVaultInfo();
  loadTokenStatus();
  renderCloudSyncStatus();
  renderBiometricStatus();
  renderThemeStatus();
  renderAiAuditStatus();
  renderProxyStatus();
}

// ─────────────────────────────────────────────────────────────
// GitHub API Worker proxy — settings UI handlers
// ─────────────────────────────────────────────────────────────
const PROXY_URL_KEY = 'wf_dash_gh_proxy_url';

function _getProxyUrl() {
  try { return (localStorage.getItem(PROXY_URL_KEY) || '').trim(); } catch { return ''; }
}

function renderProxyStatus() {
  const host = document.getElementById('proxyStatus');
  const input = document.getElementById('proxyUrlInput');
  if (!host) return;
  const url = _getProxyUrl();
  if (input && !input.value) input.value = url;
  if (url) {
    host.innerHTML = `<div>✅ <strong>Active</strong> — using proxy at <code>${escapeHtml(url)}</code></div>
      <div style="margin-top:4px;opacity:0.8">PAT is server-side. Authorization header is stripped from outgoing requests.</div>`;
  } else {
    host.innerHTML = `<div>⚪ <strong>Direct API</strong> — calls go straight to <code>api.github.com</code> with your PAT in headers.</div>
      <div style="margin-top:4px;opacity:0.8">Paste a Worker URL below to harden security.</div>`;
  }
}

async function testProxy() {
  const input = document.getElementById('proxyUrlInput');
  const btn = document.getElementById('proxyTestBtn');
  const url = (input?.value || '').trim().replace(/\/+$/, '');
  if (!url) { toast('⚠️ Nhập Worker URL trước', 'warning'); return; }
  if (!/^https:\/\//.test(url)) { toast('⚠️ URL phải bắt đầu bằng https://', 'warning'); return; }
  if (btn) { btn.disabled = true; btn.textContent = 'Testing...'; }
  try {
    // 1. /__health — no auth, just reachability + CORS
    const h = await fetch(`${url}/__health`, { method: 'GET' });
    if (!h.ok) throw new Error(`/__health → ${h.status}`);
    const htxt = (await h.text()).trim();
    if (htxt !== 'ok') throw new Error(`/__health body unexpected: ${htxt.slice(0, 40)}`);
    // 2. /user — exercises PAT injection
    const u = await fetch(`${url}/user`, { method: 'GET' });
    if (!u.ok) throw new Error(`/user → ${u.status} (PAT secret missing on Worker?)`);
    const me = await u.json();
    toast(`✅ OK — Worker reachable, PAT valid (login: ${me.login})`, 'success');
  } catch (e) {
    toast(`❌ Test failed: ${e.message}`, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<span data-icon="activity" data-size="14"></span> Test'; if (window.refreshIcons) window.refreshIcons(); }
  }
}

function saveProxyUrl() {
  const input = document.getElementById('proxyUrlInput');
  const url = (input?.value || '').trim().replace(/\/+$/, '');
  if (url && !/^https:\/\//.test(url)) { toast('⚠️ URL phải bắt đầu bằng https://', 'warning'); return; }
  try {
    if (url) localStorage.setItem(PROXY_URL_KEY, url);
    else localStorage.removeItem(PROXY_URL_KEY);
  } catch (e) {
    toast('⚠️ Không lưu được: ' + e.message, 'error'); return;
  }
  renderProxyStatus();
  toast('✅ Saved. Reload page (F5) để áp dụng cho tất cả tab.', 'success');
}

function clearProxyUrl() {
  const input = document.getElementById('proxyUrlInput');
  if (input) input.value = '';
  try { localStorage.removeItem(PROXY_URL_KEY); } catch {}
  renderProxyStatus();
  toast('Proxy disabled. Reload to apply.', 'info');
}

function renderAiAuditStatus() {
  const host = document.getElementById('aiAuditStatus');
  const toggle = document.getElementById('aiAuditSyncToggle');
  if (!host || !window.AIAudit) return;
  const entries = window.AIAudit.getAll ? window.AIAudit.getAll() : [];
  const last = window.AIAudit.getLast ? window.AIAudit.getLast() : null;
  const synced = window.AIAudit.isSyncEnabled();
  const ownerKnown = typeof window.AIAudit.isOwnerSync === 'function' ? window.AIAudit.isOwnerSync() : null;
  const isOwner = ownerKnown === true;
  if (toggle) {
    toggle.classList.toggle('active', !!synced && isOwner);
    toggle.setAttribute('aria-checked', String(!!synced && isOwner));
    if (ownerKnown === false) {
      toggle.setAttribute('disabled', 'disabled');
      toggle.classList.add('is-disabled');
      toggle.title = 'PAT của bạn không sở hữu Gist này → sync bị tắt (chỉ owner mới ghi được).';
    } else {
      toggle.removeAttribute('disabled');
      toggle.classList.remove('is-disabled');
      toggle.title = '';
    }
  }
  const lastFmt = last && last.applied_at
    ? new Date(last.applied_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
    : '—';
  let syncLine;
  if (ownerKnown === false) {
    syncLine = '🔒 Local-only — bạn không sở hữu Gist này (other-user mode).';
  } else if (ownerKnown === null) {
    syncLine = synced ? '⏳ Kiểm tra quyền sở hữu Gist...' : '⚪ Local-only';
  } else {
    syncLine = synced ? '✅ Enabled — new applies pushed to Gist' : '⚪ Local-only';
  }
  host.innerHTML = `
    <div><strong>Entries</strong>: ${entries.length} / 100</div>
    <div><strong>Last apply</strong>: ${last ? `<code>${escapeHtml(last.kind)}</code> on <code>${escapeHtml(last.target_file || '')}</code> at ${escapeHtml(lastFmt)}` : '—'}</div>
    <div><strong>Sync</strong>: ${syncLine}</div>
  `;
  // Kick off async ownership probe + re-render once known.
  if (ownerKnown === null && typeof window.AIAudit._isCurrentUserGistOwner === 'function') {
    window.AIAudit._isCurrentUserGistOwner().then(() => renderAiAuditStatus()).catch(() => {});
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function toggleAiAuditSync(enabled) {
  if (!window.AIAudit) return;
  // Block opt-in for non-owners — push would silently 404 against owner's gist.
  if (enabled && typeof window.AIAudit.isOwnerSync === 'function' && window.AIAudit.isOwnerSync() === false) {
    if (typeof toast === 'function') toast('PAT không sở hữu Gist này → sync không khả dụng', 'warning');
    return;
  }
  window.AIAudit.enableSync(!!enabled);
  renderAiAuditStatus();
  if (typeof toast === 'function') toast(enabled ? 'Audit sync enabled' : 'Audit sync disabled');
}

async function clearAiAudit() {
  if (!window.AIAudit) return;
  const ok = await (typeof uiConfirm === 'function'
    ? uiConfirm({
        title: 'Xoá audit log?',
        message: 'Xoá toàn bộ audit entries dưới máy này. Bản sao trên cloud (nếu có) vẫn được giữ. Hành động này không hoàn tác được.',
        confirmText: 'Xoá hết',
        cancelText: 'Hủy',
        danger: true,
      })
    : Promise.resolve(window.confirm('Clear ALL local audit entries?')));
  if (!ok) return;
  window.AIAudit.clearAll();
  renderAiAuditStatus();
  renderAiAuditModalBody();
  if (typeof toast === 'function') toast('Audit log cleared');
}

// ────────────────────────────────────────────────────────
// AI Audit History modal
// ────────────────────────────────────────────────────────
function _fmtAuditTime(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return `${Math.floor(diff)}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', hour12: false });
  } catch { return iso; }
}

function _auditKindBadge(kind) {
  const map = {
    create_schedule_once: { label: 'Create once', tone: 'success' },
    create_schedule_recurring: { label: 'Create recurring', tone: 'success' },
    create_ot_request: { label: 'Create OT', tone: 'success' },
    update_schedule: { label: 'Update', tone: 'warning' },
    delete_schedule: { label: 'Delete', tone: 'danger' },
    add_skip_date: { label: 'Skip date', tone: 'info' },
  };
  const m = map[kind] || { label: kind || 'unknown', tone: 'muted' };
  return `<span class="audit-kind-badge audit-kind-${m.tone}">${escapeHtml(m.label)}</span>`;
}

function renderAiAuditModalBody() {
  const body = document.getElementById('aiAuditModalBody');
  const sub = document.getElementById('aiAuditModalSub');
  if (!body || !window.AIAudit) return;
  const entries = (window.AIAudit.getAll() || []).slice().reverse(); // newest first
  if (sub) sub.textContent = `${entries.length} entries · stored locally (max 100)`;
  if (!entries.length) {
    body.innerHTML = `<div class="audit-empty"><span data-icon="history" data-size="24"></span><p>Chưa có apply nào được ghi.</p><p class="text-xs text-muted-foreground">Mỗi lần AI apply 1 proposal sẽ tự lưu vào đây.</p></div>`;
    if (typeof renderIcons === 'function') renderIcons(body);
    return;
  }
  const hasRollback = !!(window.AIProposals && window.AIProposals.rollbackEntry);
  body.innerHTML = entries.map((e) => {
    const canUndo = hasRollback && !!e.before_snapshot;
    const targetLine = e.target_file ? `<code>${escapeHtml(e.target_file)}</code>` : '<span class="text-muted-foreground">—</span>';
    return `
      <div class="audit-entry">
        <div class="audit-entry-head">
          <div class="audit-entry-meta">
            ${_auditKindBadge(e.kind)}
            <span class="audit-entry-time" title="${escapeHtml(e.applied_at || '')}">${escapeHtml(_fmtAuditTime(e.applied_at))}</span>
          </div>
          <button type="button" class="btn btn-ghost sm" data-audit-undo="${escapeHtml(e.proposal_id)}" ${canUndo ? '' : 'disabled'} title="${canUndo ? 'Hoàn tác apply này' : 'Không có before-snapshot'}">
            <span data-icon="undo" data-size="13"></span> Undo
          </button>
        </div>
        <div class="audit-entry-target">${targetLine}</div>
        <div class="audit-entry-id text-xs text-muted-foreground">id: <code>${escapeHtml(e.proposal_id)}</code>${e.conv_id ? ` · conv: <code>${escapeHtml(e.conv_id.slice(0, 8))}</code>` : ''}</div>
      </div>`;
  }).join('');
  if (typeof renderIcons === 'function') renderIcons(body);
}

function openAiAuditModal() {
  const m = document.getElementById('aiAuditModal');
  if (!m) return;
  renderAiAuditModalBody();
  m.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeAiAuditModal() {
  const m = document.getElementById('aiAuditModal');
  if (!m) return;
  m.classList.remove('open');
  document.body.style.overflow = '';
}

// Wire close + undo + ESC
document.addEventListener('DOMContentLoaded', () => {
  const m = document.getElementById('aiAuditModal');
  if (!m) return;
  m.addEventListener('click', async (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    if (t === m || t.closest('[data-audit-close]')) { closeAiAuditModal(); return; }
    const undoBtn = t.closest('[data-audit-undo]');
    if (undoBtn) {
      const pid = undoBtn.getAttribute('data-audit-undo');
      const entry = window.AIAudit && window.AIAudit.getByProposalId ? window.AIAudit.getByProposalId(pid) : null;
      if (!entry || !window.AIProposals || !window.AIProposals.rollbackEntry) {
        if (typeof toast === 'function') toast('Cannot rollback', 'error');
        return;
      }
      undoBtn.disabled = true;
      try {
        await window.AIProposals.rollbackEntry(entry);
      } finally {
        renderAiAuditModalBody();
        renderAiAuditStatus();
      }
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && m.classList.contains('open')) closeAiAuditModal();
  });
});

window.openAiAuditModal = openAiAuditModal;
window.closeAiAuditModal = closeAiAuditModal;

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function setTheme(mode) {
  if (!window.Theme) return;
  window.Theme.set(mode);
  renderThemeStatus();
}

function renderThemeStatus() {
  if (!window.Theme) return;
  const mode = window.Theme.getMode();
  const sys = window.Theme.systemPref();
  document.querySelectorAll('#themeSwitcher [data-theme-opt]').forEach(btn => {
    btn.classList.toggle('is-active', btn.getAttribute('data-theme-opt') === mode);
    btn.setAttribute('aria-checked', String(btn.getAttribute('data-theme-opt') === mode));
  });
  const help = document.getElementById('themeHelp');
  if (help) {
    help.textContent = mode === 'auto'
      ? `Currently following your system (${sys}). Will switch automatically when the OS theme changes.`
      : `Forced to ${mode} on every device that pulls this setting.`;
  }
}

async function renderBiometricStatus() {
  const card = document.getElementById('biometricCard');
  const host = document.getElementById('biometricStatus');
  if (!host || !window.Biometric) return;
  // PWA-only: hide entire card outside installed app
  if (!window.Biometric.isPwa()) {
    if (card) card.style.display = 'none';
    return;
  }
  if (card) card.style.display = '';
  const enrollBtn = document.getElementById('biometricEnrollBtn');
  const disableBtn = document.getElementById('biometricDisableBtn');
  const wa = window.Biometric.isWebAuthnSupported();
  const platAvail = wa ? await window.Biometric.isPlatformAuthenticatorAvailable() : false;
  const enabled = window.Biometric.isEnabled();
  const tier = window.Biometric.tier();
  let html = '';
  if (!wa) {
    html = '<div class="text-warning">❌ WebAuthn not supported in this browser</div>';
    if (enrollBtn) enrollBtn.style.display = 'none';
  } else if (!platAvail) {
    html = '<div class="text-warning">⚠️ Platform authenticator (Face ID / Touch ID / Windows Hello) not available</div>';
    if (enrollBtn) enrollBtn.style.display = 'none';
  } else if (enabled) {
    const tierLabel = tier === 'prf' ? '🔐 Tier 1 — PRF (crypto-bound to biometric)' : '🔓 Tier 2 — Gate (biometric required, key local)';
    html = `<div class="text-success">✅ Enabled on this device</div><div>${tierLabel}</div>`;
    if (enrollBtn) enrollBtn.style.display = 'none';
    if (disableBtn) disableBtn.style.display = 'inline-flex';
  } else {
    html = '<div>Not enrolled on this device. Click Enable to register.</div>';
    if (enrollBtn) enrollBtn.style.display = 'inline-flex';
    if (disableBtn) disableBtn.style.display = 'none';
  }
  host.innerHTML = html;
}

// ═══════════════════════════════════════════════════
//  CROSS-DEVICE SYNC PANEL
// ═══════════════════════════════════════════════════
function renderCloudSyncStatus() {
  const host = document.getElementById('cloudSyncStatus');
  if (!host || !window.CloudSync) return;
  const reg = window.CloudSync.listRegistered();
  const lastPull = window.CloudSync.lastSyncedAt();
  const lastPush = window.CloudSync.lastPushedAt();
  const dev = window.CloudSync.deviceId();
  const tsRaw = localStorage.getItem('wf_dash_settings_updated_at') || '';
  host.innerHTML = `
    <div><strong>This device:</strong> <code>${dev}</code></div>
    <div><strong>Synced keys:</strong> ${reg.map(r => r.label).join(' · ')}</div>
    <div><strong>Last pulled:</strong> ${lastPull ? fmtDateTime(lastPull.toISOString()) : '— (auto on next focus)'}</div>
    <div><strong>Last pushed:</strong> ${lastPush ? fmtDateTime(lastPush.toISOString()) : '—'}</div>
    <div><strong>Cloud updated at:</strong> ${tsRaw ? fmtDateTime(tsRaw) : '—'}</div>
  `;
}

async function cloudSyncPullNow(ev) {
  if (!window.CloudSync) return;
  const btn = ev && ev.currentTarget;
  const orig = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `${ICON('refresh', 14, 'animate-spin')} Pulling…`;
  }
  toast('Pulling settings from cloud…');
  try {
    const r = await window.CloudSync.pull({ force: true });
    if (r.error) toast('❌ Pull failed: ' + r.error, 'error');
    else if (r.applied) toast(`✅ Synced ${r.applied} settings from ${r.from}`);
    else if (r.empty) toast('☁️ No remote settings yet — push first to seed');
    else toast('✓ Already up to date');
    if (typeof window.CloudSync?.applyToUI === 'function') window.CloudSync.applyToUI();
    renderCloudSyncStatus();
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = orig; }
  }
}

async function cloudSyncPushNow(ev) {
  if (!window.CloudSync) return;
  const btn = ev && ev.currentTarget;
  const orig = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `${ICON('refresh', 14, 'animate-spin')} Pushing…`;
  }
  toast('Pushing settings to cloud…');
  try {
    const r = await window.CloudSync.push();
    if (r.error) toast('❌ Push failed: ' + r.error, 'error');
    else if (r.ok) toast('✅ Settings pushed to cloud');
    else if (r.skipped === 'empty') toast('⚠️ Nothing to push (no settings yet)', 'warning');
    renderCloudSyncStatus();
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = orig; }
  }
}

// Auto-refresh status panel when settings page is visited
window.addEventListener('cloudsync:applied', renderCloudSyncStatus);
window.addEventListener('cloudsync:pushed',  renderCloudSyncStatus);

// ═══════════════════════════════════════════════════
//  VAULT INFO (current vault details)
// ═══════════════════════════════════════════════════
function getVaultMeta() {
  try { return JSON.parse(localStorage.getItem(VAULT_META_KEY) || '{}'); }
  catch { return {}; }
}
function saveVaultMeta(patch) {
  const current = getVaultMeta();
  localStorage.setItem(VAULT_META_KEY, JSON.stringify({ ...current, ...patch }));
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
}

async function fetchGithubUser() {
  if (!sessionToken) return null;
  if (cachedGithubUser) return cachedGithubUser;
  try {
    const r = await fetch('https://api.github.com/user', {
      headers: { 'Authorization': `Bearer ${sessionToken}`, 'Accept': 'application/vnd.github+json' }
    });
    if (!r.ok) return null;
    cachedGithubUser = await r.json();
    return cachedGithubUser;
  } catch { return null; }
}

async function renderVaultInfo() {
  const body = document.getElementById('vaultInfoBody');
  if (!body) return;
  const delBtn = document.getElementById('vaultDeleteBtn');
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) {
    body.innerHTML = `<div class="text-muted-foreground">No vault loaded yet. Set up a passphrase on the Setup tab.</div>`;
    if (delBtn) delBtn.style.display = 'none';
    return;
  }
  if (delBtn) delBtn.style.display = '';
  const meta = getVaultMeta();
  const sizeKb = (new Blob([stored]).size / 1024).toFixed(1);

  // ── Source line: GitHub user (if unlocked) or "Locked" ──
  let sourceLine;
  if (sessionToken) {
    const user = await fetchGithubUser();
    sourceLine = user
      ? `<span class="text-foreground font-medium">@${user.login}</span> <span class="text-muted-foreground">· ${user.name || 'GitHub user'}</span>`
      : `<span class="text-foreground font-medium">Unlocked</span> <span class="text-muted-foreground">· (couldn't fetch user)</span>`;
  } else {
    sourceLine = `<span class="text-foreground font-medium">Locked</span> <span class="text-muted-foreground">· unlock to see GitHub account</span>`;
  }

  // ── Meta rows ──
  const rows = [];
  rows.push(`<div class="flex items-center gap-1.5"><span class="text-muted-foreground">Account:</span> ${sourceLine}</div>`);
  rows.push(`<div class="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-muted-foreground mt-1">
    <span>Size <span class="text-foreground font-mono">${sizeKb} KB</span></span>
    ${meta.imported ? `<span>· Imported <span class="text-foreground">${fmtDateTime(meta.imported)}</span></span>` : ''}
    ${meta.source_exported ? `<span>· Source exported <span class="text-foreground">${fmtDateTime(meta.source_exported)}</span></span>` : ''}
    ${meta.last_exported ? `<span>· Last export <span class="text-foreground">${fmtDateTime(meta.last_exported)}</span></span>` : ''}
  </div>`);

  body.innerHTML = rows.join('');
}

// ═══════════════════════════════════════════════════
//  CHANGE PASSPHRASE
// ═══════════════════════════════════════════════════
async function changePassphrase() {
  const oldPass = document.getElementById('cpOldPass').value;
  const newPass = document.getElementById('cpNewPass').value;
  const confirmPass = document.getElementById('cpConfirmPass').value;
  const errEl = document.getElementById('cpError');
  errEl.style.display = 'none';

  if (!oldPass) { errEl.textContent = 'Current passphrase required'; errEl.style.display = 'block'; return; }
  if (newPass.length < 6) { errEl.textContent = 'New passphrase must be 6+ chars'; errEl.style.display = 'block'; return; }
  if (newPass !== confirmPass) { errEl.textContent = 'Passphrases do not match'; errEl.style.display = 'block'; return; }

  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) { errEl.textContent = 'No vault found'; errEl.style.display = 'block'; return; }

  try {
    const token = await decryptToken(stored, oldPass);
    const reEncrypted = await encryptToken(token, newPass);
    localStorage.setItem(STORAGE_KEY, reEncrypted);
    document.getElementById('cpOldPass').value = '';
    document.getElementById('cpNewPass').value = '';
    document.getElementById('cpConfirmPass').value = '';
    toast('✅ Passphrase changed');
  } catch {
    errEl.textContent = 'Wrong current passphrase';
    errEl.style.display = 'block';
  }
}

// ═══════════════════════════════════════════════════
//  EXPORT / IMPORT VAULT
// ═══════════════════════════════════════════════════
function exportVault() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) { toast('⚠️ No vault to export'); return; }
  const exportedAt = new Date().toISOString();
  const payload = JSON.stringify({ version: 1, vault: stored, exported: exportedAt }, null, 2);
  const blob = new Blob([payload], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `wf-dash-vault-${new Date().toISOString().slice(0,10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  saveVaultMeta({ last_exported: exportedAt });
  renderVaultInfo();
  toast('📥 Vault exported');
}

function importVault(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const data = JSON.parse(e.target.result);
      if (!data.vault || typeof data.vault !== 'string') throw new Error('Invalid vault file');
      Uint8Array.from(atob(data.vault), c => c.charCodeAt(0));
      localStorage.setItem(STORAGE_KEY, data.vault);
      saveVaultMeta({
        imported: new Date().toISOString(),
        source_exported: data.exported || null,
        source_filename: file.name,
        last_exported: null,
      });
      cachedGithubUser = null; // force re-fetch after unlock
      renderVaultInfo();
      toast('📤 Vault imported! Lock and re-unlock to use.');
      lock();
    } catch (err) {
      toast(`❌ Import failed: ${err.message}`);
    }
  };
  reader.readAsText(file);
  event.target.value = '';
}


// ═══════════════════════════════════════════════════
//  AZURE AD TOKEN STATUS + RE-AUTH
// ═══════════════════════════════════════════════════
const TOKEN_STATUS_FILE = 'token-status.json';
const REAUTH_STATUS_FILE = 'reauth-status.json';
let azureReauthPollTimer = null;

function _fmtJST(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
      timeZone: 'Asia/Tokyo'
    }) + ' JST';
  } catch { return iso; }
}

function _fmtRelative(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const abs = Math.abs(diff);
  const m = Math.floor(abs / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  let s;
  if (d > 0) s = `${d}d`;
  else if (h > 0) s = `${h}h ${m % 60}m`;
  else s = `${m}m`;
  return diff >= 0 ? `${s} ago` : `in ${s}`;
}

async function loadTokenStatus() {
  const box = document.getElementById('azureTokenBox');
  if (!box) return;
  if (!sessionToken) {
    box.innerHTML = '<div class="text-muted-foreground">Unlock vault first to load token status.</div>';
    return;
  }
  box.innerHTML = '<div class="text-muted-foreground">Loading…</div>';
  try {
    const r = await fetch(`${API}/gists/${GIST_ID}`, {
      headers: { 'Authorization': `Bearer ${sessionToken}`, 'Accept': 'application/vnd.github+json' }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const gist = await r.json();
    const file = (gist.files || {})[TOKEN_STATUS_FILE];
    if (!file || !file.content) {
      box.innerHTML = `
        <div class="text-muted-foreground">No status yet. Click "Check now" to run the monitor.</div>`;
      return;
    }
    const s = JSON.parse(file.content);
    renderTokenStatus(s);
  } catch (e) {
    box.innerHTML = `<div class="text-red-400">Failed to load: ${e.message}</div>`;
  }
}

function renderTokenStatus(s) {
  const box = document.getElementById('azureTokenBox');
  if (!box) return;
  const statusColors = {
    healthy: { dot: '#22c55e', label: 'Healthy', cls: 'text-green-400' },
    expired: { dot: '#ef4444', label: 'Expired', cls: 'text-red-400' },
    revoked: { dot: '#ef4444', label: 'Revoked', cls: 'text-red-400' },
    missing: { dot: '#eab308', label: 'Not configured', cls: 'text-yellow-400' },
    error:   { dot: '#ef4444', label: 'Error', cls: 'text-red-400' },
  };
  const stat = statusColors[s.status] || statusColors.error;
  const user = s.user || {};
  const userLine = user.name || user.email
    ? `<div><span class="text-muted-foreground">User:</span> <strong>${esc(user.name || '—')}</strong>${user.email ? ` <span class="text-muted-foreground">&lt;${esc(user.email)}&gt;</span>` : ''}</div>`
    : '';
  const errLine = s.error
    ? `<div class="text-red-400 text-xs mt-1">⚠️ ${esc(s.error)}</div>`
    : '';
  const expiry = s.access_token_expires_at;
  const rotated = s.last_rotation_at;
  box.innerHTML = `
    <div class="flex items-center gap-2">
      <span style="width:8px;height:8px;border-radius:50%;background:${stat.dot};display:inline-block;"></span>
      <strong class="${stat.cls}">${stat.label}</strong>
      <span class="text-muted-foreground ml-auto text-xs">checked ${_fmtRelative(s.checked_at)}</span>
    </div>
    ${userLine}
    <div><span class="text-muted-foreground">Access token expires:</span> ${_fmtJST(expiry)} ${expiry ? `<span class="text-muted-foreground">(${_fmtRelative(expiry)})</span>` : ''}</div>
    <div><span class="text-muted-foreground">Last token rotation:</span> ${rotated ? `${_fmtJST(rotated)} <span class="text-muted-foreground">(${_fmtRelative(rotated)})</span>` : 'never (still original)'}</div>
    ${errLine}
  `;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

async function triggerTokenCheck() {
  if (!sessionToken) { toast('🔒 Unlock vault first'); return; }
  const btn = document.getElementById('btnCheckToken');
  if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
  try {
    const r = await fetch(`${API}/repos/${OWNER}/${REPO}/actions/workflows/token-monitor.yml/dispatches`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${sessionToken}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'main' })
    });
    if (r.status !== 204) {
      const txt = await r.text();
      throw new Error(`HTTP ${r.status}: ${txt.slice(0,120)}`);
    }
    toast('✅ Token check dispatched. Status will refresh in ~30s.');
    setTimeout(loadTokenStatus, 30000);
    setTimeout(loadTokenStatus, 60000);
  } catch (e) {
    toast(`❌ Dispatch failed: ${e.message}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<span data-icon="refresh" data-size="14"></span> Check now';
      if (typeof renderIcons === 'function') renderIcons();
    }
  }
}

// ─── Device-code re-auth flow ───────────────────────────────
function openAzureReauthModal() {
  const m = document.getElementById('azureReauthModal');
  if (m) m.classList.add('open');
}
function closeAzureReauthModal() {
  const m = document.getElementById('azureReauthModal');
  if (m) m.classList.remove('open');
  if (azureReauthPollTimer) { clearInterval(azureReauthPollTimer); azureReauthPollTimer = null; }
}

async function startAzureReauth() {
  if (!sessionToken) { toast('🔒 Unlock vault first'); return; }

  // Check for existing in-flight session first — avoid spawning duplicate runs
  let existing = null;
  try {
    const gr = await fetch(`${API}/gists/${GIST_ID}?_=${Date.now()}`, {
      headers: { 'Authorization': `Bearer ${sessionToken}`, 'Accept': 'application/vnd.github+json' }
    });
    if (gr.ok) {
      const g = await gr.json();
      const f = (g.files || {})[REAUTH_STATUS_FILE];
      if (f && f.content) {
        const s = JSON.parse(f.content);
        if (s.state === 'waiting_code' && s.expires_at && new Date(s.expires_at).getTime() > Date.now()) {
          existing = s;
        }
      }
    }
  } catch {}

  if (existing) {
    const reuse = await uiConfirm({
      title: 'Re-auth already in progress',
      message: `An active sign-in is waiting (code ${existing.user_code}, expires ${new Date(existing.expires_at).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}).\n\nResume that session?`,
      confirmText: 'Resume',
      cancelText: 'Cancel',
    });
    if (!reuse) return;
    openAzureReauthModal();
    renderReauthState(existing);
    _startReauthPolling();
    return;
  }

  if (!await uiConfirm({
    title: 'Start re-authentication?',
    message: 'A workflow will run a device-code login. You will see a code to enter on microsoft.com/devicelogin from any device.',
    confirmText: 'Start',
  })) return;

  openAzureReauthModal();
  const body = document.getElementById('azureReauthBody');
  body.innerHTML = '<div class="text-sm text-muted-foreground p-4 text-center">Starting workflow…</div>';
  try {
    const r = await fetch(`${API}/repos/${OWNER}/${REPO}/actions/workflows/azure-reauth.yml/dispatches`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${sessionToken}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'main' })
    });
    if (r.status !== 204) throw new Error(`HTTP ${r.status}`);
    body.innerHTML = `
      <div class="text-sm text-muted-foreground p-4 text-center">
        <div class="mb-2">⏳ Workflow dispatched. Waiting for device code…</div>
        <div class="text-xs opacity-60">This usually takes 20–40 seconds (Actions cold start).</div>
      </div>`;
    _startReauthPolling();
  } catch (e) {
    body.innerHTML = `<div class="text-red-400 p-4 text-center">❌ ${e.message}</div>`;
  }
}

function _startReauthPolling() {
  if (azureReauthPollTimer) { clearInterval(azureReauthPollTimer); }
  let lastState = null;
  let lastCode = null;
  azureReauthPollTimer = setInterval(async () => {
    try {
      const gr = await fetch(`${API}/gists/${GIST_ID}?_=${Date.now()}`, {
        headers: { 'Authorization': `Bearer ${sessionToken}`, 'Accept': 'application/vnd.github+json' }
      });
      if (!gr.ok) return;
      const g = await gr.json();
      const f = (g.files || {})[REAUTH_STATUS_FILE];
      if (!f || !f.content) return;
      const s = JSON.parse(f.content);
      // Only re-render when state OR code changes (avoids flicker on countdown)
      if (s.state === lastState && s.user_code === lastCode) return;
      lastState = s.state;
      lastCode = s.user_code;
      renderReauthState(s);
      if (['success', 'error', 'expired'].includes(s.state)) {
        clearInterval(azureReauthPollTimer);
        azureReauthPollTimer = null;
        if (s.state === 'success') {
          toast('✅ Re-authenticated. Refreshing status…');
          setTimeout(loadTokenStatus, 5000);
        }
      }
    } catch {}
  }, 3000);
}

function renderReauthState(s) {
  const body = document.getElementById('azureReauthBody');
  if (!body) return;
  if (s.state === 'waiting_code') {
    const expiresMs = s.expires_at ? new Date(s.expires_at).getTime() - Date.now() : 0;
    const mins = Math.max(0, Math.floor(expiresMs / 60000));
    body.innerHTML = `
      <div class="p-4 text-center">
        <div class="text-xs text-muted-foreground mb-2">1. Open this URL on any device:</div>
        <a href="${esc(s.verification_uri)}" target="_blank" rel="noopener" class="text-blue-400 underline text-sm break-all">${esc(s.verification_uri)}</a>
        <div class="text-xs text-muted-foreground mt-4 mb-2">2. Enter this code:</div>
        <div class="font-mono text-3xl font-bold tracking-wider my-3 select-all" style="letter-spacing:0.2em;">${esc(s.user_code)}</div>
        <button class="btn btn-outline sm" onclick="navigator.clipboard.writeText('${esc(s.user_code)}').then(()=>toast('Copied'))">
          <span data-icon="copy" data-size="14"></span> Copy code
        </button>
        <div class="text-xs text-muted-foreground mt-4">3. Sign in with Microsoft → grant DokoKin access.</div>
        <div class="text-xs text-muted-foreground mt-2 opacity-70">Code expires in ~${mins} min. This modal will auto-update.</div>
      </div>`;
    if (typeof renderIcons === 'function') renderIcons();
  } else if (s.state === 'success') {
    body.innerHTML = `
      <div class="p-6 text-center">
        <div class="text-4xl mb-2">✅</div>
        <div class="text-base font-medium text-green-400 mb-2">Re-authentication successful</div>
        <div class="text-xs text-muted-foreground mb-4">${esc(s.message || 'Token has been updated.')}</div>
        <button class="btn primary sm" onclick="closeAzureReauthModal()">Close</button>
      </div>`;
  } else if (s.state === 'expired') {
    body.innerHTML = `
      <div class="p-6 text-center">
        <div class="text-4xl mb-2">⏰</div>
        <div class="text-base font-medium text-yellow-400 mb-2">Code expired</div>
        <div class="text-xs text-muted-foreground mb-4">You did not complete sign-in in time.</div>
        <button class="btn primary sm" onclick="closeAzureReauthModal();startAzureReauth()">Try again</button>
      </div>`;
  } else if (s.state === 'error') {
    body.innerHTML = `
      <div class="p-6 text-center">
        <div class="text-4xl mb-2">❌</div>
        <div class="text-base font-medium text-red-400 mb-2">Re-auth failed</div>
        <div class="text-xs text-muted-foreground mb-4 break-words">${esc(s.message || 'Unknown error')}</div>
        <button class="btn sm" onclick="closeAzureReauthModal()">Close</button>
      </div>`;
  }
}
