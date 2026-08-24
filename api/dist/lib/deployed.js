import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VERSION } from '../version.js';
function read() {
    // app.js sits at the API root; dist/lib is two levels under it.
    for (const path of [
        join(process.cwd(), 'deployed.json'),
        new URL('../../../deployed.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    ]) {
        try {
            const raw = JSON.parse(readFileSync(path, 'utf-8'));
            if (raw.commitFull) {
                return {
                    commit: raw.commit || raw.commitFull.slice(0, 7),
                    commitFull: raw.commitFull,
                    deployedAt: raw.deployedAt ?? null,
                    source: 'deploy',
                };
            }
        }
        catch {
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
export const DEPLOYED = read();
//# sourceMappingURL=deployed.js.map