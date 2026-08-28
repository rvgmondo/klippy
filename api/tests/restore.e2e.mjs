/**
 * Restore: reading a backup back in.
 *
 * The acceptance bar is a round trip. Build a workspace, export it, restore it into
 * a brand new one, export THAT, and the two exports have to agree on everything
 * except ids and the date stamp. Until that passes, the backup is a document rather
 * than a restore path.
 *
 * Also pins the refusals, which are the whole safety of the feature: it will not
 * merge into a live workspace, it will not arm a money path on the way in, and it
 * will not claim anything about the real hosting server.
 *
 * Run with a test server on 8095:  node tests/restore.e2e.mjs
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

const tag = String(Date.now()).slice(-7);
const srcEmail = 'restore.src.' + tag + '@test.local';
const dstEmail = 'restore.dst.' + tag + '@test.local';
const liveEmail = 'restore.live.' + tag + '@test.local';

const signup = async (name, email) => {
  const r = await fetch(API + '/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accountName: name, name, email, password: 'restorepass123' }),
  });
  return { ok: r.ok, cookie: cookieOf(r) };
};
const get = (cookie, p) => fetch(API + p, { headers: { cookie } });
const post = (cookie, p, b) => fetch(API + p, {
  method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(b ?? {}),
});

const day = (n) => {
  const d = new Date(); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const today = day(0);

// ---- a source workspace with real content in it ------------------------------
const src = await signup('Restore Source ' + tag, srcEmail);
ok(src.ok && src.cookie, 'source workspace created');
const [[srcAcc]] = await db.query(
  'SELECT m.account_id a, u.id u FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ?', [srcEmail]);
const SRC = srcAcc.a;
const [[srcBiz]] = await db.query('SELECT id FROM businesses WHERE account_id = ? ORDER BY position LIMIT 1', [SRC]);

const [f] = await db.query('INSERT INTO folders (account_id, business_id, name, billing_email, hourly_rate) VALUES (?, ?, ?, ?, ?)',
  [SRC, srcBiz.id, 'Verboten Spirits', 'pay@verboten.test', '950.00']);
const [b] = await db.query('INSERT INTO boards (account_id, folder_id, name) VALUES (?, ?, ?)', [SRC, f.insertId, 'Delivery']);
const [col] = await db.query('INSERT INTO board_columns (account_id, board_id, name, position) VALUES (?, ?, ?, 0)', [SRC, b.insertId, 'Doing']);
const [t] = await db.query('INSERT INTO tasks (account_id, board_id, column_id, title, due_date) VALUES (?, ?, ?, ?, ?)',
  [SRC, b.insertId, col.insertId, 'Ship the label artwork', day(-3)]);
await db.query('INSERT INTO task_subtasks (account_id, task_id, title, position) VALUES (?, ?, ?, 0)', [SRC, t.insertId, 'Proof the bottle']);
await db.query('INSERT INTO task_comments (account_id, task_id, user_id, comment) VALUES (?, ?, ?, ?)',
  [SRC, t.insertId, srcAcc.u, 'Client approved the gold foil.']);
await db.query('INSERT INTO time_entries (account_id, task_id, user_id, start_time, duration_seconds) VALUES (?, ?, ?, ?, 5400)',
  [SRC, t.insertId, srcAcc.u, new Date()]);
const [o] = await db.query("INSERT INTO offerings (account_id, business_id, name, price, recurring) VALUES (?, ?, 'Care Plan', '2500.00', 1)", [SRC, srcBiz.id]);
const [s] = await db.query(
  `INSERT INTO subscriptions (account_id, business_id, offering_id, folder_id, status, price, auto_debit, payfast_token, domain, interval_months, started_on, next_bill_date)
   VALUES (?, ?, ?, ?, 'active', '2500.00', 1, 'LIVE-CARD-TOKEN', 'verboten.co.za', 1, ?, ?)`,
  [SRC, srcBiz.id, o.insertId, f.insertId, day(-200), day(-120)]);
await db.query(
  "INSERT INTO hosting_accounts (account_id, business_id, subscription_id, domain, username, status) VALUES (?, ?, ?, 'verboten.co.za', 'verbo', 'active')",
  [SRC, srcBiz.id, s.insertId]);
const [d1] = await db.query(
  `INSERT INTO documents (account_id, business_id, folder_id, type, seq, number, client_name, issue_date, due_date, currency, status, tax_rate, subtotal, tax_amount, total)
   VALUES (?, ?, ?, 'invoice', 41, 'INV-0041', 'Verboten Spirits', ?, ?, 'ZAR', 'sent', '15.00', '10000.00', '1500.00', '11500.00')`,
  [SRC, srcBiz.id, f.insertId, day(-20), day(-6)]);
await db.query("INSERT INTO document_lines (account_id, document_id, description, quantity, unit_price, amount, position) VALUES (?, ?, 'Label design', '1.00', '10000.00', '10000.00', 0)", [SRC, d1.insertId]);
await db.query('INSERT INTO payments (account_id, document_id, amount, paid_on, method, pf_payment_id) VALUES (?, ?, ?, ?, ?, ?)',
  [SRC, d1.insertId, '4000.00', today, 'PayFast', 'PF-LIVE-' + tag]);
await db.query("INSERT INTO focus_items (account_id, business_id, kind, ref_id, important) VALUES (?, ?, 'invoice', ?, 0)", [SRC, srcBiz.id, d1.insertId]);
await db.query("INSERT INTO focus_items (account_id, business_id, kind, title, important) VALUES (?, ?, 'manual', 'Land 2 Growth clients', 1)", [SRC, srcBiz.id]);

// ---- export it ----------------------------------------------------------------
const expRes = await get(src.cookie, '/account/export');
ok(expRes.ok, 'the source workspace exports', String(expRes.status));
const backup = await expRes.json();
ok(backup.schemaVersion >= 3, 'the backup stamps its shape version', String(backup.schemaVersion));
ok(!JSON.stringify(backup).includes('LIVE-CARD-TOKEN'), 'the saved card token is NOT in the backup');
ok(Array.isArray(backup.people) && backup.people.length >= 1, 'the backup names the team, so work can be attributed on the way back');

// ---- refusals -----------------------------------------------------------------
{
  // A workspace with real work in it must refuse, and change nothing.
  const live = await signup('Restore Live ' + tag, liveEmail);
  const [[liveAcc]] = await db.query(
    'SELECT m.account_id a FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ?', [liveEmail]);
  const [[liveBiz]] = await db.query('SELECT id FROM businesses WHERE account_id = ? ORDER BY position LIMIT 1', [liveAcc.a]);
  await db.query('INSERT INTO folders (account_id, business_id, name) VALUES (?, ?, ?)', [liveAcc.a, liveBiz.id, 'A Real Client']);
  const before = await db.query('SELECT COUNT(*) n FROM folders WHERE account_id = ?', [liveAcc.a]);
  const refused = await post(live.cookie, '/account/import', { data: backup });
  ok(refused.status === 409, 'restoring into a workspace with real work is refused', String(refused.status));
  const msg = (await refused.json()).error ?? '';
  ok(/nothing was changed/i.test(msg), 'and it says plainly that nothing changed', msg.slice(0, 70));
  const after = await db.query('SELECT COUNT(*) n FROM folders WHERE account_id = ?', [liveAcc.a]);
  ok(before[0][0].n === after[0][0].n, 'the live workspace really was untouched');
}

// ---- restore into a brand new workspace ---------------------------------------
const dst = await signup('Restore Target ' + tag, dstEmail);
ok(dst.ok && dst.cookie, 'target workspace created');
const [[dstAcc]] = await db.query(
  'SELECT m.account_id a, u.id u FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ?', [dstEmail]);
const DST = dstAcc.a;

const impRes = await post(dst.cookie, '/account/import', { data: backup });
const report = await impRes.json();
ok(impRes.ok, 'the restore runs', String(impRes.status) + ' ' + (report.error ?? ''));
ok((report.counts?.documents ?? 0) === (backup.documents?.length ?? -1),
  'every document came back', JSON.stringify(report.counts?.documents));

// ---- the money is disarmed -----------------------------------------------------
{
  const [[sub]] = await db.query('SELECT auto_debit, payfast_token, next_bill_date, domain FROM subscriptions WHERE account_id = ?', [DST]);
  ok(Number(sub.auto_debit) === 0, 'auto-debit is OFF on the restored subscription');
  ok(sub.payfast_token === null, 'and there is no saved card to charge');
  ok(String(sub.next_bill_date).slice(0, 10) >= today || new Date(sub.next_bill_date) >= new Date(today),
    'the billing date is pulled up to today, so no backlog fires', String(sub.next_bill_date));
  ok(sub.domain === 'verboten.co.za', 'the domain survives, so a rebuild cannot double-provision');

  const [[pay]] = await db.query('SELECT pf_payment_id, amount FROM payments WHERE account_id = ?', [DST]);
  ok(pay.pf_payment_id === null, 'the gateway payment id is dropped, so a real notification is not mistaken for a duplicate');
  ok(Number(pay.amount) === 4000, 'but the payment itself is restored in full');
}

// ---- hosting is a record, not a claim ------------------------------------------
{
  const [[h]] = await db.query('SELECT status, domain, detail FROM hosting_accounts WHERE account_id = ?', [DST]);
  ok(h.status === 'pending', 'hosting comes back as pending, never active', h.status);
  ok(/check this against your whm/i.test(h.detail ?? ''), 'and says it needs checking against the server');
  ok(h.domain === 'verboten.co.za', 'with the domain intact so it can be found');
}

// ---- the round trip -------------------------------------------------------------
{
  const exp2 = await (await get(dst.cookie, '/account/export')).json();
  const shape = (e) => {
    const out = {};
    for (const [k, v] of Object.entries(e)) if (Array.isArray(v)) out[k] = v.length;
    return out;
  };
  const a = shape(backup); const bshape = shape(exp2);
  // Every table must match exactly. `businesses` is the one allowed difference, and
  // only by exactly one: the workspace's own starter business, which is deliberately
  // left in place rather than deleted (see below).
  const differing = Object.keys(a).filter((k) => k !== 'businesses' && a[k] !== bshape[k]);
  ok(differing.length === 0, 'every table round-trips with the same number of rows',
    differing.map((k) => k + ' ' + a[k] + '->' + bshape[k]).join(', ') || 'identical');

  const client = exp2.clients.find((c) => c.name === 'Verboten Spirits');
  ok(!!client, 'the client is back by name');
  ok(client && client.billingEmail === 'pay@verboten.test' && String(client.hourlyRate) === '950.00',
    'with its billing email and rate intact');
  // The SOURCE workspace genuinely had the signup samples in it, so a faithful
  // restore brings them back; what must not survive is the TARGET's own starter
  // business sitting empty beside the restored ones.
  // The target's own starter business is deliberately LEFT in place: deleting it
  // would cascade away business_email, business_members and the payment, hosting and
  // messaging settings, so a founder who configured their gateway before restoring
  // would silently lose it. The report says it is there instead.
  ok(exp2.businesses.length === backup.businesses.length + 1,
    'the restored businesses arrive alongside the one this workspace already had',
    backup.businesses.length + ' -> ' + exp2.businesses.length);
  ok((report.notes ?? []).some((n) => /own empty business/i.test(n)),
    'and the report says the empty one is still there');

  const inv = exp2.documents.find((d) => d.number === 'INV-0041');
  ok(!!inv && String(inv.total) === '11500.00' && String(inv.taxAmount) === '1500.00' && inv.seq === 41,
    'the invoice is back with its number, sequence and figures', inv && inv.total);
  ok(exp2.documentLines.length === backup.documentLines.length, 'its lines came with it');

  const comment = exp2.comments[0];
  ok(comment && /gold foil/.test(comment.comment), 'card comments survive');
  ok(exp2.timeEntries[0] && exp2.timeEntries[0].durationSeconds === 5400, 'tracked time survives to the second');
  ok(exp2.subtasks.length === backup.subtasks.length, 'subtasks survive');

  // The matrix judgement has to follow the invoice to its NEW id.
  const judged = exp2.focus.find((x) => x.kind === 'invoice');
  ok(!!judged && judged.refId === inv.id,
    'a matrix judgement is remapped onto the restored invoice, not left pointing at a stale id',
    judged && (judged.refId + ' vs ' + inv.id));
  ok(exp2.focus.some((x) => x.kind === 'manual' && x.title === 'Land 2 Growth clients'),
    'and hand-written matrix items come back');
}

// ---- people ---------------------------------------------------------------------
{
  ok(report.reattributed > 0, 'work owned by somebody not in this workspace is counted, not hidden',
    'reattributed ' + report.reattributed);
  ok(typeof report.reattributedTo === 'string' && report.reattributedTo.includes(dstEmail.split('@')[0]),
    'and the report names who it went to', report.reattributedTo);
  ok((report.notes ?? []).some((n) => /tracked time/i.test(n)),
    'with a warning to check tracked time before invoicing from it');
}

// ---- cleanup ---------------------------------------------------------------------
for (const e of [srcEmail, dstEmail, liveEmail]) {
  const [[u]] = await db.query('SELECT id FROM users WHERE email = ?', [e]);
  if (!u) continue;
  const [accs] = await db.query('SELECT account_id a FROM memberships WHERE user_id = ?', [u.id]);
  for (const a of accs) await db.query('DELETE FROM accounts WHERE id = ?', [a.a]);
  await db.query('DELETE FROM users WHERE id = ?', [u.id]);
}
console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURES');
await db.end();
process.exit(failures ? 1 : 0);
