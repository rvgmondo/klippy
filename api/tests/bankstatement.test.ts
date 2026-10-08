import { describe, expect, it } from 'vitest';
import { parseAmount, parseDate, readStatement, suggestMatches } from '../src/lib/bankStatement.js';

/**
 * Reading bank exports and matching deposits to invoices, against the layouts SA
 * banks actually produce. Made-up account details throughout.
 */
describe('parseDate', () => {
  it('reads the shapes banks use, day first', () => {
    expect(parseDate('2026/10/08')).toBe('2026-10-08');
    expect(parseDate('2026-10-08 13:22')).toBe('2026-10-08');
    expect(parseDate('08/10/2026')).toBe('2026-10-08');
    expect(parseDate('8 Oct 2026')).toBe('2026-10-08');
    expect(parseDate('20261008')).toBe('2026-10-08');
    expect(parseDate('Opening balance')).toBeNull();
  });
});

describe('parseAmount', () => {
  it('reads rands however they are written', () => {
    expect(parseAmount('1,234.56')).toBe(1234.56);
    expect(parseAmount('R 1 234,56')).toBe(1234.56);
    expect(parseAmount('-500.00')).toBe(-500);
    expect(parseAmount('(500.00)')).toBe(-500);
    expect(parseAmount('250.00Cr')).toBe(250);
    expect(parseAmount('250.00Dr')).toBe(-250);
    expect(parseAmount('Balance')).toBeNull();
  });
});

describe('readStatement', () => {
  it('finds the header under FNB-style account details and keeps only money in', () => {
    const csv = [
      '2,Account Number,62000000000,Cheque Account',
      '3,Statement period,2026/10/01,2026/10/08',
      'Date,Amount,Balance,Description',
      '2026/10/02,"4,600.00","12,000.00",FNB APP PAYMENT FROM EARLY BIRD INV-0002',
      '2026/10/03,-350.00,"11,650.00",HOSTING DEBIT ORDER',
      '2026/10/05,9200.00,20850.00,ACME PLUMBING EFT',
    ].join('\n');
    const { rows, skipped } = readStatement(csv);
    expect(rows.map((r) => [r.date, r.amount])).toEqual([['2026-10-02', 4600], ['2026-10-05', 9200]]);
    expect(rows[0]!.description).toContain('INV-0002');
    expect(skipped).toBe(1);
  });

  it('reads Capitec-style money in and money out columns', () => {
    const csv = [
      'Nr,Account,Posting Date,Transaction Date,Description,Original Description,Parent Category,Category,Money In,Money Out,Fee,Balance',
      '1,1000000000,2026-10-02,2026-10-02,Payment Received: Riverwalk,Payment Received: Riverwalk,Income,Other,402.50,,,5402.50',
      '2,1000000000,2026-10-03,2026-10-03,Groceries,Groceries,Food,Groceries,,-120.00,,5282.50',
    ].join('\n');
    const { rows } = readStatement(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ date: '2026-10-02', amount: 402.5, description: 'Payment Received: Riverwalk' });
  });

  it('guesses the columns when there is no header at all', () => {
    const csv = ['08 Oct 2026;Lux Auto Care;402,50', '09 Oct 2026;Bank fees;-12,00'].join('\n');
    const { rows } = readStatement(csv);
    expect(rows).toEqual([{ line: 1, date: '2026-10-08', description: 'Lux Auto Care', amount: 402.5 }]);
  });

  it('says plainly when it cannot read the file', () => {
    expect(() => readStatement('hello\nworld')).toThrow(/date and amount/);
  });
});

describe('suggestMatches', () => {
  const open = [
    { id: 1, number: 'INV-0002', clientName: 'Early Bird Coffee', outstanding: 3600, currency: 'ZAR' },
    { id: 2, number: 'INV-0001', clientName: 'Acme Plumbing', outstanding: 9200, currency: 'ZAR' },
    { id: 3, number: 'INV-0005', clientName: 'Riverwalk', outstanding: 402.5, currency: 'ZAR' },
    { id: 4, number: 'INV-0006', clientName: 'Lux Auto Care', outstanding: 402.5, currency: 'ZAR' },
    { id: 5, number: 'INV-0012', clientName: 'Kloof Street Dental', outstanding: 2300, currency: 'ZAR' },
  ];
  const row = (line: number, description: string, amount: number) => ({ line, date: '2026-10-08', description, amount });

  it('trusts the invoice number in the reference first, even for a part payment', () => {
    expect(suggestMatches([row(1, 'EARLY BIRD INV0002', 1000)], open)).toEqual([{ line: 1, documentId: 1, confidence: 'number' }]);
  });
  it('does not read INV-0001 inside INV-0012', () => {
    const s = suggestMatches([row(1, 'payment INV-0012', 2300)], open);
    expect(s).toEqual([{ line: 1, documentId: 5, confidence: 'number' }]);
  });
  it('uses the amount and the name together when there is no number', () => {
    expect(suggestMatches([row(1, 'Payment Received: Riverwalk', 402.5)], open))
      .toEqual([{ line: 1, documentId: 3, confidence: 'amount-and-name' }]);
  });
  it('uses the amount alone only when one invoice owes it', () => {
    expect(suggestMatches([row(1, 'EFT CREDIT', 9200)], open)).toEqual([{ line: 1, documentId: 2, confidence: 'amount' }]);
    expect(suggestMatches([row(1, 'EFT CREDIT', 402.5)], open)).toEqual([]);
  });
  it('never gives one invoice to two deposits', () => {
    const s = suggestMatches([row(1, 'ACME INV-0001', 9200), row(2, 'ACME again', 9200)], open);
    expect(s).toEqual([{ line: 1, documentId: 2, confidence: 'number' }]);
  });
});
