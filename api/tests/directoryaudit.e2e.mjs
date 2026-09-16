/**
 * The directory pre-flight audit.
 *
 * What this proves:
 *
 *   1. EVERY CHECK ACTUALLY FIRES. A clean workspace returns zero on nearly all of them,
 *      and a check that has only ever returned zero has not shown it can find anything.
 *      So each condition is created on purpose and the check has to catch it.
 *   2. IT IS READ-ONLY. Running it changes no row.
 *   3. IT IS FOR OWNERS AND ADMINS. It lists every client's billing details at once.
 *   4. IT SEES ONLY ITS OWN WORKSPACE.
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
const login = async (email, password) => {
  const r = await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  return r.ok ? cookieOf(r) : null;
};

const TAG = 'E2E-DA';
const MEMBER = 'e2e-da-member@example.com';
const clean = async () => {
  await db.query('DELETE FROM portal_users WHERE email LIKE ?', ['e2e-da-%']);
  await db.query('DELETE FROM deals WHERE title LIKE ?', [`${TAG}%`]);
  await db.query('DELETE FROM documents WHERE client_name LIKE ?', [`${TAG}%`]);
  // Children first, or the parent's cascade does it and the count below lies.
  await db.query('DELETE FROM folders WHERE name LIKE ? AND parent_id IS NOT NULL', [`${TAG}%`]);
  await db.query('DELETE FROM folders WHERE name LIKE ?', [`${TAG}%`]);
  await db.query('DELETE m FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ?', [MEMBER]);
  await db.query('DELETE FROM users WHERE email = ?', [MEMBER]);
};
await clean();

const cookie = await login('ruben@x.com', 'klippylook1');
ok(!!cookie, 'owner signs in');
if (!cookie) { await db.end(); process.exit(1); }
const H = { 'content-type': 'application/json', cookie };

const run = async (c = cookie) => {
  const r = await fetch(API + '/admin/directory-audit', { headers: { cookie: c } });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const countOf = (body, key) => body?.checks?.find((c) => c.key === key)?.count ?? -1;
const rowsOf = (body, key) => body?.checks?.find((c) => c.key === key)?.rows ?? [];

// ---- the baseline, before anything is planted ---------------------------------------
const before = (await run()).body;
ok(before?.readOnly === true, 'the report declares itself read-only');

const [[biz]] = await db.query('SELECT id FROM businesses WHERE account_id = 1 ORDER BY position LIMIT 1');
const acct = 1;
const insertFolder = async (name, extra = {}) => {
  const cols = { account_id: acct, business_id: biz.id, name, color: '#6366f1', pillar: 'delivery',
    is_archived: 0, position: 0, ...extra };
  const [r] = await db.query(`INSERT INTO folders (${Object.keys(cols).join(',')}) VALUES (${Object.keys(cols).map(() => '?').join(',')})`,
    Object.values(cols));
  return r.insertId;
};

// ---- plant one of each condition ---------------------------------------------------
// (a) a real client filed under Operations: it has a billing email.
const opsClient = await insertFolder(`${TAG} Ops Client`, { pillar: 'operations', billing_email: 'e2e-da-ops@example.com' });
// A genuine internal area, with nothing billable about it. Must NOT be reported.
const opsReal = await insertFolder(`${TAG} Real Internal`, { pillar: 'operations' });

// (b) billing and company details sitting on a subfolder.
const root = await insertFolder(`${TAG} Root Client`);
const sub = await insertFolder(`${TAG} Sub Project`, { parent_id: root, billing_email: 'e2e-da-sub@example.com', reg_number: '2020/1/07' });

// (d) the same email with two portal logins that both map to the same top-level client.
await db.query(
  `INSERT INTO portal_users (account_id, business_id, folder_id, email, is_active) VALUES (?,?,?,?,1),(?,?,?,?,1)`,
  [acct, biz.id, root, 'e2e-da-dupe@example.com', acct, biz.id, sub, 'E2E-DA-DUPE@example.com']);

// (e) two top-level clients with the same name in one business, differing only in case.
await insertFolder(`${TAG} Twin`);
await insertFolder(`${TAG} twin`);

// (f) a deal pointing at a contact id that does not exist.
const [[maxC]] = await db.query('SELECT COALESCE(MAX(id), 0) + 100000 AS ghost FROM contacts');
await db.query(
  `INSERT INTO deals (account_id, business_id, title, stage, contact_id) VALUES (?,?,?,?,?)`,
  [acct, biz.id, `${TAG} Ghost Deal`, 'lead', maxC.ghost]);

// (c) a document with no client.
await db.query(
  `INSERT INTO documents (account_id, business_id, type, seq, number, client_name, issue_date, currency, status, subtotal, tax_rate, tax_amount, total)
   VALUES (?,?,?,?,?,?,UTC_DATE(),?,?,?,?,?,?)`,
  [acct, biz.id, 'invoice', 999901, 'E2EDA-0001', `${TAG} Walk-in`, 'ZAR', 'draft', '100.00', '0.00', '0.00', '100.00']);

// ---- snapshot every row this report reads, to prove it writes none ------------------
const snapshot = async () => {
  const [[f]] = await db.query('SELECT COUNT(*) n, COALESCE(SUM(CRC32(CONCAT_WS("|",id,name,pillar,IFNULL(billing_email,""),IFNULL(parent_id,"")))),0) h FROM folders WHERE account_id = 1');
  const [[p]] = await db.query('SELECT COUNT(*) n, COALESCE(SUM(is_active),0) a FROM portal_users WHERE account_id = 1');
  const [[d]] = await db.query('SELECT COUNT(*) n, COALESCE(SUM(IFNULL(contact_id,0)),0) c FROM deals WHERE account_id = 1');
  return JSON.stringify({ f, p, d });
};
const snapBefore = await snapshot();
const after = (await run()).body;
const snapAfter = await snapshot();
ok(snapBefore === snapAfter, 'running the audit changes nothing it reads');

// ---- every check has to catch what was planted --------------------------------------
{
  const a = rowsOf(after, 'a');
  ok(a.some((r) => r.folderId === opsClient),
    '(a) a client filed as internal work is caught, because it has a billing email');
  ok(!a.some((r) => r.folderId === opsReal),
    '(a) and a genuine internal area with nothing billable is NOT reported');

  const b = rowsOf(after, 'b').find((r) => r.folderId === sub);
  ok(!!b, '(b) billing details sitting on a subfolder are caught');
  ok(b?.rootFolderId === root, '(b) and traced to the top-level client they belong to', String(b?.rootFolderId));
  ok(b?.fieldsSet?.includes('billingEmail') && b?.fieldsSet?.includes('regNumber'),
    '(b) naming exactly which fields are set, including the new company ones', (b?.fieldsSet ?? []).join(','));

  ok(countOf(after, 'c-documents') === countOf(before, 'c-documents') + 1,
    '(c) a quote or invoice with no client is counted',
    `${countOf(before, 'c-documents')} -> ${countOf(after, 'c-documents')}`);

  const d = rowsOf(after, 'd').find((r) => r.email === 'e2e-da-dupe@example.com');
  ok(!!d, '(d) one email with two portal logins for the same client is caught');
  ok(d?.rootFolderId === root && d?.logins === 2,
    '(d) even though the logins sit on the client and its subfolder, and differ in case',
    d ? `root ${d.rootFolderId}, ${d.logins} logins` : 'missing');

  const e = rowsOf(after, 'e').find((r) => r.name.toLowerCase() === `${TAG} twin`.toLowerCase());
  ok(!!e && e.folderIds.length === 2, '(e) two clients with the same name in one business are listed, case-insensitively');

  const f = rowsOf(after, 'f').find((r) => r.title === `${TAG} Ghost Deal`);
  // Number(): mysql2 returns the arithmetic above as a STRING, and the API returns a
  // number, so a strict compare would fail on perfectly correct data.
  ok(!!f && f.missingContactId === Number(maxC.ghost), '(f) a deal pointing at a contact that does not exist is caught',
    f ? `contact ${f.missingContactId}` : 'missing');
}

// ---- no silent cap -----------------------------------------------------------------
{
  const every = after?.checks ?? [];
  ok(every.length > 0 && every.every((c) => c.shown <= c.count && c.rows.length === c.shown),
    'every list says how many exist and how many are shown, so a capped list cannot pass for a full one');
}

// ---- owners and admins only ---------------------------------------------------------
{
  const mk = await fetch(API + '/users', {
    method: 'POST', headers: H,
    body: JSON.stringify({ email: MEMBER, name: 'Audit Member', password: 'memberpass123', role: 'member' }),
  });
  ok(mk.ok, 'a member is added', String(mk.status));
  const memberCookie = await login(MEMBER, 'memberpass123');
  const asMember = await run(memberCookie);
  ok(asMember.status === 403, 'a member is refused, since this lists every client\'s billing details', String(asMember.status));

  const noSession = await fetch(API + '/admin/directory-audit');
  ok(noSession.status === 401, 'and so is nobody at all', String(noSession.status));
}

// ---- it sees only its own workspace -------------------------------------------------
{
  const [others] = await db.query(
    `SELECT id FROM folders WHERE account_id <> 1 AND parent_id IS NULL AND pillar = 'operations' AND billing_email IS NOT NULL`);
  const ids = new Set(others.map((r) => r.id));
  ok(!rowsOf(after, 'a').some((r) => ids.has(r.folderId)),
    "no other workspace's folders appear in the report", `${ids.size} foreign candidates exist`);
}

await clean();
await db.end();
console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURES');
process.exit(failures ? 1 : 0);
