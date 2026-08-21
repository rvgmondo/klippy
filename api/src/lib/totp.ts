import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * RFC 6238 TOTP, from the standard library alone.
 *
 * Six digits, thirty-second steps, HMAC-SHA1: the profile every authenticator
 * app (Google Authenticator, Authy, 1Password, Aegis) actually implements.
 * Verification accepts one step of drift either side, because phones keep
 * imperfect time and a code typed at second 29 should not fail at second 31.
 */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, no padding: the alphabet authenticator apps type in. */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh 160-bit secret, base32, ready for an authenticator app. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The otpauth:// URL an authenticator app understands, for manual add or a QR. */
export function otpauthUrl(secret: string, accountLabel: string, issuer = 'Klippy'): string {
  const label = encodeURIComponent(`${issuer}:${accountLabel}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

function hotp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0xf;
  const code = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(code % 1_000_000).padStart(6, '0');
}

/** The current code for a secret; exported for tests and nothing else. */
export function totpCode(secretB32: string, atMs = Date.now()): string {
  return hotp(base32Decode(secretB32), Math.floor(atMs / 1000 / 30));
}

/** Constant-time verify, allowing one 30s step of clock drift either way. */
export function verifyTotp(secretB32: string, code: string, atMs = Date.now()): boolean {
  const given = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(given)) return false;
  const secret = base32Decode(secretB32);
  const counter = Math.floor(atMs / 1000 / 30);
  for (const drift of [0, -1, 1]) {
    const expect = hotp(secret, counter + drift);
    if (timingSafeEqual(Buffer.from(expect), Buffer.from(given))) return true;
  }
  return false;
}
