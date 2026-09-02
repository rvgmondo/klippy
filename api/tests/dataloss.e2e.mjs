/**
 * Data-loss regression suite (audit batch 4).
 *
 * The paths that destroy things, or keep charging things that should have stopped:
 * the Trash purge and its nightly sweep, the cascades with no grace period at all,
 * billing a client who is in the Trash, and what the backup actually contains.
 *
 * Run against the dev database with a test server on 8095:
 *   node tests/dataloss.e2e.mjs
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
const ok = (c, label, extra = '') => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${label}${extra ? `  [${extra}]` : ''}`);
  if (!c) failures++;
};
const cookieOf = (r) => (r.headers.getSetCookie?.() ?? [r.headers.get('set-cookie')])
  .filter(Boolean).map((c) => c.split(';')[0]).join('; ');

const TAG = 'E2E DataLoss';
const clean = async () => {
  await db.query("DELETE FROM hosting_accounts WHERE domain LIKE 'e2e-dataloss%'");
  await db.query("DELETE s FROM subscriptions s JOIN folders f ON f.id = s.folder_id WHERE f.name LIKE ?", [`${TAG}%`]);
  await db.query("DELETE FROM offerings WHERE name LIKE ?", [`${TAG}%`]);
  await db.query("DELETE FROM folders WHERE name LIKE ?", [`${TAG}%`]);
  await db.query("DELETE FROM businesses WHERE name LIKE ?", [`${TAG}%`]);
};
await clean();

const lr = await fetch(`${API}/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'ruben@x.com', password: 'klippylook1' }),
});
const cookie = cookieOf(lr);
ok(lr.ok && cookie, 'owner signs in');
if (!cookie) { console.log('\ncannot proceed'); await db.end(); process.exit(1); }
const H = { 'content-type': 'application/json', cookie };
const post = (p, b) => fetch(`${API}${p}`, { method: 'POST', headers: H, body: JSON.stringify(b ?? {}) });
// No content-type header: a DELETE with no body but a JSON content-type is rejected
// by the parser as an empty body before it ever reaches the route.
const del = (p) => fetch(`${API}${p}`, { method: 'DELETE', headers: { cookie } });

const [[biz]] = await db.query('SELECT id FROM businesses WHERE account_id = 1 ORDER BY position LIMIT 1');
const BID = biz.id;
const today = new Date().toISOString().slice(0, 10);

// Build a client with a subscription and a LIVE hosting account.
const mkClient = async (name, { hosting = 'active', trashed = false } = {}) => {
  const [f] = await db.query(
    'INSERT INTO folders (account_id, business_id, name, deleted_at) VALUES (1, ?, ?, ?)',
    [BID, `${TAG} ${name}`, trashed ? new Date() : null]);
  const [o] = await db.query(
    "INSERT INTO offerings (account_id, business_id, name, price, recurring) VALUES (1, ?, ?, '500.00', 1)",
    [BID, `${TAG} Offering ${name}`]);
  const [s] = await db.query(
    `INSERT INTO subscriptions (account_id, business_id, offering_id, folder_id, status, interval_months, started_on, next_bill_date)
     VALUES (1, ?, ?, ?, 'active', 1, ?, ?)`,
    [BID, o.insertId, f.insertId, today, today]);
  let hostingId = null;
  if (hosting) {
    const [h] = await db.query(
      "INSERT INTO hosting_accounts (account_id, business_id, subscription_id, domain, username, status) VALUES (1, ?, ?, ?, 'e2euser', ?)",
      [BID, s.insertId, `e2e-dataloss-${name}.co.za`, hosting]);
    hostingId = h.insertId;
  }
  return { folderId: f.insertId, offeringId: o.insertId, subId: s.insertId, hostingId };
};

// ===========================================================================
// 1. The Trash purge must refuse while a site is still live on the server.
// ===========================================================================
{
  const c = await mkClient('purge');
  await db.query('UPDATE folders SET deleted_at = ? WHERE id = ?', [new Date(), c.folderId]);

  const refused = await post('/trash/purge', { kind: 'folder', id: c.folderId });
  ok(refused.status === 409, 'purging a client with live hosting is refused', String(refused.status));
  const err = (await refused.json()).error ?? '';
  ok(/e2e-dataloss-purge\.co\.za/.test(err), 'and the refusal names the actual domain', err.slice(0, 90));

  const [[stillThere]] = await db.query('SELECT COUNT(*) n FROM folders WHERE id = ?', [c.folderId]);
  ok(Number(stillThere.n) === 1, 'the client was not deleted');
  const [[subLives]] = await db.query('SELECT COUNT(*) n FROM subscriptions WHERE id = ?', [c.subId]);
  ok(Number(subLives.n) === 1, 'and its subscription survived');

  // Once hosting is dealt with, the purge goes through.
  await db.query('DELETE FROM hosting_accounts WHERE id = ?', [c.hostingId]);
  const allowed = await post('/trash/purge', { kind: 'folder', id: c.folderId });
  ok(allowed.ok, 'with no live hosting the purge succeeds', String(allowed.status));
  const [[gone]] = await db.query('SELECT COUNT(*) n FROM folders WHERE id = ?', [c.folderId]);
  ok(Number(gone.n) === 0, 'and the client is really gone');
  const [[subGone]] = await db.query('SELECT COUNT(*) n FROM subscriptions WHERE id = ?', [c.subId]);
  ok(Number(subGone.n) === 0, 'its subscription cascaded away as designed');
  await db.query('DELETE FROM offerings WHERE id = ?', [c.offeringId]);
}

// ===========================================================================
// 2. A failed/dry-run hosting row is not "live" and must not block a purge.
// ===========================================================================
{
  const c = await mkClient('failedhost', { hosting: 'failed' });
  await db.query('UPDATE folders SET deleted_at = ? WHERE id = ?', [new Date(), c.folderId]);
  const res = await post('/trash/purge', { kind: 'folder', id: c.folderId });
  ok(res.ok, 'a failed provisioning attempt does not block the purge', String(res.status));
  await db.query('DELETE FROM offerings WHERE id = ?', [c.offeringId]);
}

// ===========================================================================
// 3. The cascades with no 30-day grace refuse the same way.
// ===========================================================================
{
  const c = await mkClient('cascade');
  const offRes = await del(`/offerings/${c.offeringId}`);
  ok(offRes.status === 409, 'deleting an offering with live hosting under it is refused', String(offRes.status));
  const [[offLives]] = await db.query('SELECT COUNT(*) n FROM offerings WHERE id = ?', [c.offeringId]);
  ok(Number(offLives.n) === 1, 'and the offering still exists');

  // A second business, so the "you need at least one" guard cannot answer for us and
  // this really exercises the hosting check.
  const [b2] = await db.query(
    "INSERT INTO businesses (account_id, name, secondary_types) VALUES (1, ?, '[]')", [`${TAG} Biz2`]);
  const [f2] = await db.query('INSERT INTO folders (account_id, business_id, name) VALUES (1, ?, ?)',
    [b2.insertId, `${TAG} b2client`]);
  const [s2] = await db.query(
    `INSERT INTO subscriptions (account_id, business_id, offering_id, folder_id, status, interval_months, started_on, next_bill_date)
     VALUES (1, ?, ?, ?, 'active', 1, ?, ?)`,
    [b2.insertId, c.offeringId, f2.insertId, today, today]);
  await db.query(
    "INSERT INTO hosting_accounts (account_id, business_id, subscription_id, domain, username, status) VALUES (1, ?, ?, 'e2e-dataloss-b2.co.za', 'e2euser', 'active')",
    [b2.insertId, s2.insertId]);

  const bizRes = await del(`/businesses/${b2.insertId}`);
  ok(bizRes.status === 409, 'deleting a business with live hosting is refused', String(bizRes.status));
  const [[bizLives]] = await db.query('SELECT COUNT(*) n FROM businesses WHERE id = ?', [b2.insertId]);
  ok(Number(bizLives.n) === 1, 'and the business still exists');

  await db.query("DELETE FROM hosting_accounts WHERE domain = 'e2e-dataloss-b2.co.za'");
  const bizOk = await del(`/businesses/${b2.insertId}`);
  ok(bizOk.ok, 'with hosting cleared the business deletes normally', String(bizOk.status));

  await db.query('DELETE FROM hosting_accounts WHERE id = ?', [c.hostingId]);
  const offOk = await del(`/offerings/${c.offeringId}`);
  ok(offOk.ok, 'with hosting cleared the offering deletes normally', String(offOk.status));
  await db.query('DELETE FROM folders WHERE id = ?', [c.folderId]);
}

// ===========================================================================
// 4. A client in the Trash is not billed and not charged.
// ===========================================================================
{
  const { runSubscriptionBilling } = await import('file:///C:/CC/klippy-v2/api/dist/lib/jobs.js');
  const live = await mkClient('billlive', { hosting: null });
  const dead = await mkClient('billdead', { hosting: null });
  await db.query('UPDATE folders SET deleted_at = ? WHERE id = ?', [new Date(), dead.folderId]);

  const [[before]] = await db.query('SELECT next_bill_date FROM subscriptions WHERE id = ?', [dead.subId]);
  const summary = await runSubscriptionBilling();
  ok(/skipped \(client in the Trash\)/.test(summary), 'the biller reports the trashed client as skipped', summary);

  const [[deadDocs]] = await db.query('SELECT COUNT(*) n FROM documents WHERE subscription_id = ?', [dead.subId]);
  ok(Number(deadDocs.n) === 0, 'no invoice was raised for the trashed client');
  const [[after]] = await db.query('SELECT next_bill_date FROM subscriptions WHERE id = ?', [dead.subId]);
  ok(String(before.next_bill_date) === String(after.next_bill_date),
    'and its billing date was NOT advanced, so the cycle is not silently eaten');

  const [[liveDocs]] = await db.query('SELECT COUNT(*) n FROM documents WHERE subscription_id = ?', [live.subId]);
  ok(Number(liveDocs.n) === 1, 'the live client was still invoiced exactly once', `${liveDocs.n} invoices`);

  // The shared choke point refuses too, so the manual path cannot slip past.
  const { generateSubscriptionInvoice } = await import('file:///C:/CC/klippy-v2/api/dist/lib/billing.js');
  let threw = '';
  try {
    await generateSubscriptionInvoice(1, {
      businessId: BID, offeringId: dead.offeringId, folderId: dead.folderId, createdBy: null,
    });
  } catch (e) { threw = e.message; }
  ok(/Trash/.test(threw), 'raising an invoice directly for a trashed client throws', threw.slice(0, 60));

  // Restore rolls the schedule forward instead of leaving a backlog to burst.
  await db.query("UPDATE subscriptions SET next_bill_date = '2026-01-05' WHERE id = ?", [dead.subId]);
  const restored = await post('/trash/restore', { kind: 'folder', id: dead.folderId });
  ok(restored.ok, 'the client restores', String(restored.status));
  const [[rolled]] = await db.query('SELECT next_bill_date FROM subscriptions WHERE id = ?', [dead.subId]);
  const nb = String(rolled.next_bill_date).slice(0, 10);
  ok(nb >= today, 'restoring rolls the billing date forward, so no burst of back-invoices', `next ${nb}`);

  await db.query('DELETE FROM documents WHERE subscription_id IN (?, ?)', [live.subId, dead.subId]);
}

// ===========================================================================
// 5. MRR does not count a client the biller refuses to bill.
// ===========================================================================
{
  const { mrrByCurrency } = await import('file:///C:/CC/klippy-v2/api/dist/lib/mrr.js');
  const c = await mkClient('mrr', { hosting: null });
  const before = (await mrrByCurrency(1)).reduce((s, m) => s + m.mrr, 0);
  await db.query('UPDATE folders SET deleted_at = ? WHERE id = ?', [new Date(), c.folderId]);
  const after = (await mrrByCurrency(1)).reduce((s, m) => s + m.mrr, 0);
  ok(Math.abs((before - after) - 500) < 0.01,
    'trashing a client removes its subscription from MRR', `${before} -> ${after}`);
}

// ===========================================================================
// 6. The backup: complete enough to rebuild from, with no secrets in it.
// ===========================================================================
{
  const { buildAccountExport } = await import('file:///C:/CC/klippy-v2/api/dist/lib/export.js');

  // Arm every secret we can, so the deny check is meaningful.
  await db.query("UPDATE subscriptions SET payfast_token = 'SECRET-PF-TOKEN' WHERE account_id = 1 LIMIT 1");
  const data = await buildAccountExport(1);
  const json = JSON.stringify(data);

  ok(!/SECRET-PF-TOKEN/.test(json), 'no PayFast token reaches the backup');
  ok(!/passwordHash|password_hash|tokenHash|payfastToken|Enc"\s*:/.test(json),
    'no password hash, token hash or encrypted secret is in the backup');
  await db.query("UPDATE subscriptions SET payfast_token = NULL WHERE payfast_token = 'SECRET-PF-TOKEN'");

  // The omission that mattered most.
  ok(Array.isArray(data.hostingAccounts), 'the backup lists hosting accounts');
  ok('domain' in (data.subscriptions[0] ?? { domain: null }),
    'and subscriptions carry their domain, so a rebuild cannot double-provision');

  // Real user content that used to be absent entirely.
  for (const key of ['subtasks', 'comments', 'attachments', 'labels', 'cardLabels',
    'calendarEvents', 'files', 'portalUsers', 'dealActivities', 'teams']) {
    ok(Array.isArray(data[key]), `the backup includes ${key}`);
  }
  ok(data.schemaVersion >= 2, 'the backup stamps a schema version', String(data.schemaVersion));

  // Numbering must be reconstructable from the file alone.
  ok((data.documents[0] ?? { seq: 1 }).seq !== undefined, 'documents carry their sequence number');
  ok('prefixInvoice' in (data.businesses[0] ?? {}), 'businesses carry their invoice prefix');
}

// ===========================================================================
// 7. There is always a way out: a dealt-with hosting record can be forgotten.
// ===========================================================================
{
  const c = await mkClient('forget');
  const active = await del(`/hosting/accounts/${c.hostingId}`);
  ok(active.status === 409, 'an ACTIVE hosting record cannot just be forgotten', String(active.status));

  await db.query("UPDATE hosting_accounts SET status = 'suspended' WHERE id = ?", [c.hostingId]);
  const gone = await del(`/hosting/accounts/${c.hostingId}`);
  ok(gone.ok, 'once suspended, the record can be removed', String(gone.status));
  const [[left]] = await db.query('SELECT COUNT(*) n FROM hosting_accounts WHERE id = ?', [c.hostingId]);
  ok(Number(left.n) === 0, 'and it is really gone');
  const [[logged]] = await db.query(
    "SELECT COUNT(*) n FROM events WHERE name = 'hosting.forgotten' AND account_id = 1");
  ok(Number(logged.n) > 0, 'with the domain written to the log first, since nothing else remembers it');

  // And now the client can actually be purged, which was the dead end.
  await db.query('UPDATE folders SET deleted_at = ? WHERE id = ?', [new Date(), c.folderId]);
  const purged = await post('/trash/purge', { kind: 'folder', id: c.folderId });
  ok(purged.ok, 'and the client that was blocked by it can finally be deleted', String(purged.status));
  await db.query('DELETE FROM offerings WHERE id = ?', [c.offeringId]);
}

// ===========================================================================
// 8. A dry run must not permanently block the real charge.
// ===========================================================================
{
  const c = await mkClient('dryrun', { hosting: null });
  const [d] = await db.query(
    `INSERT INTO documents (account_id, business_id, folder_id, subscription_id, type, seq, number, client_name, issue_date, due_date, currency, status, tax_rate, subtotal, tax_amount, total)
     VALUES (1, ?, ?, ?, 'invoice', 9701, 'E2E-DRY-1', ?, ?, ?, 'ZAR', 'sent', '0.00', '500.00', '0.00', '500.00')`,
    [BID, c.folderId, c.subId, TAG + ' dryrun', today, today]);
  // A dry run leaves an attempt row keyed on the invoice.
  await db.query(
    "INSERT INTO auto_debit_attempts (account_id, subscription_id, document_id, status, amount) VALUES (1, ?, ?, 'dry-run', '500.00')",
    [c.subId, d.insertId]);

  const { attemptAutoDebit } = await import('file:///C:/CC/klippy-v2/api/dist/lib/autoDebit.js');
  const res = await attemptAutoDebit({
    accountId: 1, businessId: BID, subscriptionId: c.subId, documentId: d.insertId,
    amount: 500, currency: 'ZAR', itemName: 'E2E', invoiceNumber: 'E2E-DRY-1',
  });
  ok(res.detail !== 'Already attempted for this invoice.',
    'a dry-run row does not permanently block the invoice from ever being charged', res.detail);

  await db.query('DELETE FROM auto_debit_attempts WHERE document_id = ?', [d.insertId]);
  await db.query('DELETE FROM documents WHERE id = ?', [d.insertId]);
  await db.query('DELETE FROM offerings WHERE id = ?', [c.offeringId]);
}

await clean();
// ---- a cancelled plan does not get a server, or get one switched back on --------
{
  const [[biz]] = await db.query('SELECT id FROM businesses WHERE account_id = 1 LIMIT 1');
  const [[fold]] = await db.query('SELECT id FROM folders WHERE account_id = 1 AND parent_id IS NULL LIMIT 1');
  const [[off]] = await db.query("SELECT id FROM offerings WHERE account_id = 1 LIMIT 1");
  if (!biz || !fold || !off) {
    console.log('SKIP  cancelled-plan guard needs a business, client and offering');
  } else {
    await db.query("UPDATE offerings SET provisioning = 'cpanel' WHERE id = ?", [off.id]);
    const [sub] = await db.query(
      "INSERT INTO subscriptions (account_id, business_id, folder_id, offering_id, status, interval_months, started_on, next_bill_date) VALUES (1,?,?,?,'canceled',1,CURDATE(),CURDATE())",
      [biz.id, fold.id, off.id]);
    const SUB = sub.insertId;
    const [ha] = await db.query(
      "INSERT INTO hosting_accounts (account_id, business_id, subscription_id, domain, username, status) VALUES (1,?,?,'cancelled-client.test','cx','suspended')",
      [biz.id, SUB]);

    const { provisionSubscription } = await import('file:///C:/CC/klippy-v2/api/dist/lib/hosting.js');
    const res = await provisionSubscription(1, SUB, 'INV-TEST');
    ok(res.outcome === 'skipped' && /cancel/i.test(res.detail),
      'a cancelled plan is never provisioned, however its invoice gets paid', res.detail);

    // onInvoicePaid is the real entry point, and it must not switch the site back on.
    const [doc] = await db.query(
      "INSERT INTO documents (account_id, business_id, folder_id, subscription_id, type, seq, number, status, issue_date, currency, subtotal, tax_amount, total, client_name) VALUES (1,?,?,?,'invoice',999001,'INV-CANC-TEST','paid',CURDATE(),'ZAR','100.00','0.00','100.00','Gone Away Ltd')",
      [biz.id, fold.id, SUB]);
    const { onInvoicePaid } = await import('file:///C:/CC/klippy-v2/api/dist/lib/hosting.js');
    await onInvoicePaid(1, doc.insertId);
    const [[after]] = await db.query('SELECT status FROM hosting_accounts WHERE id = ?', [ha.insertId]);
    ok(after.status === 'suspended',
      'and paying its old invoice leaves the site off, not served free forever', after.status);

    await db.query('DELETE FROM documents WHERE id = ?', [doc.insertId]);
    await db.query('DELETE FROM hosting_accounts WHERE id = ?', [ha.insertId]);
    await db.query('DELETE FROM subscriptions WHERE id = ?', [SUB]);
    await db.query("UPDATE offerings SET provisioning = 'none' WHERE id = ?", [off.id]);
  }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
await db.end();
process.exit(failures ? 1 : 0);
