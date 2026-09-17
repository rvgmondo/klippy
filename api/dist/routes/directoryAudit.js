import { eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { folders, documents, subscriptions, portalUsers, expenses, deals, contacts, calendarEvents, focusItems, hostingAccounts, socialAccounts, socialPosts, socialPostTargets } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere } from '../lib/tenant.js';
/**
 * The directory pre-flight audit. READ-ONLY, and nothing else.
 *
 * Klippy has no customer record: a customer is a top-level folder, the same kind of
 * row as an internal "Admin" or "Finance" area. The plan in docs/organisation-model.md
 * turns customers into a record of their own, and every step of that plan backfills
 * from folders. Each backfill is wrong for at least one of the states below, and every
 * one of those states is reachable today because nothing ever enforced it.
 *
 * So before any of that is built, this reports how much of each exists in a real
 * workspace, for a person to read. It changes nothing, writes nothing and fixes
 * nothing. Deciding what a row means is the reader's job, not this route's.
 *
 * Owners and admins only: it lists every client's billing details at once.
 *
 * Every list is capped and says so. A report that quietly shows the first 200 of 900
 * rows reads as "that is all of them", which is the one lie an audit must not tell.
 */
const CAP = 200;
const capped = (key, title, why, rows) => ({
    key, title, why, count: rows.length, shown: Math.min(rows.length, CAP), rows: rows.slice(0, CAP),
});
export async function directoryAuditRoutes(app) {
    app.addHook('preHandler', app.requireAuth);
    app.get('/api/v1/admin/directory-audit', async (req, reply) => {
        const { accountId, role } = authOf(req);
        if (role === 'member') {
            return reply.code(403).send({ error: 'Only workspace owners and admins can run the directory audit.' });
        }
        const allFolders = await db.select({
            id: folders.id, parentId: folders.parentId, name: folders.name, businessId: folders.businessId,
            pillar: folders.pillar, deletedAt: folders.deletedAt,
            billingEmail: folders.billingEmail, billingPhone: folders.billingPhone,
            billingVatNumber: folders.billingVatNumber, billingAddress: folders.billingAddress,
            hourlyRate: folders.hourlyRate, legalName: folders.legalName, regNumber: folders.regNumber,
            paymentTermsDays: folders.paymentTermsDays, primaryContactId: folders.primaryContactId,
        }).from(folders).where(tenantWhere(folders, accountId));
        const byId = new Map(allFolders.map((f) => [f.id, f]));
        /** Walk up to the top-level folder. Bounded, because a cycle must not hang a request. */
        const rootOf = (id) => {
            let cur = id;
            for (let i = 0; i < 100 && cur != null; i++) {
                const f = byId.get(cur);
                if (!f)
                    return null;
                if (f.parentId == null)
                    return f.id;
                cur = f.parentId;
            }
            return null;
        };
        const [docRefs, subRefs, portalRows] = await Promise.all([
            db.select({ folderId: documents.folderId }).from(documents)
                .where(tenantWhere(documents, accountId, isNotNull(documents.folderId))),
            db.select({ folderId: subscriptions.folderId }).from(subscriptions)
                .where(tenantWhere(subscriptions, accountId)),
            db.select({ id: portalUsers.id, folderId: portalUsers.folderId, email: portalUsers.email,
                isActive: portalUsers.isActive, createdAt: portalUsers.createdAt })
                .from(portalUsers).where(tenantWhere(portalUsers, accountId)),
        ]);
        const referenced = new Set([
            ...docRefs.map((r) => r.folderId).filter((x) => x != null),
            ...subRefs.map((r) => r.folderId),
            ...portalRows.map((r) => r.folderId),
        ]);
        // (a) The one to lose sleep over: a real client filed as internal work. Its hours
        // drop out of every client rollup and any backfill keyed on pillar would miss it.
        const a = allFolders
            .filter((f) => f.parentId == null && f.pillar === 'operations' && !f.deletedAt
            && (f.billingEmail != null || referenced.has(f.id)))
            .map((f) => ({
            folderId: f.id, name: f.name, businessId: f.businessId,
            hasBillingEmail: f.billingEmail != null,
            invoicedOrPortal: referenced.has(f.id),
        }));
        // (b) Billing and company details sitting on a subfolder. The folder PATCH route
        // accepts them on any folder id with no root check, so they exist, and a backfill
        // that reads only top-level folders would silently drop them.
        const BILLING_KEYS = ['billingEmail', 'billingPhone', 'billingVatNumber', 'billingAddress',
            'hourlyRate', 'legalName', 'regNumber', 'paymentTermsDays', 'primaryContactId'];
        const b = allFolders
            .filter((f) => f.parentId != null && !f.deletedAt)
            .map((f) => ({ f, set: BILLING_KEYS.filter((k) => f[k] != null) }))
            .filter(({ set }) => set.length > 0)
            .map(({ f, set }) => ({
            folderId: f.id, name: f.name, rootFolderId: rootOf(f.id),
            rootName: byId.get(rootOf(f.id) ?? -1)?.name ?? null, fieldsSet: set,
        }));
        // (c) Records with no client. Counted, never guessed at: many are legitimate (a one-off
        // invoice typed for somebody with no folder, an overhead expense), and the rest cannot
        // be told apart from them by anything stored.
        const [docOrphans, expenseOrphans] = await Promise.all([
            db.select({ id: documents.id, number: documents.number, type: documents.type,
                clientName: documents.clientName, status: documents.status })
                .from(documents).where(tenantWhere(documents, accountId, isNull(documents.folderId))),
            db.select({ id: expenses.id, description: expenses.description })
                .from(expenses).where(tenantWhere(expenses, accountId, isNull(expenses.folderId))),
        ]);
        // (d) The same email with more than one portal login once folders are mapped to their
        // top-level client. The one-login-per-customer index cannot exist until this is zero.
        const byRootEmail = new Map();
        for (const p of portalRows) {
            const root = rootOf(p.folderId);
            const key = `${root ?? `orphan:${p.folderId}`}|${p.email.trim().toLowerCase()}`;
            byRootEmail.set(key, [...(byRootEmail.get(key) ?? []), p]);
        }
        const d = [...byRootEmail.entries()]
            .filter(([, list]) => list.length > 1)
            .map(([key, list]) => {
            const [root, email] = key.split('|');
            return {
                rootFolderId: root?.startsWith('orphan:') ? null : Number(root),
                email, logins: list.length,
                portalUserIds: list.map((p) => p.id),
                activeLogins: list.filter((p) => p.isActive).length,
            };
        });
        // (e) Two top-level folders with the same name in one business. Listed only. Two real
        // clients can share a name, so nothing here should ever be merged automatically.
        const byBizName = new Map();
        for (const f of allFolders.filter((x) => x.parentId == null && !x.deletedAt)) {
            const key = `${f.businessId ?? 'none'}|${f.name.trim().toLowerCase()}`;
            byBizName.set(key, [...(byBizName.get(key) ?? []), f]);
        }
        const e = [...byBizName.values()]
            .filter((list) => list.length > 1)
            .map((list) => ({
            name: list[0].name, businessId: list[0].businessId,
            folderIds: list.map((f) => f.id), pillars: list.map((f) => f.pillar),
        }));
        // (f) deals.contact_id has no foreign key, so it can point at a contact that no longer
        // exists. Any of these would make adding that key fail.
        const [dealRows, contactIds] = await Promise.all([
            db.select({ id: deals.id, title: deals.title, contactId: deals.contactId })
                .from(deals).where(tenantWhere(deals, accountId, isNotNull(deals.contactId))),
            db.select({ id: contacts.id }).from(contacts).where(tenantWhere(contacts, accountId)),
        ]);
        const known = new Set(contactIds.map((c) => c.id));
        const f = dealRows
            .filter((r) => r.contactId != null && !known.has(r.contactId))
            .map((r) => ({ dealId: r.id, title: r.title, missingContactId: r.contactId }));
        /**
         * (g) Records that belong to NO business.
         *
         * The precondition for treating a one-business workspace as simply that business.
         * Contacts made while "All businesses" was selected are stored with no business, and
         * a list filtered by business excludes them, so switching the workspace over without
         * first assigning them would make them vanish from Contacts. The dev database has
         * none; whether a real workspace does is what this answers.
         *
         * The events audit log is left out on purpose: a workspace-wide event legitimately
         * has no business.
         */
        const [nbContacts, nbDocs, nbDeals, nbFolders, nbEvents, nbFocus, nbHosting] = await Promise.all([
            db.select({ id: contacts.id, label: contacts.name }).from(contacts)
                .where(tenantWhere(contacts, accountId, isNull(contacts.businessId))),
            db.select({ id: documents.id, label: documents.number }).from(documents)
                .where(tenantWhere(documents, accountId, isNull(documents.businessId))),
            db.select({ id: deals.id, label: deals.title }).from(deals)
                .where(tenantWhere(deals, accountId, isNull(deals.businessId))),
            db.select({ id: folders.id, label: folders.name }).from(folders)
                .where(tenantWhere(folders, accountId, isNull(folders.businessId), isNull(folders.deletedAt))),
            db.select({ id: calendarEvents.id, label: calendarEvents.title }).from(calendarEvents)
                .where(tenantWhere(calendarEvents, accountId, isNull(calendarEvents.businessId))),
            db.select({ id: focusItems.id, label: focusItems.title }).from(focusItems)
                .where(tenantWhere(focusItems, accountId, isNull(focusItems.businessId))),
            db.select({ id: hostingAccounts.id, label: hostingAccounts.domain }).from(hostingAccounts)
                .where(tenantWhere(hostingAccounts, accountId, isNull(hostingAccounts.businessId))),
        ]);
        const tag = (kind, rows) => rows.map((r) => ({ kind, id: r.id, label: r.label }));
        const g = [
            ...tag('contact', nbContacts), ...tag('document', nbDocs), ...tag('deal', nbDeals),
            ...tag('client or folder', nbFolders), ...tag('meeting', nbEvents),
            ...tag('focus item', nbFocus), ...tag('hosting account', nbHosting),
        ];
        /**
         * (h) Social posts on a business with more than one account connected on one network.
         *
         * Until 2026-09 every save re-picked which account a post went to, last one wins, so a
         * post in this state may have been moved from the Page it was written for to another,
         * possibly another client's. Saves no longer move them, but nothing can tell a moved
         * post from one that was right all along. Listed for a person to check, never fixed.
         */
        const connectedAccounts = await db.select({
            id: socialAccounts.id, businessId: socialAccounts.businessId, network: socialAccounts.network,
            displayName: socialAccounts.displayName,
        }).from(socialAccounts).where(tenantWhere(socialAccounts, accountId, eq(socialAccounts.status, 'connected')));
        const perBizNetwork = new Map();
        for (const a of connectedAccounts) {
            const key = `${a.businessId}|${a.network}`;
            perBizNetwork.set(key, [...(perBizNetwork.get(key) ?? []), a]);
        }
        const crowded = [...perBizNetwork.entries()].filter(([, list]) => list.length > 1);
        const crowdedBiz = [...new Set(crowded.map(([k]) => Number(k.split('|')[0])))];
        const openTargets = crowdedBiz.length ? await db.select({
            postId: socialPosts.id, title: socialPosts.title, status: socialPosts.status, businessId: socialPosts.businessId,
            scheduledAt: socialPosts.scheduledAt, network: socialPostTargets.network, socialAccountId: socialPostTargets.socialAccountId,
        }).from(socialPostTargets)
            .innerJoin(socialPosts, eq(socialPosts.id, socialPostTargets.postId))
            .where(tenantWhere(socialPostTargets, accountId, eq(socialPosts.accountId, accountId), inArray(socialPosts.businessId, crowdedBiz), inArray(socialPosts.status, ['draft', 'needs_media', 'awaiting_approval', 'approved', 'scheduled', 'failed', 'needs_manual']))) : [];
        const h = openTargets
            .filter((t) => (perBizNetwork.get(`${t.businessId}|${t.network}`)?.length ?? 0) > 1)
            .map((t) => ({
            postId: t.postId, title: t.title, status: t.status, businessId: t.businessId, network: t.network,
            scheduledAt: t.scheduledAt,
            goesTo: connectedAccounts.find((a) => a.id === t.socialAccountId)?.displayName ?? null,
            connected: perBizNetwork.get(`${t.businessId}|${t.network}`).map((a) => a.displayName),
        }));
        const checks = [
            capped('a', 'Clients filed as internal work', 'A top-level Operations folder that has a billing email, an invoice, a repeating invoice or a portal login is almost certainly a real client. Its hours are missing from client reports today.', a),
            capped('b', 'Billing or company details on a subfolder', 'These belong to the top-level client. Decide which values are right before customers become their own record, or they will be lost.', b),
            capped('c-documents', 'Quotes and invoices with no client', 'Some are one-off documents typed for somebody with no client folder, which is fine. Others lost their client in a past delete. They cannot be told apart automatically.', docOrphans),
            capped('c-expenses', 'Expenses with no client', 'Usually general overhead, which is fine. Listed so none that belonged to a client are missed.', expenseOrphans),
            capped('d', 'One email with several portal logins for the same client', 'Must be zero before each customer can have exactly one login per email. The fix keeps the oldest login and switches the rest off. No login is ever deleted.', d),
            capped('e', 'Two clients with the same name in one business', 'Could be a duplicate, or two genuinely different clients. Never merged automatically.', e),
            capped('f', 'Deals pointing at a contact that no longer exists', 'These would stop the link between deals and contacts being tightened.', f),
            capped('g', 'Records that belong to no business', 'Usually created while "All businesses" was selected. They disappear from any list filtered to one business, so each needs a business before a one-business workspace is treated as that business.', g),
            capped('h', 'Social posts on a business with several accounts on one network', 'Saving a post used to switch it to whichever of those accounts came last. Check each one is going to the Page it was written for.', h),
        ];
        return {
            generatedAt: new Date().toISOString(),
            readOnly: true,
            rowCap: CAP,
            summary: checks.map((c) => ({ key: c.key, title: c.title, count: c.count })),
            checks,
        };
    });
}
//# sourceMappingURL=directoryAudit.js.map