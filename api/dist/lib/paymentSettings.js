import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { paymentSettings } from '../db/schema.js';
import { decryptSecret } from './secretbox.js';
export async function settingsFor(accountId, businessId) {
    if (businessId) {
        const [own] = await db.select().from(paymentSettings)
            .where(and(eq(paymentSettings.accountId, accountId), eq(paymentSettings.businessId, businessId)))
            .limit(1);
        if (own)
            return own;
    }
    const [fallback] = await db.select().from(paymentSettings)
        .where(and(eq(paymentSettings.accountId, accountId), eq(paymentSettings.businessId, 0)))
        .limit(1);
    return fallback ?? null;
}
/** Where a business's settings actually come from, for showing in the UI. */
export async function scopeOf(accountId, businessId) {
    const [own] = await db.select({ id: paymentSettings.id }).from(paymentSettings)
        .where(and(eq(paymentSettings.accountId, accountId), eq(paymentSettings.businessId, businessId)))
        .limit(1);
    if (own)
        return 'own';
    const [ws] = await db.select({ id: paymentSettings.id }).from(paymentSettings)
        .where(and(eq(paymentSettings.accountId, accountId), eq(paymentSettings.businessId, 0)))
        .limit(1);
    return ws ? 'workspace' : 'none';
}
/**
 * Usable, decrypted credentials for this business, or null. Null covers every
 * reason equally on purpose: not set up, switched off, or a rotated PAYMENTS_SECRET
 * that can no longer decrypt what is stored. None of them should take a payment.
 */
export async function credsFor(accountId, businessId) {
    const row = await settingsFor(accountId, businessId);
    if (!row || !row.enabled || !row.merchantId || !row.merchantKeyEnc)
        return null;
    try {
        return {
            merchantId: row.merchantId,
            merchantKey: decryptSecret(row.merchantKeyEnc),
            passphrase: row.passphraseEnc ? decryptSecret(row.passphraseEnc) : null,
            sandbox: row.sandbox,
        };
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=paymentSettings.js.map