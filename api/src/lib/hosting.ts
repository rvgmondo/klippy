import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  documents, events, folders, hostingAccounts, hostingSettings, offerings, subscriptions,
} from '../db/schema.js';
import { tenantWhere, withTenant } from './tenant.js';
import { decryptSecret } from './secretbox.js';
import { emailBrandFor, sendBusinessMail } from './mailer.js';
import { renderEmail, renderEmailText } from './emailLayout.js';
import {
  accountExists, createAccount, generatePassword, suspendAccount, unsuspendAccount,
  usernameFor, type WhmCreds,
} from './whm.js';

/**
 * Turning a paid hosting invoice into an actual cPanel account.
 *
 * Same shape as auto-debit, for the same reason: this reaches out and changes
 * something on a real server, so most of the code is the conditions under which it
 * refuses. The differences from auto-debit are worth stating:
 *
 *  - There is no undo. A cPanel account can be suspended, but the thing this
 *    creates holds a customer's website and mail, so nothing here ever deletes.
 *  - The password is generated, emailed to the client, and NOT kept. Storing a
 *    recoverable password for every hosting account is a liability with no real
 *    upside, since WHM can reset one in a click.
 *  - Uniqueness is per subscription, so a second payment on the same subscription
 *    (a renewal, a retried notification) never creates a second account.
 */

export type ProvisionOutcome = 'created' | 'dry-run' | 'skipped' | 'failed';

async function note(
  accountId: number, businessId: number | null, outcome: ProvisionOutcome,
  detail: string, extra: Record<string, unknown>,
): Promise<void> {
  await db.insert(events).values({
    accountId, businessId, name: 'hosting.provision',
    payload: { outcome, detail, ...extra },
    results: [{ handler: 'hosting.provision', outcome: detail, ok: outcome === 'created' || outcome === 'dry-run' }],
  }).catch(() => { /* diagnostics must never break a payment */ });
}

/** The WHM server for a business: its own, or the workspace one. Same rule as payments. */
export async function hostingSettingsFor(accountId: number, businessId: number | null) {
  if (businessId) {
    const [own] = await db.select().from(hostingSettings)
      .where(and(eq(hostingSettings.accountId, accountId), eq(hostingSettings.businessId, businessId)))
      .limit(1);
    if (own) return own;
  }
  const [ws] = await db.select().from(hostingSettings)
    .where(and(eq(hostingSettings.accountId, accountId), eq(hostingSettings.businessId, 0)))
    .limit(1);
  return ws ?? null;
}

export function credsOf(row: typeof hostingSettings.$inferSelect): WhmCreds | null {
  if (!row.whmHost || !row.whmTokenEnc) return null;
  try {
    return {
      host: row.whmHost,
      user: row.whmUser || 'root',
      token: decryptSecret(row.whmTokenEnc),
      allowSelfSigned: row.allowSelfSigned,
    };
  } catch {
    return null;
  }
}

/**
 * An invoice has been paid. Set up whatever it was selling.
 *
 * Called from every path that settles an invoice, and safe to call for all of them:
 * the overwhelmingly common case is an invoice with nothing to provision, which
 * costs one indexed lookup and returns.
 */
export async function onInvoicePaid(accountId: number, documentId: number): Promise<void> {
  try {
    const [doc] = await db.select({
      id: documents.id, businessId: documents.businessId, number: documents.number,
      subscriptionId: documents.subscriptionId, clientEmail: documents.clientEmail,
      clientName: documents.clientName, folderId: documents.folderId,
    }).from(documents)
      .where(tenantWhere(documents, accountId, eq(documents.id, documentId))).limit(1);
    if (!doc?.subscriptionId) return;
    await provisionSubscription(accountId, doc.subscriptionId, doc.number);
    // And if their site was switched off for non-payment, put it back now rather
    // than at tomorrow's sweep.
    await restoreIfSuspended(accountId, doc.subscriptionId);
  } catch {
    // Provisioning must never undo a payment. A failure is recorded by the code
    // below; anything escaping that is swallowed here on purpose.
  }
}

export async function provisionSubscription(
  accountId: number, subscriptionId: number, invoiceNumber = '',
): Promise<{ outcome: ProvisionOutcome; detail: string }> {
  const [sub] = await db.select().from(subscriptions)
    .where(tenantWhere(subscriptions, accountId, eq(subscriptions.id, subscriptionId))).limit(1);
  if (!sub) return { outcome: 'skipped', detail: 'Subscription no longer exists.' };

  const [offering] = await db.select().from(offerings)
    .where(tenantWhere(offerings, accountId, eq(offerings.id, sub.offeringId))).limit(1);
  // The ordinary case: this subscription does not set anything up. Returns before
  // touching settings or the network.
  if (!offering || offering.provisioning !== 'cpanel') {
    return { outcome: 'skipped', detail: 'Nothing to provision for this offering.' };
  }

  const done = async (outcome: ProvisionOutcome, detail: string, extra: Record<string, unknown> = {}) => {
    await note(accountId, sub.businessId, outcome, detail, {
      subscriptionId, domain: sub.domain, number: invoiceNumber, ...extra,
    });
    return { outcome, detail };
  };

  const settings = await hostingSettingsFor(accountId, sub.businessId);
  if (!settings?.enabled) return done('skipped', 'Hosting provisioning is off for this business.');
  if (!sub.domain) {
    return done('skipped', 'No domain on this subscription, so there is nothing to create an account for. Add one and provision it by hand.');
  }

  // Claim the subscription before doing anything. Unique on subscriptionId, so a
  // retried notification or an overlapping run loses the race instead of creating a
  // second hosting account for the same customer.
  const domain = sub.domain.trim().toLowerCase().replace(/^www\./, '');
  try {
    await db.insert(hostingAccounts).values(withTenant(accountId, {
      businessId: sub.businessId, subscriptionId, domain,
      whmPackage: offering.whmPackage ?? null, status: 'pending' as const,
    }));
  } catch {
    return { outcome: 'skipped', detail: 'This subscription already has a hosting account.' };
  }

  const finish = async (status: 'active' | 'failed' | 'dry-run', detail: string, username?: string) => {
    await db.update(hostingAccounts).set({ status, detail, ...(username ? { username } : {}) })
      .where(tenantWhere(hostingAccounts, accountId, eq(hostingAccounts.subscriptionId, subscriptionId)));
  };

  let username = usernameFor(domain);

  // A dry run never contacts the server, so it must not need working credentials to
  // be useful. This is the check people run BEFORE the setup is finished, to see
  // which clients and domains would be picked up.
  if (!settings.live) {
    await finish('dry-run', `Would have created ${username} for ${domain}${offering.whmPackage ? ` on package ${offering.whmPackage}` : ''}.`, username);
    return done('dry-run',
      `Dry run: would have created cPanel account ${username} for ${domain}. Nothing was created. Switch on live provisioning when this looks right.`,
      { username });
  }

  const creds = credsOf(settings);
  if (!creds) {
    await finish('failed', 'WHM host or API token is missing, or the token cannot be decrypted. Re-enter it.');
    return done('failed', 'WHM host or API token is missing, or the token cannot be decrypted. Re-enter it.');
  }

  // Pick a username that does not already exist on the server. Checked against WHM
  // rather than against our own records, because the server is the authority and
  // may well hold accounts Klippy never created.
  for (let i = 0; i < 5 && await accountExists(creds, username); i++) {
    username = usernameFor(domain, (u) => u === username);
  }

  const email = await billingEmailFor(accountId, sub.folderId);
  const password = generatePassword();
  const res = await createAccount(creds, {
    username, domain, password, plan: offering.whmPackage, contactEmail: email,
  });
  if (!res.ok) {
    await finish('failed', res.message, username);
    return done('failed', res.message, { username });
  }

  await finish('active', `Created ${username} for ${domain}.`, username);

  // The password exists only in this message. If it does not arrive, WHM resets it;
  // that is a better trade than keeping every client's hosting password recoverable.
  if (email) {
    await sendWelcome(accountId, sub.businessId, email, {
      domain, username, password, host: creds.host, clientName: await clientNameFor(accountId, sub.folderId),
    }).catch(() => { /* the account exists either way, and the failure is recorded below */ });
  }
  return done('created',
    `Created cPanel account ${username} for ${domain}${email ? `, credentials emailed to ${email}` : '. No billing email on file, so the login was NOT sent: set it in WHM.'}`,
    { username, emailed: !!email });
}

async function billingEmailFor(accountId: number, folderId: number | null): Promise<string | null> {
  if (!folderId) return null;
  const [f] = await db.select({ email: folders.billingEmail }).from(folders)
    .where(tenantWhere(folders, accountId, eq(folders.id, folderId))).limit(1);
  return f?.email ?? null;
}

async function clientNameFor(accountId: number, folderId: number | null): Promise<string> {
  if (!folderId) return 'there';
  const [f] = await db.select({ name: folders.name }).from(folders)
    .where(tenantWhere(folders, accountId, eq(folders.id, folderId))).limit(1);
  return f?.name ?? 'there';
}

async function sendWelcome(
  accountId: number, businessId: number | null, to: string,
  d: { domain: string; username: string; password: string; host: string; clientName: string },
): Promise<void> {
  const brand = await emailBrandFor(accountId, businessId);
  const content = {
    heading: `Your hosting for ${d.domain} is ready`,
    body: [
      `Hi ${d.clientName},`,
      'Your hosting account is set up and ready to use. Your login details are below.',
      'Please change the password after you first sign in, and keep this email somewhere safe until you have.',
    ],
    facts: [
      ['Domain', d.domain] as [string, string],
      ['Username', d.username] as [string, string],
      ['Password', d.password] as [string, string],
      ['Control panel', `https://${d.host}:2083`] as [string, string],
    ],
    note: 'If your domain is not pointing at us yet, the site will only appear once its nameservers have been updated.',
  };
  await sendBusinessMail({
    accountId, businessId, purpose: 'general', to,
    subject: `Hosting for ${d.domain} is ready`,
    text: renderEmailText(brand, content),
    html: renderEmail(brand, content),
  });
}

/**
 * The daily sweep: warn, then suspend, hosting whose invoices have gone unpaid.
 *
 * Suspending a client's website is the most aggressive thing Klippy does, so it is
 * off unless a number of days is actually set, it warns before it acts, and it only
 * ever counts invoices raised BY the subscription that owns the hosting. An unpaid
 * consulting invoice must never take a website down.
 *
 * Restoring is not handled here: that happens the moment an invoice is paid, in
 * onInvoicePaid, because a client who has just paid should not wait for tomorrow's
 * job to get their site back.
 */
export async function runHostingSuspensions(): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  const live = await db.select().from(hostingAccounts)
    .where(eq(hostingAccounts.status, 'active'));

  let warned = 0;
  let suspended = 0;
  let wouldSuspend = 0;
  for (const acct of live) {
    try {
      const settings = await hostingSettingsFor(acct.accountId, acct.businessId);
      // Null days means never. This is the default and the safe reading of "not
      // configured": do nothing rather than guess a number.
      if (!settings?.enabled || settings.suspendAfterDays == null) continue;

      const overdue = await oldestOverdueDays(acct.accountId, acct.subscriptionId, today);
      if (overdue == null) {
        // Paid up. Clear any warning so a later lapse warns again rather than
        // suspending silently on the strength of a months-old notice.
        if (acct.warnedAt) {
          await db.update(hostingAccounts).set({ warnedAt: null })
            .where(eq(hostingAccounts.id, acct.id));
        }
        continue;
      }

      if (overdue >= settings.suspendAfterDays) {
        // In dry run this still has to say WHO would be cut off. A run that
        // reported nothing would be indistinguishable from a run with nothing to
        // do, and this is the list worth reading twice before going live.
        if (!settings.live) {
          await note(acct.accountId, acct.businessId, 'dry-run',
            `Dry run: would have suspended ${acct.domain} (${overdue} days overdue). Nothing was changed.`,
            { subscriptionId: acct.subscriptionId, domain: acct.domain, overdue });
          wouldSuspend++;
          continue;
        }
        const res = await setSuspended(acct.accountId, acct.id, true,
          `Unpaid for ${overdue} days`);
        if (res.ok) suspended++;
        continue;
      }

      const warnAt = settings.suspendAfterDays - (settings.warnBeforeDays ?? 0);
      if (settings.warnBeforeDays && overdue >= warnAt && !acct.warnedAt) {
        const when = new Date(Date.now() + (settings.suspendAfterDays - overdue) * 86400000)
          .toISOString().slice(0, 10);
        const sent = await sendSuspensionWarning(acct, when);
        // Marked as warned either way. Retrying a failed send every morning would
        // turn one undeliverable address into a daily loop.
        await db.update(hostingAccounts).set({ warnedAt: new Date() })
          .where(eq(hostingAccounts.id, acct.id));
        if (sent) warned++;
      }
    } catch { /* one bad account must not stop the sweep */ }
  }
  return `${warned} warned, ${suspended} suspended${wouldSuspend ? `, ${wouldSuspend} would be suspended (dry run)` : ''} of ${live.length} active`;
}

/** Days past due on the oldest unpaid invoice for this subscription, or null if paid up. */
async function oldestOverdueDays(
  accountId: number, subscriptionId: number, today: string,
): Promise<number | null> {
  const rows = await db.select({ dueDate: documents.dueDate }).from(documents)
    .where(and(
      tenantWhere(documents, accountId, eq(documents.subscriptionId, subscriptionId)),
      eq(documents.type, 'invoice'),
      eq(documents.status, 'sent'),
    ));
  let worst: number | null = null;
  for (const r of rows) {
    if (!r.dueDate) continue;
    const days = Math.floor(
      (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${r.dueDate}T00:00:00Z`)) / 86400000,
    );
    if (days > 0 && (worst == null || days > worst)) worst = days;
  }
  return worst;
}

async function sendSuspensionWarning(
  acct: typeof hostingAccounts.$inferSelect, when: string,
): Promise<boolean> {
  const [sub] = await db.select({ folderId: subscriptions.folderId }).from(subscriptions)
    .where(eq(subscriptions.id, acct.subscriptionId)).limit(1);
  const to = await billingEmailFor(acct.accountId, sub?.folderId ?? null);
  if (!to) return false;

  const brand = await emailBrandFor(acct.accountId, acct.businessId);
  const content = {
    heading: `Action needed for ${acct.domain}`,
    body: [
      `Hi ${await clientNameFor(acct.accountId, sub?.folderId ?? null)},`,
      `We have not received payment for your hosting, so ${acct.domain} is due to be switched off on ${when}.`,
      'Settling the outstanding invoice will stop that happening. If you have already paid in the last day or two, please ignore this.',
    ],
    note: 'If something is wrong with the invoice, reply to this email and we will sort it out rather than switch anything off.',
  };
  await sendBusinessMail({
    accountId: acct.accountId, businessId: acct.businessId, purpose: 'invoice', to,
    subject: `${acct.domain}: hosting due to be suspended on ${when}`,
    text: renderEmailText(brand, content),
    html: renderEmail(brand, content),
  });
  return true;
}

/**
 * They have paid. Put the site back immediately, and clear the warning.
 *
 * Called from onInvoicePaid rather than from the daily job on purpose: somebody who
 * has just paid should not have to wait until tomorrow morning for their website.
 */
async function restoreIfSuspended(accountId: number, subscriptionId: number): Promise<void> {
  const [acct] = await db.select().from(hostingAccounts)
    .where(tenantWhere(hostingAccounts, accountId, eq(hostingAccounts.subscriptionId, subscriptionId)))
    .limit(1);
  if (!acct) return;
  if (acct.warnedAt) {
    await db.update(hostingAccounts).set({ warnedAt: null }).where(eq(hostingAccounts.id, acct.id));
  }
  if (acct.status !== 'suspended') return;
  const today = new Date().toISOString().slice(0, 10);
  // Only if nothing else is still outstanding, so paying one of three overdue
  // invoices does not restore the site.
  if ((await oldestOverdueDays(accountId, subscriptionId, today)) != null) return;
  await setSuspended(accountId, acct.id, false);
}

/** Suspend or restore one account by hand, from the hosting screen. */
export async function setSuspended(
  accountId: number, hostingAccountId: number, suspend: boolean, reason = 'Unpaid',
): Promise<{ ok: boolean; message: string }> {
  const [row] = await db.select().from(hostingAccounts)
    .where(tenantWhere(hostingAccounts, accountId, eq(hostingAccounts.id, hostingAccountId))).limit(1);
  if (!row) return { ok: false, message: 'Hosting account not found.' };
  if (!row.username) return { ok: false, message: 'This record has no cPanel username yet.' };

  const settings = await hostingSettingsFor(accountId, row.businessId);
  if (!settings?.enabled) return { ok: false, message: 'Hosting is off for this business.' };
  const creds = settings && credsOf(settings);
  if (!creds) return { ok: false, message: 'WHM credentials are incomplete.' };
  if (!settings.live) {
    return { ok: false, message: 'Live provisioning is off, so nothing was changed on the server.' };
  }

  const res = suspend
    ? await suspendAccount(creds, row.username, reason)
    : await unsuspendAccount(creds, row.username);
  if (res.ok) {
    await db.update(hostingAccounts).set({
      status: suspend ? 'suspended' : 'active', detail: res.message,
      suspendedAt: suspend ? new Date() : null,
      // Clearing the warning on restore means a later lapse warns again instead of
      // going straight to a dark website.
      ...(suspend ? {} : { warnedAt: null }),
    }).where(tenantWhere(hostingAccounts, accountId, eq(hostingAccounts.id, hostingAccountId)));
    await note(accountId, row.businessId, 'created',
      `${suspend ? 'Suspended' : 'Restored'} ${row.username} (${row.domain}).`, { subscriptionId: row.subscriptionId });
  }
  return { ok: res.ok, message: res.message };
}
