/**
 * Saving a new invoice twice because the first reply was lost.
 *
 * What would be quietly wrong: the retry makes a second invoice with the next
 * number, so the client gets two and the sequence SARS expects to be gap-free has a
 * stray in it once one is deleted.
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
const signup = async (email) => {
  const r = await fetch(API + '/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'createkeypass12', accountName: `Key ${tag}`, name: 'Kay', email, blueprint: 'agency', currency: 'ZAR', vatRegistered: false }),
  });
  const cookie = cookieOf(r);
  const account = (await r.json()).account;
  const make = async (key, bizId) => {
    const res = await fetch(API + '/documents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, ...(key ? { 'Idempotency-Key': key } : {}) },
      body: JSON.stringify({ type: 'invoice', businessId: bizId, clientName: 'Retry Client', issueDate: new Date().toISOString().slice(0, 10),
        lines: [{ description: 'Work', quantity: 1, unitPrice: 500 }] }),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const biz = (await (await fetch(API + '/businesses', { headers: { cookie } })).json()).businesses[0];
  return { make: (key) => make(key, biz.id), account };
};
const count = async (accountId) => Number((await db.query("SELECT COUNT(*) n FROM documents WHERE account_id = ? AND type = 'invoice'", [accountId]))[0][0].n);

const { make, account } = await signup(`key.${tag}@test.local`);
const key = `k${tag}abcdef`;
const first = await make(key);
const again = await make(key);
ok(first.status === 201 && again.status === 200 && again.body.replayed === true, 'a retry with the same key is answered, not created again', `${first.status} ${again.status}`);
ok(again.body.document?.id === first.body.document?.id && again.body.document?.number === first.body.document?.number, 'and it is the same invoice, same number', `${first.body.document?.number} ${again.body.document?.number}`);
ok(await count(account.id) === 1, 'only one invoice exists');

const burst = await Promise.all([1, 2, 3].map(() => make(`b${tag}burst00`)));
const ids = new Set(burst.map((r) => r.body.document?.id));
ok(ids.size === 1 && burst.every((r) => r.status < 300), 'three copies at the same moment still make one', `${[...ids].join(',')} ${burst.map((r) => r.status).join(',')}`);
ok(await count(account.id) === 2, 'two invoices in all so far');

const plain1 = await make(null);
const plain2 = await make(null);
ok(plain1.body.document?.id !== plain2.body.document?.id && await count(account.id) === 4, 'without a key, two saves are two invoices, as before');
const junk = await make('bad key!');
ok(junk.status === 201, 'a malformed key is ignored rather than refused', junk.status);

const { make: other, account: acc2 } = await signup(`key.other.${tag}@test.local`);
const theirs = await other(key);
ok(theirs.status === 201 && theirs.body.document?.id !== first.body.document?.id && await count(acc2.id) === 1,
  'another workspace using the same key gets its own invoice, never yours', theirs.status);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
await db.end();
process.exit(failures ? 1 : 0);
