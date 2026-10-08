import { describe, expect, it } from 'vitest';
import { periodLabel } from '../src/lib/billing.js';

/** The period written on a subscription invoice line. */
describe('periodLabel', () => {
  it('says the year once when both ends share it', () => {
    expect(periodLabel('2026-07-03', '2026-08-02')).toBe('3 Jul to 2 Aug 2026');
  });
  it('says both years across a new year', () => {
    expect(periodLabel('2026-12-15', '2027-01-14')).toBe('15 Dec 2026 to 14 Jan 2027');
  });
});
