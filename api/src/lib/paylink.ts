import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { documents } from '../db/schema.js';
import { settingsFor } from './paymentSettings.js';
import { appUrl } from './mailer.js';
import { signPayToken } from './secretbox.js';
import { payfastSupports } from './currency.js';

/**
 * A public, signed URL where a client can pay an invoice online, or null when the
 * account has not switched PayFast on (in which case the invoice email just carries
 * the bank details instead). Used by both the manual "email this invoice" action and
 * the automatic recurring-invoice email.
 */
export async function payLinkFor(accountId: number, docId: number): Promise<string | null> {
  // Resolved through the invoice's own business: a business with no gateway of its
  // own gets the workspace one, and one that has switched payment off gets no link
  // rather than a link that pays somebody else.
  const [doc] = await db.select({ businessId: documents.businessId, currency: documents.currency })
    .from(documents).where(eq(documents.id, docId)).limit(1);
  // PayFast settles rand only. An invoice raised in dollars with a PayFast key
  // configured would otherwise get a "Pay online" button that either fails at the
  // gateway or, far worse, charges the number as rand. No link is the honest
  // answer: the invoice still carries the bank details for a transfer.
  if (!payfastSupports(doc?.currency)) return null;
  const settings = await settingsFor(accountId, doc?.businessId ?? null);
  if (!settings?.enabled) return null;
  const token = signPayToken(docId);
  if (!token) return null;
  return `${appUrl()}/api/v1/pay/${docId}?t=${token}`;
}
