/**
 * Coming back from PayFast, and what "online payments are on" means.
 *
 * What this proves, each written to FAIL against the old code:
 *
 *   1. A client paying from an emailed link comes back to a page from the business that
 *      billed them, not to Klippy's own marketing page at the site root.
 *   2. That page's wording about the invoice comes from the recorded payments, not from
 *      the unsigned r= in the address.
 *   3. Tenant-typed text (a brand name, an invoice prefix) cannot inject markup into a
 *      page served on the app's own origin, and escaping it does not break the signature.
 *   4. The setup step ticks only for a gateway that takes real money. Sandbox is on by
 *      default, and a gateway left in test mode used to finish setup.
 *
 * Run with a test server on 8095 (or set KLIPPY_API). The server must have the same
 * PAYMENTS_SECRET as below (the documented e2e value).
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { createHmac } from 'node:crypto';
import { signature } from '../dist/lib/payfast.js';

const API = process.env.KLIPPY_API ?? 'http://localhost:8095/api/v1';
const ORIGIN = new URL(API).origin;
const SECRET = process.env.E2E_PAYMENTS_SECRET ?? 'e2e-payments-secret-0123456789';
const url = new URL(process.env.DATABASE_URL);
const db = await mysql.createConnection({
  host: url.hostname, port: Number(url.port || 3306),
  user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
  database: url.pathname.slice(1),
});

let failures = 0;
const ok = (c, label, extra) => {
  console.log((c ? 'PASS  ' : 'FAIL  ') + label + (extra ? '  [' + extra + ']' : ''));
  if (!c) failures++;
};
const cookieOf = (r) => (r.headers.getSetCookie?.() ?? [r.headers.get('set-cookie')])
  .filter(Boolean).map((c) => c.split(';')[0]).join('; ');

const TAG = 'E2E-PR';
const clean = async () => {
  await db.query('DELETE p FROM payments p JOIN documents d ON d.id = p.document_id WHERE d.client_name LIKE ?', [`${TAG}%`]);
  await db.query('DELETE FROM document_lines WHERE document_id IN (SELECT id FROM (SELECT id FROM documents WHERE client_name LIKE ?) x)', [`${TAG}%`]);
  await db.query('DELETE FROM documents WHERE client_name LIKE ?', [`${TAG}%`]);
  const [bizzes] = await db.query('SELECT id FROM businesses WHERE account_id = 1 AND name LIKE ?', [`${TAG}%`]);
  for (const b of bizzes) {
    await db.query('DELETE FROM payment_settings WHERE account_id = 1 AND business_id = ?', [b.id]);
    await db.query('DELETE FROM businesses WHERE id = ?', [b.id]);
  }
};
await clean();

const lr = await fetch(API + '/auth/login', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'ruben@x.com', password: 'klippylook1' }),
});
const cookie = cookieOf(lr);
ok(lr.ok && !!cookie, 'owner signs in');
if (!cookie) { await db.end(); process.exit(1); }
const H = { 'content-type': 'application/json', cookie };
const get = (p) => fetch(API + p, { headers: { cookie } });
const post = (p, b) => fetch(API + p, { method: 'POST', headers: H, body: JSON.stringify(b ?? {}) });
const patch = (p, b) => fetch(API + p, { method: 'PATCH', headers: H, body: JSON.stringify(b ?? {}) });

const [[liveElsewhere]] = await db.query(
  'SELECT COUNT(*) n FROM payment_settings WHERE account_id = 1 AND enabled = 1');
if (Number(liveElsewhere.n) > 0) {
  console.log('SKIP  workspace 1 already has a gateway switched on, so the setup-step checks would not be clean');
  await db.end(); process.exit(1);
}

const stepOf = async () => (await (await get('/onboarding')).json()).steps.find((s) => s.key === 'payments');

// ---- a business with tenant-typed text that would be markup if printed raw ---------
const BRAND = '<img src=x onerror=alert(1)>';
const PREFIX = '<b>&copy-';
const bizRes = await post('/businesses', { name: `${TAG} Biz` });
const bizId = (await bizRes.json()).business?.id;
ok(!!bizId, 'a test business is created', String(bizRes.status));
await patch(`/businesses/${bizId}`, { brandName: BRAND, prefixInvoice: PREFIX });

// ---- 4. test mode does not finish setup ---------------------------------------------
{
  const before = await stepOf();
  ok(before?.done === false, 'with no gateway, the payments step is open');

  const s = await patch(`/businesses/${bizId}/payfast`, {
    merchantId: '10000100', merchantKey: '46f0cd694581a', sandbox: true, enabled: true,
  });
  ok(s.ok, 'PayFast is switched on in sandbox, the default', String(s.status));

  const after = await stepOf();
  ok(after?.done === false,
    'a gateway left in test mode does NOT tick "Switch on online payments"', JSON.stringify(after));
  ok(after?.note === 'sandbox', 'and the step says it is in test mode instead of the usual hint', JSON.stringify(after));

  const mode = await (await get(`/payfast/mode?businessId=${bizId}`)).json();
  ok(mode.test === true && mode.live === false,
    'Billing can see that invoices for this business carry a test pay link', JSON.stringify(mode));
}

// ---- an issued invoice with a pay link ----------------------------------------------
const invoice = async (label) => {
  const r = await post('/documents', {
    type: 'invoice', businessId: bizId, clientName: `${TAG} ${label}`, clientEmail: 'e2e-pr@example.com',
    issueDate: '2026-09-01', dueDate: '2026-09-30', taxRate: 0,
    lines: [{ description: 'Work', quantity: 1, unitPrice: 1000 }],
  });
  const doc = (await r.json()).document;
  await patch(`/documents/${doc.id}/status`, { status: 'sent' });
  return doc;
};
const tokenFor = (id) => createHmac('sha256', SECRET).update(`pay:${id}`).digest('hex').slice(0, 32);
const html = async (path) => {
  const r = await fetch(ORIGIN + path);
  return { status: r.status, type: r.headers.get('content-type') ?? '', body: await r.text() };
};
const decode = (v) => v.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');

const doc = await invoice('Pays Online');
const t = tokenFor(doc.id);
ok(doc.number.startsWith(PREFIX), 'the invoice number carries the typed prefix', doc.number);

// ---- 1 and 3. the checkout form ------------------------------------------------------
let returnPath = '';
let cancelPath = '';
{
  const page = await html(`/api/v1/pay/${doc.id}?t=${t}`);
  const inputs = [...page.body.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)];
  const raw = Object.fromEntries(inputs.map((m) => [m[1], m[2]]));
  const fields = Object.fromEntries(inputs.map((m) => [decode(m[1]), decode(m[2])]));
  ok(inputs.length > 5, 'the pay link renders the PayFast form', `${inputs.length} fields`);

  const back = `${ORIGIN}/api/v1/pay/${doc.id}/return?t=${t}`;
  ok(fields.return_url === `${back}&r=paid`,
    'PayFast returns the client to a page for this invoice, not to the site root', fields.return_url);
  ok(fields.cancel_url === `${back}&r=cancelled`, 'and so does cancelling', fields.cancel_url);

  ok(!Object.values(raw).some((v) => /&(?!amp;|lt;|gt;|quot;)/.test(v)),
    'no raw ampersand is left in a form value, where a browser could read "&copy" as a character and post a different string',
    raw.item_name);
  const { signature: sig, ...rest } = fields;
  ok(signature(rest, null) === sig,
    'the values a browser would post still match the signature PayFast checks');
  ok(!page.body.includes('<b>'), 'the typed prefix is not markup on the redirect page');

  returnPath = new URL(fields.return_url).pathname + new URL(fields.return_url).search;
  cancelPath = new URL(fields.cancel_url).pathname + new URL(fields.cancel_url).search;
}

// ---- 1. the staff test checkout returns to the same page -----------------------------
{
  const r = await (await get(`/documents/${doc.id}/pay-link`)).json();
  ok(r.fields?.return_url?.includes(`/api/v1/pay/${doc.id}/return?t=`),
    'the staff "Pay online" test returns to the page a client sees', r.fields?.return_url);
}

// ---- 1, 2 and 3. the page the client lands on -----------------------------------------
{
  const paid = await html(returnPath);
  ok(paid.status === 200 && paid.type.includes('text/html'), 'the return page loads for a client with no session', String(paid.status));
  ok(paid.body.includes('&lt;img src=x onerror=alert(1)&gt;') && !paid.body.includes('<img'),
    "it names the business the client knows, escaped, so a brand name cannot run script on the app's origin");
  ok(paid.body.includes('being confirmed') && !paid.body.includes('Try again'),
    'back from paying, before the payment is recorded: being confirmed, and no button to pay twice');
  ok(!paid.body.includes('<b>&copy'), 'the invoice number is escaped here too');
  ok(!/klippy/i.test(paid.body), "and it never shows Klippy's name to someone else's client");

  const cancelled = await html(cancelPath);
  ok(cancelled.body.includes('Payment not completed') && cancelled.body.includes('Try again')
    && cancelled.body.includes(`href="/api/v1/pay/${doc.id}?t=${t}"`),
    'back from cancelling: not completed, with a way to try again');
  ok(!/nothing was charged/i.test(cancelled.body), 'without claiming a fact Klippy cannot know');

  const forged = await html(`/api/v1/pay/${doc.id}/return?t=${'0'.repeat(32)}&r=paid`);
  ok(forged.body.includes('Link not valid') && !forged.body.includes('being confirmed'),
    'a made-up token gets nothing about the invoice');

  await post(`/documents/${doc.id}/payments`, { amount: 1000, paidOn: '2026-09-10', method: 'PayFast' });
  const settled = await html(cancelPath);
  ok(settled.body.includes('is paid') && !settled.body.includes('Try again'),
    'once the payment is recorded, even r=cancelled says it is paid: the wording follows the records, not the address');
}

// ---- a cancelled invoice ----------------------------------------------------------------
{
  const v = await invoice('Voided');
  await patch(`/documents/${v.id}/status`, { status: 'void' });
  const page = await html(`/api/v1/pay/${v.id}/return?t=${tokenFor(v.id)}&r=paid`);
  ok(page.body.includes('has been cancelled') && !page.body.includes('being confirmed'),
    'a voided invoice says it was cancelled, rather than "being confirmed"');
}

// ---- 4. out of sandbox, setup is done ---------------------------------------------------
{
  await patch(`/businesses/${bizId}/payfast`, { sandbox: false });
  const step = await stepOf();
  ok(step?.done === true && !step.note, 'switching Sandbox off ticks the step, with no test-mode note', JSON.stringify(step));
  const mode = await (await get(`/payfast/mode?businessId=${bizId}`)).json();
  ok(mode.live === true && mode.test === false, 'and Billing stops warning about test mode', JSON.stringify(mode));

  // A row that is not in effect must not count: switch this business off. Its own row
  // wins over any workspace gateway, so nothing can take payment.
  await patch(`/businesses/${bizId}/payfast`, { enabled: false });
  const off = await stepOf();
  ok(off?.done === false, 'a switched-off gateway does not count either', JSON.stringify(off));
}

await clean();
await db.end();
console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURES');
process.exit(failures ? 1 : 0);
