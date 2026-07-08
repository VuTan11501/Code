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
let _txCounter = 0;
function _nextTxToken() {
  _txCounter = (_txCounter + 1) >>> 0;
  return `tx-${Date.now().toString(36)}-${_txCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function activateProfileTx({ store, next, applyRefs }) {
  const prev = store.get('active_profile');
  const prevToken = store.get('active_profile_token');
  const myToken = _nextTxToken();
  try {
    store.set('active_profile', next);
    store.set('active_profile_token', myToken);
    await applyRefs(next);
    return { ok: true, prev, next };
  } catch (e) {
    // Token-based ownership rollback: only revert if OUR write is still
    // the most recent one. A bare value-CAS would false-match when a
    // concurrent tx wrote the same profile id and we'd clobber its
    // successful commit. External readers of `active_profile` still see
    // a plain string — `active_profile_token` is a tx-internal sibling.
    if (store.get('active_profile_token') === myToken) {
      store.set('active_profile', prev);
      store.set('active_profile_token', prevToken);
    }
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
let _activateInFlight = null;

export async function activate(profileId, opts) {
  const source = (opts && opts.source) || 'unknown';
  if (typeof profileId !== 'string' || !profileId.trim()) {
    throw new Error('activate requires profileId');
  }
  // Lightweight in-flight guard: serialize concurrent activate() calls
  // through a single promise chain so the audit log + pointer move in
  // commit order. The CAS rollback inside activateProfileTx still
  // protects against direct concurrent uses of the tx primitive.
  const run = async () => {
    const defs = loadProfileDefs();
    const tx = await activateProfileTx({
      store: localStore,
      next: profileId,
      applyRefs: async (id) => applyProfileRefs(id, defs),
    });
    appendSwitchAudit({ source, from: tx.prev, to: tx.next, ok: tx.ok });
    if (!tx.ok) throw new Error(`Profile switch failed: ${tx.error}`);
    // Successful commit → stamp cooldown clock so auto-switch respects it.
    try { localStore.set('active_profile_last_switch_ts', String(Math.floor(Date.now() / 1000))); } catch { /* ignore */ }
    // Fire DOM event so UI cards (Settings, dashboard) can re-render
    // without polling. No-op in node/vitest.
    try {
      if (typeof window !== 'undefined' && typeof CustomEvent === 'function') {
        window.dispatchEvent(new CustomEvent('wf:profile:changed', {
          detail: { from: tx.prev, to: tx.next, source },
        }));
      }
    } catch { /* ignore */ }
    return tx;
  };
  const chained = (_activateInFlight || Promise.resolve()).then(run, run);
  _activateInFlight = chained.catch(() => {});
  return chained;
}

// ─── Auto-switch scheduler ──────────────────────────────────────────────
// Pure decision helper — no I/O. Given the current context, returns
// whether an auto-switch should fire and its target.
//
// Ordering:
//   1. no matching rule       → { shouldSwitch: false, reason: 'no-rule' }
//   2. winner === current     → { shouldSwitch: false, reason: 'already-active' }
//   3. cooldown not elapsed   → { shouldSwitch: false, reason: 'cooldown' }
//   4. otherwise              → { shouldSwitch: true, target: winner.profile_id }
export function computeAutoSwitchDecision(ctx) {
  const c = ctx || {};
  if (!c.winner || !c.winner.profile_id) {
    return { shouldSwitch: false, reason: 'no-rule' };
  }
  if (c.winner.profile_id === c.currentProfile) {
    return { shouldSwitch: false, reason: 'already-active' };
  }
  if (!shouldSwitchByCooldown(c.lastSwitchEpochSec, c.nowEpochSec, c.cooldownSec)) {
    return { shouldSwitch: false, reason: 'cooldown' };
  }
  return { shouldSwitch: true, target: c.winner.profile_id };
}

// JST context extraction — auto-switch rules are authored in JST since the
// whole product operates in Asia/Tokyo (workflows, DokoKin, kintai rules).
function jstContext(now) {
  const d = now instanceof Date ? now : new Date();
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
    }).formatToParts(d);
    const m = {};
    for (const p of parts) m[p.type] = p.value;
    const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return {
      date: `${m.year}-${m.month}-${m.day}`,
      hhmm: `${m.hour}:${m.minute}`,
      dow: dowMap[m.weekday] != null ? dowMap[m.weekday] : d.getDay(),
      epochSec: Math.floor(d.getTime() / 1000),
    };
  } catch {
    // Fallback: local time (headless env with limited ICU data).
    const pad = (n) => String(n).padStart(2, '0');
    return {
      date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      hhmm: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
      dow: d.getDay(),
      epochSec: Math.floor(d.getTime() / 1000),
    };
  }
}

function loadProfileRules() {
  if (!lsAvailable()) return [];
  try {
    const raw = localStorage.getItem(LS_PREFIX + 'profile_rules');
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function readCooldownSec() {
  if (!lsAvailable()) return 60;
  try {
    const raw = localStorage.getItem(LS_PREFIX + 'profile_cooldown_sec');
    const n = raw == null ? NaN : Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 60;
  } catch { return 60; }
}

function readLastSwitchTs() {
  if (!lsAvailable()) return 0;
  try {
    const raw = localStorage.getItem(LS_PREFIX + 'active_profile_last_switch_ts');
    const n = raw == null ? NaN : Number(raw);
    return Number.isFinite(n) ? n : 0;
  } catch { return 0; }
}

/**
 * Read persisted profile state for UI rendering.
 * Returns { activeId, defs, rules, cooldownSec, lastSwitchTs, summary }.
 */
export async function loadState() {
  const defs = loadProfileDefs();
  const rules = loadProfileRules();
  const activeId = localStore.get('active_profile') || '';
  const cooldownSec = readCooldownSec();
  const lastSwitchTs = readLastSwitchTs();
  const activeLabel = activeId
    ? (defs.find((p) => p && p.id === activeId)?.name || activeId)
    : '(none)';
  const summary = `Active: ${activeLabel} — ${defs.length} profile(s), ${rules.length} rule(s), cooldown ${cooldownSec}s`;
  return { activeId, defs, rules, cooldownSec, lastSwitchTs, summary };
}

/**
 * Populate a <select> with profile options. Marks the active one selected.
 */
export function fillProfileOptions(selectEl, state) {
  if (!selectEl) return;
  const s = state || {};
  const defs = Array.isArray(s.defs) ? s.defs : [];
  const active = s.activeId || '';
  const doc = selectEl.ownerDocument || (typeof document !== 'undefined' ? document : null);
  if (!doc || typeof doc.createElement !== 'function') return;
  const options = [];
  if (defs.length === 0) {
    const opt = doc.createElement('option');
    opt.value = '';
    opt.textContent = '(no profiles defined)';
    options.push(opt);
  } else {
    for (const p of defs) {
      if (!p || typeof p.id !== 'string') continue;
      const opt = doc.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name || p.id;
      opt.selected = p.id === active;
      options.push(opt);
    }
  }
  if (typeof selectEl.replaceChildren === 'function') {
    selectEl.replaceChildren(...options);
  } else {
    while (selectEl.firstChild) selectEl.removeChild(selectEl.firstChild);
    for (const opt of options) selectEl.appendChild(opt);
  }
}

let _autoSwitchTimer = null;
let _autoSwitchInFlight = false;
const AUTO_SWITCH_INTERVAL_MS = 60_000;

/**
 * Evaluate the auto-switch rules against JST now and fire `activate()`
 * when the decision says so. Safe to call at any time; guarded against
 * re-entry. Never throws — errors are logged and audited.
 */
export async function evaluateAutoSwitch() {
  if (_autoSwitchInFlight) return { shouldSwitch: false, reason: 're-entrant' };
  _autoSwitchInFlight = true;
  try {
    const rules = loadProfileRules();
    if (!rules.length) return { shouldSwitch: false, reason: 'no-rules-configured' };
    const ctx = jstContext();
    const winner = resolveWinningRule(rules, ctx);
    const decision = computeAutoSwitchDecision({
      currentProfile: localStore.get('active_profile') || null,
      winner,
      lastSwitchEpochSec: readLastSwitchTs(),
      nowEpochSec: ctx.epochSec,
      cooldownSec: readCooldownSec(),
    });
    if (!decision.shouldSwitch) return decision;
    try {
      await activate(decision.target, { source: 'auto' });
      return { ...decision, activated: true };
    } catch (e) {
      // activate() already wrote a failure audit entry.
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[ProfileSwitch] auto-switch failed:', e && e.message ? e.message : e);
      }
      return { ...decision, activated: false, error: e && e.message ? e.message : String(e) };
    }
  } finally {
    _autoSwitchInFlight = false;
  }
}

/**
 * Boot the auto-switch loop: evaluate immediately, then poll every 60s.
 * Idempotent — repeat calls do NOT stack timers.
 */
export function bootAutoSwitch() {
  // Fire once at boot (non-blocking).
  Promise.resolve().then(() => evaluateAutoSwitch()).catch(() => {});
  if (_autoSwitchTimer != null) return; // already booted
  if (typeof setInterval !== 'function') return;
  _autoSwitchTimer = setInterval(() => {
    evaluateAutoSwitch().catch(() => {});
  }, AUTO_SWITCH_INTERVAL_MS);
  // Also re-evaluate when the browser signals we came back from sleep /
  // tab focus — the interval alone can drift when the tab is throttled.
  try {
    if (typeof window !== 'undefined' && !bootAutoSwitch._focusWired) {
      window.addEventListener('visibilitychange', () => {
        if (typeof document !== 'undefined' && !document.hidden) {
          evaluateAutoSwitch().catch(() => {});
        }
      });
      bootAutoSwitch._focusWired = true;
    }
  } catch { /* ignore */ }
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
  computeAutoSwitchDecision,
  loadState,
  fillProfileOptions,
  bootAutoSwitch,
  evaluateAutoSwitch,
};

if (typeof window !== 'undefined') {
  window.ProfileSwitch = ProfileSwitch;
}

export default ProfileSwitch;
