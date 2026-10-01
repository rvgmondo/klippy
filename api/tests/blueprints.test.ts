import { describe, expect, it } from 'vitest';
import { blueprint, provisionFrom } from '../src/lib/blueprints.js';

/**
 * What a business is set up with when someone picks its kind at sign-up.
 * Pure data, so it is checked without a database.
 */
describe('sign-up blueprints', () => {
  it('a trade calls people Customers and skips deals, posts and timesheets', () => {
    const bp = blueprint('trade');
    expect(bp?.clientWord).toEqual({ one: 'Customer', many: 'Customers' });
    const mods = provisionFrom(bp!).modules;
    expect(mods).toContain('billing');
    expect(mods).toContain('collections');
    for (const off of ['pipeline', 'social', 'reports']) expect(mods).not.toContain(off);
  });

  it('carries its payment terms and reminder schedule, not only its screens', () => {
    const p = provisionFrom(blueprint('consultant')!);
    expect(p.defaultDueDays).toBe(7);
    expect(p.reminderOffsets).toEqual([-3, 0, 7, 14]);
  });

  it('an unknown kind is ignored rather than guessed', () => {
    expect(blueprint('spaceship')).toBeUndefined();
    expect(blueprint('')).toBeUndefined();
  });
});
