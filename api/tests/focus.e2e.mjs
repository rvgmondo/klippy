/**
 * The Eisenhower Home matrix.
 *
 * Proves the half that has to be automatic really is: urgency computed from dates
 * Klippy already holds, across every business, with importance the only thing stored.
 *
 * Run with a test server on 8095:  node tests/focus.e2e.mjs
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

const TAG = 'E2E Focus';
const clean = async () => {
  await db.query('DELETE FROM focus_items WHERE account_id = 1');
  await db.query('DELETE FROM documents WHERE client_name LIKE ?', [TAG + '%']);
  await db.query('DELETE FROM deals WHERE title LIKE ?', [TAG + '%']);
  await db.query('DELETE t FROM tasks t JOIN boards b ON b.id = t.board_id JOIN folders f ON f.id = b.folder_id WHERE f.name LIKE ?', [TAG + '%']);
  await db.query('DELETE b FROM boards b JOIN folders f ON f.id = b.folder_id WHERE f.name LIKE ?', [TAG + '%']);
  await db.query('DELETE FROM folders WHERE name LIKE ?', [TAG + '%']);
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
const getFocus = () => fetch(API + '/focus', { headers: { cookie } }).then((r) => r.json());
const post = (p, b) => fetch(API + p, { method: 'POST', headers: H, body: JSON.stringify(b ?? {}) });
const patch = (p, b) => fetch(API + p, { method: 'PATCH', headers: H, body: JSON.stringify(b ?? {}) });

const day = (n) => {
  const d = new Date(); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const today = day(0);
const [[biz]] = await db.query('SELECT id FROM businesses WHERE account_id = 1 ORDER BY position LIMIT 1');
const BID = biz.id;

// ---- seed one of every urgent thing ------------------------------------------
const [f] = await db.query('INSERT INTO folders (account_id, business_id, name) VALUES (1, ?, ?)', [BID, TAG + ' Client']);
const [b] = await db.query('INSERT INTO boards (account_id, folder_id, name) VALUES (1, ?, ?)', [f.insertId, TAG + ' Board']);
const [col] = await db.query('INSERT INTO board_columns (account_id, board_id, name, position) VALUES (1, ?, ?, 0)', [b.insertId, 'To do']);
const [t] = await db.query(
  'INSERT INTO tasks (account_id, board_id, column_id, title, due_date) VALUES (1, ?, ?, ?, ?)',
  [b.insertId, col.insertId, TAG + ' overdue card', day(-2)]);
await db.query(
  "INSERT INTO documents (account_id, business_id, type, seq, number, client_name, issue_date, due_date, currency, status, tax_rate, subtotal, tax_amount, total) VALUES (1, ?, 'invoice', 9801, 'E2E-INV-1', ?, ?, ?, 'ZAR', 'sent', '15.00', '1000.00', '150.00', '1150.00')",
  [BID, TAG + ' Payer', day(-30), day(-9)]);
await db.query(
  "INSERT INTO documents (account_id, business_id, type, seq, number, client_name, issue_date, due_date, currency, status, tax_rate, subtotal, tax_amount, total) VALUES (1, ?, 'quote', 9802, 'E2E-QUO-1', ?, ?, ?, 'ZAR', 'sent', '15.00', '5000.00', '750.00', '5750.00')",
  [BID, TAG + ' Prospect', today, day(3)]);
await db.query(
  "INSERT INTO deals (account_id, business_id, title, company, stage, value, next_follow_up_at, follow_up_note) VALUES (1, ?, ?, ?, 'contacted', '0.00', ?, 'Promised a call')",
  [BID, TAG + ' Deal', TAG + ' Co', day(-1)]);

// ---- the urgent side fills itself in -----------------------------------------
{
  const d = await getFocus();
  const now = d.quadrants.now;
  const kinds = new Set(now.map((i) => i.kind));
  ok(kinds.has('task'), 'a card past its due date lands on the matrix on its own');
  ok(kinds.has('invoice'), 'so does an overdue invoice');
  ok(kinds.has('quote'), 'so does a quote about to expire');
  ok(kinds.has('deal'), 'so does a follow-up that was promised and reached');
  ok(now.every((i) => i.urgent && i.important),
    'every one arrives urgent and important, so nothing needs sorting before it is useful');

  const inv = now.find((i) => i.kind === 'invoice');
  ok(inv.overdueBy === 9, 'the invoice knows how overdue it is', 'overdueBy ' + inv.overdueBy);
  ok(/owes ZAR/.test(inv.title), 'and says what is owed in plain words', inv.title);
  ok(now[0].overdueBy >= now[now.length - 1].overdueBy, 'the most overdue thing sorts first');
  ok(now.every((i) => i.businessId === BID), 'each item carries its business, for the colour dot');
  ok(d.counts.real === 0, 'the real-work quadrant starts empty, which is the point of showing it');
}

// ---- importance is the one judgement that is stored ---------------------------
{
  const before = await getFocus();
  const card = before.quadrants.now.find((i) => i.kind === 'task');
  const res = await patch('/focus/judge', { kind: 'task', refId: card.refId, important: false });
  ok(res.ok, 'a card can be judged not important', String(res.status));

  const after = await getFocus();
  ok(!after.quadrants.now.some((i) => i.key === card.key), 'it leaves the do-today quadrant');
  ok(after.quadrants.quick.some((i) => i.key === card.key),
    'and moves to fast-or-automate: still urgent, no longer important');

  await patch('/focus/judge', { kind: 'task', refId: card.refId, important: false });
  const [[n]] = await db.query(
    "SELECT COUNT(*) n FROM focus_items WHERE account_id = 1 AND kind = 'task' AND ref_id = ?", [card.refId]);
  ok(Number(n.n) === 1, 'judging twice leaves one stored opinion, not two', n.n + ' rows');

  await patch('/focus/judge', { kind: 'task', refId: card.refId, important: true });
  const back = await getFocus();
  ok(back.quadrants.now.some((i) => i.key === card.key), 'and it can be moved back');
}

// ---- the real work: the quadrant fed by hand ----------------------------------
{
  const created = await post('/focus', { title: TAG + ' land 2 Growth clients', businessId: BID });
  ok(created.status === 201, 'something with no deadline can be added by hand', String(created.status));
  const { id } = await created.json();

  const d = await getFocus();
  const mine = d.quadrants.real.find((i) => i.refId === id);
  ok(!!mine, 'it lands in the real-work quadrant, not among the fires');
  ok(mine.urgent === false, 'with no date it is never urgent');

  await patch('/focus/' + id, { dueDate: day(-1) });
  const withDate = await getFocus();
  ok(withDate.quadrants.now.some((i) => i.refId === id), 'giving it a date is what makes it urgent');
  await patch('/focus/' + id, { dueDate: null });

  await patch('/focus/' + id, { important: false });
  const demoted = await getFocus();
  ok(demoted.quadrants.later.some((i) => i.refId === id), 'demoting it drops it into let-it-go');

  const done = await post('/focus/' + id + '/done');
  ok(done.ok, 'a hand-written item can be ticked off');
  const gone = await getFocus();
  ok(!gone.quadrants.later.some((i) => i.refId === id), 'and it leaves the page');
}

// ---- nothing is copied: the page follows the real records ---------------------
{
  await db.query("UPDATE documents SET status = 'paid' WHERE number = 'E2E-INV-1'");
  const d = await getFocus();
  ok(!d.quadrants.now.some((i) => i.kind === 'invoice'),
    'paying the invoice takes it off the matrix with no extra step');

  await db.query('UPDATE tasks SET is_completed = 1 WHERE id = ?', [t.insertId]);
  const d2 = await getFocus();
  ok(!d2.quadrants.now.some((i) => i.kind === 'task'), 'completing the card takes it off too');
}

// ---- what is OWED, not the face value ----------------------------------------
{
  const [[inv]] = await db.query("SELECT id FROM documents WHERE number = 'E2E-INV-1'");
  await db.query("UPDATE documents SET status = 'sent' WHERE id = ?", [inv.id]);
  await db.query(
    "INSERT INTO payments (account_id, document_id, amount, paid_on, method) VALUES (1, ?, '900.00', ?, 'EFT')",
    [inv.id, today]);
  const d = await getFocus();
  const row = d.quadrants.now.find((i) => i.kind === 'invoice');
  ok(!!row, 'a part-paid overdue invoice is still on the matrix');
  ok(row && row.title.includes('250.00') && !row.title.includes('1,150'),
    'and it shows what is STILL OWED, not the face value', row && row.title);

  await db.query(
    "INSERT INTO payments (account_id, document_id, amount, paid_on, method) VALUES (1, ?, '250.00', ?, 'EFT')",
    [inv.id, today]);
  const after = await getFocus();
  ok(!after.quadrants.now.some((i) => i.kind === 'invoice'),
    'once it is covered it leaves the matrix, with no status change needed');
  await db.query('DELETE FROM payments WHERE document_id = ?', [inv.id]);
}

// ---- judging something you cannot see -----------------------------------------
{
  const [b2] = await db.query(
    "INSERT INTO businesses (account_id, name, secondary_types) VALUES (1, ?, '[]')", [TAG + ' Hidden']);
  const [other] = await db.query(
    "INSERT INTO documents (account_id, business_id, type, seq, number, client_name, issue_date, due_date, currency, status, tax_rate, subtotal, tax_amount, total) VALUES (1, ?, 'invoice', 9803, 'E2E-HIDDEN-1', ?, ?, ?, 'ZAR', 'sent', '15.00', '100.00', '15.00', '115.00')",
    [b2.insertId, TAG + ' Hidden Co', day(-30), day(-5)]);

  const memberEmail = 'e2e-focus-member@test.local';
  await db.query('DELETE bm FROM business_members bm JOIN users u ON u.id = bm.user_id WHERE u.email = ?', [memberEmail]);
  await db.query('DELETE m FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ?', [memberEmail]);
  await db.query('DELETE FROM users WHERE email = ?', [memberEmail]);
  const mk = await post('/users', { email: memberEmail, name: 'Focus Member', password: 'memberpass123' });
  const MID = (await mk.json()).user?.id;
  ok(!!MID, 'a scoped member exists to test with');
  const [[mainBiz]] = await db.query('SELECT id FROM businesses WHERE account_id = 1 ORDER BY position LIMIT 1');
  await db.query("INSERT INTO business_members (account_id, business_id, user_id, role) VALUES (1, ?, ?, 'member')",
    [mainBiz.id, MID]);

  const ml = await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: memberEmail, password: 'memberpass123' }),
  });
  const mCookie = cookieOf(ml);
  const blocked = await fetch(API + '/focus/judge', {
    method: 'PATCH', headers: { 'content-type': 'application/json', cookie: mCookie },
    body: JSON.stringify({ kind: 'invoice', refId: other.insertId, important: false }),
  });
  ok(blocked.status === 404 || blocked.status === 403,
    'a member cannot judge an invoice in a business they cannot see', String(blocked.status));
  const [[stored]] = await db.query(
    "SELECT COUNT(*) n FROM focus_items WHERE kind = 'invoice' AND ref_id = ?", [other.insertId]);
  ok(Number(stored.n) === 0, 'and no opinion about it was stored');

  await db.query('DELETE FROM documents WHERE id = ?', [other.insertId]);
  await db.query('DELETE FROM business_members WHERE user_id = ?', [MID]);
  await db.query('DELETE FROM memberships WHERE user_id = ?', [MID]);
  await db.query('DELETE FROM users WHERE id = ?', [MID]);
  await db.query('DELETE FROM businesses WHERE id = ?', [b2.insertId]);
}

await clean();
console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURES');
await db.end();
process.exit(failures ? 1 : 0);
