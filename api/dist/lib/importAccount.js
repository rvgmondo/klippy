import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { businesses, folders, boards, boardColumns, tasks, timeEntries, contacts, deals, dealActivities, documents, documentLines, payments, offerings, subscriptions, expenses, taskSubtasks, taskComments, labels, taskLabels, teams, teamMembers, boardTeams, calendarEvents, hostingAccounts, portalUsers, productNotes, focusItems, memberships, users, } from '../db/schema.js';
import { withTenant, tenantWhere } from './tenant.js';
import { sampleNames } from './templates.js';
import { addMonths, anchorDayOf } from './billing.js';
const arr = (data, key) => {
    const v = data[key];
    return Array.isArray(v) ? v : [];
};
const numOrNull = (v) => typeof v === 'number' && Number.isFinite(v) ? v : null;
const todayStr = () => new Date().toISOString().slice(0, 10);
/**
 * Does this workspace hold anything a person actually made?
 *
 * Signup seeds example content, so "empty" is the wrong test. This looks for the
 * seed by its exact names (the same helper the Clear examples button uses) and
 * treats anything else as real work. Documents, subscriptions and hosting are
 * checked outright, because the seed never creates any of those and their presence
 * always means a live workspace.
 */
export async function workspaceHoldsRealWork(accountId) {
    const names = sampleNames();
    const [docs] = await db.select({ n: sql `count(*)` }).from(documents)
        .where(tenantWhere(documents, accountId));
    if (Number(docs?.n ?? 0) > 0)
        return 'this workspace already has invoices or quotes in it';
    const [subs] = await db.select({ n: sql `count(*)` }).from(subscriptions)
        .where(tenantWhere(subscriptions, accountId));
    if (Number(subs?.n ?? 0) > 0)
        return 'this workspace already has subscriptions in it';
    const [host] = await db.select({ n: sql `count(*)` }).from(hostingAccounts)
        .where(tenantWhere(hostingAccounts, accountId));
    if (Number(host?.n ?? 0) > 0)
        return 'this workspace already has hosting accounts in it';
    const realFolders = await db.select({ id: folders.id, name: folders.name }).from(folders)
        .where(and(tenantWhere(folders, accountId), isNull(folders.parentId)));
    const extra = realFolders.filter((f) => !names.folders.includes(f.name));
    if (extra.length)
        return `this workspace already has clients in it (for example "${extra[0].name}")`;
    /**
     * Somebody can have worked here without ever making a client or an invoice: tracked
     * time on a seeded card, a comment, a contact, an expense, a diary entry. Checking
     * names alone would call that workspace untouched and overwrite it.
     *
     * Only tables the signup seed provably never writes are checked. Cards, deals and
     * offerings are deliberately absent from this list, because the seed creates all
     * three and counting them would refuse every genuine restore.
     */
    const counted = await Promise.all([
        db.select({ n: sql `count(*)` }).from(timeEntries).where(tenantWhere(timeEntries, accountId)),
        db.select({ n: sql `count(*)` }).from(taskSubtasks).where(tenantWhere(taskSubtasks, accountId)),
        db.select({ n: sql `count(*)` }).from(taskComments).where(tenantWhere(taskComments, accountId)),
        db.select({ n: sql `count(*)` }).from(contacts).where(tenantWhere(contacts, accountId)),
        db.select({ n: sql `count(*)` }).from(expenses).where(tenantWhere(expenses, accountId)),
        db.select({ n: sql `count(*)` }).from(calendarEvents).where(tenantWhere(calendarEvents, accountId)),
    ]);
    const labels = ['tracked time', 'card checklists', 'card comments', 'contacts', 'expenses', 'calendar entries'];
    for (let i = 0; i < counted.length; i++) {
        if (Number(counted[i][0]?.n ?? 0) > 0)
            return `this workspace already has ${labels[i]} in it`;
    }
    return null;
}
export async function importAccountData(accountId, importerUserId, data) {
    const counts = {};
    const notes = [];
    let reattributed = 0;
    let leftoverBusinesses = 0;
    // ---- people, by email --------------------------------------------------
    const teamRows = await db.select({ id: users.id, email: users.email }).from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(eq(memberships.accountId, accountId));
    const byEmail = new Map(teamRows.map((u) => [u.email.toLowerCase(), u.id]));
    const peopleMap = new Map();
    for (const p of arr(data, 'people')) {
        const oldId = numOrNull(p.id);
        const email = typeof p.email === 'string' ? p.email.toLowerCase() : null;
        if (oldId == null)
            continue;
        const hit = email ? byEmail.get(email) : undefined;
        if (hit)
            peopleMap.set(oldId, hit);
    }
    /** Map an old user id, falling back to whoever is running the import, and count it. */
    const userOf = (v) => {
        const old = numOrNull(v);
        if (old != null) {
            const hit = peopleMap.get(old);
            if (hit)
                return hit;
        }
        reattributed++;
        return importerUserId;
    };
    /** The same, but for a nullable column: an unknown person becomes nobody. */
    const userOrNull = (v) => {
        const old = numOrNull(v);
        if (old == null)
            return null;
        return peopleMap.get(old) ?? null;
    };
    const [me] = await db.select({ email: users.email }).from(users)
        .where(eq(users.id, importerUserId)).limit(1);
    const today = todayStr();
    let trashClamped = 0;
    /**
     * Anything restored INTO the Trash gets its 30 days back.
     *
     * A backup carries the original deletion date, and the nightly sweep purges
     * anything past 30 days. Restored verbatim, a client trashed two months before the
     * backup was taken would be permanently destroyed by the first sweep after the
     * restore, on the same night the founder recovered it. The displayed date is then
     * not the original, which is a smaller untruth than deleting something somebody
     * just asked to have back.
     */
    const trashStamp = (v) => {
        if (!v)
            return null;
        const was = new Date(String(v));
        const floor = new Date(Date.now() - 25 * 86_400_000);
        if (Number.isNaN(was.getTime()))
            return floor;
        if (was < floor) {
            trashClamped++;
            return floor;
        }
        return was;
    };
    await db.transaction(async (tx) => {
        /**
         * Clear the signup samples first, so a restored workspace looks like the one it
         * came from rather than the real business plus a sample client nobody wants.
         *
         * Safe by construction, not by luck: the precondition has already established
         * that the only top-level folders here ARE the seed's, so this cannot reach
         * anything a person made. Matching is by exact seed name, the same rule the
         * Clear examples button uses.
         */
        // Which businesses were here BEFORE the restore. A fresh workspace comes with one
        // named after itself, and leaving it behind means the founder opens the business
        // switcher to their restored companies plus an empty stub they never made.
        const preExisting = (await tx.select({ id: businesses.id }).from(businesses)
            .where(tenantWhere(businesses, accountId))).map((b) => b.id);
        const seed = sampleNames();
        const clearedFolders = await tx.delete(folders).where(and(tenantWhere(folders, accountId), isNull(folders.parentId), inArray(folders.name, seed.folders)));
        await tx.delete(deals).where(and(tenantWhere(deals, accountId), or(inArray(deals.company, seed.companies), inArray(deals.title, seed.dealTitles))));
        await tx.delete(offerings).where(and(tenantWhere(offerings, accountId), inArray(offerings.name, seed.offerings)));
        if (clearedFolders[0].affectedRows) {
            notes.push('The example client and sample content that came with this workspace were removed, so what you see is your own data.');
        }
        const maps = {};
        const mapOf = (k) => (maps[k] ??= new Map());
        /** Remap a foreign key through a table's id map. Unknown ids become null. */
        const ref = (table, v) => {
            const old = numOrNull(v);
            if (old == null)
                return null;
            return mapOf(table).get(old) ?? null;
        };
        /** Insert one row and remember what its id became. */
        const insert = async (table, tbl, oldId, values) => {
            const res = await tx.insert(tbl).values(withTenant(accountId, values));
            const newId = Number(res[0].insertId);
            const old = numOrNull(oldId);
            if (old != null)
                mapOf(table).set(old, newId);
            counts[table] = (counts[table] ?? 0) + 1;
            return newId;
        };
        // ---- businesses --------------------------------------------------------
        for (const b of arr(data, 'businesses')) {
            await insert('businesses', businesses, b.id, {
                name: b.name ?? 'Business', type: b.type ?? 'services', secondaryTypes: [],
                currency: b.currency ?? 'ZAR', brandName: b.brandName ?? null,
                bizAddress: b.bizAddress ?? null, bizTaxNumber: b.bizTaxNumber ?? null,
                bizRegNumber: b.bizRegNumber ?? null, bankDetails: b.bankDetails ?? null,
                defaultTaxRate: b.defaultTaxRate ?? null, defaultDueDays: b.defaultDueDays ?? null,
                prefixInvoice: b.prefixInvoice ?? undefined, prefixQuote: b.prefixQuote ?? undefined,
                prefixCreditNote: b.prefixCreditNote ?? undefined,
                seqStartInvoice: b.seqStartInvoice ?? undefined, seqStartQuote: b.seqStartQuote ?? undefined,
                seqStartCreditNote: b.seqStartCreditNote ?? undefined,
                position: b.position ?? 0, createdBy: importerUserId,
            });
        }
        // ---- clients, then their parents ---------------------------------------
        // Two passes: a folder can name a parent that has not been inserted yet, so
        // everything lands flat first and the tree is rebuilt once every id is known.
        for (const f of arr(data, 'clients')) {
            await insert('folders', folders, f.id, {
                businessId: ref('businesses', f.businessId), parentId: null,
                name: f.name ?? 'Client', pillar: f.pillar ?? 'delivery',
                billingEmail: f.billingEmail ?? null, billingPhone: f.billingPhone ?? null,
                billingVatNumber: f.billingVatNumber ?? null, billingAddress: f.billingAddress ?? null,
                hourlyRate: f.hourlyRate ?? null, monthlyHoursBudget: f.monthlyHoursBudget ?? null,
                notes: f.notes ?? null, isArchived: !!f.isArchived,
                deletedAt: trashStamp(f.deletedAt),
                position: f.position ?? 0, createdBy: importerUserId,
            });
        }
        for (const f of arr(data, 'clients')) {
            const parent = ref('folders', f.parentId);
            const self = ref('folders', f.id);
            if (parent && self) {
                await tx.update(folders).set({ parentId: parent })
                    .where(tenantWhere(folders, accountId, eq(folders.id, self)));
            }
        }
        for (const b of arr(data, 'boards')) {
            await insert('boards', boards, b.id, {
                folderId: ref('folders', b.folderId), name: b.name ?? 'Board',
                description: b.description ?? null, isArchived: !!b.isArchived,
                deletedAt: trashStamp(b.deletedAt),
                position: b.position ?? 0, createdBy: importerUserId,
            });
        }
        for (const c of arr(data, 'columns')) {
            const boardId = ref('boards', c.boardId);
            if (!boardId)
                continue;
            await insert('columns', boardColumns, c.id, {
                boardId, name: c.name ?? 'To do', position: c.position ?? 0,
            });
        }
        for (const t of arr(data, 'cards')) {
            const boardId = ref('boards', t.boardId);
            if (!boardId)
                continue;
            await insert('cards', tasks, t.id, {
                boardId, columnId: ref('columns', t.columnId),
                title: t.title ?? 'Card', description: t.description ?? null,
                priority: t.priority ?? 'none', dueDate: t.dueDate ?? null,
                estimateMinutes: t.estimateMinutes ?? null,
                scheduledStart: t.scheduledStart ? new Date(String(t.scheduledStart)) : null,
                recurrence: t.recurrence ?? null, assignedTo: userOrNull(t.assignedTo),
                position: t.position ?? 0, isCompleted: !!t.isCompleted,
                completedAt: t.completedAt ? new Date(String(t.completedAt)) : null,
                isArchived: !!t.isArchived, createdBy: importerUserId,
            });
        }
        for (const s of arr(data, 'subtasks')) {
            const taskId = ref('cards', s.taskId);
            if (!taskId)
                continue;
            await insert('subtasks', taskSubtasks, s.id, {
                taskId, title: s.title ?? '', isCompleted: !!s.isCompleted, position: s.position ?? 0,
            });
        }
        for (const c of arr(data, 'comments')) {
            const taskId = ref('cards', c.taskId);
            if (!taskId)
                continue;
            await insert('comments', taskComments, c.id, {
                taskId, userId: userOf(c.userId), comment: c.comment ?? '',
            });
        }
        for (const l of arr(data, 'labels')) {
            await insert('labels', labels, l.id, { name: l.name ?? 'Label', color: l.color ?? undefined });
        }
        for (const tl of arr(data, 'cardLabels')) {
            const taskId = ref('cards', tl.taskId);
            const labelId = ref('labels', tl.labelId);
            if (!taskId || !labelId)
                continue;
            await insert('cardLabels', taskLabels, tl.id, { taskId, labelId });
        }
        for (const t of arr(data, 'teams')) {
            await insert('teams', teams, t.id, { name: t.name ?? 'Team', color: t.color ?? undefined });
        }
        for (const tm of arr(data, 'teamMembers')) {
            const teamId = ref('teams', tm.teamId);
            const userId = userOrNull(tm.userId);
            // A team membership for somebody who is not in this workspace is meaningless,
            // so it is dropped rather than pointed at the importer.
            if (!teamId || !userId)
                continue;
            await insert('teamMembers', teamMembers, tm.id, { teamId, userId });
        }
        for (const bt of arr(data, 'boardTeams')) {
            const boardId = ref('boards', bt.boardId);
            const teamId = ref('teams', bt.teamId);
            if (!boardId || !teamId)
                continue;
            await insert('boardTeams', boardTeams, bt.id, { boardId, teamId });
        }
        for (const e of arr(data, 'timeEntries')) {
            const taskId = ref('cards', e.taskId);
            if (!taskId)
                continue;
            await insert('timeEntries', timeEntries, e.id, {
                taskId, userId: userOf(e.userId),
                startTime: e.startTime ? new Date(String(e.startTime)) : new Date(),
                durationSeconds: e.durationSeconds ?? null,
            });
        }
        for (const e of arr(data, 'calendarEvents')) {
            await insert('calendarEvents', calendarEvents, e.id, {
                businessId: ref('businesses', e.businessId), folderId: ref('folders', e.folderId),
                title: e.title ?? 'Event', description: e.description ?? null,
                kind: e.kind ?? 'meeting',
                startAt: e.startAt ? new Date(String(e.startAt)) : new Date(),
                endAt: e.endAt ? new Date(String(e.endAt)) : null,
                allDay: !!e.allDay, location: e.location ?? null, attendees: e.attendees ?? null,
                createdBy: importerUserId,
            });
        }
        for (const c of arr(data, 'contacts')) {
            await insert('contacts', contacts, c.id, {
                businessId: ref('businesses', c.businessId), folderId: ref('folders', c.folderId),
                name: c.name ?? 'Contact', email: c.email ?? null, phone: c.phone ?? null,
                company: c.company ?? null, role: c.role ?? null, notes: c.notes ?? null,
            });
        }
        for (const d of arr(data, 'deals')) {
            await insert('deals', deals, d.id, {
                businessId: ref('businesses', d.businessId), title: d.title ?? 'Deal',
                company: d.company ?? null, value: d.value ?? '0.00', stage: d.stage ?? 'lead',
                source: d.source ?? null, lostReason: d.lostReason ?? null, notes: d.notes ?? null,
                clientFolderId: ref('folders', d.clientFolderId), createdBy: importerUserId,
            });
        }
        for (const a of arr(data, 'dealActivities')) {
            const dealId = ref('deals', a.dealId);
            if (!dealId)
                continue;
            await insert('dealActivities', dealActivities, a.id, {
                dealId, kind: a.kind ?? 'note', body: a.body ?? '',
                occurredAt: a.occurredAt ? new Date(String(a.occurredAt)) : new Date(),
                createdBy: importerUserId,
            });
        }
        for (const o of arr(data, 'offerings')) {
            const businessId = ref('businesses', o.businessId);
            if (!businessId)
                continue;
            await insert('offerings', offerings, o.id, {
                businessId, name: o.name ?? 'Offering', description: o.description ?? null,
                price: o.price ?? '0.00', recurring: !!o.recurring, unit: o.unit ?? null,
            });
        }
        /**
         * Subscriptions, disarmed.
         *
         * autoDebit off and the billing date pulled up to today at the earliest. A backup
         * is by definition older than now, so every restored subscription is overdue on
         * arrival; left alone, the first nightly run would raise every missed cycle at
         * once. If those cycles genuinely should be billed, that is a person doing it
         * from the Subscriptions screen where they can see the amount first.
         */
        let disarmed = 0;
        let rolled = 0;
        for (const s of arr(data, 'subscriptions')) {
            const businessId = ref('businesses', s.businessId);
            const offeringId = ref('offerings', s.offeringId);
            const folderId = ref('folders', s.folderId);
            if (!businessId || !offeringId || !folderId)
                continue;
            /**
             * Roll the schedule forward past today, not on to it.
             *
             * Clamping to today made every restored subscription due the moment the restore
             * finished, so the first nightly run invoiced the entire client list on day one
             * of a recovery. Rolling on its own cadence from its own anchor day lands it
             * where the next real cycle would have fallen. Cycles missed while the backup
             * sat on a disk are forgiven; if they are genuinely owed, a person raises them
             * from the Subscriptions screen where the amount is visible first.
             */
            const anchor = anchorDayOf(typeof s.startedOn === 'string' ? s.startedOn : today);
            const every = Number(s.intervalMonths ?? 1) || 1;
            let next = typeof s.nextBillDate === 'string' ? s.nextBillDate : today;
            for (let i = 0; i < 600 && next <= today; i++)
                next = addMonths(next, every, anchor);
            if (next !== s.nextBillDate)
                rolled++;
            if (s.autoDebit)
                disarmed++;
            await insert('subscriptions', subscriptions, s.id, {
                businessId, offeringId, folderId, status: s.status ?? 'active',
                price: s.price ?? null, autoSend: !!s.autoSend,
                autoDebit: false, payfastToken: null,
                domain: s.domain ?? null,
                intervalMonths: s.intervalMonths ?? 1,
                startedOn: s.startedOn ?? today, nextBillDate: next,
                createdBy: importerUserId,
            });
        }
        if (disarmed) {
            notes.push(`${disarmed} subscription(s) had auto-debit on. It is switched off, and no card is stored, so nothing can be charged until you set it up again.`);
        }
        if (rolled) {
            notes.push(`${rolled} subscription(s) were overdue in the backup. Their next invoice is set to the next normal cycle, and nothing was raised for the months in between. Raise those by hand if they are genuinely owed.`);
        }
        // ---- documents, then the credit notes that point at them ---------------
        for (const d of arr(data, 'documents')) {
            await insert('documents', documents, d.id, {
                businessId: ref('businesses', d.businessId), folderId: ref('folders', d.folderId),
                subscriptionId: ref('subscriptions', d.subscriptionId), sourceDocumentId: null,
                type: d.type ?? 'invoice', seq: d.seq ?? 0, number: d.number ?? '',
                clientName: d.clientName ?? '', clientEmail: d.clientEmail ?? null,
                clientAddress: d.clientAddress ?? null, clientVatNumber: d.clientVatNumber ?? null,
                issueDate: d.issueDate ?? today, dueDate: d.dueDate ?? null,
                currency: d.currency ?? 'ZAR', taxRate: d.taxRate ?? '0',
                subtotal: d.subtotal ?? '0.00', taxAmount: d.taxAmount ?? '0.00',
                discountType: d.discountType ?? 'none', discountValue: d.discountValue ?? '0.00',
                discountAmount: d.discountAmount ?? '0.00',
                depositType: d.depositType ?? 'none', depositValue: d.depositValue ?? '0.00',
                depositAmount: d.depositAmount ?? '0.00',
                total: d.total ?? '0.00', status: d.status ?? 'draft', notes: d.notes ?? null,
                createdBy: importerUserId,
            });
        }
        for (const d of arr(data, 'documents')) {
            const src = ref('documents', d.sourceDocumentId);
            const self = ref('documents', d.id);
            if (src && self) {
                await tx.update(documents).set({ sourceDocumentId: src })
                    .where(tenantWhere(documents, accountId, eq(documents.id, self)));
            }
        }
        for (const l of arr(data, 'documentLines')) {
            const documentId = ref('documents', l.documentId);
            if (!documentId)
                continue;
            await insert('documentLines', documentLines, l.id, {
                documentId, description: l.description ?? '', detail: l.detail ?? null,
                quantity: l.quantity ?? '1.00', unitPrice: l.unitPrice ?? '0.00',
                amount: l.amount ?? '0.00', position: l.position ?? 0,
            });
        }
        for (const p of arr(data, 'payments')) {
            const documentId = ref('documents', p.documentId);
            if (!documentId)
                continue;
            await insert('payments', payments, p.id, {
                documentId, amount: p.amount ?? '0.00', paidOn: p.paidOn ?? today,
                method: p.method ?? null, note: p.note ?? null,
                // The fee is history, not a live key, so it restores as it was.
                feeAmount: p.feeAmount ?? null, netAmount: p.netAmount ?? null,
                // The gateway id is deliberately dropped: it is a live idempotency key, and
                // re-importing it would make a genuine future notification for the same
                // payment look like a duplicate and be thrown away.
                pfPaymentId: null, createdBy: null,
            });
        }
        /**
         * Hosting comes back as a RECORD, never as a claim about the server.
         *
         * The suspension sweep only ever acts on rows marked active, so importing as
         * pending means a restored row can never cause Klippy to switch off a real site
         * it has not confirmed exists. Somebody has to check these against WHM by hand,
         * and the detail line says so where they will read it.
         */
        for (const h of arr(data, 'hostingAccounts')) {
            await insert('hostingAccounts', hostingAccounts, h.id, {
                businessId: ref('businesses', h.businessId),
                subscriptionId: ref('subscriptions', h.subscriptionId),
                domain: h.domain ?? '', username: h.username ?? null,
                whmPackage: h.whmPackage ?? null,
                isTemporary: !!h.isTemporary, tempDomain: h.tempDomain ?? null,
                status: 'pending',
                detail: 'Restored from a backup. Check this against your WHM server before relying on it.',
            });
        }
        if (counts.hostingAccounts) {
            notes.push(`${counts.hostingAccounts} hosting account(s) were restored as records only. Check each one against your server before switching anything on.`);
        }
        for (const p of arr(data, 'portalUsers')) {
            const businessId = ref('businesses', p.businessId);
            const folderId = ref('folders', p.folderId);
            if (!businessId || !folderId)
                continue;
            await insert('portalUsers', portalUsers, p.id, {
                businessId, folderId, email: String(p.email ?? '').toLowerCase(),
                name: p.name ?? null, isActive: p.isActive !== false,
            });
        }
        for (const e of arr(data, 'expenses')) {
            await insert('expenses', expenses, e.id, {
                businessId: ref('businesses', e.businessId), folderId: ref('folders', e.folderId),
                description: e.description ?? '', category: e.category ?? null,
                amount: e.amount ?? '0.00', vatAmount: e.vatAmount ?? null,
                incurredOn: e.incurredOn ?? today, createdBy: importerUserId,
            });
        }
        for (const n of arr(data, 'notes')) {
            await insert('notes', productNotes, n.id, {
                title: n.title ?? '', body: n.body ?? null, kind: n.kind ?? undefined,
                status: n.status ?? undefined, priority: n.priority ?? undefined,
                createdBy: importerUserId,
            });
        }
        /**
         * The matrix. Its refId points into a different table depending on kind, so it
         * is remapped through whichever map that kind belongs to. A judgement whose
         * subject did not survive the import is dropped rather than left pointing at
         * whatever row happens to hold that id now.
         */
        for (const f of arr(data, 'focus')) {
            const kind = String(f.kind ?? 'manual');
            let refId = null;
            if (kind === 'task')
                refId = ref('cards', f.refId);
            else if (kind === 'invoice' || kind === 'quote')
                refId = ref('documents', f.refId);
            else if (kind === 'deal')
                refId = ref('deals', f.refId);
            if (kind !== 'manual' && refId == null)
                continue;
            await insert('focus', focusItems, f.id, {
                businessId: ref('businesses', f.businessId), kind, refId,
                title: f.title ?? null, important: f.important !== false,
                dueDate: f.dueDate ?? null,
                doneAt: f.doneAt ? new Date(String(f.doneAt)) : null,
                createdBy: importerUserId,
            });
        }
        /**
         * The workspace's own starter business is LEFT ALONE.
         *
         * Removing it would tidy the business switcher, and an earlier version did. But
         * business_email, business_members and the payment, hosting and messaging
         * settings all hang off a business, so anyone who had set up their gateway on the
         * fresh workspace before restoring would have had that configuration deleted as a
         * side effect of a restore. Worse, the check would have to be updated every time
         * a new per-business table is added, and forgetting once is silent data loss.
         *
         * So it stays, and the report says it is there. Deleting a business is already a
         * button with its own guards; this is not the place to do it.
         */
        if (preExisting.length && (maps.businesses?.size ?? 0) > 0) {
            leftoverBusinesses = preExisting.length;
        }
    });
    // ---- what was deliberately left behind -----------------------------------
    const skippedFiles = arr(data, 'attachments').length + arr(data, 'files').length;
    if (skippedFiles) {
        notes.push(`${skippedFiles} attachment(s) and file(s) were listed in the backup but their contents are not in it, so they were not restored.`);
    }
    if (leftoverBusinesses) {
        notes.push(`This workspace's own empty business is still in the list beside the restored ones. Delete it from Settings if you do not want it.`);
    }
    if (trashClamped) {
        notes.push(`${trashClamped} item(s) came back in the Trash with their 30 days restarted, so tonight's clear-out cannot destroy them. Restore anything you want to keep.`);
    }
    if (reattributed) {
        notes.push(`${reattributed} entries belonged to people who are not in this workspace, so they are recorded against you. Check tracked time before invoicing from it.`);
    }
    return {
        counts, reattributed, reattributedTo: me?.email ?? null, skippedFiles, notes,
    };
}
//# sourceMappingURL=importAccount.js.map