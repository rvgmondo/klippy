import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { memberships, users, accounts } from '../db/schema.js';
/**
 * Workspace access lives in `memberships`, never on the user row: one login can
 * belong to many workspaces with a different role in each. Every "is this person
 * allowed in this workspace" check must go through here.
 */
export async function getMembership(accountId, userId) {
    const [m] = await db.select().from(memberships)
        .where(and(eq(memberships.accountId, accountId), eq(memberships.userId, userId)))
        .limit(1);
    return m ?? null;
}
/** True when the person is an active member of the workspace. */
export async function isActiveMember(accountId, userId) {
    const m = await getMembership(accountId, userId);
    return !!m && m.isActive;
}
/** Every workspace this person can open, with their role in each. */
export async function workspacesFor(userId) {
    return db.select({
        accountId: memberships.accountId,
        role: memberships.role,
        isActive: memberships.isActive,
        name: accounts.name,
        slug: accounts.slug,
        plan: accounts.plan,
    }).from(memberships)
        .innerJoin(accounts, eq(accounts.id, memberships.accountId))
        .where(and(eq(memberships.userId, userId), eq(memberships.isActive, true)))
        .orderBy(accounts.name);
}
/** Active people in a workspace, joined to their global user record. */
export async function membersOf(accountId) {
    return db.select({
        id: users.id,
        name: users.name,
        email: users.email,
        isActive: memberships.isActive,
        role: memberships.role,
        lastLogin: users.lastLogin,
    }).from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(eq(memberships.accountId, accountId))
        .orderBy(users.name);
}
/** Add someone to a workspace (idempotent). Returns the membership role. */
export async function addMember(accountId, userId, role = 'member') {
    const existing = await getMembership(accountId, userId);
    if (existing) {
        if (!existing.isActive) {
            await db.update(memberships).set({ isActive: true, role })
                .where(eq(memberships.id, existing.id));
        }
        return existing;
    }
    await db.insert(memberships).values({ accountId, userId, role });
    return getMembership(accountId, userId);
}
//# sourceMappingURL=membership.js.map