/**
 * Talking to clients: emails written from Klippy, and help requests from the portal.
 *
 * Each block names what would be quietly wrong:
 *   - an email to a client is sent and kept on that client, and a bad address is refused
 *   - a client asks for help in the portal: it is saved, lands on Home, and becomes a
 *     card on their board
 *   - the answer reaches the client's portal, and a client reply makes it "waiting" again
 *   - one client can never read another client's request, by list or by id
 *   - another workspace cannot read or answer anything here
 *   - a staff preview of the portal cannot send a request
 *   - the WhatsApp number is cleaned up and shown to the portal
 *   - a backup carries the conversations
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
  console.log((c ? 'PASS  ' : 'FAIL  ') + label + (extra !== undefined ? '  [' + extra + ']' : ''));
  if (!c) failures++;
};
const cookieOf = (r) => (r.headers.getSetCookie?.() ?? [r.headers.get('set-cookie')]).filter(Boolean).map((c) => c.split(';')[0]).join('; ');
const tag = Date.now();
const call = (cookie) => async (method, p, b) => {
  const r = await fetch(API + p, {
    method, headers: { ...(b !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: b === undefined ? undefined : JSON.stringify(b),
  });
  return { status: r.status, body: await r.json().catch(() => ({})), cookie: cookieOf(r) };
};
const signup = async (email) => {
  const r = await call('')('POST', '/auth/signup', { password: 'talkpass12345', accountName: `Talk ${tag}`, name: 'Tess Talk', email, blueprint: 'agency', currency: 'ZAR', vatRegistered: false });
  return { A: call(r.cookie), account: r.body.account };
};

const { A, account } = await signup(`talk.${tag}@test.local`);
const [[biz]] = await db.query('SELECT id FROM businesses WHERE account_id = ?', [account.id]);
const mkClient = async (name, email) => (await A('POST', '/folders', { name, businessId: biz.id, billingEmail: email })).body.folder.id;
const acme = await mkClient('Acme Talk', `acme.${tag}@test.local`);
const other = await mkClient('Other Talk', `other.${tag}@test.local`);
// A board for Acme, so a help request can become a card on it.
const board = await A('POST', '/boards', { folderId: acme, name: 'Website care' });
ok(board.status === 201 || board.status === 200, 'a board for the client', board.status);

// ---- email a client ---------------------------------------------------------------
const sent = await A('POST', `/clients/${acme}/emails`, { to: [`acme.${tag}@test.local`, `ACME.${tag}@test.local`], subject: 'Your new homepage', body: 'Hi,\n\nIt is live.\n\nThanks' });
ok(sent.status === 200 && sent.body.ok, 'an email to a client sends', sent.status);
const list = await A('GET', `/clients/${acme}/emails`);
ok(list.body.emails?.length === 1 && list.body.emails[0].subject === 'Your new homepage' && list.body.emails[0].by === 'Tess Talk', 'and is kept on that client, with who sent it', JSON.stringify(list.body.emails?.[0]?.by));
ok(!list.body.emails[0].to.includes(',') , 'the same address in two cases is sent once', list.body.emails[0].to);
const bad = await A('POST', `/clients/${acme}/emails`, { to: ['not-an-email'], subject: 'x', body: 'y' });
ok(bad.status === 400, 'a bad address is refused', bad.status);
const otherList = await A('GET', `/clients/${other}/emails`);
ok(otherList.body.emails?.length === 0, 'another client\'s emails are separate');

// ---- a second workspace -----------------------------------------------------------
const { A: B } = await signup(`talk.other.${tag}@test.local`);
ok((await B('GET', `/clients/${acme}/emails`)).status === 404, 'another workspace cannot read the emails');
ok((await B('POST', `/clients/${acme}/emails`, { to: ['x@test.local'], subject: 'x', body: 'y' })).status === 404, 'or send as this business');
ok((await call('')('GET', `/clients/${acme}/emails`)).status === 401, 'signed out gets nothing');

// ---- WhatsApp number --------------------------------------------------------------
const wa = await A('PATCH', `/businesses/${biz.id}`, { bizWhatsapp: '082 555 0101' });
const [[waRow]] = await db.query('SELECT biz_whatsapp w FROM businesses WHERE id = ?', [biz.id]);
ok(wa.status === 200 && waRow.w === '27825550101', 'a local number is stored in the form WhatsApp needs', waRow.w);
const waBad = await A('PATCH', `/businesses/${biz.id}`, { bizWhatsapp: '12' });
ok(waBad.status === 400, 'a number too short is refused', waBad.status);

// ---- the client's portal ------------------------------------------------------------
const portalLogin = async (folderId, email) => {
  await A('POST', `/folders/${folderId}/portal-users`, { email, name: 'Pat Client', invite: false });
  const users = (await A('GET', `/folders/${folderId}/portal-users`)).body.portalUsers;
  const pu = users.find((u) => u.email === email);
  await A('POST', `/portal-users/${pu.id}/password`, { password: 'portalpass123' });
  const r = await call('')('POST', '/portal/password-login', { email, password: 'portalpass123' });
  return call(r.cookie);
};
const P = await portalLogin(acme, `pat.${tag}@test.local`);
const Q = await portalLogin(other, `quinn.${tag}@test.local`);

const me = await P('GET', '/portal/me');
ok(me.body.brand?.whatsapp === '27825550101', 'the portal knows the WhatsApp number', me.body.brand?.whatsapp);

const asked = await P('POST', '/portal/support', { subject: 'Contact form broken', body: 'Nothing arrives when people fill it in.' });
ok(asked.status === 201 && asked.body.id, 'a client can ask for help', asked.status);
const reqId = asked.body.id;
const [[reqRow]] = await db.query('SELECT status, task_id t, business_id b FROM support_requests WHERE id = ?', [reqId]);
ok(reqRow.status === 'open' && reqRow.b === biz.id, 'it is saved as waiting on the business');
const [[card]] = reqRow.t ? await db.query('SELECT title, priority FROM tasks WHERE id = ?', [reqRow.t]) : [[null]];
ok(card?.title === 'Help: Contact form broken' && card?.priority === 'high', 'and it is a card on their board', card?.title);
const [[note]] = await db.query("SELECT title FROM notifications WHERE account_id = ? AND kind = 'support' ORDER BY id DESC LIMIT 1", [account.id]);
ok(note?.title?.includes('Acme Talk needs help'), 'the owner is notified', note?.title);

const home = (await A('GET', '/home')).body;
const homeItem = home.items?.find((i) => i.kind === 'support' && i.supportId === reqId);
ok(!!homeItem && homeItem.group === 'today' && homeItem.folderId === acme, 'it shows on Home under today', JSON.stringify(homeItem?.group));

// Scope: the other client cannot see it.
ok((await Q('GET', '/portal/support')).body.requests?.length === 0, 'another client\'s portal does not list it');
ok((await Q('GET', `/portal/support/${reqId}`)).status === 404, 'or open it by id');
ok((await Q('POST', `/portal/support/${reqId}/reply`, { body: 'hi' })).status === 404, 'or reply to it');
ok((await B('GET', `/support/${reqId}`)).status === 404, 'another workspace cannot open it');
ok((await B('POST', `/support/${reqId}/reply`, { body: 'x' })).status === 404, 'or answer it');

// ---- answer it -------------------------------------------------------------------------
const ans = await A('POST', `/support/${reqId}/reply`, { body: 'Fixed. It was a spam filter.' });
ok(ans.status === 200 && ans.body.status === 'answered', 'the business answers', ans.status);
const thread = (await P('GET', `/portal/support/${reqId}`)).body;
ok(thread.messages?.length === 2 && thread.messages[1].fromClient === false && thread.request.status === 'answered', 'the client sees the answer in their portal');
ok(!(await A('GET', '/home')).body.items.some((i) => i.supportId === reqId), 'and it leaves Home once answered');

const back = await P('POST', `/portal/support/${reqId}/reply`, { body: 'Still nothing on my side.' });
const [[again]] = await db.query('SELECT status FROM support_requests WHERE id = ?', [reqId]);
ok(back.status === 200 && again.status === 'open', 'a client reply makes it waiting again', again.status);
await A('POST', `/support/${reqId}/reply`, { body: 'Sorted now, tested twice.', close: true });
const [[closed]] = await db.query('SELECT status FROM support_requests WHERE id = ?', [reqId]);
ok(closed.status === 'closed', 'answer and mark done closes it');
await P('POST', `/portal/support/${reqId}/reply`, { body: 'Broken again.' });
const [[reopened]] = await db.query('SELECT status FROM support_requests WHERE id = ?', [reqId]);
ok(reopened.status === 'open', 'a client writing on a closed one opens it again');

const forClient = (await A('GET', `/support?folderId=${acme}`)).body.requests;
ok(forClient?.length === 1 && forClient[0].clientName === 'Acme Talk', 'the client page lists it');
const count = (await A('GET', '/support-count')).body;
ok(count.open === 1, 'the waiting count is right', count.open);

// ---- a staff preview cannot write -------------------------------------------------
const prev = await A('POST', `/folders/${acme}/portal-preview`, {});
const prevCookie = prev.cookie;
if (prevCookie) {
  const PV = call(prevCookie);
  const tried = await PV('POST', '/portal/support', { subject: 'x', body: 'y' });
  ok(tried.status === 403, 'staff previewing the portal cannot send a request as the client', tried.status);
} else {
  ok(false, 'preview cookie issued', prev.status);
}

// ---- in the backup ---------------------------------------------------------------------
const exp = (await A('GET', '/account/export')).body;
const data = exp.data ?? exp;
ok(data.clientEmails?.length === 1 && data.supportRequests?.length === 1 && data.supportMessages?.length === 5,
  'the backup has the emails and the whole conversation', `${data.clientEmails?.length}, ${data.supportRequests?.length}, ${data.supportMessages?.length}`);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
await db.end();
process.exit(failures ? 1 : 0);
