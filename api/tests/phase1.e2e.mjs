/**
 * Phase 1 of the usability plan: stop the silent damage.
 *
 * Every block here is a defect the usability audit reported and a verification pass
 * confirmed against the live API before anything was changed. Each one produced a
 * wrong result with no message. Each block is written to FAIL against the old code.
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
  console.log((c ? 'PASS  ' : 'FAIL  ') + label + (extra ? '  [' + extra + ']' : ''));
  if (!c) failures++;
};
const cookieOf = (r) => (r.headers.getSetCookie?.() ?? [r.headers.get('set-cookie')])
  .filter(Boolean).map((c) => c.split(';')[0]).join('; ');

const TAG = 'E2E-P1';
const clean = async () => {
  await db.query('DELETE p FROM payments p JOIN documents d ON d.id = p.document_id WHERE d.client_name LIKE ?', [`${TAG}%`]);
  await db.query('DELETE FROM document_lines WHERE document_id IN (SELECT id FROM (SELECT id FROM documents WHERE client_name LIKE ?) x)', [`${TAG}%`]);
  await db.query('DELETE FROM documents WHERE client_name LIKE ?', [`${TAG}%`]);
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
const post = (p, b) => fetch(API + p, { method: 'POST', headers: H, body: JSON.stringify(b ?? {}) });
const patch = (p, b) => fetch(API + p, { method: 'PATCH', headers: H, body: JSON.stringify(b ?? {}) });
// Cookie only: a bodyless request claiming to be JSON is a silent 400 from Fastify.
const del = (p) => fetch(API + p, { method: 'DELETE', headers: { cookie } });

const [[biz]] = await db.query('SELECT id FROM businesses WHERE account_id = 1 ORDER BY position LIMIT 1');

/** An issued invoice for R1000, due a month ago, so it is squarely something to chase. */
const issuedInvoice = async (label) => {
  const r = await post('/documents', {
    type: 'invoice', businessId: biz.id, clientName: `${TAG} ${label}`,
    issueDate: '2026-07-01', dueDate: '2026-08-01', taxRate: 0,
    lines: [{ description: 'Work', quantity: 1, unitPrice: 1000 }],
  });
  const doc = (await r.json()).document;
  await patch(`/documents/${doc.id}/status`, { status: 'sent' });
  return doc.id;
};
const pay = async (docId, amount) => {
  await post(`/documents/${docId}/payments`, { amount, paidOn: '2026-08-10', method: 'EFT' });
  const [[row]] = await db.query('SELECT id FROM payments WHERE document_id = ? ORDER BY id DESC LIMIT 1', [docId]);
  return row.id;
};
const statusOf = async (docId) => (await db.query('SELECT status FROM documents WHERE id = ?', [docId]))[0][0].status;
const onCollections = async (docId) => {
  const r = await (await fetch(API + `/collections?businessId=${biz.id}`, { headers: { cookie } })).json();
  return (r.items ?? []).some((i) => i.id === docId || i.documentId === docId);
};

/**
 * ---- deleting the payment that settled an invoice reopens it ----------------------
 *
 * It used to leave the invoice 'paid' with nothing paid against it. Every screen and job
 * that decides "is this owed" filters on 'sent', and every way a client can pay refuses
 * a 'paid' invoice, so the debt vanished and could not have been paid if they tried.
 */
{
  const id = await issuedInvoice('Settled Then Undone');
  const pid = await pay(id, 1000);
  ok((await statusOf(id)) === 'paid', 'a full payment settles the invoice', await statusOf(id));

  const r = await del(`/payments/${pid}`);
  const body = await r.json();
  ok(r.status === 200, 'the payment can be removed', String(r.status));
  ok((await statusOf(id)) === 'sent',
    'removing the payment that settled it puts the invoice back to sent, instead of leaving it paid with nothing paid',
    await statusOf(id));
  ok(body.reopened === true && Math.abs(body.outstanding - 1000) < 0.01,
    'and the response says it reopened, with the amount now owing', JSON.stringify({ reopened: body.reopened, outstanding: body.outstanding }));
  ok(await onCollections(id), 'so it is back on Collections, where it will be chased');

  const [[ev]] = await db.query(
    "SELECT business_id, payload FROM events WHERE name = 'payment.deleted' ORDER BY id DESC LIMIT 1");
  const payload = typeof ev.payload === 'string' ? JSON.parse(ev.payload) : ev.payload;
  ok(ev.business_id === biz.id && payload.reopened === true && payload.statusBefore === 'paid',
    'the audit trail records the business and that the invoice reopened', JSON.stringify({ biz: ev.business_id, payload }));
}

/**
 * ---- an invoice marked paid BY HAND after a part payment is not suddenly chased -----
 *
 * The obvious rule, "reopen if money is owing after the delete", would take an invoice
 * someone deliberately marked paid after R500 of R1000 (writing off the rest) and chase
 * the client for the full R1000 the moment that R500 row is removed.
 */
{
  const id = await issuedInvoice('Paid By Hand');
  const pid = await pay(id, 500);
  await patch(`/documents/${id}/status`, { status: 'paid' });
  ok((await statusOf(id)) === 'paid', 'an invoice can be marked paid by hand after a part payment');

  const body = await (await del(`/payments/${pid}`)).json();
  ok((await statusOf(id)) === 'paid',
    'removing that part payment does NOT reopen it, because that delete is not what settled it', await statusOf(id));
  ok(body.reopened === false && body.stillPaidWithBalance === true,
    'but the response says plainly that it is marked paid with money not covered', JSON.stringify({ reopened: body.reopened, stillPaidWithBalance: body.stillPaidWithBalance }));
}

/**
 * ---- a paid and then fully refunded invoice stays settled --------------------------
 *
 * The client paid, then got their money back. Deleting the original payment row must not
 * chase them for money they were refunded.
 */
{
  const id = await issuedInvoice('Paid Then Refunded');
  const paid = await pay(id, 1000);
  await pay(id, -1000);
  const before = await statusOf(id);
  await del(`/payments/${paid}`);
  ok((await statusOf(id)) === before,
    'deleting the payment on a refunded invoice leaves its status alone rather than reopening it', `${before} -> ${await statusOf(id)}`);
}

/**
 * ---- deleting a part payment on an invoice still owed changes nothing ---------------
 */
{
  const id = await issuedInvoice('Part Paid');
  const pid = await pay(id, 300);
  ok((await statusOf(id)) === 'sent', 'a part payment leaves the invoice owed');
  const body = await (await del(`/payments/${pid}`)).json();
  ok((await statusOf(id)) === 'sent' && body.reopened === false,
    'and removing it leaves it owed, with nothing to reopen', await statusOf(id));
}

/**
 * ---- only a quote can be accepted ---------------------------------------------------
 *
 * Set on an invoice, 'accepted' matched none of the filters that decide whether money is
 * owed, so the invoice dropped off Collections, reminders, the forecast and hosting
 * suspension, and vanished from the client's own portal, while the profit and VAT reports
 * still counted it as owed.
 */
{
  const inv = await issuedInvoice('Accepted By Mistake');
  const r = await patch(`/documents/${inv}/status`, { status: 'accepted' });
  ok(r.status === 400, 'an invoice cannot be set to accepted', String(r.status));
  ok((await statusOf(inv)) === 'sent', 'so it stays sent, where every chase can still see it', await statusOf(inv));
  const msg = (await r.json()).error ?? '';
  ok(/only a quote/i.test(msg), 'and the refusal says why, in words a person can act on', msg);

  const q = await post('/documents', {
    type: 'quote', businessId: biz.id, clientName: `${TAG} Real Quote`,
    issueDate: '2026-07-01', taxRate: 0, lines: [{ description: 'Work', quantity: 1, unitPrice: 500 }],
  });
  const quoteId = (await q.json()).document.id;
  await patch(`/documents/${quoteId}/status`, { status: 'sent' });
  const qa = await patch(`/documents/${quoteId}/status`, { status: 'accepted' });
  ok(qa.status === 200 && (await statusOf(quoteId)) === 'accepted',
    'while a quote can still be accepted, which is what the status is for', String(qa.status));
}

/**
 * ---- a voided document cannot be revived --------------------------------------------
 *
 * Void cancels an issued document and keeps its number and trail; a voided tax invoice may
 * already sit in a filed VAT period. PATCH back to sent revived it with no event recorded.
 */
{
  const inv = await issuedInvoice('Voided');
  const v = await patch(`/documents/${inv}/status`, { status: 'void' });
  ok(v.status === 200 && (await statusOf(inv)) === 'void',
    'an issued invoice can still be voided this way, the existing sanctioned way to cancel', String(v.status));
  const back = await patch(`/documents/${inv}/status`, { status: 'sent' });
  ok(back.status === 400 && (await statusOf(inv)) === 'void',
    'but a voided invoice cannot be set back to sent', `${back.status} -> ${await statusOf(inv)}`);
}

await clean();
await db.end();
console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURES');
process.exit(failures ? 1 : 0);
