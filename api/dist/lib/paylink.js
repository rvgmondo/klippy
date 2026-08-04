import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { paymentSettings } from '../db/schema.js';
import { appUrl } from './mailer.js';
import { signPayToken } from './secretbox.js';
/**
 * A public, signed URL where a client can pay an invoice online, or null when the
 * account has not switched PayFast on (in which case the invoice email just carries
 * the bank details instead). Used by both the manual "email this invoice" action and
 * the automatic recurring-invoice email.
 */
export async function payLinkFor(accountId, docId) {
    const [settings] = await db.select({ enabled: paymentSettings.enabled }).from(paymentSettings)
        .where(eq(paymentSettings.accountId, accountId)).limit(1);
    if (!settings?.enabled)
        return null;
    const token = signPayToken(docId);
    if (!token)
        return null;
    return `${appUrl()}/api/v1/pay/${docId}?t=${token}`;
}
//# sourceMappingURL=paylink.js.map