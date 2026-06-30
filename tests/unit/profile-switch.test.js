import { describe, it, expect } from 'vitest';
import {
  resolveWinningRule,
  shouldSwitchByCooldown,
  validateProfileBundle,
} from '../../docs/js/profile-switch.js';

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
    expect(shouldSwitchByCooldown(100000, 100061, 60)).toBe(true);
  });

  it('rejects missing schedule_set_id', () => {
    const result = validateProfileBundle({ id: 'p1', refs: { location_key: 'office' } });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/schedule_set_id/i);
  });
});
