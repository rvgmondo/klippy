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
  /**
   * Read the file back, optionally a byte range.
   *
   * The range exists for video. A player asks for a slice rather than the whole file,
   * and a server that ignores that either sends the entire video for every seek or
   * fails to play at all in Safari, which will not start a video without a 206.
   */
  createReadStream(key: string, range?: { start: number; end: number }): Readable;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** Size in bytes, or null when the file is gone. Needed to answer a Range request. */
  size(key: string): Promise<number | null>;
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

  createReadStream(key: string, range?: { start: number; end: number }): Readable {
    return createReadStream(this.full(key), range ? { start: range.start, end: range.end } : undefined);
  }

  async size(key: string): Promise<number | null> {
    try { return (await stat(this.full(key))).size; } catch { return null; }
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
