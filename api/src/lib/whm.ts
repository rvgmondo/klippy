import { request } from 'node:https';
import { randomBytes } from 'node:crypto';

/**
 * Talking to WHM, the thing that actually creates hosting accounts.
 *
 * Deliberately written against WHM's own API rather than WHMCS. WHMCS is a billing
 * system, and Klippy already does the billing: invoices, recurring cycles, PayFast,
 * reminders. Putting WHMCS in the middle would mean two systems invoicing the same
 * client. WHM is the layer underneath that just makes accounts, which is the only
 * part that was missing.
 *
 * Auth is an API token, sent as `Authorization: whm user:token`. A WHM token is
 * effectively root on that server, so it is stored encrypted and never leaves the
 * API. node:https is used rather than fetch for one specific reason: WHM listens on
 * 2087 and very often presents a self-signed certificate, and this is the only way
 * to make trusting it an explicit per-account decision instead of a global one.
 */

export interface WhmCreds {
  host: string;          // hostname only, no scheme, no port
  user: string;          // usually root, or a reseller
  token: string;
  allowSelfSigned: boolean;
}

export interface WhmResult<T = Record<string, unknown>> {
  ok: boolean;
  message: string;
  data?: T;
}

/** Strip anything that is not a hostname, so a pasted URL still works. */
export function cleanHost(raw: string): string {
  return raw.trim()
    .replace(/^https?:\/\//i, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '')
    .toLowerCase();
}

function call<T>(creds: WhmCreds, fn: string, params: Record<string, string>): Promise<WhmResult<T>> {
  const qs = new URLSearchParams({ 'api.version': '1', ...params }).toString();
  return new Promise((resolve) => {
    const req = request({
      host: cleanHost(creds.host),
      port: 2087,
      path: `/json-api/${fn}?${qs}`,
      method: 'GET',
      headers: { Authorization: `whm ${creds.user}:${creds.token}` },
      rejectUnauthorized: !creds.allowSelfSigned,
      timeout: 30000,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          return resolve({ ok: false, message: 'WHM rejected the credentials. Check the username and API token, and that the token has the right privileges.' });
        }
        let json: {
          metadata?: { result?: number; reason?: string };
          data?: T;
          result?: [{ status?: number; statusmsg?: string }];
        };
        try {
          json = JSON.parse(body) as typeof json;
        } catch {
          return resolve({ ok: false, message: `WHM replied with something that is not JSON (HTTP ${res.statusCode}): ${body.slice(0, 200)}` });
        }
        // WHM reports failure in two different shapes depending on the call, and
        // both mean the same thing, so both are checked. Missing the second one is
        // how an integration decides a failed createacct succeeded.
        const meta = json.metadata;
        const legacy = json.result?.[0];
        if (meta && meta.result !== undefined && Number(meta.result) !== 1) {
          return resolve({ ok: false, message: meta.reason || 'WHM refused the request.' });
        }
        if (legacy && legacy.status !== undefined && Number(legacy.status) !== 1) {
          return resolve({ ok: false, message: legacy.statusmsg || 'WHM refused the request.' });
        }
        resolve({ ok: true, message: meta?.reason || legacy?.statusmsg || 'OK', data: json.data ?? (json as unknown as T) });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, message: 'WHM did not answer within 30 seconds. If the account may have been created, check WHM before trying again.' });
    });
    req.on('error', (err: NodeJS.ErrnoException) => {
      const why = err.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || err.code === 'SELF_SIGNED_CERT_IN_CHAIN'
        ? 'The server is using a self-signed certificate. Tick "allow self-signed certificate" if that is expected.'
        : err.code === 'ENOTFOUND' ? 'That hostname does not resolve.'
        : err.code === 'ECONNREFUSED' ? 'Nothing is listening on port 2087. Check the hostname and that WHM is reachable from this server.'
        : err.message;
      resolve({ ok: false, message: `Could not reach WHM: ${why}` });
    });
    req.end();
  });
}

/** Cheapest call that proves host, user and token all work. */
export async function testConnection(creds: WhmCreds): Promise<WhmResult<{ version?: string }>> {
  const res = await call<{ version?: string }>(creds, 'version', {});
  if (!res.ok) return res;
  return { ok: true, message: `Connected to WHM ${res.data?.version ?? ''}`.trim(), data: res.data };
}

export interface WhmPackage { name: string }

/** The hosting packages defined on the server, for choosing one per offering. */
export async function listPackages(creds: WhmCreds): Promise<WhmResult<WhmPackage[]>> {
  const res = await call<{ pkg?: { name: string }[] }>(creds, 'listpkgs', {});
  if (!res.ok) return { ok: false, message: res.message };
  const pkgs = res.data?.pkg ?? [];
  return { ok: true, message: `${pkgs.length} packages`, data: pkgs.map((p) => ({ name: p.name })) };
}

/**
 * A cPanel username from a domain.
 *
 * cPanel's own rules, which are strict and worth getting right rather than letting
 * the server reject the account: letters and digits only, must not start with a
 * digit, and at most 16 characters on most builds. A short random tail keeps two
 * similar domains from colliding.
 */
export function usernameFor(domain: string, taken: (u: string) => boolean = () => false): string {
  const base = domain.toLowerCase().replace(/^www\./, '').split('.')[0]?.replace(/[^a-z0-9]/g, '') ?? '';
  let stem = (/^[0-9]/.test(base) ? `u${base}` : base).slice(0, 12) || 'site';
  if (!/^[a-z]/.test(stem)) stem = `u${stem}`.slice(0, 12);
  let candidate = stem;
  let n = 0;
  while (taken(candidate)) {
    n += 1;
    candidate = `${stem.slice(0, 12 - String(n).length)}${n}`;
  }
  return candidate.slice(0, 16);
}

/** A password strong enough for cPanel's own strength check. */
export function generatePassword(): string {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%^&*-_=+'];
  const bytes = randomBytes(24);
  // One from each set first, so the result always satisfies the character-class
  // requirement rather than usually satisfying it.
  const chars = sets.map((s, i) => s[bytes[i]! % s.length]!);
  const all = sets.join('');
  for (let i = sets.length; i < 20; i++) chars.push(all[bytes[i]! % all.length]!);
  // Shuffle, so the guaranteed characters are not always in the same positions.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomBytes(1)[0]! % (i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}

export async function createAccount(creds: WhmCreds, opts: {
  username: string; domain: string; password: string; plan?: string | null; contactEmail?: string | null;
}): Promise<WhmResult> {
  return call(creds, 'createacct', {
    username: opts.username,
    domain: opts.domain,
    password: opts.password,
    ...(opts.plan ? { plan: opts.plan } : {}),
    ...(opts.contactEmail ? { contactemail: opts.contactEmail } : {}),
  });
}

export async function suspendAccount(creds: WhmCreds, username: string, reason: string): Promise<WhmResult> {
  return call(creds, 'suspendacct', { user: username, reason: reason.slice(0, 200) });
}

export async function unsuspendAccount(creds: WhmCreds, username: string): Promise<WhmResult> {
  return call(creds, 'unsuspendacct', { user: username });
}

/** Does this username already exist on the server? */
export async function accountExists(creds: WhmCreds, username: string): Promise<boolean> {
  const res = await call(creds, 'accountsummary', { user: username });
  return res.ok;
}
