import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, gte, isNotNull, lte } from 'drizzle-orm';
import { db } from '../db/client.js';
import { timeEntries, tasks, boards, folders, users, accounts } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere } from '../lib/tenant.js';

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export async function reportRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  /**
   * Time in a date range turned into money.
   * Work rolls up to the top-level folder (the client you would invoice), and
   * the hourly rate is inherited from the nearest ancestor that has one set.
   */
  app.get('/api/v1/reports/time', async (req, reply) => {
    const { accountId } = authOf(req);
    const q = z.object({ from: dateStr, to: dateStr }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'from and to (YYYY-MM-DD) required.' });

    const start = new Date(`${q.data.from}T00:00:00.000Z`);
    const end = new Date(`${q.data.to}T23:59:59.999Z`);

    const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
    const currency = account?.currency ?? 'ZAR';

    // Every folder, so we can walk ancestors for rate inheritance and roll-up.
    const allFolders = await db.select({
      id: folders.id, parentId: folders.parentId, name: folders.name, hourlyRate: folders.hourlyRate,
    }).from(folders).where(tenantWhere(folders, accountId));
    const byId = new Map(allFolders.map((f) => [f.id, f]));

    const rootOf = (folderId: number) => {
      let cur = byId.get(folderId);
      for (let i = 0; i < 100 && cur?.parentId != null; i++) cur = byId.get(cur.parentId) ?? cur;
      return cur;
    };
    const rateFor = (folderId: number): number | null => {
      let cur = byId.get(folderId);
      for (let i = 0; i < 100 && cur; i++) {
        if (cur.hourlyRate != null) return Number(cur.hourlyRate);
        if (cur.parentId == null) break;
        cur = byId.get(cur.parentId);
      }
      return null;
    };

    const entries = await db.select({
      seconds: timeEntries.durationSeconds,
      userId: timeEntries.userId,
      userName: users.name,
      folderId: boards.folderId,
    }).from(timeEntries)
      .innerJoin(tasks, eq(tasks.id, timeEntries.taskId))
      .innerJoin(boards, eq(boards.id, tasks.boardId))
      .leftJoin(users, eq(users.id, timeEntries.userId))
      .where(tenantWhere(timeEntries, accountId, and(
        isNotNull(timeEntries.durationSeconds),
        gte(timeEntries.startTime, start),
        lte(timeEntries.startTime, end),
      )));

    const perClient = new Map<number, { name: string; seconds: number }>();
    const perPerson = new Map<number, { name: string; seconds: number }>();
    let totalSeconds = 0;

    for (const e of entries) {
      const secs = Number(e.seconds ?? 0);
      if (!secs) continue;
      totalSeconds += secs;

      const root = rootOf(e.folderId);
      if (root) {
        const cur = perClient.get(root.id) ?? { name: root.name, seconds: 0 };
        cur.seconds += secs;
        perClient.set(root.id, cur);
      }
      const p = perPerson.get(e.userId) ?? { name: e.userName ?? 'Someone', seconds: 0 };
      p.seconds += secs;
      perPerson.set(e.userId, p);
    }

    const clients = [...perClient.entries()].map(([folderId, v]) => {
      const rate = rateFor(folderId);
      const hours = v.seconds / 3600;
      return {
        folderId, name: v.name, seconds: v.seconds,
        hours: Math.round(hours * 100) / 100,
        rate,
        amount: rate == null ? null : Math.round(hours * rate * 100) / 100,
      };
    }).sort((a, b) => b.seconds - a.seconds);

    const people = [...perPerson.entries()].map(([userId, v]) => ({
      userId, name: v.name, seconds: v.seconds,
      hours: Math.round((v.seconds / 3600) * 100) / 100,
    })).sort((a, b) => b.seconds - a.seconds);

    const billable = clients.reduce((sum, c) => sum + (c.amount ?? 0), 0);

    return {
      currency,
      from: q.data.from,
      to: q.data.to,
      clients,
      people,
      totals: {
        seconds: totalSeconds,
        hours: Math.round((totalSeconds / 3600) * 100) / 100,
        amount: Math.round(billable * 100) / 100,
        unratedClients: clients.filter((c) => c.rate == null).length,
      },
    };
  });
}
