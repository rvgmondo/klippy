import { z } from 'zod';
import { asc, desc, eq, isNotNull, lte, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { contacts, dealActivities, deals, folders } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere, withTenant } from '../lib/tenant.js';
import { businessScope, assertMaybeBusiness } from '../lib/access.js';
import { intId } from '../lib/http.js';
/**
 * The parts of a CRM the pipeline was missing: who you are dealing with, what has
 * happened, and when to chase.
 *
 * Built onto the existing deals rather than beside them. A second thing called CRM
 * sitting next to a pipeline is how you end up with two half-filled systems and no
 * idea which one is true.
 */
const ACTIVITY_KINDS = ['note', 'call', 'email', 'meeting', 'stage'];
export async function crmRoutes(app) {
    app.addHook('preHandler', app.requireAuth);
    // ---- Contacts -------------------------------------------------------------
    app.get('/api/v1/contacts', async (req) => {
        const { accountId } = authOf(req);
        const q = z.object({
            businessId: z.coerce.number().int().positive().optional(),
            search: z.string().max(100).optional(),
        }).safeParse(req.query);
        const bizFilter = q.success && q.data.businessId
            ? eq(contacts.businessId, q.data.businessId) : undefined;
        const rows = await db.select({
            id: contacts.id, name: contacts.name, email: contacts.email, phone: contacts.phone,
            company: contacts.company, role: contacts.role, notes: contacts.notes,
            businessId: contacts.businessId, folderId: contacts.folderId,
            clientName: folders.name,
        }).from(contacts)
            .leftJoin(folders, eq(folders.id, contacts.folderId))
            .where(tenantWhere(contacts, accountId, bizFilter, await businessScope(req, contacts.businessId)))
            .orderBy(asc(contacts.name))
            .limit(500);
        const term = q.success ? (q.data.search ?? '').trim().toLowerCase() : '';
        const filtered = term
            ? rows.filter((c) => [c.name, c.email, c.company].some((v) => v?.toLowerCase().includes(term)))
            : rows;
        return { contacts: filtered };
    });
    const contactSchema = z.object({
        name: z.string().trim().min(1).max(120),
        email: z.string().trim().email().max(150).nullable().optional().or(z.literal('')),
        phone: z.string().trim().max(40).nullable().optional(),
        company: z.string().trim().max(150).nullable().optional(),
        role: z.string().trim().max(80).nullable().optional(),
        notes: z.string().max(5000).nullable().optional(),
        businessId: z.number().int().positive().nullable().optional(),
        folderId: z.number().int().positive().nullable().optional(),
    });
    app.post('/api/v1/contacts', async (req, reply) => {
        const { accountId, userId } = authOf(req);
        const parsed = contactSchema.safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: parsed.error.issues[0]?.message });
        const d = parsed.data;
        if (!(await assertMaybeBusiness(req, reply, d.businessId ?? null)))
            return;
        const ins = await db.insert(contacts).values(withTenant(accountId, {
            name: d.name, email: d.email || null, phone: d.phone ?? null,
            company: d.company ?? null, role: d.role ?? null, notes: d.notes ?? null,
            businessId: d.businessId ?? null, folderId: d.folderId ?? null, createdBy: userId,
        }));
        const [created] = await db.select().from(contacts)
            .where(tenantWhere(contacts, accountId, eq(contacts.id, Number(ins[0].insertId)))).limit(1);
        return reply.code(201).send({ contact: created });
    });
    app.patch('/api/v1/contacts/:id', async (req, reply) => {
        const { accountId } = authOf(req);
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        const parsed = contactSchema.partial().safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: parsed.error.issues[0]?.message });
        const [own] = await db.select({ businessId: contacts.businessId }).from(contacts)
            .where(tenantWhere(contacts, accountId, eq(contacts.id, id))).limit(1);
        if (!own)
            return reply.code(404).send({ error: 'Contact not found.' });
        if (!(await assertMaybeBusiness(req, reply, own.businessId)))
            return;
        const d = parsed.data;
        const patch = {};
        for (const k of ['name', 'phone', 'company', 'role', 'notes', 'folderId', 'businessId']) {
            if (d[k] !== undefined)
                patch[k] = d[k];
        }
        if (d.email !== undefined)
            patch.email = d.email || null;
        await db.update(contacts).set(patch).where(tenantWhere(contacts, accountId, eq(contacts.id, id)));
        const [updated] = await db.select().from(contacts)
            .where(tenantWhere(contacts, accountId, eq(contacts.id, id))).limit(1);
        return { contact: updated };
    });
    app.delete('/api/v1/contacts/:id', async (req, reply) => {
        const { accountId } = authOf(req);
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        const [own] = await db.select({ businessId: contacts.businessId }).from(contacts)
            .where(tenantWhere(contacts, accountId, eq(contacts.id, id))).limit(1);
        if (!own)
            return reply.code(404).send({ error: 'Contact not found.' });
        if (!(await assertMaybeBusiness(req, reply, own.businessId)))
            return;
        // Deals keep their own copy of the name and email, so removing a contact loses
        // the person record but never blanks the deal it was attached to.
        await db.update(deals).set({ contactId: null })
            .where(tenantWhere(deals, accountId, eq(deals.contactId, id)));
        await db.delete(contacts).where(tenantWhere(contacts, accountId, eq(contacts.id, id)));
        return { ok: true };
    });
    // ---- Deal activity --------------------------------------------------------
    app.get('/api/v1/deals/:id/activity', async (req, reply) => {
        const { accountId } = authOf(req);
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        const [deal] = await db.select({ businessId: deals.businessId }).from(deals)
            .where(tenantWhere(deals, accountId, eq(deals.id, id))).limit(1);
        if (!deal)
            return reply.code(404).send({ error: 'Deal not found.' });
        if (!(await assertMaybeBusiness(req, reply, deal.businessId)))
            return;
        const rows = await db.select().from(dealActivities)
            .where(tenantWhere(dealActivities, accountId, eq(dealActivities.dealId, id)))
            .orderBy(desc(dealActivities.occurredAt), desc(dealActivities.id))
            .limit(200);
        return { activity: rows };
    });
    app.post('/api/v1/deals/:id/activity', async (req, reply) => {
        const { accountId, userId } = authOf(req);
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        const parsed = z.object({
            kind: z.enum(ACTIVITY_KINDS).optional(),
            body: z.string().trim().min(1).max(5000),
            // Logged after the fact more often than not, so the date is the caller's.
            occurredAt: z.string().datetime().optional(),
        }).safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: parsed.error.issues[0]?.message });
        const [deal] = await db.select({ businessId: deals.businessId }).from(deals)
            .where(tenantWhere(deals, accountId, eq(deals.id, id))).limit(1);
        if (!deal)
            return reply.code(404).send({ error: 'Deal not found.' });
        if (!(await assertMaybeBusiness(req, reply, deal.businessId)))
            return;
        await db.insert(dealActivities).values(withTenant(accountId, {
            dealId: id, kind: parsed.data.kind ?? 'note', body: parsed.data.body,
            occurredAt: parsed.data.occurredAt ? new Date(parsed.data.occurredAt) : new Date(),
            createdBy: userId,
        }));
        // Logging the call IS the follow-up. Leaving the reminder standing after the
        // work was done let it rot into a permanent overdue, which trains the operator
        // to ignore the follow-up list. The next chase date is set deliberately, not
        // inherited from a promise already kept.
        await db.update(deals).set({ nextFollowUpAt: null, followUpNote: null })
            .where(tenantWhere(deals, accountId, eq(deals.id, id)));
        return reply.code(201).send({ ok: true });
    });
    // ---- The follow-up list ---------------------------------------------------
    /**
     * Deals due to be chased, oldest first.
     *
     * The point of the whole feature: one screen answering "who am I supposed to be
     * getting back to", which is otherwise a memory problem that quietly loses deals.
     * Won and lost are excluded, since there is nothing left to chase.
     */
    app.get('/api/v1/deals/follow-ups', async (req) => {
        const { accountId } = authOf(req);
        const today = new Date().toISOString().slice(0, 10);
        const rows = await db.select({
            id: deals.id, title: deals.title, company: deals.company, stage: deals.stage,
            value: deals.value, businessId: deals.businessId,
            nextFollowUpAt: deals.nextFollowUpAt, followUpNote: deals.followUpNote,
            contactName: contacts.name, contactEmail: contacts.email,
        }).from(deals)
            .leftJoin(contacts, eq(contacts.id, deals.contactId))
            .where(tenantWhere(deals, accountId, isNotNull(deals.nextFollowUpAt), lte(deals.nextFollowUpAt, today), or(eq(deals.stage, 'lead'), eq(deals.stage, 'contacted'), eq(deals.stage, 'proposal')), await businessScope(req, deals.businessId)))
            .orderBy(asc(deals.nextFollowUpAt))
            .limit(200);
        return { followUps: rows, today };
    });
}
//# sourceMappingURL=crm.js.map