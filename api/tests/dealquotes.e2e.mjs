/**
 * Deals and the quotes made for them, plus the board's "gone quiet" signal.
 *
 * Each block names what would be quietly wrong:
 *   - a quote made from a deal leaving the deal sitting at Lead
 *   - a client accepting a quote and nobody on the deal side hearing about it
 *   - winning that deal drafting a SECOND invoice on top of the quote
 *   - a deal from another workspace being quoted against, or read
 *   - a deal nobody has touched in weeks looking as fresh as one from today
 *   - the follow-up strip listing other businesses' chases
 *
 * Run with a test server on 8095 (or set KLIPPY_API).
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';

const API = process.env.KLIPPY_API ?? 'http://localhost:8095/api/v1';
const url = new URL(process.env.DATABASE_URL);
const db = await mysql.createConnection({
  host: url.hostname, port: Number(url.port || 3306),
  user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
  database: url.pathname.slice(1), dateStrings: true,
});
let failures = 0;
const ok = (c, label, extra) => {
  console.log((c ? 'PASS  ' : 'FAIL  ') + label + (extra !== undefined ? '  [' + extra + ']' : ''));
  if (!c) failures++;
};
const cookieOf = (r) => (r.headers.getSetCookie?.() ?? [r.headers.get('set-cookie')]).filter(Boolean).map((c) => c.split(';')[0]).join('; ');
const tag = Date.now();
const signup = async (email) => {
  const r = await fetch(API + '/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'dealquotepass12', accountName: `Deals ${tag}`, name: 'Dee Deals', email, blueprint: 'agency', currency: 'ZAR', vatRegistered: false }),
  });
  const cookie = cookieOf(r);
  const body = await r.json();
  const A = async (method, p, b) => {
    const res = await fetch(API + p, { method, headers: { ...(b ? { 'content-type': 'application/json' } : {}), cookie }, body: b ? JSON.stringify(b) : undefined });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  return { A, account: body.account };
};

const { A, account } = await signup(`deals.${tag}@test.local`);
const biz = (await A('GET', '/businesses')).body.businesses[0];
const today = new Date().toISOString().slice(0, 10);
const dealOf = async (id) => ((await A('GET', '/deals')).body.deals ?? []).find((d) => d.id === id);

const deal = (await A('POST', '/deals', {
  title: 'New website', company: 'Acme Plumbing', contactName: 'Pat', contactEmail: `pat.${tag}@test.local`,
  value: 12000, businessId: biz.id,
})).body.deal;
ok(deal?.stage === 'lead', 'a new deal starts as a lead', deal?.stage);
const fresh = await dealOf(deal.id);
ok(!!fresh?.lastTouchAt && fresh.quotes?.count === 0, 'the board knows when it was last touched and that nothing is quoted yet', JSON.stringify(fresh?.quotes));

// ---- a quote made from the deal ----------------------------------------------------------
const quote = (await A('POST', '/documents', {
  type: 'quote', businessId: biz.id, dealId: deal.id, clientName: 'Acme Plumbing', clientEmail: `pat.${tag}@test.local`,
  issueDate: today, lines: [{ description: 'New website', quantity: 1, unitPrice: 12000 }],
})).body.document;
ok(quote?.dealId === deal.id, 'the quote remembers the deal it was made for', quote?.dealId);
const afterQuote = await dealOf(deal.id);
ok(afterQuote?.stage === 'proposal', 'and the deal moves from Lead to Proposal', afterQuote?.stage);
ok(afterQuote?.quotes?.count === 1 && !afterQuote.quotes.accepted, 'the card shows it has been quoted', JSON.stringify(afterQuote?.quotes));
const one = (await A('GET', `/deals/${deal.id}`)).body;
ok(one.documents?.length === 1 && one.documents[0].number === quote.number, 'opening the deal lists its quote', one.documents?.map((d) => d.number).join(','));
const hist = (await A('GET', `/deals/${deal.id}/activity`)).body.activity ?? [];
ok(hist.some((a) => (a.body ?? '').includes(quote.number)), 'and its history says the quote was made', hist.map((a) => a.body).join(' | '));

// ---- the client accepts it ------------------------------------------------------------------
await A('PATCH', `/documents/${quote.id}/status`, { status: 'sent' });
const acc = await A('PATCH', `/documents/${quote.id}/status`, { status: 'accepted' });
ok(acc.status === 200, 'the quote can be marked accepted', acc.status);
const afterAccept = await dealOf(deal.id);
ok(afterAccept?.nextFollowUpAt === today && /accepted/i.test(afterAccept?.followUpNote ?? ''),
  'the deal lands on today\'s follow-up list, saying the quote was accepted', `${afterAccept?.nextFollowUpAt} ${afterAccept?.followUpNote}`);
ok(afterAccept?.quotes?.accepted === true, 'and the card shows it as accepted');
ok(afterAccept?.stage === 'proposal', 'but is not marked won behind your back', afterAccept?.stage);
const fu = (await A('GET', `/deals/follow-ups?businessId=${biz.id}`)).body.followUps ?? [];
ok(fu.some((f) => f.id === deal.id), 'the follow-up strip for this business shows it');
const fuOther = (await A('GET', '/deals/follow-ups?businessId=999999999')).body.followUps ?? [];
ok(!fuOther.some((f) => f.id === deal.id), 'and the strip for another business does not');

// ---- winning it does not bill twice ---------------------------------------------------------
const won = await A('POST', `/deals/${deal.id}/move`, { stage: 'won', position: 0 });
const draft = (won.body.handoff ?? []).find((h) => h.handler === 'draft-opening-invoice');
ok(won.status === 200 && /made for this deal/.test(draft?.outcome ?? ''), 'winning it does not draft a second invoice over the quote', draft?.outcome);
const [[{ n: invoices }]] = await db.query("SELECT COUNT(*) n FROM documents WHERE account_id = ? AND type = 'invoice'", [account.id]);
ok(Number(invoices) === 0, 'no invoice was made from the deal value', invoices);
const conv = await A('POST', `/documents/${quote.id}/convert`);
ok(conv.status === 201 && conv.body.document?.dealId === deal.id, 'the invoice made from the quote stays linked to the deal', conv.body.document?.dealId);

// ---- another workspace -----------------------------------------------------------------------
const { A: B } = await signup(`deals.other.${tag}@test.local`);
const bBiz = (await B('GET', '/businesses')).body.businesses[0];
const sneak = await B('POST', '/documents', {
  type: 'quote', businessId: bBiz.id, dealId: deal.id, clientName: 'X', issueDate: today,
  lines: [{ description: 'X', quantity: 1, unitPrice: 1 }],
});
ok(sneak.status === 400, 'another workspace cannot make a quote against your deal', sneak.status);
ok((await B('GET', `/deals/${deal.id}`)).status === 404, 'or open it');
const [[{ n: acts }]] = await db.query('SELECT COUNT(*) n FROM deal_activities WHERE deal_id = ? AND body LIKE ?', [deal.id, '%X%']);
ok(Number(acts) === 0, 'and nothing was written to its history', acts);

// ---- gone quiet --------------------------------------------------------------------------------
const old = (await A('POST', '/deals', { title: 'Old lead', value: 500, businessId: biz.id })).body.deal;
await db.query('UPDATE deals SET created_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY) WHERE id = ?', [old.id]);
const quiet = await dealOf(old.id);
const age = Math.floor((Date.now() - new Date(quiet.lastTouchAt).getTime()) / 86400000);
ok(age >= 29, 'a deal untouched for a month reads as a month old', age);
await A('POST', `/deals/${old.id}/activity`, { kind: 'call', body: 'Called, they are still keen' });
const touched = await dealOf(old.id);
const age2 = Math.floor((Date.now() - new Date(touched.lastTouchAt).getTime()) / 86400000);
ok(age2 === 0, 'logging a call makes it fresh again', age2);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
await db.end();
process.exit(failures ? 1 : 0);
