import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors,
  type DragEndEvent, type DraggableAttributes, type DraggableSyntheticListeners,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  ChevronRight, ChevronDown, Folder, FolderPlus, Plus, SquareKanban, MoreHorizontal, GripVertical,
  Home, Target, CalendarDays, HardDrive, BarChart3, Receipt, type LucideIcon,
} from 'lucide-react';
import { apiGet, apiPost, apiPatch, apiDelete } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Menu } from './Menu';
import { BusinessSwitcher, type BusinessSelection } from './BusinessSwitcher';
import type { Board, Business, Folder as TFolder } from '../lib/types';

interface Props {
  selectedBoardId: number | null;
  businessId: BusinessSelection;
  view: string;
  onNavigate: (v: string) => void;
  onBusinessChange: (v: BusinessSelection) => void;
  onSelectBoard: (id: number) => void;
}

const NAV: { key: string; label: string; icon: LucideIcon }[] = [
  { key: 'home', label: 'Home', icon: Home },
  { key: 'pipeline', label: 'Pipeline', icon: Target },
  { key: 'calendar', label: 'Calendar', icon: CalendarDays },
  { key: 'files', label: 'Files', icon: HardDrive },
  { key: 'reports', label: 'Reports', icon: BarChart3 },
  { key: 'billing', label: 'Billing', icon: Receipt },
];

function ask(prompt: string, current: string): string | null {
  const v = window.prompt(prompt, current);
  return v && v.trim() ? v.trim() : null;
}

// Drag handle shared by folder rows and board rows; only shows on row hover.
function Grip({ setRef, attributes, listeners }: {
  setRef: (el: HTMLElement | null) => void;
  attributes: DraggableAttributes; listeners: DraggableSyntheticListeners;
}) {
  return (
    <span ref={setRef} {...attributes} {...listeners}
      title="Drag to reorder"
      className="shrink-0 cursor-grab text-slate-600 opacity-0 hover:text-slate-300 active:cursor-grabbing group-hover:opacity-100">
      <GripVertical size={13} />
    </span>
  );
}

export function Sidebar({ selectedBoardId, businessId, view, onNavigate, onBusinessChange, onSelectBoard }: Props) {
  const { account } = useAuth();
  const { data } = useQuery({ queryKey: ['folders'], queryFn: () => apiGet<{ folders: TFolder[] }>('/folders') });
  const folders = data?.folders ?? [];
  const bizData = useQuery({ queryKey: ['businesses'], queryFn: () => apiGet<{ businesses: Business[] }>('/businesses') });
  const businesses = bizData.data?.businesses ?? [];

  // Which businesses to show: all of them, or just the selected one.
  const shown = businessId === 'all' ? businesses : businesses.filter((b) => b.id === businessId);
  const showHeaders = businessId === 'all' && businesses.length > 1;

  return (
    <aside className="flex h-full w-full shrink-0 flex-col border-r border-slate-800 bg-slate-950/40">
      <div className="flex h-14 items-center gap-2 border-b border-slate-800 px-4">
        {account?.hasLogo ? (
          <img src="/api/v1/account/logo" alt="" className="h-7 w-7 shrink-0 rounded-lg object-contain" />
        ) : (
          <div className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-violet-500 to-indigo-600 text-sm font-bold text-white">
            {(account?.brandName || 'Klippy')[0]!.toUpperCase()}
          </div>
        )}
        <span className="truncate font-semibold text-slate-100">{account?.brandName || 'Klippy'}</span>
      </div>

      {/* Business switcher */}
      <div className="border-b border-slate-800 px-2 py-2">
        <BusinessSwitcher value={businessId} onChange={onBusinessChange} full />
      </div>

      {/* Primary navigation */}
      <div className="space-y-0.5 border-b border-slate-800 px-2 py-2">
        {NAV.map((n) => {
          const Icon = n.icon;
          const active = view === n.key;
          return (
            <button key={n.key} onClick={() => onNavigate(n.key)}
              className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition ${
                active ? 'bg-violet-600/15 text-violet-200' : 'text-slate-300 hover:bg-slate-800/60 hover:text-slate-100'}`}>
              <Icon size={16} className="shrink-0" /> {n.label}
            </button>
          );
        })}
      </div>

      {/* Boards tree */}
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {shown.length === 0 && (
          <p className="px-2 py-6 text-center text-[11px] text-slate-600">No businesses yet.</p>
        )}
        {shown.map((biz) => (
          <BusinessBlock key={biz.id} business={biz} all={folders} showHeader={showHeaders}
            folderLabelSingular={account?.folderLabelSingular} folderLabelPlural={account?.folderLabelPlural}
            selectedBoardId={selectedBoardId} onSelectBoard={onSelectBoard} />
        ))}
      </nav>
    </aside>
  );
}

// One business's slice of the sidebar: its Delivery and Operations sections.
function BusinessBlock({ business, all, showHeader, folderLabelSingular, folderLabelPlural, selectedBoardId, onSelectBoard }: {
  business: Business; all: TFolder[]; showHeader: boolean;
  folderLabelSingular?: string; folderLabelPlural?: string;
  selectedBoardId: number | null; onSelectBoard: (id: number) => void;
}) {
  const qc = useQueryClient();
  const createFolder = useMutation({
    mutationFn: (v: { name: string; parentId: number | null; businessId: number; pillar: 'delivery' | 'operations' }) => apiPost('/folders', v),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['folders'] }),
  });

  const roots = all.filter((f) => f.parentId === null && f.businessId === business.id);
  const deliveryRoots = roots.filter((f) => (f.pillar ?? 'delivery') !== 'operations');
  const opsRoots = roots.filter((f) => f.pillar === 'operations');

  function addTop(pillar: 'delivery' | 'operations') {
    const what = pillar === 'operations' ? 'internal area' : (folderLabelSingular ?? 'folder');
    const name = window.prompt(`New ${what} name in ${business.name}`);
    if (name?.trim()) createFolder.mutate({ name: name.trim(), parentId: null, businessId: business.id, pillar });
  }

  return (
    <div className={showHeader ? 'mb-2 mt-3 border-t border-slate-800/70 pt-2 first:mt-0 first:border-t-0' : ''}>
      {showHeader && (
        <div className="flex items-center gap-2 px-2 pb-1">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: business.color }} />
          <span className="truncate text-xs font-semibold text-slate-200">{business.name}</span>
        </div>
      )}

      <SectionHeader label={`Delivery / ${folderLabelPlural ?? 'Clients'}`} onAdd={() => addTop('delivery')} />
      {deliveryRoots.length === 0 && (
        <p className="px-2 py-2 text-center text-[11px] text-slate-600">No {folderLabelPlural?.toLowerCase() ?? 'clients'} yet.</p>
      )}
      <FolderList folders={deliveryRoots} all={all} depth={0}
        selectedBoardId={selectedBoardId} onSelectBoard={onSelectBoard} />

      <div className="mt-4">
        <SectionHeader label="Operations / Internal" onAdd={() => addTop('operations')} />
        {opsRoots.length === 0 && (
          <p className="px-2 py-2 text-center text-[11px] text-slate-600">Admin, hiring, finance...</p>
        )}
        <FolderList folders={opsRoots} all={all} depth={0}
          selectedBoardId={selectedBoardId} onSelectBoard={onSelectBoard} />
      </div>
    </div>
  );
}

function SectionHeader({ label, onAdd }: { label: string; onAdd: () => void }) {
  return (
    <div className="flex items-center justify-between px-2 pb-1 pt-3">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{label}</span>
      <button onClick={onAdd} title="Add" className="grid h-6 w-6 place-items-center rounded text-slate-400 hover:bg-slate-800 hover:text-slate-200">
        <FolderPlus size={15} />
      </button>
    </div>
  );
}

// A drag-sortable list of sibling folders. Persists order via /folders/reorder.
function FolderList({ folders, all, depth, selectedBoardId, onSelectBoard }: {
  folders: TFolder[]; all: TFolder[]; depth: number;
  selectedBoardId: number | null; onSelectBoard: (id: number) => void;
}) {
  const qc = useQueryClient();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const reorder = useMutation({
    mutationFn: (orderedIds: number[]) => apiPost('/folders/reorder', { orderedIds }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['folders'] }),
  });
  const ids = folders.map((f) => f.id);

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldI = ids.indexOf(Number(String(active.id).slice(2)));
    const newI = ids.indexOf(Number(String(over.id).slice(2)));
    if (oldI < 0 || newI < 0) return;
    reorder.mutate(arrayMove(ids, oldI, newI));
  }

  if (folders.length === 0) return null;
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={ids.map((id) => `f-${id}`)} strategy={verticalListSortingStrategy}>
        {folders.map((f) => (
          <FolderNode key={f.id} folder={f} all={all} depth={depth}
            selectedBoardId={selectedBoardId} onSelectBoard={onSelectBoard} />
        ))}
      </SortableContext>
    </DndContext>
  );
}

function FolderNode({ folder, all, depth, selectedBoardId, onSelectBoard }: {
  folder: TFolder; all: TFolder[]; depth: number;
  selectedBoardId: number | null; onSelectBoard: (id: number) => void;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(depth === 0);
  const children = all.filter((f) => f.parentId === folder.id);
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, transform, transition, isDragging } =
    useSortable({ id: `f-${folder.id}` });
  const style = { transform: CSS.Transform.toString(transform), transition };

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
  const removeImage = useMutation({
    mutationFn: () => apiDelete(`/folders/${folder.id}/image`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['folders'] }),
  });
  const setRate = useMutation({
    mutationFn: (rate: number | null) => apiPatch(`/folders/${folder.id}`, { hourlyRate: rate }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['folders'] }),
  });
  const setPillar = useMutation({
    mutationFn: (pillar: 'delivery' | 'operations') => apiPatch(`/folders/${folder.id}`, { pillar }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['folders'] }),
  });

  // Hidden file input, opened from the folder menu.
  function pickImage() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(`/api/v1/folders/${folder.id}/image`, {
        method: 'POST', body: form, credentials: 'same-origin',
      });
      if (res.ok) qc.invalidateQueries({ queryKey: ['folders'] });
      else alert((await res.json().catch(() => null))?.error ?? 'Upload failed.');
    };
    input.click();
  }

  const hasKids = children.length > 0 || (boards.data?.boards.length ?? 0) > 0;

  return (
    <div ref={setNodeRef} style={style} className={isDragging ? 'opacity-40' : ''}>
      <div className="group flex items-center gap-1 rounded-md px-1.5 py-1.5 hover:bg-slate-800/60"
        style={{ paddingLeft: depth * 12 + 6 }}>
        <Grip setRef={setActivatorNodeRef} attributes={attributes} listeners={listeners} />
        <button onClick={() => setOpen(!open)} className="text-slate-500 hover:text-slate-300">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        {folder.imagePath ? (
          <img src={`/api/v1/folders/${folder.id}/image`} alt=""
            className="h-4 w-4 shrink-0 rounded object-cover" />
        ) : (
          <Folder size={14} style={{ color: folder.color }} />
        )}
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
            { label: folder.imagePath ? 'Change image' : 'Add image', onClick: () => pickImage() },
            ...(depth === 0 ? [{ label: (folder.pillar === 'operations') ? 'Move to Delivery' : 'Move to Operations', onClick: () => setPillar.mutate(folder.pillar === 'operations' ? 'delivery' : 'operations') }] : []),
            ...(depth === 0 ? [{ label: folder.hourlyRate != null ? `Rate: ${folder.hourlyRate}/h (change)` : 'Set billing rate', onClick: () => {
              const cur = folder.hourlyRate != null ? String(folder.hourlyRate) : '';
              const v = window.prompt('Hourly rate for this client (blank to clear)', cur);
              if (v === null) return;
              const t = v.trim();
              setRate.mutate(t === '' ? null : Number(t));
            } }] : []),
            ...(folder.imagePath ? [{ label: 'Remove image', onClick: () => removeImage.mutate() }] : []),
            { label: 'Delete', danger: true, onClick: () => { if (confirm(`Delete "${folder.name}"${hasKids ? ' and everything inside it' : ''}? This cannot be undone.`)) deleteFolder.mutate(); } },
          ]}
        />
      </div>

      {open && (
        <div>
          <BoardList boards={boards.data?.boards ?? []} folderId={folder.id} depth={depth}
            selectedBoardId={selectedBoardId} onSelectBoard={onSelectBoard} />
          <FolderList folders={children} all={all} depth={depth + 1}
            selectedBoardId={selectedBoardId} onSelectBoard={onSelectBoard} />
        </div>
      )}
    </div>
  );
}

// A drag-sortable list of boards within one folder. Persists order via /boards/reorder.
function BoardList({ boards, folderId, depth, selectedBoardId, onSelectBoard }: {
  boards: Board[]; folderId: number; depth: number;
  selectedBoardId: number | null; onSelectBoard: (id: number) => void;
}) {
  const qc = useQueryClient();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const reorder = useMutation({
    mutationFn: (orderedIds: number[]) => apiPost('/boards/reorder', { orderedIds }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['boards', folderId] }),
  });
  const ids = boards.map((b) => b.id);

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldI = ids.indexOf(Number(String(active.id).slice(2)));
    const newI = ids.indexOf(Number(String(over.id).slice(2)));
    if (oldI < 0 || newI < 0) return;
    reorder.mutate(arrayMove(ids, oldI, newI));
  }

  if (boards.length === 0) return null;
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={ids.map((id) => `b-${id}`)} strategy={verticalListSortingStrategy}>
        {boards.map((b) => (
          <BoardRow key={b.id} board={b} folderId={folderId} depth={depth}
            selected={selectedBoardId === b.id} onSelect={() => onSelectBoard(b.id)} />
        ))}
      </SortableContext>
    </DndContext>
  );
}

function BoardRow({ board, folderId, depth, selected, onSelect }: {
  board: Board; folderId: number; depth: number; selected: boolean; onSelect: () => void;
}) {
  const qc = useQueryClient();
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, transform, transition, isDragging } =
    useSortable({ id: `b-${board.id}` });
  const style = { transform: CSS.Transform.toString(transform), transition, paddingLeft: depth * 12 + 30 };
  const invalidate = () => qc.invalidateQueries({ queryKey: ['boards', folderId] });
  const rename = useMutation({ mutationFn: (name: string) => apiPatch(`/boards/${board.id}`, { name }), onSuccess: invalidate });
  const del = useMutation({ mutationFn: () => apiDelete(`/boards/${board.id}`), onSuccess: invalidate });

  return (
    <div ref={setNodeRef} style={style}
      className={`group flex items-center gap-1 rounded-md pr-1 ${isDragging ? 'opacity-40' : ''} ${selected ? 'bg-violet-600/20' : 'hover:bg-slate-800/60'}`}>
      <Grip setRef={setActivatorNodeRef} attributes={attributes} listeners={listeners} />
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
