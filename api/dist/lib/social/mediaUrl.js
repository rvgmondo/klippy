import { appUrl } from '../mailer.js';
/**
 * The public URL Instagram and Facebook will fetch a file from.
 *
 * Two things make this its own module rather than a template string at the call site.
 *
 * FIRST, THE EXTENSION IS NOT DECORATION. Meta inspects what it downloads, and a URL
 * ending in a recognisable extension is the difference between a fetch that works and
 * one that fails with a content-type complaint pointing nowhere useful.
 *
 * SECOND, THE HOST MAY NOT BE THIS APP. On cPanel the API is mounted at a sub-URI
 * behind Passenger, and a deploy can end up with an internal URL that is right for the
 * browser and unreachable from the public internet. PUBLIC_MEDIA_BASE overrides the
 * host for exactly that case, so publishing can be pointed at a URL somebody has
 * actually confirmed is reachable, without touching the rest of the app.
 */
const EXT = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
};
export function publicMediaUrl(token, mimeType) {
    if (!token)
        return null;
    const base = (process.env.PUBLIC_MEDIA_BASE || appUrl() || '').replace(/\/+$/, '');
    if (!base)
        return null;
    return `${base}/api/v1/m/${token}${EXT[mimeType ?? ''] ?? ''}`;
}
/**
 * Whether a media URL can be handed to a platform at all.
 *
 * A localhost or private address is fine in the browser and useless to Meta, which
 * fetches from its own servers. Saying so at validation time beats a publish failure
 * that reads as a platform problem.
 */
export function isPubliclyFetchable(url) {
    if (!url)
        return false;
    try {
        const u = new URL(url);
        if (u.protocol !== 'https:' && u.protocol !== 'http:')
            return false;
        const h = u.hostname;
        if (h === 'localhost' || h === '127.0.0.1' || h === '::1')
            return false;
        if (/^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h))
            return false;
        if (h.endsWith('.local') || h.endsWith('.internal'))
            return false;
        return true;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=mediaUrl.js.map