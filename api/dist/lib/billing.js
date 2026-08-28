import { eq, isNull } from 'drizzle-orm';
import { money } from './money.js';
import { formatMoney, roundMoney } from './currency.js';
import { currencyFor } from './currencyFor.js';
import { taxRateFor } from './taxRateFor.js';
import { db } from '../db/client.js';
import { documents, documentLines, accounts, businesses, offerings, folders } from '../db/schema.js';
import { tenantWhere, withTenant } from './tenant.js';
import { nextNumberFor } from './numbering.js';
import { sendBusinessMail, emailBrandFor } from './mailer.js';
import { renderEmail, renderEmailText } from './emailLayout.js';
import { payLinkFor } from './paylink.js';
import { renderDocumentPdf } from './pdf.js';
/**
 * Next billing date, one month on.
 *
 * Two traps this avoids, both of which quietly cost real money:
 *  1. Naive month arithmetic OVERFLOWS: 31 Jan + 1 month becomes 3 Mar, skipping
 *     February entirely and pushing every later bill further out.
 *  2. Clamping alone STICKS: 31 Jan -> 28 Feb -> 28 Mar, so a month-end
 *     subscription silently moves to the 28th forever.
 *
 * So we clamp against the month's length but always measure from `anchorDay` (the
 * day the subscription started), which lets it spring back:
 * 31 Jan -> 28 Feb -> 31 Mar -> 30 Apr -> 31 May.
 */
export function addOneMonth(dateStr, anchorDay) {
    return addMonths(dateStr, 1, anchorDay);
}
/**
 * The same arithmetic over any number of months, which is what lets a subscription
 * bill quarterly or annually rather than only monthly. Hosting and domains are
 * usually sold by the year, so this is the difference between Klippy being able to
 * run that business and not.
 */
export function addMonths(dateStr, months, anchorDay) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const day = anchorDay ?? d;
    const step = Math.max(1, Math.round(months));
    // First of the target month, then clamp the anchor day to that month's length.
    const target = new Date(Date.UTC(y, m - 1 + step, 1));
    const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    target.setUTCDate(Math.min(day, lastDay));
    return target.toISOString().slice(0, 10);
}
/** Day-of-month a subscription bills on, taken from the date it started. */
export function anchorDayOf(startedOn) {
    return Number(startedOn.split('-')[2]);
}
/** Plain day arithmetic in UTC, so a due date never shifts with the server's zone. */
export function addDays(dateStr, days) {
    const d = new Date(`${dateStr}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}
/**
 * Turn one subscription billing cycle into an invoice, same shape as one created by
 * hand. Used when a subscription starts and by the recurring cron job.
 *
 * If the subscription is set to send itself and the client has a billing email, the
 * invoice goes out and is marked sent. Otherwise it stays a draft for review. A
 * recurring charge that still needs a human to press send every month is not really
 * recurring, which is the whole reason `autoSend` exists.
 */
export async function generateSubscriptionInvoice(accountId, sub) {
    const [offering] = await db.select().from(offerings)
        .where(tenantWhere(offerings, accountId, eq(offerings.id, sub.offeringId))).limit(1);
    // A trashed client is not a client. The row still exists (the Trash is a stamp,
    // not a delete) so this used to pass straight through and copy the deleted client's
    // name and billing email onto a fresh invoice. The nightly run gates on this too,
    // before it claims the cycle; this is the choke point that also covers the manual
    // path and anything added later.
    const [folder] = await db.select().from(folders)
        .where(tenantWhere(folders, accountId, eq(folders.id, sub.folderId), isNull(folders.deletedAt))).limit(1);
    if (!offering)
        throw new Error('Offering no longer exists.');
    if (!folder)
        throw new Error('This client is in the Trash, so no invoice was raised.');
    const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
    // Brand the invoice email from the business it belongs to, not the account.
    const [business] = await db.select({ brandName: businesses.brandName, name: businesses.name }).from(businesses)
        .where(tenantWhere(businesses, accountId, eq(businesses.id, sub.businessId))).limit(1);
    const brand = business?.brandName || business?.name || account?.brandName || 'Invoice';
    const currency = await currencyFor(accountId, sub.businessId);
    const price = roundMoney(sub.price ?? Number(offering.price), currency);
    /**
     * VAT, at the same rate the rest of the app uses.
     *
     * This used to write a hardcoded zero, so a business charging 15% on everything it
     * invoiced by hand sent out every recurring invoice with no VAT at all: the same
     * offering, at the same price, to the same client, taxed one way in month one and
     * another way forever after. The output VAT on all recurring revenue was reported
     * as nil, and where the business is registered the PDF was still headed "Tax
     * Invoice", which is not a document the client can validly claim against either.
     *
     * Offering prices are VAT-exclusive everywhere else (the editor puts offering.price
     * into a line and computeTotals adds tax on top), so tax goes on top here too.
     * Each figure is built from figures that are already rounded, the same discipline
     * as computeTotals, or the invoice does not add up in the column.
     *
     * A business with no rate set resolves to 0 and nothing about its invoices changes.
     */
    const taxRate = await taxRateFor(accountId, sub.businessId);
    const taxAmount = roundMoney(price * (taxRate / 100), currency);
    const total = roundMoney(price + taxAmount, currency);
    const issueDate = new Date().toISOString().slice(0, 10);
    const dueDate = addDays(issueDate, 7);
    // Numbering honours this business's prefix and starting number.
    const { seq, number } = await nextNumberFor(accountId, sub.businessId, 'invoice');
    const docId = await db.transaction(async (tx) => {
        const ins = await tx.insert(documents).values(withTenant(accountId, {
            type: 'invoice', seq, number, businessId: sub.businessId, folderId: sub.folderId,
            subscriptionId: sub.subscriptionId ?? null,
            clientName: folder.name, clientEmail: folder.billingEmail ?? null, clientAddress: null,
            issueDate, dueDate, currency,
            taxRate: money(taxRate), subtotal: money(price),
            taxAmount: money(taxAmount), total: money(total),
            notes: `Auto-generated for the ${offering.name} subscription.`, createdBy: sub.createdBy,
        }));
        const newId = Number(ins[0].insertId);
        await tx.insert(documentLines).values(withTenant(accountId, {
            documentId: newId, description: `${offering.name}${offering.unit ? ` (${offering.unit})` : ''}`,
            // What they are paying for, in the words already written on the offering.
            // A recurring invoice is the one a client sees most often and questions
            // least often, so a bare product name is where "what is this charge?"
            // emails come from.
            detail: offering.description || null,
            quantity: '1.00', unitPrice: money(price), amount: money(price), position: 0,
        }));
        return newId;
    });
    // Send it, if asked to and there is somewhere to send it. A failure here must not
    // lose the invoice: it stays a draft and can be sent by hand.
    if (sub.autoSend && folder.billingEmail) {
        try {
            const payLink = await payLinkFor(accountId, docId);
            // Same as a manual send: attach the invoice, but never let a render failure
            // stop the automated run.
            const pdf = await renderDocumentPdf(accountId, docId).catch(() => null);
            // Branded like every other send, so a recurring invoice does not look like
            // the one email the business did not bother with.
            const emailBrand = await emailBrandFor(accountId, sub.businessId);
            const content = {
                heading: `Invoice ${number}`,
                body: [
                    `Hi ${folder.name},`,
                    `Your invoice for ${offering.name} is attached.`,
                ],
                facts: [
                    // The total, not the bare price: with VAT on top these differ, and an
                    // email quoting one figure beside an attached invoice showing another is
                    // the kind of thing a client stops to query instead of paying.
                    ['Amount', formatMoney(total, currency)],
                    ['Due', dueDate],
                ],
                ...(payLink ? { button: { label: 'Pay online', url: payLink } } : {}),
            };
            await sendBusinessMail({
                accountId, businessId: sub.businessId, purpose: 'invoice',
                to: folder.billingEmail,
                attachments: pdf ? [{ filename: pdf.filename, content: pdf.buffer }] : undefined,
                subject: `${brand} ${number}`,
                text: renderEmailText(emailBrand, content),
                html: renderEmail(emailBrand, content),
            });
            await db.update(documents).set({ status: 'sent' })
                .where(tenantWhere(documents, accountId, eq(documents.id, docId)));
        }
        catch {
            // Left as a draft on purpose, so it is visible as unsent rather than lost.
        }
    }
    return docId;
}
//# sourceMappingURL=billing.js.map