import { useRef, useState } from 'react';
import { confirmDialog, promptDialog } from './ConfirmDialog';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ChevronRight, ChevronDown, Folder, FolderPlus, Upload, Download,
  MoreHorizontal, File as FileIcon, HardDrive,
} from 'lucide-react';
import { apiGet, apiPost, apiPatch, apiDelete } from '../lib/api';
import { Menu } from './Menu';
import { CanvasPage, PageHeader } from './PageHeader';

interface Node {
  id: number;
  kind: 'folder' | 'file';
  name: string;
  size: number | null;
  mimeType: string | null;
  updatedAt: string;
  uploaderName: string | null;
}
interface TreeFolder { id: number; parentId: number | null; name: string }

function fmtBytes(b: number | null): string {
  if (!b) return '';
  if (b >= 1073741824) return `${(b / 1073741824).toFixed(1)} GB`;
  if (b >= 1048576) return `${(b / 1048576).toFixed(1)} MB`;
  if (b >= 1024) return `${Math.round(b / 1024)} KB`;
  return `${b} B`;
}

export function FilesView() {
  const qc = useQueryClient();
  const [cwd, setCwd] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const listKey = ['storage', cwd];
  const { data, isLoading } = useQuery({
    queryKey: listKey,
    queryFn: () => apiGet<{ items: Node[]; path: { id: number; name: string }[] }>(
      `/storage${cwd === null ? '' : `?parentId=${cwd}`}`),
  });
  const tree = useQuery({ queryKey: ['storage-tree'], queryFn: () => apiGet<{ folders: TreeFolder[] }>('/storage/tree') });
  const usage = useQuery({ queryKey: ['storage-usage'], queryFn: () => apiGet<{ files: number; bytes: number }>('/storage/usage') });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['storage'] });
    qc.invalidateQueries({ queryKey: ['storage-tree'] });
    qc.invalidateQueries({ queryKey: ['storage-usage'] });
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
    onSuccess: refresh,
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not move.'),
  });
  const remove = useMutation({
    mutationFn: (id: number) => apiDelete(`/storage/${id}`),
    onSuccess: refresh,
  });

  async function upload(files: FileList) {
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
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed.');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  const items = data?.items ?? [];
  const roots = (tree.data?.folders ?? []).filter((f) => f.parentId === null);

  return (
    <CanvasPage>
      <PageHeader view="files" title="Files"
        subtitle="Contracts and assets, kept next to the work."
        actions={(
          <>
            <button onClick={async () => { const n = await promptDialog('Folder name'); if (n?.trim()) mkdir.mutate(n.trim()); }}
              className="flex min-h-9 items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 text-xs text-slate-300 hover:bg-slate-800">
              <FolderPlus size={14} /> New folder
            </button>
            <button onClick={() => fileRef.current?.click()} disabled={uploading}
              className="flex min-h-9 items-center gap-1.5 rounded-lg bg-violet-600 px-3 text-xs font-medium text-[var(--accent-ink)] hover:bg-violet-500 disabled:opacity-60">
              <Upload size={14} /> {uploading ? 'Uploading...' : 'Upload'}
            </button>
            <input ref={fileRef} type="file" multiple className="hidden"
              onChange={(e) => { if (e.target.files?.length) upload(e.target.files); }} />
          </>
        )} />
    <div className="flex min-h-0 flex-1">
      {/* Tree */}
      <aside className="hidden w-56 shrink-0 flex-col border-r border-slate-800 md:flex">
        <div className="flex items-center gap-2 border-b border-slate-800 px-3 py-2.5 text-xs font-semibold uppercase tracking-wider text-slate-500">
          <HardDrive size={13} /> Files
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          <button onClick={() => setCwd(null)}
            className={`mb-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
              cwd === null ? 'bg-violet-600/20 text-violet-200' : 'text-slate-300 hover:bg-slate-800/60'}`}>
            <HardDrive size={14} /> All files
          </button>
          {roots.map((f) => (
            <TreeNode key={f.id} folder={f} all={tree.data?.folders ?? []} depth={0} cwd={cwd} onOpen={setCwd} />
          ))}
        </div>
        {usage.data && (
          <div className="border-t border-slate-800 px-3 py-2 text-[11px] text-slate-500">
            {usage.data.files} file{usage.data.files === 1 ? '' : 's'}, {fmtBytes(usage.data.bytes) || '0 B'}
          </div>
        )}
      </aside>

      {/* Contents */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 px-4 py-3">
          <div className="flex min-w-0 flex-1 items-center gap-1 text-sm">
            <button onClick={() => setCwd(null)} className="shrink-0 text-slate-400 hover:text-slate-200">All files</button>
            {(data?.path ?? []).map((p) => (
              <span key={p.id} className="flex min-w-0 items-center gap-1">
                <ChevronRight size={13} className="shrink-0 text-slate-500" />
                <button onClick={() => setCwd(p.id)} className="truncate text-slate-300 hover:text-slate-100">{p.name}</button>
              </span>
            ))}
          </div>
        </div>

        {error && (
          <div className="mx-4 mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {error} <button onClick={() => setError(null)} className="ml-2 underline">dismiss</button>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {isLoading && <p className="text-sm text-slate-500">Loading...</p>}
          {!isLoading && items.length === 0 && (
            <div className="grid h-full place-items-center text-center text-sm text-slate-500">
              <div>
                <p>This folder is empty.</p>
                <p className="mt-1 text-xs">Upload files or create a folder to get started.</p>
              </div>
            </div>
          )}
          <div className="space-y-1">
            {items.map((n) => (
              <div key={n.id} className="group flex items-center gap-3 rounded-lg border border-slate-800 px-3 py-2 hover:bg-slate-900">
                {n.kind === 'folder'
                  ? <Folder size={16} className="shrink-0 text-violet-400" />
                  : <FileIcon size={16} className="shrink-0 text-slate-500" />}
                {n.kind === 'folder' ? (
                  <button onClick={() => setCwd(n.id)} className="min-w-0 flex-1 truncate text-left text-sm text-slate-200 hover:text-slate-100">
                    {n.name}
                  </button>
                ) : (
                  <a href={`/api/v1/storage/${n.id}/download`}
                    className="min-w-0 flex-1 truncate text-sm text-slate-200 hover:text-violet-300 hover:underline">
                    {n.name}
                  </a>
                )}
                <span className="hidden shrink-0 text-xs text-slate-500 sm:block">{fmtBytes(n.size)}</span>
                <span className="hidden shrink-0 text-xs text-slate-500 lg:block">
                  {new Date(n.updatedAt).toLocaleDateString()}
                </span>
                {n.kind === 'file' && (
                  <a href={`/api/v1/storage/${n.id}/download`} title="Download"
                    className="hidden shrink-0 text-slate-500 hover:text-slate-200 group-hover:block"><Download size={14} /></a>
                )}
                <Menu
                  trigger={<span className="shrink-0 text-slate-500 hover:text-slate-200"><MoreHorizontal size={15} /></span>}
                  items={[
                    { label: 'Rename', onClick: async () => { const v = await promptDialog('New name', n.name); if (v?.trim()) rename.mutate({ id: n.id, name: v.trim() }); } },
                    ...(cwd !== null ? [{ label: 'Move up one level', onClick: () => move.mutate({ id: n.id, parentId: null }) }] : []),
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
        </div>
      </div>
    </div>
    </CanvasPage>
  );
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
            cwd === folder.id ? 'text-violet-300' : 'text-slate-300'}`}>
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
