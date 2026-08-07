import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { autoDebitAttempts, documents, payments, subscriptions, events, } from '../db/schema.js';
import { settingsFor } from './paymentSettings.js';
import { onInvoicePaid } from './hosting.js';
import { tenantWhere, withTenant } from './tenant.js';
import { decryptSecret } from './secretbox.js';
import { chargeToken } from './payfast.js';
async function note(accountId, businessId, outcome, detail, extra) {
    await db.insert(events).values({
        accountId, businessId, name: 'payfast.autodebit',
        payload: { outcome, detail, ...extra },
        results: [{ handler: 'payfast.autodebit', outcome: detail, ok: outcome === 'charged' || outcome === 'dry-run' }],
    }).catch(() => { });
}
export async function attemptAutoDebit(r) {
    const done = async (outcome, detail, extra = {}) => {
        await note(r.accountId, r.businessId, outcome, detail, {
            subscriptionId: r.subscriptionId, documentId: r.documentId,
            number: r.invoiceNumber, amount: r.amount.toFixed(2), ...extra,
        });
        return { outcome, detail };
    };
    // Per business, so a subscription is charged through the merchant account that
    // business actually banks into.
    const settings = await settingsFor(r.accountId, r.businessId);
    if (!settings?.enabled)
        return { outcome: 'skipped', detail: 'PayFast is not set up for this business.' };
    if (!settings.autoDebitEnabled)
        return { outcome: 'skipped', detail: 'Auto-debit is off for this business.' };
    const [sub] = await db.select().from(subscriptions)
        .where(tenantWhere(subscriptions, r.accountId, eq(subscriptions.id, r.subscriptionId))).limit(1);
    if (!sub)
        return { outcome: 'skipped', detail: 'Subscription no longer exists.' };
    if (!sub.autoDebit)
        return { outcome: 'skipped', detail: 'This subscription is not set to auto-debit.' };
    if (!sub.payfastToken) {
        return done('skipped', 'No saved card yet. The client has to pay one invoice online before a card can be stored.');
    }
    const cap = Number(settings.autoDebitMax);
    if (r.amount > cap) {
        return done('skipped', `Refused: ${r.amount.toFixed(2)} is over the ${cap.toFixed(2)} per-charge limit. Raise the limit in Settings > Payments if this is correct.`, { cap: cap.toFixed(2) });
    }
    // The claim: this invoice has not been attempted before. The unique index on
    // documentId is what enforces it, so a concurrent run loses the race rather than
    // charging alongside us.
    try {
        await db.insert(autoDebitAttempts).values(withTenant(r.accountId, {
            subscriptionId: r.subscriptionId, documentId: r.documentId,
            status: 'pending', amount: r.amount.toFixed(2),
        }));
    }
    catch {
        return { outcome: 'skipped', detail: 'Already attempted for this invoice.' };
    }
    const finish = async (status, detail, pfPaymentId) => {
        await db.update(autoDebitAttempts).set({ status, detail, pfPaymentId: pfPaymentId ?? null })
            .where(tenantWhere(autoDebitAttempts, r.accountId, eq(autoDebitAttempts.documentId, r.documentId)));
    };
    if (!settings.autoDebitLive) {
        await finish('dry-run', `Would have charged ${r.amount.toFixed(2)} for ${r.invoiceNumber}.`);
        return done('dry-run', `Dry run: would have charged ${r.amount.toFixed(2)} for ${r.invoiceNumber}. Nothing was taken. Switch on live charging when this list looks right.`);
    }
    if (!settings.merchantId || !settings.merchantKeyEnc) {
        await finish('failed', 'PayFast credentials are incomplete.');
        return done('failed', 'PayFast credentials are incomplete.');
    }
    const creds = {
        merchantId: settings.merchantId,
        merchantKey: decryptSecret(settings.merchantKeyEnc) ?? '',
        passphrase: settings.passphraseEnc ? decryptSecret(settings.passphraseEnc) : null,
        sandbox: settings.sandbox,
    };
    // Cents, not rands. Rounded once, here, so the amount charged is exactly the
    // amount written down on the attempt.
    const cents = Math.round(r.amount * 100);
    const res = await chargeToken(creds, sub.payfastToken, cents, r.itemName, `doc-${r.documentId}`);
    if (!res.ok) {
        await finish('failed', res.message);
        return done('failed', res.message);
    }
    // Record the money. PayFast also sends an ITN for this charge; that handler is
    // idempotent on the PayFast payment id, so whichever arrives second does nothing.
    const today = new Date().toISOString().slice(0, 10);
    await db.insert(payments).values(withTenant(r.accountId, {
        documentId: r.documentId, amount: r.amount.toFixed(2), paidOn: today,
        method: 'PayFast', note: res.pfPaymentId ? `PayFast ${res.pfPaymentId}` : 'PayFast auto-debit',
        createdBy: null,
    }));
    const paidRows = await db.select({ amount: payments.amount }).from(payments)
        .where(tenantWhere(payments, r.accountId, eq(payments.documentId, r.documentId)));
    const paid = paidRows.reduce((s, p) => s + Number(p.amount), 0);
    const [doc] = await db.select({ total: documents.total, status: documents.status }).from(documents)
        .where(tenantWhere(documents, r.accountId, eq(documents.id, r.documentId))).limit(1);
    if (doc && paid + 0.001 >= Number(doc.total) && doc.status !== 'paid') {
        await db.update(documents).set({ status: 'paid' })
            .where(tenantWhere(documents, r.accountId, eq(documents.id, r.documentId)));
        await onInvoicePaid(r.accountId, r.documentId);
    }
    await finish('charged', `Charged ${r.amount.toFixed(2)}.`, res.pfPaymentId);
    return done('charged', `Charged ${r.amount.toFixed(2)} for ${r.invoiceNumber}.`, { pfPaymentId: res.pfPaymentId });
}
/** Recent auto-debit attempts for an account, newest first. */
export async function recentAttempts(accountId, limit = 20) {
    return db.select().from(autoDebitAttempts)
        .where(and(eq(autoDebitAttempts.accountId, accountId)))
        .orderBy(autoDebitAttempts.id)
        .limit(limit);
}
//# sourceMappingURL=autoDebit.js.map