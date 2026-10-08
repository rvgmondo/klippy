import { and, eq, gte, inArray, isNull, lt, lte, ne } from 'drizzle-orm';
import { db } from '../db/client.js';
import { accounts, businesses, dealActivities, documents, expenses, folders, memberships, offerings, payments, sales, subscriptions, users, } from '../db/schema.js';
import { formatMoney } from './currency.js';
import { sendBusinessMail, sendMail, emailBrandFor, appUrl } from './mailer.js';
import { renderEmail, renderEmailText } from './emailLayout.js';
import { balancesFor, CHASE_MIN } from './balances.js';
import { IMPORTED_SEQ_BASE } from './numbering.js';
import { addDays } from './billing.js';
import { chargeFor } from './mrr.js';
import { buildStatement } from './statement.js';
import { renderStatementPdf } from './pdf.js';
import { quoteLinkFor } from '../routes/quotes.js';
import { tenantWhere, withTenant } from './tenant.js';
/**
 * Three things that happen on their own, so nobody has to remember them:
 *
 *  - quote follow-ups: one polite nudge on a quote nobody has answered
 *  - monthly statements: on the 1st, each client who owes gets their statement
 *  - the month in money: on the 1st, the owner gets last month's figures
 *
 * The first two email CLIENTS, so they are off until a business switches them on.
 * The third goes only to owners and admins who have the digest on.
 */
const todayStr = () => new Date().toISOString().slice(0, 10);
const round = (n) => Math.round(n * 100) / 100;
const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const sayDate = (d) => `${Number(d.slice(8, 10))} ${MONTH[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
// ---- quote follow-ups --------------------------------------------------------------------
/**
 * Quotes sent, unanswered, still valid, and older than the business's follow-up
 * days get one short email with the accept link. Once: the quote is stamped before
 * the email goes, and un-stamped if it fails, so a retry tomorrow is possible but a
 * second nudge never is.
 */
export async function runQuoteFollowUps(today = todayStr()) {
    const rows = await db.select({
        id: documents.id, accountId: documents.accountId, businessId: documents.businessId, number: documents.number,
        clientName: documents.clientName, clientEmail: documents.clientEmail, folderId: documents.folderId,
        issueDate: documents.issueDate, dueDate: documents.dueDate, total: documents.total, currency: documents.currency,
        dealId: documents.dealId, days: businesses.quoteFollowUpDays,
    }).from(documents)
        .innerJoin(businesses, and(eq(businesses.id, documents.businessId), eq(businesses.accountId, documents.accountId)))
        .where(and(eq(documents.type, 'quote'), eq(documents.status, 'sent'), isNull(documents.decision), isNull(documents.quoteNudgedAt), lt(documents.seq, IMPORTED_SEQ_BASE)));
    let sent = 0;
    let noEmail = 0;
    let failed = 0;
    for (const q of rows) {
        if (!q.days || q.issueDate > addDays(today, -q.days))
            continue;
        if (q.dueDate && q.dueDate < today)
            continue; // expired: a nudge would invite a stale price
        const [client] = q.folderId ? await db.select({ email: folders.billingEmail, name: folders.name }).from(folders)
            .where(and(eq(folders.id, q.folderId), eq(folders.accountId, q.accountId), isNull(folders.deletedAt))).limit(1) : [];
        const to = client?.email || q.clientEmail;
        if (!to) {
            noEmail++;
            continue;
        }
        const claim = await db.update(documents).set({ quoteNudgedAt: new Date() })
            .where(and(eq(documents.id, q.id), eq(documents.accountId, q.accountId), isNull(documents.quoteNudgedAt)));
        if (!claim[0].affectedRows)
            continue;
        const link = quoteLinkFor(q.id);
        const brand = await emailBrandFor(q.accountId, q.businessId);
        const content = {
            heading: `Quote ${q.number}`,
            body: [
                `Hi ${client?.name ?? q.clientName},`,
                `Just following up on the quote we sent on ${sayDate(q.issueDate)}. If anything in it needs changing, reply to this email and we will sort it out.`,
                ...(q.dueDate ? [`It is valid until ${sayDate(q.dueDate)}.`] : []),
            ],
            facts: [['Total', formatMoney(q.total, q.currency)]],
            ...(link ? { button: { label: 'View and accept this quote', url: link } } : {}),
        };
        try {
            await sendBusinessMail({
                accountId: q.accountId, businessId: q.businessId, purpose: 'invoice', to,
                subject: `Following up on quote ${q.number}`,
                text: renderEmailText(brand, content), html: renderEmail(brand, content),
            });
            sent++;
            if (q.dealId) {
                await db.insert(dealActivities).values(withTenant(q.accountId, {
                    dealId: q.dealId, kind: 'email', body: `Klippy followed up on quote ${q.number}`, occurredAt: new Date(), createdBy: null,
                })).catch(() => { });
            }
        }
        catch {
            failed++;
            await db.update(documents).set({ quoteNudgedAt: null }).where(and(eq(documents.id, q.id), eq(documents.accountId, q.accountId)));
        }
    }
    return `${sent} quote follow-up(s) sent` + (noEmail ? `, ${noEmail} skipped with no email` : '') + (failed ? `, ${failed} FAILED` : '');
}
// ---- monthly statements --------------------------------------------------------------------
/**
 * On the 1st: for each business that has it on, every client who owes money on an
 * invoice raised in Klippy gets their statement, one per currency. Clients whose
 * reminders are paused are left alone, and so is debt that is only old-system
 * history still being checked.
 */
export async function runMonthlyStatements(today = todayStr()) {
    if (today.slice(8, 10) !== '01')
        return 'Not the 1st; nothing sent.';
    const bizRows = await db.select({ id: businesses.id, accountId: businesses.accountId })
        .from(businesses).where(eq(businesses.monthlyStatements, true));
    let sent = 0;
    let noEmail = 0;
    let failed = 0;
    for (const b of bizRows) {
        const inv = await db.select({
            id: documents.id, total: documents.total, folderId: documents.folderId, currency: documents.currency,
        }).from(documents)
            .where(tenantWhere(documents, b.accountId, eq(documents.businessId, b.id), eq(documents.type, 'invoice'), eq(documents.status, 'sent'), lt(documents.seq, IMPORTED_SEQ_BASE)));
        const bal = await balancesFor(b.accountId, inv);
        const owing = new Map();
        for (const i of inv) {
            if (i.folderId == null || (bal.get(i.id)?.outstanding ?? Number(i.total)) < CHASE_MIN)
                continue;
            owing.set(`${i.folderId}:${i.currency}`, { folderId: i.folderId, currency: i.currency });
        }
        for (const { folderId, currency } of owing.values()) {
            const [client] = await db.select({ email: folders.billingEmail, name: folders.name, paused: folders.remindersPaused })
                .from(folders).where(tenantWhere(folders, b.accountId, eq(folders.id, folderId), isNull(folders.deletedAt))).limit(1);
            if (!client || client.paused)
                continue;
            if (!client.email) {
                noEmail++;
                continue;
            }
            try {
                const st = await buildStatement(b.accountId, folderId, { currency });
                if (!st || st.summary.balance < CHASE_MIN)
                    continue;
                const pdf = await renderStatementPdf(b.accountId, st);
                const brand = await emailBrandFor(b.accountId, b.id);
                const content = {
                    heading: 'Your statement of account',
                    body: [
                        `Hi ${client.name},`,
                        'Here is your statement for the month, attached. It lists every invoice and payment, so you can check it against your own records.',
                        `The balance owing is ${formatMoney(st.summary.balance, st.currency)}. If you have paid since, thank you, and please ignore this.`,
                    ],
                };
                await sendBusinessMail({
                    accountId: b.accountId, businessId: b.id, purpose: 'invoice', to: client.email,
                    subject: `Statement of account: ${client.name}`,
                    text: renderEmailText(brand, content), html: renderEmail(brand, content),
                    attachments: [{ filename: pdf.filename, content: pdf.buffer }],
                });
                sent++;
            }
            catch {
                failed++;
            }
        }
    }
    return `${sent} statement(s) sent` + (noEmail ? `, ${noEmail} client(s) with no email` : '') + (failed ? `, ${failed} FAILED` : '');
}
const add = (m, c, v) => { m[c] = (m[c] ?? 0) + v; };
/** What last month looked like, for one workspace. Pure reads; also used by the test. */
export async function monthFigures(accountId, today = todayStr()) {
    const thisStart = `${today.slice(0, 8)}01`;
    const from = addDays(thisStart, -1).slice(0, 8) + '01';
    const to = addDays(thisStart, -1);
    const prevFrom = addDays(from, -1).slice(0, 8) + '01';
    const thisEnd = addDays(addDays(thisStart, 32).slice(0, 8) + '01', -1);
    const [acc] = await db.select({ currency: accounts.currency }).from(accounts).where(eq(accounts.id, accountId)).limit(1);
    const bizCur = new Map((await db.select({ id: businesses.id, currency: businesses.currency }).from(businesses)
        .where(eq(businesses.accountId, accountId))).map((b) => [b.id, b.currency || acc?.currency || 'ZAR']));
    const curOf = (id) => (id != null ? bizCur.get(id) : null) ?? acc?.currency ?? 'ZAR';
    const invoiced = {};
    const received = {};
    const receivedBefore = {};
    const fees = {};
    const taken = {};
    const spent = {};
    for (const r of await db.select({ total: documents.total, currency: documents.currency }).from(documents)
        .where(and(eq(documents.accountId, accountId), eq(documents.type, 'invoice'), ne(documents.status, 'void'), ne(documents.status, 'draft'), gte(documents.issueDate, from), lte(documents.issueDate, to), lt(documents.seq, IMPORTED_SEQ_BASE)))) {
        add(invoiced, r.currency, Number(r.total));
    }
    for (const r of await db.select({ amount: payments.amount, fee: payments.feeAmount, paidOn: payments.paidOn, currency: documents.currency })
        .from(payments).innerJoin(documents, and(eq(documents.id, payments.documentId), eq(documents.accountId, accountId)))
        .where(and(eq(payments.accountId, accountId), gte(payments.paidOn, prevFrom), lte(payments.paidOn, to)))) {
        if (r.paidOn >= from) {
            add(received, r.currency, Number(r.amount));
            if (r.fee != null)
                add(fees, r.currency, Number(r.fee));
        }
        else
            add(receivedBefore, r.currency, Number(r.amount));
    }
    for (const r of await db.select({ gross: sales.gross, fee: sales.fee, currency: sales.currency }).from(sales)
        .where(and(eq(sales.accountId, accountId), gte(sales.occurredAt, new Date(`${from}T00:00:00Z`)), lte(sales.occurredAt, new Date(`${to}T23:59:59Z`))))) {
        add(taken, r.currency, Number(r.gross));
        add(fees, r.currency, Number(r.fee));
    }
    for (const r of await db.select({ amount: expenses.amount, businessId: expenses.businessId }).from(expenses)
        .where(and(eq(expenses.accountId, accountId), gte(expenses.incurredOn, from), lte(expenses.incurredOn, to)))) {
        add(spent, curOf(r.businessId), Number(r.amount));
    }
    // Owed now, by what is really still owed, and who owes the most.
    const open = await db.select({
        id: documents.id, total: documents.total, currency: documents.currency, clientName: documents.clientName,
        folderId: documents.folderId, dueDate: documents.dueDate, seq: documents.seq,
    }).from(documents).where(and(eq(documents.accountId, accountId), eq(documents.type, 'invoice'), eq(documents.status, 'sent')));
    const bal = await balancesFor(accountId, open);
    const owed = {};
    const oldOwed = {};
    const dueThisMonth = {};
    const who = new Map();
    for (const d of open) {
        const left = bal.get(d.id)?.outstanding ?? Number(d.total);
        if (left < CHASE_MIN)
            continue;
        add(owed, d.currency, left);
        if (d.seq >= IMPORTED_SEQ_BASE) {
            add(oldOwed, d.currency, left);
            continue;
        }
        if (d.dueDate && d.dueDate >= thisStart && d.dueDate <= thisEnd)
            add(dueThisMonth, d.currency, left);
        if (d.dueDate && d.dueDate < today) {
            const k = `${d.folderId ?? d.clientName}:${d.currency}`;
            const w = who.get(k) ?? { name: d.clientName, currency: d.currency, amount: 0, oldestDue: null };
            w.amount += left;
            if (!w.oldestDue || d.dueDate < w.oldestDue)
                w.oldestDue = d.dueDate;
            who.set(k, w);
        }
    }
    const topOwing = [...who.values()].sort((a, b) => b.amount - a.amount).slice(0, 5).map((w) => ({ ...w, amount: round(w.amount) }));
    // Subscriptions billing this month, at what each client actually pays.
    const billing = {};
    for (const s of await db.select({ price: subscriptions.price, list: offerings.price, businessId: subscriptions.businessId })
        .from(subscriptions).innerJoin(offerings, and(eq(offerings.id, subscriptions.offeringId), eq(offerings.accountId, accountId)))
        .where(and(eq(subscriptions.accountId, accountId), eq(subscriptions.status, 'active'), gte(subscriptions.nextBillDate, thisStart), lte(subscriptions.nextBillDate, thisEnd)))) {
        add(billing, curOf(s.businessId), chargeFor(s, { price: s.list }));
    }
    const r = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, round(v)]));
    return {
        month: MONTH[Number(from.slice(5, 7)) - 1], from, to,
        invoiced: r(invoiced), received: r(received), receivedBefore: r(receivedBefore), fees: r(fees), taken: r(taken),
        spent: r(spent), owed: r(owed), oldOwed: r(oldOwed), dueThisMonth: r(dueThisMonth), billing: r(billing), topOwing,
    };
}
/** On the 1st, last month's money to each owner and admin who has the digest on. */
export async function runMonthReport(today = todayStr()) {
    if (today.slice(8, 10) !== '01')
        return 'Not the 1st; nothing sent.';
    const people = await db.select({ email: users.email, accountId: memberships.accountId }).from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(and(eq(users.isActive, true), eq(users.dailyDigest, true), eq(memberships.isActive, true), inArray(memberships.role, ['owner', 'admin'])));
    const byAccount = new Map();
    for (const p of people)
        byAccount.set(p.accountId, [...(byAccount.get(p.accountId) ?? []), p.email]);
    let sent = 0;
    for (const [accountId, emails] of byAccount) {
        const f = await monthFigures(accountId, today);
        const curs = [...new Set([...Object.keys(f.invoiced), ...Object.keys(f.received), ...Object.keys(f.spent), ...Object.keys(f.owed), ...Object.keys(f.taken)])];
        if (!curs.length)
            continue; // nothing happened and nothing is owed: no mail
        const many = curs.length > 1;
        const facts = [];
        for (const c of curs) {
            const tag = many ? ` (${c})` : '';
            const m = (v) => formatMoney(v ?? 0, c);
            const inV = f.received[c] ?? 0;
            const before = f.receivedBefore[c] ?? 0;
            const change = before > 0 ? Math.round(((inV - before) / before) * 100) : null;
            facts.push([`Invoiced${tag}`, m(f.invoiced[c])]);
            facts.push([`Money in${tag}`, m(inV) + (change != null ? `, ${change >= 0 ? 'up' : 'down'} ${Math.abs(change)}% on the month before` : '')]);
            if (f.taken[c])
                facts.push([`Over the counter${tag}`, m(f.taken[c])]);
            if (f.fees[c])
                facts.push([`Card and gateway fees${tag}`, m(f.fees[c])]);
            facts.push([`Spent${tag}`, m(f.spent[c])]);
            const kept = (f.invoiced[c] ?? 0) + (f.taken[c] ?? 0) - (f.spent[c] ?? 0) - (f.fees[c] ?? 0);
            facts.push([`Earned less spent${tag}`, m(kept)]);
            facts.push([`Owed to you now${tag}`, m(f.owed[c]) + (f.oldOwed[c] ? `, of which ${m(f.oldOwed[c])} is old-system history` : '')]);
            if (f.dueThisMonth[c] || f.billing[c])
                facts.push([`Due in this month${tag}`, `${m(f.dueThisMonth[c])} on invoices, ${m(f.billing[c])} from subscriptions`]);
        }
        const body = [`Here is ${f.month} in money, from the 1st to the last day.`];
        if (f.topOwing.length) {
            body.push('Who owes you the most, late:');
            for (const w of f.topOwing)
                body.push(`${w.name}: ${formatMoney(w.amount, w.currency)}${w.oldestDue ? `, late since ${sayDate(w.oldestDue)}` : ''}`);
        }
        const content = { heading: `Your ${f.month} in money`, body, facts, button: { label: 'Open Reports', url: `${appUrl()}?v=reports` } };
        const brand = await emailBrandFor(accountId, null);
        for (const to of emails) {
            await sendMail(to, `Klippy: your ${f.month} in money`, renderEmailText(brand, content), renderEmail(brand, content))
                .then(() => { sent++; }).catch(() => { });
        }
    }
    return `${sent} month report(s) sent across ${byAccount.size} workspace(s)`;
}
//# sourceMappingURL=monthly.js.map