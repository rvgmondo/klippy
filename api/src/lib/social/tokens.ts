import { keyFrom, encryptWith, decryptWith } from '../secretbox.js';

/**
 * OAuth tokens for connected social accounts, encrypted at rest.
 *
 * Same AES-256-GCM recipe the payment credentials use, under a SEPARATE environment
 * variable. That separation is the whole point of this file: a leaked payments key
 * must not also hand over every client's Facebook Page, and a leaked social key must
 * not expose anyone's merchant credentials. One implementation to review, two keys.
 *
 * A social access token is worth more than most secrets in this database. It can post
 * as a client's brand to their audience. So:
 *   - it is never returned to the browser, at any endpoint, in any shape
 *   - it is never written to a log, including error logs (see redact)
 *   - the server refuses to store one at all when no key is configured, rather than
 *     silently keeping plaintext
 */

const socialKey = () => keyFrom(process.env.SOCIAL_TOKEN_KEY);

/** True when the server can store social tokens. The connect screen reads this. */
export function socialTokensAvailable(): boolean {
  return socialKey() !== null;
}

export function encryptToken(plain: string): string {
  const k = socialKey();
  if (!k) {
    throw new Error('SOCIAL_TOKEN_KEY is not configured on the server, so social accounts cannot be connected.');
  }
  return encryptWith(k, plain);
}

export function decryptToken(stored: string): string {
  const k = socialKey();
  if (!k) throw new Error('SOCIAL_TOKEN_KEY is not configured on the server.');
  return decryptWith(k, stored);
}

/**
 * Strip anything token-shaped out of a value before it is logged or stored in
 * social_publish_log, which the UI reads.
 *
 * Deliberately over-eager. A publish failure is exactly the moment someone pastes a
 * log into a chat to ask for help, and a redactor that only catches the fields it was
 * told about will miss the one the platform added last month. So it walks the whole
 * structure and blanks any key that looks like a credential, at any depth, plus any
 * long opaque string that appears in a value position.
 */
const SECRET_KEY = /(token|secret|password|authorization|auth|credential|signature|appsecret|client_secret|code)/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]';
  if (typeof value === 'string') {
    // Bearer prefixes and very long unbroken strings are almost always credentials.
    if (/^Bearer\s+/i.test(value)) return '[redacted]';
    if (value.length > 60 && !/\s/.test(value)) return `[redacted ${value.length} chars]`;
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}
