/* Klippy Quick Add - popup logic.
 * Auth is an API token (Settings > Tokens in Klippy), sent as a Bearer header.
 * Cookies can't be used from an extension origin, which is why tokens exist.
 */
const $ = (id) => document.getElementById(id);
const DEFAULT_BASE = 'https://klippy.mondobase.com';

let cfg = { baseUrl: '', token: '' };

async function api(path, opts = {}) {
  const headers = { Authorization: `Bearer ${cfg.token}`, ...(opts.headers || {}) };
  if (opts.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${cfg.baseUrl}/api/v1${path}`, { ...opts, headers });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { /* non-JSON error page */ } }
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

function show(el, on) { el.classList.toggle('hidden', !on); }
function note(el, text, kind) { el.innerHTML = text ? `<div class="msg ${kind}">${text}</div>` : ''; }

// ---- Setup ---------------------------------------------------------------
$('save').addEventListener('click', async () => {
  const baseUrl = ($('baseUrl').value || DEFAULT_BASE).trim().replace(/\/+$/, '');
  const token = $('token').value.trim();
  if (!token) return note($('setupMsg'), 'Paste your access token.', 'err');
  cfg = { baseUrl, token };
  try {
    await api('/auth/me');                       // validates the token
    await chrome.storage.sync.set({ klippy: cfg });
    note($('setupMsg'), '', '');
    await start();
  } catch (e) {
    note($('setupMsg'), e.message.includes('authenticated') ? 'That token was rejected.' : e.message, 'err');
  }
});

$('reset').addEventListener('click', async () => {
  await chrome.storage.sync.remove('klippy');
  cfg = { baseUrl: '', token: '' };
  show($('app'), false); show($('setup'), true);
});

// ---- Quick add -----------------------------------------------------------
$('add').addEventListener('click', async () => {
  const title = $('title').value.trim();
  if (!title) return note($('msg'), 'Give the card a title.', 'err');
  const boardId = Number($('board').value);
  if (!boardId) return note($('msg'), 'Pick a board.', 'err');

  $('add').disabled = true;
  try {
    const full = await api(`/boards/${boardId}/full`);
    const firstCol = full.columns[0];
    if (!firstCol) throw new Error('That board has no columns yet.');
    await api('/tasks', {
      method: 'POST',
      body: JSON.stringify({
        boardId,
        columnId: firstCol.id,
        title,
        description: $('notes').value.trim() || null,
        priority: $('priority').value,
        dueDate: $('due').value || null,
      }),
    });
    note($('msg'), 'Added to Klippy.', 'ok');
    $('title').value = ''; $('notes').value = ''; $('due').value = '';
    loadDue();
  } catch (e) {
    note($('msg'), e.message, 'err');
  } finally {
    $('add').disabled = false;
  }
});

// ---- Loading -------------------------------------------------------------
async function loadBoards() {
  const sel = $('board');
  sel.innerHTML = '';
  const { folders } = await api('/folders');
  const lists = await Promise.all(
    folders.map((f) => api(`/boards?folderId=${f.id}`).then((r) => r.boards).catch(() => [])),
  );
  const boards = lists.flat();
  if (!boards.length) {
    sel.innerHTML = '<option value="">No boards yet</option>';
    return;
  }
  for (const b of boards) {
    const o = document.createElement('option');
    o.value = b.id; o.textContent = b.name;
    sel.appendChild(o);
  }
  const saved = (await chrome.storage.sync.get('lastBoard')).lastBoard;
  if (saved && boards.some((b) => b.id === saved)) sel.value = String(saved);
  sel.addEventListener('change', () => chrome.storage.sync.set({ lastBoard: Number(sel.value) }));
}

async function loadDue() {
  const el = $('dueList');
  try {
    const today = new Date().toISOString().slice(0, 10);
    const from = '2000-01-01';
    const { tasks } = await api(`/tasks/calendar?from=${from}&to=${today}`);
    const open = tasks.filter((t) => !t.isCompleted);
    if (!open.length) { el.innerHTML = '<span class="hint">Nothing due. Nice.</span>'; return; }
    el.innerHTML = open.slice(0, 8).map((t) => {
      const late = t.dueDate < today;
      return `<a href="${cfg.baseUrl}" target="_blank" class="${late ? 'overdue' : ''}">${
        late ? '! ' : ''}${escapeHtml(t.title)} <span class="hint">${t.dueDate}</span></a>`;
    }).join('');
  } catch {
    el.innerHTML = '<span class="hint">Could not load.</span>';
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function prefillFromTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    if (!$('title').value) $('title').value = tab.title || '';
    if (!$('notes').value && tab.url) $('notes').value = tab.url;
  } catch { /* no activeTab permission granted yet */ }
}

async function start() {
  show($('setup'), false);
  show($('app'), true);
  await prefillFromTab();
  await loadBoards();
  await loadDue();
  $('title').focus();
}

(async function init() {
  const stored = (await chrome.storage.sync.get('klippy')).klippy;
  if (stored?.token) {
    cfg = stored;
    try { await api('/auth/me'); await start(); return; }
    catch { /* token revoked -> fall through to setup */ }
  }
  $('baseUrl').value = DEFAULT_BASE;
  show($('setup'), true);
})();
