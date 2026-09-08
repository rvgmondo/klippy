import { SocialApiError } from './types.js';
import { redact } from './tokens.js';
/**
 * The one place a social network is called.
 *
 * Every adapter goes through this, for three reasons that are each worth a bug avoided:
 *
 *  1. A REQUEST THAT NEVER RETURNS WOULD WEDGE THE CRON. The publisher runs inside an
 *     HTTP request on shared hosting, so every call carries a timeout and gives up
 *     rather than holding the run open until something else kills it.
 *  2. TOKENS MUST NOT REACH A LOG. Access tokens travel in the query string on the
 *     Graph API, which is Meta's design and not ours, so the URL itself is a
 *     credential. Nothing here logs a raw URL; it is scrubbed first.
 *  3. RETRYABLE OR NOT IS ONE DECISION, MADE ONCE. Getting it wrong is expensive both
 *     ways: retrying a permanent failure burns quota and looks broken, while giving up
 *     on a transient one silently drops a client's post. So the classification lives
 *     here with the doc rows it comes from, not scattered through the adapters.
 */
const DEFAULT_TIMEOUT_MS = 30_000;
/** Anything token-shaped out of a URL before it is logged or attached to an error. */
export function scrubUrl(url) {
    try {
        const u = new URL(url);
        for (const key of [...u.searchParams.keys()]) {
            if (/token|secret|code|signature|appsecret/i.test(key))
                u.searchParams.set(key, '[redacted]');
        }
        return u.toString();
    }
    catch {
        return url.replace(/([?&](?:access_token|client_secret|code)=)[^&]+/gi, '$1[redacted]');
    }
}
/**
 * Meta's error shape, turned into a decision.
 *
 * Handled on CODES, never on message strings: the docs say plainly that messages
 * change without notice, and a retry policy keyed on English is a retry policy that
 * silently stops working. HTTP status is not reliable either, so the body is parsed
 * whatever the status says.
 */
export function classifyMetaError(body, status) {
    const err = body?.error ?? {};
    const code = Number(err.code ?? 0);
    const sub = Number(err.error_subcode ?? 0);
    const message = String(err.error_user_msg ?? err.message ?? `HTTP ${status}`);
    const label = sub ? `${code}/${sub}` : String(code || status);
    // X-ERR-02: when the platform says it is temporary, believe it, whatever the code.
    if (err.is_transient === true)
        return { message, retryable: true, code: label };
    // IG-PUB-23: the spam guard. Retrying this makes it worse and it needs a person.
    if (code === 4 && sub === 2207051) {
        return {
            message: 'Instagram has temporarily restricted posting on this account. Try again later or post it by hand.',
            retryable: false, code: label,
        };
    }
    // X-ERR-04: the 190 family. Every one of these needs a NEW TOKEN, so a retry with
    // the same credential can only fail again and burn quota doing it.
    if (code === 190 || (code >= 100 && sub >= 458 && sub <= 492)) {
        return { message: `${message} The connection needs to be re-authorised.`, retryable: false, code: label };
    }
    // X-ERR-03 and X-ERR-05: transient and rate limits.
    if ([1, 2, 4, 17, 32, 341, 368, 613, 80001, 80002].includes(code)) {
        return { message, retryable: true, code: label };
    }
    // X-ERR-06 and IG-PUB-16: the Instagram publishing subcodes worth retrying.
    const RETRY_SUBCODES = new Set([2207001, 2207003, 2207008, 2207027, 2207032, 2207053]);
    if (RETRY_SUBCODES.has(sub))
        return { message, retryable: true, code: label };
    // A container that expired needs a new one rather than a retry of the same call,
    // which the publisher handles by rebuilding from scratch on the next attempt.
    if (sub === 2207020 || sub === 2207042)
        return { message, retryable: true, code: label };
    // Permission problems (10, 200 to 299) and every validation failure are permanent.
    return { message, retryable: false, code: label };
}
export async function httpJson(url, opts) {
    const { method = 'GET', form, json, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, network } = opts;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
        const init = { method, headers: { ...headers }, signal: controller.signal };
        if (form) {
            const body = new URLSearchParams();
            for (const [k, v] of Object.entries(form))
                if (v !== undefined && v !== null)
                    body.set(k, String(v));
            init.body = body;
            init.headers['content-type'] = 'application/x-www-form-urlencoded';
        }
        else if (json !== undefined) {
            init.body = JSON.stringify(json);
            init.headers['content-type'] = 'application/json';
        }
        res = await fetch(url, init);
    }
    catch (err) {
        // A timeout or a dropped connection says nothing about the request, so it is
        // always worth another go.
        const aborted = err instanceof Error && err.name === 'AbortError';
        throw new SocialApiError(network, aborted
            ? `${network} did not answer within ${Math.round(timeoutMs / 1000)} seconds.`
            : `Could not reach ${network}.`, {
            retryable: true, code: aborted ? 'timeout' : 'network', detail: { url: scrubUrl(url) },
        });
    }
    finally {
        clearTimeout(timer);
    }
    const text = await res.text();
    let body = null;
    try {
        body = text ? JSON.parse(text) : null;
    }
    catch {
        body = { raw: text.slice(0, 500) };
    }
    if (!res.ok || body?.error) {
        const { message, retryable, code } = classifyMetaError(body, res.status);
        throw new SocialApiError(network, message, {
            retryable, code,
            detail: { url: scrubUrl(url), status: res.status, body: redact(body) },
        });
    }
    return body;
}
//# sourceMappingURL=http.js.map