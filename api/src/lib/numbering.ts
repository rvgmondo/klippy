import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { documents, businesses } from '../db/schema.js';
import { tenantWhere } from './tenant.js';

/**
 * Document numbering.
 *
 * Two things people expect and Klippy did not offer: their own prefix (a lot of
 * businesses have used "MB-" or "2026/" for years and their clients recognise it),
 * and control of where the count is. The second matters most when moving from
 * another system, where restarting at 0001 next to invoices already numbered 1042
 * is a bookkeeping mess.
 *
 * The next number is always `max(highest used + 1, start)`. Deriving from the
 * highest used means a raised start can never collide with a document that already
 * exists, and lowering the start quietly does nothing rather than issuing a
 * duplicate number.
 */

export type DocType = 'quote' | 'invoice' | 'credit_note';

const FALLBACK_PREFIX: Record<DocType, string> = {
  quote: 'QUO-', invoice: 'INV-', credit_note: 'CN-',
};

const PREFIX_COLUMN = {
  quote: 'prefixQuote', invoice: 'prefixInvoice', credit_note: 'prefixCreditNote',
} as const;
const START_COLUMN = {
  quote: 'seqStartQuote', invoice: 'seqStartInvoice', credit_note: 'seqStartCreditNote',
} as const;

type BusinessRow = typeof businesses.$inferSelect;

export function prefixFor(business: BusinessRow | undefined, type: DocType): string {
  const custom = business?.[PREFIX_COLUMN[type]];
  return (custom ?? '').trim() || FALLBACK_PREFIX[type];
}

/** Format a sequence the way it appears on a document. */
export function formatNumber(prefix: string, seq: number): string {
  return `${prefix}${String(seq).padStart(4, '0')}`;
}

/**
 * The next sequence and number for a business + type, without consuming it.
 * Used both when issuing a document and to show "your next invoice will be X".
 */
export async function nextNumberFor(
  accountId: number, businessId: number | null, type: DocType,
): Promise<{ seq: number; number: string; prefix: string; highestUsed: number }> {
  const [business] = businessId
    ? await db.select().from(businesses)
      .where(tenantWhere(businesses, accountId, eq(businesses.id, businessId))).limit(1)
    : [undefined];

  const [row] = await db.select({ m: sql<number>`COALESCE(MAX(seq),0)` }).from(documents)
    .where(tenantWhere(documents, accountId, eq(documents.type, type),
      businessId == null ? sql`business_id IS NULL` : eq(documents.businessId, businessId)));

  const highestUsed = Number(row?.m ?? 0);
  const start = business?.[START_COLUMN[type]] ?? null;
  // The start is a floor, never a rewind: an existing document always wins.
  const seq = Math.max(highestUsed + 1, start ?? 1);
  const prefix = prefixFor(business, type);
  return { seq, number: formatNumber(prefix, seq), prefix, highestUsed };
}
