import { and, eq, ne } from 'drizzle-orm';
import { db } from '../db/client.js';
import { documents } from '../db/schema.js';
import { tenantWhere } from './tenant.js';
import { balanceOf } from './balances.js';
import { onInvoicePaid } from './hosting.js';
/**
 * "Is this invoice covered now, and if so mark it paid."
 *
 * Four places used to answer this by hand, and two of them answered it wrong: the
 * PayFast webhook and auto-debit both summed the payment rows and compared that to
 * the invoice's face value, with no term for credit notes. Since both the pay link
 * and the portal deliberately charge the OUTSTANDING amount (payments.ts, which uses
 * balanceOf), any invoice carrying a credit note was charged the credited-down
 * figure and then tested against the full one. The test could never pass. The client
 * paid in full, the invoice stayed 'sent' forever, the reminder job kept chasing
 * them for the whole face value, and onInvoicePaid never ran, so whatever they had
 * just bought was never set up.
 *
 * So the decision lives here once, on top of balanceOf, which is the authoritative
 * calculation and already subtracts non-void credit notes.
 *
 * Two details worth keeping:
 *
 *  - The flip to 'paid' is a CLAIM, conditional on the row not already being paid,
 *    and onInvoicePaid only runs if this call is the one that won it. Two ITNs can
 *    arrive at once; without the claim both would provision the same purchase twice.
 *  - Provisioning requires money to have actually arrived. An invoice written off
 *    entirely by a credit note is settled and should read as paid, but nobody paid
 *    for anything, so it must not start a hosting account. That asymmetry is the
 *    reason for the `bal.paid` check and it is not obvious from the call sites.
 */
export async function settleIfCovered(accountId, docId, total, currentStatus) {
    const bal = await balanceOf(accountId, docId, total);
    const settled = bal.outstanding <= 0.001;
    if (!settled || currentStatus === 'paid')
        return { bal, settled, flipped: false };
    const claim = await db.update(documents).set({ status: 'paid' })
        .where(and(tenantWhere(documents, accountId, eq(documents.id, docId)), ne(documents.status, 'paid')));
    const flipped = !!claim[0].affectedRows;
    if (flipped && bal.paid > 0.001)
        await onInvoicePaid(accountId, docId);
    return { bal, settled, flipped };
}
//# sourceMappingURL=settle.js.map