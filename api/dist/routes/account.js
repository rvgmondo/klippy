import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { accounts } from '../db/schema.js';
import { authOf } from '../lib/context.js';
const updateSchema = z.object({
    name: z.string().trim().min(1).max(150).optional(),
    folderLabelSingular: z.string().trim().min(1).max(40).optional(),
    folderLabelPlural: z.string().trim().min(1).max(40).optional(),
});
function publicAccount(a) {
    return {
        id: a.id, name: a.name, slug: a.slug, plan: a.plan,
        folderLabelSingular: a.folderLabelSingular, folderLabelPlural: a.folderLabelPlural,
    };
}
export async function accountRoutes(app) {
    app.addHook('preHandler', app.requireAuth);
    // Update workspace settings (owner/admin only).
    app.patch('/api/v1/account', async (req, reply) => {
        const { accountId, role } = authOf(req);
        if (role === 'member') {
            return reply.code(403).send({ error: 'Only workspace admins can change settings.' });
        }
        const parsed = updateSchema.safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: parsed.error.issues[0]?.message });
        if (Object.keys(parsed.data).length === 0) {
            return reply.code(400).send({ error: 'Nothing to update.' });
        }
        await db.update(accounts).set(parsed.data).where(eq(accounts.id, accountId));
        const [updated] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
        if (!updated)
            return reply.code(404).send({ error: 'Account not found.' });
        return { account: publicAccount(updated) };
    });
}
//# sourceMappingURL=account.js.map