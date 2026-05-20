// ═══════════════════════════════════════════════════
//  AI AUDIT — Ring-buffer audit log for applied proposals
//  Storage: localStorage 'ai_audit_v1' (max 100 entries, FIFO)
//  Optional sync: append-only push to Gist 'ai-audit.json'
// ═══════════════════════════════════════════════════
(function () {
  'use strict';

  const LS_KEY = 'ai_audit_v1';
  const LS_SYNC_KEY = 'ai_audit_sync_enabled';
  const GIST_ID = (typeof window !== 'undefined' && window.GIST_ID) || 'abc2a47c0a396025a72a6580227ff493';
  const GIST_FILE = 'ai-audit.json';
  const MAX_ENTRIES = 100;

  function _load() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }

  function _save(entries) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(entries)); } catch {}
  }

  function log(entry) {
    if (!entry || !entry.proposal_id) return;
    const record = {
      proposal_id: entry.proposal_id,
      kind: entry.kind || 'unknown',
      target_file: entry.target_file || '',
      before_snapshot: entry.before_snapshot || null,
      after_snapshot: entry.after_snapshot || null,
      applied_at: entry.applied_at || new Date().toISOString(),
      conv_id: entry.conv_id || null,
    };
    const entries = _load();
    entries.push(record);
    while (entries.length > MAX_ENTRIES) entries.shift();
    _save(entries);
    console.log('[audit] Logged:', record.kind, record.proposal_id);
    // Fire-and-forget Gist sync if enabled
    if (isSyncEnabled()) {
      _syncToGist(record).catch(e => console.warn('[audit] sync failed', e));
    }
  }

  function getAll() { return _load(); }
  function getRecent(n = 10) {
    const entries = _load();
    return entries.slice(-n);
  }
  function getLast() {
    const entries = _load();
    return entries.length ? entries[entries.length - 1] : null;
  }
  function getByProposalId(pid) {
    return _load().find(e => e.proposal_id === pid) || null;
  }

  function clearAll() {
    try { localStorage.removeItem(LS_KEY); } catch {}
    console.log('[audit] Cleared all entries');
  }

  function enableSync(enabled) {
    try { localStorage.setItem(LS_SYNC_KEY, enabled ? '1' : '0'); } catch {}
  }
  function isSyncEnabled() {
    return localStorage.getItem(LS_SYNC_KEY) === '1';
  }

  async function _syncToGist(record) {
    const token = (typeof sessionToken !== 'undefined' && sessionToken) ? sessionToken : null;
    if (!token) return;
    // Read current cloud audit (tolerate 404 / missing file)
    let cloud = [];
    try {
      const r = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' },
      });
      if (r.ok) {
        const g = await r.json();
        const f = g.files && g.files[GIST_FILE];
        if (f && f.content) { try { cloud = JSON.parse(f.content); } catch {} }
      }
    } catch {}
    if (!Array.isArray(cloud)) cloud = [];
    // De-dupe by proposal_id
    if (!cloud.some(e => e && e.proposal_id === record.proposal_id)) {
      cloud.push(record);
      while (cloud.length > MAX_ENTRIES) cloud.shift();
    }
    await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github+json',
      },
      body: JSON.stringify({ files: { [GIST_FILE]: { content: JSON.stringify(cloud, null, 2) } } }),
    });
  }

  window.AIAudit = { log, getAll, getRecent, getLast, getByProposalId, clearAll, enableSync, isSyncEnabled };
})();
