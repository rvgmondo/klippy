import { describe, expect, it } from 'vitest';
import { allocatePayments, clientName, looksLikeJunk, realEmail, money, paymentMethod, rollForward, sameClient, splitNumber } from '../src/lib/importInvoiceNinja.js';

/**
 * The parts of the Invoice Ninja import that decide things, tested without a
 * database. Real cases from a real export: names that differ by a word, numbers
 * with three different prefixes, and payment files that do not add up.
 */
describe('Invoice Ninja import', () => {
  it('matches the same client under a slightly different name', () => {
    expect(sameClient('Early Bird Co', 'Early Bird Coffee Co')).toBe(true);
    expect(sameClient('Early Bird Co', 'Early Bird Coffee')).toBe(true);
    expect(sameClient('Bousteen Holdings (Pty) Ltd', 'Bousteen Holdings')).toBe(true);
    expect(sameClient('KAIZEN BUSINESS ANALYTICS', 'Kaizen Business Analytics')).toBe(true);
    expect(sameClient('DreamClean', 'Dream Clean')).toBe(true);
    expect(sameClient('Centred Studio', 'Studio')).toBe(false);
    expect(sameClient('Jolly Cool', 'Early Bird Co')).toBe(false);
  });

  it('names a nameless client after its contact', () => {
    expect(clientName({ Name: '', 'First Name': 'Johan', 'Last Name': 'Van Der Merwe' })).toBe('Johan Van Der Merwe');
    expect(clientName({ 'Client Name': 'RenewSA' })).toBe('RenewSA');
  });

  it('flags test entries but not real ones, and drops a made-up email without dropping the client', () => {
    expect(looksLikeJunk('Test client')).toBeTruthy();
    expect(looksLikeJunk('test mondo')).toBeTruthy();
    expect(looksLikeJunk('Testament Holdings')).toBeNull();
    expect(looksLikeJunk('Jack Five Guys Handyman service & Plumbing')).toBeNull();
    expect(realEmail('F62xhi@example.com')).toBeNull();
    expect(realEmail('')).toBeNull();
    expect(realEmail('accounts@renew.co.za')).toBe('accounts@renew.co.za');
  });

  it('reads numbers and money however they were typed', () => {
    expect(splitNumber('MB-10409')).toEqual({ prefix: 'MB-', seq: 10409 });
    expect(splitNumber('MBI10101')).toEqual({ prefix: 'MBI', seq: 10101 });
    expect(splitNumber('BC00001')).toEqual({ prefix: 'BC', seq: 1 });
    expect(splitNumber('DRAFT')).toBeNull();
    expect(money('22,000.00')).toBe(22000);
    expect(money('')).toBe(0);
    expect(paymentMethod('Visa Card')).toBe('Card');
    expect(paymentMethod('Bank Transfer')).toBe('EFT');
  });

  it('moves a repeating date forward, never back, keeping the day', () => {
    expect(rollForward('2026-06-05', 1, '2026-10-02')).toBe('2026-10-05');
    expect(rollForward('2026-01-31', 1, '2026-02-15')).toBe('2026-02-28');
    expect(rollForward('2026-12-01', 1, '2026-10-02')).toBe('2026-12-01');
    expect(rollForward('2025-03-10', 12, '2026-10-02')).toBe('2027-03-10');
  });

  it('matches payments to invoices oldest first and fills any gap', () => {
    const out = allocatePayments(
      [{ number: 'A', date: '2026-01-01', paid: 250 }, { number: 'B', date: '2026-02-01', paid: 500 }],
      [{ date: '2026-01-05', amount: 400, method: 'EFT', ref: '' }, { date: '2026-02-03', amount: 0, method: 'EFT', ref: '' }],
    );
    expect(out.get('A')).toEqual([{ date: '2026-01-05', amount: 250, method: 'EFT', ref: '' }]);
    const b = out.get('B')!;
    expect(b.reduce((s, p) => s + p.amount, 0)).toBe(500);
    expect(b[1]).toMatchObject({ amount: 350, method: 'Other' });
  });
});
