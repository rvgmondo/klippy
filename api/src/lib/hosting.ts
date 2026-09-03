import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  documents, documentLines, events, folders, hostingAccounts, hostingSettings, offerings,
  subscriptions,
} from '../db/schema.js';
import { isDuplicateKey, tenantWhere, withTenant } from './tenant.js';
import { addMonths } from './billing.js';
import { decryptSecret } from './secretbox.js';
import { appUrl, emailBrandFor, sendBusinessMail } from './mailer.js';
import { renderEmail, renderEmailText } from './emailLayout.js';
import {
  accountExists, changePrimaryDomain, createAccount, generatePassword, isReservedRejection,
  setAccountPassword, suspendAccount, tempDomainFor, unsuspendAccount, usernameFor, type WhmCreds,
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
      subscriptionsStartedAt: documents.subscriptionsStartedAt,
    }).from(documents)
      .where(tenantWhere(documents, accountId, eq(documents.id, documentId))).limit(1);
    if (!doc) return;

    /**
     * Never set anything up for a client who is in the Trash.
     *
     * A payment can still land on a trashed client's invoice: an old pay link, a
     * bank transfer entered by hand, or a gateway notification arriving after the
     * delete. Provisioning off the back of that creates a real cPanel account, on a
     * real server, for a client the founder believes they have deleted, and the
     * suspension sweep will not touch it because the subscription is on its way out.
     * The payment is still recorded and the invoice still settles; only the
     * side effect is refused.
     */
    if (doc.folderId != null) {
      const [client] = await db.select({ id: folders.id }).from(folders)
        .where(tenantWhere(folders, accountId, eq(folders.id, doc.folderId), isNull(folders.deletedAt)))
        .limit(1);
      if (!client) return;
    }

    // An invoice raised BY a subscription: carry on with that one.
    if (doc.subscriptionId) {
      await provisionSubscription(accountId, doc.subscriptionId, doc.number);
      // And if their site was switched off for non-payment, put it back now rather
      // than at tomorrow's sweep.
      await restoreIfSuspended(accountId, doc.subscriptionId);
      return;
    }

    // An ordinary invoice that happens to sell something recurring. Selling a
    // monthly hosting package on a normal invoice used to bill once and start
    // nothing: no renewal, no cPanel account, no record that the client is on a
    // plan. Paying it now starts the thing that was sold.
    await startSubscriptionsFromLines(accountId, doc);
  } catch {
    // Provisioning must never undo a payment. A failure is recorded by the code
    // below; anything escaping that is swallowed here on purpose.
  }
}

/**
 * Turn the recurring lines of a paid invoice into subscriptions.
 *
 * Guarded once per document rather than once per line, because editing a document
 * deletes and re-inserts its lines; a per-line marker would be wiped by an ordinary
 * edit and the next payment would start everything a second time.
 *
 * A failure on one line must not stop the others: three things sold on one invoice
 * should not all fail because the middle one has a bad offering.
 */
async function startSubscriptionsFromLines(
  accountId: number,
  doc: { id: number; number: string; businessId: number | null; folderId: number | null },
): Promise<void> {
  if (!doc.folderId || !doc.businessId) return;

  const lines = await db.select({
    id: documentLines.id, offeringId: documentLines.offeringId,
    recurringMonths: documentLines.recurringMonths, description: documentLines.description,
    // What they were actually invoiced, which is not always the list price.
    amount: documentLines.amount,
  }).from(documentLines)
    .where(tenantWhere(documentLines, accountId, eq(documentLines.documentId, doc.id)));

  const recurring = lines.filter((l) => l.offeringId && l.recurringMonths);
  if (!recurring.length) return;

  // Claim the document first. Conditional on it still being unclaimed, so two
  // payments landing together cannot both start the same subscriptions.
  const claim = await db.update(documents).set({ subscriptionsStartedAt: new Date() })
    .where(and(
      tenantWhere(documents, accountId, eq(documents.id, doc.id)),
      isNull(documents.subscriptionsStartedAt),
    ));
  if (!claim[0].affectedRows) return;

  const today = new Date().toISOString().slice(0, 10);
  // The list prices, so a line billed at something else can be spotted.
  const listPrices = new Map<number, number>();
  {
    const ids = [...new Set(recurring.map((l) => l.offeringId as number))];
    const rows = ids.length
      ? await db.select({ id: offerings.id, price: offerings.price }).from(offerings)
        .where(tenantWhere(offerings, accountId, inArray(offerings.id, ids)))
      : [];
    for (const o of rows) listPrices.set(o.id, Number(o.price));
  }

  for (const line of recurring) {
    try {
      const months = line.recurringMonths as number;
      // Carry the invoiced amount onto the subscription when it is not the list
      // price. Without this, discounting or marking up a recurring line worked for
      // exactly one month: the client was invoiced the agreed figure at the point
      // of sale and quietly moved onto the list price at the next cycle, and
      // nothing anywhere said so.
      const charged = Number(line.amount);
      const list = listPrices.get(line.offeringId as number);
      const custom = Number.isFinite(charged) && list != null && charged !== list ? line.amount : null;

      const ins = await db.insert(subscriptions).values(withTenant(accountId, {
        businessId: doc.businessId as number,
        offeringId: line.offeringId as number,
        folderId: doc.folderId as number,
        status: 'active' as const,
        intervalMonths: months,
        price: custom,
        startedOn: today,
        // The first period is paid for by THIS invoice, so the next bill is one
        // period out. Billing again today would charge them twice for the same month.
        nextBillDate: addMonths(today, months),
        lastBilledAt: new Date(),
      }));
      const subId = Number(ins[0].insertId);
      await db.update(documentLines).set({ startedSubscriptionId: subId })
        .where(tenantWhere(documentLines, accountId, eq(documentLines.id, line.id)));

      await note(accountId, doc.businessId, 'created',
        `${doc.number} started a ${months === 1 ? 'monthly' : `${months}-monthly`} subscription for ${line.description}.`,
        { subscriptionId: subId, documentId: doc.id });

      // And if that offering sets something up, set it up. This is what makes
      // "add hosting to an invoice" actually produce hosting.
      await provisionSubscription(accountId, subId, doc.number).catch(() => null);
    } catch {
      await note(accountId, doc.businessId, 'failed',
        `Could not start a subscription for "${line.description}" from ${doc.number}. Start it by hand from Offerings.`,
        { documentId: doc.id });
    }
  }
}

export async function provisionSubscription(
  accountId: number, subscriptionId: number, invoiceNumber = '',
): Promise<{ outcome: ProvisionOutcome; detail: string }> {
  const [sub] = await db.select().from(subscriptions)
    .where(tenantWhere(subscriptions, accountId, eq(subscriptions.id, subscriptionId))).limit(1);
  if (!sub) return { outcome: 'skipped', detail: 'Subscription no longer exists.' };
  /**
   * A cancelled plan does not get a server.
   *
   * Payment can land on an invoice long after the plan behind it ended: an old pay
   * link, a bank transfer entered late, a gateway retry. Without this, settling that
   * invoice would create a real cPanel account, on a real server, for a client who
   * has already left, and nothing would ever take it down again because a cancelled
   * subscription raises no further invoices for the overdue sweep to find.
   *
   * Paused is different and is allowed through: a pause is temporary and the client
   * is expected back.
   */
  if (sub.status === 'canceled') {
    return { outcome: 'skipped', detail: 'Subscription is cancelled, so nothing was set up.' };
  }

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

  /**
   * What do we build this account on?
   *
   * No domain is the NORMAL case at the point of sale. People buy hosting and then
   * go and buy a domain, often days later. Three ways that can go:
   *
   *  - They gave us a domain. Use it.
   *  - They did not, but a holding address is configured. Build it NOW on an
   *    address we own, so somebody who has paid can log in this minute and start
   *    working, and ask them for the real one in parallel.
   *  - They did not and there is no holding address. Fall back to the old
   *    behaviour: ask, and wait. Nothing is created.
   */
  const clientName = await clientNameFor(accountId, sub.folderId);
  const realDomain = sub.domain ? sub.domain.trim().toLowerCase().replace(/^www\./, '') : null;

  // The username has to come from somewhere even when there is no domain yet, so
  // it falls back to the client's name. It is permanent once cPanel has it, and
  // renaming a cPanel user later is not something to do casually.
  let username = usernameFor(realDomain ?? clientName);
  const holding = !realDomain && settings.tempDomainPattern
    ? tempDomainFor(settings.tempDomainPattern, username)
    : null;

  if (!realDomain && !holding) {
    const asked = await requestDomain(accountId, sub);
    return done('skipped', asked
      ? 'Waiting on the client for a domain. They have been emailed and can enter it themselves; it will set itself up as soon as they do. Set a holding address in Settings > Hosting to give them a working account straight away instead.'
      : 'No domain, and no billing email to ask for one. Add either, or set a holding address, and it will set itself up.');
  }

  const domain = (realDomain ?? holding) as string;
  const isTemporary = !realDomain;

  // Claim the subscription before doing anything. Unique on subscriptionId, so a
  // retried notification or an overlapping run loses the race instead of creating a
  // second hosting account for the same customer.
  const [prior] = await db.select().from(hostingAccounts)
    .where(tenantWhere(hostingAccounts, accountId, eq(hostingAccounts.subscriptionId, subscriptionId)))
    .limit(1);

  if (prior && prior.status !== 'failed' && prior.status !== 'dry-run') {
    return { outcome: 'skipped', detail: 'This subscription already has a hosting account.' };
  }
  if (prior) {
    // A previous attempt failed, or was a dry run and live is now on. Reuse the row
    // rather than refusing: a stranded "failed" that can never be retried is worse
    // than no record at all, because it looks like something was done.
    await db.update(hostingAccounts).set({
      status: 'pending', domain, whmPackage: offering.whmPackage ?? null, detail: null,
      isTemporary, tempDomain: holding ?? prior.tempDomain,
    }).where(tenantWhere(hostingAccounts, accountId, eq(hostingAccounts.id, prior.id)));
  } else {
    try {
      await db.insert(hostingAccounts).values(withTenant(accountId, {
        businessId: sub.businessId, subscriptionId, domain,
        whmPackage: offering.whmPackage ?? null, status: 'pending' as const,
        isTemporary, tempDomain: holding,
      }));
    } catch (err) {
      if (isDuplicateKey(err)) {
        return { outcome: 'skipped', detail: 'This subscription already has a hosting account.' };
      }
      return done('failed', `Could not claim this subscription, so nothing was created: ${
        err instanceof Error ? err.message : String(err)}`);
    }
  }

  const finish = async (status: 'active' | 'failed' | 'dry-run', detail: string, username?: string) => {
    await db.update(hostingAccounts).set({ status, detail, ...(username ? { username } : {}) })
      .where(tenantWhere(hostingAccounts, accountId, eq(hostingAccounts.subscriptionId, subscriptionId)));
  };

  // A dry run never contacts the server, so it must not need working credentials to
  // be useful. This is the check people run BEFORE the setup is finished, to see
  // which clients and domains would be picked up.
  if (!settings.live) {
    const where = isTemporary ? `${domain} (holding address, their own domain comes later)` : domain;
    await finish('dry-run', `Would have created ${username} for ${where}${offering.whmPackage ? ` on package ${offering.whmPackage}` : ''}.`, username);
    return done('dry-run',
      `Dry run: would have created cPanel account ${username} for ${where}. Nothing was created. Switch on live provisioning when this looks right.`,
      { username, isTemporary });
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

  // The reserved-name list here will never match a given server's exactly, and a
  // customer should not be stranded because of a name we could have simply changed.
  // So a refusal ON THE NAME is retried with a different one; anything else is a
  // real failure and reported as it stands.
  let res = await createAccount(creds, {
    username, domain, password, plan: offering.whmPackage, contactEmail: email,
  });
  for (let attempt = 1; attempt <= 3 && !res.ok && isReservedRejection(res.message); attempt++) {
    const rejected = username;
    username = usernameFor(domain, (u) => u === rejected || u === username);
    username = `k${attempt}${username}`.slice(0, 16);
    res = await createAccount(creds, {
      username, domain, password, plan: offering.whmPackage, contactEmail: email,
    });
  }

  if (!res.ok) {
    await finish('failed', res.message, username);
    return done('failed', res.message, { username });
  }

  await finish('active', `Created ${username} for ${domain}.`, username);

  // A holding address is a start, not the end. They still need their own domain,
  // so the request goes out alongside the welcome rather than waiting for somebody
  // to remember. Their hosting works in the meantime, which is the whole point.
  if (isTemporary) await requestDomain(accountId, sub).catch(() => false);

  // The password exists only in this message. If it does not arrive, WHM resets it;
  // that is a better trade than keeping every client's hosting password recoverable.
  if (email) {
    await sendWelcome(accountId, sub.businessId, email, {
      domain, username, password, host: creds.host, clientName, isTemporary,
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

/**
 * The email that lets them actually start.
 *
 * Two versions, because the situations are genuinely different. With their own
 * domain it is "here is your login and your site is at yourdomain.co.za". On a
 * holding address it is "here is your login, your site is at this temporary
 * address, and here is what happens when you have your own domain". Sending the
 * first version for the second case is how you get a support call an hour later
 * asking why their domain does not work.
 */

/**
 * A new cPanel password, on demand.
 *
 * Provisioning generates the password, emails it to the client, and keeps
 * nothing: storing every client's hosting password is a liability with no
 * upside. The cost of that decision is "what are the logins?" a month later.
 * This is the answer: WHM sets a fresh password, it is returned ONCE for the
 * admin to read, and (when asked) the same credentials email the client got on
 * day one goes out again with it. Recorded like every other hosting action.
 */
export async function resetHostingPassword(
  accountId: number, hostingAccountId: number, opts: { emailClient: boolean },
): Promise<{ ok: boolean; message: string; username?: string; password?: string; emailedTo?: string | null }> {
  const [row] = await db.select().from(hostingAccounts)
    .where(tenantWhere(hostingAccounts, accountId, eq(hostingAccounts.id, hostingAccountId))).limit(1);
  if (!row) return { ok: false, message: 'Hosting account not found.' };
  if (!row.username) return { ok: false, message: 'This account has no cPanel username recorded, so there is nothing to reset.' };
  if (row.status !== 'active' && row.status !== 'suspended') {
    return { ok: false, message: `This account is ${row.status}; there is no live cPanel account to reset.` };
  }

  const settings = await hostingSettingsFor(accountId, row.businessId);
  const creds = settings ? credsOf(settings) : null;
  if (!creds) return { ok: false, message: 'No hosting server is configured for this business.' };
  if (!settings!.live) return { ok: false, message: 'Hosting is in dry run; nothing exists on the server to reset.' };

  const password = generatePassword();
  const res = await setAccountPassword(creds, row.username, password);
  if (!res.ok) return { ok: false, message: res.message };

  // Who to tell: the client on the subscription behind this account, if any.
  let emailedTo: string | null = null;
  if (opts.emailClient && row.subscriptionId) {
    const [sub] = await db.select({ folderId: subscriptions.folderId }).from(subscriptions)
      .where(tenantWhere(subscriptions, accountId, eq(subscriptions.id, row.subscriptionId))).limit(1);
    const email = sub ? await billingEmailFor(accountId, sub.folderId) : null;
    if (email) {
      const clientName = sub ? await clientNameFor(accountId, sub.folderId) : 'there';
      await sendWelcome(accountId, row.businessId, email, {
        domain: row.domain, username: row.username, password, host: creds.host,
        clientName, isTemporary: row.isTemporary,
      }).catch(() => { /* the reset stands either way; recorded below */ });
      emailedTo = email;
    }
  }

  await db.insert(events).values({
    accountId, businessId: row.businessId, name: 'hosting.provision',
    payload: { hostingAccountId, username: row.username, domain: row.domain },
    results: [{
      handler: 'hosting.password-reset',
      outcome: `Password reset for ${row.username}${emailedTo ? `, new login emailed to ${emailedTo}` : ', shown to the admin only'}.`,
      ok: true,
    }],
  }).catch(() => { /* diagnostics never block the reset */ });

  return {
    ok: true,
    message: `New password set for ${row.username}.${emailedTo ? ` Emailed to ${emailedTo}.` : ''}`,
    username: row.username, password, emailedTo,
  };
}

export async function sendWelcome(
  accountId: number, businessId: number | null, to: string,
  d: {
    domain: string; username: string; password: string; host: string;
    clientName: string; isTemporary?: boolean;
  },
): Promise<void> {
  const brand = await emailBrandFor(accountId, businessId);
  const cpanel = `https://${d.host}:2083`;

  const content = d.isTemporary
    ? {
      heading: 'Your hosting is ready',
      body: [
        `Hi ${d.clientName},`,
        'Your hosting is set up and you can start building right now, using the temporary address below. You do not have to wait for a domain.',
        'When you have your own domain, tell us and we will move your site onto it. Nothing you build in the meantime is lost.',
        'Please change the password after you first sign in.',
      ],
      facts: [
        ['Temporary address', `http://${d.domain}`] as [string, string],
        ['Username', d.username] as [string, string],
        ['Password', d.password] as [string, string],
        ['Control panel', cpanel] as [string, string],
      ],
      note: 'The temporary address is ours, not yours, so use it for building rather than giving it to customers. It stops working once your own domain is live.',
    }
    : {
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
        ['Control panel', cpanel] as [string, string],
      ],
      note: 'If your domain is not pointing at us yet, the site will only appear once its nameservers have been updated.',
    };

  await sendBusinessMail({
    accountId, businessId, purpose: 'general', to,
    subject: d.isTemporary ? 'Your hosting is ready to use' : `Hosting for ${d.domain} is ready`,
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
      // A hosting row whose subscription was deleted (subscription_id nulled by the
      // FK) has no billing cycle to judge overdue against; leave it for manual teardown.
      if (acct.subscriptionId == null) continue;

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
  const [sub] = acct.subscriptionId != null
    ? await db.select({ folderId: subscriptions.folderId }).from(subscriptions)
      .where(eq(subscriptions.id, acct.subscriptionId)).limit(1)
    : [undefined];
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
  // Money arriving against a cancelled plan does not switch the site back on. The
  // sweep would never suspend it a second time, since a cancelled subscription
  // raises no more invoices to fall overdue, so this would be hosting served free
  // and indefinitely off the back of one late payment.
  const [sub] = await db.select({ status: subscriptions.status }).from(subscriptions)
    .where(tenantWhere(subscriptions, accountId, eq(subscriptions.id, subscriptionId))).limit(1);
  if (!sub || sub.status === 'canceled') return;

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

/**
 * Ask the client what domain their hosting is for.
 *
 * Sent once per subscription, not on every payment, because a renewal should not
 * re-ask a question already answered or already pending. Creating a portal login
 * for them here is deliberate: they have just bought hosting, so they need the
 * portal anyway, and a link that lands on a sign-in wall is a link nobody follows.
 */
async function requestDomain(
  accountId: number, sub: typeof subscriptions.$inferSelect,
): Promise<boolean> {
  if (sub.domainRequestedAt) return true;   // already asked, still waiting

  const email = await billingEmailFor(accountId, sub.folderId);
  if (!email) return false;

  const { ensurePortalUser, issueLoginTokenForUser } = await import('./portalAuth.js');
  // Issue the link for the exact portal we just ensured, not by email: this same
  // address may be a client of another business too, and a by-email link could sign
  // them into that other company's portal instead of the hosting they just bought.
  const portalUserId = await ensurePortalUser(accountId, sub.businessId, sub.folderId, email);
  const issued = portalUserId ? await issueLoginTokenForUser(portalUserId) : null;

  const brand = await emailBrandFor(accountId, sub.businessId);
  const link = issued
    ? `${appUrl()}/?portal=enter&token=${encodeURIComponent(issued.raw)}`
    : `${appUrl()}/?portal=1`;
  const content = {
    heading: 'One thing before we set up your hosting',
    body: [
      `Hi ${await clientNameFor(accountId, sub.folderId)},`,
      'Thank you, your hosting is paid for. We just need to know which domain it is for.',
      'Tell us below and it will be set up straight away, usually within a minute.',
    ],
    button: { label: 'Enter your domain', url: link },
    note: 'If you have not registered a domain yet, reply to this email and we will help.',
  };
  await sendBusinessMail({
    accountId, businessId: sub.businessId, purpose: 'general', to: email,
    subject: 'Which domain is your hosting for?',
    text: renderEmailText(brand, content),
    html: renderEmail(brand, content),
  });

  await db.update(subscriptions).set({ domainRequestedAt: new Date() })
    .where(tenantWhere(subscriptions, accountId, eq(subscriptions.id, sub.id)));
  return true;
}

/**
 * A domain the client typed. Rejects the things people actually paste: a full URL,
 * a path, an email address, a bare hostname with no dot.
 */
export function cleanDomain(raw: string): string | null {
  const d = raw.trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/?#].*$/, '')
    .replace(/\.$/, '');
  if (!d || d.includes('@') || d.includes(' ')) return null;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d)) return null;
  if (d.length > 190) return null;
  return d;
}

/**
 * Move an account from its holding address onto the customer's own domain.
 *
 * Called when a client who was set up on a holding address finally tells us their
 * real domain. Deliberately separate from provisioning: nothing is created, an
 * existing account is renamed, and the two failure modes are nothing alike.
 *
 * Honest about its limits. If WHM refuses, the record says so and says a person has
 * to finish it, rather than flipping to "done" and leaving a customer whose site
 * quietly still answers on the old address. And it never pretends the customer's
 * site content followed: a WordPress install still has the old address baked into
 * its settings, which is a real thing somebody has to fix.
 */
export async function switchToRealDomain(
  accountId: number, subscriptionId: number, realDomain: string,
): Promise<{ ok: boolean; message: string }> {
  const [acct] = await db.select().from(hostingAccounts)
    .where(tenantWhere(hostingAccounts, accountId, eq(hostingAccounts.subscriptionId, subscriptionId)))
    .limit(1);
  if (!acct) return { ok: false, message: 'No hosting account for this subscription yet.' };
  if (!acct.username) return { ok: false, message: 'That account has no cPanel username yet.' };
  if (!acct.isTemporary) {
    return { ok: false, message: 'That account is already on its own domain.' };
  }

  const settings = await hostingSettingsFor(accountId, acct.businessId);
  if (!settings?.enabled) return { ok: false, message: 'Hosting is off for this business.' };

  const record = async (ok: boolean, detail: string, patch: Record<string, unknown> = {}) => {
    await db.update(hostingAccounts).set({ detail, ...patch })
      .where(tenantWhere(hostingAccounts, accountId, eq(hostingAccounts.id, acct.id)));
    await note(accountId, acct.businessId, ok ? 'created' : 'failed', detail, {
      subscriptionId, username: acct.username, from: acct.tempDomain, to: realDomain,
    });
  };

  // In dry run nothing on the server changes, but the intent is still written down,
  // because "who is waiting to be moved across" is a list worth reading.
  if (!settings.live) {
    await record(true,
      `Dry run: would have moved ${acct.username} from ${acct.domain} to ${realDomain}. Nothing was changed.`);
    return { ok: true, message: 'Noted. Your domain will be set up shortly.' };
  }

  const creds = credsOf(settings);
  if (!creds) {
    await record(false, 'WHM credentials are incomplete, so the domain could not be changed.');
    return { ok: false, message: 'We have your domain and will finish setting it up shortly.' };
  }

  const res = await changePrimaryDomain(creds, acct.username, realDomain);
  if (!res.ok) {
    // The customer must not be told it worked. Equally they should not be shown a
    // cPanel error, so the message they see differs from the one recorded.
    await record(false,
      `Could not move ${acct.username} onto ${realDomain}: ${res.message}. The account is still on ${acct.domain}. Change the primary domain in WHM and mark it here.`);
    return { ok: false, message: 'We have your domain. Someone is finishing the setup and will be in touch.' };
  }

  await record(true, `Moved ${acct.username} from ${acct.domain} to ${realDomain}.`, {
    domain: realDomain, isTemporary: false, domainSwitchedAt: new Date(), status: 'active',
  });
  return { ok: true, message: 'Your domain is set up. It can take a few hours for it to work everywhere.' };
}

/**
 * Suspend or restore every hosting account attached to a subscription.
 *
 * Cancelling or pausing a subscription used to touch only the subscription row, so
 * the cPanel site ran free forever and, because a cancelled sub raises no invoices,
 * the overdue-suspension sweep never reached it either. This is what makes "cancel"
 * actually stop the service. Best-effort and never throws: a WHM outage must not
 * block the status change the operator asked for; the hosting row keeps its old
 * status and the next manual action (or the sweep) can retry.
 */
export interface LiveHosting {
  hostingAccountId: number;
  subscriptionId: number;
  folderId: number;
  domain: string;
  username: string | null;
  status: string;
}

/**
 * Hosting rows that stand for something REAL on the WHM box.
 *
 * The guard in front of every path that can destroy a subscription. Deleting a
 * subscription nulls hosting_accounts.subscription_id (the FK is set-null), and the
 * overdue sweep then skips that row forever, so the site keeps serving, keeps using
 * a server slot, and can never be invoiced again because the subscription that
 * invoiced it is gone. The subscription delete route already suspends first for
 * exactly this reason; the folder and offering cascades did not, so they could
 * silently strand a live customer site.
 *
 * 'failed' and 'dry-run' are excluded deliberately: nothing exists on the server for
 * those, and provisioning reuses those rows. 'pending' counts, because it may be
 * mid-provision and become real a second later.
 */
export async function liveHostingForSubscriptions(
  accountId: number, subscriptionIds: number[],
): Promise<LiveHosting[]> {
  if (!subscriptionIds.length) return [];
  return db.select({
    hostingAccountId: hostingAccounts.id, subscriptionId: subscriptions.id,
    folderId: subscriptions.folderId, domain: hostingAccounts.domain,
    username: hostingAccounts.username, status: hostingAccounts.status,
  }).from(hostingAccounts)
    .innerJoin(subscriptions, eq(subscriptions.id, hostingAccounts.subscriptionId))
    // tenantWhere scopes one table, so the joined table is scoped explicitly.
    .where(tenantWhere(hostingAccounts, accountId,
      eq(subscriptions.accountId, accountId),
      inArray(subscriptions.id, subscriptionIds),
      inArray(hostingAccounts.status, ['pending', 'active', 'suspended'])));
}

/**
 * Anything live on the server anywhere in this workspace.
 *
 * Its own query, without the subscription join, because deleting a WORKSPACE is the
 * one cascade that destroys the hosting_accounts rows themselves rather than nulling
 * their link. That leaves a real cPanel account with no record anywhere in Klippy,
 * not even the orphan row on the Hosting screen, so no query can ever find it again.
 */
export async function liveHostingForAccount(accountId: number): Promise<LiveHosting[]> {
  return db.select({
    hostingAccountId: hostingAccounts.id, subscriptionId: hostingAccounts.subscriptionId,
    folderId: hostingAccounts.id, domain: hostingAccounts.domain,
    username: hostingAccounts.username, status: hostingAccounts.status,
  }).from(hostingAccounts)
    .where(tenantWhere(hostingAccounts, accountId,
      inArray(hostingAccounts.status, ['pending', 'active', 'suspended']))) as Promise<LiveHosting[]>;
}

/** The same question asked through the clients that own the subscriptions. */
export async function liveHostingForFolders(
  accountId: number, folderIds: number[],
): Promise<LiveHosting[]> {
  if (!folderIds.length) return [];
  const subs = await db.select({ id: subscriptions.id }).from(subscriptions)
    .where(tenantWhere(subscriptions, accountId, inArray(subscriptions.folderId, folderIds)));
  return liveHostingForSubscriptions(accountId, subs.map((s) => s.id));
}

/**
 * Any standing money arrangement under these folders, hosting or not.
 *
 * The trash purge held back a client with LIVE HOSTING and nothing else, which left a
 * real hole: a client on a monthly retainer with no server had no guard at all. Trash
 * them, wait past the thirty days, and the folder delete cascaded through
 * subscriptions.folderId and took the arrangement with it, including the negotiated
 * price, the saved card token and the debit consent behind it. Nothing was said and
 * there was nothing to restore from.
 *
 * A hold is not a leak, because a CANCELLED or PAUSED arrangement is not counted. The
 * trash still empties; it just cannot empty a client who is still being billed.
 */
export async function liveArrangementsForFolders(
  accountId: number, folderIds: number[],
): Promise<{ id: number; folderId: number }[]> {
  if (!folderIds.length) return [];
  return db.select({ id: subscriptions.id, folderId: subscriptions.folderId })
    .from(subscriptions)
    .where(tenantWhere(subscriptions, accountId,
      inArray(subscriptions.folderId, folderIds),
      eq(subscriptions.status, 'active')));
}

export async function suspendForSubscription(
  accountId: number, subscriptionId: number, suspend: boolean, reason = 'Subscription cancelled',
): Promise<void> {
  try {
    const rows = await db.select().from(hostingAccounts)
      .where(tenantWhere(hostingAccounts, accountId, eq(hostingAccounts.subscriptionId, subscriptionId)));
    for (const row of rows) {
      // Already in the target state, or never provisioned: nothing to do.
      if (!row.username) continue;
      if (suspend && row.status === 'suspended') continue;
      if (!suspend && row.status === 'active') continue;
      await setSuspended(accountId, row.id, suspend, reason).catch(() => {});
    }
  } catch {
    /* never let hosting side-effects fail the subscription change */
  }
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
