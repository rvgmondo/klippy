import { z } from 'zod';
import { authOf } from '../lib/context.js';
import { canSeeBusiness } from '../lib/access.js';
import { importInvoiceNinja } from '../lib/importInvoiceNinja.js';
/**
 * Bring clients (and, if wanted, old invoices) over from Invoice Ninja.
 *
 * The browser reads the CSV files and posts the rows, so nothing is uploaded or
 * stored as a file. Ask with dryRun first for the preview, then again without it
 * to write. Owner or admin only, because it adds clients in bulk.
 */
const rows = z.array(z.record(z.string(), z.string())).max(20000).optional();
const Body = z.object({
    businessId: z.number().int().positive(),
    dryRun: z.boolean(),
    files: z.object({
        clients: rows, contacts: rows, invoices: rows, quotes: rows, recurring: rows, payments: rows,
    }),
    choices: z.record(z.string(), z.union([z.number().int().positive(), z.literal('new'), z.literal('skip')])).optional(),
    include: z.object({
        contacts: z.boolean(), invoices: z.boolean(), quotes: z.boolean(), payments: z.boolean(), recurring: z.boolean(),
    }),
});
export async function importNinjaRoutes(app) {
    app.addHook('preHandler', app.requireAuth);
    app.post('/api/v1/import/invoice-ninja', { bodyLimit: 40 * 1024 * 1024 }, async (req, reply) => {
        const { accountId, userId, role } = authOf(req);
        if (role !== 'owner' && role !== 'admin') {
            return reply.code(403).send({ error: 'Only the owner or an admin can import clients.' });
        }
        const parsed = Body.safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: 'Those files could not be read. Pick the CSV files Invoice Ninja exported.' });
        const b = parsed.data;
        if (!(await canSeeBusiness(req, b.businessId)))
            return reply.code(404).send({ error: 'That business is not in this workspace.' });
        if (!b.files.clients?.length && !b.files.contacts?.length && !b.files.invoices?.length && !b.files.quotes?.length) {
            return reply.code(400).send({ error: 'Add at least the clients file.' });
        }
        try {
            return await importInvoiceNinja(accountId, userId, b.files, {
                businessId: b.businessId, dryRun: b.dryRun, choices: b.choices, include: b.include,
            });
        }
        catch (err) {
            req.log.error({ err }, 'invoice ninja import failed');
            return reply.code(500).send({ error: 'The import stopped and nothing was changed. Try again, or send the files to support.' });
        }
    });
}
//# sourceMappingURL=importNinja.js.map