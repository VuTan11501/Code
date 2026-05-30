// ═══════════════════════════════════════════════════
//  AI PROPOSALS — Propose-then-Apply engine for schedule/OT mutations
//  Manages pending proposals, renders confirmation modal, executes atomic PATCH.
// ═══════════════════════════════════════════════════
(function () {
  'use strict';

  const MAX_PROPOSALS_PER_TURN = 5;
  const GIST_ID = typeof window.GIST_ID !== 'undefined' ? window.GIST_ID : 'abc2a47c0a396025a72a6580227ff493';

  const _pending = new Map(); // proposal_id → proposal
  let _turnProposalCount = 0;

  function register(proposal) {
    if (!proposal || !proposal.proposal_id) return null;
    _pending.set(proposal.proposal_id, proposal);
    _turnProposalCount++;
    console.log('[proposals] Registered:', proposal.proposal_id, proposal.kind);
    return proposal.proposal_id;
  }

  function getActive() {
    clearExpired();
    return [..._pending.values()];
  }

  function clearExpired() {
    const now = Date.now();
    for (const [id, p] of _pending) {
      if (p.expires_at && p.expires_at < now) _pending.delete(id);
    }
  }

  function resetTurnCounter() { _turnProposalCount = 0; }
  function getTurnCount() { return _turnProposalCount; }
  function isAtLimit() { return _turnProposalCount >= MAX_PROPOSALS_PER_TURN; }

  function clearAll() { _pending.clear(); _turnProposalCount = 0; }

  // ─── Modal rendering ─────────────────────────────────
  function renderModal(proposalIds) {
    const proposals = proposalIds
      ? proposalIds.map(id => _pending.get(id)).filter(Boolean)
      : getActive();
    if (!proposals.length) return;

    const modal = document.getElementById('aiProposalModal');
    if (!modal) return;

    const body = modal.querySelector('.proposal-modal-body');
    const applyBtn = modal.querySelector('[data-proposal-apply]');
    const countSpan = modal.querySelector('.proposal-apply-count');

    if (body) body.innerHTML = proposals.map((p, i) => _renderProposalItem(p, i)).join('');
    _updateApplyBtn(modal);

    // Event delegation for checkboxes
    if (body) {
      body.addEventListener('change', () => _updateApplyBtn(modal));
    }

    // Show modal
    modal.hidden = false;
    modal.removeAttribute('aria-hidden');
    requestAnimationFrame(() => modal.classList.add('show'));
    if (applyBtn) applyBtn.focus();

    // ESC to close
    modal._escHandler = (e) => { if (e.key === 'Escape') closeModal(); };
    document.addEventListener('keydown', modal._escHandler);
  }

  function _renderProposalItem(p, idx) {
    const hasErrors = p.errors && p.errors.length > 0;
    const hasWarnings = p.warnings && p.warnings.length > 0;
    const checked = !hasErrors ? 'checked' : '';
    const disabled = hasErrors ? 'disabled' : '';

    let diffHtml = '';
    if (p.diff) {
      if (p.diff.before === null || p.diff.before === undefined) {
        // New entry
        diffHtml = `<pre class="diff-block"><span class="diff-add">+ ${_escJson(p.diff.after)}</span></pre>`;
      } else if (p.diff.after === null || p.diff.after === undefined) {
        // Delete
        diffHtml = `<pre class="diff-block"><span class="diff-remove">- ${_escJson(p.diff.before)}</span></pre>`;
      } else {
        // Update — field-level diff
        diffHtml = _renderFieldDiff(p.diff.before, p.diff.after);
      }
    }

    let subActionsHtml = '';
    if (p.sub_actions && p.sub_actions.length) {
      subActionsHtml = `<div class="proposal-sub-actions">
        ${p.sub_actions.map(sa => `<div class="proposal-sub-action">
          <span class="validation-badge warn">↳</span>
          <span>${_esc(sa.summary || sa.kind || 'Sub-action')}</span>
        </div>`).join('')}
      </div>`;
    }

    const validationHtml = _renderValidation(p);

    return `<div class="proposal-item" data-proposal-id="${_esc(p.proposal_id)}">
      <div class="proposal-item-header">
        <label class="proposal-check">
          <input type="checkbox" ${checked} ${disabled} data-proposal-check="${_esc(p.proposal_id)}">
          <span class="proposal-title">${_esc(_proposalTitle(p))}</span>
        </label>
        <span class="proposal-target">${_esc(p.target_file || '')}</span>
      </div>
      ${validationHtml}
      ${diffHtml}
      ${subActionsHtml}
    </div>`;
  }

  function _renderValidation(p) {
    const badges = [];
    if (p.errors && p.errors.length) {
      badges.push(...p.errors.map(e => `<span class="validation-badge err">🚫 ${_esc(e)}</span>`));
    }
    if (p.warnings && p.warnings.length) {
      badges.push(...p.warnings.map(w => `<span class="validation-badge warn">⚠️ ${_esc(w)}</span>`));
    }
    if (!badges.length) {
      badges.push('<span class="validation-badge ok">✓ Valid</span>');
    }
    return `<div class="proposal-validation">${badges.join('')}</div>`;
  }

  function _renderFieldDiff(before, after) {
    if (typeof before !== 'object' || typeof after !== 'object') {
      return `<pre class="diff-block"><span class="diff-remove">- ${_escJson(before)}</span>\n<span class="diff-add">+ ${_escJson(after)}</span></pre>`;
    }
    const allKeys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
    let lines = [];
    for (const k of allKeys) {
      const bv = JSON.stringify(before[k]);
      const av = JSON.stringify(after[k]);
      if (bv === av) {
        lines.push(`  "${k}": ${av}`);
      } else if (bv === undefined) {
        lines.push(`<span class="diff-add">+ "${k}": ${_esc(av)}</span>`);
      } else if (av === undefined) {
        lines.push(`<span class="diff-remove">- "${k}": ${_esc(bv)}</span>`);
      } else {
        lines.push(`<span class="diff-remove">- "${k}": ${_esc(bv)}</span>`);
        lines.push(`<span class="diff-add">+ "${k}": ${_esc(av)}</span>`);
      }
    }
    return `<pre class="diff-block">${lines.join('\n')}</pre>`;
  }

  function _proposalTitle(p) {
    switch (p.kind) {
      case 'create_once': return `Create one-time schedule: ${p.diff?.after?.workflow || ''}`;
      case 'create_recurring': return `Create recurring schedule: ${p.diff?.after?.workflow || ''}`;
      case 'create_ot': return `Create OT request: ${p.diff?.after?.date || ''} ${p.diff?.after?.start || ''}-${p.diff?.after?.end || ''}`;
      case 'update_schedule': return `Update schedule entry`;
      case 'delete_schedule': return `Delete schedule entry`;
      case 'add_skip_date': return `Add skip_date to recurring entry`;
      default: return p.kind || 'Proposal';
    }
  }

  function _updateApplyBtn(modal) {
    const checks = modal.querySelectorAll('[data-proposal-check]:checked:not(:disabled)');
    const btn = modal.querySelector('[data-proposal-apply]');
    const countSpan = modal.querySelector('.proposal-apply-count');
    if (btn) btn.disabled = checks.length === 0;
    if (countSpan) countSpan.textContent = checks.length;
  }

  function closeModal() {
    const modal = document.getElementById('aiProposalModal');
    if (!modal) return;
    modal.classList.remove('show');
    if (modal._escHandler) {
      document.removeEventListener('keydown', modal._escHandler);
      modal._escHandler = null;
    }
    setTimeout(() => {
      modal.hidden = true;
      modal.setAttribute('aria-hidden', 'true');
    }, 250);
    // Return focus
    const convBtn = document.getElementById('aiConvBtn');
    if (convBtn) convBtn.focus();
  }

  // ─── Apply proposals → atomic Gist PATCH ─────────────
  async function applyFromModal() {
    const modal = document.getElementById('aiProposalModal');
    if (!modal) return;
    const checked = [...modal.querySelectorAll('[data-proposal-check]:checked:not(:disabled)')];
    const ids = checked.map(c => c.getAttribute('data-proposal-check'));
    if (!ids.length) return;
    await applyProposals(ids);
    closeModal();
  }

  async function applyProposals(selectedIds) {
    const proposals = selectedIds.map(id => _pending.get(id)).filter(Boolean);
    if (!proposals.length) { _toast('No valid proposals to apply', 'warning'); return; }

    // Group by target_file
    const groups = {};
    for (const p of proposals) {
      const f = p.target_file || 'scheduled-runs.json';
      if (!groups[f]) groups[f] = [];
      groups[f].push(p);
    }

    let applied = 0;
    let errors = [];
    let conflicts = [];

    for (const [file, fileProposals] of Object.entries(groups)) {
      try {
        const result = await _applyToFile(file, fileProposals);
        applied += result.applied;
        if (result.errors.length) errors.push(...result.errors);
        if (result.conflicts && result.conflicts.length) conflicts.push(...result.conflicts);
      } catch (e) {
        errors.push(`${file}: ${e.message || e}`);
      }
    }

    // Only forget proposals that were actually applied or definitively errored;
    // keep conflicted ones in _pending so the user can review and re-submit.
    const conflictedIds = new Set(conflicts.map(c => c.proposal_id));
    for (const id of selectedIds) {
      if (!conflictedIds.has(id)) _pending.delete(id);
    }

    if (applied > 0) {
      _toast(`✅ Applied ${applied} change${applied > 1 ? 's' : ''}`, '');
      _refreshAffectedUI();
    }
    if (conflicts.length) {
      console.warn('[proposals] Skipped due to concurrent edits:', conflicts);
      _toast(
        `⚠️ ${conflicts.length} change(s) skipped — target was modified elsewhere. Review & re-submit.`,
        'warning'
      );
    }
    if (errors.length) {
      _toast(`⚠️ ${errors.length} error(s): ${errors[0]}`, 'error');
    }

    return { applied, errors, conflicts };
  }

  async function _applyToFile(file, proposals, retryCount = 0, baseSnapshot = null) {
    if (typeof apiFetch !== 'function') throw new Error('apiFetch not available');
    const token = typeof sessionToken !== 'undefined' ? sessionToken : null;
    if (!token) throw new Error('No session token');

    // Raw GET so we can capture the ETag for CAS conflict detection.
    // apiFetch caches via in-memory ETag map but doesn't expose the header
    // value, which we need to detect concurrent writes between our GET
    // and PATCH (changed ETag → retry with fresh state + ORIGINAL baseSnapshot).
    const proxyBase = (typeof localStorage !== 'undefined' && localStorage.getItem('wf_dash_gh_proxy_url')) || 'https://api.github.com';
    const getResp = await fetch(`${proxyBase}/gists/${GIST_ID}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
      },
    });
    if (!getResp.ok) throw new Error(`Gist GET failed: ${getResp.status}`);
    const currentEtag = getResp.headers.get('ETag') || getResp.headers.get('etag') || null;
    const gist = await getResp.json();
    const gistFile = gist.files && gist.files[file];
    let currentData = [];
    const gfContent = window.readGistFile ? await window.readGistFile(gistFile) : (gistFile && gistFile.content) || '';
    if (gfContent) {
      try {
        const parsed = JSON.parse(gfContent);
        currentData = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.entries) ? parsed.entries : (Array.isArray(parsed.requests) ? parsed.requests : []));
      } catch { currentData = []; }
    }

    // Snapshot the "base" target state on the FIRST attempt. On retry we keep
    // the original base so 3-way merge can compare base vs new-remote per entry.
    if (baseSnapshot === null) {
      baseSnapshot = JSON.parse(JSON.stringify(currentData));
    }

    const applied = [];
    const applyErrors = [];
    const conflicts = [];
    // Defer audit logging until after a successful PATCH — otherwise we'd
    // record applies that never actually hit the gist.
    const pendingAudit = [];

    for (const p of proposals) {
      try {
        // 3-way merge: skip this proposal if base vs current shows a real
        // conflict on the same target. (No-op on first attempt because
        // baseSnapshot === currentData.)
        const conflict = _detectConflict(p, baseSnapshot, currentData);
        if (conflict) {
          conflicts.push({ proposal_id: p.proposal_id, kind: p.kind, ...conflict });
          continue;
        }
        const before = JSON.parse(JSON.stringify(currentData));
        currentData = _applyDiff(currentData, p);

        // Also apply sub-actions
        if (p.sub_actions) {
          for (const sa of p.sub_actions) {
            currentData = _applyDiff(currentData, sa);
          }
        }
        pendingAudit.push({ p, before });
        applied.push(p.proposal_id);
      } catch (e) {
        applyErrors.push(`${p.kind}: ${e.message}`);
      }
    }

    if (!applied.length) return { applied: 0, errors: applyErrors, conflicts };

    // Determine content format — preserve wrapper if OT file
    let content;
    if (file === 'ot-requests.json') {
      // Rebuild wrapper format
      content = JSON.stringify(currentData, null, 2);
    } else {
      content = JSON.stringify(currentData, null, 2);
    }

    // GitHub now REJECTS If-Match on gist PATCH (HTTP 400 "Conditional request
    // headers are not allowed in unsafe requests"). Emulate CAS instead: re-read
    // the ETag right before PATCH; if it changed since our GET, another writer
    // raced us → retry with the ORIGINAL baseSnapshot so 3-way merge reconciles.
    if (currentEtag && retryCount < 1) {
      try {
        const recheck = await fetch(`${proxyBase}/gists/${GIST_ID}`, {
          headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' },
        });
        const freshEtag = recheck.headers.get('ETag') || recheck.headers.get('etag') || null;
        if (recheck.ok && freshEtag && freshEtag !== currentEtag) {
          console.log('[proposals] ETag changed before PATCH, retrying with 3-way merge...');
          return _applyToFile(file, proposals, retryCount + 1, baseSnapshot);
        }
      } catch (_) { /* best-effort CAS recheck — proceed on failure */ }
    }
    const patchBody = { files: { [file]: { content } } };
    const patchHeaders = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/vnd.github+json',
    };
    let patchResp;
    try {
      patchResp = await fetch(`${proxyBase}/gists/${GIST_ID}`, {
        method: 'PATCH',
        headers: patchHeaders,
        body: JSON.stringify(patchBody),
      });
      if (patchResp.status === 409 || patchResp.status === 412) {
        // Conflict — retry once, carrying the ORIGINAL baseSnapshot so the
        // 3-way merge can detect concurrent edits this time round.
        if (retryCount < 1) {
          console.log('[proposals] ETag conflict (412/409), retrying with 3-way merge...');
          return _applyToFile(file, proposals, retryCount + 1, baseSnapshot);
        }
        throw new Error('Gist conflict after retry');
      }
      if (!patchResp.ok) {
        const text = await patchResp.text().catch(() => '');
        throw new Error(`PATCH failed: ${patchResp.status} ${text.slice(0, 100)}`);
      }
    } catch (e) {
      if (retryCount < 1 && e.message && e.message.includes('conflict')) {
        return _applyToFile(file, proposals, retryCount + 1, baseSnapshot);
      }
      throw e;
    }

    // Audit log — emit only after the PATCH actually succeeded, and stamp the
    // FINAL etag from the successful response so rollback can guard against
    // post-apply concurrent edits.
    const finalEtag = patchResp.headers.get('ETag') || patchResp.headers.get('etag') || null;
    const finalSnapshot = JSON.parse(JSON.stringify(currentData));
    for (const r of pendingAudit) {
      if (window.AIAudit) {
        window.AIAudit.log({
          proposal_id: r.p.proposal_id,
          kind: r.p.kind,
          target_file: file,
          before_snapshot: r.before,
          after_snapshot: finalSnapshot,
          applied_at: new Date().toISOString(),
          gist_etag: finalEtag,
        });
      }
    }

    return { applied: applied.length, errors: applyErrors, conflicts };
  }

  // ─── 3-way merge conflict detection ─────────────────
  // Decides whether a proposal can still be safely applied when the remote
  // state has changed since the proposal was created (base snapshot).
  // The "base" for each proposal is taken from ``proposal.diff.before`` when
  // available — this is the snapshot AT PROPOSAL CREATION TIME, which is what
  // the user actually reviewed in the modal. Falling back to apply-time
  // ``baseEntries`` would miss any drift between proposal create and apply.
  //   • create_* → conflict only on duplicate id (someone else inserted it)
  //   • delete_schedule → conflict if the target was edited remotely since
  //     proposal creation (don't silently delete someone else's update);
  //     no-op if already gone
  //   • update_schedule → per-field merge: conflict only if a field WE touch
  //     was also changed remotely since proposal creation
  //   • add_skip_date → never field-conflicts (skip_dates is union-mergeable in
  //     _applyDiff). Conflict only if target entry was deleted remotely.
  function _detectConflict(proposal, baseEntries, currentEntries) {
    const kind = proposal.kind;
    const diff = proposal.diff;
    if (!diff) return null;
    const baseArr = Array.isArray(baseEntries) ? baseEntries : [];
    const curArr = Array.isArray(currentEntries) ? currentEntries : [];

    if (kind === 'create_once' || kind === 'create_recurring' || kind === 'create_ot') {
      if (diff.after && diff.after.id && curArr.some(e => e && e.id === diff.after.id)) {
        return { reason: 'duplicate_id', target_id: diff.after.id };
      }
      return null;
    }

    const targetId = (diff.before && diff.before.id) || (diff.after && diff.after.id);
    if (!targetId) return null;
    // Prefer the proposal's own ``before`` snapshot (captured at proposal-
    // creation time and shown to the user in the diff modal). Fall back to
    // the apply-time base only if the proposal didn't capture one (legacy).
    const baseEntry = (diff.before && diff.before.id === targetId)
      ? diff.before
      : (baseArr.find(e => e && e.id === targetId) || null);
    const curEntry = curArr.find(e => e && e.id === targetId) || null;

    if (kind === 'delete_schedule') {
      if (!curEntry) return null; // already gone — treat as success
      if (baseEntry && JSON.stringify(baseEntry) !== JSON.stringify(curEntry)) {
        return {
          reason: 'modified_before_delete',
          target_id: targetId,
          base_field: '*',
          current_value: curEntry,
          proposed_value: null,
        };
      }
      return null;
    }

    if (kind === 'update_schedule') {
      if (!curEntry) {
        return { reason: 'target_deleted', target_id: targetId };
      }
      if (!baseEntry) return null;
      const ourChanges = diff.after || {};
      for (const k of Object.keys(ourChanges)) {
        if (k === 'id') continue;
        const baseVal = JSON.stringify(baseEntry[k]);
        const curVal = JSON.stringify(curEntry[k]);
        if (baseVal !== curVal) {
          return {
            reason: 'field_conflict',
            target_id: targetId,
            base_field: k,
            current_value: curEntry[k],
            proposed_value: ourChanges[k],
          };
        }
      }
      return null;
    }

    if (kind === 'add_skip_date') {
      if (!curEntry) return { reason: 'target_deleted', target_id: targetId };
      // skip_dates is union-merged in _applyDiff — concurrent additions are safe.
      return null;
    }

    return null;
  }

  function _applyDiff(data, proposal) {
    const kind = proposal.kind;
    const diff = proposal.diff;
    if (!diff) return data;

    switch (kind) {
      case 'create_once':
      case 'create_recurring':
      case 'create_ot': {
        if (diff.after) data.push(diff.after);
        break;
      }
      case 'delete_schedule': {
        if (diff.before && diff.before.id) {
          data = data.filter(e => e.id !== diff.before.id);
        }
        break;
      }
      case 'update_schedule': {
        if (diff.after && diff.after.id) {
          const idx = data.findIndex(e => e.id === diff.after.id);
          if (idx >= 0) data[idx] = { ...data[idx], ...diff.after };
        }
        break;
      }
      case 'add_skip_date': {
        if (diff.after && diff.after.id) {
          const idx = data.findIndex(e => e.id === diff.after.id);
          if (idx >= 0) {
            const rec = data[idx].recurrence || {};
            // Union-merge so we don't clobber skip_dates that were added
            // concurrently (e.g. another device's add_skip_date for a
            // different date on the same recurring entry).
            const curSkip = Array.isArray(rec.skip_dates) ? rec.skip_dates : [];
            const newSkip = Array.isArray(diff.after.skip_dates) ? diff.after.skip_dates : [];
            rec.skip_dates = Array.from(new Set([...curSkip, ...newSkip])).sort();
            data[idx].recurrence = rec;
          }
        }
        break;
      }
    }
    return data;
  }

  // ─── Rollback ─────────────────────────────────────────
  async function rollbackLast() {
    if (!window.AIAudit) { _toast('Audit module not available', 'error'); return; }
    const last = window.AIAudit.getLast();
    return rollbackEntry(last);
  }

  async function rollbackEntry(entry) {
    if (!entry || !entry.before_snapshot) { _toast('Nothing to undo', 'warning'); return; }
    const ok = await (typeof uiConfirm === 'function'
      ? uiConfirm({ title: 'Hoàn tác apply?', message: `Khôi phục trạng thái trước (${entry.kind}).`, confirmText: 'Hoàn tác', cancelText: 'Hủy', danger: true })
      : Promise.resolve(window.confirm(`Undo apply (${entry.kind})?`)));
    if (!ok) return;

    const file = entry.target_file;
    const content = JSON.stringify(entry.before_snapshot, null, 2);
    const token = typeof sessionToken !== 'undefined' ? sessionToken : null;
    if (!token) { _toast('No session token', 'error'); return; }

    // ─── Safety pre-check: refuse rollback if remote diverged from what we
    // stored at apply time. This guards against silently overwriting edits a
    // user (or autopilot) made on another device after the apply landed.
    // The content-equality check below is the reliable signal. (We no longer
    // send If-Match — GitHub now 400s conditional headers on gist PATCH.)
    if (entry.after_snapshot !== undefined && entry.after_snapshot !== null) {
      try {
        if (typeof apiFetch !== 'function') throw new Error('apiFetch not available');
        const gist = await apiFetch(`/gists/${GIST_ID}`);
        const gf = gist.files && gist.files[file];
        const remoteRaw = window.readGistFile ? await window.readGistFile(gf) : (gf && gf.content) || '';
        let remoteData = [];
        if (remoteRaw) {
          try {
            const parsed = JSON.parse(remoteRaw);
            remoteData = Array.isArray(parsed)
              ? parsed
              : (Array.isArray(parsed.entries) ? parsed.entries
                : (Array.isArray(parsed.requests) ? parsed.requests : []));
          } catch { remoteData = []; }
        }
        if (JSON.stringify(remoteData) !== JSON.stringify(entry.after_snapshot)) {
          _toast(
            '❌ Cannot rollback — file has been modified since the apply was logged. Use manual edit.',
            'error'
          );
          console.warn('[proposals] Rollback blocked: remote state diverged from logged after_snapshot', {
            proposal_id: entry.proposal_id, target_file: file,
          });
          return;
        }
      } catch (e) {
        _toast(`❌ Rollback pre-check failed: ${e.message || e}`, 'error');
        return;
      }
    }

    const headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/vnd.github+json',
    };

    try {
      const resp = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ files: { [file]: { content } } }),
      });
      if (resp.status === 412) {
        _toast(
          '❌ Cannot rollback — file has been modified since the apply was logged. Use manual edit.',
          'error'
        );
        return;
      }
      if (!resp.ok) throw new Error(`PATCH failed: ${resp.status}`);
      // Persist the new etag so a subsequent chained rollback still has a
      // fresh anchor (mainly for the If-Match path; the content-equality
      // check uses after_snapshot which we don't mutate here — chained
      // rollback will simply re-fetch and re-validate).
      const newEtag = resp.headers.get('ETag') || resp.headers.get('etag') || null;
      if (newEtag && window.AIAudit && typeof window.AIAudit.updateEtag === 'function') {
        try { window.AIAudit.updateEtag(entry.proposal_id, newEtag); } catch {}
      }
      _toast('✅ Rolled back successfully', '');
      _refreshAffectedUI();
    } catch (e) {
      _toast(`❌ Rollback failed: ${e.message}`, 'error');
    }
  }

  function _refreshAffectedUI() {
    const fns = ['renderScheduleTable', 'renderScheduleCalendar', 'renderScheduledQueue', 'renderOtList', 'renderOtCalendar', 'renderOtStats', 'renderOtBudget'];
    for (const fn of fns) {
      try { if (typeof window[fn] === 'function') window[fn](); } catch {}
    }
    // Also reload schedule/OT data
    try { if (typeof loadScheduledRuns === 'function') loadScheduledRuns(); } catch {}
    try { if (typeof loadOtData === 'function') loadOtData(); } catch {}
  }

  function _toast(msg, type) {
    if (typeof toast === 'function') toast(msg, type || '');
    else console.log('[proposals]', msg);
  }

  function _esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function _escJson(v) {
    try { return _esc(JSON.stringify(v, null, 2)); }
    catch { return _esc(String(v)); }
  }

  window.AIProposals = {
    _pending,
    register,
    getActive,
    clearExpired,
    clearAll,
    resetTurnCounter,
    getTurnCount,
    isAtLimit,
    renderModal,
    closeModal,
    applyFromModal,
    applyProposals,
    rollbackLast,
    rollbackEntry,
    MAX_PROPOSALS_PER_TURN,
  };
})();
