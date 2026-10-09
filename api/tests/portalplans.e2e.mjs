/**
 * Monthly services in the client portal.
 *
 * What would be quietly wrong: a client seeing the list price instead of what they
 * pay, another client's plans, a cancelled plan, or a next bill date on a paused one.
 *
 * Run with a test server on 8095 (or set KLIPPY_API).
 */
const API = process.env.KLIPPY_API ?? 'http://localhost:8095/api/v1';
let failures = 0;
const ok = (c, label, extra) => {
  console.log((c ? 'PASS  ' : 'FAIL  ') + label + (extra !== undefined ? '  [' + extra + ']' : ''));
  if (!c) failures++;
};
const cookieOf = (r) => (r.headers.getSetCookie?.() ?? [r.headers.get('set-cookie')]).filter(Boolean).map((c) => c.split(';')[0]).join('; ');
const call = (cookie) => async (method, p, b) => {
  const r = await fetch(API + p, {
    method, headers: { ...(b !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: b !== undefined ? JSON.stringify(b) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})), cookie: cookieOf(r) };
};
const tag = Date.now();
const su = await call('')('POST', '/auth/signup', { password: 'portalplans123', accountName: `Plans ${tag}`, name: 'Pla Ns', email: `plans.${tag}@test.local`, blueprint: 'agency', currency: 'ZAR', vatRegistered: false });
const A = call(su.cookie);
const biz = (await A('GET', '/businesses')).body.businesses[0];
const client = (await A('POST', '/folders', { name: 'Plan Client', businessId: biz.id })).body.folder.id;
const other = (await A('POST', '/folders', { name: 'Other Client', businessId: biz.id })).body.folder.id;
const hosting = (await A('POST', '/offerings', { businessId: biz.id, name: 'Website hosting', price: 350, recurring: true, description: 'Hosting, backups and SSL' })).body.offering.id;
const care = (await A('POST', '/offerings', { businessId: biz.id, name: 'Website care', price: 1200, recurring: true })).body.offering.id;
const seo = (await A('POST', '/offerings', { businessId: biz.id, name: 'SEO', price: 3000, recurring: true })).body.offering.id;

const s1 = (await A('POST', '/subscriptions', { businessId: biz.id, offeringId: hosting, folderId: client, price: 300, domain: 'plan.example' })).body.subscription;
const s2 = (await A('POST', '/subscriptions', { businessId: biz.id, offeringId: care, folderId: client })).body.subscription;
const s3 = (await A('POST', '/subscriptions', { businessId: biz.id, offeringId: seo, folderId: client })).body.subscription;
await A('POST', '/subscriptions', { businessId: biz.id, offeringId: seo, folderId: other });
await A('PATCH', `/subscriptions/${s2.id}`, { status: 'paused' });
await A('PATCH', `/subscriptions/${s3.id}`, { status: 'canceled' });

const portal = async (folderId, email) => {
  await A('POST', `/folders/${folderId}/portal-users`, { email, name: 'Pat', invite: false });
  const pu = (await A('GET', `/folders/${folderId}/portal-users`)).body.portalUsers.find((u) => u.email === email);
  await A('POST', `/portal-users/${pu.id}/password`, { password: 'portalpass123' });
  const r = await call('')('POST', '/portal/password-login', { email, password: 'portalpass123' });
  return call(r.cookie);
};
const P = await portal(client, `pat.plans.${tag}@test.local`);
const plans = (await P('GET', '/portal/subscriptions')).body.subscriptions ?? [];
const h = plans.find((p) => p.id === s1.id);
const c = plans.find((p) => p.id === s2.id);
ok(h?.amount === 300 && h.currency === 'ZAR' && h.domain === 'plan.example' && h.description === 'Hosting, backups and SSL', 'the client sees what they pay, not the list price', JSON.stringify(h));
ok(!!h?.nextBillDate, 'with the next bill date');
ok(c?.status === 'paused' && c.nextBillDate === null, 'a paused plan shows, with no next bill promised', JSON.stringify(c));
ok(!plans.some((p) => p.id === s3.id), 'a cancelled plan does not show');
ok(plans.length === 2, 'and nobody else\'s plans', plans.length);
ok((await call('')('GET', '/portal/subscriptions')).status === 401, 'signed out, nothing');

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
