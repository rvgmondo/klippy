import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VERSION } from '../version.js';

/**
 * Which commit is actually serving this request.
 *
 * The build stamp in version.ts is written by gen-version.mjs BEFORE the commit
 * that carries the build exists, so it always names the previous commit. That is
 * harmless as a build fingerprint and actively misleading as a deploy answer: it
 * had me telling the owner production was fifteen commits behind when it was
 * exactly current.
 *
 * So the deploy writes the truth instead. `.cpanel.yml` runs inside the server's
 * own git checkout, where `git rev-parse HEAD` is the commit being deployed, and
 * drops it next to the app as deployed.json. Read once at boot: the file only
 * changes when the process is restarted by a deploy anyway.
 *
 * No file means nobody deployed this build through cPanel (a local run, or a
 * hand-copied dist), and the build stamp is the best answer available.
 */
export interface DeployedVersion {
  commit: string;
  commitFull: string;
  /** When the deploy ran, not when the build did. */
  deployedAt: string | null;
  /** Where the number came from, so a stale stamp can never masquerade as fact. */
  source: 'deploy' | 'build';
}

function read(): DeployedVersion {
  // app.js sits at the API root; dist/lib is two levels under it.
  for (const path of [
    join(process.cwd(), 'deployed.json'),
    new URL('../../../deployed.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  ]) {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<DeployedVersion>;
      if (raw.commitFull) {
        return {
          commit: raw.commit || raw.commitFull.slice(0, 7),
          commitFull: raw.commitFull,
          deployedAt: raw.deployedAt ?? null,
          source: 'deploy',
        };
      }
    } catch {
      // Next candidate, then the build stamp.
    }
  }
  return {
    commit: VERSION.commit,
    commitFull: VERSION.commitFull,
    deployedAt: null,
    source: 'build',
  };
}

export const DEPLOYED: DeployedVersion = read();
