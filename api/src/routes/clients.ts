import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asc, desc, eq, inArray, isNull, ne } from 'drizzle-orm';
import { db } from '../db/client.js';
import { folders, documents, boards, tasks, contacts, deals } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere } from '../lib/tenant.js';
import { intId } from '../lib/http.js';
import { accessibleBusinessIds, assertMaybeBusiness } from '../lib/access.js';
import { balancesFor } from '../lib/balances.js';

/**
 * The Clients door.
 *
 * A client used to be a folder in a tree that only appeared inside Work, with its
 * money in Billing, its chasing in Collections, its people in Contacts and its
 * details behind a pencil icon. Nothing could answer "what is going on with
 * Acme?" without five screens. These two routes answer it from one place.
 *
 * A client is a top-level folder that is not internal work. Money is worked out
 * with the same balancesFor() that every other money screen uses, so what this
 * page says a client owes is to the cent what Money says. Totals are kept per
 * currency, because Klippy never converts.
 */

const round = (n: number) => Math.round(n * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);
type PerCur = Record<string, number>;
const add = (m: PerCur, cur: string, n: number) => { m[cur] = round((m[cur] ?? 0) + n); };

/** Every folder under a client, so boards filed in a sub-folder still count as theirs. */
function subtree(rootId: number, all: { id: number; parentId: number | null }[]): number[] {
  const out = [rootId];
  for (let i = 0; i < out.length; i++) {
    for (const f of all) if (f.parentId === out[i]) out.push(f.id);
  }
  return out;
}

export async function clientRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  app.get('/api/v1/clients', async (req) => {
    const { accountId } = authOf(req);
    const q = z.object({ businessId: z.coerce.number().int().positive().optional() }).safeParse(req.query);
    const allowed = await accessibleBusinessIds(req);

    const all = await db.select({
      id: folders.id, parentId: folders.parentId, businessId: folders.businessId, name: folders.name,
      color: folders.color, pillar: folders.pillar, billingEmail: folders.billingEmail,
      billingPhone: folders.billingPhone, hasImage: folders.imagePath, createdAt: folders.createdAt,
    }).from(folders)
      .where(tenantWhere(folders, accountId, isNull(folders.deletedAt)))
      .orderBy(asc(folders.position));

    const visible = all.filter((f) => f.businessId == null || allowed === null || allowed.has(f.businessId));
    const clients = visible.filter((f) => f.parentId == null && (f.pillar ?? 'delivery') !== 'operations'
      && (!q.success || !q.data.businessId || f.businessId === q.data.businessId));
    if (!clients.length) return { clients: [] };

    const ids = clients.map((c) => c.id);
    const docs = await db.select({
      id: documents.id, folderId: documents.folderId, type: documents.type, status: documents.status,
      total: documents.total, currency: documents.currency, dueDate: documents.dueDate, issueDate: documents.issueDate,
    }).from(documents)
      .where(tenantWhere(documents, accountId, inArray(documents.folderId, ids)));

    const unpaid = docs.filter((d) => d.type === 'invoice' && d.status === 'sent');
    const bal = await balancesFor(accountId, unpaid);

    // A WhatsApp button needs a number: the client's own, else one of their people.
    const phones = await db.select({ folderId: contacts.folderId, phone: contacts.phone }).from(contacts)
      .where(tenantWhere(contacts, accountId, inArray(contacts.folderId, ids)));

    const openDeals = await db.select({ folderId: deals.clientFolderId }).from(deals)
      .where(tenantWhere(deals, accountId, inArray(deals.clientFolderId, ids),
        ne(deals.stage, 'won'), ne(deals.stage, 'lost')));

    const now = today();
    return {
      clients: clients.map((c) => {
        const owed: PerCur = {};
        const overdue: PerCur = {};
        let lastActivity: string | null = null;
        for (const d of docs) {
          if (d.folderId !== c.id) continue;
          if (!lastActivity || d.issueDate > lastActivity) lastActivity = d.issueDate;
          if (d.type !== 'invoice' || d.status !== 'sent') continue;
          const left = bal.get(d.id)?.outstanding ?? Number(d.total);
          if (left <= 0.001) continue;
          add(owed, d.currency, left);
          if (d.dueDate && d.dueDate < now) add(overdue, d.currency, left);
        }
        const phone = c.billingPhone || phones.find((p) => p.folderId === c.id && p.phone)?.phone || null;
        return {
          id: c.id, name: c.name, color: c.color, businessId: c.businessId,
          email: c.billingEmail, phone, hasLogo: !!c.hasImage,
          owed, overdue, lastActivity,
          dealOpen: openDeals.some((d) => d.folderId === c.id),
          since: c.createdAt,
        };
      }),
    };
  });

  app.get('/api/v1/clients/:id', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });

    // An explicit list of what the page may show. Never a bare select: this row
    // also carries portal and billing internals that have no business in a browser.
    const [c] = await db.select({
      id: folders.id, parentId: folders.parentId, businessId: folders.businessId, name: folders.name,
      color: folders.color, pillar: folders.pillar, notes: folders.notes, hasImage: folders.imagePath,
      billingEmail: folders.billingEmail, billingPhone: folders.billingPhone, billingAddress: folders.billingAddress,
      billingVatNumber: folders.billingVatNumber, hourlyRate: folders.hourlyRate,
      monthlyHoursBudget: folders.monthlyHoursBudget, legalName: folders.legalName, regNumber: folders.regNumber,
      companyType: folders.companyType, country: folders.country, taxNumber: folders.taxNumber,
      industry: folders.industry, website: folders.website, paymentTermsDays: folders.paymentTermsDays, remindersPaused: folders.remindersPaused,
      createdAt: folders.createdAt,
    }).from(folders)
      .where(tenantWhere(folders, accountId, eq(folders.id, id), isNull(folders.deletedAt))).limit(1);
    if (!c || c.parentId != null) return reply.code(404).send({ error: 'Client not found.' });
    if (!(await assertMaybeBusiness(req, reply, c.businessId, 'viewer'))) return;

    const docs = await db.select({
      id: documents.id, type: documents.type, number: documents.number, status: documents.status,
      issueDate: documents.issueDate, dueDate: documents.dueDate, total: documents.total,
      currency: documents.currency, decision: documents.decision, lastReminderOn: documents.lastReminderOn,
      businessId: documents.businessId,
    }).from(documents)
      .where(tenantWhere(documents, accountId, eq(documents.folderId, id)))
      .orderBy(desc(documents.issueDate)).limit(200);

    const bal = await balancesFor(accountId, docs.filter((d) => d.type === 'invoice'));
    const now = today();
    const owed: PerCur = {};
    const overdue: PerCur = {};
    let lateCount = 0;
    let openInvoices = 0;
    const docRows = docs.map((d) => {
      const b = bal.get(d.id);
      const outstanding = d.type === 'invoice' ? (b?.outstanding ?? Number(d.total)) : 0;
      const unpaid = d.type === 'invoice' && d.status === 'sent' && outstanding > 0.001;
      const late = unpaid && !!d.dueDate && d.dueDate < now;
      if (unpaid) { add(owed, d.currency, outstanding); openInvoices++; }
      if (late) { add(overdue, d.currency, outstanding); lateCount++; }
      return { ...d, total: Number(d.total), outstanding: round(outstanding), late };
    });

    const tree = await db.select({ id: folders.id, parentId: folders.parentId }).from(folders)
      .where(tenantWhere(folders, accountId, isNull(folders.deletedAt)));
    const folderIds = subtree(id, tree);
    const boardRows = await db.select({ id: boards.id, name: boards.name }).from(boards)
      .where(tenantWhere(boards, accountId, inArray(boards.folderId, folderIds),
        isNull(boards.deletedAt), eq(boards.isArchived, false)))
      .orderBy(asc(boards.position));
    const boardIds = boardRows.map((b) => b.id);
    const openTasks = boardIds.length ? await db.select({
      id: tasks.id, title: tasks.title, dueDate: tasks.dueDate, boardId: tasks.boardId,
    }).from(tasks)
      .where(tenantWhere(tasks, accountId, inArray(tasks.boardId, boardIds),
        eq(tasks.isCompleted, false), eq(tasks.isArchived, false)))
      .orderBy(asc(tasks.dueDate)).limit(50) : [];

    const people = await db.select({
      id: contacts.id, name: contacts.name, email: contacts.email, phone: contacts.phone, role: contacts.role,
    }).from(contacts)
      .where(tenantWhere(contacts, accountId, eq(contacts.folderId, id)))
      .orderBy(asc(contacts.name));

    const clientDeals = await db.select({
      id: deals.id, title: deals.title, stage: deals.stage, value: deals.value,
    }).from(deals)
      .where(tenantWhere(deals, accountId, eq(deals.clientFolderId, id)));

    return {
      client: { ...c, hasLogo: !!c.hasImage, hasImage: undefined },
      money: { owed, overdue, openInvoices, lateCount },
      documents: docRows,
      boards: boardRows.map((b) => ({
        ...b,
        open: openTasks.filter((t) => t.boardId === b.id).length,
        late: openTasks.filter((t) => t.boardId === b.id && t.dueDate && t.dueDate < now).length,
      })),
      tasks: openTasks,
      people,
      deals: clientDeals.map((d) => ({ ...d, value: Number(d.value) })),
    };
  });
}

