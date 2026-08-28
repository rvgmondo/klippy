import { db } from '../db/client.js';
import { folders } from '../db/schema.js';
import { tenantWhere } from './tenant.js';

/**
 * Walking a client's folder subtree.
 *
 * Shared because two callers have to agree about it, and they are the two that
 * decide whether data is destroyed: the Trash purge, and the nightly sweep that
 * empties the Trash. Both need the same answer to "what actually goes when this
 * folder is deleted".
 *
 * The walk follows parentId, NOT the deletedAt stamp, because the FK cascade
 * follows parentId. Those two disagree in reachable cases: a folder can be created
 * under a trashed parent, and a child can be restored on its own while its ancestor
 * stays trashed. Checking the stamp would then look at a narrower set than the
 * delete actually reaches, which is the difference between a safe check and one that
 * only appears safe.
 */

export interface FolderNode { id: number; parentId: number | null }

/** Every id in the subtree rooted at `rootId`, root included, from rows already read. */
export function subtreeIdsFrom(all: FolderNode[], rootId: number): number[] {
  const children = new Map<number, number[]>();
  for (const f of all) {
    if (f.parentId == null) continue;
    const list = children.get(f.parentId) ?? [];
    list.push(f.id);
    children.set(f.parentId, list);
  }
  const out: number[] = [];
  const queue = [rootId];
  const seen = new Set<number>();
  while (queue.length) {
    const id = queue.pop()!;
    if (seen.has(id)) continue;   // a cycle would otherwise loop forever
    seen.add(id);
    out.push(id);
    for (const c of children.get(id) ?? []) queue.push(c);
  }
  return out;
}

/** All folders in an account, as the walk needs them. */
export async function folderNodes(accountId: number): Promise<FolderNode[]> {
  return db.select({ id: folders.id, parentId: folders.parentId })
    .from(folders).where(tenantWhere(folders, accountId));
}

/** Every folder id in the subtree rooted at `rootId`, root included. */
export async function subtreeIds(accountId: number, rootId: number): Promise<number[]> {
  return subtreeIdsFrom(await folderNodes(accountId), rootId);
}
