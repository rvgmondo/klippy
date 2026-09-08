import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { socialAppSettings } from '../../db/schema.js';
import { tenantWhere } from '../tenant.js';
import { encryptToken, decryptToken } from './tokens.js';
import type { Network } from './types.js';

/**
 * The app credentials a workspace connects through.
 *
 * ONE PLACE ANSWERS "CAN THIS WORKSPACE CONNECT INSTAGRAM", so the settings screen,
 * the connect route and the accounts list cannot disagree about it, which is how a
 * Connect button ends up existing only to return an error.
 *
 * The workspace's own row wins, and the environment is the fallback. Both matter:
 *   - A workspace pastes its own app id and secret into Klippy and it works, with no
 *     server access, which is the whole point of moving these out of env vars.
 *   - One day Klippy ships its own reviewed app in the environment, and every
 *     workspace inherits it without a single row being written.
 *
 * These are used ONLY during the OAuth round trip. Publishing runs on the per-account
 * access token stored on social_accounts, so clearing these breaks new connections and
 * leaves existing ones posting exactly as before.
 */

export type Provider = 'meta' | 'linkedin';

export const providerOf = (network: Network): Provider =>
  (network === 'linkedin' ? 'linkedin' : 'meta');

export interface AppCredentials {
  appId: string;
  appSecret: string;
  configId: string | null;
  /** Where these came from, so the UI can say "your app" or "provided by Klippy". */
  source: 'workspace' | 'server';
}

function fromEnv(provider: Provider): AppCredentials | null {
  const appId = provider === 'meta' ? process.env.META_APP_ID : process.env.LINKEDIN_CLIENT_ID;
  const appSecret = provider === 'meta' ? process.env.META_APP_SECRET : process.env.LINKEDIN_CLIENT_SECRET;
  if (!appId || !appSecret) return null;
  return {
    appId, appSecret,
    configId: provider === 'meta' ? (process.env.META_LOGIN_CONFIG_ID ?? null) : null,
    source: 'server',
  };
}

export async function appCredentials(accountId: number, provider: Provider): Promise<AppCredentials | null> {
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
    } catch {
      // A stored secret that cannot be decrypted usually means SOCIAL_TOKEN_KEY
      // changed. Falling through to the environment is better than a hard failure,
      // and the settings screen shows the row as needing to be entered again.
    }
  }
  return fromEnv(provider);
}

/** Whether a workspace can start a connection on this network at all. */
export async function canConnect(accountId: number, network: Network): Promise<boolean> {
  return !!(await appCredentials(accountId, providerOf(network)));
}

export interface AppSettingsView {
  provider: Provider;
  appId: string | null;
  configId: string | null;
  /** Never the secret itself. Only whether one is stored. */
  hasSecret: boolean;
  source: 'workspace' | 'server' | 'none';
}

export async function listAppSettings(accountId: number): Promise<AppSettingsView[]> {
  const rows = await db.select().from(socialAppSettings)
    .where(tenantWhere(socialAppSettings, accountId));

  const out: AppSettingsView[] = [];
  for (const provider of ['meta', 'linkedin'] as Provider[]) {
    const row = rows.find((r) => r.provider === provider);
    const env = fromEnv(provider);
    if (row?.appId && row.appSecretEnc) {
      out.push({ provider, appId: row.appId, configId: row.configId ?? null, hasSecret: true, source: 'workspace' });
    } else if (env) {
      // The id is shown because it is not a secret and seeing it is how somebody
      // confirms which app their connections will go through.
      out.push({ provider, appId: env.appId, configId: env.configId, hasSecret: true, source: 'server' });
    } else {
      out.push({ provider, appId: row?.appId ?? null, configId: row?.configId ?? null, hasSecret: false, source: 'none' });
    }
  }
  return out;
}

export async function saveAppSettings(
  accountId: number, userId: number, provider: Provider,
  values: { appId: string; appSecret?: string; configId?: string | null },
): Promise<void> {
  const [existing] = await db.select({ id: socialAppSettings.id }).from(socialAppSettings)
    .where(tenantWhere(socialAppSettings, accountId, eq(socialAppSettings.provider, provider)))
    .limit(1);

  const patch: Record<string, unknown> = {
    appId: values.appId,
    configId: values.configId ?? null,
    updatedBy: userId,
  };
  // An absent secret means "leave the stored one alone", so editing the config id does
  // not silently wipe a credential nobody meant to touch.
  if (values.appSecret) patch.appSecretEnc = encryptToken(values.appSecret);

  if (existing) {
    await db.update(socialAppSettings).set(patch)
      .where(tenantWhere(socialAppSettings, accountId, eq(socialAppSettings.id, existing.id)));
  } else {
    await db.insert(socialAppSettings).values({ accountId, provider, ...patch } as never);
  }
}

export async function clearAppSettings(accountId: number, provider: Provider): Promise<void> {
  // Only the workspace's own row goes. Connections already made keep working, because
  // they run on their own access tokens.
  await db.delete(socialAppSettings)
    .where(tenantWhere(socialAppSettings, accountId, eq(socialAppSettings.provider, provider)));
}
