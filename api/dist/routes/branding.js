import { createWriteStream, createReadStream } from 'node:fs';
import { mkdir, unlink, stat, readFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { accounts, folders, businesses } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere } from '../lib/tenant.js';
import { intId } from '../lib/http.js';
import { assertBusinessAccess, canSeeBusiness } from '../lib/access.js';
import { checkImage } from '../lib/imageGuard.js';
const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2MB is plenty for a logo
const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml']);
const uploadDir = () => process.env.UPLOAD_DIR ?? path.resolve(process.cwd(), '../data/uploads');
/** Save one uploaded image, returning its stored filename. */
async function saveImage(req, reply, prefix) {
    const part = await req.file({ limits: { fileSize: MAX_IMAGE_BYTES } });
    if (!part) {
        await reply.code(400).send({ error: 'No image uploaded.' });
        return null;
    }
    if (!ALLOWED.has(part.mimetype)) {
        await reply.code(400).send({ error: 'Use a PNG, JPG, WEBP, GIF or SVG image.' });
        return null;
    }
    const ext = path.extname(part.filename).slice(0, 10).replace(/[^.a-zA-Z0-9]/g, '') || '.png';
    const stored = `${prefix}_${Date.now()}_${randomBytes(6).toString('hex')}${ext}`;
    const dir = uploadDir();
    await mkdir(dir, { recursive: true });
    const dest = path.join(dir, stored);
    try {
        await pipeline(part.file, createWriteStream(dest));
    }
    catch (err) {
        await unlink(dest).catch(() => { });
        throw err;
    }
    if (part.file.truncated) {
        await unlink(dest).catch(() => { });
        await reply.code(400).send({ error: 'Image must be under 2MB.' });
        return null;
    }
    // Check the bytes, not just the declared type. A truncated PNG passes the
    // mimetype check and then costs pdfkit about fifty seconds per invoice before it
    // gives up, so a bad file is refused here rather than quietly poisoning every
    // document this business ever sends. PNG and JPEG only for logos, since those are
    // the two the PDF can embed; the others stay allowed for non-document images.
    const looksLikeDocumentImage = /\.(png|jpe?g)$/i.test(stored) || part.mimetype.startsWith('image/png') || part.mimetype.startsWith('image/jpeg');
    if (looksLikeDocumentImage) {
        const bytes = await readFile(dest).catch(() => null);
        const check = bytes ? checkImage(bytes) : { ok: false, reason: 'Could not read the upload.' };
        if (!check.ok) {
            await unlink(dest).catch(() => { });
            await reply.code(400).send({ error: check.reason ?? 'That image could not be read.' });
            return null;
        }
    }
    return stored;
}
async function sendImage(reply, stored) {
    if (!stored)
        return reply.code(404).send({ error: 'No image set.' });
    const full = path.join(uploadDir(), stored);
    try {
        await stat(full);
    }
    catch {
        return reply.code(404).send({ error: 'Image missing.' });
    }
    const ext = path.extname(stored).toLowerCase();
    const type = ext === '.svg' ? 'image/svg+xml'
        : ext === '.png' ? 'image/png'
            : ext === '.webp' ? 'image/webp'
                : ext === '.gif' ? 'image/gif' : 'image/jpeg';
    reply.header('Content-Type', type);
    reply.header('Cache-Control', 'private, max-age=300');
    return reply.send(createReadStream(full));
}
export async function brandingRoutes(app) {
    app.addHook('preHandler', app.requireAuth);
    // ---- Workspace logo (white-labelling) ----
    app.post('/api/v1/account/logo', async (req, reply) => {
        const { accountId, role } = authOf(req);
        if (role === 'member')
            return reply.code(403).send({ error: 'Only admins can change branding.' });
        const stored = await saveImage(req, reply, `logo${accountId}`);
        if (!stored)
            return;
        const [acc] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
        await db.update(accounts).set({ logoPath: stored }).where(eq(accounts.id, accountId));
        if (acc?.logoPath)
            await unlink(path.join(uploadDir(), acc.logoPath)).catch(() => { });
        return reply.code(201).send({ ok: true });
    });
    app.delete('/api/v1/account/logo', async (req, reply) => {
        const { accountId, role } = authOf(req);
        if (role === 'member')
            return reply.code(403).send({ error: 'Only admins can change branding.' });
        const [acc] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
        await db.update(accounts).set({ logoPath: null }).where(eq(accounts.id, accountId));
        if (acc?.logoPath)
            await unlink(path.join(uploadDir(), acc.logoPath)).catch(() => { });
        return { ok: true };
    });
    app.get('/api/v1/account/logo', async (req, reply) => {
        const { accountId } = authOf(req);
        const [acc] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
        return sendImage(reply, acc?.logoPath ?? null);
    });
    // ---- Business logo (the brand a client sees on that business's invoices) ----
    app.post('/api/v1/businesses/:id/logo', async (req, reply) => {
        const { accountId } = authOf(req);
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        if (!(await assertBusinessAccess(req, reply, id, 'admin')))
            return;
        const [biz] = await db.select().from(businesses)
            .where(tenantWhere(businesses, accountId, eq(businesses.id, id))).limit(1);
        if (!biz)
            return reply.code(404).send({ error: 'Business not found.' });
        const stored = await saveImage(req, reply, `biz${id}`);
        if (!stored)
            return;
        await db.update(businesses).set({ logoPath: stored })
            .where(tenantWhere(businesses, accountId, eq(businesses.id, id)));
        if (biz.logoPath)
            await unlink(path.join(uploadDir(), biz.logoPath)).catch(() => { });
        return reply.code(201).send({ ok: true });
    });
    app.delete('/api/v1/businesses/:id/logo', async (req, reply) => {
        const { accountId } = authOf(req);
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        if (!(await assertBusinessAccess(req, reply, id, 'admin')))
            return;
        const [biz] = await db.select().from(businesses)
            .where(tenantWhere(businesses, accountId, eq(businesses.id, id))).limit(1);
        if (!biz)
            return reply.code(404).send({ error: 'Business not found.' });
        await db.update(businesses).set({ logoPath: null })
            .where(tenantWhere(businesses, accountId, eq(businesses.id, id)));
        if (biz.logoPath)
            await unlink(path.join(uploadDir(), biz.logoPath)).catch(() => { });
        return { ok: true };
    });
    // Logo serving is not secret (it appears on invoices sent to clients), but keep it
    // behind auth like the account logo; the invoice PDF is rendered by a logged-in user.
    app.get('/api/v1/businesses/:id/logo', async (req, reply) => {
        const { accountId } = authOf(req);
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        if (!(await canSeeBusiness(req, id)))
            return reply.code(404).send({ error: 'Not found.' });
        const [biz] = await db.select({ logoPath: businesses.logoPath }).from(businesses)
            .where(tenantWhere(businesses, accountId, eq(businesses.id, id))).limit(1);
        return sendImage(reply, biz?.logoPath ?? null);
    });
    // ---- Per-business (folder) image ----
    app.post('/api/v1/folders/:id/image', async (req, reply) => {
        const { accountId } = authOf(req);
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        const [folder] = await db.select().from(folders)
            .where(tenantWhere(folders, accountId, eq(folders.id, id))).limit(1);
        if (!folder)
            return reply.code(404).send({ error: 'Not found.' });
        const stored = await saveImage(req, reply, `folder${id}`);
        if (!stored)
            return;
        await db.update(folders).set({ imagePath: stored })
            .where(tenantWhere(folders, accountId, eq(folders.id, id)));
        if (folder.imagePath)
            await unlink(path.join(uploadDir(), folder.imagePath)).catch(() => { });
        return reply.code(201).send({ ok: true });
    });
    app.delete('/api/v1/folders/:id/image', async (req, reply) => {
        const { accountId } = authOf(req);
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        const [folder] = await db.select().from(folders)
            .where(tenantWhere(folders, accountId, eq(folders.id, id))).limit(1);
        if (!folder)
            return reply.code(404).send({ error: 'Not found.' });
        await db.update(folders).set({ imagePath: null })
            .where(tenantWhere(folders, accountId, eq(folders.id, id)));
        if (folder.imagePath)
            await unlink(path.join(uploadDir(), folder.imagePath)).catch(() => { });
        return { ok: true };
    });
    app.get('/api/v1/folders/:id/image', async (req, reply) => {
        const { accountId } = authOf(req);
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        const [folder] = await db.select().from(folders)
            .where(tenantWhere(folders, accountId, eq(folders.id, id))).limit(1);
        return sendImage(reply, folder?.imagePath ?? null);
    });
}
//# sourceMappingURL=branding.js.map