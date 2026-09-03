/**
 * Did this business make money.
 *
 * Klippy could not answer that until both halves of both sides existed. Revenue meant
 * invoices, so a shop selling over a counter appeared to earn nothing; costs meant
 * one-off expenses, so every standing cost was missing. This pins the arithmetic, and
 * a wrong profit figure is worse than no profit figure.
 *
 * What is checked:
 *   - earned counts invoices AND counter takings, since a retailer has no invoices
 *   - a credit note comes OFF, so a refunded month reads as the refund
 *   - a refunded taking is not revenue
 *   - card and gateway fees are counted as a cost, not quietly dropped
 *   - earned is not received, and the gap is reported rather than hidden
 *   - currencies are never summed together
 *
 * Run with a test server on 8095 started with AUTH_RATE_LIMIT_MAX raised.
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
  await db.query("DELETE p FROM payments p JOIN documents d ON d.id = p.document_id WHERE d.number LIKE 'E2E-P%'");
  await db.query("DELETE FROM documents WHERE account_id = 1 AND number LIKE 'E2E-P%'");
  await db.query("DELETE FROM sales WHERE account_id = 1 AND reference LIKE 'E2E-P%'");
  await db.query("DELETE FROM expenses WHERE account_id = 1 AND description LIKE 'E2E-P%'");
};
await clean();

const lr = await fetch(API + '/auth/login', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'ruben@x.com', password: 'klippylook1' }),
});
const cookie = cookieOf(lr);
ok(lr.ok && !!cookie, 'owner signs in');
if (!cookie) { await db.end(); process.exit(1); }

const [[biz]] = await db.query('SELECT id, currency FROM businesses WHERE account_id = 1 ORDER BY position LIMIT 1');
const BID = biz.id;
const CUR = biz.currency || 'ZAR';
const today = new Date().toISOString().slice(0, 10);
const getj = (p) => fetch(API + p, { headers: { cookie } }).then((r) => r.json());

// ---- both halves of both sides ----------------------------------------------------
{
  // Invoiced work: 10,000. One credit note of 1,000 against it.
  await db.query(
    "INSERT INTO documents (account_id,business_id,type,seq,number,status,issue_date,currency,subtotal,tax_amount,total,client_name) VALUES (1,?,'invoice',991001,'E2E-P-INV1','sent',?,?,'10000.00','0.00','10000.00','Client A')",
    [BID, today, CUR]);
  const [[inv]] = await db.query("SELECT id FROM documents WHERE number = 'E2E-P-INV1'");
  await db.query(
    "INSERT INTO documents (account_id,business_id,type,seq,number,status,issue_date,currency,subtotal,tax_amount,total,client_name) VALUES (1,?,'credit_note',991002,'E2E-P-CN1','sent',?,?,'1000.00','0.00','1000.00','Client A')",
    [BID, today, CUR]);

  // Counter takings: 5,000 gross with 125 of card fee, and one 500 refund.
  await db.query(
    "INSERT INTO sales (account_id,business_id,provider,external_id,occurred_at,currency,gross,fee,net,refunded,reference) VALUES (1,?,'manual',NULL,NOW(),?,'5000.00','125.00','4875.00','500.00','E2E-P-SALE1')",
    [BID, CUR]);

  // Costs: 2,000 of expenses.
  await db.query(
    "INSERT INTO expenses (account_id,business_id,description,amount,incurred_on) VALUES (1,?,'E2E-P Rent','2000.00',?)",
    [BID, today]);

  // A part payment against the invoice, with a gateway fee.
  await db.query(
    "INSERT INTO payments (account_id,document_id,amount,fee_amount,paid_on,method) VALUES (1,?,'4000.00','80.00',?,'card')",
    [inv.id, today]);

  const rep = await getj(`/reports/profit?from=${today}&to=${today}&businessId=${BID}`);
  const r = (rep.rows ?? []).find((x) => x.businessId === BID && x.currency === CUR);
  ok(!!r, 'the business has a profit row', JSON.stringify(rep.rows?.map((x) => x.currency)));
  if (!r) { await clean(); await db.end(); process.exit(1); }

  ok(r.invoiced === 9000, 'a credit note comes off what was invoiced', String(r.invoiced));
  ok(r.taken === 4500, 'a refunded taking is not revenue', String(r.taken));
  ok(r.earned === 13500, 'earned counts invoiced work AND counter takings', String(r.earned));

  ok(r.fees === 205, 'card and gateway fees are both counted as a cost', String(r.fees));
  ok(r.expenses === 2000, 'expenses are counted', String(r.expenses));
  ok(r.spent === 2205, 'spent is expenses plus fees', String(r.spent));

  ok(r.profit === 11295, 'profit is earned minus spent', String(r.profit));
  ok(r.margin === 83.7, 'and the margin is reported', String(r.margin));

  // Received: 4,000 paid against the invoice plus 4,500 taken over the counter.
  ok(r.received === 8500, 'received is money actually in, not money earned', String(r.received));
  ok(r.awaited === 5000,
    'and the gap is reported, which is what explains a good month with an empty account',
    String(r.awaited));
}

// ---- currencies are never added together ------------------------------------------
{
  const other = CUR === 'USD' ? 'EUR' : 'USD';
  await db.query(
    "INSERT INTO documents (account_id,business_id,type,seq,number,status,issue_date,currency,subtotal,tax_amount,total,client_name) VALUES (1,?,'invoice',991003,'E2E-P-INV2','sent',?,?,'700.00','0.00','700.00','Client B')",
    [BID, today, other]);

  const rep = await getj(`/reports/profit?from=${today}&to=${today}&businessId=${BID}`);
  const mine = (rep.rows ?? []).filter((x) => x.businessId === BID);
  ok(mine.length === 2, 'a second currency gets its own row, not a bigger number', String(mine.length));
  const home = mine.find((x) => x.currency === CUR);
  const foreign = mine.find((x) => x.currency === other);
  ok(home && home.earned === 13500, 'the home currency total is untouched by it', home && String(home.earned));
  ok(foreign && foreign.earned === 700, 'and the other currency stands on its own', foreign && String(foreign.earned));
}

await clean();
console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURES');
await db.end();
process.exit(failures ? 1 : 0);
