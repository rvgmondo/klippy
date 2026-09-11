/**
 * The client company record.
 *
 * What this proves:
 *
 *   1. THE FIELDS ROUND TRIP. Written through the API, read back the same, and
 *      stored in the columns they claim to be in.
 *   2. AN EMPTY BOX CLEARS. The form sends '' for anything somebody blanked, and a
 *      column holding '' reads as set everywhere else: a two-letter country of ''
 *      fails a lookup, a currency of '' gets printed on an invoice.
 *   3. THE TWO IDS ARE CHECKED AGAINST THIS ACCOUNT. accountManagerId and
 *      primaryContactId are numbers the caller chose. Without a check, a number
 *      from another workspace lands in the row and the client record starts naming
 *      a stranger. This is the one that matters.
 *   4. A YEAR END THAT IS NOT A DAY IS REFUSED, rather than stored and shown back
 *      as a date that does not exist.
 *
 * Run with a test server on 8095 started with CRON_SECRET and AUTH_RATE_LIMIT_MAX set.
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
  await db.query("DELETE FROM contacts WHERE name LIKE 'E2E-CR%'");
  await db.query("DELETE FROM folders WHERE name LIKE 'E2E-CR%'");
};
await clean();

const lr = await fetch(API + '/auth/login', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'ruben@x.com', password: 'klippylook1' }),
});
const cookie = cookieOf(lr);
ok(lr.ok && !!cookie, 'owner signs in');
if (!cookie) { await db.end(); process.exit(1); }

const H = { 'content-type': 'application/json', cookie };
const post = (p, b) => fetch(API + p, { method: 'POST', headers: H, body: JSON.stringify(b ?? {}) });
const patch = (p, b) => fetch(API + p, { method: 'PATCH', headers: H, body: JSON.stringify(b ?? {}) });

const [[biz]] = await db.query('SELECT id FROM businesses WHERE account_id = 1 ORDER BY position LIMIT 1');

const made = await post('/folders', { name: 'E2E-CR Sunrise Hospitality', businessId: biz.id });
const CID = (await made.json()).folder.id;
ok(!!CID, 'a client is created', String(CID));

// ---- every field round trips into the column it claims ------------------------------
{
  const r = await patch(`/folders/${CID}`, {
    legalName: 'Sunrise Hospitality Group (Pty) Ltd',
    regNumber: '2019/123456/07',
    companyType: 'Pty Ltd',
    country: 'za',
    taxNumber: '9012345678',
    billingVatNumber: '4123456789',
    industry: 'Food and drink',
    website: 'earlybird.co.za',
    bbbeeLevel: '4',
    financialYearEnd: '02-28',
    paymentTermsDays: 30,
    creditLimit: 25000,
    currency: 'zar',
    clientStatus: 'active',
    clientSince: '2024-03-01',
    source: 'Referral',
  });
  ok(r.status === 200, 'the whole company record saves in one request', String(r.status));

  const [[row]] = await db.query(
    `SELECT legal_name, reg_number, company_type, country, tax_number, industry, website,
            bbbee_level, financial_year_end, payment_terms_days, credit_limit, currency,
            client_status, DATE_FORMAT(client_since, '%Y-%m-%d') AS since, source
       FROM folders WHERE id = ?`, [CID]);

  ok(row.legal_name === 'Sunrise Hospitality Group (Pty) Ltd', 'the registered name is kept apart from the trading name', row.legal_name);
  ok(row.reg_number === '2019/123456/07', 'the registration number is stored verbatim, not reformatted', row.reg_number);
  ok(row.country === 'ZA', 'the country is upper-cased, so a two-letter lookup works', row.country);
  ok(row.currency === 'ZAR', 'and so is the currency, which gets printed on invoices', row.currency);
  ok(row.website === 'https://earlybird.co.za',
    'a website typed without a scheme gets one, or every href is a relative link to nowhere', row.website);
  ok(row.financial_year_end === '02-28', 'the year end is a day and a month with no year', row.financial_year_end);
  ok(row.payment_terms_days === 30, 'payment terms are a number of days', String(row.payment_terms_days));
  ok(String(row.credit_limit) === '25000.00', 'and the credit limit keeps its cents', String(row.credit_limit));
  ok(row.since === '2024-03-01', 'client since is a plain date', row.since);
  ok(row.bbbee_level === '4' && row.tax_number === '9012345678' && row.industry === 'Food and drink',
    'and the rest lands where it says it does');
}

// ---- zero is a real answer, and not the same as blank -------------------------------
{
  await patch(`/folders/${CID}`, { paymentTermsDays: 0 });
  const [[row]] = await db.query('SELECT payment_terms_days FROM folders WHERE id = ?', [CID]);
  ok(row.payment_terms_days === 0,
    'zero days is stored as zero, because on receipt is a real arrangement', String(row.payment_terms_days));

  await patch(`/folders/${CID}`, { paymentTermsDays: null });
  const [[after]] = await db.query('SELECT payment_terms_days FROM folders WHERE id = ?', [CID]);
  ok(after.payment_terms_days === null,
    'and null is different again: it means use the business default', String(after.payment_terms_days));
}

// ---- an empty box clears the field rather than storing an empty string --------------
{
  await patch(`/folders/${CID}`, { country: '', currency: '', regNumber: '', financialYearEnd: '' });
  const [[row]] = await db.query(
    'SELECT country, currency, reg_number, financial_year_end FROM folders WHERE id = ?', [CID]);
  ok(row.country === null && row.currency === null && row.reg_number === null && row.financial_year_end === null,
    'blanking a field stores null, never an empty string that reads as set',
    JSON.stringify(row));
}

// ---- a year end has to be a real day of a real month --------------------------------
{
  const bad = await patch(`/folders/${CID}`, { financialYearEnd: '02-30' });
  ok(bad.status === 400, 'the 30th of February is refused', String(bad.status));
  const worse = await patch(`/folders/${CID}`, { financialYearEnd: '13-01' });
  ok(worse.status === 400, 'and so is a thirteenth month', String(worse.status));
  const leap = await patch(`/folders/${CID}`, { financialYearEnd: '02-29' });
  ok(leap.status === 200, 'while the 29th of February is allowed, because leap years happen', String(leap.status));
}

// ---- the authorised contact is a pointer, and it is checked -------------------------
{
  const c = await post('/contacts', { name: 'E2E-CR Thandi Mokoena', email: 'thandi@example.com', role: 'Owner' });
  const contactId = (await c.json()).contact?.id ?? (await (await post('/contacts', { name: 'E2E-CR fallback' })).json()).contact?.id;
  ok(!!contactId, 'a contact exists to point at', String(contactId));

  const r = await patch(`/folders/${CID}`, { primaryContactId: contactId });
  ok(r.status === 200, 'the authorised contact can be set', String(r.status));

  const [[row]] = await db.query('SELECT primary_contact_id FROM folders WHERE id = ?', [CID]);
  ok(row.primary_contact_id === contactId, 'stored as a pointer, not a copy of their name', String(row.primary_contact_id));

  const [[link]] = await db.query('SELECT folder_id FROM contacts WHERE id = ?', [contactId]);
  ok(link.folder_id === CID, 'and the contact is filed under the client, so it is reachable from both ends');

  // Deleting the person must not take the company with them.
  await db.query('DELETE FROM contacts WHERE id = ?', [contactId]);
  const [[after]] = await db.query('SELECT id, primary_contact_id FROM folders WHERE id = ?', [CID]);
  ok(!!after.id && after.primary_contact_id === null,
    'losing the contact nulls the pointer and leaves the company record standing');
}

/**
 * ---- the ids are checked against THIS account ---------------------------------------
 *
 * Both are numbers the caller chose. Without a check, a number belonging to another
 * workspace lands in the row and the client record starts naming a stranger.
 */
{
  const [[other]] = await db.query('SELECT id FROM users WHERE id NOT IN (SELECT user_id FROM memberships WHERE account_id = 1) LIMIT 1');
  if (other) {
    const r = await patch(`/folders/${CID}`, { accountManagerId: other.id });
    ok(r.status === 400, 'a user from outside this workspace is refused as account manager', String(r.status));
  } else {
    const r = await patch(`/folders/${CID}`, { accountManagerId: 99999 });
    ok(r.status === 400, 'a user id that is not in this workspace is refused', String(r.status));
  }

  const [[foreign]] = await db.query('SELECT id FROM contacts WHERE account_id <> 1 LIMIT 1');
  const foreignId = foreign?.id ?? 99999;
  const r2 = await patch(`/folders/${CID}`, { primaryContactId: foreignId });
  ok(r2.status === 400, 'and a contact from another workspace is refused as the authorised person', String(r2.status));

  const [[row]] = await db.query('SELECT account_manager_id, primary_contact_id FROM folders WHERE id = ?', [CID]);
  ok(row.account_manager_id === null && row.primary_contact_id === null,
    'with nothing written either time', JSON.stringify(row));
}

// ---- a real member can own the client -----------------------------------------------
{
  const [[me]] = await db.query('SELECT user_id FROM memberships WHERE account_id = 1 AND is_active = 1 LIMIT 1');
  const r = await patch(`/folders/${CID}`, { accountManagerId: me.user_id });
  ok(r.status === 200, 'somebody actually in the workspace can own the client', String(r.status));
  const [[row]] = await db.query('SELECT account_manager_id FROM folders WHERE id = ?', [CID]);
  ok(row.account_manager_id === me.user_id, 'and it sticks', String(row.account_manager_id));
}

/**
 * ---- the company record changes what an invoice says and when it falls due ---------
 *
 * A field nobody reads is a field nobody fills in. These two do something:
 * legalName is who the client legally is on a document, and paymentTermsDays is
 * their own arrangement, which used to be ignored by every path that raised an
 * invoice without a person present.
 */
{
  const made = await post('/folders', { name: 'E2E-CR Kestrel Trading', businessId: biz.id });
  const FID = (await made.json()).folder.id;
  await patch(`/folders/${FID}`, {
    legalName: 'Kestrel Trading Enterprises (Pty) Ltd',
    billingEmail: 'accounts@kestrel.example',
    billingAddress: '12 Loop Street, Cape Town',
    billingVatNumber: '4111222333',
    paymentTermsDays: 45,
  });

  // A quote turned into an invoice is the most common source in the app.
  const q = await post('/documents', {
    type: 'quote', businessId: biz.id, folderId: FID,
    clientName: 'Kestrel Trading Enterprises (Pty) Ltd',
    issueDate: new Date().toISOString().slice(0, 10),
    lines: [{ description: 'Retainer', quantity: 1, unitPrice: 5000 }],
  });
  const quote = (await q.json()).document;
  ok(q.status === 201 || q.status === 200, 'a quote is raised for them', String(q.status));

  const conv = await post(`/documents/${quote.id}/convert`);
  const invoiceId = (await conv.json().catch(() => ({}))).document?.id;
  ok(!!invoiceId, 'and turned into an invoice', String(conv.status));

  if (invoiceId) {
    const [[inv]] = await db.query(
      `SELECT DATE_FORMAT(issue_date, '%Y-%m-%d') AS issued,
              DATE_FORMAT(due_date, '%Y-%m-%d') AS due
         FROM documents WHERE id = ?`, [invoiceId]);
    const days = Math.round(
      (new Date(inv.due + 'T00:00:00Z') - new Date(inv.issued + 'T00:00:00Z')) / 86400000);
    ok(days === 45,
      "the client's own 45 day terms set the due date, not the business default", `${days} days`);
  }

  // Zero is a real arrangement and must not be read as "unset".
  await patch(`/folders/${FID}`, { paymentTermsDays: 0 });
  const q2 = await post('/documents', {
    type: 'quote', businessId: biz.id, folderId: FID, clientName: 'Kestrel',
    issueDate: new Date().toISOString().slice(0, 10),
    lines: [{ description: 'Ad hoc', quantity: 1, unitPrice: 100 }],
  });
  const quote2 = (await q2.json()).document;
  const conv2 = await post(`/documents/${quote2.id}/convert`);
  const inv2Id = (await conv2.json().catch(() => ({}))).document?.id;
  if (inv2Id) {
    const [[inv2]] = await db.query(
      `SELECT DATE_FORMAT(issue_date, '%Y-%m-%d') AS issued,
              DATE_FORMAT(due_date, '%Y-%m-%d') AS due FROM documents WHERE id = ?`, [inv2Id]);
    ok(inv2.due === inv2.issued,
      'and zero days means due on receipt, not "fall back to the default"', `${inv2.issued} -> ${inv2.due}`);
  }

  await db.query('DELETE FROM documents WHERE folder_id = ?', [FID]);
  await db.query('DELETE FROM folders WHERE id = ?', [FID]);
}

// ---- the backup carries the company record ------------------------------------------
{
  const r = await fetch(API + '/account/export', { headers: { cookie } });
  if (r.ok) {
    const dump = await r.json();
    // The export calls them `clients`, not `folders`: that is the word the restore
    // reads and the word a person opening the JSON would look for.
    const f = (dump.clients ?? dump.folders ?? []).find((x) => x.id === CID);
    ok(!!f && 'regNumber' in f && 'clientStatus' in f && 'financialYearEnd' in f,
      'the weekly backup carries the company record, not just the billing details');
    const flat = JSON.stringify(dump).toLowerCase();
    ok(!flat.includes('password_hash') && !flat.includes('access_token_enc'),
      'and still carries no credentials, which is what the column allow-list is for');
  } else {
    ok(false, 'the export endpoint answers', String(r.status));
  }
}

await clean();
await db.end();
console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURES');
process.exit(failures ? 1 : 0);
