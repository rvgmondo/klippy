import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { accounts, businesses } from '../db/schema.js';
import { DEFAULT_CURRENCY } from './currency.js';
/**
 * What a given business bills in.
 *
 * Same rule as every other per-business setting: the business wins if it has one,
 * otherwise the workspace default. Unlike the payment gateway there is no "off"
 * state to respect, so a plain null check is the whole rule.
 *
 * Called once when a document is created and then never again: the answer is
 * copied onto the document. Changing a business's currency later must not silently
 * restate last year's invoices in a currency nobody was billed in.
 */
export async function currencyFor(accountId, businessId) {
    if (businessId) {
        const [b] = await db.select({ currency: businesses.currency }).from(businesses)
            .where(and(eq(businesses.accountId, accountId), eq(businesses.id, businessId))).limit(1);
        if (b?.currency)
            return b.currency;
    }
    const [a] = await db.select({ currency: accounts.currency }).from(accounts)
        .where(eq(accounts.id, accountId)).limit(1);
    return a?.currency || DEFAULT_CURRENCY;
}
//# sourceMappingURL=currencyFor.js.map