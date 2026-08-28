import { db } from '../db/client.js';
import { folders } from '../db/schema.js';
import { tenantWhere } from './tenant.js';
/** Every id in the subtree rooted at `rootId`, root included, from rows already read. */
export function subtreeIdsFrom(all, rootId) {
    const children = new Map();
    for (const f of all) {
        if (f.parentId == null)
            continue;
        const list = children.get(f.parentId) ?? [];
        list.push(f.id);
        children.set(f.parentId, list);
    }
    const out = [];
    const queue = [rootId];
    const seen = new Set();
    while (queue.length) {
        const id = queue.pop();
        if (seen.has(id))
            continue; // a cycle would otherwise loop forever
        seen.add(id);
        out.push(id);
        for (const c of children.get(id) ?? [])
            queue.push(c);
    }
    return out;
}
/** All folders in an account, as the walk needs them. */
export async function folderNodes(accountId) {
    return db.select({ id: folders.id, parentId: folders.parentId })
        .from(folders).where(tenantWhere(folders, accountId));
}
/** Every folder id in the subtree rooted at `rootId`, root included. */
export async function subtreeIds(accountId, rootId) {
    return subtreeIdsFrom(await folderNodes(accountId), rootId);
}
//# sourceMappingURL=folderTree.js.map