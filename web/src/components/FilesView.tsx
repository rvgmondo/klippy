import { useRef, useState } from 'react';
import { confirmDialog, promptDialog } from './ConfirmDialog';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ChevronRight, ChevronDown, Folder, FolderPlus, Upload, Download,
  MoreHorizontal, File as FileIcon, HardDrive, Paperclip, Search, X,
} from 'lucide-react';
import { apiGet, apiPost, apiPatch, apiDelete } from '../lib/api';
import { navigateTo } from '../lib/urlAction';
import { Menu } from './Menu';
import { Modal } from './Modal';
import { CanvasPage, PageHeader } from './PageHeader';

/**
 * The drive, and every file attached to a card.
 *
 * Attachments used to live only inside their card, so finding "the logo Johan
 * sent" meant remembering which card it went on. They now have their own place
 * here, searchable with everything else. Files can be dropped straight onto the
 * page and moved into any folder, not only up one level.
 */

interface Node {
  id: number;
  kind: 'folder' | 'file';
  name: string;
  size: number | null;
  mimeType: string | null;
  updatedAt: string;
  uploaderName: string | null;
  parentId?: number | null;
}
interface TreeFolder { id: number; parentId: number | null; name: string }
interface Attachment {
  id: number; name: string; size: number; mimeType: string; uploadedAt: string;
  taskId: number; taskTitle: string; boardId: number; boardName: string; clientName: string;
}
type Place = number | null | 'attachments';

function fmtBytes(b: number | null): string {
  if (!b) return '';
  if (b >= 1073741824) return `${(b / 1073741824).toFixed(1)} GB`;
  if (b >= 1048576) return `${(b / 1048576).toFixed(1)} MB`;
  if (b >= 1024) return `${Math.round(b / 1024)} KB`;
  return `${b} B`;
}

export function FilesView() {
  const qc = useQueryClient();
  const [place, setPlace] = useState<Place>(null);
  const cwd = place === 'attachments' ? null : place;
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [dropping, setDropping] = useState(false);
  const [moving, setMoving] = useState<Node | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['storage', cwd],
    queryFn: () => apiGet<{ items: Node[]; path: { id: number; name: string }[] }>(
      `/storage${cwd === null ? '' : `?parentId=${cwd}`}`),
    enabled: place !== 'attachments',
  });
  const tree = useQuery({ queryKey: ['storage-tree'], queryFn: () => apiGet<{ folders: TreeFolder[] }>('/storage/tree') });
  const usage = useQuery({ queryKey: ['storage-usage'], queryFn: () => apiGet<{ files: number; bytes: number }>('/storage/usage') });
  const attachments = useQuery({ queryKey: ['attachments'], queryFn: () => apiGet<{ files: Attachment[] }>('/files/attachments') });
  const needle = q.trim();
  const found = useQuery({
    queryKey: ['storage-search', needle],
    queryFn: () => apiGet<{ items: Node[] }>(`/storage/search?q=${encodeURIComponent(needle)}`),
    enabled: needle.length > 0,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['storage'] });
    qc.invalidateQueries({ queryKey: ['storage-tree'] });
    qc.invalidateQueries({ queryKey: ['storage-usage'] });
    qc.invalidateQueries({ queryKey: ['storage-search'] });
  };

  const mkdir = useMutation({
    mutationFn: (name: string) => apiPost('/storage/folder', { name, parentId: cwd }),
    onSuccess: refresh,
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not create folder.'),
  });
  const rename = useMutation({
    mutationFn: (v: { id: number; name: string }) => apiPatch(`/storage/${v.id}`, { name: v.name }),
    onSuccess: refresh,
  });
  const move = useMutation({
    mutationFn: (v: { id: number; parentId: number | null }) => apiPatch(`/storage/${v.id}`, { parentId: v.parentId }),
    onSuccess: () => { refresh(); setMoving(null); },
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not move.'),
  });
  const remove = useMutation({
    mutationFn: (id: number) => apiDelete(`/storage/${id}`),
    onSuccess: refresh,
  });

  async function upload(files: FileList | File[]) {
    setUploading(true); setError(null);
    try {
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.append('file', file);
        const res = await fetch(`/api/v1/storage/upload${cwd === null ? '' : `?parentId=${cwd}`}`, {
          method: 'POST', body: form, credentials: 'same-origin',
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error ?? `Upload failed for ${file.name}`);
        }
      }
      refresh();
      if (place === 'attachments') setPlace(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed.');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  const folders = tree.data?.folders ?? [];
  const roots = folders.filter((f) => f.parentId === null);
  const atts = attachments.data?.files ?? [];
  const lower = needle.toLowerCase();
  const attShown = needle ? atts.filter((a) => `${a.name} ${a.clientName} ${a.taskTitle}`.toLowerCase().includes(lower)) : atts;
  const items: Node[] = needle ? (found.data?.items ?? []) : (data?.items ?? []);
  const showDrive = place !== 'attachments' || !!needle;
  const showAtt = place === 'attachments' || !!needle;

  return (
    <CanvasPage>
      <PageHeader view="files" title="Files"
        subtitle="Contracts and assets, and everything attached to a card."
        actions={(
          <>
            <button onClick={async () => { const n = await promptDialog('Folder name'); if (n?.trim()) mkdir.mutate(n.trim()); }}
              className="flex min-h-9 items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 text-xs text-slate-300 hover:bg-slate-800">
              <FolderPlus size={14} /> New folder
            </button>
            <button onClick={() => fileRef.current?.click()} disabled={uploading}
              className="flex min-h-9 items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3 text-xs font-medium text-[var(--accent-ink)] hover:opacity-90 disabled:opacity-60">
              <Upload size={14} /> {uploading ? 'Uploading' : 'Upload'}
            </button>
            <input ref={fileRef} type="file" multiple className="hidden"
              onChange={(e) => { if (e.target.files?.length) void upload(e.target.files); }} />
          </>
        )} />
    <div className="flex min-h-0 flex-1">
      <aside className="hidden w-56 shrink-0 flex-col border-r border-slate-800 md:flex">
        <div className="flex items-center gap-2 border-b border-slate-800 px-3 py-2.5 text-xs font-semibold uppercase tracking-wider text-slate-500">
          <HardDrive size={13} /> Files
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          <button onClick={() => { setPlace(null); setQ(''); }}
            className={`mb-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
              place === null ? 'bg-[var(--accent-quiet)] text-[var(--accent)]' : 'text-slate-300 hover:bg-slate-800/60'}`}>
            <HardDrive size={14} /> All files
          </button>
          {roots.map((f) => (
            <TreeNode key={f.id} folder={f} all={folders} depth={0} cwd={cwd} onOpen={(id) => { setPlace(id); setQ(''); }} />
          ))}
          <button onClick={() => { setPlace('attachments'); setQ(''); }}
            className={`mt-3 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
              place === 'attachments' ? 'bg-[var(--accent-quiet)] text-[var(--accent)]' : 'text-slate-300 hover:bg-slate-800/60'}`}>
            <Paperclip size={14} /> Card attachments
            <span className="num ml-auto text-xs text-slate-500">{atts.length || ''}</span>
          </button>
        </div>
        {usage.data && (
          <div className="border-t border-slate-800 px-3 py-2 text-[11px] text-slate-500">
            {usage.data.files} file{usage.data.files === 1 ? '' : 's'}, {fmtBytes(usage.data.bytes) || '0 B'}
          </div>
        )}
      </aside>

      <div className={`relative flex min-w-0 flex-1 flex-col ${dropping ? 'bg-[var(--accent-quiet)]' : ''}`}
        onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDropping(true); } }}
        onDragLeave={(e) => { if (e.currentTarget === e.target) setDropping(false); }}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault(); setDropping(false);
          void upload(e.dataTransfer.files);
        }}>
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 px-4 py-3">
          <div className="flex min-w-0 flex-1 items-center gap-1 text-sm">
            {needle ? <span className="text-slate-300">Results for "{needle}"</span>
              : place === 'attachments' ? <span className="text-slate-300">Card attachments</span>
                : (
                  <>
                    <button onClick={() => setPlace(null)} className="shrink-0 text-slate-400 hover:text-slate-200">All files</button>
                    {(data?.path ?? []).map((p) => (
                      <span key={p.id} className="flex min-w-0 items-center gap-1">
                        <ChevronRight size={13} className="shrink-0 text-slate-500" />
                        <button onClick={() => setPlace(p.id)} className="truncate text-slate-300 hover:text-slate-100">{p.name}</button>
                      </span>
                    ))}
                  </>
                )}
          </div>
          <label className="relative w-full sm:w-64">
            <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a file" aria-label="Find a file"
              className="w-full rounded-lg border border-slate-700 bg-slate-900/70 py-1.5 pl-8 pr-8 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-[var(--accent)]" />
            {q && <button onClick={() => setQ('')} aria-label="Clear search" className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-200"><X size={13} /></button>}
          </label>
        </div>

        {error && (
          <div className="mx-4 mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {error} <button onClick={() => setError(null)} className="ml-2 underline">dismiss</button>
          </div>
        )}
        {dropping && (
          <div className="pointer-events-none absolute inset-3 z-10 grid place-items-center rounded-xl border-2 border-dashed border-[var(--accent)] text-sm text-[var(--accent)]">
            Drop to upload{data?.path?.length ? ` into ${data.path[data.path.length - 1]!.name}` : ''}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {showDrive && (
            <>
              {needle && <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">In your files</h3>}
              {(needle ? found.isLoading : isLoading) && <p className="text-sm text-slate-500">Loading</p>}
              {!(needle ? found.isLoading : isLoading) && items.length === 0 && (
                needle ? <p className="mb-4 text-sm text-slate-500">Nothing in your files is called that.</p> : (
                  <div className="grid h-full min-h-48 place-items-center text-center text-sm text-slate-500">
                    <div>
                      <p>This folder is empty.</p>
                      <p className="mt-1 text-xs">Drop files here, or use Upload.</p>
                    </div>
                  </div>
                )
              )}
              <div className="mb-6 space-y-1">
                {items.map((n) => (
                  <div key={n.id} className="group flex items-center gap-3 rounded-lg border border-slate-800 px-3 py-2 hover:bg-slate-900">
                    {n.kind === 'folder'
                      ? <Folder size={16} className="shrink-0 text-[var(--accent)]" />
                      : <FileIcon size={16} className="shrink-0 text-slate-500" />}
                    {n.kind === 'folder' ? (
                      <button onClick={() => { setPlace(n.id); setQ(''); }} className="min-w-0 flex-1 truncate text-left text-sm text-slate-200 hover:text-slate-100">
                        {n.name}
                      </button>
                    ) : (
                      <a href={`/api/v1/storage/${n.id}/download`}
                        className="min-w-0 flex-1 truncate text-sm text-slate-200 hover:text-[var(--accent)] hover:underline">
                        {n.name}
                      </a>
                    )}
                    <span className="hidden shrink-0 text-xs text-slate-500 sm:block">{fmtBytes(n.size)}</span>
                    <span className="hidden shrink-0 text-xs text-slate-500 lg:block">{new Date(n.updatedAt).toLocaleDateString()}</span>
                    {n.kind === 'file' && (
                      <a href={`/api/v1/storage/${n.id}/download`} title="Download"
                        className="hidden shrink-0 text-slate-500 hover:text-slate-200 group-hover:block"><Download size={14} /></a>
                    )}
                    <Menu
                      trigger={<span className="shrink-0 text-slate-500 hover:text-slate-200"><MoreHorizontal size={15} /></span>}
                      items={[
                        { label: 'Rename', onClick: async () => { const v = await promptDialog('New name', n.name); if (v?.trim()) rename.mutate({ id: n.id, name: v.trim() }); } },
                        { label: 'Move to...', onClick: () => setMoving(n) },
                        { label: 'Delete', danger: true, onClick: async () => {
                          if (await confirmDialog(n.kind === 'folder'
                            ? `Delete "${n.name}" and everything inside it? This cannot be undone.`
                            : `Delete "${n.name}"? This cannot be undone.`)) remove.mutate(n.id);
                        } },
                      ]}
                    />
                  </div>
                ))}
              </div>
            </>
          )}

          {showAtt && (
            <>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Attached to cards</h3>
              {attShown.length === 0 ? (
                <p className="text-sm text-slate-500">{needle ? 'No attachment is called that.' : 'Nothing attached to a card yet. Files added on a card show up here.'}</p>
              ) : (
                <div className="space-y-1">
                  {attShown.map((a) => (
                    <div key={a.id} className="group flex items-center gap-3 rounded-lg border border-slate-800 px-3 py-2 hover:bg-slate-900">
                      <Paperclip size={15} className="shrink-0 text-slate-500" />
                      <span className="min-w-0 flex-1">
                        <a href={`/api/v1/files/${a.id}/download`} className="block truncate text-sm text-slate-200 hover:text-[var(--accent)] hover:underline">{a.name}</a>
                        <button onClick={() => navigateTo('board', { board: String(a.boardId) })}
                          className="block truncate text-left text-xs text-slate-500 hover:text-slate-300">
                          {a.clientName}, {a.boardName}, on "{a.taskTitle}"
                        </button>
                      </span>
                      <span className="hidden shrink-0 text-xs text-slate-500 sm:block">{fmtBytes(a.size)}</span>
                      <span className="hidden shrink-0 text-xs text-slate-500 lg:block">{new Date(a.uploadedAt).toLocaleDateString()}</span>
                      <a href={`/api/v1/files/${a.id}/download`} title="Download" className="shrink-0 text-slate-500 hover:text-slate-200"><Download size={14} /></a>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>

      {moving && (
        <Modal onClose={() => setMoving(null)} size="sm">
          <div className="p-5">
            <h2 className="text-base font-semibold text-slate-100">Move "{moving.name}"</h2>
            <p className="mb-3 mt-0.5 text-xs text-slate-500">Pick where it should live.</p>
            <div className="max-h-80 space-y-0.5 overflow-y-auto">
              <button onClick={() => move.mutate({ id: moving.id, parentId: null })}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-slate-200 hover:bg-slate-800">
                <HardDrive size={14} /> All files (the top)
              </button>
              {flatten(folders, null, 0)
                // A folder cannot go inside itself or anything under it.
                .filter((f) => moving.kind !== 'folder' || !isInside(folders, f.id, moving.id))
                .map((f) => (
                  <button key={f.id} onClick={() => move.mutate({ id: moving.id, parentId: f.id })}
                    className="flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left text-sm text-slate-200 hover:bg-slate-800"
                    style={{ paddingLeft: 8 + f.depth * 14 }}>
                    <Folder size={14} className="text-[var(--accent)]" /> {f.name}
                  </button>
                ))}
            </div>
          </div>
        </Modal>
      )}
    </CanvasPage>
  );
}

function flatten(all: TreeFolder[], parent: number | null, depth: number): (TreeFolder & { depth: number })[] {
  return all.filter((f) => f.parentId === parent).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((f) => [{ ...f, depth }, ...flatten(all, f.id, depth + 1)]);
}
/** Is `id` the folder `ancestor` or somewhere under it? */
function isInside(all: TreeFolder[], id: number, ancestor: number): boolean {
  for (let cur: number | null = id, i = 0; cur != null && i < 200; i++) {
    if (cur === ancestor) return true;
    cur = all.find((f) => f.id === cur)?.parentId ?? null;
  }
  return false;
}

function TreeNode({ folder, all, depth, cwd, onOpen }: {
  folder: TreeFolder; all: TreeFolder[]; depth: number; cwd: number | null; onOpen: (id: number) => void;
}) {
  const [open, setOpen] = useState(depth === 0);
  const kids = all.filter((f) => f.parentId === folder.id);
  return (
    <div>
      <div className="flex items-center gap-1 rounded-md hover:bg-slate-800/60" style={{ paddingLeft: depth * 10 }}>
        {kids.length > 0 ? (
          <button onClick={() => setOpen(!open)} className="text-slate-500 hover:text-slate-300">
            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
        ) : <span className="w-[13px]" />}
        <button onClick={() => onOpen(folder.id)}
          className={`flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left text-sm ${
            cwd === folder.id ? 'text-[var(--accent)]' : 'text-slate-300'}`}>
          <Folder size={13} className="shrink-0" />
          <span className="truncate">{folder.name}</span>
        </button>
      </div>
      {open && kids.map((k) => (
        <TreeNode key={k.id} folder={k} all={all} depth={depth + 1} cwd={cwd} onOpen={onOpen} />
      ))}
    </div>
  );
}
