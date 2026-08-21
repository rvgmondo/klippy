/**
 * The client tree in the sidebar: folders, the boards inside them, and the drag
 * handles that reorder both.
 *
 * Lifted out of Sidebar.tsx, which held twelve components in 557 lines. These are
 * one concern and get edited together; the navigation above them almost never
 * changes at the same time, and a patch aimed at one kept landing in the other.
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DndContext, closestCenter, PointerSensor, TouchSensor, useSensor, useSensors,
  type DragEndEvent, type DraggableAttributes, type DraggableSyntheticListeners,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  ChevronRight, ChevronDown, Folder, Plus, SquareKanban, MoreHorizontal, GripVertical,
} from 'lucide-react';
import { apiGet, apiPost, apiPatch, apiDelete } from '../lib/api';
import { confirmDialog, promptDialog, notify } from './ConfirmDialog';
import { Menu } from './Menu';
import { PortalAccessModal } from './PortalAccessModal';
import type { Board, Folder as TFolder } from '../lib/types';

// A drag-sortable list of sibling folders. Persists order via /folders/reorder.
export function FolderList({ folders, all, depth, selectedBoardId, onSelectBoard }: {
  folders: TFolder[]; all: TFolder[]; depth: number;
  selectedBoardId: number | null; onSelectBoard: (id: number) => void;
}) {
  const qc = useQueryClient();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    // Touch: press-and-hold begins a drag; a quick swipe scrolls the page.
    // Without this, a finger could not scroll a board at all.
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  );
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

export function FolderNode({ folder, all, depth, selectedBoardId, onSelectBoard }: {
  folder: TFolder; all: TFolder[]; depth: number;
  selectedBoardId: number | null; onSelectBoard: (id: number) => void;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(depth === 0);
  const [portalFor, setPortalFor] = useState<{ id: number; name: string } | null>(null);
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
  const setBillingEmail = useMutation({
    mutationFn: (email: string) => apiPatch(`/folders/${folder.id}`, { billingEmail: email }),
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
      else notify((await res.json().catch(() => null))?.error ?? 'Upload failed.', 'error');
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
          onClick={async () => { const n = await ask('Board name', ''); if (n) createBoard.mutate(n); }}
          className="hidden text-slate-500 hover:text-slate-200 group-hover:block max-lg:block">
          <Plus size={14} />
        </button>
        <Menu
          trigger={<span className="hidden text-slate-500 hover:text-slate-200 group-hover:block max-lg:block"><MoreHorizontal size={14} /></span>}
          items={[
            { label: 'Add board', onClick: async () => { const n = await ask('Board name', ''); if (n) createBoard.mutate(n); } },
            { label: 'Add subfolder', onClick: async () => { const n = await ask('Subfolder name', ''); if (n) createFolder.mutate(n); } },
            { label: 'Rename', onClick: async () => { const n = await ask('Rename folder', folder.name); if (n) renameFolder.mutate(n); } },
            { label: folder.imagePath ? 'Change image' : 'Add image', onClick: () => pickImage() },
            ...(depth === 0 ? [{ label: (folder.pillar === 'operations') ? 'Move to Delivery' : 'Move to Operations', onClick: () => setPillar.mutate(folder.pillar === 'operations' ? 'delivery' : 'operations') }] : []),
            ...(depth === 0 ? [{ label: folder.hourlyRate != null ? `Rate: ${folder.hourlyRate}/h (change)` : 'Set billing rate', onClick: async () => {
              const cur = folder.hourlyRate != null ? String(folder.hourlyRate) : '';
              const v = await promptDialog('Hourly rate for this client (blank to clear)', cur);
              if (v === null) return;
              const t = v.trim();
              setRate.mutate(t === '' ? null : Number(t));
            } }] : []),
            // Without a billing email a recurring invoice can only ever be a draft
            // someone has to send by hand, and nothing can be chased automatically.
            ...(depth === 0 ? [{ label: folder.billingEmail ? `Billing email: ${folder.billingEmail}` : 'Set billing email', onClick: async () => {
              const v = await promptDialog('Where should invoices and payment reminders go? (blank to clear)', folder.billingEmail ?? '');
              if (v === null) return;
              setBillingEmail.mutate(v.trim());
            } }] : []),
            // Only top-level folders are clients, and only a client has a portal.
            ...(depth === 0 ? [{ label: 'Portal access', onClick: () => setPortalFor({ id: folder.id, name: folder.name }) }] : []),
            ...(folder.imagePath ? [{ label: 'Remove image', onClick: () => removeImage.mutate() }] : []),
            { label: 'Delete', danger: true, onClick: async () => { if (await confirmDialog(`Move "${folder.name}"${hasKids ? ' and everything inside it' : ''} to the Trash? It can be restored from Settings for 30 days.`, { danger: true })) deleteFolder.mutate(); } },
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

      {portalFor && (
        <PortalAccessModal folderId={portalFor.id} folderName={portalFor.name}
          onClose={() => setPortalFor(null)} />
      )}
    </div>
  );
}

// A drag-sortable list of boards within one folder. Persists order via /boards/reorder.

export function BoardList({ boards, folderId, depth, selectedBoardId, onSelectBoard }: {
  boards: Board[]; folderId: number; depth: number;
  selectedBoardId: number | null; onSelectBoard: (id: number) => void;
}) {
  const qc = useQueryClient();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    // Touch: press-and-hold begins a drag; a quick swipe scrolls the page.
    // Without this, a finger could not scroll a board at all.
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  );
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

export function BoardRow({ board, folderId, depth, selected, onSelect }: {
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
        trigger={<span className="hidden text-slate-500 hover:text-slate-200 group-hover:block max-lg:block"><MoreHorizontal size={13} /></span>}
        items={[
          { label: 'Rename', onClick: async () => { const n = await ask('Rename board', board.name); if (n) rename.mutate(n); } },
          { label: 'Delete', danger: true, onClick: async () => { if (await confirmDialog(`Move board "${board.name}" and its cards to the Trash? It can be restored from Settings for 30 days.`, { danger: true })) del.mutate(); } },
        ]}
      />
    </div>
  );
}

// Drag handle shared by folder rows and board rows; only shows on row hover.
export function Grip({ setRef, attributes, listeners }: {
  setRef: (el: HTMLElement | null) => void;
  attributes: DraggableAttributes; listeners: DraggableSyntheticListeners;
}) {
  return (
    <span ref={setRef} {...attributes} {...listeners}
      title="Drag to reorder"
      className="shrink-0 cursor-grab text-slate-500 opacity-0 hover:text-slate-300 active:cursor-grabbing group-hover:opacity-100 max-lg:opacity-100">
      <GripVertical size={13} />
    </span>
  );
}

/** Ask for a value, trimmed, or null if they cancelled or left it blank. */
export async function ask(prompt: string, current: string): Promise<string | null> {
  const v = await promptDialog(prompt, current);
  return v && v.trim() ? v.trim() : null;
}
