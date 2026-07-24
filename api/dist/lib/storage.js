import { createWriteStream, createReadStream } from 'node:fs';
import { mkdir, unlink, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
class LocalDiskDriver {
    root;
    constructor(root) {
        this.root = root;
    }
    full(key) {
        // Keys are generated server-side, but never trust them into a path.
        const safe = key.replace(/\\/g, '/').replace(/\.\.+/g, '').replace(/^\/+/, '');
        return path.join(this.root, safe);
    }
    async save(key, stream) {
        const dest = this.full(key);
        await mkdir(path.dirname(dest), { recursive: true });
        try {
            await pipeline(stream, createWriteStream(dest));
        }
        catch (err) {
            await unlink(dest).catch(() => { });
            throw err;
        }
        const { size } = await stat(dest);
        return size;
    }
    createReadStream(key) {
        return createReadStream(this.full(key));
    }
    async delete(key) {
        await unlink(this.full(key)).catch(() => { });
    }
    async exists(key) {
        try {
            await stat(this.full(key));
            return true;
        }
        catch {
            return false;
        }
    }
}
let driver = null;
export function storage() {
    if (driver)
        return driver;
    const kind = process.env.STORAGE_DRIVER ?? 'local';
    if (kind !== 'local') {
        // Deliberately loud: a typo here must not silently write to the wrong place.
        throw new Error(`Unknown STORAGE_DRIVER "${kind}". Only "local" is implemented so far.`);
    }
    const root = process.env.STORAGE_DIR
        ?? path.join(process.env.UPLOAD_DIR ?? path.resolve(process.cwd(), '../data/uploads'), 'storage');
    driver = new LocalDiskDriver(root);
    return driver;
}
/** Largest single file accepted into the document store. */
export const MAX_STORAGE_BYTES = 50 * 1024 * 1024;
//# sourceMappingURL=storage.js.map