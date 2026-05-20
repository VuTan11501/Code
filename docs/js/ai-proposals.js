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

    for (const [file, fileProposals] of Object.entries(groups)) {
      try {
        const result = await _applyToFile(file, fileProposals);
        applied += result.applied;
        if (result.errors.length) errors.push(...result.errors);
      } catch (e) {
        errors.push(`${file}: ${e.message || e}`);
      }
    }

    // Clean up applied proposals
    for (const id of selectedIds) _pending.delete(id);

    if (applied > 0) {
      _toast(`✅ Applied ${applied} change${applied > 1 ? 's' : ''}`, '');
      _refreshAffectedUI();
    }
    if (errors.length) {
      _toast(`⚠️ ${errors.length} error(s): ${errors[0]}`, 'error');
    }
  }

  async function _applyToFile(file, proposals, retryCount = 0) {
    if (typeof apiFetch !== 'function') throw new Error('apiFetch not available');

    // Fetch current Gist
    const gist = await apiFetch(`/gists/${GIST_ID}`);
    const gistFile = gist.files && gist.files[file];
    let currentData = [];
    if (gistFile && gistFile.content) {
      try {
        const parsed = JSON.parse(gistFile.content);
        currentData = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.entries) ? parsed.entries : (Array.isArray(parsed.requests) ? parsed.requests : []));
      } catch { currentData = []; }
    }

    const applied = [];
    const applyErrors = [];

    for (const p of proposals) {
      try {
        const before = JSON.parse(JSON.stringify(currentData));
        currentData = _applyDiff(currentData, p);

        // Also apply sub-actions
        if (p.sub_actions) {
          for (const sa of p.sub_actions) {
            currentData = _applyDiff(currentData, sa);
          }
        }

        // Audit log
        if (window.AIAudit) {
          window.AIAudit.log({
            proposal_id: p.proposal_id,
            kind: p.kind,
            target_file: file,
            before_snapshot: before,
            after_snapshot: JSON.parse(JSON.stringify(currentData)),
            applied_at: new Date().toISOString(),
          });
        }
        applied.push(p.proposal_id);
      } catch (e) {
        applyErrors.push(`${p.kind}: ${e.message}`);
      }
    }

    if (!applied.length) return { applied: 0, errors: applyErrors };

    // Determine content format — preserve wrapper if OT file
    let content;
    if (file === 'ot-requests.json') {
      // Rebuild wrapper format
      content = JSON.stringify(currentData, null, 2);
    } else {
      content = JSON.stringify(currentData, null, 2);
    }

    // PATCH Gist
    const token = typeof sessionToken !== 'undefined' ? sessionToken : null;
    if (!token) throw new Error('No session token');

    const patchBody = { files: { [file]: { content } } };
    try {
      const resp = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/vnd.github+json',
        },
        body: JSON.stringify(patchBody),
      });
      if (resp.status === 409 || resp.status === 412) {
        // Conflict — retry once
        if (retryCount < 1) {
          console.log('[proposals] ETag conflict, retrying...');
          return _applyToFile(file, proposals, retryCount + 1);
        }
        throw new Error('Gist conflict after retry');
      }
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`PATCH failed: ${resp.status} ${text.slice(0, 100)}`);
      }
    } catch (e) {
      if (retryCount < 1 && e.message && e.message.includes('conflict')) {
        return _applyToFile(file, proposals, retryCount + 1);
      }
      throw e;
    }

    return { applied: applied.length, errors: applyErrors };
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
            rec.skip_dates = diff.after.skip_dates || rec.skip_dates || [];
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

    try {
      const resp = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/vnd.github+json',
        },
        body: JSON.stringify({ files: { [file]: { content } } }),
      });
      if (!resp.ok) throw new Error(`PATCH failed: ${resp.status}`);
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
