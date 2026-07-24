import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, ChevronDown, Folder, FolderPlus, Plus, SquareKanban, MoreHorizontal } from 'lucide-react';
import { apiGet, apiPost, apiPatch, apiDelete } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Menu } from './Menu';
import type { Board, Folder as TFolder } from '../lib/types';

interface Props {
  selectedBoardId: number | null;
  onSelectBoard: (id: number) => void;
}

function ask(prompt: string, current: string): string | null {
  const v = window.prompt(prompt, current);
  return v && v.trim() ? v.trim() : null;
}

export function Sidebar({ selectedBoardId, onSelectBoard }: Props) {
  const { account } = useAuth();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['folders'], queryFn: () => apiGet<{ folders: TFolder[] }>('/folders') });
  const folders = data?.folders ?? [];

  const createFolder = useMutation({
    mutationFn: (v: { name: string; parentId: number | null }) => apiPost('/folders', v),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['folders'] }),
  });

  const roots = folders.filter((f) => f.parentId === null);

  function addTopFolder() {
    const name = window.prompt(`New ${account?.folderLabelSingular ?? 'folder'} name`);
    if (name?.trim()) createFolder.mutate({ name: name.trim(), parentId: null });
  }

  return (
    <aside className="flex h-full w-full shrink-0 flex-col border-r border-slate-800 bg-slate-950/40">
      <div className="flex h-14 items-center gap-2 border-b border-slate-800 px-4">
        <div className="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-violet-500 to-indigo-600 text-sm font-bold text-white">K</div>
        <span className="font-semibold text-white">Klippy</span>
      </div>

      <div className="flex items-center justify-between px-4 pb-1 pt-4">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
          {account?.folderLabelPlural ?? 'Folders'}
        </span>
        <button onClick={addTopFolder} title={`Add ${account?.folderLabelSingular ?? 'folder'}`}
          className="grid h-6 w-6 place-items-center rounded text-slate-400 hover:bg-slate-800 hover:text-slate-200">
          <FolderPlus size={15} />
        </button>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {roots.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-slate-600">
            No {account?.folderLabelPlural?.toLowerCase() ?? 'folders'} yet.<br />Click + to add one.
          </p>
        )}
        {roots.map((f) => (
          <FolderNode key={f.id} folder={f} all={folders} depth={0}
            selectedBoardId={selectedBoardId} onSelectBoard={onSelectBoard} />
        ))}
      </nav>
    </aside>
  );
}

function FolderNode({ folder, all, depth, selectedBoardId, onSelectBoard }: {
  folder: TFolder; all: TFolder[]; depth: number;
  selectedBoardId: number | null; onSelectBoard: (id: number) => void;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(depth === 0);
  const children = all.filter((f) => f.parentId === folder.id);

  const boards = useQuery({
    queryKey: ['boards', folder.id],
    queryFn: () => apiGet<{ boards: Board[] }>(`/boards?folderId=${folder.id}`),
    enabled: open,
  });

  const createFolder = useMutation({
    mutationFn: (name: string) => apiPost('/folders', { name, parentId: folder.id }),
    onSuccess: () => { setOpen(true); qc.invalidateQueries({ queryKey: ['folders'] }); },
  });
  const createBoard = useMutation({
    mutationFn: (name: string) => apiPost('/boards', { folderId: folder.id, name }),
    onSuccess: () => { setOpen(true); qc.invalidateQueries({ queryKey: ['boards', folder.id] }); },
  });
  const renameFolder = useMutation({
    mutationFn: (name: string) => apiPatch(`/folders/${folder.id}`, { name }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['folders'] }),
  });
  const deleteFolder = useMutation({
    mutationFn: () => apiDelete(`/folders/${folder.id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['folders'] }),
  });

  const hasKids = children.length > 0 || (boards.data?.boards.length ?? 0) > 0;

  return (
    <div>
      <div className="group flex items-center gap-1 rounded-md px-1.5 py-1.5 hover:bg-slate-800/60"
        style={{ paddingLeft: depth * 12 + 6 }}>
        <button onClick={() => setOpen(!open)} className="text-slate-500 hover:text-slate-300">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <Folder size={14} style={{ color: folder.color }} />
        <button onClick={() => setOpen(!open)} className="flex-1 truncate text-left text-sm text-slate-200">{folder.name}</button>
        <button title="Add board"
          onClick={() => { const n = ask('Board name', ''); if (n) createBoard.mutate(n); }}
          className="hidden text-slate-500 hover:text-slate-200 group-hover:block">
          <Plus size={14} />
        </button>
        <Menu
          trigger={<span className="hidden text-slate-500 hover:text-slate-200 group-hover:block"><MoreHorizontal size={14} /></span>}
          items={[
            { label: 'Add board', onClick: () => { const n = ask('Board name', ''); if (n) createBoard.mutate(n); } },
            { label: 'Add subfolder', onClick: () => { const n = ask('Subfolder name', ''); if (n) createFolder.mutate(n); } },
            { label: 'Rename', onClick: () => { const n = ask('Rename folder', folder.name); if (n) renameFolder.mutate(n); } },
            { label: 'Delete', danger: true, onClick: () => { if (confirm(`Delete "${folder.name}"${hasKids ? ' and everything inside it' : ''}? This cannot be undone.`)) deleteFolder.mutate(); } },
          ]}
        />
      </div>

      {open && (
        <div>
          {(boards.data?.boards ?? []).map((b) => (
            <BoardRow key={b.id} board={b} folderId={folder.id} depth={depth}
              selected={selectedBoardId === b.id} onSelect={() => onSelectBoard(b.id)} />
          ))}
          {children.map((c) => (
            <FolderNode key={c.id} folder={c} all={all} depth={depth + 1}
              selectedBoardId={selectedBoardId} onSelectBoard={onSelectBoard} />
          ))}
        </div>
      )}
    </div>
  );
}

function BoardRow({ board, folderId, depth, selected, onSelect }: {
  board: Board; folderId: number; depth: number; selected: boolean; onSelect: () => void;
}) {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ['boards', folderId] });
  const rename = useMutation({ mutationFn: (name: string) => apiPatch(`/boards/${board.id}`, { name }), onSuccess: invalidate });
  const del = useMutation({ mutationFn: () => apiDelete(`/boards/${board.id}`), onSuccess: invalidate });

  return (
    <div className={`group flex items-center gap-2 rounded-md pr-1 ${selected ? 'bg-violet-600/20' : 'hover:bg-slate-800/60'}`}
      style={{ paddingLeft: depth * 12 + 30 }}>
      <button onClick={onSelect}
        className={`flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left text-sm ${selected ? 'text-violet-200' : 'text-slate-400'}`}>
        <SquareKanban size={13} className="shrink-0" />
        <span className="truncate">{board.name}</span>
      </button>
      <Menu
        trigger={<span className="hidden text-slate-500 hover:text-slate-200 group-hover:block"><MoreHorizontal size={13} /></span>}
        items={[
          { label: 'Rename', onClick: () => { const n = ask('Rename board', board.name); if (n) rename.mutate(n); } },
          { label: 'Delete', danger: true, onClick: () => { if (confirm(`Delete board "${board.name}" and its cards? This cannot be undone.`)) del.mutate(); } },
        ]}
      />
    </div>
  );
}
