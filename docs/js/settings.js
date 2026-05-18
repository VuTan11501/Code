// ═══════════════════════════════════════════════════
//  SETTINGS PAGE
// ═══════════════════════════════════════════════════
let settingsInitialized = false;
const VAULT_META_KEY = 'wf_dash_vault_meta';
let cachedGithubUser = null;

function initSettingsPage() {
  settingsInitialized = true;
  renderVaultInfo();
}

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
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) {
    body.innerHTML = `<div class="text-muted-foreground">No vault loaded yet. Set up a passphrase on the Setup tab.</div>`;
    return;
  }
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
