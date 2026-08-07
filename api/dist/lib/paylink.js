import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { documents } from '../db/schema.js';
import { settingsFor } from './paymentSettings.js';
import { appUrl } from './mailer.js';
import { signPayToken } from './secretbox.js';
/**
 * A public, signed URL where a client can pay an invoice online, or null when the
 * account has not switched PayFast on (in which case the invoice email just carries
 * the bank details instead). Used by both the manual "email this invoice" action and
 * the automatic recurring-invoice email.
 */
export async function payLinkFor(accountId, docId) {
    // Resolved through the invoice's own business: a business with no gateway of its
    // own gets the workspace one, and one that has switched payment off gets no link
    // rather than a link that pays somebody else.
    const [doc] = await db.select({ businessId: documents.businessId }).from(documents)
        .where(eq(documents.id, docId)).limit(1);
    const settings = await settingsFor(accountId, doc?.businessId ?? null);
    if (!settings?.enabled)
        return null;
    const token = signPayToken(docId);
    if (!token)
        return null;
    return `${appUrl()}/api/v1/pay/${docId}?t=${token}`;
}
//# sourceMappingURL=paylink.js.map