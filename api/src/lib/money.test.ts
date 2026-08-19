import { describe, it, expect } from 'vitest';
import { money, cents } from './money.js';

describe('money', () => {
  it('rounds to the cent then fixes two decimals', () => {
    expect(money(1.006)).toBe('1.01'); // rounds up at the cent
    expect(money(1.004)).toBe('1.00'); // rounds down at the cent
    expect(money(1150)).toBe('1150.00');
    expect(money(0)).toBe('0.00');
  });
});

describe('cents', () => {
  it('converts to whole cents', () => {
    expect(cents(11.5)).toBe(1150);
    expect(cents(0.1)).toBe(10);
  });
});
