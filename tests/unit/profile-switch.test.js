import { describe, it, expect } from 'vitest';
import {
  resolveWinningRule,
  shouldSwitchByCooldown,
  validateProfileBundle,
  activateProfileTx,
  activate,
  appendSwitchAudit,
  localStore,
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
