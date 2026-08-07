import { eq, sql } from 'drizzle-orm';
import { db } from './../db/client.js';
import { deals, folders, boards, boardColumns, documents, documentLines, accounts, businesses, memberships, } from '../db/schema.js';
import { tenantWhere, withTenant } from './tenant.js';
import { nextNumberFor } from './numbering.js';
import { nextPosition } from './http.js';
import { on } from './events.js';
import { notify } from './push.js';
import { appUrl } from './mailer.js';
/**
 * The Golden Handoff: what happens the moment a deal is won.
 *
 * This is the seam most tools leave to the human. A deal closes and someone has to
 * remember to set up the project, raise the deposit invoice, and tell the people
 * who will do the work. Each step is easy and each one gets forgotten. So winning a
 * deal fires one event and three things happen: the client gets a workspace in
 * Fulfillment, a draft invoice waits in Finance, and the team is told.
 *
 * Every step is idempotent, because a deal can be dragged to Won, dragged out and
 * dragged back, and that must not produce three boards and three invoices.
 */
const DEFAULT_COLUMNS = [
    { name: 'To do', color: '#94a3b8', isDoneColumn: false },
    { name: 'Doing', color: '#3b82f6', isDoneColumn: false },
    { name: 'Done', color: '#22c55e', isDoneColumn: true },
];
const money = (n) => (Math.round(n * 100) / 100).toFixed(2);
/** 1. Fulfillment: the client gets somewhere for the work to live. */
on('deal.won', 'create-client-workspace', async (p, ctx) => {
    const { accountId, userId } = ctx;
    const [deal] = await db.select().from(deals)
        .where(tenantWhere(deals, accountId, eq(deals.id, p.dealId))).limit(1);
    if (!deal)
        return { outcome: 'deal no longer exists', ok: false };
    // Already converted: this is the idempotency guard for a re-won deal.
    if (deal.clientFolderId) {
        return { outcome: 'client already set up', ok: true, data: { folderId: deal.clientFolderId } };
    }
    const name = deal.company || deal.title;
    const folderId = await db.transaction(async (tx) => {
        const position = await nextPosition(folders, sql `account_id = ${accountId} AND parent_id IS NULL`);
        const fIns = await tx.insert(folders).values(withTenant(accountId, {
            parentId: null, businessId: deal.businessId, name, pillar: 'delivery',
            position, createdBy: userId,
        }));
        const fid = Number(fIns[0].insertId);
        const bIns = await tx.insert(boards).values(withTenant(accountId, {
            folderId: fid, name: 'Onboarding', description: `Getting ${name} up and running.`,
            position: 0, createdBy: userId,
        }));
        const bid = Number(bIns[0].insertId);
        await tx.insert(boardColumns).values(DEFAULT_COLUMNS.map((c, i) => withTenant(accountId, {
            boardId: bid, name: c.name, color: c.color, isDoneColumn: c.isDoneColumn, position: i,
        })));
        await tx.update(deals).set({ clientFolderId: fid })
            .where(tenantWhere(deals, accountId, eq(deals.id, p.dealId)));
        return fid;
    });
    return { outcome: `created client "${name}" with an onboarding board`, ok: true, data: { folderId, clientName: name } };
});
/** 2. Finance: a draft invoice for the agreed value, waiting to be checked and sent. */
on('deal.won', 'draft-opening-invoice', async (p, ctx) => {
    const { accountId, userId } = ctx;
    if (!p.value || p.value <= 0)
        return { outcome: 'no value on the deal, nothing to invoice', ok: true };
    const [deal] = await db.select({ clientFolderId: deals.clientFolderId }).from(deals)
        .where(tenantWhere(deals, accountId, eq(deals.id, p.dealId))).limit(1);
    const folderId = deal?.clientFolderId ?? null;
    // If this deal already produced an invoice, do not raise another.
    if (folderId) {
        const [existing] = await db.select({ id: documents.id, number: documents.number }).from(documents)
            .where(tenantWhere(documents, accountId, eq(documents.type, 'invoice'), eq(documents.folderId, folderId))).limit(1);
        if (existing)
            return { outcome: `invoice ${existing.number} already exists`, ok: true };
    }
    const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
    const [business] = p.businessId
        ? await db.select().from(businesses)
            .where(tenantWhere(businesses, accountId, eq(businesses.id, p.businessId))).limit(1)
        : [undefined];
    const taxRate = Number(business?.defaultTaxRate ?? account?.defaultTaxRate ?? 0);
    const dueDays = business?.defaultDueDays ?? account?.defaultDueDays ?? 14;
    const issueDate = new Date().toISOString().slice(0, 10);
    const due = new Date(`${issueDate}T00:00:00.000Z`);
    due.setUTCDate(due.getUTCDate() + dueDays);
    const subtotal = p.value;
    const taxAmount = subtotal * (taxRate / 100);
    // Numbering honours this business's prefix and starting number.
    const { seq, number } = await nextNumberFor(accountId, p.businessId, 'invoice');
    const docId = await db.transaction(async (tx) => {
        const ins = await tx.insert(documents).values(withTenant(accountId, {
            type: 'invoice', seq, number, businessId: p.businessId, folderId,
            clientName: p.company || p.title, clientEmail: p.contactEmail || null,
            issueDate, dueDate: due.toISOString().slice(0, 10),
            currency: account?.currency ?? 'ZAR',
            taxRate: money(taxRate), subtotal: money(subtotal),
            taxAmount: money(taxAmount), total: money(subtotal + taxAmount),
            // A DRAFT on purpose: the handoff should save the typing, not send a client
            // an invoice nobody read first.
            status: 'draft',
            notes: `Raised automatically when the deal "${p.title}" was won.`,
            createdBy: userId,
        }));
        const newId = Number(ins[0].insertId);
        await tx.insert(documentLines).values(withTenant(accountId, {
            documentId: newId, description: p.title,
            quantity: '1.00', unitPrice: money(subtotal), amount: money(subtotal), position: 0,
        }));
        return newId;
    });
    return { outcome: `drafted invoice ${number}`, ok: true, data: { invoiceId: docId, invoiceNumber: number } };
});
/** 3. Admin: tell the people who run the account, so nobody finds out days later. */
on('deal.won', 'notify-team', async (p, ctx) => {
    const { accountId, userId } = ctx;
    const admins = await db.select({ userId: memberships.userId }).from(memberships)
        .where(tenantWhere(memberships, accountId, eq(memberships.isActive, true), sql `role IN ('owner','admin')`));
    const targets = admins.map((a) => a.userId).filter((id) => id !== userId);
    if (!targets.length)
        return { outcome: 'nobody else to tell', ok: true };
    const name = p.company || p.title;
    for (const id of targets) {
        notify(id, {
            title: `Deal won: ${name}`,
            body: p.value > 0 ? `Worth ${money(p.value)}. Onboarding board and draft invoice are ready.` : 'Onboarding board is ready.',
            url: appUrl(),
            tag: `deal-${p.dealId}`,
        });
    }
    return { outcome: `notified ${targets.length} ${targets.length === 1 ? 'person' : 'people'}`, ok: true };
});
//# sourceMappingURL=handoff.js.map