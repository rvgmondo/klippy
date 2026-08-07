import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { boards, boardColumns, tasks, folders, taskLabels, labels } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere, withTenant } from '../lib/tenant.js';
import { intId, nextPosition } from '../lib/http.js';
import { assertBoardAccess, assertMaybeBusiness } from '../lib/access.js';
import { BOARD_TEMPLATES, boardTemplate, columnsFor } from '../lib/boardTemplates.js';

const createSchema = z.object({
  folderId: z.number().int().positive(),
  name: z.string().trim().min(1).max(150),
  description: z.string().trim().max(255).nullable().optional(),
});
const updateSchema = z.object({
  name: z.string().trim().min(1).max(150).optional(),
  description: z.string().trim().max(255).nullable().optional(),
  folderId: z.number().int().positive().optional(),
  isArchived: z.boolean().optional(),
});

const DEFAULT_COLUMNS = [
  { name: 'To do', color: '#94a3b8', isDoneColumn: false },
  { name: 'Doing', color: '#3b82f6', isDoneColumn: false },
  { name: 'Done', color: '#22c55e', isDoneColumn: true },
];

export async function boardRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  // Boards in a folder.
  app.get('/api/v1/boards', async (req, reply) => {
    const { accountId } = authOf(req);
    const q = z.object({ folderId: z.coerce.number().int().positive() }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'folderId required.' });
    // Only list boards in a folder whose business the user can access.
    const [fld] = await db.select({ businessId: folders.businessId }).from(folders)
      .where(tenantWhere(folders, accountId, eq(folders.id, q.data.folderId))).limit(1);
    if (fld && !(await assertMaybeBusiness(req, reply, fld.businessId, 'viewer'))) return;
    const rows = await db.select().from(boards)
      .where(tenantWhere(boards, accountId, and(eq(boards.folderId, q.data.folderId), eq(boards.isArchived, false))))
      .orderBy(asc(boards.position));
    return { boards: rows };
  });

  // Full board: columns (ordered) + non-archived tasks. The main kanban read.
  app.get('/api/v1/boards/:id/full', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    if (!(await assertBoardAccess(req, reply, id, 'viewer'))) return;
    const [board] = await db.select().from(boards)
      .where(tenantWhere(boards, accountId, eq(boards.id, id))).limit(1);
    if (!board) return reply.code(404).send({ error: 'Board not found.' });
    const columns = await db.select().from(boardColumns)
      .where(tenantWhere(boardColumns, accountId, eq(boardColumns.boardId, id)))
      .orderBy(asc(boardColumns.position));
    const cards = await db.select().from(tasks)
      .where(tenantWhere(tasks, accountId, and(eq(tasks.boardId, id), eq(tasks.isArchived, false))))
      .orderBy(asc(tasks.position));
    // Label chips for every card on this board (frontend groups by taskId).
    const cardLabels = await db.select({
      taskId: taskLabels.taskId, id: labels.id, name: labels.name, color: labels.color,
    }).from(taskLabels)
      .innerJoin(labels, eq(labels.id, taskLabels.labelId))
      .innerJoin(tasks, eq(tasks.id, taskLabels.taskId))
      .where(tenantWhere(taskLabels, accountId, eq(tasks.boardId, id)));
    return { board, columns, tasks: cards, cardLabels };
  });

  app.post('/api/v1/boards', async (req, reply) => {
    const { accountId, userId } = authOf(req);
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    const { folderId, name, description } = parsed.data;

    const [folder] = await db.select({ id: folders.id, businessId: folders.businessId }).from(folders)
      .where(tenantWhere(folders, accountId, eq(folders.id, folderId))).limit(1);
    if (!folder) return reply.code(400).send({ error: 'Folder not found.' });
    if (!(await assertMaybeBusiness(req, reply, folder.businessId, 'member'))) return;

    const position = await nextPosition(boards, sql`account_id = ${accountId} AND folder_id = ${folderId}`);

    const boardId = await db.transaction(async (tx) => {
      const ins = await tx.insert(boards).values(withTenant(accountId, {
        folderId, name, description: description ?? null, position, createdBy: userId,
      }));
      const newId = Number(ins[0].insertId);
      await tx.insert(boardColumns).values(
        DEFAULT_COLUMNS.map((c, i) => withTenant(accountId, { boardId: newId, name: c.name, color: c.color, isDoneColumn: c.isDoneColumn, position: i })),
      );
      return newId;
    });
    const [created] = await db.select().from(boards)
      .where(tenantWhere(boards, accountId, eq(boards.id, boardId))).limit(1);
    return reply.code(201).send({ board: created });
  });

  app.patch('/api/v1/boards/:id', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    if (!(await assertBoardAccess(req, reply, id, 'member'))) return;
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    if (parsed.data.folderId) {
      const [folder] = await db.select({ id: folders.id }).from(folders)
        .where(tenantWhere(folders, accountId, eq(folders.id, parsed.data.folderId))).limit(1);
      if (!folder) return reply.code(400).send({ error: 'Folder not found.' });
    }
    const res = await db.update(boards).set(parsed.data)
      .where(tenantWhere(boards, accountId, eq(boards.id, id)));
    if (!res[0].affectedRows) return reply.code(404).send({ error: 'Board not found.' });
    const [updated] = await db.select().from(boards)
      .where(tenantWhere(boards, accountId, eq(boards.id, id))).limit(1);
    return { board: updated };
  });

  app.delete('/api/v1/boards/:id', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    if (!(await assertBoardAccess(req, reply, id, 'member'))) return;
    const res = await db.delete(boards).where(tenantWhere(boards, accountId, eq(boards.id, id)));
    if (!res[0].affectedRows) return reply.code(404).send({ error: 'Board not found.' });
    return { ok: true };
  });

  /**
   * Copy a board into any folder, including one in another business.
   *
   * A process you have worked out once should not be retyped for the next client.
   * Structure and card content come across; time entries, comments, assignees and
   * due dates deliberately do not, because those belong to the original run of the
   * work rather than to the shape of it. Assignees especially: the person on the
   * old card may not even have access to the business you are copying into.
   */
  app.post('/api/v1/boards/:id/copy', async (req, reply) => {
    const { accountId, userId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const parsed = z.object({
      targetFolderId: z.number().int().positive(),
      name: z.string().trim().min(1).max(150).optional(),
      includeCards: z.boolean().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });

    // Both ends are checked: you must be able to read the source and write to the
    // destination, which may sit in a different business entirely.
    if (!(await assertBoardAccess(req, reply, id, 'viewer'))) return;
    const [source] = await db.select().from(boards)
      .where(tenantWhere(boards, accountId, eq(boards.id, id))).limit(1);
    if (!source) return reply.code(404).send({ error: 'Board not found.' });

    const [target] = await db.select({ id: folders.id, businessId: folders.businessId, name: folders.name })
      .from(folders).where(tenantWhere(folders, accountId, eq(folders.id, parsed.data.targetFolderId))).limit(1);
    if (!target) return reply.code(404).send({ error: 'Destination folder not found.' });
    if (!(await assertMaybeBusiness(req, reply, target.businessId, 'member'))) return;

    const cols = await db.select().from(boardColumns)
      .where(tenantWhere(boardColumns, accountId, eq(boardColumns.boardId, id)))
      .orderBy(asc(boardColumns.position));
    const cards = parsed.data.includeCards === false ? [] : await db.select().from(tasks)
      .where(tenantWhere(tasks, accountId, and(eq(tasks.boardId, id), eq(tasks.isArchived, false))))
      .orderBy(asc(tasks.position));

    const position = await nextPosition(boards, sql`account_id = ${accountId} AND folder_id = ${target.id}`);
    const newBoardId = await db.transaction(async (tx) => {
      const ins = await tx.insert(boards).values(withTenant(accountId, {
        folderId: target.id, name: parsed.data.name?.trim() || `${source.name} (copy)`,
        description: source.description, position, createdBy: userId,
      }));
      const bid = Number(ins[0].insertId);

      // Map old column ids to new ones so cards land in the same lane.
      const colMap = new Map<number, number>();
      const source1 = cols.length ? cols : DEFAULT_COLUMNS.map((c, i) => ({ ...c, id: -(i + 1), position: i }));
      for (let i = 0; i < source1.length; i++) {
        const c = source1[i]!;
        const cIns = await tx.insert(boardColumns).values(withTenant(accountId, {
          boardId: bid, name: c.name, color: c.color, isDoneColumn: c.isDoneColumn, position: i,
        }));
        colMap.set(c.id, Number(cIns[0].insertId));
      }

      if (cards.length) {
        const perColumn = new Map<number, number>();
        for (const t of cards) {
          const targetCol = colMap.get(t.columnId) ?? [...colMap.values()][0]!;
          const pos = perColumn.get(targetCol) ?? 0;
          perColumn.set(targetCol, pos + 1);
          await tx.insert(tasks).values(withTenant(accountId, {
            boardId: bid, columnId: targetCol,
            title: t.title, description: t.description,
            priority: t.priority, estimateMinutes: t.estimateMinutes,
            position: pos, createdBy: userId,
          }));
        }
      }
      return bid;
    });

    const [created] = await db.select().from(boards)
      .where(tenantWhere(boards, accountId, eq(boards.id, newBoardId))).limit(1);
    return reply.code(201).send({ board: created, copiedCards: cards.length, into: target.name });
  });

  /** The template library, so the picker and the server cannot drift apart. */
  app.get('/api/v1/board-templates', async () => ({
    templates: BOARD_TEMPLATES.map((t) => ({
      key: t.key, label: t.label, blurb: t.blurb,
      columns: columnsFor(t).map((c) => c.name), cardCount: t.cards.length,
    })),
  }));

  /** Drop a ready-made board into a folder. */
  app.post('/api/v1/boards/from-template', async (req, reply) => {
    const { accountId, userId } = authOf(req);
    const parsed = z.object({
      template: z.string().trim().max(60),
      folderId: z.number().int().positive(),
      name: z.string().trim().min(1).max(150).optional(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });

    const tpl = boardTemplate(parsed.data.template);
    if (!tpl) return reply.code(404).send({ error: 'No such template.' });

    const [folder] = await db.select({ id: folders.id, businessId: folders.businessId }).from(folders)
      .where(tenantWhere(folders, accountId, eq(folders.id, parsed.data.folderId))).limit(1);
    if (!folder) return reply.code(404).send({ error: 'Folder not found.' });
    if (!(await assertMaybeBusiness(req, reply, folder.businessId, 'member'))) return;

    const columns = columnsFor(tpl);
    const position = await nextPosition(boards, sql`account_id = ${accountId} AND folder_id = ${folder.id}`);
    const newBoardId = await db.transaction(async (tx) => {
      const ins = await tx.insert(boards).values(withTenant(accountId, {
        folderId: folder.id, name: parsed.data.name?.trim() || tpl.label,
        description: tpl.blurb, position, createdBy: userId,
      }));
      const bid = Number(ins[0].insertId);
      const colIds: number[] = [];
      for (let i = 0; i < columns.length; i++) {
        const c = columns[i]!;
        const cIns = await tx.insert(boardColumns).values(withTenant(accountId, {
          boardId: bid, name: c.name, color: c.color, isDoneColumn: c.isDoneColumn ?? false, position: i,
        }));
        colIds.push(Number(cIns[0].insertId));
      }
      const perColumn = new Map<number, number>();
      for (const card of tpl.cards) {
        const idx = Math.min(card.column ?? 0, colIds.length - 1);
        const pos = perColumn.get(idx) ?? 0;
        perColumn.set(idx, pos + 1);
        await tx.insert(tasks).values(withTenant(accountId, {
          boardId: bid, columnId: colIds[idx]!, title: card.title,
          description: card.description ?? null, position: pos, createdBy: userId,
        }));
      }
      return bid;
    });

    const [created] = await db.select().from(boards)
      .where(tenantWhere(boards, accountId, eq(boards.id, newBoardId))).limit(1);
    return reply.code(201).send({ board: created, cards: tpl.cards.length });
  });

  // Persist sibling order after drag/drop within a folder.
  app.post('/api/v1/boards/reorder', async (req, reply) => {
    const { accountId } = authOf(req);
    const body = z.object({ orderedIds: z.array(z.number().int().positive()).max(500) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'orderedIds required.' });
    await db.transaction(async (tx) => {
      for (let i = 0; i < body.data.orderedIds.length; i++) {
        await tx.update(boards).set({ position: i })
          .where(and(eq(boards.accountId, accountId), eq(boards.id, body.data.orderedIds[i]!)));
      }
    });
    return { ok: true };
  });
}
