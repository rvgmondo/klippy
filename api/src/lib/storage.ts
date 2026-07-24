import { createWriteStream, createReadStream } from 'node:fs';
import { mkdir, unlink, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import path from 'node:path';

/**
 * Where stored files physically live.
 *
 * Today this is the cPanel disk. When the account outgrows that, add an
 * S3Driver implementing this same interface and switch STORAGE_DRIVER - nothing
 * in the routes or the database needs to change, because everything above this
 * layer only ever deals in opaque string keys.
 */
export interface StorageDriver {
  /** Persist a stream under `key`. Returns the number of bytes written. */
  save(key: string, stream: Readable): Promise<number>;
  createReadStream(key: string): Readable;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

class LocalDiskDriver implements StorageDriver {
  constructor(private readonly root: string) {}

  private full(key: string): string {
    // Keys are generated server-side, but never trust them into a path.
    const safe = key.replace(/\\/g, '/').replace(/\.\.+/g, '').replace(/^\/+/, '');
    return path.join(this.root, safe);
  }

  async save(key: string, stream: Readable): Promise<number> {
    const dest = this.full(key);
    await mkdir(path.dirname(dest), { recursive: true });
    try {
      await pipeline(stream, createWriteStream(dest));
    } catch (err) {
      await unlink(dest).catch(() => {});
      throw err;
    }
    const { size } = await stat(dest);
    return size;
  }

  createReadStream(key: string): Readable {
    return createReadStream(this.full(key));
  }

  async delete(key: string): Promise<void> {
    await unlink(this.full(key)).catch(() => {});
  }

  async exists(key: string): Promise<boolean> {
    try { await stat(this.full(key)); return true; } catch { return false; }
  }
}

let driver: StorageDriver | null = null;

export function storage(): StorageDriver {
  if (driver) return driver;
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
