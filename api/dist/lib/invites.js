import { randomBytes, createHash } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { invitations, accounts, users } from '../db/schema.js';
import { sendMail, appUrl, emailBrandFor } from './mailer.js';
import { renderEmail, renderEmailText } from './emailLayout.js';
/**
 * Inviting someone who already has a Klippy login.
 *
 * The rule this exists to serve: a login that is not already in this workspace cannot
 * be pulled into it by an admin. Only the person holding that login can agree to
 * join. Without that rule, adding a colleague by email was the first half of an
 * account takeover, because the password reset on PATCH /users only checks for a
 * membership in this workspace, and adding them created exactly that.
 *
 * Everything here follows the same shape as the portal's sign-in links: a random
 * token, only its hash stored, a short life, one use, and asking again retires the
 * previous one so a stale email cannot still let someone in.
 */
const TTL_DAYS = 7;
/** How long between invitation emails to one address, so this is not a mail cannon. */
const MIN_GAP_SECONDS = 60;
const hashToken = (raw) => createHash('sha256').update(raw).digest('hex');
/**
 * Create (or replace) an invitation for an email address.
 *
 * Returns null when one was issued moments ago, so a double-clicked button does not
 * send twice. The caller answers the same either way, which keeps this from being a
 * way to test whether an address is already invited.
 */
export async function issueInvitation(accountId, email, role, createdBy) {
    const now = new Date();
    const [recent] = await db.select({ createdAt: invitations.createdAt })
        .from(invitations)
        .where(and(eq(invitations.accountId, accountId), eq(invitations.email, email), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)))
        .orderBy(invitations.id)
        .limit(1);
    if (recent?.createdAt && now.getTime() - recent.createdAt.getTime() < MIN_GAP_SECONDS * 1000) {
        return null;
    }
    // Retire anything outstanding for this address first. Otherwise every re-invite
    // leaves another working key in another inbox.
    await db.update(invitations).set({ revokedAt: now })
        .where(and(eq(invitations.accountId, accountId), eq(invitations.email, email), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)));
    const raw = randomBytes(32).toString('base64url');
    const ins = await db.insert(invitations).values({
        accountId, email, role,
        tokenHash: hashToken(raw),
        expiresAt: new Date(now.getTime() + TTL_DAYS * 86_400_000),
        createdBy,
    });
    return { id: Number(ins[0].insertId), raw };
}
export async function sendInvitationEmail(accountId, email, raw, invitedByName) {
    const [acct] = await db.select({ name: accounts.name }).from(accounts)
        .where(eq(accounts.id, accountId)).limit(1);
    const workspace = acct?.name || 'a Klippy workspace';
    const link = `${appUrl()}/?invite=${encodeURIComponent(raw)}`;
    const content = {
        heading: `Join ${workspace}`,
        body: [
            `${invitedByName || 'Someone'} has invited you to join ${workspace} on Klippy.`,
            'You already have a Klippy login, so nothing about it changes. Sign in as yourself and this workspace will be added to the ones you can switch between.',
            `The invitation expires in ${TTL_DAYS} days.`,
        ],
        cta: { label: 'Accept the invitation', url: link },
        footer: 'If you were not expecting this, ignore it. Nothing happens until you accept, and your password is not affected either way.',
    };
    // The workspace's own branding, so the invitation looks like it came from the
    // company doing the inviting rather than from a tool the person has never heard of.
    const brand = await emailBrandFor(accountId, null);
    await sendMail(email, `You have been invited to ${workspace}`, renderEmailText(brand, content), renderEmail(brand, content)).catch(() => { });
}
/**
 * Turn an invitation into a membership.
 *
 * Two things are checked beyond the token itself, and both matter. The invitation
 * must still be live, and the person redeeming it must be signed in AS the address it
 * was sent to. Without the second check a leaked link would let whoever found it join
 * a workspace they were never offered.
 */
export async function acceptInvitation(rawToken, userId) {
    const [inv] = await db.select().from(invitations)
        .where(and(eq(invitations.tokenHash, hashToken(rawToken)), isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, new Date()))).limit(1);
    if (!inv)
        return { ok: false, message: 'That invitation is not valid any more. Ask for a new one.' };
    const [me] = await db.select({ email: users.email }).from(users)
        .where(eq(users.id, userId)).limit(1);
    if (!me)
        return { ok: false, message: 'Sign in first.' };
    if (me.email.toLowerCase() !== inv.email.toLowerCase()) {
        return {
            ok: false,
            message: `That invitation was sent to ${inv.email}. Sign in with that address to accept it.`,
        };
    }
    // Claim it before granting anything: a conditional update means two clicks on the
    // same link cannot both succeed, however close together they arrive.
    const claim = await db.update(invitations).set({ acceptedAt: new Date() })
        .where(and(eq(invitations.id, inv.id), isNull(invitations.acceptedAt)));
    if (!claim[0].affectedRows) {
        return { ok: false, message: 'That invitation has already been used.' };
    }
    return { ok: true, accountId: inv.accountId, role: inv.role };
}
//# sourceMappingURL=invites.js.map