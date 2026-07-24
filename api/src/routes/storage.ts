import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { storageNodes, users } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere, withTenant } from '../lib/tenant.js';
import { intId } from '../lib/http.js';
import { storage, MAX_STORAGE_BYTES } from '../lib/storage.js';

const nameSchema = z.string().trim().min(1).max(255)
  .refine((n) => !n.includes('/') && !n.includes('\\'), 'Name cannot contain slashes');

/** Children of a folder (null = the root of the workspace's drive). */
function childrenWhere(accountId: number, parentId: number | null) {
  return parentId === null
    ? tenantWhere(storageNodes, accountId, isNull(storageNodes.parentId))
    : tenantWhere(storageNodes, accountId, eq(storageNodes.parentId, parentId));
}

/** Walk up from `candidateParent`; true if it is `nodeId` or inside it. */
async function wouldCycle(accountId: number, nodeId: number, candidateParent: number): Promise<boolean> {
  let cur: number | null = candidateParent;
  for (let i = 0; i < 200 && cur !== null; i++) {
    if (cur === nodeId) return true;
    const [row] = await db.select({ parentId: storageNodes.parentId }).from(storageNodes)
      .where(tenantWhere(storageNodes, accountId, eq(storageNodes.id, cur))).limit(1);
    cur = row?.parentId ?? null;
  }
  return false;
}

/**
 * Collect a subtree, deepest last. Done in code rather than leaning on the
 * self-referencing FK, because MySQL does not reliably cascade a self-reference
 * recursively, and we must delete the physical blobs anyway.
 */
async function collectSubtree(accountId: number, rootId: number) {
  const out: { id: number; kind: 'folder' | 'file'; storageKey: string | null }[] = [];
  const queue = [rootId];
  while (queue.length) {
    const id = queue.shift()!;
    const [node] = await db.select({ id: storageNodes.id, kind: storageNodes.kind, storageKey: storageNodes.storageKey })
      .from(storageNodes).where(tenantWhere(storageNodes, accountId, eq(storageNodes.id, id))).limit(1);
    if (!node) continue;
    out.push(node);
    if (node.kind === 'folder') {
      const kids = await db.select({ id: storageNodes.id }).from(storageNodes)
        .where(tenantWhere(storageNodes, accountId, eq(storageNodes.parentId, id)));
      queue.push(...kids.map((k) => k.id));
    }
  }
  return out;
}

export async function storageRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  // Every folder in the workspace, for drawing the tree.
  app.get('/api/v1/storage/tree', async (req) => {
    const { accountId } = authOf(req);
    const rows = await db.select({
      id: storageNodes.id, parentId: storageNodes.parentId, name: storageNodes.name,
    }).from(storageNodes)
      .where(tenantWhere(storageNodes, accountId, eq(storageNodes.kind, 'folder')))
      .orderBy(asc(storageNodes.name));
    return { folders: rows };
  });

  // Contents of one folder, plus the breadcrumb path to it.
  app.get('/api/v1/storage', async (req, reply) => {
    const { accountId } = authOf(req);
    const q = z.object({ parentId: z.coerce.number().int().positive().optional() }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'Bad parentId.' });
    const parentId = q.data.parentId ?? null;

    if (parentId !== null) {
      const [parent] = await db.select({ id: storageNodes.id, kind: storageNodes.kind }).from(storageNodes)
        .where(tenantWhere(storageNodes, accountId, eq(storageNodes.id, parentId))).limit(1);
      if (!parent || parent.kind !== 'folder') return reply.code(404).send({ error: 'Folder not found.' });
    }

    const items = await db.select({
      id: storageNodes.id, kind: storageNodes.kind, name: storageNodes.name,
      size: storageNodes.size, mimeType: storageNodes.mimeType,
      updatedAt: storageNodes.updatedAt, uploadedBy: storageNodes.uploadedBy,
      uploaderName: users.name,
    }).from(storageNodes)
      .leftJoin(users, eq(users.id, storageNodes.uploadedBy))
      .where(childrenWhere(accountId, parentId))
      .orderBy(asc(storageNodes.kind), asc(storageNodes.name));

    // Breadcrumbs, root-first.
    const trail: { id: number; name: string }[] = [];
    let cur: number | null = parentId;
    for (let i = 0; i < 200 && cur !== null; i++) {
      const [row] = await db.select({ id: storageNodes.id, name: storageNodes.name, parentId: storageNodes.parentId })
        .from(storageNodes).where(tenantWhere(storageNodes, accountId, eq(storageNodes.id, cur))).limit(1);
      if (!row) break;
      trail.unshift({ id: row.id, name: row.name });
      cur = row.parentId;
    }

    return { items, path: trail, parentId };
  });

  app.post('/api/v1/storage/folder', async (req, reply) => {
    const { accountId } = authOf(req);
    const parsed = z.object({
      name: nameSchema,
      parentId: z.number().int().positive().nullable().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
    const parentId = parsed.data.parentId ?? null;

    if (parentId !== null) {
      const [parent] = await db.select({ kind: storageNodes.kind }).from(storageNodes)
        .where(tenantWhere(storageNodes, accountId, eq(storageNodes.id, parentId))).limit(1);
      if (!parent || parent.kind !== 'folder') return reply.code(400).send({ error: 'Parent folder not found.' });
    }
    const ins = await db.insert(storageNodes).values(withTenant(accountId, {
      parentId, kind: 'folder' as const, name: parsed.data.name,
    }));
    const [created] = await db.select().from(storageNodes)
      .where(tenantWhere(storageNodes, accountId, eq(storageNodes.id, Number(ins[0].insertId)))).limit(1);
    return reply.code(201).send({ node: created });
  });

  app.post('/api/v1/storage/upload', async (req, reply) => {
    const { accountId, userId } = authOf(req);
    const q = z.object({ parentId: z.coerce.number().int().positive().optional() }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'Bad parentId.' });
    const parentId = q.data.parentId ?? null;

    if (parentId !== null) {
      const [parent] = await db.select({ kind: storageNodes.kind }).from(storageNodes)
        .where(tenantWhere(storageNodes, accountId, eq(storageNodes.id, parentId))).limit(1);
      if (!parent || parent.kind !== 'folder') return reply.code(400).send({ error: 'Folder not found.' });
    }

    const part = await req.file({ limits: { fileSize: MAX_STORAGE_BYTES } });
    if (!part) return reply.code(400).send({ error: 'No file uploaded.' });

    const ext = path.extname(part.filename).slice(0, 12).replace(/[^.a-zA-Z0-9]/g, '');
    const key = `${accountId}/${Date.now()}_${randomBytes(8).toString('hex')}${ext}`;
    const size = await storage().save(key, part.file);

    if (part.file.truncated) {
      await storage().delete(key);
      return reply.code(400).send({ error: 'File is larger than the 50MB limit.' });
    }

    const ins = await db.insert(storageNodes).values(withTenant(accountId, {
      parentId, kind: 'file' as const, name: part.filename.slice(0, 255),
      storageKey: key, size, mimeType: part.mimetype, uploadedBy: userId,
    }));
    const [created] = await db.select().from(storageNodes)
      .where(tenantWhere(storageNodes, accountId, eq(storageNodes.id, Number(ins[0].insertId)))).limit(1);
    return reply.code(201).send({ node: created });
  });

  // Rename and/or move.
  app.patch('/api/v1/storage/:id', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const parsed = z.object({
      name: nameSchema.optional(),
      parentId: z.number().int().positive().nullable().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });

    const [node] = await db.select().from(storageNodes)
      .where(tenantWhere(storageNodes, accountId, eq(storageNodes.id, id))).limit(1);
    if (!node) return reply.code(404).send({ error: 'Not found.' });

    if (parsed.data.parentId !== undefined && parsed.data.parentId !== null) {
      const [parent] = await db.select({ kind: storageNodes.kind }).from(storageNodes)
        .where(tenantWhere(storageNodes, accountId, eq(storageNodes.id, parsed.data.parentId))).limit(1);
      if (!parent || parent.kind !== 'folder') return reply.code(400).send({ error: 'Target folder not found.' });
      if (node.kind === 'folder' && await wouldCycle(accountId, id, parsed.data.parentId)) {
        return reply.code(400).send({ error: "Can't move a folder into itself." });
      }
    }

    await db.update(storageNodes).set(parsed.data)
      .where(tenantWhere(storageNodes, accountId, eq(storageNodes.id, id)));
    const [updated] = await db.select().from(storageNodes)
      .where(tenantWhere(storageNodes, accountId, eq(storageNodes.id, id))).limit(1);
    return { node: updated };
  });

  app.delete('/api/v1/storage/:id', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const [node] = await db.select({ id: storageNodes.id }).from(storageNodes)
      .where(tenantWhere(storageNodes, accountId, eq(storageNodes.id, id))).limit(1);
    if (!node) return reply.code(404).send({ error: 'Not found.' });

    const subtree = await collectSubtree(accountId, id);
    // Remove blobs first; a leftover row is recoverable, an orphaned blob is not.
    for (const n of subtree) if (n.storageKey) await storage().delete(n.storageKey);
    // Delete children before parents so foreign keys stay satisfied.
    for (const n of [...subtree].reverse()) {
      await db.delete(storageNodes).where(tenantWhere(storageNodes, accountId, eq(storageNodes.id, n.id)));
    }
    return { ok: true, deleted: subtree.length };
  });

  app.get('/api/v1/storage/:id/download', async (req, reply) => {
    const { accountId } = authOf(req);
    const id = intId(req);
    if (!id) return reply.code(400).send({ error: 'Bad id.' });
    const [node] = await db.select().from(storageNodes)
      .where(tenantWhere(storageNodes, accountId, eq(storageNodes.id, id))).limit(1);
    if (!node || node.kind !== 'file' || !node.storageKey) return reply.code(404).send({ error: 'File not found.' });
    if (!(await storage().exists(node.storageKey))) return reply.code(404).send({ error: 'File missing from storage.' });

    reply.header('Content-Type', node.mimeType ?? 'application/octet-stream');
    reply.header('Content-Disposition',
      `attachment; filename="${node.name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'")}"`);
    return reply.send(storage().createReadStream(node.storageKey));
  });

  // How much disk this workspace is using.
  app.get('/api/v1/storage/usage', async (req) => {
    const { accountId } = authOf(req);
    const [row] = await db.select({
      files: sql<number>`COUNT(*)`,
      bytes: sql<number>`COALESCE(SUM(size),0)`,
    }).from(storageNodes)
      .where(tenantWhere(storageNodes, accountId, eq(storageNodes.kind, 'file')));
    return { files: Number(row?.files ?? 0), bytes: Number(row?.bytes ?? 0) };
  });
}
