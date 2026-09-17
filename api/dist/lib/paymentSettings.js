import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { paymentSettings, businesses, accounts } from '../db/schema.js';
import { decryptSecret } from './secretbox.js';
import { payfastSupports } from './currency.js';
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
 * reason equally on purpose: not set up, switched off, a currency PayFast cannot
 * settle, or a rotated PAYMENTS_SECRET that can no longer decrypt what is stored.
 * None of them should take a payment.
 */
export async function credsFor(accountId, businessId, currency) {
    // PayFast settles rand only. Checking here rather than at each call site means
    // every path that could take money (pay link, public pay page, portal checkout,
    // auto-debit) is closed by one line: PayFast would otherwise happily charge the
    // number as rand, so a $200 invoice becomes a R200 payment and the invoice is
    // marked settled.
    if (currency !== undefined && !payfastSupports(currency))
        return null;
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
export async function gatewayModeFor(accountId, businessIds) {
    const [rows, bizRows, [acct]] = await Promise.all([
        db.select().from(paymentSettings).where(eq(paymentSettings.accountId, accountId)),
        db.select({ id: businesses.id, name: businesses.name, currency: businesses.currency })
            .from(businesses).where(eq(businesses.accountId, accountId)),
        db.select({ currency: accounts.currency }).from(accounts).where(eq(accounts.id, accountId)).limit(1),
    ]);
    const workspaceRow = rows.find((r) => r.businessId === 0) ?? null;
    const wanted = businessIds ? bizRows.filter((b) => businessIds.includes(b.id)) : bizRows;
    // A workspace with no business of its own still has the workspace gateway.
    const targets = wanted.length
        ? wanted
        : (businessIds ? [] : [{ id: 0, name: null, currency: null }]);
    const usable = (row, currency) => {
        if (!row?.enabled || !row.merchantId || !row.merchantKeyEnc)
            return false;
        if (!payfastSupports(currency ?? acct?.currency))
            return false;
        try {
            decryptSecret(row.merchantKeyEnc);
        }
        catch {
            return false;
        }
        return true;
    };
    const out = { live: false, test: false, testLabel: null, testScope: null };
    for (const b of targets) {
        const own = b.id ? rows.find((r) => r.businessId === b.id) ?? null : null;
        const row = own ?? workspaceRow;
        if (!usable(row, b.currency))
            continue;
        if (row.sandbox) {
            out.test = true;
            if (!out.testScope) {
                out.testLabel = b.name;
                out.testScope = own ? 'own' : 'workspace';
            }
        }
        else {
            out.live = true;
        }
    }
    return out;
}
//# sourceMappingURL=paymentSettings.js.map