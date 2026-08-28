import { z } from 'zod';
import { eq, isNull, isNotNull, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { folders, boards, subscriptions } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere } from '../lib/tenant.js';
import { accessibleBusinessIds, assertMaybeBusiness } from '../lib/access.js';
import { liveHostingForFolders } from '../lib/hosting.js';
import { subtreeIds } from '../lib/folderTree.js';
import { addMonths, anchorDayOf } from '../lib/billing.js';
/**
 * The Trash: where deleted clients and boards wait out their 30 days.
 *
 * Delete used to be a hard DELETE behind a confirm dialog, which is to say one
 * misread dialog away from a client's whole history (boards, cards, time) being
 * unrecoverable. Deletes now stamp `deletedAt` instead; trashed things vanish
 * from every list, search and count, sit here restorable for 30 days, and the
 * nightly housekeeping hard-deletes what nobody came back for.
 *
 * The listing shows only the ROOTS of what was deleted: deleting a client folder
 * trashes its whole subtree with one stamp, and restoring the root restores
 * exactly the rows carrying that stamp, so a board someone deleted separately
 * last week stays deleted when this week's folder mistake is undone.
 */
export async function trashRoutes(app) {
    app.addHook('preHandler', app.requireAuth);
    app.get('/api/v1/trash', async (req) => {
        const { accountId } = authOf(req);
        const allowed = await accessibleBusinessIds(req);
        const canSee = (bid) => allowed === null || bid == null || allowed.has(bid);
        const fRows = await db.select({
            id: folders.id, name: folders.name, parentId: folders.parentId,
            businessId: folders.businessId, deletedAt: folders.deletedAt,
        }).from(folders).where(tenantWhere(folders, accountId, isNotNull(folders.deletedAt)));
        const deletedFolderIds = new Set(fRows.map((f) => f.id));
        const bRows = await db.select({
            id: boards.id, name: boards.name, folderId: boards.folderId, deletedAt: boards.deletedAt,
            folderName: folders.name, businessId: folders.businessId,
        }).from(boards)
            .leftJoin(folders, eq(folders.id, boards.folderId))
            .where(tenantWhere(boards, accountId, isNotNull(boards.deletedAt), isNull(folders.deletedAt)));
        const daysLeft = (d) => Math.max(0, 30 - Math.floor((Date.now() - d.getTime()) / 86_400_000));
        const items = [
            ...fRows
                .filter((f) => (f.parentId == null || !deletedFolderIds.has(f.parentId)) && canSee(f.businessId))
                .map((f) => ({
                kind: 'folder', id: f.id, name: f.name,
                detail: null,
                deletedAt: f.deletedAt.toISOString(), daysLeft: daysLeft(f.deletedAt),
            })),
            ...bRows
                .filter((b) => canSee(b.businessId ?? null))
                .map((b) => ({
                kind: 'board', id: b.id, name: b.name,
                detail: b.folderName,
                deletedAt: b.deletedAt.toISOString(), daysLeft: daysLeft(b.deletedAt),
            })),
        ].sort((a, z2) => z2.deletedAt.localeCompare(a.deletedAt));
        return { items };
    });
    const targetSchema = z.object({
        kind: z.enum(['folder', 'board']),
        id: z.number().int().positive(),
    });
    app.post('/api/v1/trash/restore', async (req, reply) => {
        const { accountId } = authOf(req);
        const parsed = targetSchema.safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: 'kind and id required.' });
        const { kind, id } = parsed.data;
        if (kind === 'folder') {
            const [f] = await db.select({ businessId: folders.businessId, deletedAt: folders.deletedAt })
                .from(folders).where(tenantWhere(folders, accountId, eq(folders.id, id))).limit(1);
            if (!f || !f.deletedAt)
                return reply.code(404).send({ error: 'Not in the trash.' });
            if (!(await assertMaybeBusiness(req, reply, f.businessId)))
                return;
            // Only rows stamped in the same delete come back: a board trashed separately
            // before the folder was stays where its own delete put it.
            const ids = await subtreeIds(accountId, id);
            await db.update(folders).set({ deletedAt: null })
                .where(tenantWhere(folders, accountId, inArray(folders.id, ids), eq(folders.deletedAt, f.deletedAt)));
            await db.update(boards).set({ deletedAt: null })
                .where(tenantWhere(boards, accountId, inArray(boards.folderId, ids), eq(boards.deletedAt, f.deletedAt)));
            /**
             * Roll any frozen billing schedule forward before the client goes live again.
             *
             * Billing skips a trashed client, so nextBillDate stays where it was. Restoring
             * without this hands the biller a date weeks in the past, and it raises one
             * back-invoice per daily run, each of which goes straight to auto-debit: a
             * client trashed for forty days and restored gets several card debits inside a
             * day. The per-invoice idempotency guard does not help, because each catch-up
             * cycle is a different invoice.
             *
             * Cycles spent in the Trash are forgiven. If they genuinely should be billed,
             * that is a person raising them from the Subscriptions screen where they can
             * see the amount first.
             */
            const today = new Date().toISOString().slice(0, 10);
            const frozen = await db.select({
                id: subscriptions.id, nextBillDate: subscriptions.nextBillDate,
                intervalMonths: subscriptions.intervalMonths, startedOn: subscriptions.startedOn,
            }).from(subscriptions)
                .where(tenantWhere(subscriptions, accountId, inArray(subscriptions.folderId, ids), eq(subscriptions.status, 'active')));
            for (const s of frozen) {
                if (s.nextBillDate >= today)
                    continue;
                const anchor = anchorDayOf(s.startedOn);
                let next = s.nextBillDate;
                // Bounded: 600 monthly cycles is fifty years, far past any real gap.
                for (let i = 0; i < 600 && next < today; i++)
                    next = addMonths(next, s.intervalMonths, anchor);
                await db.update(subscriptions).set({ nextBillDate: next })
                    .where(tenantWhere(subscriptions, accountId, eq(subscriptions.id, s.id)));
            }
            return { ok: true };
        }
        const [b] = await db.select({ deletedAt: boards.deletedAt, businessId: folders.businessId })
            .from(boards).leftJoin(folders, eq(folders.id, boards.folderId))
            .where(tenantWhere(boards, accountId, eq(boards.id, id))).limit(1);
        if (!b || !b.deletedAt)
            return reply.code(404).send({ error: 'Not in the trash.' });
        if (!(await assertMaybeBusiness(req, reply, b.businessId ?? null)))
            return;
        await db.update(boards).set({ deletedAt: null })
            .where(tenantWhere(boards, accountId, eq(boards.id, id)));
        return { ok: true };
    });
    /** The real, unrecoverable delete. Only offered from inside the Trash. */
    app.post('/api/v1/trash/purge', async (req, reply) => {
        const { accountId } = authOf(req);
        const parsed = targetSchema.safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: 'kind and id required.' });
        const { kind, id } = parsed.data;
        if (kind === 'folder') {
            const [f] = await db.select({ businessId: folders.businessId, deletedAt: folders.deletedAt })
                .from(folders).where(tenantWhere(folders, accountId, eq(folders.id, id))).limit(1);
            if (!f || !f.deletedAt)
                return reply.code(404).send({ error: 'Not in the trash.' });
            if (!(await assertMaybeBusiness(req, reply, f.businessId)))
                return;
            /**
             * Refuse while anything is still live on the server.
             *
             * Deleting the client cascades away its subscriptions, and the FK then nulls
             * hosting_accounts.subscription_id. The overdue sweep skips a null one for
             * good, so the site keeps serving and can never be invoiced again: free
             * hosting, indefinitely, with only a blank client name on the Hosting screen
             * to show for it.
             *
             * Refusing rather than suspending is deliberate. Suspending takes a paying
             * client's website and mail dark, and this route is reachable by a member
             * while suspending by hand is admin-only, so switching it off here would route
             * around that. Refusing needs no privilege and destroys nothing.
             */
            const ids = await subtreeIds(accountId, id);
            const live = await liveHostingForFolders(accountId, ids);
            if (live.length) {
                const names = [...new Set(live.map((h) => h.domain))].slice(0, 3).join(', ');
                return reply.code(409).send({
                    error: `This client still has hosting on the server (${names}). Switch it off on the Hosting screen first, then delete the client.`,
                });
            }
            await db.delete(folders).where(tenantWhere(folders, accountId, eq(folders.id, id)));
            return { ok: true };
        }
        const [b] = await db.select({ deletedAt: boards.deletedAt, businessId: folders.businessId })
            .from(boards).leftJoin(folders, eq(folders.id, boards.folderId))
            .where(tenantWhere(boards, accountId, eq(boards.id, id))).limit(1);
        if (!b || !b.deletedAt)
            return reply.code(404).send({ error: 'Not in the trash.' });
        if (!(await assertMaybeBusiness(req, reply, b.businessId ?? null)))
            return;
        await db.delete(boards).where(tenantWhere(boards, accountId, eq(boards.id, id)));
        return { ok: true };
    });
}
//# sourceMappingURL=trash.js.map