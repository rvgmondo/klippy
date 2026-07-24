/* Right-click any page or selection -> "Add to Klippy" without opening the popup. */
const MENU_ID = 'klippy-add';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: 'Add to Klippy',
    contexts: ['page', 'selection', 'link'],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  const { klippy, lastBoard } = await chrome.storage.sync.get(['klippy', 'lastBoard']);
  if (!klippy?.token) return notify('Open the Klippy extension once to connect it first.');

  const title = (info.selectionText || tab?.title || 'Note').slice(0, 200);
  const url = info.linkUrl || info.pageUrl || tab?.url || '';

  try {
    const call = async (path, opts = {}) => {
      const headers = { Authorization: `Bearer ${klippy.token}` };
      if (opts.body) headers['Content-Type'] = 'application/json';
      const res = await fetch(`${klippy.baseUrl}/api/v1${path}`, { ...opts, headers });
      const text = await res.text();
      const data = text ? JSON.parse(text) : null;
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      return data;
    };

    let boardId = lastBoard;
    if (!boardId) {
      const { folders } = await call('/folders');
      for (const f of folders) {
        const { boards } = await call(`/boards?folderId=${f.id}`);
        if (boards.length) { boardId = boards[0].id; break; }
      }
    }
    if (!boardId) return notify('No board found in Klippy yet.');

    const full = await call(`/boards/${boardId}/full`);
    const col = full.columns[0];
    if (!col) return notify('That board has no columns.');

    await call('/tasks', {
      method: 'POST',
      body: JSON.stringify({ boardId, columnId: col.id, title, description: url || null }),
    });
    notify(`Added: ${title.slice(0, 60)}`);
  } catch (e) {
    notify(`Klippy: ${e.message}`);
  }
});

function notify(message) {
  // Badge feedback only; no notifications permission needed.
  chrome.action.setBadgeText({ text: message.startsWith('Added') ? 'OK' : '!' });
  chrome.action.setTitle({ title: message });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 4000);
}
