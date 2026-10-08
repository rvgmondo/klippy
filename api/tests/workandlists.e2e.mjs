/**
 * The Tasks list, the Work tree's board counts, and duplicating documents.
 *
 * Each block names what would be quietly wrong:
 *   - Tasks shows every open task across clients, and nothing from another account
 *   - finished tasks only appear when asked for
 *   - the tree knows which clients have boards
 *   - "add a task to..." lists every board with a column to put it in
 *   - a duplicate is a fresh draft with the same lines, and nothing that happened
 *     to the original (status, payments, decision) comes along
 *   - duplicating as the other type works, credit notes refuse
 *   - the invoice list says what is still owed and which came from the old system
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
    body: JSON.stringify({ password: 'worklistpass1', accountName: `Work ${tag}`, name: 'Wes Work', email, blueprint: 'agency', currency: 'ZAR', vatRegistered: false }),
  });
  const cookie = cookieOf(r);
  const account = (await r.json()).account;
  const A = async (method, p, b) => {
    const res = await fetch(API + p, { method, headers: { ...(b ? { 'content-type': 'application/json' } : {}), cookie }, body: b ? JSON.stringify(b) : undefined });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  return { A, account, cookie };
};
const today = new Date().toISOString().slice(0, 10);

const { A, account, cookie: cookieOfA } = await signup(`work.${tag}@test.local`);
const biz = (await A('GET', '/businesses')).body.businesses[0];
const acme = (await A('POST', '/folders', { name: 'Acme Work', businessId: biz.id })).body.folder.id;
const empty = (await A('POST', '/folders', { name: 'Nothing Yet', businessId: biz.id })).body.folder.id;
const board = (await A('POST', '/boards', { folderId: acme, name: 'Website' })).body.board ?? (await A('POST', '/boards', { folderId: acme, name: 'Website 2' })).body.board;
const boardId = board?.id;
ok(!!boardId, 'a board for the client');

// ---- the tree's board counts -------------------------------------------------------
const folders = (await A('GET', '/folders')).body.folders;
ok(folders.find((f) => f.id === acme)?.boardCount >= 1 && folders.find((f) => f.id === empty)?.boardCount === 0,
  'the client list says which clients have boards', `${folders.find((f) => f.id === acme)?.boardCount}, ${folders.find((f) => f.id === empty)?.boardCount}`);

// ---- all boards, for "add a task to..." -----------------------------------------------
const allBoards = (await A('GET', '/boards/all')).body.boards ?? [];
const mine = allBoards.find((b) => b.id === boardId);
ok(!!mine && mine.folderName === 'Acme Work' && mine.firstColumnId > 0, 'every board is listed with a column to add to', JSON.stringify(mine));

// ---- the Tasks list -------------------------------------------------------------------------
const t1 = (await A('POST', '/tasks', { boardId, columnId: mine.firstColumnId, title: 'Late thing', dueDate: '2026-01-01' })).body.task;
const t2 = (await A('POST', '/tasks', { boardId, columnId: mine.firstColumnId, title: 'Undated thing' })).body.task;
let list = (await A('GET', '/tasks/all')).body.tasks ?? [];
const titles = list.map((t) => t.title);
ok(titles.includes('Late thing') && titles.includes('Undated thing'), 'Tasks lists open work from every board', titles.join(', '));
ok(list.find((t) => t.title === 'Late thing')?.folderName === 'Acme Work', 'with the client it belongs to');
ok(titles.indexOf('Late thing') < titles.indexOf('Undated thing'), 'dated work before undated');
await A('PATCH', `/tasks/${t1.id}`, { isCompleted: true });
list = (await A('GET', '/tasks/all')).body.tasks;
ok(!list.some((t) => t.id === t1.id), 'a finished task leaves the open list');
const done = (await A('GET', '/tasks/all?done=true')).body.tasks;
ok(done.some((t) => t.id === t1.id) && !done.some((t) => t.id === t2.id), 'and shows when asking for done work');

const { A: B } = await signup(`work.other.${tag}@test.local`);
const theirs = (await B('GET', '/tasks/all')).body.tasks ?? [];
ok(!theirs.some((t) => t.id === t2.id), 'another account never sees these tasks');
ok(!((await B('GET', '/boards/all')).body.boards ?? []).some((b) => b.id === boardId), 'or these boards');

// ---- what each card carries on the board ---------------------------------------------
await A('POST', '/subtasks', { taskId: t2.id, title: 'One' });
const st = (await A('POST', '/subtasks', { taskId: t2.id, title: 'Two' })).body;
const subId = st.subtask?.id ?? st.id;
if (subId) await A('PATCH', `/subtasks/${subId}`, { isCompleted: true });
await A('POST', '/comments', { taskId: t2.id, comment: 'Noted' });
const full = (await A('GET', `/boards/${boardId}/full`)).body;
const card = full.tasks?.find((t) => t.id === t2.id);
ok(card?.subtaskTotal === 2 && card?.commentCount === 1, 'a board card says how much of its checklist is done and how many comments it has', `${card?.subtaskDone}/${card?.subtaskTotal}, ${card?.commentCount}`);

// ---- files: search the drive, find what is attached to cards ---------------------------
const formPost = async (cookie, path, name) => {
  const fd = new FormData();
  fd.append('file', new Blob(['hello'], { type: 'text/plain' }), name);
  const r = await fetch(API + path, { method: 'POST', headers: { cookie }, body: fd });
  return r.status;
};
const upDrive = await formPost(cookieOfA, '/storage/upload', `brief-${tag}.txt`);
const upCard = await formPost(cookieOfA, `/tasks/${t2.id}/files`, `logo-${tag}.txt`);
const foundDrive = (await A('GET', `/storage/search?q=brief-${tag}`)).body.items ?? [];
ok(upDrive < 300 && foundDrive.length === 1, 'a file in the drive can be found by name', `${upDrive}, ${foundDrive.length}`);
const atts = (await A('GET', '/files/attachments')).body.files ?? [];
const att = atts.find((f) => f.name === `logo-${tag}.txt`);
ok(upCard < 300 && att?.clientName === 'Acme Work' && att?.taskTitle === 'Undated thing', 'a file on a card is listed with its client and card', JSON.stringify(att ?? upCard));
ok(((await B('GET', `/storage/search?q=brief-${tag}`)).body.items ?? []).length === 0, 'another account cannot find it');
ok(!((await B('GET', '/files/attachments')).body.files ?? []).some((f) => f.name === `logo-${tag}.txt`), 'or see the card attachment');

// ---- duplicating documents ---------------------------------------------------------------------
const inv = (await A('POST', '/documents', {
  type: 'invoice', businessId: biz.id, folderId: acme, clientName: 'Acme Work', issueDate: '2026-01-15',
  lines: [{ description: 'Design', quantity: 2, unitPrice: 500 }, { description: 'Hosting', quantity: 1, unitPrice: 250 }],
})).body.document;
await db.query("UPDATE documents SET status = 'sent' WHERE id = ?", [inv.id]);
await A('POST', `/documents/${inv.id}/payments`, { amount: 1250, paidOn: today });
const copy = await A('POST', `/documents/${inv.id}/duplicate`, {});
ok(copy.status === 201 && copy.body.document?.type === 'invoice' && copy.body.document.number !== inv.number, 'an invoice duplicates into a new number', copy.body.document?.number);
const [[c]] = await db.query('SELECT status, issue_date i, due_date d, total, folder_id f FROM documents WHERE id = ?', [copy.body.document.id]);
const [lines] = await db.query('SELECT description, amount FROM document_lines WHERE document_id = ? ORDER BY position', [copy.body.document.id]);
const [[{ n: copyPays }]] = await db.query('SELECT COUNT(*) n FROM payments WHERE document_id = ?', [copy.body.document.id]);
ok(c.status === 'draft' && c.i === today && c.d > today, 'as a draft dated today with a fresh due date', `${c.status} ${c.i} ${c.d}`);
ok(lines.length === 2 && lines[0].description === 'Design' && Number(c.total) === 1250 && c.f === acme, 'with the same client, lines and total');
ok(Number(copyPays) === 0, 'and none of the original payments');

const asQuote = await A('POST', `/documents/${inv.id}/duplicate`, { as: 'quote' });
ok(asQuote.body.document?.type === 'quote' && /^QUO-/.test(asQuote.body.document.number), 'an invoice can be copied as a quote', asQuote.body.document?.number);
const cn = (await A('POST', `/documents/${inv.id}/credit-note`, { reason: 'test' })).body.document;
if (cn) ok((await A('POST', `/documents/${cn.id}/duplicate`, {})).status === 400, 'a credit note cannot be duplicated');
ok((await B('POST', `/documents/${inv.id}/duplicate`, {})).status === 404, 'another account cannot duplicate it');

// ---- the list knows what is owed ----------------------------------------------------------------
const part = (await A('POST', '/documents', {
  type: 'invoice', businessId: biz.id, clientName: 'Part Payer', issueDate: today,
  lines: [{ description: 'Work', quantity: 1, unitPrice: 1000 }],
})).body.document;
await db.query("UPDATE documents SET status = 'sent' WHERE id = ?", [part.id]);
await A('POST', `/documents/${part.id}/payments`, { amount: 400, paidOn: today });
const docs = (await A('GET', '/documents?type=invoice')).body.documents;
const row = docs.find((d) => d.id === part.id);
ok(row?.outstanding === 600 && row.imported === false, 'the invoice list says what is still owed on each', JSON.stringify({ o: row?.outstanding }));
ok(docs.find((d) => d.id === inv.id)?.outstanding === 0, 'and nothing on a paid one');

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
await db.end();
process.exit(failures ? 1 : 0);
