/**
 * The Money screens: Owed to you, Coming in, Expenses and the accountant's exports.
 *
 * Each block names what would be quietly wrong:
 *   - a client with an email on their record showing no way to chase them
 *   - Chase all emailing clients about invoices carried over from the old system
 *   - drafts (money nobody has sent for) counted nowhere on Coming in
 *   - an expense tagged to another workspace's client
 *   - a receipt landing anywhere but Receipts, or on someone else's expense
 *   - the accountant's export mixing two businesses with nothing saying whose is whose
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
    body: JSON.stringify({ password: 'moneyscreens12', accountName: `Money ${tag}`, name: 'Mo Ney', email, blueprint: 'agency', currency: 'ZAR', vatRegistered: false }),
  });
  const cookie = cookieOf(r);
  const body = await r.json();
  const A = async (method, p, b) => {
    const res = await fetch(API + p, { method, headers: { ...(b ? { 'content-type': 'application/json' } : {}), cookie }, body: b ? JSON.stringify(b) : undefined });
    const text = await res.text();
    let json = {};
    try { json = JSON.parse(text); } catch { json = { text }; }
    return { status: res.status, body: json };
  };
  const upload = async (p, name, type, bytes) => {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type }), name);
    const res = await fetch(API + p, { method: 'POST', headers: { cookie }, body: form });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  return { A, upload, account: body.account };
};
const day = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

const { A, upload, account } = await signup(`money.${tag}@test.local`);
const biz = (await A('GET', '/businesses')).body.businesses[0];
const other = (await A('POST', '/businesses', { name: `Second Co ${tag}`, type: 'services' })).body.business;

// A client whose email went on their record after the invoice was made.
const late = (await A('POST', '/folders', { name: 'Late Payer', businessId: biz.id })).body.folder.id;
let seq = 5000;
const invoice = async (folder, due, opts = {}) => {
  seq++;
  const s = opts.seq ?? seq;
  const [r] = await db.query(`INSERT INTO documents (account_id, business_id, type, seq, number, folder_id, client_name, client_email, issue_date, due_date, status, total, subtotal)
    VALUES (?, ?, 'invoice', ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
  [account.id, opts.biz ?? biz.id, s, `INV-${s}`, folder, opts.name ?? 'Late Payer', day(-90), due, opts.status ?? 'sent', opts.total ?? 1000, opts.total ?? 1000]);
  return r.insertId;
};
const ten = await invoice(late, day(-10), { total: 1000 });
const seventy = await invoice(late, day(-70), { total: 400 });
await A('PATCH', `/folders/${late}`, { billingEmail: `late.${tag}@test.local` });

// ---- Owed to you ------------------------------------------------------------------------------
let coll = (await A('GET', '/collections')).body;
const row = coll.items?.find((i) => i.id === ten);
ok(row?.clientEmail === `late.${tag}@test.local`, 'the list uses the email on the client record when the invoice has none', row?.clientEmail);
const ageing = coll.summary?.ageing?.[0]?.buckets ?? [];
ok(ageing.find((b) => b.key === '1-30')?.amount === 1000 && ageing.find((b) => b.key === '61-90')?.amount === 400,
  'how late the money is, in 30-day steps', JSON.stringify(ageing));

// An invoice carried over from the old system, overdue, with an email.
const oldOne = await invoice(late, day(-200), { seq: 3_000_000_000 + tag % 1_000_000, total: 250 });
coll = (await A('GET', '/collections')).body;
ok(coll.items.find((i) => i.id === oldOne)?.imported === true, 'an old-system invoice is marked as such on the list');
const chaseAll = (await A('POST', '/collections/chase', {})).body;
const [[oldDoc]] = await db.query('SELECT last_reminder_on l FROM documents WHERE id = ?', [oldOne]);
const [[newDoc]] = await db.query('SELECT last_reminder_on l FROM documents WHERE id = ?', [ten]);
ok(chaseAll.covered === 2 && !oldDoc.l && !!newDoc.l, 'Chase all chases real invoices and leaves the old-system one alone', `${JSON.stringify(chaseAll)} old=${oldDoc.l} new=${newDoc.l}`);
const picked = (await A('POST', '/collections/chase', { ids: [oldOne] })).body;
ok(picked.covered === 1, 'picked by hand, an old-system invoice can still be chased', JSON.stringify(picked));

// ---- Coming in ---------------------------------------------------------------------------------
const soon = await invoice(late, day(3), { total: 700 });
await invoice(late, day(5), { total: 300, status: 'draft' });
const cash = (await A('GET', '/reports/cashflow')).body.currencies?.[0];
const week0 = (cash?.items ?? []).filter((i) => i.week === 0);
ok(week0.some((i) => i.id === soon && i.client === 'Late Payer' && i.amount === 700), 'a week says whose money is in it', JSON.stringify(week0));
ok((cash?.items ?? []).some((i) => i.id === ten && i.week === -1), 'and overdue invoices are listed under overdue');
ok(cash?.drafts === 300 && cash.draftCount === 1, 'money sitting in drafts is shown, not lost', `${cash?.drafts} ${cash?.draftCount}`);

// ---- Expenses --------------------------------------------------------------------------------------
const { A: B, upload: upB } = await signup(`money.other.${tag}@test.local`);
const theirClient = (await B('POST', '/folders', { name: 'Their Client', businessId: (await B('GET', '/businesses')).body.businesses[0].id })).body.folder.id;
const sneaky = await A('POST', '/expenses', { businessId: biz.id, folderId: theirClient, description: 'Lunch', amount: 100, incurredOn: day(0) });
ok(sneaky.status === 400, 'an expense cannot be tagged to another workspace\'s client', sneaky.status);
const exp = (await A('POST', '/expenses', { businessId: biz.id, folderId: late, description: 'Hosting bill', category: 'Software', amount: 230, vatAmount: 30, incurredOn: day(0) })).body.expense;
ok(!!exp?.id, 'an expense for your own client saves');
const sneakyEdit = await A('PATCH', `/expenses/${exp.id}`, { folderId: theirClient });
ok(sneakyEdit.status === 400, 'or be moved onto one later', sneakyEdit.status);

const notImage = await upload(`/expenses/${exp.id}/receipt`, 'notes.txt', 'text/plain', 'hello');
ok(notImage.status === 400, 'a receipt has to be a photo or a PDF', notImage.body.error);
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const up = await upload(`/expenses/${exp.id}/receipt`, 'slip.png', 'image/png', png);
ok(up.status === 201 && up.body.receiptNodeId, 'a photo of the slip attaches', up.status);
const [[node]] = await db.query('SELECT n.account_id a, n.name, p.name parent FROM storage_nodes n JOIN storage_nodes p ON p.id = n.parent_id WHERE n.id = ?', [up.body.receiptNodeId]);
ok(node?.a === account.id && node.parent === 'Receipts' && node.name.includes('Hosting bill'), 'it is filed in Files under Receipts, named after the expense', `${node?.parent} / ${node?.name}`);
const listed = (await A('GET', '/expenses')).body.expenses.find((e) => e.id === exp.id);
ok(listed?.receiptNodeId === up.body.receiptNodeId, 'and the expense shows it');
const theirUp = await upB(`/expenses/${exp.id}/receipt`, 'x.png', 'image/png', png);
ok(theirUp.status === 404, 'nobody else can attach to your expense', theirUp.status);
const second = await upload(`/expenses/${exp.id}/receipt`, 'slip2.png', 'image/png', png);
const [[{ n: oldLeft }]] = await db.query('SELECT COUNT(*) n FROM storage_nodes WHERE id = ?', [up.body.receiptNodeId]);
ok(second.status === 201 && Number(oldLeft) === 0, 'replacing it removes the old file rather than leaving it behind', oldLeft);
await A('DELETE', `/expenses/${exp.id}/receipt`);
const [[{ n: gone }]] = await db.query('SELECT COUNT(*) n FROM storage_nodes WHERE id = ?', [second.body.receiptNodeId]);
const [[after]] = await db.query('SELECT receipt_node_id r FROM expenses WHERE id = ?', [exp.id]);
ok(Number(gone) === 0 && after.r === null, 'removing it deletes the file and clears the expense', `${gone} ${after.r}`);

// ---- the accountant's exports ---------------------------------------------------------------------
await A('POST', '/expenses', { businessId: other.id, description: 'Other company rent', amount: 5000, incurredOn: day(0) });
const csvOf = async (q) => (await A('GET', `/reports/export?${q}`)).body.text ?? '';
const all = await csvOf(`kind=expenses&from=${day(-1)}&to=${day(1)}`);
ok(all.startsWith('Business,') && all.includes('Other company rent') && all.includes('Hosting bill'), 'the export says which business each line belongs to', all.split(/\r\n/)[0]);
const one = await csvOf(`kind=expenses&from=${day(-1)}&to=${day(1)}&businessId=${biz.id}`);
ok(one.includes('Hosting bill') && !one.includes('Other company rent'), 'and with a business picked, it is only that business', one.split(/\r\n/).length);
ok(one.split(/\r\n/)[0].includes('VAT') && one.includes(',30.00,'), 'expenses carry their VAT for the return', one.split(/\r\n/)[1]);
const inv = await csvOf(`kind=invoices&from=${day(-100)}&to=${day(1)}&businessId=${other.id}`);
ok(!inv.includes('INV-'), 'the invoice export follows the business too');
const theirs = await B('GET', `/reports/export?kind=expenses&from=${day(-1)}&to=${day(1)}&businessId=${biz.id}`);
ok(theirs.status === 403, 'another workspace cannot export your business', theirs.status);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
await db.end();
process.exit(failures ? 1 : 0);
