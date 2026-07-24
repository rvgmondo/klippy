import type { FastifyInstance } from 'fastify';
import { and, eq, isNotNull, lt, lte, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { tasks, users, boards, folders } from '../db/schema.js';
import { sendMail, appUrl } from '../lib/mailer.js';

const todayStr = () => new Date().toISOString().slice(0, 10);

interface Row { id: number; title: string; dueDate: string | null; priority: string; boardName: string | null; folderName: string | null; }

function renderDigest(name: string, today: Row[], overdue: Row[]): string {
  const line = (t: Row) => {
    const where = [t.folderName, t.boardName].filter(Boolean).join(' / ');
    const pri = t.priority !== 'none' ? ` [${t.priority}]` : '';
    return `  - ${t.title}${pri}${where ? `  (${where})` : ''}`;
  };
  const parts = [`Morning ${name},`, ''];
  if (overdue.length) {
    parts.push(`OVERDUE (${overdue.length}):`, ...overdue.map((t) => `${line(t)}  - was due ${t.dueDate}`), '');
  }
  if (today.length) {
    parts.push(`DUE TODAY (${today.length}):`, ...today.map(line), '');
  }
  if (!overdue.length && !today.length) parts.push('Nothing due today and nothing overdue. Enjoy it.', '');
  parts.push(`Open Klippy: ${appUrl()}`, '', 'To stop these, turn off the daily digest in Settings > Profile.');
  return parts.join('\n');
}

export async function cronRoutes(app: FastifyInstance) {
  /**
   * Morning digest. Called by a cPanel cron job, authenticated with a shared
   * secret (CRON_SECRET) since there is no logged-in user:
   *   curl -s -H "X-Cron-Key: SECRET" https://your-site/api/v1/cron/daily-digest
   */
  app.post('/api/v1/cron/daily-digest', async (req, reply) => {
    const secret = process.env.CRON_SECRET;
    if (!secret) return reply.code(503).send({ error: 'CRON_SECRET is not configured.' });
    const given = (req.headers['x-cron-key'] as string | undefined) ?? '';
    if (given !== secret) return reply.code(401).send({ error: 'Bad cron key.' });

    const today = todayStr();
    const recipients = await db.select().from(users)
      .where(and(eq(users.isActive, true), eq(users.dailyDigest, true)));

    let sent = 0;
    for (const u of recipients) {
      const base = and(
        eq(tasks.accountId, u.accountId),
        eq(tasks.isArchived, false),
        eq(tasks.isCompleted, false),
        isNotNull(tasks.dueDate),
      );
      const select = () => db.select({
        id: tasks.id, title: tasks.title, dueDate: tasks.dueDate, priority: tasks.priority,
        boardName: boards.name, folderName: folders.name,
      }).from(tasks)
        .leftJoin(boards, eq(boards.id, tasks.boardId))
        .leftJoin(folders, eq(folders.id, boards.folderId));

      const dueToday = await select().where(and(base, eq(tasks.dueDate, today))).limit(50) as Row[];
      const overdue = await select().where(and(base, lt(tasks.dueDate, today))).limit(50) as Row[];
      if (!dueToday.length && !overdue.length) continue; // don't nag with empty mail

      const subject = overdue.length
        ? `Klippy: ${dueToday.length} due today, ${overdue.length} overdue`
        : `Klippy: ${dueToday.length} due today`;
      try {
        await sendMail(u.email, subject, renderDigest(u.name, dueToday, overdue));
        sent++;
      } catch (err) {
        req.log.error({ err, to: u.email }, 'digest send failed');
      }
    }
    return { ok: true, considered: recipients.length, sent };
  });
}
