/**
 * Bringing clients over from Invoice Ninja into a business that is already in use.
 *
 * The real case: the founder ran Invoice Ninja and Klippy side by side, so some
 * clients exist in both under slightly different names, and both systems issued
 * invoice 10408. Each block names what would be quietly wrong:
 *   - a client already in Klippy is joined, not doubled, and keeps what was typed
 *   - a test entry is left out unless asked for
 *   - old invoices keep their numbers but do not move Klippy's own numbering
 *   - old unpaid invoices are never chased automatically
 *   - payments add up to exactly what the old system said was paid
 *   - running it twice changes nothing
 *   - nobody signed out, and no other account, can use it
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
const cookieOf = (r) => (r.headers.getSetCookie?.() ?? [r.headers.get('set-cookie')]).filter(Boolean).map((c) => c.split(';')[0]).join('; ');
const tag = Date.now();
const signup = async (email) => {
  const r = await fetch(API + '/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'importpass123', accountName: `Import ${tag}`, name: 'Imp Test', email, blueprint: 'agency', currency: 'ZAR', vatRegistered: false }),
  });
  return { cookie: cookieOf(r), body: await r.json() };
};
const client = (cookie) => ({
  get: async (p) => { const r = await fetch(API + p, { headers: { cookie } }); return { status: r.status, body: await r.json().catch(() => ({})) }; },
  post: async (p, b) => { const r = await fetch(API + p, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(b ?? {}) }); return { status: r.status, body: await r.json().catch(() => ({})) }; },
});

const me = await signup(`imp.${tag}@test.local`);
const A = client(me.cookie);
const accountId = me.body.account.id;
const [[biz]] = await db.query('SELECT id FROM businesses WHERE account_id = ?', [accountId]);
await db.query("UPDATE businesses SET prefix_invoice = 'MBI-' WHERE id = ?", [biz.id]);

// What was already in Klippy: two clients, and Klippy's own 10408 and 10416.
const mk = async (name, email) => (await A.post('/folders', { name, businessId: biz.id, billingEmail: email ?? undefined })).body.folder.id;
const earlyBird = await mk('Early Bird Coffee Co', 'kept@earlybird.test');
const centred = await mk('Centred Studio', null);
for (const seq of [10408, 10416]) {
  await db.query(`INSERT INTO documents (account_id, business_id, type, seq, number, folder_id, client_name, issue_date, status, total, subtotal)
    VALUES (?, ?, 'invoice', ?, ?, ?, 'Centred Studio', '2026-09-01', 'paid', 100, 100)`, [accountId, biz.id, seq, `MBI-${seq}`, centred]);
}

const files = {
  clients: [
    { Name: 'Early Bird Co', Email: 'old@earlybird.test', 'Client Phone': '021 555 0101', Street: '1 Long St', City: 'Cape Town', 'First Name': 'Ana', 'Last Name': 'Bird', 'VAT Number': '4000000001' },
    { Name: 'Centred Studio', Email: 'hi@centred.test', 'First Name': 'Lee', 'Last Name': 'Centre' },
    { Name: 'RenewSA', Email: 'accounts@renew.test', 'Client Phone': '082 000 0000', 'First Name': 'Ren', 'Last Name': 'Ewe', 'Client Payment Terms': '7' },
    { Name: 'RenewSA', Email: '', 'Client Phone': '', Street: '9 Main Rd', City: 'Durban', 'First Name': '', 'Last Name': '' },
    { Name: '', Email: 'johan@vdm.test', 'First Name': 'Johan', 'Last Name': 'Van Der Merwe' },
    { Name: 'Test client', Email: 'email@example.com', 'First Name': 'Test', 'Last Name': 'Person' },
  ],
  contacts: [
    { 'Client Name': 'RenewSA', 'Contact First Name': 'Ren', 'Contact Last Name': 'Ewe', 'Contact Email': 'accounts@renew.test' },
    { 'Client Name': 'RenewSA', 'Contact First Name': 'Second', 'Contact Last Name': 'Person', 'Contact Email': 'second@renew.test', 'Contact Phone': '083 111 2222' },
  ],
  invoices: [
    { 'Client Name': 'RenewSA', 'Invoice Invoice Number': 'MB-10408', 'Invoice Amount': '250.00', 'Invoice Subtotal': '250.00', 'Invoice Paid to Date': '0.00', 'Invoice Date': '2026-01-22', 'Invoice Due Date': '2026-01-29', 'Invoice Status': 'Sent' },
    { 'Client Name': 'RenewSA', 'Invoice Invoice Number': 'MB-10300', 'Invoice Amount': '1,000.00', 'Invoice Subtotal': '1,000.00', 'Invoice Paid to Date': '1,000.00', 'Invoice Date': '2025-11-01', 'Invoice Due Date': '2025-11-08', 'Invoice Status': 'Paid' },
    { 'Client Name': 'RenewSA', 'Invoice Invoice Number': 'MBI10095', 'Invoice Amount': '500.00', 'Invoice Subtotal': '500.00', 'Invoice Paid to Date': '200.00', 'Invoice Date': '2025-12-01', 'Invoice Due Date': '2025-12-08', 'Invoice Status': 'Partial/Deposit' },
    { 'Client Name': 'Early Bird Co', 'Invoice Invoice Number': 'MB-10342', 'Invoice Amount': '250.00', 'Invoice Paid to Date': '0', 'Invoice Date': '2026-01-26', 'Invoice Due Date': '2026-02-02', 'Invoice Status': 'Cancelled' },
    { 'Client Name': 'Johan Van Der Merwe', 'Invoice Invoice Number': 'BC00001', 'Invoice Amount': '300.00', 'Invoice Paid to Date': '300.00', 'Invoice Date': '2024-05-01', 'Invoice Status': 'Paid' },
    { 'Client Name': 'Test client', 'Invoice Invoice Number': 'MB-10001', 'Invoice Amount': '9.00', 'Invoice Paid to Date': '0', 'Invoice Date': '2023-01-01', 'Invoice Status': 'Sent' },
  ],
  quotes: [
    { 'Client Name': 'RenewSA', 'Quote Number': 'MBQ-10080', 'Quote Amount': '5,000.00', 'Quote Date': '2025-10-01', 'Quote Valid Until': '2025-10-31', 'Quote Status': 'Converted' },
    { 'Client Name': 'Centred Studio', 'Quote Number': 'MBQ10073', 'Quote Amount': '800.00', 'Quote Date': '2025-01-01', 'Quote Valid Until': '2025-01-31', 'Quote Status': 'Expired' },
  ],
  payments: [
    { 'Client Name': 'RenewSA', 'Payment Date': '2025-11-03', 'Payment Amount': '1,000.00', 'Payment Refunded': '0', 'Payment Method': 'Bank Transfer', 'Payment Transaction Reference': 'FNB123' },
    { 'Client Name': 'RenewSA', 'Payment Date': '2025-12-02', 'Payment Amount': '0.00', 'Payment Method': 'Bank Transfer' },
  ],
  recurring: [
    { 'Client Name': 'RenewSA', 'Recurring Invoice Amount': '250.00', 'Recurring Invoice Status': 'Active', 'Recurring Invoice How Often': 'Monthly', 'Recurring Invoice Date': '2023-10-03', 'Recurring Invoice Next Send Date': '2026-06-05 00:00:00' },
    { 'Client Name': 'Centred Studio', 'Recurring Invoice Amount': '350.00', 'Recurring Invoice Status': 'Paused', 'Recurring Invoice How Often': 'Monthly', 'Recurring Invoice Date': '2024-01-01', 'Recurring Invoice Next Send Date': '2026-01-10' },
  ],
};
const include = { contacts: true, invoices: true, quotes: true, payments: true, recurring: true };
const body = (extra) => ({ businessId: biz.id, files, include, dryRun: true, ...extra });

// ---- guards -----------------------------------------------------------------------
const anon = await fetch(API + '/import/invoice-ninja', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body()) });
ok(anon.status === 401, 'signed out cannot import', anon.status);
const other = client((await signup(`imp.other.${tag}@test.local`)).cookie);
const cross = await other.post('/import/invoice-ninja', body());
ok(cross.status === 404, 'another account cannot import into this business', cross.status);

// ---- preview ------------------------------------------------------------------------
const pre = await A.post('/import/invoice-ninja', body());
ok(pre.status === 200 && pre.body.done === false, 'the preview answers and writes nothing', pre.status);
const pc = Object.fromEntries((pre.body.preview?.clients ?? []).map((c) => [c.name, c]));
ok(pc['Early Bird Co']?.choice === earlyBird, '"Early Bird Co" is matched to "Early Bird Coffee Co"', JSON.stringify(pc['Early Bird Co']?.choice));
ok(pc['Centred Studio']?.choice === centred, 'a client with the same name is matched');
ok(pc['RenewSA']?.choice === 'new' && pc['RenewSA']?.people === 2, 'a client in the file twice is one client with its two people', JSON.stringify(pc['RenewSA']));
ok(pc['Johan Van Der Merwe']?.choice === 'new', 'a client with no name takes its contact\'s name');
ok(pc['Test client']?.choice === 'skip' && !!pc['Test client']?.junk, 'a test entry is left out by default');
const c0 = pre.body.preview?.counts ?? {};
ok(c0.invoices === 5 && c0.quotes === 2, 'the left-out client\'s invoice is not counted', `${c0.invoices} invoices, ${c0.quotes} quotes`);
ok(c0.unpaidInvoices === 2 && c0.unpaidTotal === 550, 'unpaid history is shown before importing', `${c0.unpaidInvoices}, R${c0.unpaidTotal}`);
const [[{ n: docsBefore }]] = await db.query('SELECT COUNT(*) n FROM documents WHERE account_id = ?', [accountId]);
ok(Number(docsBefore) === 2, 'and the preview really wrote nothing', docsBefore);

// ---- import ---------------------------------------------------------------------------
const run = await A.post('/import/invoice-ninja', body({ dryRun: false }));
ok(run.status === 200 && run.body.done === true, 'the import runs', run.status);
const a = run.body.added ?? {};
ok(a.clients === 2 && a.invoices === 5 && a.quotes === 2, 'two new clients, five invoices, two quotes', JSON.stringify(a));
const [[eb]] = await db.query('SELECT billing_email e, billing_phone p, billing_address ad, billing_vat_number v FROM folders WHERE id = ?', [earlyBird]);
ok(eb.e === 'kept@earlybird.test', 'what was typed into Klippy is not overwritten', eb.e);
ok(eb.p === '021 555 0101' && eb.ad?.includes('Long St') && eb.v === '4000000001', 'but blank details are filled in', `${eb.p}, ${eb.ad}, ${eb.v}`);
const [[renew]] = await db.query("SELECT id, billing_address ad, payment_terms_days t, primary_contact_id pc, client_since s FROM folders WHERE account_id = ? AND name = 'RenewSA'", [accountId]);
ok(renew?.ad?.includes('Main Rd') && renew?.t === 7, 'the duplicate row fills in the address the first one lacked', `${renew?.ad}, ${renew?.t}`);
ok(!!renew?.pc && !!renew?.s, 'the first person is the main contact, and client-since is the first invoice', `${renew?.pc}, ${renew?.s}`);
const [people] = await db.query('SELECT name FROM contacts WHERE account_id = ? AND folder_id = ?', [accountId, renew.id]);
ok(people.length === 2, 'two people at RenewSA, not three', people.map((p) => p.name).join(', '));
const [[{ n: testN }]] = await db.query("SELECT COUNT(*) n FROM folders WHERE account_id = ? AND name = 'Test client'", [accountId]);
ok(Number(testN) === 0, 'the test entry was not created');

const [docs] = await db.query('SELECT number, seq, status, total, folder_id f, client_name cn, (SELECT COALESCE(SUM(amount),0) FROM payments p WHERE p.document_id = d.id) paid FROM documents d WHERE account_id = ? AND seq >= 3000000000', [accountId]);
const D = Object.fromEntries(docs.map((d) => [d.number, d]));
ok(!!D['MB-10408'], 'the old MB-10408 sits next to Klippy\'s own MBI-10408');
ok(D['MB-10342']?.cn === 'Early Bird Coffee Co' && D['MB-10342']?.f === earlyBird, 'an old invoice of a joined client carries the Klippy name and sits on that client', D['MB-10342']?.cn);
ok(D['MB-10342']?.status === 'void' && D['MBQ10073']?.status === 'void' && D['MBQ-10080']?.status === 'accepted', 'cancelled and expired come in closed, converted comes in accepted');
ok(Number(D['MB-10300']?.paid) === 1000 && Number(D['MBI10095']?.paid) === 200, 'payments add up to what was paid, even where the payments file falls short', `${D['MB-10300']?.paid}, ${D['MBI10095']?.paid}`);
ok(Number(D['BC00001']?.paid) === 300 && D['BC00001']?.status === 'paid', 'a paid invoice with no payment on file still reads as paid');
const num = (await A.get(`/businesses/${biz.id}/numbering`)).body.numbering?.invoice;
ok(num?.nextNumber === 'MBI-10417', 'Klippy\'s next invoice number does not move', num?.nextNumber);

const [subs] = await db.query('SELECT folder_id f, status, auto_send a, next_bill_date n FROM subscriptions WHERE account_id = ?', [accountId]);
const today = new Date().toISOString().slice(0, 10);
const dstr = (v) => (v instanceof Date ? new Date(v.getTime() - v.getTimezoneOffset() * 60000).toISOString().slice(0, 10) : String(v));
ok(subs.length === 2 && subs.every((s) => Number(s.a) === 0 && dstr(s.n) >= today),
  'monthly bills make drafts only and never start in the past', subs.map((s) => `${s.status} ${dstr(s.n)}`).join(', '));
ok(subs.some((s) => s.status === 'paused'), 'a paused one stays paused');

const page = (await A.get(`/clients/${renew.id}`)).body;
ok(Number(page.money?.owed?.ZAR) === 550 && page.money?.openInvoices === 2, 'the client page shows the R550 still owed on two invoices', JSON.stringify(page.money));

// ---- never chased automatically -----------------------------------------------------
await db.query('UPDATE folders SET billing_email = ? WHERE id = ?', ['renew@test.local', renew.id]);
const { runInvoiceReminders } = await import('file:///C:/CC/klippy-v2/api/dist/lib/jobs.js');
await runInvoiceReminders().catch((e) => console.log('reminder run:', e.message));
const [[chased]] = await db.query('SELECT COUNT(*) n FROM documents WHERE account_id = ? AND seq >= 3000000000 AND (last_reminder_on IS NOT NULL OR suspended_at IS NOT NULL)', [accountId]);
ok(Number(chased.n) === 0, 'old unpaid invoices are never chased automatically', chased.n);

// ---- twice ----------------------------------------------------------------------------
const again = await A.post('/import/invoice-ninja', body({ dryRun: false }));
const b2 = again.body.added ?? {};
ok(again.status === 200 && b2.clients === 0 && b2.people === 0 && b2.invoices === 0 && b2.quotes === 0 && b2.payments === 0 && b2.repeating === 0,
  'running it again adds nothing', JSON.stringify(b2));
ok(again.body.preview?.counts?.alreadyImported === 7, 'and says the documents are already here', again.body.preview?.counts?.alreadyImported);

// ---- a choice the person changed -------------------------------------------------------
const moved = await A.post('/import/invoice-ninja', body({ choices: { 'Johan Van Der Merwe': centred, 'Test client': 'new' } }));
const mc = Object.fromEntries(moved.body.preview.clients.map((c) => [c.name, c]));
ok(mc['Johan Van Der Merwe'].choice === centred && mc['Test client'].choice === 'new', 'the person can change any match in the preview');
const forged = await A.post('/import/invoice-ninja', body({ choices: { RenewSA: 999999999 } }));
ok(forged.body.preview.clients.find((c) => c.name === 'RenewSA').choice !== 999999999, 'a client id from outside this business is ignored');

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
await db.end();
process.exit(failures ? 1 : 0);
