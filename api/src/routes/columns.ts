import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { boardColumns, boards } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere, withTenant } from '../lib/tenant.js';
import { assertBoardAccess, assertColumnAccess } from '../lib/access.js';
import { intId, nextPosition } from '../lib/http.js';

const createSchema = z.object({
  boardId: z.number().int().positive(),
  name: z.string().trim().min(1).max(100),
  color: z.string().trim().max(20).optional(),
  isDoneColumn: z.boolean().optional(),
});
const updateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  color: z.string().trim().max(20).optional(),
  isDoneColumn: z.boolean().optional(),
});

export async function columnRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  app.post('/api/v1/columns', async (req, reply) => {
    const { accountId } = authOf(req);
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    const { boardId, name, color, isDoneColumn } = parsed.data;
    const [board] = await db.select({ id: boards.id }).from(boards)
      .where(tenantWhere(boards, accountId, eq(boards.id, boardId))).limit(1);
    if (!board) return reply.code(400).send({ error: 'Board not found.' });
    if (!(await assertBoardAccess(req, reply, boardId, 'member'))) return;
    const position = await nextPosition(boardColumns, sql`account_id = ${accountId} AND board_id = ${boardId}`);
    const ins = await db.insert(boardColumns).values(withTenant(accountId, {
      boardId, name, color: color ?? '#94a3b8', isDoneColumn: isDoneColumn ?? false, position,
    }));
    const [created] = await db.select().from(boardColumns)
      .where(tenantWhere(boardColumns, accountId, eq(boardColumns.id, Number(ins[0].insertId)))).limit(1);
    return reply.code(201).send({ column: created });
  });

  app.patch('/api/v1/columns/:id', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    if (!(await assertColumnAccess(req, reply, id, 'member'))) return;
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    const res = await db.update(boardColumns).set(parsed.data)
      .where(tenantWhere(boardColumns, accountId, eq(boardColumns.id, id)));
    if (!res[0].affectedRows) return reply.code(404).send({ error: 'Column not found.' });
    const [updated] = await db.select().from(boardColumns)
      .where(tenantWhere(boardColumns, accountId, eq(boardColumns.id, id))).limit(1);
    return { column: updated };
  });

  // Deletes the column and its cards (FK cascade).
  app.delete('/api/v1/columns/:id', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    if (!(await assertColumnAccess(req, reply, id, 'member'))) return;
    const res = await db.delete(boardColumns).where(tenantWhere(boardColumns, accountId, eq(boardColumns.id, id)));
    if (!res[0].affectedRows) return reply.code(404).send({ error: 'Column not found.' });
    return { ok: true };
  });

  app.post('/api/v1/columns/reorder', async (req, reply) => {
    const { accountId } = authOf(req);
    const body = z.object({ orderedIds: z.array(z.number().int().positive()).max(200) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'orderedIds required.' });
    await db.transaction(async (tx) => {
      for (let i = 0; i < body.data.orderedIds.length; i++) {
        await tx.update(boardColumns).set({ position: i })
          .where(and(eq(boardColumns.accountId, accountId), eq(boardColumns.id, body.data.orderedIds[i]!)));
      }
    });
    return { ok: true };
  });
}
