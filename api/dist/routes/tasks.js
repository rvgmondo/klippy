import { z } from 'zod';
import { and, asc, desc, eq, gte, lte, ne, or, isNull, isNotNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { tasks, boards, boardColumns, folders, users, taskSubtasks, taskComments, taskLabels, labels } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere, withTenant } from '../lib/tenant.js';
import { intId, nextPosition } from '../lib/http.js';
import { assertTaskAccess, assertBoardAccess, businessScope } from '../lib/access.js';
import { isActiveMember } from '../lib/membership.js';
import { notify } from '../lib/push.js';
import { appUrl } from '../lib/mailer.js';
const priority = z.enum(['none', 'low', 'medium', 'high', 'urgent']);
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const recurrence = z.enum(['none', 'daily', 'weekly', 'biweekly', 'monthly']);
/** Advance a YYYY-MM-DD date by one recurrence interval. */
function advance(dateStr, rule) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (rule === 'daily')
        dt.setUTCDate(dt.getUTCDate() + 1);
    else if (rule === 'weekly')
        dt.setUTCDate(dt.getUTCDate() + 7);
    else if (rule === 'biweekly')
        dt.setUTCDate(dt.getUTCDate() + 14);
    else {
        // Monthly: keep the day-of-month, clamping for short months (31 Jan -> 28 Feb).
        const targetMonth = dt.getUTCMonth() + 1;
        const day = dt.getUTCDate();
        dt.setUTCDate(1);
        dt.setUTCMonth(targetMonth);
        const lastDay = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
        dt.setUTCDate(Math.min(day, lastDay));
    }
    return dt.toISOString().slice(0, 10);
}
const createSchema = z.object({
    boardId: z.number().int().positive(),
    columnId: z.number().int().positive(),
    title: z.string().trim().min(1).max(200),
    description: z.string().max(20000).nullable().optional(),
    priority: priority.optional(),
    dueDate: dateStr.nullable().optional(),
    assignedTo: z.number().int().positive().nullable().optional(),
    estimateMinutes: z.number().int().min(0).max(60 * 24).nullable().optional(),
    scheduledStart: z.string().datetime({ offset: true }).nullable().optional(),
});
const updateSchema = z.object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(20000).nullable().optional(),
    priority: priority.optional(),
    dueDate: dateStr.nullable().optional(),
    recurrence: recurrence.optional(),
    assignedTo: z.number().int().positive().nullable().optional(),
    isCompleted: z.boolean().optional(),
    isArchived: z.boolean().optional(),
    // Time blocking: how long you think it takes, and when you plan to do it.
    estimateMinutes: z.number().int().min(0).max(60 * 24).nullable().optional(),
    scheduledStart: z.string().datetime({ offset: true }).nullable().optional(),
});
const moveSchema = z.object({
    columnId: z.number().int().positive(),
    position: z.number().int().min(0).max(100000),
});
async function assertColumnInAccount(accountId, boardId, columnId) {
    const [col] = await db.select({ id: boardColumns.id }).from(boardColumns)
        .where(tenantWhere(boardColumns, accountId, and(eq(boardColumns.id, columnId), eq(boardColumns.boardId, boardId)))).limit(1);
    return !!col;
}
export async function taskRoutes(app) {
    app.addHook('preHandler', app.requireAuth);
    // Cards with a due date in [from, to] across the whole account (for the calendar).
    app.get('/api/v1/tasks/calendar', async (req, reply) => {
        const { accountId } = authOf(req);
        const q = z.object({ from: dateStr, to: dateStr }).safeParse(req.query);
        if (!q.success)
            return reply.code(400).send({ error: 'from and to (YYYY-MM-DD) required.' });
        // Scope to the businesses the user can see (tasks reach a business via board
        // -> folder), so a member's calendar never shows another business's work.
        const rows = await db.select({
            id: tasks.id, title: tasks.title, priority: tasks.priority, dueDate: tasks.dueDate,
            boardId: tasks.boardId, columnId: tasks.columnId, isCompleted: tasks.isCompleted,
        }).from(tasks)
            .leftJoin(boards, eq(boards.id, tasks.boardId))
            .leftJoin(folders, eq(folders.id, boards.folderId))
            .where(tenantWhere(tasks, accountId, and(eq(tasks.isArchived, false), isNotNull(tasks.dueDate), isNull(boards.deletedAt), gte(tasks.dueDate, q.data.from), lte(tasks.dueDate, q.data.to), await businessScope(req, folders.businessId)))).orderBy(asc(tasks.dueDate));
        return { tasks: rows };
    });
    /**
     * Day planner. Everything needed to plan one day in a single round trip:
     *  - `scheduled`: cards blocked onto this day, in time order
     *  - `backlog`: unscheduled open cards worth pulling in (due on/before this day,
     *     or with no date at all), so there is something to drag onto the timeline
     *  - `capacity`: planned minutes vs the working day, which is what makes
     *     over-committing visible instead of a surprise at 6pm
     * Optional ?businessId scopes it like the rest of the app; ?mine=1 limits to
     * cards assigned to you (or unassigned).
     */
    app.get('/api/v1/tasks/day', async (req, reply) => {
        const { accountId, userId } = authOf(req);
        const q = z.object({
            date: dateStr,
            businessId: z.coerce.number().int().positive().optional(),
            mine: z.coerce.boolean().optional(),
            workingMinutes: z.coerce.number().int().min(60).max(60 * 24).optional(),
        }).safeParse(req.query);
        if (!q.success)
            return reply.code(400).send({ error: 'date (YYYY-MM-DD) required.' });
        const { date, businessId, mine, workingMinutes = 480 } = q.data;
        const dayStart = new Date(`${date}T00:00:00.000Z`);
        const dayEnd = new Date(`${date}T23:59:59.999Z`);
        // Cards live under boards -> folders, and the business lives on the folder, so
        // scoping by business means joining out to the folder.
        const base = () => db.select({
            id: tasks.id, title: tasks.title, priority: tasks.priority, dueDate: tasks.dueDate,
            boardId: tasks.boardId, columnId: tasks.columnId, isCompleted: tasks.isCompleted,
            estimateMinutes: tasks.estimateMinutes, scheduledStart: tasks.scheduledStart,
            assignedTo: tasks.assignedTo, boardName: boards.name, folderName: folders.name,
        }).from(tasks)
            .leftJoin(boards, eq(boards.id, tasks.boardId))
            .leftJoin(folders, eq(folders.id, boards.folderId));
        const scopes = [eq(tasks.isArchived, false), isNull(boards.deletedAt)];
        if (businessId)
            scopes.push(eq(folders.businessId, businessId));
        if (mine)
            scopes.push(or(eq(tasks.assignedTo, userId), isNull(tasks.assignedTo)));
        // Restrict to the member's accessible businesses (no-op for owners/admins).
        const scope = await businessScope(req, folders.businessId);
        if (scope)
            scopes.push(scope);
        const scheduled = await base()
            .where(tenantWhere(tasks, accountId, and(...scopes, gte(tasks.scheduledStart, dayStart), lte(tasks.scheduledStart, dayEnd))))
            .orderBy(asc(tasks.scheduledStart));
        const backlog = await base()
            .where(tenantWhere(tasks, accountId, and(...scopes, eq(tasks.isCompleted, false), isNull(tasks.scheduledStart), or(isNull(tasks.dueDate), lte(tasks.dueDate, date)))))
            .orderBy(asc(tasks.dueDate)).limit(50);
        const plannedMinutes = scheduled
            .filter((t) => !t.isCompleted)
            .reduce((sum, t) => sum + (t.estimateMinutes ?? 0), 0);
        return {
            date,
            scheduled,
            backlog,
            capacity: {
                workingMinutes,
                plannedMinutes,
                remainingMinutes: workingMinutes - plannedMinutes,
                overcommitted: plannedMinutes > workingMinutes,
                // Cards on the day with no estimate: the planned total is a lie until these
                // are filled in, so the UI can say so rather than quietly under-reporting.
                unestimated: scheduled.filter((t) => !t.isCompleted && t.estimateMinutes == null).length,
            },
        };
    });
    // Full card detail: the card + its subtasks + comments (with author name).
    app.get('/api/v1/tasks/:id/detail', async (req, reply) => {
        const { accountId } = authOf(req);
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        if (!(await assertTaskAccess(req, reply, id, 'viewer')))
            return;
        const [task] = await db.select().from(tasks)
            .where(tenantWhere(tasks, accountId, eq(tasks.id, id))).limit(1);
        if (!task)
            return reply.code(404).send({ error: 'Task not found.' });
        const subtasks = await db.select().from(taskSubtasks)
            .where(tenantWhere(taskSubtasks, accountId, eq(taskSubtasks.taskId, id)))
            .orderBy(asc(taskSubtasks.position));
        const comments = await db.select({
            id: taskComments.id, comment: taskComments.comment, createdAt: taskComments.createdAt,
            userId: taskComments.userId, authorName: users.name,
        }).from(taskComments)
            .leftJoin(users, eq(users.id, taskComments.userId))
            .where(tenantWhere(taskComments, accountId, eq(taskComments.taskId, id)))
            .orderBy(desc(taskComments.createdAt));
        const cardLabels = await db.select({ id: labels.id, name: labels.name, color: labels.color })
            .from(taskLabels).innerJoin(labels, eq(labels.id, taskLabels.labelId))
            .where(tenantWhere(taskLabels, accountId, eq(taskLabels.taskId, id)));
        return { task, subtasks, comments, labels: cardLabels };
    });
    app.post('/api/v1/tasks', async (req, reply) => {
        const { accountId, userId } = authOf(req);
        const parsed = createSchema.safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: parsed.error.issues[0]?.message });
        const { boardId, columnId, title, description, priority: pr, dueDate, assignedTo, estimateMinutes, scheduledStart } = parsed.data;
        const [board] = await db.select({ id: boards.id }).from(boards)
            .where(tenantWhere(boards, accountId, eq(boards.id, boardId))).limit(1);
        if (!board)
            return reply.code(400).send({ error: 'Board not found.' });
        if (!(await assertBoardAccess(req, reply, boardId, 'member')))
            return;
        if (!(await assertColumnInAccount(accountId, boardId, columnId))) {
            return reply.code(400).send({ error: 'Column not found on this board.' });
        }
        if (assignedTo && !(await userInAccount(accountId, assignedTo))) {
            return reply.code(400).send({ error: 'Assignee not found.' });
        }
        const position = await nextPosition(tasks, sql `account_id = ${accountId} AND column_id = ${columnId}`);
        const ins = await db.insert(tasks).values(withTenant(accountId, {
            boardId, columnId, title, description: description ?? null,
            priority: pr ?? 'none', dueDate: dueDate ?? null, assignedTo: assignedTo ?? null,
            estimateMinutes: estimateMinutes ?? null,
            scheduledStart: scheduledStart ? new Date(scheduledStart) : null,
            position, createdBy: userId,
        }));
        const [created] = await db.select().from(tasks)
            .where(tenantWhere(tasks, accountId, eq(tasks.id, Number(ins[0].insertId)))).limit(1);
        return reply.code(201).send({ task: created });
    });
    app.patch('/api/v1/tasks/:id', async (req, reply) => {
        const { accountId } = authOf(req);
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        if (!(await assertTaskAccess(req, reply, id, 'member')))
            return;
        const parsed = updateSchema.safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: parsed.error.issues[0]?.message });
        const [existing] = await db.select().from(tasks)
            .where(tenantWhere(tasks, accountId, eq(tasks.id, id))).limit(1);
        if (!existing)
            return reply.code(404).send({ error: 'Task not found.' });
        if (parsed.data.assignedTo && !(await userInAccount(accountId, parsed.data.assignedTo))) {
            return reply.code(400).send({ error: 'Assignee not found.' });
        }
        const patch = { ...parsed.data };
        // Maintain completedAt alongside isCompleted.
        if (parsed.data.isCompleted !== undefined) {
            patch.completedAt = parsed.data.isCompleted ? new Date() : null;
        }
        // scheduledStart arrives as an ISO string; the column is a datetime.
        if (parsed.data.scheduledStart !== undefined) {
            patch.scheduledStart = parsed.data.scheduledStart ? new Date(parsed.data.scheduledStart) : null;
        }
        await db.update(tasks).set(patch).where(tenantWhere(tasks, accountId, eq(tasks.id, id)));
        // Completing a recurring card spawns the next occurrence, due one interval
        // later. Only on the transition into completed, and only if it has a date.
        let spawned = null;
        const becameComplete = parsed.data.isCompleted === true && !existing.isCompleted;
        const rule = existing.recurrence;
        if (becameComplete && rule !== 'none' && existing.dueDate) {
            const nextDue = advance(existing.dueDate, rule);
            const position = await nextPosition(tasks, sql `account_id = ${accountId} AND column_id = ${existing.columnId}`);
            const ins = await db.insert(tasks).values(withTenant(accountId, {
                boardId: existing.boardId, columnId: existing.columnId, title: existing.title,
                description: existing.description, priority: existing.priority, dueDate: nextDue,
                recurrence: rule, assignedTo: existing.assignedTo, position, createdBy: existing.createdBy,
            }));
            spawned = Number(ins[0].insertId);
        }
        const [updated] = await db.select().from(tasks)
            .where(tenantWhere(tasks, accountId, eq(tasks.id, id))).limit(1);
        // assignee notification: someone was newly assigned (and it isn't the actor).
        if (parsed.data.assignedTo && parsed.data.assignedTo !== existing.assignedTo
            && parsed.data.assignedTo !== authOf(req).userId) {
            notify(parsed.data.assignedTo, {
                title: 'Assigned to you',
                body: existing.title,
                url: `${appUrl()}?v=board&board=${existing.boardId}`,
                tag: `task-${id}`,
            });
        }
        return { task: updated, spawnedTaskId: spawned };
    });
    // Move a card within/between columns of the same board; reindex the target.
    app.post('/api/v1/tasks/:id/move', async (req, reply) => {
        const { accountId } = authOf(req);
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        if (!(await assertTaskAccess(req, reply, id, 'member')))
            return;
        const parsed = moveSchema.safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: parsed.error.issues[0]?.message });
        const [task] = await db.select().from(tasks)
            .where(tenantWhere(tasks, accountId, eq(tasks.id, id))).limit(1);
        if (!task)
            return reply.code(404).send({ error: 'Task not found.' });
        if (!(await assertColumnInAccount(accountId, task.boardId, parsed.data.columnId))) {
            return reply.code(400).send({ error: 'Target column not on this board.' });
        }
        await db.transaction(async (tx) => {
            await tx.update(tasks).set({ columnId: parsed.data.columnId })
                .where(tenantWhere(tasks, accountId, eq(tasks.id, id)));
            const siblings = await tx.select({ id: tasks.id }).from(tasks)
                .where(tenantWhere(tasks, accountId, and(eq(tasks.columnId, parsed.data.columnId), eq(tasks.isArchived, false), ne(tasks.id, id))))
                .orderBy(asc(tasks.position));
            const ids = siblings.map((s) => s.id);
            const pos = Math.min(parsed.data.position, ids.length);
            ids.splice(pos, 0, id);
            for (let i = 0; i < ids.length; i++) {
                await tx.update(tasks).set({ position: i })
                    .where(and(eq(tasks.accountId, accountId), eq(tasks.id, ids[i])));
            }
        });
        const [moved] = await db.select().from(tasks)
            .where(tenantWhere(tasks, accountId, eq(tasks.id, id))).limit(1);
        return { task: moved };
    });
    app.delete('/api/v1/tasks/:id', async (req, reply) => {
        const { accountId } = authOf(req);
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        if (!(await assertTaskAccess(req, reply, id, 'member')))
            return;
        const res = await db.delete(tasks).where(tenantWhere(tasks, accountId, eq(tasks.id, id)));
        if (!res[0].affectedRows)
            return reply.code(404).send({ error: 'Task not found.' });
        return { ok: true };
    });
}
async function userInAccount(accountId, userId) {
    return isActiveMember(accountId, userId);
}
//# sourceMappingURL=tasks.js.map