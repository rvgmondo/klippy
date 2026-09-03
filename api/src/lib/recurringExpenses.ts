import { and, eq, lte, isNull, or, gte } from 'drizzle-orm';
import { db } from '../db/client.js';
import { recurringExpenses, expenses } from '../db/schema.js';
import { isDuplicateKey, tenantWhere, withTenant } from './tenant.js';
import { addMonths, anchorDayOf } from './billing.js';

/**
 * Writing the costs that repeat.
 *
 * The rules, and each one exists because of a way this goes wrong:
 *
 *  1. CATCH UP, DO NOT SKIP. A cost due in March, April and May while nobody ran the
 *    job writes three expenses, not one. Advancing straight to today would silently
 *    lose two months of real spending, and nothing would ever say so.
 *  2. NEVER WRITE THE SAME MONTH TWICE. A unique index on (recurringExpenseId,
 *    incurredOn) decides that, not a remembered check, so a job that runs twice at
 *    once is harmless.
 *  3. DATE IT WHEN IT WAS DUE, NOT WHEN THE JOB RAN. An expense that arrives late must
 *    still land in the month it belongs to, or the VAT period and the profit for that
 *    month are both wrong.
 *  4. THE MONTH ANCHOR NEVER DRIFTS. A cost on the 31st does not walk backwards to the
 *    28th after February. Same anchored arithmetic the billing cron uses, so the two
 *    never disagree about what "monthly" means.
 */

/** How far back a first run will reach, so a badly dated record cannot write years. */
const MAX_CATCHUP = 24;

const todayStr = () => new Date().toISOString().slice(0, 10);

export interface GenerateResult { written: number; skipped: number }

/**
 * Bring one standing cost up to date.
 *
 * Exported on its own so a person pressing "record it now" runs exactly the same code
 * as the nightly job. Two paths that both write money are two chances to disagree.
 */
export async function generateFor(
  accountId: number, row: typeof recurringExpenses.$inferSelect, today = todayStr(),
): Promise<GenerateResult> {
  let written = 0;
  let skipped = 0;
  let due = row.nextDueOn;
  const anchor = anchorDayOf(row.startedOn);

  for (let i = 0; i < MAX_CATCHUP && due <= today; i++) {
    // A cost that has ended stops on its end date, and the record is switched off so
    // it is not walked again every night forever.
    if (row.endsOn && due > row.endsOn) break;

    try {
      await db.insert(expenses).values(withTenant(accountId, {
        businessId: row.businessId,
        description: row.description,
        category: row.category,
        amount: row.amount,
        vatAmount: row.vatAmount,
        // Rule 3: the date it was due, not the date this ran.
        incurredOn: due,
        recurringExpenseId: row.id,
        createdBy: row.createdBy,
      } as never));
      written++;
    } catch (err) {
      // Rule 2. Already recorded for that date, so move on rather than fail the run.
      if (!isDuplicateKey(err)) throw err;
      skipped++;
    }
    due = addMonths(due, row.intervalMonths, anchor);
  }

  const finished = !!(row.endsOn && due > row.endsOn);
  await db.update(recurringExpenses).set({
    nextDueOn: due,
    lastGeneratedOn: written > 0 ? today : row.lastGeneratedOn,
    ...(finished ? { isActive: false } : {}),
  }).where(tenantWhere(recurringExpenses, accountId, eq(recurringExpenses.id, row.id)));

  return { written, skipped };
}

/** Every standing cost that has come due, across every workspace. The nightly job. */
export async function runRecurringExpenses(): Promise<string> {
  const today = todayStr();
  const rows = await db.select().from(recurringExpenses)
    .where(and(
      eq(recurringExpenses.isActive, true),
      lte(recurringExpenses.nextDueOn, today),
      // Not yet ended, or with no end at all.
      or(isNull(recurringExpenses.endsOn), gte(recurringExpenses.endsOn, today)),
    ));

  let written = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const res = await generateFor(row.accountId, row, today);
      written += res.written;
    } catch {
      // One broken record must not stop the rest. It stays due, so the next run
      // retries it rather than losing the month.
      failed++;
    }
  }
  return `${written} recurring expense(s) recorded${failed ? `, ${failed} failed` : ''}`;
}
