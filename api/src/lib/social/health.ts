import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { socialAccounts } from '../../db/schema.js';
import { tenantWhere } from '../tenant.js';
import { httpJson } from './http.js';
import { decryptToken } from './tokens.js';
import { SocialApiError, NETWORK_LABEL, type Network } from './types.js';
import { metaConfigured } from './adapters/meta.js';

/**
 * Is this connection still going to work on Monday?
 *
 * A revoked token, a removed Page role and a deleted account all look identical to a
 * healthy connection in our database: a row with a status of 'connected'. Nothing
 * finds out otherwise until something tries to publish, and finding out then means a
 * client's post did not go out and nobody knew why.
 *
 * So this asks. It is one cheap read per account, run daily and on demand, and its
 * whole job is to move a broken connection into a state a person can see BEFORE it
 * costs them a post.
 */

const VERSION = process.env.META_API_VERSION || 'v26.0';
const GRAPH = `https://graph.facebook.com/${VERSION}`;

export interface HealthResult {
  ok: boolean;
  status: 'connected' | 'expired' | 'revoked' | 'error';
  message: string;
}

export async function checkAccount(row: typeof socialAccounts.$inferSelect): Promise<HealthResult> {
  const network = row.network as Network;
  const label = NETWORK_LABEL[network];

  if (!row.accessTokenEnc) {
    return await record(row, 'error', 'There is no stored token for this connection.');
  }
  if ((network === 'instagram' || network === 'facebook') && !metaConfigured()) {
    // Not the connection's fault, so it is not marked broken. The server is missing
    // its app credentials, and saying that is more useful than a red badge.
    return { ok: false, status: row.status as HealthResult['status'], message: 'The Meta app is not set up on this server.' };
  }

  let token: string;
  try {
    token = decryptToken(row.accessTokenEnc);
  } catch {
    return await record(row, 'error', 'The stored token could not be read. Reconnect the account.');
  }

  try {
    if (network === 'linkedin') {
      // The org's own node, for the same reason as below: it proves the token works
      // AND that this member still administers this specific Page.
      const id = row.externalId.split(':').pop() ?? '';
      const res = await fetch(`https://api.linkedin.com/rest/organizations/${id}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Restli-Protocol-Version': '2.0.0',
          'LinkedIn-Version': process.env.LINKEDIN_VERSION || '202608',
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) return await record(row, 'connected', `${label} is connected and working.`);
      if (res.status === 401 || res.status === 403) {
        return await record(row, 'revoked', `${label}: the connection was revoked or the Page role was removed.`);
      }
      return { ok: false, status: row.status as HealthResult['status'], message: `Could not reach ${label} just now.` };
    }

    // The cheapest call that proves the token still works AND still reaches this
    // specific account: reading the node's own id. A /me call would pass even after
    // the Page role was removed, which is the case worth catching.
    await httpJson<{ id: string }>(
      `${GRAPH}/${row.externalId}?${new URLSearchParams({ fields: 'id', access_token: token })}`,
      { network, timeoutMs: 15_000 });
    return await record(row, 'connected', `${label} is connected and working.`);
  } catch (err) {
    if (err instanceof SocialApiError) {
      // A retryable error says nothing about the credential: the platform was busy or
      // the network dropped. Marking the connection broken over that would cry wolf.
      if (err.retryable) {
        return { ok: false, status: row.status as HealthResult['status'], message: `Could not reach ${label} just now.` };
      }
      const revoked = /re-authoris|revok|permission/i.test(err.message);
      return await record(row, revoked ? 'revoked' : 'expired', `${label}: ${err.message}`);
    }
    return await record(row, 'error', `${label}: ${err instanceof Error ? err.message : 'unknown error'}`);
  }
}

async function record(
  row: typeof socialAccounts.$inferSelect,
  status: HealthResult['status'],
  message: string,
): Promise<HealthResult> {
  await db.update(socialAccounts).set({
    status,
    lastCheckedAt: new Date(),
    lastError: status === 'connected' ? null : message.slice(0, 500),
  }).where(tenantWhere(socialAccounts, row.accountId, eq(socialAccounts.id, row.id)))
    .catch(() => { /* a health check must never break the request that asked for it */ });
  return { ok: status === 'connected', status, message };
}

/**
 * Every connection, once a day.
 *
 * Runs across all workspaces, so it is deliberately quiet: one call per account, and
 * a failure on one never stops the rest.
 */
export async function runSocialTokenCheck(): Promise<string> {
  const rows = await db.select().from(socialAccounts);
  let ok = 0;
  let broken = 0;
  for (const row of rows) {
    try {
      const res = await checkAccount(row);
      if (res.ok) ok++; else broken++;
    } catch {
      broken++;
    }
  }
  return `${ok} connection(s) healthy${broken ? `, ${broken} need attention` : ''}`;
}
