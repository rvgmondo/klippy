import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { socialPostMedia, storageNodes } from '../db/schema.js';
import { storage } from '../lib/storage.js';
/**
 * The public media route: how Instagram and Facebook actually get the picture.
 *
 * Meta publishes by DOWNLOADING the file from a URL we hand it. It arrives as an
 * anonymous crawler with no cookie and no Authorization header, so nothing behind the
 * session can ever be published. This route is the deliberate hole in that wall, and
 * it is kept as small as a hole can be:
 *
 *   - NO AUTHENTICATION, ON PURPOSE. It is registered outside requireAuth because a
 *     401 to facebookexternalhit is a post that never goes out.
 *   - THE URL IS THE CREDENTIAL. 32 random bytes per file, unique, unguessable, and
 *     revoked by deleting the row. There is no id to enumerate and no listing.
 *   - IT SERVES ONE THING. A row in social_post_media and nothing else. It cannot
 *     reach a client's Files tree, an invoice, or another workspace's upload, because
 *     the token is looked up in this table and the storage key comes from the row it
 *     finds. No path, no filename, no account id ever comes from the caller.
 *   - IT IS NOT A TENANT ROUTE. That is why it does not use tenantWhere: there is no
 *     session to scope to, and the token IS the scope. Every other route in Klippy
 *     must never do this, which is why it lives in a file of its own with this note.
 *
 * Range support is here for video: a player asks for a slice, and a server that
 * answers 200 with the whole file makes Safari refuse to play at all.
 *
 * robots.txt allows this path explicitly. Meta refuses to fetch from a host whose
 * robots.txt blocks its crawler, so that file and this route have to agree.
 */
/** Content types we will serve. Anything else is not something a network can post. */
const SERVEABLE = new Set([
    'image/jpeg', 'image/png', 'image/webp', 'image/gif',
    'video/mp4', 'video/quicktime',
]);
export async function socialMediaRoutes(app) {
    app.get('/api/v1/m/:token', async (req, reply) => {
        // Strip any extension: the URL carries one so Meta and LinkedIn see a filename
        // that matches the content type, but the token is what identifies the row.
        const raw = req.params.token ?? '';
        const token = raw.replace(/\.[a-z0-9]{1,5}$/i, '');
        // Cheap shape check before touching the database, so a scan of nonsense paths
        // costs nothing.
        if (!/^[a-f0-9]{32,64}$/i.test(token))
            return reply.code(404).send({ error: 'Not found.' });
        const [row] = await db.select({
            mimeType: socialPostMedia.mimeType,
            nodeMime: storageNodes.mimeType,
            storageKey: storageNodes.storageKey,
            name: storageNodes.name,
        }).from(socialPostMedia)
            .innerJoin(storageNodes, eq(storageNodes.id, socialPostMedia.storageNodeId))
            .where(eq(socialPostMedia.publicToken, token))
            .limit(1);
        if (!row?.storageKey)
            return reply.code(404).send({ error: 'Not found.' });
        const type = row.mimeType ?? row.nodeMime ?? 'application/octet-stream';
        if (!SERVEABLE.has(type))
            return reply.code(404).send({ error: 'Not found.' });
        const size = await storage().size(row.storageKey);
        if (size == null)
            return reply.code(404).send({ error: 'Not found.' });
        reply
            .header('Content-Type', type)
            .header('Accept-Ranges', 'bytes')
            // A day is right for both readers: Meta caches what it fetches, and a browser
            // preview in the composer should not re-download on every keystroke.
            .header('Cache-Control', 'public, max-age=86400')
            // The file is meant to be fetched and embedded, never interpreted as a page.
            .header('X-Content-Type-Options', 'nosniff')
            .header('Content-Disposition', 'inline');
        const range = req.headers.range;
        if (range) {
            const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
            if (m) {
                const startRaw = m[1];
                const endRaw = m[2];
                let start;
                let end;
                if (startRaw === '' && endRaw !== '') {
                    // "bytes=-500" means the LAST 500 bytes, not the first.
                    const suffix = Number(endRaw);
                    start = Math.max(0, size - suffix);
                    end = size - 1;
                }
                else {
                    start = Number(startRaw || 0);
                    end = endRaw === '' ? size - 1 : Math.min(Number(endRaw), size - 1);
                }
                if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
                    return reply.code(416).header('Content-Range', `bytes */${size}`).send();
                }
                return reply
                    .code(206)
                    .header('Content-Range', `bytes ${start}-${end}/${size}`)
                    .header('Content-Length', String(end - start + 1))
                    .send(storage().createReadStream(row.storageKey, { start, end }));
            }
            // An unparseable Range is ignored rather than refused, which is what the spec
            // allows and what keeps a fussy client working.
        }
        return reply.header('Content-Length', String(size)).send(storage().createReadStream(row.storageKey));
    });
}
//# sourceMappingURL=socialMedia.js.map