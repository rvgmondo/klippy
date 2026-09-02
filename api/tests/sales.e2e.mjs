/**
 * Counter takings: card machine sales and what the fees cost.
 *
 * The Yoco client has NOT been run against a live merchant account, so the parsing
 * is proved here against responses in the shape their API reference documents:
 * integer cents, processing_fees[], payment_source, card_machine_id, cursor paging.
 * If Yoco changes that shape this is the test that should fail first.
 *
 * Run with a test server on 8095:  node tests/sales.e2e.mjs
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';

const API = 'http://localhost:8095/api/v1';
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

const clean = async () => {
  await db.query("DELETE FROM sales WHERE account_id = 1");
  await db.query("DELETE FROM payment_connections WHERE account_id = 1");
};
await clean();

const lr = await fetch(API + '/auth/login', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'ruben@x.com', password: 'klippylook1' }),
});
const cookie = cookieOf(lr);
ok(lr.ok && cookie, 'owner signs in');
if (!cookie) { await db.end(); process.exit(1); }
const H = { 'content-type': 'application/json', cookie };
const post = (p, b) => fetch(API + p, { method: 'POST', headers: H, body: JSON.stringify(b ?? {}) });
const getj = (p) => fetch(API + p, { headers: { cookie } }).then((r) => r.json());

const [[biz]] = await db.query('SELECT id FROM businesses WHERE account_id = 1 ORDER BY position LIMIT 1');
const BID = biz.id;
const day = (n) => {
  const d = new Date(); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// ---- the client parses what Yoco documents --------------------------------------
{
  const { listPayments, windows } = await import('file:///C:/CC/klippy-v2/api/dist/lib/yoco.js');
  const realFetch = globalThis.fetch;

  // Their documented shape: amounts as integer CENTS with a currency beside them.
  globalThis.fetch = async () => new Response(JSON.stringify({
    data: [
      {
        id: 'p_tap1', status: 'approved', created_at: day(-1) + 'T10:15:00Z',
        payment_source: 'card_machine', card_machine_id: 'cm_till_1',
        total_amount: { amount: 11500, currency: 'ZAR' },
        tip_amount: { amount: 500, currency: 'ZAR' },
        refunded_amount: { amount: 0, currency: 'ZAR' },
        processing_fees: [{ amount: 287, currency: 'ZAR', type: 'processing' }],
        receipt_number: 'R-001',
      },
      // A failed tap is not money and must never reach the books.
      {
        id: 'p_dead', status: 'failed', created_at: day(-1) + 'T10:20:00Z',
        payment_source: 'card_machine',
        total_amount: { amount: 9900, currency: 'ZAR' },
        processing_fees: [],
      },
      // No id means nothing can dedupe it, so it is dropped rather than invented.
      { status: 'approved', created_at: day(-1) + 'T10:25:00Z', total_amount: { amount: 100, currency: 'ZAR' } },
    ],
    next_cursor: null,
  }), { status: 200, headers: { 'content-type': 'application/json' } });

  const res = await listPayments('sk_test', { from: day(-2), to: day(0) });
  globalThis.fetch = realFetch;

  ok(res.ok, 'a documented response parses');
  ok(res.data.payments.length === 2, 'the row with no id is dropped, not invented', res.data.payments.length + ' rows');
  const tap = res.data.payments.find((p) => p.id === 'p_tap1');
  ok(tap.gross === 115, 'cents become rand', 'gross ' + tap.gross);
  ok(tap.fee === 2.87, 'the processing fee is read and converted', 'fee ' + tap.fee);
  ok(tap.source === 'card_machine', 'an in-person tap is recognisable as one', tap.source);
  ok(tap.cardMachineId === 'cm_till_1', 'and it says which machine');

  // The 31-day cap is theirs, so the sync must walk windows rather than ask for a year.
  const w = windows('2026-01-01', '2026-03-15');
  ok(w.length === 3, 'a long range is split into windows of at most 31 days', w.length + ' windows');
  ok(w[0].from === '2026-01-01' && w[w.length - 1].to === '2026-03-15', 'covering the whole range end to end');
}

// ---- a bad key is refused before it is ever stored --------------------------------
{
  const realFetch = globalThis.fetch;
  // Pass every argument through: dropping the options would turn the PUT below into
  // a GET and the test would be measuring the wrong thing.
  globalThis.fetch = async (...args) => (String(args[0]).includes('api.yoco.com')
    ? new Response('nope', { status: 401 })
    : realFetch(...args));
  const res = await fetch(API + '/businesses/' + BID + '/sales-connection', {
    method: 'PUT', headers: H, body: JSON.stringify({ provider: 'yoco', secret: 'sk_wrong_key_123' }),
  });
  globalThis.fetch = realFetch;
  ok(res.status === 400, 'a key Yoco rejects is not saved', String(res.status));
  const [[n]] = await db.query('SELECT COUNT(*) n FROM payment_connections WHERE account_id = 1');
  ok(Number(n.n) === 0, 'so nothing sits there looking connected while pulling nothing');
}

// ---- VAT comes OUT of the gross, never on top of it -------------------------------
{
  const { taxOutOf } = await import('file:///C:/CC/klippy-v2/api/dist/lib/salesSync.js');
  ok(taxOutOf(115, 15, 'ZAR') === 15,
    'R115 taken at 15% is R15 of VAT, because money received is tax-inclusive', String(taxOutOf(115, 15, 'ZAR')));
  ok(taxOutOf(115, 0, 'ZAR') === 0, 'and a business with no rate set records no VAT');
}

// ---- a hand-entered sale, and what it does to the books ---------------------------
{
  await db.query("UPDATE businesses SET default_tax_rate = '15.00' WHERE id = ?", [BID]);
  const created = await post('/sales', {
    businessId: BID, occurredAt: day(0), gross: 1150, fee: 28.75, reference: 'CASH-1',
  });
  ok(created.status === 201, 'a counter sale can be entered by hand', String(created.status));
  const { id } = await created.json();

  const [[row]] = await db.query('SELECT gross, fee, net, tax_amount FROM sales WHERE id = ?', [id]);
  ok(Number(row.net) === 1121.25, 'net is the gross less the fee', 'net ' + row.net);
  ok(Number(row.tax_amount) === 150, 'and the VAT is backed out of the gross', 'vat ' + row.tax_amount);

  const list = await getj('/sales?from=' + day(-1) + '&to=' + day(1));
  const zar = list.totals.find((t) => t.currency === 'ZAR');
  ok(zar && zar.gross === 1150 && zar.fee === 28.75 && zar.net === 1121.25,
    'the takings screen shows all three figures, not just the gross', JSON.stringify(zar));

  // The whole point: this money reaches the VAT return.
  const vat = await getj('/reports/vat?from=' + day(-1) + '&to=' + day(1));
  const out = (vat.output ?? []).find((o) => o.currency === 'ZAR');
  ok(out && out.outputVat >= 150, 'counter takings appear in the VAT return', out && String(out.outputVat));

  await db.query("UPDATE businesses SET default_tax_rate = NULL WHERE id = ?", [BID]);
}

// ---- a synced sale is not something you can quietly delete ------------------------
{
  const [ins] = await db.query(
    "INSERT INTO sales (account_id, business_id, provider, external_id, occurred_at, currency, gross, fee, net) VALUES (1, ?, 'yoco', 'p_locked', ?, 'ZAR', '500.00', '12.50', '487.50')",
    [BID, new Date()]);
  const res = await fetch(API + '/sales/' + ins.insertId, { method: 'DELETE', headers: { cookie } });
  ok(res.status === 409, 'a card machine sale cannot be deleted by hand', String(res.status));
  const [[still]] = await db.query('SELECT COUNT(*) n FROM sales WHERE id = ?', [ins.insertId]);
  ok(Number(still.n) === 1, 'so real takings cannot be removed from the VAT figures');
}

await clean();
console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURES');
await db.end();
process.exit(failures ? 1 : 0);
