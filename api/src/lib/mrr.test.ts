import { describe, it, expect } from 'vitest';
import { chargeFor } from './mrr.js';

describe('chargeFor', () => {
  it('uses the negotiated price when set', () => {
    expect(chargeFor({ price: '9000.00' }, { price: '7500.00' })).toBe(9000);
  });
  it('falls back to the offering list price when null', () => {
    expect(chargeFor({ price: null }, { price: '7500.00' })).toBe(7500);
  });
});
