/**
 * A stand-in for the Klippy API, for clicking through the web app on a machine
 * where the database cannot run. NOT shipped, NOT used by the real server.
 *
 * It answers the screens' requests with one realistic sample workspace: two
 * businesses, clients, invoices in every state, tasks, a meeting, a deal and a
 * failed post. Writes are accepted and logged, so buttons can be pressed without
 * anything leaving the machine. Anything it does not know is logged as UNKNOWN,
 * which is how the list of endpoints a screen needs is found.
 *
 *   node scripts/mock-api.mjs        (listens on 127.0.0.1:8090, where Vite proxies /api)
 */
import http from 'node:http';

const PORT = Number(process.env.PORT || 8090);
const today = new Date().toISOString().slice(0, 10);
const day = (n) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

const account = { id: 1, name: 'Mondo Group', slug: 'mondo', plan: 'pro', folderLabelSingular: 'Client', folderLabelPlural: 'Clients', brandName: 'Mondo Group', hasLogo: false, currency: 'ZAR' };
const user = { id: 1, name: 'Ruben Test', email: 'owner@example.test', role: 'owner', accountId: 1, theme: 'dark' };
const MODS = ['today', 'calendar', 'reports', 'files', 'pipeline', 'offerings', 'social', 'billing', 'collections', 'cashflow', 'expenses'];
const businesses = [
  { id: 1, accountId: 1, name: 'Mondobase', type: 'services', secondaryTypes: [], color: '#c6f432', currency: 'ZAR', defaultDueDays: 14, modules: MODS, position: 0, remindersEnabled: true },
  { id: 2, accountId: 1, name: 'Mondo Hosting', type: 'code', secondaryTypes: [], color: '#38bdf8', currency: 'ZAR', defaultDueDays: 7, modules: ['today', 'billing', 'collections', 'cashflow', 'files'], position: 1, remindersEnabled: true },
];
const f = (id, businessId, name, color, extra = {}) => ({ id, accountId: 1, businessId, parentId: null, name, color, notes: null, pillar: 'delivery', position: id, ...extra });
const folders = [
  f(10, 1, 'Acme Plumbing', '#f59e0b', { billingEmail: 'admin@acme.example', billingPhone: '0835550121', billingAddress: '44 Esselen Street, Sunnyside, Pretoria', legalName: 'Acme Plumbing CC', regNumber: '2008/117762/23', website: 'acme.example', paymentTermsDays: 30, notes: 'Johan prefers WhatsApp. Pays on the 25th.' }),
  f(11, 1, 'Early Bird Coffee', '#fb7185', { billingEmail: 'thandi@earlybird.example', billingPhone: '0825550142' }),
  f(12, 1, 'Nordic Studio', '#a78bfa', { billingEmail: 'hello@nordic.example' }),
  f(13, 2, 'Blue Crane Guesthouse', '#34d399', { billingPhone: '0845550155' }),
  f(14, 1, 'Kloof Street Dental', '#60a5fa', {}),
  { ...f(20, 1, 'Admin', '#94a3b8'), pillar: 'operations' },
];
const clientName = (fid) => folders.find((x) => x.id === fid)?.name ?? 'Walk-in';
let nextId = 200;
// Signed in until the app signs out, so the landing page and sign-up can be walked too.
let signedIn = true;
const docs = [
  { id: 31, type: 'invoice', number: 'INV-0031', status: 'sent', folderId: 10, businessId: 1, issueDate: day(-64), dueDate: day(-34), total: '9200.00', currency: 'ZAR', lastReminderOn: day(-4) },
  { id: 42, type: 'invoice', number: 'INV-0042', status: 'sent', folderId: 11, businessId: 1, issueDate: day(-26), dueDate: day(-12), total: '4600.00', currency: 'ZAR', lastReminderOn: null },
  { id: 43, type: 'invoice', number: 'INV-0043', status: 'sent', folderId: 12, businessId: 1, issueDate: day(-33), dueDate: day(-3), total: '1200.00', currency: 'USD', lastReminderOn: null },
  { id: 50, type: 'invoice', number: 'INV-0050', status: 'sent', folderId: 11, businessId: 1, issueDate: day(-14), dueDate: today, total: '2000.00', currency: 'ZAR' },
  { id: 51, type: 'invoice', number: 'INV-0051', status: 'draft', folderId: 10, businessId: 1, issueDate: day(-4), dueDate: day(26), total: '3450.00', currency: 'ZAR', createdAt: `${day(-4)}T08:00:00.000Z` },
  { id: 52, type: 'invoice', number: 'INV-0052', status: 'sent', folderId: 10, businessId: 1, issueDate: day(-2), dueDate: day(28), total: '7350.00', currency: 'ZAR' },
  { id: 101, type: 'invoice', number: 'MH-0101', status: 'sent', folderId: 13, businessId: 2, issueDate: day(-80), dueDate: day(-6), total: '450.00', currency: 'ZAR' },
  { id: 47, type: 'invoice', number: 'INV-0047', status: 'paid', folderId: 14, businessId: 1, issueDate: day(-20), dueDate: day(-6), total: '2300.00', currency: 'ZAR' },
  { id: 14, type: 'quote', number: 'QUO-0014', status: 'sent', decision: 'accepted', folderId: 11, businessId: 1, issueDate: day(-8), dueDate: day(22), total: '12500.00', currency: 'ZAR' },
  { id: 12, type: 'quote', number: 'QUO-0012', status: 'sent', decision: null, folderId: 14, businessId: 1, issueDate: day(-28), dueDate: day(2), total: '8000.00', currency: 'ZAR' },
];
const pays = { 42: [], 47: [{ id: 1, amount: '2300.00', paidOn: today, method: 'Card' }], 101: [] };
const paidOf = (d) => (pays[d.id] ?? []).reduce((s, p) => s + Number(p.amount), 0);
const left = (d) => Math.round((Number(d.total) - paidOf(d)) * 100) / 100;
const add = (m, c, n) => { m[c] = Math.round(((m[c] ?? 0) + n) * 100) / 100; };

function clientsList(bid) {
  return folders.filter((x) => x.parentId == null && x.pillar !== 'operations' && (!bid || x.businessId === bid)).map((c) => {
    const owed = {}; const overdue = {}; let last = null;
    for (const d of docs.filter((x) => x.folderId === c.id)) {
      if (!last || d.issueDate > last) last = d.issueDate;
      if (d.type === 'invoice' && d.status === 'sent' && left(d) > 0) { add(owed, d.currency, left(d)); if (d.dueDate < today) add(overdue, d.currency, left(d)); }
    }
    return { id: c.id, name: c.name, color: c.color, businessId: c.businessId, email: c.billingEmail ?? null, phone: c.billingPhone ?? null, hasLogo: false, owed, overdue, lastActivity: last, dealOpen: c.id === 12, since: '2025-01-10T00:00:00.000Z' };
  });
}

function clientPage(id) {
  const c = folders.find((x) => x.id === id);
  if (!c) return null;
  const owed = {}; const overdue = {}; let openInvoices = 0; let lateCount = 0;
  const documents = docs.filter((d) => d.folderId === id).map((d) => {
    const out = d.type === 'invoice' ? left(d) : 0;
    const unpaid = d.type === 'invoice' && d.status === 'sent' && out > 0;
    const late = unpaid && d.dueDate < today;
    if (unpaid) { add(owed, d.currency, out); openInvoices++; }
    if (late) { add(overdue, d.currency, out); lateCount++; }
    return { ...d, total: Number(d.total), outstanding: out, late, decision: d.decision ?? null, lastReminderOn: d.lastReminderOn ?? null };
  });
  const boards = id === 10 ? [{ id: 4, name: 'Homepage build', open: 3, late: 1 }, { id: 5, name: 'Website care', open: 0, late: 0 }] : [];
  return {
    client: { ...c, hasLogo: false, createdAt: '2025-01-10T00:00:00.000Z', billingVatNumber: null, hourlyRate: '650.00', monthlyHoursBudget: null, companyType: null, country: 'ZA', taxNumber: null, industry: 'Plumbing', paymentTermsDays: c.paymentTermsDays ?? null },
    money: { owed, overdue, openInvoices, lateCount }, documents, boards,
    tasks: id === 10 ? [{ id: 1, title: 'Homepage copy', dueDate: day(-3), boardId: 4 }, { id: 2, title: 'Contact page form', dueDate: null, boardId: 4 }] : [],
    people: id === 10 ? [{ id: 1, name: 'Johan van Wyk', email: 'johan@acme.example', phone: '0835550121', role: 'Owner' }] : [],
    deals: id === 12 ? [{ id: 1, title: 'Brand refresh', stage: 'proposal', value: 18000 }] : [],
  };
}

function home(bid) {
  const items = []; const owedM = {}; const overdueM = {}; const coming = {};
  for (const d of docs) {
    if (bid && d.businessId !== bid) continue;
    const base = { businessId: d.businessId, folderId: d.folderId, clientName: clientName(d.folderId), currency: d.currency, docId: d.id, docType: d.type, docNumber: d.number };
    if (d.type === 'invoice' && d.status === 'sent' && left(d) > 0) {
      add(owedM, d.currency, left(d));
      if (d.dueDate < today) {
        add(overdueM, d.currency, left(d));
        const n = Math.round((Date.parse(today) - Date.parse(d.dueDate)) / 864e5);
        items.push({ ...base, key: `inv-${d.id}`, group: 'overdue', kind: 'invoice-late', title: `${d.number} is ${n} days overdue`, sub: d.lastReminderOn ? `Chased ${d.lastReminderOn}` : 'Not chased yet', amount: left(d), rank: -n });
      } else {
        add(coming, d.currency, left(d));
        if (d.dueDate === today) items.push({ ...base, key: `inv-${d.id}`, group: 'today', kind: 'invoice-due', title: `${d.number} is due today`, sub: 'If it is in your bank, mark it paid', amount: left(d), rank: 10 });
      }
    }
    if (d.status === 'draft') items.push({ ...base, key: `draft-${d.id}`, group: 'today', kind: 'draft', title: `${d.number} is a draft nobody has seen`, sub: 'Made 4 days ago. Nothing is owed until it goes out', amount: Number(d.total), rank: 16 });
    if (d.type === 'quote' && d.status === 'sent' && d.decision === 'accepted') items.push({ ...base, key: `qa-${d.id}`, group: 'today', kind: 'quote-accepted', title: `${clientName(d.folderId)} said yes to ${d.number}`, sub: 'It is not an invoice yet', amount: Number(d.total), rank: 5 });
    if (d.type === 'quote' && d.status === 'sent' && !d.decision && d.dueDate <= day(3)) items.push({ ...base, key: `qe-${d.id}`, group: 'week', kind: 'quote-expiring', title: `${d.number} runs out on ${d.dueDate}`, sub: 'No answer from them yet', amount: Number(d.total), rank: 2 });
  }
  if (!bid || bid === 1) {
    items.push({ key: 'task-1', group: 'overdue', kind: 'task', title: 'Homepage copy', sub: 'Acme Plumbing, Homepage build. 3 days late', businessId: 1, folderId: 10, clientName: null, taskId: 1, boardId: 4, rank: -3 });
    items.push({ key: 'ev-1', group: 'today', kind: 'event', title: 'Call with Thandi', sub: 'Zoom', at: `${today}T12:00:00.000Z`, allDay: false, businessId: 1, folderId: 11, clientName: null, eventId: 1, rank: 0 });
    items.push({ key: 'deal-1', group: 'week', kind: 'deal', title: 'Follow up: Brand refresh', sub: 'Send the revised proposal', businessId: 1, folderId: null, clientName: 'Nordic Studio', dealId: 1, rank: 1 });
    items.push({ key: 'post-1', group: 'today', kind: 'post', title: 'Spring specials', sub: 'It did not go out. Fix it and try again', businessId: 1, folderId: 11, clientName: null, postId: 1, rank: 0 });
  }
  const order = { overdue: 0, today: 1, week: 2 };
  items.sort((a, b) => order[a.group] - order[b.group] || a.rank - b.rank);
  return {
    today,
    figures: { owed: owedM, overdue: overdueM, comingIn: coming, moneyIn: { ZAR: 2300 }, byMethod: [{ method: 'Card', currency: 'ZAR', amount: 2300 }], cameInToday: [{ docId: 47, number: 'INV-0047', clientName: 'Kloof Street Dental', amount: 2300, currency: 'ZAR', method: 'Card' }] },
    items,
    didForYou: { afterReminder: { ZAR: 6900 }, afterReminderCount: 2, autoInvoices: 3, cardSelf: { ZAR: 2300 } },
    counts: { overdue: items.filter((i) => i.group === 'overdue').length, today: items.filter((i) => i.group === 'today').length, week: items.filter((i) => i.group === 'week').length },
    perBusiness: businesses.map((b) => ({ id: b.id, count: items.filter((i) => i.businessId == null || i.businessId === b.id).length })),
  };
}

const docSummary = (d) => ({ id: d.id, type: d.type, number: d.number, clientName: clientName(d.folderId), issueDate: d.issueDate, dueDate: d.dueDate, status: d.status, currency: d.currency, total: d.total });

function route(method, path, q, body) {
  const m = (re) => path.match(re);
  if (method === 'GET') {
    if (path === '/api/v1/auth/me') return signedIn ? { user, account } : [401, { error: 'Not authenticated.' }];
    if (path === '/api/v1/businesses') return { businesses };
    if (path === '/api/v1/modules') return { primitives: [], modules: MODS.concat(['takings']).map((k) => ({ key: k, label: ({ pipeline: 'Deals', offerings: 'Price list', social: 'Posts', billing: 'Quotes and invoices', collections: 'Owed to you', cashflow: 'Coming in', takings: 'Counter sales' })[k] ?? k[0].toUpperCase() + k.slice(1), primitive: 'x' })) };
    if (path === '/api/v1/folders') return { folders };
    if (path === '/api/v1/clients') return { clients: clientsList(Number(q.get('businessId')) || 0) };
    if (m(/^\/api\/v1\/clients\/(\d+)$/)) { const r = clientPage(Number(m(/(\d+)$/)[1])); return r ?? [404, { error: 'Client not found.' }]; }
    if (path === '/api/v1/home') return home(Number(q.get('businessId')) || 0);
    if (path === '/api/v1/documents') return { documents: docs.filter((d) => !q.get('type') || d.type === q.get('type')).filter((d) => !Number(q.get('businessId')) || d.businessId === Number(q.get('businessId'))).map(docSummary) };
    if (m(/^\/api\/v1\/documents\/(\d+)\/payments$/)) { const d = docs.find((x) => x.id === Number(path.split('/')[4])); return { payments: pays[d.id] ?? [], credits: [], paid: paidOf(d), credited: 0, outstanding: left(d), total: Number(d.total) }; }
    if (m(/^\/api\/v1\/documents\/(\d+)\/whatsapp-link$/)) return { url: 'https://wa.me/27835550121?text=mock', phone: '+27835550121', text: 'mock' };
    if (m(/^\/api\/v1\/documents\/(\d+)$/)) { const d = docs.find((x) => x.id === Number(path.split('/')[4])); return d ? { document: { ...docSummary(d), clientEmail: null, clientAddress: null, clientVatNumber: null, taxRate: '15', folderId: d.folderId, businessId: d.businessId, notes: null, discountType: 'none', discountValue: '0', depositType: 'none', depositValue: '0' }, lines: [{ description: 'Work done', quantity: 1, unitPrice: Number(d.total) }], brand: { name: 'Mondobase', hasLogo: false, logoUrl: null }, issuer: { name: 'Mondobase', accent: '#c6f432' } } : [404, { error: 'Not found.' }]; }
    if (path === '/api/v1/collections') { const items = docs.filter((d) => d.type === 'invoice' && d.status === 'sent' && d.dueDate < today && left(d) > 0).map((d) => ({ id: d.id, number: d.number, clientName: clientName(d.folderId), clientEmail: folders.find((x) => x.id === d.folderId)?.billingEmail ?? null, hasPhone: !!folders.find((x) => x.id === d.folderId)?.billingPhone, businessId: d.businessId, folderId: d.folderId, currency: d.currency, total: Number(d.total), outstanding: left(d), dueDate: d.dueDate, daysOverdue: Math.round((Date.parse(today) - Date.parse(d.dueDate)) / 864e5), lastReminderOn: d.lastReminderOn ?? null, suspended: false })); return { items, summary: { count: items.length, byCurrency: [], suspended: 0 } }; }
    if (path.startsWith('/api/v1/payfast/mode')) return { live: false, test: false };
    if (path === '/api/v1/onboarding') return { steps: [{ key: 'client', done: true }, { key: 'invoice', done: false }, { key: 'bank', done: false }, { key: 'brand', done: false }, { key: 'offering', done: false }, { key: 'payments', done: false }] };
    if (path.startsWith('/api/v1/notifications')) return { notifications: [], unread: 0 };
    if (path.startsWith('/api/v1/timer')) return { timer: null, running: null };
    if (path.startsWith('/api/v1/contacts')) return { contacts: [] };
    if (path.startsWith('/api/v1/boards')) return { boards: [{ id: 4, folderId: 10, name: 'Homepage build' }] };
    if (path.startsWith('/api/v1/focus')) return { items: [] };
    if (path.startsWith('/api/v1/search')) return { clients: [], tasks: [], documents: [], deals: [], contacts: [], offerings: [] };
    if (path.startsWith('/api/v1/branding') || path.startsWith('/api/v1/account')) return { account };
    if (path.startsWith('/api/v1/tasks/') && path.endsWith('/detail')) return [404, { error: 'Mock has no task detail.' }];
  }
  if (method === 'POST' && path === '/api/v1/auth/logout') { signedIn = false; return { ok: true }; }
  if (method === 'POST' && path === '/api/v1/auth/signup') {
    signedIn = true;
    Object.assign(account, { name: body.accountName, folderLabelSingular: body.blueprint === 'trade' ? 'Customer' : 'Client', folderLabelPlural: body.blueprint === 'trade' ? 'Customers' : 'Clients' });
    Object.assign(user, { name: body.name, email: body.email });
    return [201, { user, account }];
  }
  if (method === 'POST' && path === '/api/v1/collections/chase') return { sent: 1, covered: 1, skipped: [] };
  if (method === 'POST' && m(/^\/api\/v1\/documents\/(\d+)\/convert$/)) { const q0 = docs.find((x) => x.id === Number(path.split('/')[4])); const n = { ...q0, id: nextId++, type: 'invoice', number: `INV-00${nextId}`, status: 'draft', decision: null }; docs.push(n); q0.status = 'accepted'; return [201, { document: n }]; }
  if (method === 'PATCH' && m(/^\/api\/v1\/documents\/(\d+)\/status$/)) { const d = docs.find((x) => x.id === Number(path.split('/')[4])); if (d) d.status = body.status; return { ok: true }; }
  if (method === 'POST' && m(/^\/api\/v1\/documents\/(\d+)\/email$/)) { const d = docs.find((x) => x.id === Number(path.split('/')[4])); if (d && d.status === 'draft') d.status = 'sent'; return { ok: true }; }
  if (method === 'POST' && m(/^\/api\/v1\/documents\/(\d+)\/payments$/)) { const id = Number(path.split('/')[4]); (pays[id] ??= []).push({ id: nextId++, amount: String(body.amount), paidOn: body.paidOn ?? today, method: body.method ?? 'EFT' }); const d = docs.find((x) => x.id === id); if (d && left(d) <= 0) d.status = 'paid'; return [201, { ok: true }]; }
  if (method === 'POST' && path === '/api/v1/automation/tick') return { ok: true };
  if (method !== 'GET') return { ok: true };
  return undefined;
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { /* not json */ }
    let out = route(req.method, url.pathname, url.searchParams, body);
    let code = 200;
    if (Array.isArray(out)) [code, out] = out;
    if (out === undefined) { console.log('UNKNOWN', req.method, url.pathname + url.search); out = {}; }
    else if (req.method !== 'GET') console.log('WRITE', req.method, url.pathname, raw.slice(0, 200));
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
  });
}).listen(PORT, '127.0.0.1', () => console.log(`mock Klippy API on ${PORT}`));
