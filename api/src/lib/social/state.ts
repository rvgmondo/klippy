import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

/**
 * The `state` parameter on an OAuth round trip.
 *
 * It leaves our server, sits in a URL bar, travels to Meta, and comes back. Everything
 * about that is hostile, so it is signed and short-lived, and the signature is checked
 * before a single byte of it is believed.
 *
 * WHAT IT CARRIES AND WHY. The callback arrives with no session: it is a redirect from
 * facebook.com, so there is no cookie we can rely on and no way to ask who is
 * connecting. The state is the only thing tying the person who clicked Connect to the
 * tokens that come back. Without a signature, anyone could craft a state naming
 * another workspace and have a client's Page attached to it.
 *
 * A NONCE IS INCLUDED so two people connecting the same business at the same moment do
 * not produce identical states, which would make one indistinguishable from a replay
 * of the other.
 *
 * Ten minutes is deliberately short. A person clicks Connect and completes the dialog
 * in under a minute; anything older is a stale tab or somebody replaying a URL out of
 * a browser history.
 */

const TTL_MS = 10 * 60_000;

export interface SocialState {
  accountId: number;
  businessId: number;
  userId: number;
  network: string;
}

const secret = (): string | null => {
  const raw = process.env.SOCIAL_TOKEN_KEY || process.env.PAYMENTS_SECRET;
  return raw && raw.length >= 16 ? raw : null;
};

const b64u = (buf: Buffer) => buf.toString('base64url');

export function signState(payload: SocialState): string {
  const key = secret();
  if (!key) throw new Error('SOCIAL_TOKEN_KEY is not configured, so accounts cannot be connected.');
  const body = b64u(Buffer.from(JSON.stringify({
    ...payload, exp: Date.now() + TTL_MS, n: randomBytes(8).toString('hex'),
  })));
  const sig = createHmac('sha256', key).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/**
 * Verify and decode, or null.
 *
 * Null for every failure, with no distinction between a bad signature, a malformed
 * body and an expired one. The caller has nothing useful to do with the difference,
 * and telling a caller WHICH check failed is how a signature gets probed.
 */
export function verifyState(state: string): SocialState | null {
  const key = secret();
  if (!key || !state) return null;
  const [body, sig] = state.split('.');
  if (!body || !sig) return null;

  const expected = createHmac('sha256', key).update(body).digest('base64url');
  // Constant time, and length-checked first because timingSafeEqual throws on a
  // mismatch rather than returning false.
  if (sig.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SocialState & { exp?: number };
    if (!parsed.exp || parsed.exp < Date.now()) return null;
    if (!parsed.accountId || !parsed.businessId || !parsed.userId) return null;
    return {
      accountId: Number(parsed.accountId),
      businessId: Number(parsed.businessId),
      userId: Number(parsed.userId),
      network: String(parsed.network ?? ''),
    };
  } catch {
    return null;
  }
}
