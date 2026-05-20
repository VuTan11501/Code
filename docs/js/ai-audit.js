// ═══════════════════════════════════════════════════
//  AI AUDIT — Ring-buffer audit log for applied proposals
//  Storage: localStorage 'ai_audit_v1' (max 100 entries, FIFO)
// ═══════════════════════════════════════════════════
(function () {
  'use strict';

  const LS_KEY = 'ai_audit_v1';
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
    // Ring buffer: drop oldest if exceeds max
    while (entries.length > MAX_ENTRIES) entries.shift();
    _save(entries);
    console.log('[audit] Logged:', record.kind, record.proposal_id);
  }

  function getRecent(n = 10) {
    const entries = _load();
    return entries.slice(-n);
  }

  function getLast() {
    const entries = _load();
    return entries.length ? entries[entries.length - 1] : null;
  }

  function clearAll() {
    try { localStorage.removeItem(LS_KEY); } catch {}
    console.log('[audit] Cleared all entries');
  }

  // Optional Gist sync (exposed API; UI wiring deferred)
  function enableSync(enabled) {
    try { localStorage.setItem('ai_audit_sync_enabled', enabled ? '1' : '0'); } catch {}
  }

  function isSyncEnabled() {
    return localStorage.getItem('ai_audit_sync_enabled') === '1';
  }

  window.AIAudit = { log, getRecent, getLast, clearAll, enableSync, isSyncEnabled };
})();
