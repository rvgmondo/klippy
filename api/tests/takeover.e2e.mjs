/**
 * The cross-tenant account takeover, and the fence that closes it.
 *
 * THE ATTACK, in two ordinary buttons:
 *   1. A person's Klippy login ends up with NO memberships. Reachable in normal use:
 *      leaving your last workspace, or having a workspace deleted, removes the
 *      membership rows and leaves the login standing.
 *   2. An attacker signs up (instant owner of a fresh workspace) and adds that person
 *      by email. The old rule only refused logins that belonged to ANOTHER workspace,
 *      and this one belonged to none, so membership was granted on the spot.
 *   3. PATCH /users/:id resets a password for anyone with a membership HERE, which
 *      step 2 had just created. Attacker sets the password and signs in as them.
 *
 * This suite proves each link, and that the invitation is a real way in rather than
 * a dead end.
 *
 * It signs in more than most suites do, and sign-in is rate limited per IP (10 in five
 * minutes), so cookies are reused wherever the assertion does not depend on a fresh
 * one. Run it LAST if you are running everything back to back.
 *
 * Run with a test server on 8095:  node tests/takeover.e2e.mjs
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

const VICTIM = 'e2e-victim@test.local';
const ATTACKER = 'e2e-attacker@test.local';
const PASS = 'victimpassword123';

const wipe = async () => {
  for (const email of [VICTIM, ATTACKER]) {
    await db.query('DELETE m FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ?', [email]);
    await db.query('DELETE FROM invitations WHERE email = ?', [email]);
    await db.query('DELETE FROM users WHERE email = ?', [email]);
  }
  await db.query("DELETE FROM accounts WHERE name = 'E2E Throwaway'");
};
await wipe();

const login = async (email, password) => {
  const r = await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return r.ok ? cookieOf(r) : null;
};

// ---- set the stage: a real login with no workspace at all -------------------------
// One owner sign-in for the whole suite, reused wherever a signed-in stranger is
// needed, so this does not spend the rate-limit budget on the same person twice.
const ownerCookie = await login('ruben@x.com', 'klippylook1');

let VICTIM_ID;
{
  // Made through the app so the password hash is whatever the app really produces.
  const owner = ownerCookie;
  const mk = await fetch(API + '/users', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: owner },
    body: JSON.stringify({ email: VICTIM, name: 'Victim Person', password: PASS, role: 'member' }),
  });
  VICTIM_ID = (await mk.json()).user?.id;
  ok(!!VICTIM_ID, 'a victim login exists');

  ok(!!(await login(VICTIM, PASS)), 'and the victim can sign in with their own password');

  // Now strip every membership, which is what leaving your last workspace does.
  // Note the login stops working at this point: auth.ts refuses a login that belongs
  // to no workspace. That is WHY accepting an invitation cannot require a session.
  await db.query('DELETE FROM memberships WHERE user_id = ?', [VICTIM_ID]);
  const [[m]] = await db.query('SELECT COUNT(*) n FROM memberships WHERE user_id = ?', [VICTIM_ID]);
  ok(Number(m.n) === 0, 'the login now belongs to no workspace, as after leaving your last one');
}

// ---- the attacker's throwaway workspace -------------------------------------------
let attackerCookie;
{
  const signup = await fetch(API + '/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Attacker', email: ATTACKER, password: 'attackerpass123',
      accountName: 'E2E Throwaway',
    }),
  });
  attackerCookie = signup.ok ? cookieOf(signup) : await login(ATTACKER, 'attackerpass123');
  ok(!!attackerCookie, 'anyone can sign up and instantly own a workspace', String(signup.status));
}

// ---- step 2 of the attack must fail ------------------------------------------------
{
  const add = await fetch(API + '/users', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: attackerCookie },
    body: JSON.stringify({ email: VICTIM, role: 'member' }),
  });
  ok(add.status === 202, 'adding an existing login invites rather than conscripts', String(add.status));
  const body = await add.json();
  ok(body.invited === true, 'and says so plainly');

  const [[m]] = await db.query(
    'SELECT COUNT(*) n FROM memberships WHERE user_id = ?', [VICTIM_ID]);
  ok(Number(m.n) === 0, 'NO membership was created, so the foothold never happens');
}

// ---- step 3 is therefore unreachable ------------------------------------------------
{
  const reset = await fetch(API + '/users/' + VICTIM_ID, {
    method: 'PATCH', headers: { 'content-type': 'application/json', cookie: attackerCookie },
    body: JSON.stringify({ password: 'attackerchosen123' }),
  });
  ok(reset.status === 404, 'the password reset cannot even find them', String(reset.status));

  // Their password is untouched, which is provable through the accept route below
  // (it takes the real password). Signing in is refused only for want of a workspace.
  const stillRefused = await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: VICTIM, password: PASS }),
  });
  ok(stillRefused.status === 403, 'the victim is refused for want of a workspace, not a wrong password', String(stillRefused.status));
  const refusal = await stillRefused.json();
  ok(refusal.pendingInvitation === true, 'and is told an invitation is waiting rather than hitting a dead end');

  const attackerPass = await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: VICTIM, password: 'attackerchosen123' }),
  });
  ok(attackerPass.status === 401, 'and the attacker password was never set', String(attackerPass.status));
}

// ---- the invitation is a real way in, not a dead end --------------------------------
{
  const [[inv]] = await db.query(
    'SELECT id, token_hash FROM invitations WHERE email = ? AND accepted_at IS NULL AND revoked_at IS NULL',
    [VICTIM]);
  ok(!!inv, 'an invitation was recorded for them');

  // Only the hash is stored, so the test mints its own token the same way the app does
  // and rewrites the row: proof the raw token never has to live in the database.
  const { randomBytes, createHash } = await import('node:crypto');
  const raw = randomBytes(32).toString('base64url');
  await db.query('UPDATE invitations SET token_hash = ? WHERE id = ?',
    [createHash('sha256').update(raw).digest('hex'), inv.id]);

  // A stranger holding the link cannot use it.
  const wrongPerson = await fetch(API + '/invitations/accept', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: ownerCookie },
    body: JSON.stringify({ token: raw }),
  });
  ok(wrongPerson.status === 400, 'a leaked invitation link is useless to anyone else', String(wrongPerson.status));

  // The invited person accepts with their OWN password. They have no workspace, so
  // they cannot hold a session: requiring one would have made this a dead end.
  const accepted = await fetch(API + '/invitations/accept', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: raw, email: VICTIM, password: PASS }),
  });
  ok(accepted.status === 200, 'but the person it was sent to can accept it', String(accepted.status));
  const [[m]] = await db.query('SELECT COUNT(*) n FROM memberships WHERE user_id = ?', [VICTIM_ID]);
  ok(Number(m.n) === 1, 'which is what actually creates the membership');

  // One use only.
  const twice = await fetch(API + '/invitations/accept', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: raw, email: VICTIM, password: PASS }),
  });
  ok(twice.status === 400, 'and it cannot be used twice', String(twice.status));

  ok(!!(await login(VICTIM, PASS)), 'and now that they have a workspace, they sign in with their own password');
}

await wipe();
console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURES');
await db.end();
process.exit(failures ? 1 : 0);
