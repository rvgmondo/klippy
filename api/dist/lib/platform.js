import { and, asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users, memberships, accounts } from '../db/schema.js';
import { authOf } from './context.js';
/**
 * Is this request the PLATFORM operator (you), rather than a customer signed into
 * their own workspace?
 *
 * The daily jobs and their on/off switches are global: one billing run sweeps every
 * account, and one `job_runs.enabled` flag turns a job off for everyone. So forcing
 * a job to run, or disabling one, is not a per-tenant setting. It is the platform's,
 * and it must never be reachable by a customer, who could otherwise switch off the
 * billing that invoices every other customer, or fire hosting suspensions across the
 * whole platform off-schedule.
 *
 * Who counts as the operator:
 *  - anyone whose id is in PLATFORM_ADMIN_USER_IDS (comma separated), or whose email
 *    is in PLATFORM_ADMIN_EMAILS; failing that,
 *  - the owner of the oldest account, which is the workspace that first installed
 *    Klippy. That keeps a single-operator install working with no configuration, and
 *    the moment a second workspace exists it is already locked out. Set the env once
 *    you onboard anyone, so the operator is named rather than inferred.
 */
export async function isPlatformAdmin(req) {
    const { userId } = authOf(req);
    const idList = (process.env.PLATFORM_ADMIN_USER_IDS ?? '')
        .split(',').map((s) => s.trim()).filter(Boolean).map(Number).filter((n) => Number.isFinite(n));
    if (idList.includes(userId))
        return true;
    const emailList = (process.env.PLATFORM_ADMIN_EMAILS ?? '')
        .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (emailList.length) {
        const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
        if (u && emailList.includes(u.email.toLowerCase()))
            return true;
    }
    // No allowlist configured: fall back to the owner of the oldest account. Only ever
    // reached when neither env is set, so a configured allowlist is authoritative.
    if (idList.length === 0 && emailList.length === 0) {
        const [firstAccount] = await db.select({ id: accounts.id }).from(accounts)
            .orderBy(asc(accounts.id)).limit(1);
        if (firstAccount) {
            const [m] = await db.select({ role: memberships.role }).from(memberships)
                .where(and(eq(memberships.accountId, firstAccount.id), eq(memberships.userId, userId)))
                .limit(1);
            if (m?.role === 'owner')
                return true;
        }
    }
    return false;
}
//# sourceMappingURL=platform.js.map