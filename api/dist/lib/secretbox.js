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
//# sourceMappingURL=secretbox.js.map