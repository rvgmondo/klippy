import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every route file that reads who is asking must make the server check first.
 *
 * authOf() only works after requireAuth has run. A route file that calls authOf
 * without the preHandler answers every request with a server error, and the new
 * Clients routes shipped exactly like that once. This reads the source, so it
 * needs no database and fails the moment the check goes missing.
 */
const ROUTES = join(__dirname, '..', 'src', 'routes');

describe('route sign-in', () => {
  const files = readdirSync(ROUTES).filter((f) => f.endsWith('.ts'));
  for (const f of files) {
    const src = readFileSync(join(ROUTES, f), 'utf8');
    if (!/\bauthOf\(/.test(src)) continue;
    it(`${f} checks sign-in before reading who is asking`, () => {
      expect(src).toMatch(/requireAuth/);
    });
  }
});
