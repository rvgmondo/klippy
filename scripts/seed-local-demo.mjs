/**
 * A realistic local workspace for clicking through Klippy on this machine.
 *
 * LOCAL ONLY. Talks to the dev API on 127.0.0.1:8090 and refuses anything else.
 * Creates (or reuses) one test login and fills it with two businesses, clients,
 * boards, tasks with due dates and estimates, meetings and invoices in every state.
 * The login is a throwaway test credential for the local database, nothing more.
 *
 *   node scripts/seed-local-demo.mjs
 */
const API = 'http://127.0.0.1:8090/api/v1';
const LOGIN = { email: 'demo@klippy.local', password: 'local-demo-only-1' };

const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const at = (n, h, m = 0) => { const d = new Date(); d.setDate(d.getDate() + n); d.setHours(h, m, 0, 0); return d.toISOString(); };

let cookie = '';
async function call(method, path, body) {
  const r = await fetch(API + path, {
    method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = r.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} ${r.status}: ${json.error ?? JSON.stringify(json)}`);
  return json;
}

// Sign in, or make the account the first time.
try {
  await call('POST', '/auth/login', LOGIN);
  console.log('Signed in to the existing demo login; adding a fresh batch.');
} catch {
  await call('POST', '/auth/signup', {
    accountName: 'Mondobase', name: 'Demo Owner', ...LOGIN,
    blueprint: 'agency', currency: 'ZAR', vatRegistered: true, vatNumber: '4123456789',
  });
  console.log('Made the demo login.');
}

const { businesses } = await call('GET', '/businesses');
const mb = businesses[0];
let mh = businesses.find((b) => b.name === 'Mondo Hosting');
if (!mh) mh = (await call('POST', '/businesses', { name: 'Mondo Hosting', type: 'services' })).business;
await call('PATCH', `/businesses/${mh.id}`, { defaultTaxRate: 0 });
await call('PATCH', `/businesses/${mb.id}`, { bankDetails: 'FNB Business, 62841927351, branch 250655' });

const client = async (name, businessId, extra = {}) => {
  const { folder } = await call('POST', '/folders', { name, parentId: null, businessId, pillar: 'delivery' });
  if (Object.keys(extra).length) await call('PATCH', `/folders/${folder.id}`, extra);
  return folder;
};
const board = async (folderId, name) => {
  const { board: b } = await call('POST', '/boards', { folderId, name });
  const full = await call('GET', `/boards/${b.id}/full`);
  return { id: b.id, columns: full.columns ?? full.board?.columns ?? [] };
};
const task = (b, col, title, dueDate, estimateMinutes) =>
  call('POST', '/tasks', { boardId: b.id, columnId: b.columns[col]?.id ?? b.columns[0].id, title, dueDate, estimateMinutes });

const acme = await client('Acme Plumbing', mb.id, { billingEmail: 'admin@acme.example', billingPhone: '0835550121', billingAddress: '44 Esselen Street, Sunnyside, Pretoria' });
const bird = await client('Early Bird Coffee', mb.id, { billingEmail: 'thandi@earlybird.example', billingPhone: '0825550142' });
const kloof = await client('Kloof Street Dental', mb.id, { billingEmail: 'reception@kloof.example' });
const crane = await client('Blue Crane Guesthouse', mh.id, { billingPhone: '0845550155' });

const site = await board(acme.id, 'Homepage build');
await task(site, 1, 'Homepage copy', day(-3), 120);
await task(site, 0, 'Contact page form', null, 60);
await task(site, 0, 'Photos from Johan', day(2), 15);
const social = await board(bird.id, 'Social content');
await task(social, 0, 'October posts', day(0), 90);
await task(social, 0, 'Spring specials artwork', day(1), 60);
const care = await board(kloof.id, 'Website care');
await task(care, 0, 'Plugin updates', day(0), 30);
await task(care, 0, 'Monthly report', day(5), 45);
const hosting = await board(crane.id, 'Hosting');
await task(hosting, 0, 'Renew SSL certificate', day(-1), 15);

await call('POST', '/calendar-events', { title: 'Call with Thandi', kind: 'call', startAt: at(0, 14), endAt: at(0, 14, 30), folderId: bird.id, businessId: mb.id });
await call('POST', '/calendar-events', { title: 'Site visit, Acme', kind: 'meeting', startAt: at(1, 9), endAt: at(1, 10), folderId: acme.id, businessId: mb.id, location: '44 Esselen Street' });

const invoice = async (folder, businessId, total, issue, due, status, type = 'invoice') => {
  const { document } = await call('POST', '/documents', {
    type, folderId: folder.id, businessId, clientName: folder.name, issueDate: issue, dueDate: due,
    taxRate: businessId === mb.id ? 15 : 0, lines: [{ description: 'Work done', quantity: 1, unitPrice: total }],
  });
  if (status !== 'draft') await call('PATCH', `/documents/${document.id}/status`, { status });
  return document;
};
await invoice(acme, mb.id, 8000, day(-64), day(-34), 'sent');
const part = await invoice(bird, mb.id, 4000, day(-26), day(-12), 'sent');
await call('POST', `/documents/${part.id}/payments`, { amount: 1000, paidOn: day(-5), method: 'EFT' });
await invoice(kloof, mb.id, 2000, day(-14), day(0), 'sent');
await invoice(acme, mb.id, 3000, day(-4), day(26), 'draft');
await invoice(crane, mh.id, 450, day(-20), day(-6), 'sent');
await invoice(bird, mb.id, 12500, day(-8), day(22), 'sent', 'quote');

console.log(`Done. Sign in at http://localhost:5173 as ${LOGIN.email} (the password is in this file).`);
