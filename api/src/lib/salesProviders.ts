import { listPayments as yocoList, testKey as yocoTest, MAX_WINDOW_DAYS as YOCO_WINDOW } from './yoco.js';
import type { YocoPayment, YocoResult } from './yoco.js';

/**
 * The providers Klippy can READ takings from, and what each one will actually tell you.
 *
 * This exists because "add another gateway" should be one file, not a schema change,
 * a sync rewrite and three route edits. A provider that lands here with a client
 * attached works everywhere sales work: the screen, the nightly job, the VAT return.
 *
 * There is a hard line running through this list, and it is worth naming. Reading and
 * charging are different things. A gateway you can CHARGE through (PayFast) lives in
 * payment_settings and pushes money at you through its notify callback. A provider you
 * can READ from tells you what a machine took after the fact. Some providers do both;
 * most do exactly one. Only the readable ones belong here.
 *
 * Which is which was verified against each provider's own reference in September 2026,
 * not assumed from their marketing:
 *
 *  - YOCO       payments list with processing_fees[]. Built and shipped. 31-day cap.
 *  - ZAPPER     the richest of the lot: processingFeeAmount, its percentage and fixed
 *               parts, the TAX on that fee, and settlementAmount/Status/Date. The fee
 *               tax matters, because that is input VAT the business can claim back.
 *  - SNAPSCAN   readable, but reports NO fee at all. Gross and tip only. A shop on
 *               SnapScan alone would see turnover with no cost against it, which is
 *               the exact illusion the Takings screen exists to prevent, so it must be
 *               labelled rather than quietly integrated.
 *  - PAYSTACK   transaction list carries `fees` in the currency subunit.
 *  - PEACH      a reconciliation API that lists transactions with their fees, refunds
 *               and reversals per deposit.
 *
 * Deliberately absent: PAYFAST and OZOW. Both are push-only. PayFast has no
 * transaction-history read API at all, and its fee reaches us exactly once, on the ITN
 * (amount_fee / amount_net), which is why that is captured at the moment of payment or
 * never. Ozow offers a lookup by reference and status polling, not a merchant list.
 * Neither belongs in a sync that pulls a date range.
 *
 * IKHOKHA is missing on purpose: its developer portal renders behind a script and
 * could not be read without a merchant login, so whether iK Pay exposes a transaction
 * list is UNVERIFIED. It is not listed as available rather than guessed at.
 */

export type ProviderKey = 'yoco' | 'zapper' | 'snapscan' | 'paystack' | 'peach';

export interface SalesProvider {
  key: ProviderKey;
  label: string;
  /** What the merchant pastes in. Shown on the connect form. */
  credentialLabel: string;
  /**
   * Whether the provider reports what it kept. False means Klippy can show what was
   * taken but never what it cost, and the screen has to say so rather than implying
   * a zero fee is a real one.
   */
  reportsFees: boolean;
  /** Their cap on how much time one query may span. Null means no documented limit. */
  maxWindowDays: number | null;
  /** Null until a client is written. The key exists so the note can be shown. */
  client: {
    listPayments(secret: string, opts: { from: string; to: string; cursor?: string; limit?: number }):
      Promise<YocoResult<{ payments: YocoPayment[]; nextCursor: string | null }>>;
    testKey(secret: string): Promise<YocoResult<{ payments: number }>>;
  } | null;
  /** Shown to whoever is deciding what to connect. Plain, not marketing. */
  note: string;
}

export const SALES_PROVIDERS: SalesProvider[] = [
  {
    key: 'yoco',
    label: 'Yoco',
    credentialLabel: 'Yoco API key',
    reportsFees: true,
    maxWindowDays: YOCO_WINDOW,
    client: { listPayments: yocoList, testKey: yocoTest },
    note: 'Card machine and online payments, with the processing fee on each one.',
  },
  {
    key: 'zapper',
    label: 'Zapper',
    credentialLabel: 'Zapper merchant API key',
    reportsFees: true,
    maxWindowDays: null,
    client: null,
    note: 'Reports the fee, the tax on the fee, and what was settled to the bank. Not connected yet.',
  },
  {
    key: 'paystack',
    label: 'Paystack',
    credentialLabel: 'Paystack secret key',
    reportsFees: true,
    maxWindowDays: null,
    client: null,
    note: 'Online payments with the fee on each transaction. Not connected yet.',
  },
  {
    key: 'peach',
    label: 'Peach Payments',
    credentialLabel: 'Peach entity ID and access token',
    reportsFees: true,
    maxWindowDays: null,
    client: null,
    note: 'Reconciliation API listing transactions, fees and refunds per deposit. Not connected yet.',
  },
  {
    key: 'snapscan',
    label: 'SnapScan',
    credentialLabel: 'SnapScan API key',
    // The one that has to be said out loud.
    reportsFees: false,
    maxWindowDays: null,
    client: null,
    note: 'SnapScan does not report what it charged you, so takings would show with no cost against them. Not connected yet.',
  },
];

const BY_KEY = new Map(SALES_PROVIDERS.map((p) => [p.key, p]));

export const providerFor = (key: string): SalesProvider | undefined =>
  BY_KEY.get(key as ProviderKey);

/** The ones a person can actually connect today, i.e. those with a client written. */
export const connectableProviders = (): SalesProvider[] =>
  SALES_PROVIDERS.filter((p) => p.client !== null);

export const isConnectable = (key: string): boolean => !!providerFor(key)?.client;
