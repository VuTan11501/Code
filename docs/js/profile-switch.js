// Profile Switch engine — pure primitives for picking the active profile
// from a list of rules, gating switches with a cooldown, and validating
// profile bundles before they are applied.
//
// Dual-mode: works as ES module (vitest imports) and attaches to
// window.ProfileSwitch for in-browser script consumers.

/**
 * Pick the winning rule for the given context. Higher `priority` wins;
 * ties are broken by array order (later entries win, mirroring CSS
 * cascade intuition). Rules that don't match the context are skipped.
 *
 * A rule matches when:
 *   - rule.weekdays (if present) includes ctx.dow (0=Sun..6=Sat)
 *   - rule.start/end (HH:MM, inclusive start, exclusive end) cover ctx.hhmm
 *     If start > end, the window wraps across midnight.
 *   - rule.dates (if present, YYYY-MM-DD list) includes ctx.date
 *
 * Rules with no constraints act as defaults.
 *
 * @param {Array<object>} rules
 * @param {{dow?: number, hhmm?: string, date?: string}} ctx
 * @returns {object|null}
 */
export function resolveWinningRule(rules, ctx) {
  if (!Array.isArray(rules) || rules.length === 0) return null;
  const matches = [];
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    if (!r) continue;
    if (!ruleMatches(r, ctx)) continue;
    matches.push({ r, i, priority: Number(r.priority) || 0 });
  }
  if (matches.length === 0) return null;
  matches.sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    const au = tsOf(a.r.updated_at), bu = tsOf(b.r.updated_at);
    if (au !== bu) return bu - au;
    const ac = tsOf(a.r.created_at), bc = tsOf(b.r.created_at);
    if (ac !== bc) return bc - ac;
    return b.i - a.i;
  });
  return matches[0].r;
}

function tsOf(v) {
  if (v == null) return 0;
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Date.parse(v);
    return isNaN(n) ? 0 : n;
  }
  return 0;
}

function ruleMatches(rule, ctx) {
  const c = ctx || {};
  if (Array.isArray(rule.weekdays) && rule.weekdays.length > 0) {
    if (typeof c.dow !== 'number' || !rule.weekdays.includes(c.dow)) return false;
  }
  if (Array.isArray(rule.dates) && rule.dates.length > 0) {
    if (!c.date || !rule.dates.includes(c.date)) return false;
  }
  if (rule.start && rule.end) {
    if (!c.hhmm) return false;
    if (!timeInWindow(c.hhmm, rule.start, rule.end)) return false;
  }
  return true;
}

function timeInWindow(hhmm, start, end) {
  const t = toMin(hhmm), s = toMin(start), e = toMin(end);
  if (t == null || s == null || e == null) return false;
  if (s <= e) return t >= s && t < e;
  // wraps midnight
  return t >= s || t < e;
}

function toMin(hhmm) {
  if (typeof hhmm !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Returns true when enough time has elapsed since the previous switch.
 * Both timestamps are in seconds (epoch or monotonic — caller decides).
 *
 * @param {number} lastSwitchTs
 * @param {number} nowTs
 * @param {number} cooldownSec
 */
export function shouldSwitchByCooldown(lastSwitchTs, nowTs, cooldownSec) {
  if (typeof lastSwitchTs !== 'number' || !isFinite(lastSwitchTs)) return true;
  if (typeof nowTs !== 'number' || !isFinite(nowTs)) return false;
  const cd = Number(cooldownSec) || 0;
  return nowTs - lastSwitchTs >= cd;
}

/**
 * Validate a profile bundle before persisting/applying. Required:
 *   - id (string)
 *   - refs.schedule_set_id (string) — every profile must point at a
 *     concrete schedule set so switching is deterministic.
 *
 * @param {object} bundle
 * @returns {{ok: boolean, error?: string}}
 */
export function validateProfileBundle(bundle) {
  if (!bundle || typeof bundle !== 'object') {
    return { ok: false, error: 'profile bundle must be an object' };
  }
  if (typeof bundle.id !== 'string' || !bundle.id.trim()) {
    return { ok: false, error: 'profile bundle requires id' };
  }
  const refs = bundle.refs || {};
  if (typeof refs.schedule_set_id !== 'string' || !refs.schedule_set_id.trim()) {
    return { ok: false, error: 'profile bundle requires refs.schedule_set_id' };
  }
  return { ok: true };
}

/**
 * Transactional profile activation. Writes the pointer optimistically,
 * runs the side-effect (`applyRefs`), and rolls the pointer back if it
 * throws. Returns a result describing the outcome — callers should not
 * throw from this function.
 *
 * @param {{store: {get:(k:string)=>any, set:(k:string,v:any)=>void}, next: string, applyRefs: (next:string)=>any}} args
 * @returns {Promise<{ok: boolean, prev: any, next: string, error?: string}>}
 */
export async function activateProfileTx({ store, next, applyRefs }) {
  const prev = store.get('active_profile');
  try {
    store.set('active_profile', next);
    await applyRefs(next);
    return { ok: true, prev, next };
  } catch (e) {
    store.set('active_profile', prev);
    return { ok: false, prev, next, error: e && e.message ? e.message : String(e) };
  }
}

// ─── localStorage-backed store + audit helpers ──────────────────────────
// These run in the browser. In test (node) environments without
// `localStorage`, the adapters degrade to no-ops so module import stays
// side-effect free.

const LS_PREFIX = 'wf_dash_';

function lsAvailable() {
  try { return typeof localStorage !== 'undefined' && localStorage !== null; }
  catch { return false; }
}

/** localStorage-backed key/value store used by `activate()`. */
export const localStore = {
  get(key) {
    if (!lsAvailable()) return null;
    try { return localStorage.getItem(LS_PREFIX + key); } catch { return null; }
  },
  set(key, value) {
    if (!lsAvailable()) return;
    try {
      if (value == null) localStorage.removeItem(LS_PREFIX + key);
      else localStorage.setItem(LS_PREFIX + key, String(value));
    } catch { /* ignore quota / disabled storage */ }
  },
};

function loadProfileDefs() {
  if (!lsAvailable()) return [];
  try {
    const raw = localStorage.getItem(LS_PREFIX + 'profile_defs');
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

/**
 * Apply profile refs (schedule_set_id, locations, etc.). For Task 3 this
 * only guards "unknown id when a defs registry exists" — full refs
 * application (rewriting active schedule pointer, location overrides, …)
 * lands in Task 4/5. Throwing here triggers `activateProfileTx` rollback.
 *
 * @param {string} profileId
 * @param {Array<object>} defs
 */
export async function applyProfileRefs(profileId, defs) {
  const list = Array.isArray(defs) ? defs : [];
  if (list.length > 0) {
    const found = list.find((p) => p && p.id === profileId);
    if (!found) throw new Error(`profile not found: ${profileId}`);
  }
  // Real side effects (schedule set swap, location remap) wired in Task 4/5.
}

const AUDIT_KEY = LS_PREFIX + 'profile_audit';
const AUDIT_MAX = 100;

/**
 * Append a switch audit entry to a localStorage ring buffer (max 100).
 * Schema: { ts, source, from, to, ok }.
 */
export function appendSwitchAudit(entry) {
  if (!lsAvailable()) return;
  let arr = [];
  try {
    const raw = localStorage.getItem(AUDIT_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) arr = parsed;
  } catch { arr = []; }
  arr.push({
    ts: new Date().toISOString(),
    source: entry && entry.source != null ? entry.source : 'unknown',
    from: entry ? entry.from : null,
    to: entry ? entry.to : null,
    ok: !!(entry && entry.ok),
  });
  if (arr.length > AUDIT_MAX) arr = arr.slice(-AUDIT_MAX);
  try { localStorage.setItem(AUDIT_KEY, JSON.stringify(arr)); } catch { /* ignore */ }
}

/**
 * Activate a profile by id. Wraps `activateProfileTx` with the real
 * localStorage-backed store + `applyProfileRefs`. Throws when the
 * transaction reports `ok:false` so callers (UI) can surface the error.
 * Always records an audit entry (rollback or success).
 *
 * @param {string} profileId
 * @param {{source?: string}} [opts]
 */
export async function activate(profileId, opts) {
  const source = (opts && opts.source) || 'unknown';
  if (typeof profileId !== 'string' || !profileId.trim()) {
    throw new Error('activate requires profileId');
  }
  const defs = loadProfileDefs();
  const tx = await activateProfileTx({
    store: localStore,
    next: profileId,
    applyRefs: async (id) => applyProfileRefs(id, defs),
  });
  appendSwitchAudit({ source, from: tx.prev, to: tx.next, ok: tx.ok });
  if (!tx.ok) throw new Error(`Profile switch failed: ${tx.error}`);
  return tx;
}

const ProfileSwitch = {
  resolveWinningRule,
  shouldSwitchByCooldown,
  validateProfileBundle,
  activateProfileTx,
  activate,
  applyProfileRefs,
  appendSwitchAudit,
  localStore,
};

if (typeof window !== 'undefined') {
  window.ProfileSwitch = ProfileSwitch;
}

export default ProfileSwitch;
