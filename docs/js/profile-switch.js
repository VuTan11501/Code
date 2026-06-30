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

const ProfileSwitch = {
  resolveWinningRule,
  shouldSwitchByCooldown,
  validateProfileBundle,
};

if (typeof window !== 'undefined') {
  window.ProfileSwitch = ProfileSwitch;
}

export default ProfileSwitch;
