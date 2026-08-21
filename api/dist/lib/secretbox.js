import { createCipheriv, createDecipheriv, randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';
/**
 * Encrypt small secrets (payment credentials) for storage in the database.
 *
 * AES-256-GCM with a key derived from the PAYMENTS_SECRET environment variable.
 * The key lives only in the server environment, never in the repo or the DB, so a
 * database dump on its own does not expose anyone's merchant key. GCM gives us an
 * authentication tag, so tampered ciphertext fails to decrypt rather than returning
 * garbage.
 *
 * Stored format: `iv:tag:ciphertext`, all hex. The iv is random per encryption, so
 * the same input encrypts differently each time.
 */
function key() {
    const raw = process.env.PAYMENTS_SECRET;
    if (!raw || raw.length < 16)
        return null;
    // Accept any length secret; hash it to exactly 32 bytes for AES-256.
    return createHash('sha256').update(raw).digest();
}
/** True if a usable PAYMENTS_SECRET is configured. */
export function secretsAvailable() {
    return key() !== null;
}
export function encryptSecret(plain) {
    const k = key();
    if (!k)
        throw new Error('PAYMENTS_SECRET is not configured on the server.');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', k, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}
export function decryptSecret(stored) {
    const k = key();
    if (!k)
        throw new Error('PAYMENTS_SECRET is not configured on the server.');
    const [ivHex, tagHex, dataHex] = stored.split(':');
    if (!ivHex || !tagHex || !dataHex)
        throw new Error('Malformed secret.');
    const decipher = createDecipheriv('aes-256-gcm', k, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}
/**
 * A stateless, unguessable token for a public pay link, so an emailed
 * "Pay this invoice" URL cannot be forged or enumerated by trying document ids.
 * HMAC of the id under the same server secret; null when secrets are unavailable.
 */
export function signPayToken(docId) {
    const raw = process.env.PAYMENTS_SECRET;
    if (!raw || raw.length < 16)
        return null;
    return createHmac('sha256', raw).update(`pay:${docId}`).digest('hex').slice(0, 32);
}
export function verifyPayToken(docId, token) {
    const expected = signPayToken(docId);
    if (!expected || !token || token.length !== expected.length)
        return false;
    return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}
/**
 * The public lead-form token for one business. Same recipe as the pay token: an
 * HMAC under the server secret, so the form URL cannot be forged or enumerated by
 * walking business ids, and nothing has to be stored to make it valid.
 */
export function signLeadToken(businessId) {
    const raw = process.env.PAYMENTS_SECRET;
    if (!raw || raw.length < 16)
        return null;
    return createHmac('sha256', raw).update(`lead:${businessId}`).digest('hex').slice(0, 32);
}
export function verifyLeadToken(businessId, token) {
    const expected = signLeadToken(businessId);
    if (!expected || !token || token.length !== expected.length)
        return false;
    return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}
/**
 * The same idea for a logo in an email.
 *
 * An email client fetches images with no cookie, so a logo URL behind the session
 * simply comes back 401 and the recipient sees a broken image. A logo is not a
 * secret, it is printed on every invoice, but the URL is still signed so the
 * endpoint cannot be walked to enumerate which businesses exist.
 *
 * No expiry on purpose: emails outlive tokens, and a two-year-old invoice should
 * still render its letterhead.
 */
/**
 * Signed public quote link, same recipe as the pay link: HMAC over the document
 * id, so the URL cannot be guessed or enumerated, and carrying no session at all.
 */
export function signQuoteToken(docId) {
    const key = process.env.PAYMENTS_SECRET;
    if (!key)
        return null;
    return createHmac('sha256', key).update(`quote:${docId}`).digest('hex').slice(0, 32);
}
export function verifyQuoteToken(docId, token) {
    const expect = signQuoteToken(docId);
    if (!expect || !token || token.length !== expect.length)
        return false;
    return timingSafeEqual(Buffer.from(expect), Buffer.from(token));
}
/** Signed personal calendar-feed token: HMAC over account and user. */
export function signCalToken(accountId, userId) {
    const key = process.env.PAYMENTS_SECRET;
    if (!key)
        return null;
    return createHmac('sha256', key).update(`cal:${accountId}:${userId}`).digest('hex').slice(0, 32);
}
export function verifyCalToken(accountId, userId, token) {
    const expect = signCalToken(accountId, userId);
    if (!expect || !token || token.length !== expect.length)
        return false;
    return timingSafeEqual(Buffer.from(expect), Buffer.from(token));
}
export function signLogoToken(kind, id) {
    const raw = process.env.PAYMENTS_SECRET;
    if (!raw || raw.length < 16)
        return null;
    return createHmac('sha256', raw).update(`logo:${kind}:${id}`).digest('hex').slice(0, 32);
}
export function verifyLogoToken(kind, id, token) {
    const expected = signLogoToken(kind, id);
    if (!expected || !token || token.length !== expected.length)
        return false;
    return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}
//# sourceMappingURL=secretbox.js.map