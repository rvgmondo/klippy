import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { socialAppSettings } from '../../db/schema.js';
import { tenantWhere } from '../tenant.js';
import { encryptToken, decryptToken } from './tokens.js';
export const providerOf = (network) => (network === 'linkedin' ? 'linkedin' : 'meta');
function fromEnv(provider) {
    const appId = provider === 'meta' ? process.env.META_APP_ID : process.env.LINKEDIN_CLIENT_ID;
    const appSecret = provider === 'meta' ? process.env.META_APP_SECRET : process.env.LINKEDIN_CLIENT_SECRET;
    if (!appId || !appSecret)
        return null;
    return {
        appId, appSecret,
        configId: provider === 'meta' ? (process.env.META_LOGIN_CONFIG_ID ?? null) : null,
        source: 'server',
    };
}
export async function appCredentials(accountId, provider) {
    const [row] = await db.select().from(socialAppSettings)
        .where(tenantWhere(socialAppSettings, accountId, eq(socialAppSettings.provider, provider)))
        .limit(1);
    if (row?.appId && row.appSecretEnc) {
        try {
            return {
                appId: row.appId,
                appSecret: decryptToken(row.appSecretEnc),
                configId: row.configId ?? null,
                source: 'workspace',
            };
        }
        catch {
            // A stored secret that cannot be decrypted usually means SOCIAL_TOKEN_KEY
            // changed. Falling through to the environment is better than a hard failure,
            // and the settings screen shows the row as needing to be entered again.
        }
    }
    return fromEnv(provider);
}
/** Whether a workspace can start a connection on this network at all. */
export async function canConnect(accountId, network) {
    return !!(await appCredentials(accountId, providerOf(network)));
}
export async function listAppSettings(accountId) {
    const rows = await db.select().from(socialAppSettings)
        .where(tenantWhere(socialAppSettings, accountId));
    const out = [];
    for (const provider of ['meta', 'linkedin']) {
        const row = rows.find((r) => r.provider === provider);
        const env = fromEnv(provider);
        if (row?.appId && row.appSecretEnc) {
            out.push({ provider, appId: row.appId, configId: row.configId ?? null, hasSecret: true, source: 'workspace' });
        }
        else if (env) {
            // The id is shown because it is not a secret and seeing it is how somebody
            // confirms which app their connections will go through.
            out.push({ provider, appId: env.appId, configId: env.configId, hasSecret: true, source: 'server' });
        }
        else {
            out.push({ provider, appId: row?.appId ?? null, configId: row?.configId ?? null, hasSecret: false, source: 'none' });
        }
    }
    return out;
}
export async function saveAppSettings(accountId, userId, provider, values) {
    const [existing] = await db.select({ id: socialAppSettings.id }).from(socialAppSettings)
        .where(tenantWhere(socialAppSettings, accountId, eq(socialAppSettings.provider, provider)))
        .limit(1);
    const patch = {
        appId: values.appId,
        configId: values.configId ?? null,
        updatedBy: userId,
    };
    // An absent secret means "leave the stored one alone", so editing the config id does
    // not silently wipe a credential nobody meant to touch.
    if (values.appSecret)
        patch.appSecretEnc = encryptToken(values.appSecret);
    if (existing) {
        await db.update(socialAppSettings).set(patch)
            .where(tenantWhere(socialAppSettings, accountId, eq(socialAppSettings.id, existing.id)));
    }
    else {
        await db.insert(socialAppSettings).values({ accountId, provider, ...patch });
    }
}
export async function clearAppSettings(accountId, provider) {
    // Only the workspace's own row goes. Connections already made keep working, because
    // they run on their own access tokens.
    await db.delete(socialAppSettings)
        .where(tenantWhere(socialAppSettings, accountId, eq(socialAppSettings.provider, provider)));
}
//# sourceMappingURL=credentials.js.map