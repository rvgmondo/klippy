/**
 * The price list: what each item earns, and deleting one safely.
 *
 * Each block names what would be quietly wrong:
 *   - deleting an item somebody is subscribed to, which deleted the subscription
 *     with it and stopped their monthly bill without a word
 *   - drafts and voided invoices counted as money an item brought in
 *   - another workspace's sales counted against yours
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
const r = await fetch(API + '/auth/signup', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: 'pricelistpass12', accountName: `Prices ${tag}`, name: 'Pri Ces', email: `prices.${tag}@test.local`, blueprint: 'agency', currency: 'ZAR', vatRegistered: false }),
});
const cookie = cookieOf(r);
const A = async (method, p, b) => {
  const res = await fetch(API + p, { method, headers: { ...(b ? { 'content-type': 'application/json' } : {}), cookie }, body: b ? JSON.stringify(b) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const biz = (await A('GET', '/businesses')).body.businesses[0];
const today = new Date().toISOString().slice(0, 10);
const folder = (await A('POST', '/folders', { name: 'Steady Client', businessId: biz.id })).body.folder.id;
const item = async (id) => ((await A('GET', `/offerings?businessId=${biz.id}`)).body.offerings ?? []).find((o) => o.id === id);

const hosting = (await A('POST', '/offerings', { businessId: biz.id, name: `Hosting ${tag}`, price: 250, recurring: true })).body.offering.id;
const audit = (await A('POST', '/offerings', { businessId: biz.id, name: `Audit ${tag}`, price: 3000, cost: 1000 })).body.offering.id;
const spare = (await A('POST', '/offerings', { businessId: biz.id, name: `Spare ${tag}`, price: 10 })).body.offering.id;

// ---- what it earns -------------------------------------------------------------------------
const invoice = async (status) => {
  const d = (await A('POST', '/documents', {
    type: 'invoice', businessId: biz.id, clientName: 'Steady Client', issueDate: today,
    lines: [{ description: 'Audit', quantity: 2, unitPrice: 3000, offeringId: audit }],
  })).body.document;
  if (status !== 'draft') await db.query('UPDATE documents SET status = ? WHERE id = ?', [status, d.id]);
  return d;
};
await invoice('sent');
await invoice('draft');
await invoice('void');
const a = await item(audit);
ok(a?.usage?.revenue12m === 6000 && a.usage.sold12m === 2, 'an item counts what sent and paid invoices brought in, not drafts or void ones', JSON.stringify(a?.usage));

const sub = (await A('POST', '/subscriptions', { businessId: biz.id, offeringId: hosting, folderId: folder })).body.subscription;
// Starting it raises the first invoice; if it did not, bill it now.
const [[{ n: raised }]] = await db.query('SELECT COUNT(*) n FROM documents WHERE subscription_id = ?', [sub.id]);
if (!Number(raised)) await A('POST', `/subscriptions/${sub.id}/bill-now`);
const [[subLine]] = await db.query(
  'SELECT l.offering_id o, d.id d FROM document_lines l JOIN documents d ON d.id = l.document_id WHERE d.subscription_id = ? ORDER BY d.id DESC LIMIT 1', [sub.id]);
ok(subLine?.o === hosting, 'a subscription invoice records which item it bills', subLine?.o);
// An invoice from before that was recorded: no item on the line, only the subscription.
await db.query('UPDATE document_lines SET offering_id = NULL WHERE document_id = ?', [subLine.d]);
await db.query("UPDATE documents SET status = 'sent' WHERE id = ?", [subLine.d]);
const h = await item(hosting);
ok(h?.usage?.revenue12m === 250, 'and older subscription invoices still count towards their item', h?.usage?.revenue12m);
ok(h?.usage?.subscribers === 1 && h.usage.followPrice === 1, 'a recurring item knows who is on it, and who pays its list price', JSON.stringify(h?.usage));

// ---- deleting safely --------------------------------------------------------------------------
const delSub = await A('DELETE', `/offerings/${hosting}`);
ok(delSub.status === 409 && /Archive/.test(delSub.body.error ?? ''), 'an item someone is subscribed to cannot be deleted, and says to archive it', delSub.body.error);
const [[{ n: subsLeft }]] = await db.query('SELECT COUNT(*) n FROM subscriptions WHERE offering_id = ?', [hosting]);
ok(Number(subsLeft) === 1, 'and the subscription is still there', subsLeft);
const arch = await A('PATCH', `/offerings/${hosting}`, { active: false });
ok(arch.status === 200 && arch.body.offering?.active === false, 'archiving it works');
const [[{ s: subStatus }]] = await db.query('SELECT status s FROM subscriptions WHERE offering_id = ?', [hosting]);
ok(subStatus === 'active', 'and the subscription keeps running', subStatus);
ok((await A('DELETE', `/offerings/${spare}`)).status === 200, 'an item nobody uses can still be deleted');

// ---- another workspace ---------------------------------------------------------------------------
const r2 = await fetch(API + '/auth/signup', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: 'pricelistpass12', accountName: `Prices B ${tag}`, name: 'Other', email: `prices.b.${tag}@test.local`, blueprint: 'agency', currency: 'ZAR', vatRegistered: false }),
});
const cookie2 = cookieOf(r2);
const B = async (method, p, b) => {
  const res = await fetch(API + p, { method, headers: { ...(b ? { 'content-type': 'application/json' } : {}), cookie: cookie2 }, body: b ? JSON.stringify(b) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const bBiz = (await B('GET', '/businesses')).body.businesses[0];
const theirs = (await B('POST', '/documents', {
  type: 'invoice', businessId: bBiz.id, clientName: 'X', issueDate: today,
  lines: [{ description: 'Sneaky', quantity: 5, unitPrice: 100, offeringId: audit }],
})).body.document;
if (theirs) await db.query("UPDATE documents SET status = 'sent' WHERE id = ?", [theirs.id]);
const a2 = await item(audit);
ok(a2?.usage?.revenue12m === 6000, "another workspace's invoice never counts towards your item", a2?.usage?.revenue12m);
const [[line]] = await db.query('SELECT offering_id o FROM document_lines WHERE document_id = ?', [theirs?.id ?? 0]);
ok(theirs && line && line.o === null, 'their line keeps its words but does not point at your item', line?.o);
ok((await B('DELETE', `/offerings/${audit}`)).status === 404, 'and it cannot delete your item');

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
await db.end();
process.exit(failures ? 1 : 0);
