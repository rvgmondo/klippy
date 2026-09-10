import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { boards } from '../db/schema.js';
import { db } from '../db/client.js';
import { folders, businesses, documents, deals, dealActivities, contacts, memberships } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere, withTenant } from '../lib/tenant.js';
import { intId, nextPosition } from '../lib/http.js';
import { accessibleBusinessIds, assertMaybeBusiness } from '../lib/access.js';

/**
 * The company behind the client, as a contract or a tax invoice needs it.
 *
 * Nearly all of it is loose on purpose. A registration number is a CIPC number
 * here, a Companies House number there and an EIN somewhere else, so a format
 * check written for one country rejects the other two; `country` is what makes the
 * LABEL right, and the value itself is whatever the client's certificate says.
 *
 * The two that are checked are the two a machine later reads: a financial year end
 * that has to be a real day of a real month, and a currency that has to be a
 * currency code. Everything else is a human reading a human.
 */
const companySchema = {
  legalName: z.string().trim().max(200).nullable().optional(),
  regNumber: z.string().trim().max(60).nullable().optional(),
  companyType: z.string().trim().max(60).nullable().optional(),
  country: z.string().trim().length(2).toUpperCase().nullable().optional().or(z.literal('')),
  taxNumber: z.string().trim().max(60).nullable().optional(),
  industry: z.string().trim().max(80).nullable().optional(),
  website: z.string().trim().max(255).nullable().optional(),
  bbbeeLevel: z.string().trim().max(20).nullable().optional(),

  /**
   * MM-DD, and the day is checked against the month, so 02-30 is refused rather
   * than stored and shown back as a date that does not exist. February is allowed
   * 29 because a leap year is a real year.
   */
  financialYearEnd: z.string().trim().regex(/^\d{2}-\d{2}$/, 'Use MM-DD, for example 02-28.')
    .refine((v) => {
      const m = Number(v.slice(0, 2));
      const d = Number(v.slice(3, 5));
      const last = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] ?? 0;
      return m >= 1 && m <= 12 && d >= 1 && d <= last;
    }, 'That is not a day of that month.')
    .nullable().optional().or(z.literal('')),

  /** Zero is a real answer and means on receipt, so this is not min(1). */
  paymentTermsDays: z.number().int().min(0).max(365).nullable().optional(),
  creditLimit: z.number().nonnegative().max(999999999).nullable().optional(),
  currency: z.string().trim().length(3).toUpperCase().nullable().optional().or(z.literal('')),

  clientStatus: z.enum(['prospect', 'active', 'dormant', 'former']).optional(),
  clientSince: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.').nullable().optional().or(z.literal('')),
  accountManagerId: z.number().int().positive().nullable().optional(),
  source: z.string().trim().max(80).nullable().optional(),
  primaryContactId: z.number().int().positive().nullable().optional(),
};

const createSchema = z.object({
  name: z.string().trim().min(1).max(150),
  parentId: z.number().int().positive().nullable().optional(),
  businessId: z.number().int().positive().optional(),
  color: z.string().trim().max(20).optional(),
  notes: z.string().max(5000).nullable().optional(),
  pillar: z.enum(['delivery','operations']).optional(),
  // Set when a client is created inline from an invoice, so the very first invoice
  // can already be emailed and chased without a second trip to settings.
  billingEmail: z.string().email().max(150).nullable().optional(),
});
const updateSchema = z.object({
  name: z.string().trim().min(1).max(150).optional(),
  parentId: z.number().int().positive().nullable().optional(),
  color: z.string().trim().max(20).optional(),
  notes: z.string().max(5000).nullable().optional(),
  isArchived: z.boolean().optional(),
  hourlyRate: z.number().nonnegative().max(100000).nullable().optional(),
  monthlyHoursBudget: z.number().nonnegative().max(10000).nullable().optional(),
  billingEmail: z.string().trim().email().max(150).nullable().optional().or(z.literal('')),
  billingPhone: z.string().trim().max(40).nullable().optional(),
  // The client's own billing details. Editable here as well as by the client in
  // their portal, since whoever knows the right answer should be able to fix it.
  billingVatNumber: z.string().trim().max(60).nullable().optional(),
  billingAddress: z.string().trim().max(500).nullable().optional(),
  pillar: z.enum(['delivery','operations']).optional(),
  ...companySchema,
});

/** True if `candidateParent` is `folderId` itself or a descendant of it. */
async function wouldCycle(accountId: number, folderId: number, candidateParent: number): Promise<boolean> {
  let cur: number | null = candidateParent;
  for (let i = 0; i < 100 && cur !== null; i++) {
    if (cur === folderId) return true;
    const [row] = await db.select({ parentId: folders.parentId }).from(folders)
      .where(tenantWhere(folders, accountId, eq(folders.id, cur))).limit(1);
    cur = row?.parentId ?? null;
  }
  return false;
}

export async function folderRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  // Flat list of folders the user may see; the client assembles the tree. Members
  // only see folders in businesses they have access to. Folders with no business
  // (legacy/uncategorised) stay visible to everyone in the account.
  app.get('/api/v1/folders', async (req) => {
    const { accountId } = authOf(req);
    const rows = await db.select().from(folders)
      .where(tenantWhere(folders, accountId, isNull(folders.deletedAt)))
      .orderBy(asc(folders.parentId), asc(folders.position));
    const allowed = await accessibleBusinessIds(req);
    return { folders: allowed ? rows.filter((f) => f.businessId == null || allowed.has(f.businessId)) : rows };
  });

  app.post('/api/v1/folders', async (req, reply) => {
    const { accountId, userId } = authOf(req);
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    const { name, parentId = null, color, notes } = parsed.data;

    // A subfolder inherits its parent's business; a top-level folder takes the
    // businessId the client sends (the currently-selected business).
    let businessId: number | null = parsed.data.businessId ?? null;
    if (parentId) {
      const [parent] = await db.select({ id: folders.id, businessId: folders.businessId }).from(folders)
        .where(tenantWhere(folders, accountId, eq(folders.id, parentId))).limit(1);
      if (!parent) return reply.code(400).send({ error: 'Parent folder not found.' });
      businessId = parent.businessId;
    } else if (businessId) {
      const [biz] = await db.select({ id: businesses.id }).from(businesses)
        .where(tenantWhere(businesses, accountId, eq(businesses.id, businessId))).limit(1);
      if (!biz) return reply.code(400).send({ error: 'Business not found.' });
    } else {
      // No business given for a top-level folder: fall back to the account's first.
      const [biz] = await db.select({ id: businesses.id }).from(businesses)
        .where(tenantWhere(businesses, accountId)).orderBy(asc(businesses.position)).limit(1);
      businessId = biz?.id ?? null;
    }
    // A member can only add folders inside a business they can work in.
    if (!(await assertMaybeBusiness(req, reply, businessId))) return;
    const position = await nextPosition(folders,
      parentId === null
        ? sql`account_id = ${accountId} AND parent_id IS NULL`
        : sql`account_id = ${accountId} AND parent_id = ${parentId}`);

    const ins = await db.insert(folders).values(withTenant(accountId, {
      parentId, businessId, name, color: color ?? '#6366f1', notes: notes ?? null,
      billingEmail: parsed.data.billingEmail ?? null,
      pillar: parsed.data.pillar ?? 'delivery', position, createdBy: userId,
    }));
    const [created] = await db.select().from(folders)
      .where(tenantWhere(folders, accountId, eq(folders.id, Number(ins[0].insertId)))).limit(1);
    return reply.code(201).send({ folder: created });
  });

  app.patch('/api/v1/folders/:id', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });

    const [existing] = await db.select().from(folders)
      .where(tenantWhere(folders, accountId, eq(folders.id, id))).limit(1);
    if (!existing) return reply.code(404).send({ error: 'Folder not found.' });
    if (!(await assertMaybeBusiness(req, reply, existing.businessId))) return;

    // MySQL DECIMAL columns are string-typed in Drizzle.
    const patch: Record<string, unknown> = { ...parsed.data };
    if (parsed.data.billingPhone !== undefined) {
      patch.billingPhone = parsed.data.billingPhone?.trim() || null;
    }
    if (parsed.data.monthlyHoursBudget !== undefined) {
      patch.monthlyHoursBudget = parsed.data.monthlyHoursBudget === null ? null : String(parsed.data.monthlyHoursBudget);
    }
    if (parsed.data.hourlyRate !== undefined) {
      patch.hourlyRate = parsed.data.hourlyRate === null ? null : String(parsed.data.hourlyRate);
    }
    /**
     * An empty box means "clear this", not "store an empty string".
     *
     * The form sends '' for every field somebody blanked, and a column holding ''
     * reads as set everywhere else: a country of '' fails a two-letter lookup, a
     * currency of '' would be printed on an invoice. One pass, so no field is
     * remembered to be normalised and no field is forgotten.
     */
    for (const k of ['legalName', 'regNumber', 'companyType', 'country', 'taxNumber',
      'industry', 'website', 'bbbeeLevel', 'financialYearEnd', 'clientSince', 'source',
      'currency'] as const) {
      if (patch[k] !== undefined) patch[k] = (patch[k] as string | null)?.trim() || null;
    }
    // DECIMAL columns are string-typed in Drizzle, like hourlyRate above.
    if (parsed.data.creditLimit !== undefined) {
      patch.creditLimit = parsed.data.creditLimit === null ? null : String(parsed.data.creditLimit);
    }
    // A website somebody typed as "acme.co.za" is a relative link in an href, which
    // silently sends them to klippy.example.com/acme.co.za. Give it a scheme here so
    // every screen that renders it can just render it.
    if (typeof patch.website === 'string' && !/^https?:\/\//i.test(patch.website)) {
      patch.website = `https://${patch.website}`;
    }

    /**
     * Both of these are ids the caller chose, so both are checked against this
     * account before they are stored. Without it, a number from another workspace
     * lands in the row and the client record starts naming a stranger.
     */
    if (parsed.data.accountManagerId) {
      const [mgr] = await db.select({ id: memberships.userId }).from(memberships)
        .where(and(eq(memberships.accountId, accountId),
          eq(memberships.userId, parsed.data.accountManagerId),
          eq(memberships.isActive, true))).limit(1);
      if (!mgr) return reply.code(400).send({ error: 'That person is not in this workspace.' });
    }
    if (parsed.data.primaryContactId) {
      const [person] = await db.select({ id: contacts.id }).from(contacts)
        .where(tenantWhere(contacts, accountId, eq(contacts.id, parsed.data.primaryContactId))).limit(1);
      if (!person) return reply.code(400).send({ error: 'That contact does not exist.' });
      // Filed under this client from now on, so the authorised person is reachable
      // from the company as well as from the contacts list.
      await db.update(contacts).set({ folderId: id })
        .where(tenantWhere(contacts, accountId, eq(contacts.id, parsed.data.primaryContactId)));
    }

    const newParent = parsed.data.parentId;
    if (newParent !== undefined && newParent !== existing.parentId) {
      if (newParent !== null) {
        const [parent] = await db.select({ id: folders.id }).from(folders)
          .where(tenantWhere(folders, accountId, eq(folders.id, newParent))).limit(1);
        if (!parent) return reply.code(400).send({ error: 'Parent folder not found.' });
        if (await wouldCycle(accountId, id, newParent)) {
          return reply.code(400).send({ error: "Can't move a folder into itself or its own subfolder." });
        }
      }
    }
    await db.update(folders).set(patch).where(tenantWhere(folders, accountId, eq(folders.id, id)));
    const [updated] = await db.select().from(folders)
      .where(tenantWhere(folders, accountId, eq(folders.id, id))).limit(1);
    return { folder: updated };
  });

  /**
   * Delete = move to Trash. The whole subtree (subfolders and their boards) gets
   * one shared deletedAt stamp, which is what lets a restore bring back exactly
   * this delete and nothing that was already in the trash. The Trash keeps it 30
   * days; the nightly housekeeping does the hard delete nobody should do by hand.
   */
  app.delete('/api/v1/folders/:id', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const [own] = await db.select({ businessId: folders.businessId, deletedAt: folders.deletedAt }).from(folders)
      .where(tenantWhere(folders, accountId, eq(folders.id, id))).limit(1);
    if (!own || own.deletedAt) return reply.code(404).send({ error: 'Folder not found.' });
    if (!(await assertMaybeBusiness(req, reply, own.businessId))) return;

    const all = await db.select({ id: folders.id, parentId: folders.parentId })
      .from(folders).where(tenantWhere(folders, accountId));
    const children = new Map<number, number[]>();
    for (const f of all) {
      if (f.parentId == null) continue;
      const list = children.get(f.parentId) ?? [];
      list.push(f.id);
      children.set(f.parentId, list);
    }
    const ids: number[] = [];
    const queue = [id];
    while (queue.length) {
      const cur = queue.pop()!;
      ids.push(cur);
      for (const c of children.get(cur) ?? []) queue.push(c);
    }

    const stamp = new Date();
    await db.update(folders).set({ deletedAt: stamp })
      .where(tenantWhere(folders, accountId, inArray(folders.id, ids), isNull(folders.deletedAt)));
    await db.update(boards).set({ deletedAt: stamp })
      .where(tenantWhere(boards, accountId, inArray(boards.folderId, ids), isNull(boards.deletedAt)));
    return { ok: true, trashed: true };
  });

  // Persist sibling order after drag/drop.
  app.post('/api/v1/folders/reorder', async (req, reply) => {
    const { accountId } = authOf(req);
    const body = z.object({ orderedIds: z.array(z.number().int().positive()).max(1000) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'orderedIds required.' });
    await db.transaction(async (tx) => {
      for (let i = 0; i < body.data.orderedIds.length; i++) {
        await tx.update(folders).set({ position: i })
          .where(and(eq(folders.accountId, accountId), eq(folders.id, body.data.orderedIds[i]!)));
      }
    });
    return { ok: true };
  });

  /**
   * One client's story in order: every document issued to them and every logged
   * deal interaction, oldest last. The pieces all existed in their own modules;
   * nothing showed them as one relationship. Read-only aggregation, no new tables.
   */
  app.get('/api/v1/folders/:id/timeline', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const [folder] = await db.select({ id: folders.id, name: folders.name, businessId: folders.businessId })
      .from(folders).where(tenantWhere(folders, accountId, eq(folders.id, id))).limit(1);
    if (!folder) return reply.code(404).send({ error: 'Client not found.' });
    if (!(await assertMaybeBusiness(req, reply, folder.businessId, 'viewer'))) return;

    const docs = await db.select({
      id: documents.id, number: documents.number, type: documents.type, status: documents.status,
      issueDate: documents.issueDate, total: documents.total, currency: documents.currency,
      decision: documents.decision, decisionAt: documents.decisionAt,
    }).from(documents)
      .where(tenantWhere(documents, accountId, eq(documents.folderId, id)))
      .orderBy(desc(documents.issueDate)).limit(100);

    const clientDeals = await db.select({ id: deals.id, title: deals.title }).from(deals)
      .where(tenantWhere(deals, accountId, eq(deals.clientFolderId, id)));
    const dealIds = clientDeals.map((d) => d.id);
    const acts = dealIds.length
      ? await db.select({
        dealId: dealActivities.dealId, kind: dealActivities.kind,
        body: dealActivities.body, occurredAt: dealActivities.occurredAt,
      }).from(dealActivities)
        .where(tenantWhere(dealActivities, accountId, inArray(dealActivities.dealId, dealIds)))
        .orderBy(desc(dealActivities.occurredAt)).limit(100)
      : [];
    const dealName = new Map(clientDeals.map((d) => [d.id, d.title]));

    const entries = [
      ...docs.map((d) => ({
        at: d.issueDate,
        kind: `document:${d.type}` as const,
        title: `${d.number} (${d.status})`,
        detail: `${d.currency} ${d.total}${d.decision ? `, ${d.decision}` : ''}`,
      })),
      ...acts.map((a) => ({
        at: a.occurredAt.toISOString().slice(0, 10),
        kind: `deal:${a.kind}` as const,
        title: dealName.get(a.dealId) ?? 'Deal',
        detail: a.body ?? a.kind,
      })),
    ].sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0));

    return { client: folder, entries };
  });
}
