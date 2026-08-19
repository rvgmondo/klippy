import { describe, it, expect } from 'vitest';
import {
  roundMoney, formatMoney, decimalsFor, payfastSupports, isKnownCurrency, currencyInfo,
} from './currency.js';

describe('roundMoney', () => {
  it('rounds to the cent for two-decimal currencies', () => {
    expect(roundMoney(1150.505, 'ZAR')).toBe(1150.51);
    expect(roundMoney(1150.504, 'USD')).toBe(1150.5);
  });
  it('rounds to whole units for a zero-decimal currency (yen has no half)', () => {
    expect(roundMoney(1150.5, 'JPY')).toBe(1151);
    expect(roundMoney(1150.4, 'JPY')).toBe(1150);
  });
  it('rounds to three places for a dinar', () => {
    expect(roundMoney(1150.5678, 'KWD')).toBe(1150.568);
  });
});

describe('formatMoney', () => {
  it('prefixes the ISO code and groups thousands', () => {
    expect(formatMoney(1234567.89, 'ZAR')).toBe('ZAR 1,234,567.89');
  });
  it('omits decimals for a zero-decimal currency', () => {
    expect(formatMoney(1151, 'JPY')).toBe('JPY 1,151');
  });
  it('handles a string amount and a negative', () => {
    expect(formatMoney('-1234.5', 'USD')).toBe('USD -1,234.50');
  });
  it('never blanks out on a non-finite amount', () => {
    expect(formatMoney(Number.NaN, 'ZAR')).toBe('ZAR 0.00');
  });
});

describe('an invoice built from rounded parts adds up', () => {
  // The exact bug that shipped: rounding each figure from the raw arithmetic gave
  // subtotal + tax that a client's calculator disagreed with. Round the parts, then
  // build the totals from those parts.
  it('reconciles a two-line yen invoice at 10% tax', () => {
    const r = (n: number) => roundMoney(n, 'JPY');
    const lines = [
      { qty: 2, unit: r(12500.5) },  // 25002
      { qty: 1, unit: r(3333.33) },  // 3333
    ];
    const lineAmounts = lines.map((l) => r(l.qty * l.unit));
    const subtotal = r(lineAmounts.reduce((s, a) => s + a, 0));
    const tax = r(subtotal * 0.1);
    const total = r(subtotal + tax);
    expect(subtotal).toBe(28335);
    expect(tax).toBe(2834);
    expect(subtotal + tax).toBe(total); // the column a client checks
  });
});

describe('payfastSupports', () => {
  it('is rand-only, case-insensitive, defaulting to ZAR on null', () => {
    expect(payfastSupports('ZAR')).toBe(true);
    expect(payfastSupports('zar')).toBe(true);
    expect(payfastSupports(null)).toBe(true);
    expect(payfastSupports('USD')).toBe(false);
    expect(payfastSupports('EUR')).toBe(false);
  });
});

describe('currency metadata', () => {
  it('knows real currencies and rejects a typo', () => {
    expect(isKnownCurrency('ZAR')).toBe(true);
    expect(isKnownCurrency('usd')).toBe(true);
    expect(isKnownCurrency('XYZ')).toBe(false);
  });
  it('reports the right number of decimals', () => {
    expect(decimalsFor('JPY')).toBe(0);
    expect(decimalsFor('KWD')).toBe(3);
    expect(decimalsFor('ZAR')).toBe(2);
  });
  it('treats an unknown code as two-decimal rather than throwing', () => {
    expect(currencyInfo('XYZ').decimals).toBe(2);
    expect(roundMoney(1.006, 'XYZ')).toBe(1.01);
  });
});
