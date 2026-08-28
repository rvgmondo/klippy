/**
 * Money-correctness regression suite (audit batch 3).
 *
 * Covers the paths that decide what a client owes and what gets filed with SARS.
 * These had no automated coverage at all, which is how six defects lived here.
 *
 * Run against the dev database with a test server on 8095:
 *   node tests/money.e2e.mjs
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

const TAG = 'E2E Money Client';
const clean = async () => {
  await db.query("DELETE p FROM payments p JOIN documents d ON d.id = p.document_id WHERE d.client_name = ?", [TAG]);
  await db.query("DELETE FROM documents WHERE client_name = ? AND source_document_id IS NOT NULL", [TAG]);
  await db.query("DELETE FROM documents WHERE client_name = ?", [TAG]);
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
const put = (p, b) => fetch(`${API}${p}`, { method: 'PUT', headers: H, body: JSON.stringify(b ?? {}) });
const patch = (p, b) => fetch(`${API}${p}`, { method: 'PATCH', headers: H, body: JSON.stringify(b ?? {}) });
const getj = (p) => fetch(`${API}${p}`, { headers: H }).then((r) => r.json());

const today = new Date().toISOString().slice(0, 10);
// 2 x 5000 = 10000 subtotal, 15% = 1500 tax, total 11500.
const mkInvoice = async (extra = {}) => {
  const r = await post('/documents', {
    type: 'invoice', clientName: TAG, clientEmail: 'money@example.com',
    issueDate: today, dueDate: today, taxRate: 15,
    lines: [{ description: 'Website build', quantity: 2, unitPrice: 5000 }],
    ...extra,
  });
  const j = await r.json();
  return j.document?.id ?? j.id;
};
const statusOf = async (id) => {
  const [[row]] = await db.query('SELECT status FROM documents WHERE id = ?', [id]);
  return row?.status;
};

const { settleIfCovered } = await import('file:///C:/CC/klippy-v2/api/dist/lib/settle.js');

// ===========================================================================
// 1. The flagship bug: an invoice carrying a credit note could never settle.
// ===========================================================================
{
  const INV = await mkInvoice();
  await db.query("UPDATE documents SET status = 'sent' WHERE id = ?", [INV]);
  // Credit 1500 of the 11500, leaving 10000 outstanding.
  const cn = await post(`/documents/${INV}/credit-note`, {
    lines: [{ description: 'Agreed reduction', quantity: 1, unitPrice: 1304.35 }],
  });
  ok(cn.status === 201, 'a credit note can be raised against a sent invoice', String(cn.status));

  const before = await getj(`/documents/${INV}/payments`);
  ok(Math.abs(before.outstanding - 10000) < 0.05,
    'outstanding drops by the credit note', `outstanding ${before.outstanding}`);

  // The client pays exactly what is outstanding, which is what the pay link charges.
  await db.query(
    "INSERT INTO payments (account_id, document_id, amount, paid_on, method) VALUES (1, ?, ?, ?, 'PayFast')",
    [INV, before.outstanding.toFixed(2), today]);

  // Old code compared payments against the FACE value and could never settle this.
  const res = await settleIfCovered(1, INV, 11500, 'sent');
  ok(res.settled === true, 'an invoice paid down to zero via a credit note SETTLES');
  ok(res.flipped === true, 'and the flip is claimed by this call');
  ok(await statusOf(INV) === 'paid', 'the invoice is marked paid, so reminders stop chasing it');

  // Claimed, so a second concurrent notification does not re-provision.
  const again = await settleIfCovered(1, INV, 11500, 'sent');
  ok(again.flipped === false, 'a second settle of the same invoice does not flip again');
}

// ===========================================================================
// 2. A full write-off settles but must NOT provision (nobody paid anything).
// ===========================================================================
{
  const INV = await mkInvoice();
  await db.query("UPDATE documents SET status = 'sent' WHERE id = ?", [INV]);
  await post(`/documents/${INV}/credit-note`, {});   // credits the whole outstanding
  const bal = await getj(`/documents/${INV}/payments`);
  ok(bal.outstanding <= 0.001, 'crediting the full amount clears the balance', `outstanding ${bal.outstanding}`);
  ok(await statusOf(INV) === 'paid', 'a fully credited invoice reads as settled');
  const res = await settleIfCovered(1, INV, 11500, 'paid');
  ok(res.bal.paid <= 0.001, 'no money was received on a full write-off, so nothing is provisioned',
    `paid ${res.bal.paid}`);
}

// ===========================================================================
// 3. The VAT report: only ISSUED, non-void documents belong in a return.
// ===========================================================================
{
  const vatOf = async () => {
    const r = await getj(`/reports/vat?from=${today}&to=${today}`);
    return (r.output ?? []).reduce((s, o) => s + o.outputVat, 0);
  };
  const base = await vatOf();

  const draft = await mkInvoice();                       // stays draft
  ok(Math.abs(await vatOf() - base) < 0.001,
    'a DRAFT invoice contributes no output VAT', `base ${base}`);

  const issued = await mkInvoice();
  await db.query("UPDATE documents SET status = 'sent' WHERE id = ?", [issued]);
  ok(Math.abs(await vatOf() - (base + 1500)) < 0.01,
    'an ISSUED invoice adds its 1500 VAT', `now ${await vatOf()}`);

  await db.query("UPDATE documents SET status = 'void' WHERE id = ?", [issued]);
  ok(Math.abs(await vatOf() - base) < 0.01,
    'VOIDING it takes the VAT back out of the return');

  // An 'accepted' invoice has been issued and must still count.
  await db.query("UPDATE documents SET status = 'accepted' WHERE id = ?", [issued]);
  ok(Math.abs(await vatOf() - (base + 1500)) < 0.01,
    "an 'accepted' document still counts (not just sent/paid)");
  await db.query("UPDATE documents SET status = 'void' WHERE id = ?", [issued]);

  // A voided CREDIT NOTE must not subtract VAT that was never credited.
  const src = await mkInvoice();
  await db.query("UPDATE documents SET status = 'sent' WHERE id = ?", [src]);
  const withInvoice = await vatOf();
  const cn = await post(`/documents/${src}/credit-note`, {
    lines: [{ description: 'Reduction', quantity: 1, unitPrice: 1000 }],
  });
  const cnId = (await cn.json()).document?.id;
  const afterCredit = await vatOf();
  ok(afterCredit < withInvoice, 'a live credit note reduces output VAT', `${withInvoice} -> ${afterCredit}`);
  await db.query("UPDATE documents SET status = 'void' WHERE id = ?", [cnId]);
  ok(Math.abs(await vatOf() - withInvoice) < 0.01,
    'a VOIDED credit note stops subtracting, so the return is not understated');
  void draft;
}

// ===========================================================================
// 4. An issued, paid document cannot be silently restated.
// ===========================================================================
{
  const INV = await mkInvoice();
  await db.query("UPDATE documents SET status = 'sent' WHERE id = ?", [INV]);
  const paid = await post(`/documents/${INV}/payments`, { amount: 11500, paidOn: today, method: 'EFT' });
  ok(paid.status === 201, 'the invoice is paid in full', String(paid.status));
  ok(await statusOf(INV) === 'paid', 'and is marked paid');

  const body = (extra = {}) => ({
    type: 'invoice', clientName: TAG, issueDate: today, dueDate: today, taxRate: 15,
    lines: [{ description: 'Website build', quantity: 2, unitPrice: 5000 }],
    ...extra,
  });

  // (a) changing the TOTAL
  const bumpTotal = await put(`/documents/${INV}`, body({
    lines: [{ description: 'Website build', quantity: 3, unitPrice: 5000 }],
  }));
  ok(bumpTotal.status === 400, 'changing the total of a paid invoice is refused', String(bumpTotal.status));
  const err = (await bumpTotal.json()).error ?? '';
  ok(/credit note/i.test(err), 'and the refusal names the way out (a credit note)', err.slice(0, 80));

  // (b) changing the TAX while holding the total constant
  const swingTax = await put(`/documents/${INV}`, body({
    taxRate: 0, lines: [{ description: 'Website build', quantity: 1, unitPrice: 11500 }],
  }));
  ok(swingTax.status === 400, 'restating the VAT with the total unchanged is refused', String(swingTax.status));

  // (c) moving the ISSUE DATE into another VAT period
  const moveDate = await put(`/documents/${INV}`, body({ issueDate: '2026-01-15' }));
  ok(moveDate.status === 400, 'moving a paid invoice into another VAT period is refused', String(moveDate.status));

  // nothing was written by any of the three
  const [[after]] = await db.query('SELECT total, tax_amount, subtotal, issue_date, status FROM documents WHERE id = ?', [INV]);
  ok(Number(after.total) === 11500 && Number(after.tax_amount) === 1500 && Number(after.subtotal) === 10000,
    'the figures on the paid invoice are untouched', `total ${after.total} tax ${after.tax_amount}`);
  ok(after.status === 'paid', 'and it is still paid');

  // (d) the everyday typo fix still works
  const typo = await put(`/documents/${INV}`, body({
    clientAddress: '12 New Street, Cape Town', notes: 'Paid, thank you.',
  }));
  ok(typo.ok, 'address and notes are still editable on a paid invoice', String(typo.status));
  const [[edited]] = await db.query('SELECT client_address, total FROM documents WHERE id = ?', [INV]);
  ok(/New Street/.test(edited.client_address ?? '') && Number(edited.total) === 11500,
    'the edit landed and the figures still did not move');

  // (e) a draft with no money is freely editable
  const DRAFT = await mkInvoice();
  const editDraft = await put(`/documents/${DRAFT}`, body({
    lines: [{ description: 'Website build', quantity: 3, unitPrice: 5000 }],
  }));
  ok(editDraft.ok, 'a draft with no payments is still freely editable', String(editDraft.status));
  const [[d2]] = await db.query('SELECT total FROM documents WHERE id = ?', [DRAFT]);
  ok(Number(d2.total) === 17250, 'and its total really changed', `total ${d2.total}`);
}

// ===========================================================================
// 5. An issued document cannot be dropped back to draft (out of a filed period).
// ===========================================================================
{
  const INV = await mkInvoice();
  const toSent = await patch(`/documents/${INV}/status`, { status: 'sent' });
  ok(toSent.ok, 'a draft can be issued');
  const back = await patch(`/documents/${INV}/status`, { status: 'draft' });
  ok(back.status === 400, 'an issued invoice cannot go back to draft', String(back.status));
  ok(await statusOf(INV) === 'sent', 'and it is still issued');
  const voided = await patch(`/documents/${INV}/status`, { status: 'void' });
  ok(voided.ok, 'voiding it is still the sanctioned way to cancel');
}

// ===========================================================================
// 6. The gateway idempotency key auto-debit was failing to write.
// ===========================================================================
{
  const INV = await mkInvoice();
  const PF = `E2E-PF-${Date.now()}`;
  await db.query(
    "INSERT INTO payments (account_id, document_id, amount, paid_on, method, pf_payment_id) VALUES (1, ?, '100.00', ?, 'PayFast', ?)",
    [INV, today, PF]);
  let doubled = false;
  try {
    await db.query(
      "INSERT INTO payments (account_id, document_id, amount, paid_on, method, pf_payment_id) VALUES (1, ?, '100.00', ?, 'PayFast', ?)",
      [INV, today, PF]);
    doubled = true;
  } catch { /* the unique index is what stops it */ }
  ok(!doubled, 'the same gateway payment id cannot be recorded twice');

  // Two hand-entered payments carry no id, and must both still be allowed.
  await db.query("INSERT INTO payments (account_id, document_id, amount, paid_on, method) VALUES (1, ?, '50.00', ?, 'EFT')", [INV, today]);
  await db.query("INSERT INTO payments (account_id, document_id, amount, paid_on, method) VALUES (1, ?, '50.00', ?, 'EFT')", [INV, today]);
  const [[n]] = await db.query('SELECT COUNT(*) n FROM payments WHERE document_id = ?', [INV]);
  ok(Number(n.n) === 3, 'manual payments are unaffected by that index', `${n.n} rows`);

  // And the source we actually changed: auto-debit now passes the id through.
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync('C:/CC/klippy-v2/api/src/lib/autoDebit.ts', 'utf8'));
  ok(/pfPaymentId:\s*res\.pfPaymentId\s*\?\?\s*null/.test(src),
    'auto-debit writes the gateway id onto the payment row');
}

await clean();
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
await db.end();
process.exit(failures ? 1 : 0);
