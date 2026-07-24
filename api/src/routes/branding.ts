import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createWriteStream, createReadStream } from 'node:fs';
import { mkdir, unlink, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { accounts, folders } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere } from '../lib/tenant.js';
import { intId } from '../lib/http.js';

const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2MB is plenty for a logo
const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml']);

const uploadDir = () => process.env.UPLOAD_DIR ?? path.resolve(process.cwd(), '../data/uploads');

/** Save one uploaded image, returning its stored filename. */
async function saveImage(req: FastifyRequest, reply: FastifyReply, prefix: string): Promise<string | null> {
  const part = await req.file({ limits: { fileSize: MAX_IMAGE_BYTES } });
  if (!part) { await reply.code(400).send({ error: 'No image uploaded.' }); return null; }
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
  } catch (err) {
    await unlink(dest).catch(() => {});
    throw err;
  }
  if (part.file.truncated) {
    await unlink(dest).catch(() => {});
    await reply.code(400).send({ error: 'Image must be under 2MB.' });
    return null;
  }
  return stored;
}

async function sendImage(reply: FastifyReply, stored: string | null) {
  if (!stored) return reply.code(404).send({ error: 'No image set.' });
  const full = path.join(uploadDir(), stored);
  try { await stat(full); } catch { return reply.code(404).send({ error: 'Image missing.' }); }
  const ext = path.extname(stored).toLowerCase();
  const type = ext === '.svg' ? 'image/svg+xml'
    : ext === '.png' ? 'image/png'
    : ext === '.webp' ? 'image/webp'
    : ext === '.gif' ? 'image/gif' : 'image/jpeg';
  reply.header('Content-Type', type);
  reply.header('Cache-Control', 'private, max-age=300');
  return reply.send(createReadStream(full));
}

export async function brandingRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  // ---- Workspace logo (white-labelling) ----
  app.post('/api/v1/account/logo', async (req, reply) => {
    const { accountId, role } = authOf(req);
    if (role === 'member') return reply.code(403).send({ error: 'Only admins can change branding.' });
    const stored = await saveImage(req, reply, `logo${accountId}`);
    if (!stored) return;
    const [acc] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
    await db.update(accounts).set({ logoPath: stored }).where(eq(accounts.id, accountId));
    if (acc?.logoPath) await unlink(path.join(uploadDir(), acc.logoPath)).catch(() => {});
    return reply.code(201).send({ ok: true });
  });

  app.delete('/api/v1/account/logo', async (req, reply) => {
    const { accountId, role } = authOf(req);
    if (role === 'member') return reply.code(403).send({ error: 'Only admins can change branding.' });
    const [acc] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
    await db.update(accounts).set({ logoPath: null }).where(eq(accounts.id, accountId));
    if (acc?.logoPath) await unlink(path.join(uploadDir(), acc.logoPath)).catch(() => {});
    return { ok: true };
  });

  app.get('/api/v1/account/logo', async (req, reply) => {
    const { accountId } = authOf(req);
    const [acc] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
    return sendImage(reply, acc?.logoPath ?? null);
  });

  // ---- Per-business (folder) image ----
  app.post('/api/v1/folders/:id/image', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const [folder] = await db.select().from(folders)
      .where(tenantWhere(folders, accountId, eq(folders.id, id))).limit(1);
    if (!folder) return reply.code(404).send({ error: 'Not found.' });

    const stored = await saveImage(req, reply, `folder${id}`);
    if (!stored) return;
    await db.update(folders).set({ imagePath: stored })
      .where(tenantWhere(folders, accountId, eq(folders.id, id)));
    if (folder.imagePath) await unlink(path.join(uploadDir(), folder.imagePath)).catch(() => {});
    return reply.code(201).send({ ok: true });
  });

  app.delete('/api/v1/folders/:id/image', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const [folder] = await db.select().from(folders)
      .where(tenantWhere(folders, accountId, eq(folders.id, id))).limit(1);
    if (!folder) return reply.code(404).send({ error: 'Not found.' });
    await db.update(folders).set({ imagePath: null })
      .where(tenantWhere(folders, accountId, eq(folders.id, id)));
    if (folder.imagePath) await unlink(path.join(uploadDir(), folder.imagePath)).catch(() => {});
    return { ok: true };
  });

  app.get('/api/v1/folders/:id/image', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const [folder] = await db.select().from(folders)
      .where(tenantWhere(folders, accountId, eq(folders.id, id))).limit(1);
    return sendImage(reply, folder?.imagePath ?? null);
  });
}
