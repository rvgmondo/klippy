import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { documents, events, folders, hostingAccounts, hostingSettings, offerings, subscriptions, } from '../db/schema.js';
import { tenantWhere, withTenant } from './tenant.js';
import { decryptSecret } from './secretbox.js';
import { emailBrandFor, sendBusinessMail } from './mailer.js';
import { renderEmail, renderEmailText } from './emailLayout.js';
import { accountExists, createAccount, generatePassword, suspendAccount, unsuspendAccount, usernameFor, } from './whm.js';
async function note(accountId, businessId, outcome, detail, extra) {
    await db.insert(events).values({
        accountId, businessId, name: 'hosting.provision',
        payload: { outcome, detail, ...extra },
        results: [{ handler: 'hosting.provision', outcome: detail, ok: outcome === 'created' || outcome === 'dry-run' }],
    }).catch(() => { });
}
/** The WHM server for a business: its own, or the workspace one. Same rule as payments. */
export async function hostingSettingsFor(accountId, businessId) {
    if (businessId) {
        const [own] = await db.select().from(hostingSettings)
            .where(and(eq(hostingSettings.accountId, accountId), eq(hostingSettings.businessId, businessId)))
            .limit(1);
        if (own)
            return own;
    }
    const [ws] = await db.select().from(hostingSettings)
        .where(and(eq(hostingSettings.accountId, accountId), eq(hostingSettings.businessId, 0)))
        .limit(1);
    return ws ?? null;
}
export function credsOf(row) {
    if (!row.whmHost || !row.whmTokenEnc)
        return null;
    try {
        return {
            host: row.whmHost,
            user: row.whmUser || 'root',
            token: decryptSecret(row.whmTokenEnc),
            allowSelfSigned: row.allowSelfSigned,
        };
    }
    catch {
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
export async function onInvoicePaid(accountId, documentId) {
    try {
        const [doc] = await db.select({
            id: documents.id, businessId: documents.businessId, number: documents.number,
            subscriptionId: documents.subscriptionId, clientEmail: documents.clientEmail,
            clientName: documents.clientName, folderId: documents.folderId,
        }).from(documents)
            .where(tenantWhere(documents, accountId, eq(documents.id, documentId))).limit(1);
        if (!doc?.subscriptionId)
            return;
        await provisionSubscription(accountId, doc.subscriptionId, doc.number);
    }
    catch {
        // Provisioning must never undo a payment. A failure is recorded by the code
        // below; anything escaping that is swallowed here on purpose.
    }
}
export async function provisionSubscription(accountId, subscriptionId, invoiceNumber = '') {
    const [sub] = await db.select().from(subscriptions)
        .where(tenantWhere(subscriptions, accountId, eq(subscriptions.id, subscriptionId))).limit(1);
    if (!sub)
        return { outcome: 'skipped', detail: 'Subscription no longer exists.' };
    const [offering] = await db.select().from(offerings)
        .where(tenantWhere(offerings, accountId, eq(offerings.id, sub.offeringId))).limit(1);
    // The ordinary case: this subscription does not set anything up. Returns before
    // touching settings or the network.
    if (!offering || offering.provisioning !== 'cpanel') {
        return { outcome: 'skipped', detail: 'Nothing to provision for this offering.' };
    }
    const done = async (outcome, detail, extra = {}) => {
        await note(accountId, sub.businessId, outcome, detail, {
            subscriptionId, domain: sub.domain, number: invoiceNumber, ...extra,
        });
        return { outcome, detail };
    };
    const settings = await hostingSettingsFor(accountId, sub.businessId);
    if (!settings?.enabled)
        return done('skipped', 'Hosting provisioning is off for this business.');
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
            whmPackage: offering.whmPackage ?? null, status: 'pending',
        }));
    }
    catch {
        return { outcome: 'skipped', detail: 'This subscription already has a hosting account.' };
    }
    const finish = async (status, detail, username) => {
        await db.update(hostingAccounts).set({ status, detail, ...(username ? { username } : {}) })
            .where(tenantWhere(hostingAccounts, accountId, eq(hostingAccounts.subscriptionId, subscriptionId)));
    };
    let username = usernameFor(domain);
    // A dry run never contacts the server, so it must not need working credentials to
    // be useful. This is the check people run BEFORE the setup is finished, to see
    // which clients and domains would be picked up.
    if (!settings.live) {
        await finish('dry-run', `Would have created ${username} for ${domain}${offering.whmPackage ? ` on package ${offering.whmPackage}` : ''}.`, username);
        return done('dry-run', `Dry run: would have created cPanel account ${username} for ${domain}. Nothing was created. Switch on live provisioning when this looks right.`, { username });
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
        }).catch(() => { });
    }
    return done('created', `Created cPanel account ${username} for ${domain}${email ? `, credentials emailed to ${email}` : '. No billing email on file, so the login was NOT sent: set it in WHM.'}`, { username, emailed: !!email });
}
async function billingEmailFor(accountId, folderId) {
    if (!folderId)
        return null;
    const [f] = await db.select({ email: folders.billingEmail }).from(folders)
        .where(tenantWhere(folders, accountId, eq(folders.id, folderId))).limit(1);
    return f?.email ?? null;
}
async function clientNameFor(accountId, folderId) {
    if (!folderId)
        return 'there';
    const [f] = await db.select({ name: folders.name }).from(folders)
        .where(tenantWhere(folders, accountId, eq(folders.id, folderId))).limit(1);
    return f?.name ?? 'there';
}
async function sendWelcome(accountId, businessId, to, d) {
    const brand = await emailBrandFor(accountId, businessId);
    const content = {
        heading: `Your hosting for ${d.domain} is ready`,
        body: [
            `Hi ${d.clientName},`,
            'Your hosting account is set up and ready to use. Your login details are below.',
            'Please change the password after you first sign in, and keep this email somewhere safe until you have.',
        ],
        facts: [
            ['Domain', d.domain],
            ['Username', d.username],
            ['Password', d.password],
            ['Control panel', `https://${d.host}:2083`],
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
/** Suspend or restore one account by hand, from the hosting screen. */
export async function setSuspended(accountId, hostingAccountId, suspend, reason = 'Unpaid') {
    const [row] = await db.select().from(hostingAccounts)
        .where(tenantWhere(hostingAccounts, accountId, eq(hostingAccounts.id, hostingAccountId))).limit(1);
    if (!row)
        return { ok: false, message: 'Hosting account not found.' };
    if (!row.username)
        return { ok: false, message: 'This record has no cPanel username yet.' };
    const settings = await hostingSettingsFor(accountId, row.businessId);
    if (!settings?.enabled)
        return { ok: false, message: 'Hosting is off for this business.' };
    const creds = settings && credsOf(settings);
    if (!creds)
        return { ok: false, message: 'WHM credentials are incomplete.' };
    if (!settings.live) {
        return { ok: false, message: 'Live provisioning is off, so nothing was changed on the server.' };
    }
    const res = suspend
        ? await suspendAccount(creds, row.username, reason)
        : await unsuspendAccount(creds, row.username);
    if (res.ok) {
        await db.update(hostingAccounts).set({ status: suspend ? 'suspended' : 'active', detail: res.message })
            .where(tenantWhere(hostingAccounts, accountId, eq(hostingAccounts.id, hostingAccountId)));
        await note(accountId, row.businessId, 'created', `${suspend ? 'Suspended' : 'Restored'} ${row.username} (${row.domain}).`, { subscriptionId: row.subscriptionId });
    }
    return { ok: res.ok, message: res.message };
}
//# sourceMappingURL=hosting.js.map