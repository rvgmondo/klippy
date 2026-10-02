/**
 * The six-door release, against a real database.
 *
 * Everything here shipped while the local database was blocked, so it had only been
 * checked against a stand-in. Each block names the thing that would be quietly wrong:
 *   - sign-up: the business type, VAT answer and clean start actually land
 *   - documents and records take the right business, or refuse instead of guessing
 *   - Clients and Home add money up with the same rule as every other screen
 *   - one account can never read another account's client
 *   - the new routes refuse anybody not signed in
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
  database: url.pathname.slice(1),
});

let failures = 0;
const ok = (c, label, extra) => {
  console.log((c ? 'PASS  ' : 'FAIL  ') + label + (extra !== undefined ? '  [' + extra + ']' : ''));
  if (!c) failures++;
};
const cookieOf = (r) => (r.headers.getSetCookie?.() ?? [r.headers.get('set-cookie')])
  .filter(Boolean).map((c) => c.split(';')[0]).join('; ');

const tag = Date.now();
const emails = [`six.trade.${tag}@test.local`, `six.vat.${tag}@test.local`, `six.other.${tag}@test.local`];

const signup = async (body) => {
  const r = await fetch(API + '/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'sixdoorspass1', ...body }),
  });
  return { status: r.status, cookie: cookieOf(r), body: await r.json().catch(() => ({})) };
};
const client = (cookie) => ({
  get: async (p) => { const r = await fetch(API + p, { headers: { cookie } }); return { status: r.status, body: await r.json().catch(() => ({})) }; },
  post: async (p, b) => { const r = await fetch(API + p, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(b ?? {}) }); return { status: r.status, body: await r.json().catch(() => ({})) }; },
  patch: async (p, b) => { const r = await fetch(API + p, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(b ?? {}) }); return { status: r.status, body: await r.json().catch(() => ({})) }; },
});
const day = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// ---- sign-up as a tradesperson, not VAT registered ---------------------------------
const trade = await signup({ accountName: `Six Trade ${tag}`, name: 'Sipho Test', email: emails[0], blueprint: 'trade', currency: 'ZAR', vatRegistered: false });
ok(trade.status === 201 && !!trade.cookie, 'a tradesperson can sign up', trade.status);
const T = client(trade.cookie);
const tAcc = trade.body.account;
ok(tAcc?.folderLabelPlural === 'Customers', 'a trade account calls people Customers', tAcc?.folderLabelPlural);

const [[tBiz]] = await db.query('SELECT id, default_tax_rate r, default_due_days d, modules m, biz_tax_number v FROM businesses WHERE account_id = ?', [tAcc.id]);
ok(Number(tBiz.r) === 0, 'not VAT registered means 0% on invoices', tBiz.r);
ok(tBiz.d === 7, 'the trade blueprint terms (7 days) are applied at sign-up, not only to a second business', tBiz.d);
const mods = typeof tBiz.m === 'string' ? JSON.parse(tBiz.m) : tBiz.m;
ok(Array.isArray(mods) && !mods.includes('pipeline') && mods.includes('billing'), 'deals are off and billing is on for a trade', JSON.stringify(mods));

const [tFolders] = await db.query('SELECT name, pillar FROM folders WHERE account_id = ?', [tAcc.id]);
ok(tFolders.length === 1 && tFolders[0].name === 'Internal work', 'a new account starts clean: one internal folder, no sample client', tFolders.map((f) => f.name).join(', '));
const [[{ n: tDeals }]] = await db.query('SELECT COUNT(*) n FROM deals WHERE account_id = ?', [tAcc.id]);
const [[{ n: tOffers }]] = await db.query('SELECT COUNT(*) n FROM offerings WHERE account_id = ?', [tAcc.id]);
ok(Number(tDeals) === 0 && Number(tOffers) === 0, 'and no made-up deals or prices', `${tDeals} deals, ${tOffers} prices`);

const steps = (await T.get('/onboarding')).body.steps ?? [];
const keys = steps.map((s) => s.key);
ok(keys[0] === 'client' && keys[1] === 'invoice' && keys.includes('bank'), 'the setup list starts with a customer, a first invoice, then bank details', keys.join(','));
ok(!keys.includes('deal'), 'and never asks a trade to track a deal');
ok(steps.find((s) => s.key === 'client')?.done === false, 'the first-customer step is genuinely not done on a clean start');

// ---- sign-up as VAT registered -----------------------------------------------------
const vat = await signup({ accountName: `Six VAT ${tag}`, name: 'Vee Test', email: emails[1], blueprint: 'agency', currency: 'ZAR', vatRegistered: true, vatNumber: '4123456789' });
ok(vat.status === 201, 'a VAT-registered agency can sign up', vat.status);
const V = client(vat.cookie);
const vAcc = vat.body.account;
const [[vBiz]] = await db.query('SELECT id, default_tax_rate r, biz_tax_number v FROM businesses WHERE account_id = ?', [vAcc.id]);
ok(Number(vBiz.r) === 15 && vBiz.v === '4123456789', 'registered means 15% and the VAT number on every invoice', `${vBiz.r}, ${vBiz.v}`);
ok(vAcc.folderLabelPlural === 'Clients', 'an agency still says Clients');

// ---- which business a document comes from ------------------------------------------
const second = await V.post('/businesses', { name: `Six Hosting ${tag}`, type: 'services' });
ok(second.status === 201, 'a second business can be added', second.status);
const biz2 = second.body.business?.id;

const noBiz = await V.post('/documents', {
  type: 'invoice', clientName: 'Somebody', issueDate: day(0), taxRate: 0,
  lines: [{ description: 'Work', quantity: 1, unitPrice: 100 }],
});
ok(noBiz.status === 400, 'with two businesses and nothing to go on, an invoice is refused, not filed under the first', noBiz.status);
ok(/which business/i.test(noBiz.body.error ?? ''), 'and the refusal asks which business', noBiz.body.error);

const f2 = await V.post('/folders', { name: `Six Client ${tag}`, parentId: null, businessId: biz2, pillar: 'delivery' });
const clientId = f2.body.folder?.id;
ok(f2.status === 201 && clientId, 'a client can be added to the second business', f2.status);

const fromClient = await V.post('/documents', {
  type: 'invoice', clientName: `Six Client ${tag}`, folderId: clientId, issueDate: day(-40), dueDate: day(-10), taxRate: 0,
  lines: [{ description: 'Hosting', quantity: 1, unitPrice: 1000 }],
});
ok(fromClient.status === 201 && fromClient.body.document?.businessId === biz2,
  'an invoice for that client comes from the client\'s business', `${fromClient.status} biz ${fromClient.body.document?.businessId} want ${biz2}`);
const invId = fromClient.body.document?.id;

const exp = await V.post('/expenses', { description: 'Server', amount: 50, incurredOn: day(0) });
ok(exp.status === 400, 'an expense with no business and no client is refused rather than filed under the first', exp.status);
const exp2 = await V.post('/expenses', { description: 'Server', amount: 50, incurredOn: day(0), folderId: clientId });
const [[expRow]] = exp2.status === 201 ? await db.query('SELECT business_id b FROM expenses WHERE account_id = ? ORDER BY id DESC LIMIT 1', [vAcc.id]) : [[{}]];
ok(exp2.status === 201 && expRow.b === biz2, 'an expense for a client lands in that client\'s business', `${exp2.status} biz ${expRow.b}`);
const deal = await V.post('/deals', { title: 'A job', value: 100 });
ok(deal.status === 400, 'a deal with no business is refused too', deal.status);
const deal2 = await V.post('/deals', { title: 'A job', value: 100, businessId: vBiz.id });
ok(deal2.status === 201 || deal2.status === 200, 'and accepted once a business is given', deal2.status);

// ---- Clients and Home add money up the way Money does ------------------------------
await V.patch(`/documents/${invId}/status`, { status: 'sent' });
await V.post(`/documents/${invId}/payments`, { amount: 400, paidOn: day(0), method: 'EFT' });

const list = (await V.get('/clients')).body.clients ?? [];
const row = list.find((c) => c.id === clientId);
ok(row && row.owed?.ZAR === 600, 'the Clients list shows what is left after a part payment', JSON.stringify(row?.owed));
ok(row && row.overdue?.ZAR === 600, 'and all of it as overdue, since it was due ten days ago', JSON.stringify(row?.overdue));
ok(!list.some((c) => c.name === 'Internal work'), 'internal work is not listed as a client');

const page = (await V.get(`/clients/${clientId}`)).body;
ok(page.money?.owed?.ZAR === 600 && page.money?.lateCount === 1, 'the client page agrees with the list to the cent', JSON.stringify(page.money));
ok(page.documents?.[0]?.outstanding === 600, 'and its invoice shows what is still owed');

const coll = (await V.get('/collections')).body;
const collRow = (coll.items ?? []).find((i) => i.id === invId);
ok(collRow?.outstanding === 600, 'Owed to you says the same amount', collRow?.outstanding);

const home = (await V.get('/home')).body;
const late = (home.items ?? []).find((i) => i.kind === 'invoice-late' && i.docId === invId);
ok(!!late && late.amount === 600 && late.group === 'overdue', 'Home lists it under Overdue with the same amount', JSON.stringify(late && { a: late.amount, g: late.group }));
ok(home.figures?.owed?.ZAR === 600 && home.figures?.overdue?.ZAR === 600, 'and the Owed figure on top matches', JSON.stringify(home.figures?.owed));
ok(home.figures?.moneyIn?.ZAR === 400, 'money in this month counts the part payment', JSON.stringify(home.figures?.moneyIn));
ok(!(home.items ?? []).some((i) => i.docId === invId && i.group !== 'overdue'), 'nothing is counted twice across groups');
ok(home.didForYou && typeof home.didForYou.autoInvoices === 'number', 'the what-Klippy-did line is worked out', JSON.stringify(home.didForYou));
const only2 = (await V.get(`/home?businessId=${biz2}`)).body;
const only1 = (await V.get(`/home?businessId=${vBiz.id}`)).body;
ok((only2.items ?? []).some((i) => i.docId === invId), 'showing the second business keeps its invoice');
ok(!(only1.items ?? []).some((i) => i.docId === invId), 'showing the first business leaves it out');

const draft = await V.post('/documents', {
  type: 'quote', businessId: vBiz.id, clientName: 'Draft person', issueDate: day(0), taxRate: 15,
  lines: [{ description: 'Idea', quantity: 1, unitPrice: 200 }],
});
const homeAfter = (await V.get('/home')).body;
ok((homeAfter.items ?? []).some((i) => i.kind === 'draft' && i.docId === draft.body.document?.id), 'an unsent draft shows on Home as something to send');

// ---- one account never sees another's client ----------------------------------------
const other = await signup({ accountName: `Six Other ${tag}`, name: 'Other Test', email: emails[2] });
const O = client(other.cookie);
const peek = await O.get(`/clients/${clientId}`);
ok(peek.status === 404, 'another account asking for this client by id gets nothing', peek.status);
const theirList = (await O.get('/clients')).body.clients ?? [];
ok(!theirList.some((c) => c.id === clientId), 'and it is not in their list');
const theirHome = (await O.get('/home')).body;
ok(!(theirHome.items ?? []).some((i) => i.docId === invId), 'and not on their Home');

// ---- signed out ---------------------------------------------------------------------
for (const p of ['/clients', `/clients/${clientId}`, '/home']) {
  const r = await fetch(API + p);
  ok(r.status === 401, `${p} refuses anybody not signed in`, r.status);
}

// ---- cleanup ------------------------------------------------------------------------
for (const e of emails) {
  const [[u]] = await db.query('SELECT id FROM users WHERE email = ?', [e]);
  if (!u) continue;
  const [accs] = await db.query('SELECT account_id a FROM memberships WHERE user_id = ?', [u.id]);
  for (const a of accs) await db.query('DELETE FROM accounts WHERE id = ?', [a.a]);
  await db.query('DELETE FROM users WHERE id = ?', [u.id]);
}
console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURES');
await db.end();
process.exit(failures ? 1 : 0);
