import { describe, it, expect } from 'vitest';
import {
  resolveWinningRule,
  shouldSwitchByCooldown,
  validateProfileBundle,
  activateProfileTx,
  activate,
  appendSwitchAudit,
  localStore,
  computeAutoSwitchDecision,
  fillProfileOptions,
  loadState,
} from '../../docs/js/profile-switch.js';

// Minimal in-memory localStorage shim so activate() (which uses the
// real localStorage-backed `localStore`) is exercisable in node/vitest.
// Node 24+ ships a built-in `localStorage` but it lacks `.clear()`, so we
// always install our own deterministic shim for tests.
{
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
    clear: () => { mem.clear(); },
    key: (i) => Array.from(mem.keys())[i] ?? null,
    get length() { return mem.size; },
  };
}

function makeMockStore(initial = {}) {
  const data = { ...initial };
  return {
    get: (k) => data[k],
    set: (k, v) => { data[k] = v; },
    _data: data,
  };
}

describe('ProfileSwitch core', () => {
  it('picks specific rule over default rule', () => {
    const rules = [
      { id: 'default', priority: 1, profile_id: 'home' },
      { id: 'weekday-9', priority: 10, weekdays: [1,2,3,4,5], start: '09:00', end: '18:00', profile_id: 'office' },
    ];
    const winner = resolveWinningRule(rules, { dow: 2, hhmm: '10:00' });
    expect(winner?.id).toBe('weekday-9');
  });

  it('enforces 60s cooldown', () => {
    expect(shouldSwitchByCooldown(100000, 100030, 60)).toBe(false);
    expect(shouldSwitchByCooldown(100000, 100060, 60)).toBe(true); // exact boundary
    expect(shouldSwitchByCooldown(100000, 100061, 60)).toBe(true);
  });

  it('breaks priority ties by updated_at recency', () => {
    const rules = [
      { id: 'older', priority: 5, profile_id: 'a', updated_at: '2026-06-01T00:00:00Z' },
      { id: 'newer', priority: 5, profile_id: 'b', updated_at: '2026-06-15T00:00:00Z' },
    ];
    const winner = resolveWinningRule(rules, { dow: 2, hhmm: '10:00' });
    expect(winner?.id).toBe('newer');
  });

  it('rejects missing schedule_set_id', () => {
    const result = validateProfileBundle({ id: 'p1', refs: { location_key: 'office' } });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/schedule_set_id/i);
  });

  it('rolls back pointer when apply fails', async () => {
    const s = makeMockStore({ active_profile: 'p-old' });
    const apply = () => { throw new Error('write failed'); };
    const r = await activateProfileTx({ store: s, next: 'p-new', applyRefs: apply });
    expect(r.ok).toBe(false);
    expect(s.get('active_profile')).toBe('p-old');
  });

  it('commits pointer when apply succeeds', async () => {
    const s = makeMockStore({ active_profile: 'p-old' });
    const r = await activateProfileTx({ store: s, next: 'p-new', applyRefs: async () => {} });
    expect(r.ok).toBe(true);
    expect(r.prev).toBe('p-old');
    expect(r.next).toBe('p-new');
    expect(s.get('active_profile')).toBe('p-new');
  });

  it('activate() persists pointer + audits when refs apply cleanly', async () => {
    localStorage.clear();
    localStorage.setItem('wf_dash_active_profile', 'p-old');
    // No defs registered → applyProfileRefs is a no-op so refs succeed.
    const tx = await activate('p-new', { source: 'manual' });
    expect(tx.ok).toBe(true);
    expect(tx.prev).toBe('p-old');
    expect(tx.next).toBe('p-new');
    expect(localStore.get('active_profile')).toBe('p-new');
    const audit = JSON.parse(localStorage.getItem('wf_dash_profile_audit') || '[]');
    const last = audit[audit.length - 1];
    expect(last.source).toBe('manual');
    expect(last.from).toBe('p-old');
    expect(last.to).toBe('p-new');
    expect(last.ok).toBe(true);
  });

  it('activate() throws + rolls back + audits failure when defs registry rejects id', async () => {
    localStorage.clear();
    localStorage.setItem('wf_dash_active_profile', 'p-old');
    localStorage.setItem('wf_dash_profile_defs', JSON.stringify([{ id: 'p-known' }]));
    await expect(activate('p-unknown', { source: 'manual' })).rejects.toThrow(/Profile switch failed/);
    expect(localStore.get('active_profile')).toBe('p-old');
    const audit = JSON.parse(localStorage.getItem('wf_dash_profile_audit') || '[]');
    const last = audit[audit.length - 1];
    expect(last.ok).toBe(false);
    expect(last.from).toBe('p-old');
    expect(last.to).toBe('p-unknown');
  });

  it('activateProfileTx rollback does NOT clobber a newer successful switch (CAS)', async () => {
    // Race: tx A starts (prev='p-old', next='p-A'), then tx B commits
    // ('p-B'), then tx A's applyRefs throws. CAS guard must see the
    // pointer is no longer 'p-A' and leave 'p-B' intact.
    const s = makeMockStore({ active_profile: 'p-old' });
    let releaseA;
    const aBlocker = new Promise((res) => { releaseA = res; });

    const txA = activateProfileTx({
      store: s,
      next: 'p-A',
      applyRefs: async () => {
        await aBlocker;
        throw new Error('A failed');
      },
    });

    // Allow A to write its pointer (synchronous set inside tx, but the
    // await aBlocker yields control). Microtask flush:
    await Promise.resolve();
    expect(s.get('active_profile')).toBe('p-A');

    // B runs to completion while A is still paused.
    const txB = await activateProfileTx({
      store: s,
      next: 'p-B',
      applyRefs: async () => {},
    });
    expect(txB.ok).toBe(true);
    expect(s.get('active_profile')).toBe('p-B');

    // Now let A fail. With CAS, A must NOT roll back to 'p-old' because
    // current pointer ('p-B') is not its own next.
    releaseA();
    const rA = await txA;
    expect(rA.ok).toBe(false);
    expect(s.get('active_profile')).toBe('p-B'); // winner preserved
  });

  it('activateProfileTx token-rollback survives concurrent tx with SAME next id', async () => {
    // Same-id race: A starts (prev='p-old', next='p-X'), B then writes
    // 'p-X' too and commits, A throws. A bare value-CAS would see
    // pointer === next === 'p-X' and false-roll-back to 'p-old',
    // destroying B's commit. Token CAS must protect against this.
    const s = makeMockStore({ active_profile: 'p-old' });
    let releaseA;
    const aBlocker = new Promise((res) => { releaseA = res; });

    const txA = activateProfileTx({
      store: s,
      next: 'p-X',
      applyRefs: async () => {
        await aBlocker;
        throw new Error('A failed');
      },
    });

    await Promise.resolve();
    expect(s.get('active_profile')).toBe('p-X');

    // B writes the SAME profile id and commits cleanly.
    const txB = await activateProfileTx({
      store: s,
      next: 'p-X',
      applyRefs: async () => {},
    });
    expect(txB.ok).toBe(true);
    expect(s.get('active_profile')).toBe('p-X');
    const tokenAfterB = s.get('active_profile_token');

    // A fails. Token mismatch ⇒ no rollback.
    releaseA();
    const rA = await txA;
    expect(rA.ok).toBe(false);
    expect(s.get('active_profile')).toBe('p-X'); // NOT rolled back to 'p-old'
    expect(s.get('active_profile_token')).toBe(tokenAfterB); // B's token intact
  });

  it('does not switch when cooldown not elapsed', async () => {
    const res = computeAutoSwitchDecision({
      currentProfile: 'p1',
      winner: { profile_id: 'p2' },
      lastSwitchEpochSec: 2000,
      nowEpochSec: 2050,
      cooldownSec: 60,
    });
    expect(res.shouldSwitch).toBe(false);
    expect(res.reason).toBe('cooldown');
  });

  it('switches when winner differs and cooldown elapsed', async () => {
    const res = computeAutoSwitchDecision({
      currentProfile: 'p1',
      winner: { profile_id: 'p2' },
      lastSwitchEpochSec: 2000,
      nowEpochSec: 2100,
      cooldownSec: 60,
    });
    expect(res.shouldSwitch).toBe(true);
    expect(res.target).toBe('p2');
  });

  it('skips auto-switch when winner already active', async () => {
    const res = computeAutoSwitchDecision({
      currentProfile: 'p1',
      winner: { profile_id: 'p1' },
      lastSwitchEpochSec: 0,
      nowEpochSec: 5000,
      cooldownSec: 60,
    });
    expect(res.shouldSwitch).toBe(false);
    expect(res.reason).toBe('already-active');
  });

  it('skips auto-switch when no rule matches', async () => {
    const res = computeAutoSwitchDecision({
      currentProfile: 'p1',
      winner: null,
      lastSwitchEpochSec: 0,
      nowEpochSec: 5000,
      cooldownSec: 60,
    });
    expect(res.shouldSwitch).toBe(false);
    expect(res.reason).toBe('no-rule');
  });

  it('fills profile options without HTML injection', () => {
    const created = [];
    const doc = {
      createElement: (tag) => {
        const node = { tag, value: '', textContent: '', selected: false };
        created.push(node);
        return node;
      },
    };
    const select = {
      ownerDocument: doc,
      replaceChildren: (...nodes) => { select.nodes = nodes; },
    };

    const payload = {
      activeId: 'safe"id',
      defs: [
        { id: 'safe"id', name: '<img src=x onerror=alert(1)>' },
      ],
    };
    fillProfileOptions(select, payload);

    expect(created).toHaveLength(1);
    expect(select.nodes).toHaveLength(1);
    expect(select.nodes[0].value).toBe('safe"id');
    expect(select.nodes[0].textContent).toBe('<img src=x onerror=alert(1)>');
    expect(select.nodes[0].selected).toBe(true);
  });

  it('seeds current profile from Azure token status when none exist', async () => {
    localStorage.clear();
    const prevApiFetch = globalThis.apiFetch;
    const prevReadGistFile = globalThis.readGistFile;
    globalThis.GIST_ID = 'abc2a47c0a396025a72a6580227ff493';
    globalThis.apiFetch = async () => ({
      files: {
        'token-status.json': {
          content: JSON.stringify({
            user: { name: 'Tan Vu Cao', email: 'tanvc@fpt.com', oid: 'oid-123' },
          }),
        },
      },
    });
    globalThis.readGistFile = async (file) => file && file.content ? file.content : '';
    try {
      const state = await loadState();
      expect(state.defs).toHaveLength(1);
      expect(state.defs[0].name).toBe('Tan Vu Cao');
      expect(state.activeId).toBe(state.defs[0].id);
      expect(state.summary).toContain('Tan Vu Cao');
      const persisted = JSON.parse(localStorage.getItem('wf_dash_profile_defs') || '[]');
      expect(persisted).toHaveLength(1);
      expect(persisted[0].name).toBe('Tan Vu Cao');
      expect(localStorage.getItem('wf_dash_active_profile')).toBe(state.defs[0].id);
    } finally {
      globalThis.apiFetch = prevApiFetch;
      globalThis.readGistFile = prevReadGistFile;
      delete globalThis.GIST_ID;
    }
  });

  it('activate() serializes concurrent calls (in-flight guard)', async () => {
    localStorage.clear();
    localStorage.setItem('wf_dash_active_profile', 'p-old');
    // Two parallel manual activations — both should commit, in order.
    const [r1, r2] = await Promise.all([
      activate('p-1', { source: 'manual' }),
      activate('p-2', { source: 'manual' }),
    ]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(localStore.get('active_profile')).toBe('p-2');
    const audit = JSON.parse(localStorage.getItem('wf_dash_profile_audit') || '[]');
    // Last two audit entries reflect committed order p-old→p-1→p-2.
    const tail = audit.slice(-2);
    expect(tail[0].to).toBe('p-1');
    expect(tail[1].from).toBe('p-1');
    expect(tail[1].to).toBe('p-2');
  });
});
