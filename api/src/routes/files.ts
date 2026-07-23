import type { FastifyInstance } from 'fastify';
import { createWriteStream, createReadStream } from 'node:fs';
import { mkdir, unlink, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { taskFiles, tasks } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere, withTenant } from '../lib/tenant.js';
import { intId } from '../lib/http.js';

export const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15MB, mirrors v1

// Same allowlist as the v1 PHP app: images, pdf, office docs, txt/csv, zip.
const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
  'application/pdf',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain', 'text/csv',
  'application/zip', 'application/x-zip-compressed',
]);

const uploadDir = () => process.env.UPLOAD_DIR ?? path.resolve(process.cwd(), '../data/uploads');

export async function fileRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  // Upload one file to a task (multipart field name: "file").
  app.post('/api/v1/tasks/:id/files', async (req, reply) => {
    const { accountId, userId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const [task] = await db.select({ id: tasks.id }).from(tasks)
      .where(tenantWhere(tasks, accountId, eq(tasks.id, id))).limit(1);
    if (!task) return reply.code(404).send({ error: 'Task not found.' });

    const part = await req.file({ limits: { fileSize: MAX_FILE_BYTES } });
    if (!part) return reply.code(400).send({ error: 'No file uploaded.' });
    if (!ALLOWED_MIME.has(part.mimetype)) {
      return reply.code(400).send({ error: 'File type not allowed (images, PDF, Office docs, txt/csv, zip).' });
    }

    const safeExt = path.extname(part.filename).slice(0, 10).replace(/[^.a-zA-Z0-9]/g, '');
    const storedName = `${accountId}_${Date.now()}_${randomBytes(8).toString('hex')}${safeExt}`;
    const dir = uploadDir();
    await mkdir(dir, { recursive: true });
    const dest = path.join(dir, storedName);

    try {
      await pipeline(part.file, createWriteStream(dest));
    } catch (err) {
      await unlink(dest).catch(() => {});
      throw err;
    }
    if (part.file.truncated) {
      await unlink(dest).catch(() => {});
      return reply.code(400).send({ error: 'File exceeds the 15MB limit.' });
    }

    const { size } = await stat(dest);
    const ins = await db.insert(taskFiles).values(withTenant(accountId, {
      taskId: id, userId,
      originalName: part.filename.slice(0, 255),
      storedName, filesize: size, mimeType: part.mimetype,
    }));
    const [created] = await db.select().from(taskFiles)
      .where(tenantWhere(taskFiles, accountId, eq(taskFiles.id, Number(ins[0].insertId)))).limit(1);
    return reply.code(201).send({ file: created });
  });

  // List a task's files.
  app.get('/api/v1/tasks/:id/files', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const files = await db.select().from(taskFiles)
      .where(tenantWhere(taskFiles, accountId, eq(taskFiles.taskId, id)));
    return { files };
  });

  // Download (auth + tenant checked; nothing served from disk directly).
  app.get('/api/v1/files/:id/download', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const [f] = await db.select().from(taskFiles)
      .where(tenantWhere(taskFiles, accountId, eq(taskFiles.id, id))).limit(1);
    if (!f) return reply.code(404).send({ error: 'File not found.' });
    const full = path.join(uploadDir(), f.storedName);
    try { await stat(full); } catch { return reply.code(404).send({ error: 'File missing from storage.' }); }
    reply.header('Content-Type', f.mimeType);
    reply.header('Content-Disposition',
      `attachment; filename="${f.originalName.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'")}"`);
    return reply.send(createReadStream(full));
  });

  app.delete('/api/v1/files/:id', async (req, reply) => {
    const { accountId, userId, role } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const [f] = await db.select().from(taskFiles)
      .where(tenantWhere(taskFiles, accountId, eq(taskFiles.id, id))).limit(1);
    if (!f) return reply.code(404).send({ error: 'File not found.' });
    if (f.userId !== userId && role === 'member') {
      return reply.code(403).send({ error: 'You can only delete your own uploads.' });
    }
    await db.delete(taskFiles).where(tenantWhere(taskFiles, accountId, eq(taskFiles.id, id)));
    await unlink(path.join(uploadDir(), f.storedName)).catch(() => {});
    return { ok: true };
  });
}
