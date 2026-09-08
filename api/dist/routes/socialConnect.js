import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { socialAccounts } from '../db/schema.js';
import { authOf } from '../lib/context.js';
import { tenantWhere, withTenant } from '../lib/tenant.js';
import { intId } from '../lib/http.js';
import { assertBusinessAccess } from '../lib/access.js';
import { appUrl } from '../lib/mailer.js';
import { encryptToken, socialTokensAvailable } from '../lib/social/tokens.js';
import { signState, verifyState } from '../lib/social/state.js';
import { metaAuthUrl, metaExchangeCode, metaListAccounts } from '../lib/social/adapters/meta.js';
import { linkedinAuthUrl, linkedinExchangeCode, linkedinListOrganisations } from '../lib/social/adapters/linkedin.js';
import { adapterFor, whyNotAutomatic } from '../lib/social/registry.js';
import { appCredentials, providerOf, listAppSettings, saveAppSettings, clearAppSettings } from '../lib/social/credentials.js';
import { NETWORK_LABEL } from '../lib/social/types.js';
/**
 * Connecting a Facebook Page and the Instagram account behind it.
 *
 * Three steps, and the middle one is the awkward part.
 *
 *  1. START, signed in. Klippy signs a short-lived state naming the workspace, the
 *     business and the person, and hands back Meta's dialog URL.
 *  2. CALLBACK, WITH NO SESSION AT ALL. Meta redirects the browser to us, and a
 *     cross-site redirect carries no cookie we can depend on. The signed state is
 *     therefore the ONLY thing tying these tokens to a workspace, which is why it is
 *     verified before anything else happens and why nothing is written on the strength
 *     of a query parameter alone.
 *  3. FINALISE, signed in again. The callback does not save anything. It lists what
 *     the person can publish to and hands the browser back to Klippy, where they pick
 *     the Page and the Instagram account they meant. Saving every Page a person
 *     administers would attach accounts nobody chose, on a screen nobody saw.
 *
 * The short-lived user token from step 2 is held in memory between 2 and 3 rather than
 * stored, because it is a credential with no home: the thing worth keeping is the PAGE
 * token, which never expires, and that is only known once a Page is picked.
 */
/**
 * Pending connections, keyed by a handoff id.
 *
 * In memory on purpose. It lives for one minute of one person's flow, it is a
 * credential, and writing it to the database would mean a token at rest that no
 * feature ever reads again. A restart between the dialog and the pick just means
 * clicking Connect again, which is a fine trade for never persisting this.
 */
const pending = new Map();
const PENDING_TTL_MS = 10 * 60_000;
function sweepPending() {
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [k, v] of pending)
        if (v.at < cutoff)
            pending.delete(k);
}
const redirectFor = (network) => `${(process.env.APP_URL ?? appUrl() ?? '').replace(/\/+$/, '')}/api/v1/social/connect/${network}/callback`;
/** Back to the app with a message, since a callback has nowhere else to land. */
function bounce(reply, message, ok = false) {
    const base = (appUrl() ?? '').replace(/\/+$/, '');
    const q = new URLSearchParams({ v: 'social', [ok ? 'connected' : 'connectError']: message });
    reply.redirect(`${base}/?${q}`);
}
export async function socialConnectRoutes(app) {
    // ---- 1. Start, signed in -------------------------------------------------------
    app.get('/api/v1/social/connect/:network/start', { preHandler: app.requireAuth }, async (req, reply) => {
        const { accountId, userId } = authOf(req);
        const network = req.params.network;
        const adapter = adapterFor(network);
        if (!adapter)
            return reply.code(400).send({ error: `Klippy cannot connect ${network} yet.` });
        const q = z.object({ businessId: z.coerce.number().int().positive() }).safeParse(req.query);
        if (!q.success)
            return reply.code(400).send({ error: 'Which business is this for?' });
        if (!(await assertBusinessAccess(req, reply, q.data.businessId, 'admin')))
            return;
        if (!socialTokensAvailable()) {
            return reply.code(503).send({
                error: 'The server cannot store social tokens yet. Set SOCIAL_TOKEN_KEY in the app environment and restart.',
            });
        }
        // The workspace's own app, or the server's as a fallback. Missing means the
        // settings below the Connect button have not been filled in, and saying that
        // beats a generic "not configured" that sends somebody hunting a config file.
        const app = await appCredentials(accountId, providerOf(network));
        if (!app) {
            return reply.code(503).send({ error: whyNotAutomatic(network, { canConnect: false }) });
        }
        const state = signState({ accountId, businessId: q.data.businessId, userId, network });
        return {
            url: network === 'linkedin'
                ? linkedinAuthUrl(state, redirectFor(network), app)
                : metaAuthUrl(state, redirectFor(network), app),
        };
    });
    // ---- 2. Callback, with no session ----------------------------------------------
    app.get('/api/v1/social/connect/:network/callback', async (req, reply) => {
        sweepPending();
        const network = req.params.network;
        const q = z.object({
            code: z.string().min(4).optional(),
            state: z.string().min(8).optional(),
            error_description: z.string().optional(),
            error: z.string().optional(),
        }).safeParse(req.query);
        if (!q.success)
            return bounce(reply, 'That connection link was malformed.');
        // The person pressed Cancel, which is not a failure worth an alarming message.
        if (q.data.error) {
            return bounce(reply, q.data.error_description ?? 'The connection was cancelled.');
        }
        if (!q.data.code || !q.data.state)
            return bounce(reply, 'That connection link was incomplete.');
        const state = verifyState(q.data.state);
        if (!state) {
            // Expired, tampered with, or replayed. All the same answer: no detail, because
            // a caller that learns WHICH check failed can probe the signature.
            return bounce(reply, 'That connection link is no longer valid. Start again from the Social screen.');
        }
        try {
            const isLinkedIn = network === 'linkedin';
            // Resolved from the STATE's workspace, not from a session, because there is no
            // session here. The state was signature-checked a moment ago, so its accountId
            // is the only trustworthy thing in this request.
            const app = await appCredentials(state.accountId, providerOf(network));
            if (!app)
                return bounce(reply, 'The app details for this network are no longer set up.');
            const exchanged = isLinkedIn
                ? await linkedinExchangeCode(q.data.code, redirectFor(network), app)
                : await metaExchangeCode(q.data.code, redirectFor(network), app);
            const accessToken = exchanged.accessToken;
            const expiresAt = exchanged.expiresAt;
            const accounts = isLinkedIn
                ? await linkedinListOrganisations(accessToken)
                : await metaListAccounts(accessToken);
            if (!accounts.length) {
                return bounce(reply, isLinkedIn
                    ? 'No LinkedIn Pages came back. Check you are an Administrator on the Page, which only its super admin can grant.'
                    : 'No Pages came back that you can post to. Check you have the Create Content role on the Page.');
            }
            const handoff = signState({ ...state, network });
            pending.set(handoff, {
                accountId: state.accountId, businessId: state.businessId, userId: state.userId,
                network, userToken: accessToken,
                // LinkedIn only issues one to partner-enabled apps. Null is the normal case
                // and means a person reconnects in a browser before day sixty.
                refreshToken: isLinkedIn ? (exchanged.refreshToken ?? null) : null,
                expiresAt, accounts, at: Date.now(),
            });
            const base = (appUrl() ?? '').replace(/\/+$/, '');
            return reply.redirect(`${base}/?${new URLSearchParams({ v: 'social', connect: handoff })}`);
        }
        catch (err) {
            return bounce(reply, err instanceof Error ? err.message : 'Meta refused the connection.');
        }
    });
    // ---- 3. What came back, and finalising -----------------------------------------
    /**
     * The Pages and Instagram accounts waiting to be picked.
     *
     * Behind the session AND matched against the handoff's own workspace, so a handoff
     * id that leaked cannot be redeemed by anyone else.
     */
    app.get('/api/v1/social/connect/pending', { preHandler: app.requireAuth }, async (req, reply) => {
        sweepPending();
        const { accountId } = authOf(req);
        const q = z.object({ handoff: z.string().min(8) }).safeParse(req.query);
        if (!q.success)
            return reply.code(400).send({ error: 'Bad handoff.' });
        const row = pending.get(q.data.handoff);
        if (!row || row.accountId !== accountId) {
            return reply.code(404).send({ error: 'That connection has expired. Start again from the Social screen.' });
        }
        return {
            businessId: row.businessId,
            network: row.network,
            // Never the tokens. Only what a person needs to choose between.
            accounts: row.accounts.map((a) => ({
                network: a.network, externalId: a.externalId,
                displayName: a.displayName, avatarUrl: a.avatarUrl,
            })),
        };
    });
    app.post('/api/v1/social/accounts', { preHandler: app.requireAuth }, async (req, reply) => {
        sweepPending();
        const { accountId, userId } = authOf(req);
        const parsed = z.object({
            handoff: z.string().min(8),
            externalIds: z.array(z.string().min(1).max(120)).min(1).max(10),
        }).safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: parsed.error.issues[0]?.message });
        const row = pending.get(parsed.data.handoff);
        if (!row || row.accountId !== accountId) {
            return reply.code(404).send({ error: 'That connection has expired. Start again from the Social screen.' });
        }
        if (!(await assertBusinessAccess(req, reply, row.businessId, 'admin')))
            return;
        let saved = 0;
        for (const externalId of parsed.data.externalIds) {
            const found = row.accounts.find((a) => a.externalId === externalId);
            if (!found)
                continue;
            // An Instagram account publishes through its Page's token, so both entries carry
            // the Page token. Falling back to the user token would work for about sixty days
            // and then stop, which is the worst kind of failure: silent and delayed.
            const token = found.accountToken ?? row.userToken;
            // The adapter says which network each entry is, because one Connect click
            // returns both a Page and its Instagram account.
            const network = found.network;
            const existing = await db.select({ id: socialAccounts.id }).from(socialAccounts)
                .where(tenantWhere(socialAccounts, accountId, eq(socialAccounts.businessId, row.businessId), eq(socialAccounts.network, network), eq(socialAccounts.externalId, externalId))).limit(1);
            const values = {
                displayName: found.displayName,
                avatarUrl: found.avatarUrl,
                accessTokenEnc: encryptToken(token),
                refreshTokenEnc: row.refreshToken ? encryptToken(row.refreshToken) : null,
                // A Meta PAGE token has no expiry (M-AUTH-21), so recording the user token's
                // sixty days against it would make a healthy connection look doomed. LinkedIn
                // has no page token at all and its sixty days are real, so they are kept.
                tokenExpiresAt: found.accountToken ? null : row.expiresAt,
                status: 'connected',
                lastError: null,
                lastCheckedAt: new Date(),
                connectedBy: userId,
            };
            if (existing[0]) {
                await db.update(socialAccounts).set(values)
                    .where(tenantWhere(socialAccounts, accountId, eq(socialAccounts.id, existing[0].id)));
            }
            else {
                await db.insert(socialAccounts).values(withTenant(accountId, {
                    businessId: row.businessId, network, externalId, ...values,
                }));
            }
            saved++;
        }
        pending.delete(parsed.data.handoff);
        return { ok: true, saved };
    });
    /**
     * Disconnect.
     *
     * The account row goes and its posts DO NOT. A target's link to the account is set
     * null on delete, so the record that something published last month, with its
     * permalink, survives unhooking the account it went out through.
     */
    app.delete('/api/v1/social/accounts/:id', { preHandler: app.requireAuth }, async (req, reply) => {
        const { accountId } = authOf(req);
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        const [row] = await db.select({ businessId: socialAccounts.businessId, network: socialAccounts.network })
            .from(socialAccounts)
            .where(tenantWhere(socialAccounts, accountId, eq(socialAccounts.id, id))).limit(1);
        if (!row)
            return reply.code(404).send({ error: 'Not connected.' });
        if (!(await assertBusinessAccess(req, reply, row.businessId, 'admin')))
            return;
        await db.delete(socialAccounts).where(tenantWhere(socialAccounts, accountId, eq(socialAccounts.id, id)));
        return {
            ok: true,
            message: `${NETWORK_LABEL[row.network]} disconnected. Posts that already went out keep their links.`,
        };
    });
    // ---- App settings, so nobody needs a server to set this up ---------------------
    /**
     * The app identity this workspace connects through.
     *
     * The secret is NEVER returned, only whether one is stored. `source` says where the
     * working credentials come from, because "your app" and "the one Klippy ships" are
     * different situations and a person setting this up needs to know which they are in.
     */
    app.get('/api/v1/social/app-settings', { preHandler: app.requireAuth }, async (req, reply) => {
        const { accountId, role } = authOf(req);
        if (role === 'member')
            return reply.code(403).send({ error: 'Only admins can see app settings.' });
        return { settings: await listAppSettings(accountId) };
    });
    app.put('/api/v1/social/app-settings/:provider', { preHandler: app.requireAuth }, async (req, reply) => {
        const { accountId, userId, role } = authOf(req);
        if (role === 'member')
            return reply.code(403).send({ error: 'Only admins can change app settings.' });
        const provider = req.params.provider;
        if (provider !== 'meta' && provider !== 'linkedin') {
            return reply.code(400).send({ error: 'Unknown provider.' });
        }
        if (!socialTokensAvailable()) {
            return reply.code(503).send({
                error: 'This server cannot store secrets yet. Set SOCIAL_TOKEN_KEY in the app environment and restart.',
            });
        }
        const parsed = z.object({
            appId: z.string().trim().min(3).max(120),
            // Optional so the config id can be edited without retyping a secret, and absent
            // means "keep the stored one" rather than "clear it".
            appSecret: z.string().trim().min(8).max(400).optional(),
            configId: z.string().trim().max(120).nullable().optional(),
        }).safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: parsed.error.issues[0]?.message });
        await saveAppSettings(accountId, userId, provider, parsed.data);
        return { ok: true, settings: await listAppSettings(accountId) };
    });
    /**
     * Forget this workspace's app details.
     *
     * Accounts already connected keep working, because they publish with their own
     * access tokens. Only new connections stop being possible.
     */
    app.delete('/api/v1/social/app-settings/:provider', { preHandler: app.requireAuth }, async (req, reply) => {
        const { accountId, role } = authOf(req);
        if (role === 'member')
            return reply.code(403).send({ error: 'Only admins can change app settings.' });
        const provider = req.params.provider;
        if (provider !== 'meta' && provider !== 'linkedin') {
            return reply.code(400).send({ error: 'Unknown provider.' });
        }
        await clearAppSettings(accountId, provider);
        return {
            ok: true,
            message: 'Removed. Accounts already connected keep posting; only new connections need details again.',
            settings: await listAppSettings(accountId),
        };
    });
    /**
     * Is this connection still alive?
     *
     * A cheap read against the account itself. A token that has been revoked, or a Page
     * role that was removed, looks exactly like a working connection in our database
     * until something tries to use it, and finding that out at 09:00 on a Monday is the
     * failure this exists to prevent.
     */
    app.post('/api/v1/social/accounts/:id/check', { preHandler: app.requireAuth }, async (req, reply) => {
        const { accountId } = authOf(req);
        const id = intId(req);
        if (!id)
            return reply.code(400).send({ error: 'Bad id.' });
        const [row] = await db.select().from(socialAccounts)
            .where(tenantWhere(socialAccounts, accountId, eq(socialAccounts.id, id))).limit(1);
        if (!row)
            return reply.code(404).send({ error: 'Not connected.' });
        if (!(await assertBusinessAccess(req, reply, row.businessId, 'admin')))
            return;
        const { checkAccount } = await import('../lib/social/health.js');
        const result = await checkAccount(row);
        return result;
    });
}
//# sourceMappingURL=socialConnect.js.map