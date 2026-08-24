import { request } from 'node:https';
import { randomBytes } from 'node:crypto';
/** Strip anything that is not a hostname, so a pasted URL still works. */
export function cleanHost(raw) {
    return raw.trim()
        .replace(/^https?:\/\//i, '')
        .replace(/[/?#].*$/, '')
        .replace(/:\d+$/, '')
        .toLowerCase();
}
function call(creds, fn, params) {
    // POST the parameters in the request BODY, not the query string. createacct
    // carries the freshly generated cPanel password, and a GET puts it straight into
    // WHM's access logs (and any proxy in between). WHM's json-api accepts POST with a
    // form-encoded body, so the secret never lands in a URL.
    const form = new URLSearchParams({ 'api.version': '1', ...params }).toString();
    return new Promise((resolve) => {
        const req = request({
            host: cleanHost(creds.host),
            port: 2087,
            path: `/json-api/${fn}`,
            method: 'POST',
            headers: {
                Authorization: `whm ${creds.user}:${creds.token}`,
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(form),
            },
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
                let json;
                try {
                    json = JSON.parse(body);
                }
                catch {
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
                resolve({ ok: true, message: meta?.reason || legacy?.statusmsg || 'OK', data: json.data ?? json });
            });
        });
        req.on('timeout', () => {
            req.destroy();
            resolve({ ok: false, message: 'WHM did not answer within 30 seconds. If the account may have been created, check WHM before trying again.' });
        });
        req.on('error', (err) => {
            const why = err.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || err.code === 'SELF_SIGNED_CERT_IN_CHAIN'
                ? 'The server is using a self-signed certificate. Tick "allow self-signed certificate" if that is expected.'
                : err.code === 'ENOTFOUND' ? 'That hostname does not resolve.'
                    : err.code === 'ECONNREFUSED' ? 'Nothing is listening on port 2087. Check the hostname and that WHM is reachable from this server.'
                        : err.message;
            resolve({ ok: false, message: `Could not reach WHM: ${why}` });
        });
        req.write(form);
        req.end();
    });
}
/** Cheapest call that proves host, user and token all work. */
export async function testConnection(creds) {
    const res = await call(creds, 'version', {});
    if (!res.ok)
        return res;
    return { ok: true, message: `Connected to WHM ${res.data?.version ?? ''}`.trim(), data: res.data };
}
/** The hosting packages defined on the server, for choosing one per offering. */
export async function listPackages(creds) {
    const res = await call(creds, 'listpkgs', {});
    if (!res.ok)
        return { ok: false, message: res.message };
    const pkgs = res.data?.pkg ?? [];
    return { ok: true, message: `${pkgs.length} packages`, data: pkgs.map((p) => ({ name: p.name })) };
}
/**
 * Usernames cPanel refuses.
 *
 * Two kinds. Exact names that belong to the system, and PREFIXES that cPanel
 * reserves wholesale: anything starting with "test" is rejected outright, which is
 * how testrubs.co.za and testsampleclient.co.za both failed with "reserved
 * username" on a real server. Worth encoding rather than discovering per customer.
 *
 * This list will never be complete, which is why the caller also recovers when the
 * server refuses a name it did not know about. The server is the authority; this
 * just avoids the round trip for the ones we can predict.
 */
const RESERVED_NAMES = new Set([
    'root', 'admin', 'administrator', 'cpanel', 'whm', 'mysql', 'ftp', 'www', 'web',
    'mail', 'email', 'nobody', 'bin', 'daemon', 'sys', 'operator', 'uucp', 'lp',
    'sync', 'shutdown', 'halt', 'news', 'games', 'gopher', 'apache', 'nginx',
    'postgres', 'exim', 'named', 'sshd', 'tomcat', 'test', 'temp', 'guest', 'user',
    'default', 'system', 'server', 'host', 'main', 'public', 'support', 'info',
]);
const RESERVED_PREFIXES = ['test'];
export function isReservedUsername(u) {
    if (RESERVED_NAMES.has(u))
        return true;
    return RESERVED_PREFIXES.some((p) => u.startsWith(p));
}
/**
 * A cPanel username from a domain.
 *
 * cPanel's own rules, which are strict and worth getting right rather than letting
 * the server reject the account: letters and digits only, must not start with a
 * digit, and at most 16 characters on most builds. A reserved name gets a letter in
 * front rather than a number on the end, since a reserved PREFIX would survive a
 * suffix and be refused all over again.
 */
export function usernameFor(domain, taken = () => false) {
    const base = domain.toLowerCase().replace(/^www\./, '').split('.')[0]?.replace(/[^a-z0-9]/g, '') ?? '';
    let stem = (/^[0-9]/.test(base) ? `u${base}` : base).slice(0, 12) || 'site';
    if (!/^[a-z]/.test(stem))
        stem = `u${stem}`.slice(0, 12);
    // Break the reserved prefix at the front, where it actually matters.
    if (isReservedUsername(stem))
        stem = `k${stem}`.slice(0, 12);
    let candidate = stem;
    let n = 0;
    while (taken(candidate) || isReservedUsername(candidate)) {
        n += 1;
        if (n > 50)
            return `k${Math.random().toString(36).slice(2, 10)}`;
        candidate = `${stem.slice(0, 12 - String(n).length)}${n}`;
    }
    return candidate.slice(0, 16);
}
/**
 * Turn a holding-domain pattern into an actual domain for one account.
 *
 * "{username}.clients.example.co.za" with username ktestrubs becomes
 * ktestrubs.clients.example.co.za. Returns null when the result is not a usable
 * hostname, so a mistyped pattern in settings fails here rather than at cPanel with
 * an error nobody can read.
 */
export function tempDomainFor(pattern, username) {
    if (!pattern || !username)
        return null;
    const filled = pattern.trim().toLowerCase()
        .replace(/\{username\}/g, username)
        .replace(/^https?:\/\//, '')
        .replace(/^www\./, '')
        .replace(/[/?#].*$/, '')
        .replace(/\.$/, '');
    // A holding domain must still be a real hostname with at least two labels, and
    // must actually vary per account or every customer collides on the same one.
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(filled))
        return null;
    if (filled.length > 190)
        return null;
    if (!pattern.includes('{username}'))
        return null;
    return filled;
}
/** Did WHM refuse this name rather than fail for some other reason? */
export function isReservedRejection(message) {
    return /reserved username|username.*reserved|already exists|in use/i.test(message);
}
/** A password strong enough for cPanel's own strength check. */
export function generatePassword() {
    const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%^&*-_=+'];
    const bytes = randomBytes(24);
    // One from each set first, so the result always satisfies the character-class
    // requirement rather than usually satisfying it.
    const chars = sets.map((s, i) => s[bytes[i] % s.length]);
    const all = sets.join('');
    for (let i = sets.length; i < 20; i++)
        chars.push(all[bytes[i] % all.length]);
    // Shuffle, so the guaranteed characters are not always in the same positions.
    for (let i = chars.length - 1; i > 0; i--) {
        const j = randomBytes(1)[0] % (i + 1);
        [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    return chars.join('');
}
export async function createAccount(creds, opts) {
    return call(creds, 'createacct', {
        username: opts.username,
        domain: opts.domain,
        password: opts.password,
        ...(opts.plan ? { plan: opts.plan } : {}),
        ...(opts.contactEmail ? { contactemail: opts.contactEmail } : {}),
    });
}
/**
 * Move an account onto a different primary domain.
 *
 * The customer built their site on a holding address; now they have their own
 * domain and it has to become the real one. WHM's modifyacct takes the existing
 * username and the new domain.
 *
 * NOT VERIFIED against a real server from here. It follows WHM's documented
 * modifyacct call, but nobody has watched it run, so the caller treats a failure as
 * "a person needs to finish this in WHM" rather than pretending it worked.
 */
export async function changePrimaryDomain(creds, username, newDomain) {
    return call(creds, 'modifyacct', { user: username, domain: newDomain });
}
/**
 * Set a new password on an existing cPanel account. The password travels in the
 * POST body like createacct's, never in a URL.
 */
export async function setAccountPassword(creds, username, password) {
    return call(creds, 'passwd', { user: username, password, db_pass_update: '1' });
}
export async function suspendAccount(creds, username, reason) {
    return call(creds, 'suspendacct', { user: username, reason: reason.slice(0, 200) });
}
export async function unsuspendAccount(creds, username) {
    return call(creds, 'unsuspendacct', { user: username });
}
/** Does this username already exist on the server? */
export async function accountExists(creds, username) {
    const res = await call(creds, 'accountsummary', { user: username });
    return res.ok;
}
//# sourceMappingURL=whm.js.map