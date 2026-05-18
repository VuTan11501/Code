// ═══════════════════════════════════════════════════
//  SETTINGS PAGE
// ═══════════════════════════════════════════════════
let settingsInitialized = false;

function initSettingsPage() {
  settingsInitialized = true;
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
  const payload = JSON.stringify({ version: 1, vault: stored, exported: new Date().toISOString() }, null, 2);
  const blob = new Blob([payload], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `wf-dash-vault-${new Date().toISOString().slice(0,10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
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
      toast('📤 Vault imported! Lock and re-unlock to use.');
      lock();
    } catch (err) {
      toast(`❌ Import failed: ${err.message}`);
    }
  };
  reader.readAsText(file);
  event.target.value = '';
}
