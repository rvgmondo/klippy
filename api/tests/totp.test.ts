import { describe, it, expect } from 'vitest';
import { base32Encode, base32Decode, totpCode, verifyTotp, generateTotpSecret, otpauthUrl } from '../src/lib/totp.js';

// RFC 6238 Appendix B test vectors, SHA1, truncated from 8 digits to our 6.
const RFC_SECRET_B32 = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

describe('totp', () => {
  it('round-trips base32', () => {
    const buf = Buffer.from('12345678901234567890', 'ascii');
    expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
    expect(RFC_SECRET_B32).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  it('matches the RFC 6238 SHA1 vectors', () => {
    const vectors: [number, string][] = [
      [59, '287082'],            // RFC: 94287082
      [1111111109, '081804'],    // RFC: 07081804
      [1111111111, '050471'],    // RFC: 14050471
      [1234567890, '005924'],    // RFC: 89005924
      [2000000000, '279037'],    // RFC: 69279037
      [20000000000, '353130'],   // RFC: 65353130
    ];
    for (const [seconds, expected] of vectors) {
      expect(totpCode(RFC_SECRET_B32, seconds * 1000)).toBe(expected);
    }
  });

  it('verifies with one step of drift either way, and no further', () => {
    const at = 1111111109 * 1000;
    expect(verifyTotp(RFC_SECRET_B32, '081804', at)).toBe(true);
    // One step earlier and later still pass at the same instant.
    expect(verifyTotp(RFC_SECRET_B32, totpCode(RFC_SECRET_B32, at - 30_000), at)).toBe(true);
    expect(verifyTotp(RFC_SECRET_B32, totpCode(RFC_SECRET_B32, at + 30_000), at)).toBe(true);
    // Two steps out fails.
    expect(verifyTotp(RFC_SECRET_B32, totpCode(RFC_SECRET_B32, at - 60_000), at)).toBe(false);
    // Garbage fails without throwing.
    expect(verifyTotp(RFC_SECRET_B32, 'abcdef', at)).toBe(false);
    expect(verifyTotp(RFC_SECRET_B32, '12345', at)).toBe(false);
  });

  it('generates distinct secrets and a scannable otpauth url', () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    const url = otpauthUrl(a, 'ruben@example.com');
    expect(url.startsWith('otpauth://totp/Klippy%3Aruben%40example.com?secret=')).toBe(true);
    expect(url).toContain('issuer=Klippy');
  });
});
