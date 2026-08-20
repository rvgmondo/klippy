import { useEffect, useMemo, useState } from 'react';
import { confirmDialog, promptDialog } from './ConfirmDialog';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DndContext, DragOverlay, PointerSensor, useSensor, useSensors, closestCorners,
  type DragStartEvent, type DragOverEvent, type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext, useSortable, verticalListSortingStrategy, horizontalListSortingStrategy, arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Plus, Flag, MoreHorizontal, GripVertical, Copy } from 'lucide-react';
import { setUrlParams } from '../lib/urlAction';
import { apiGet, apiPost, apiPatch, apiDelete } from '../lib/api';
import { BoardListView } from './BoardListView';
import { BoardActions } from './BoardActions';
import type { BoardFull, CardLabel, Column, Priority, Task, TeamUser, Folder as FolderT } from '../lib/types';
import { CardDetail } from './CardDetail';
import { ErrorNote } from './ErrorNote';
import { Menu } from './Menu';
import { BoardFilters, EMPTY_FILTERS, applyFilters, type FilterState } from './BoardFilters';

const PRIORITY: Record<Priority, { label: string; color: string } | null> = {
  none: null,
  low: { label: 'Low', color: '#64748b' },
  medium: { label: 'Medium', color: '#eab308' },
  high: { label: 'High', color: '#f97316' },
  urgent: { label: 'Urgent', color: '#ef4444' },
};

const cardKey = (id: number) => `card-${id}`;
const colKey = (id: number) => `col-${id}`;
const idFromKey = (k: string) => Number(k.split('-')[1]);

function initials(name: string): string {
  return name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
}

export function BoardView({ boardId, onNavigate }: { boardId: number | null; onNavigate?: (v: string) => void }) {
  const qc = useQueryClient();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const [openTaskId, setOpenTaskId] = useState<number | null>(null);
  const [showActions, setShowActions] = useState(false);
  // Board or list. Remembered, because it is a preference about how someone
  // thinks, not a per-board decision.
  const [mode, setMode] = useState<'board' | 'list'>(
    () => (localStorage.getItem('klippy.boardMode') === 'list' ? 'list' : 'board'),
  );
  const setModeSticky = (m: 'board' | 'list') => {
    setMode(m);
    try { localStorage.setItem('klippy.boardMode', m); } catch { /* ignore */ }
  };
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [activeId, setActiveId] = useState<string | null>(null);
  // Local container state so cards move smoothly during a drag.
  const [containers, setContainers] = useState<Record<string, number[]>>({});

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['board', boardId],
    queryFn: () => apiGet<BoardFull>(`/boards/${boardId}/full`),
    enabled: boardId !== null,
    retry: false,
  });
  const { data: usersData } = useQuery({ queryKey: ['users'], queryFn: () => apiGet<{ users: TeamUser[] }>('/users') });

  // The client this board belongs to, resolved by walking the folder chain to its
  // root. The client folder IS the billing entity, so its board is where "raise an
  // invoice for them" naturally starts; until now every money task began in a
  // module and re-picked the client from a dropdown.
  const foldersQ = useQuery({ queryKey: ['folders'], queryFn: () => apiGet<{ folders: FolderT[] }>('/folders') });
  const client = useMemo(() => {
    const fid = data?.board.folderId;
    const all = foldersQ.data?.folders ?? [];
    if (!fid || !all.length) return null;
    let cur = all.find((f) => f.id === fid);
    for (let i = 0; i < 50 && cur?.parentId != null; i++) cur = all.find((f) => f.id === cur!.parentId);
    if (!cur || cur.pillar === 'operations') return null;   // internal areas are not billed
    return cur;
  }, [data?.board.folderId, foldersQ.data]);
  const launch = (view: string, params: Record<string, string>) => {
    setUrlParams(params);
    onNavigate?.(view);
  };
  const userMap = useMemo(() => new Map((usersData?.users ?? []).map((u) => [u.id, u])), [usersData]);
  const labelsByTask = useMemo(() => {
    const m = new Map<number, CardLabel[]>();
    for (const l of data?.cardLabels ?? []) { const a = m.get(l.taskId) ?? []; a.push(l); m.set(l.taskId, a); }
    return m;
  }, [data]);
  const taskMap = useMemo(() => new Map((data?.tasks ?? []).map((t) => [t.id, t])), [data]);

  // Sync local containers from server data when not mid-drag.
  useEffect(() => {
    if (!data || activeId) return;
    const next: Record<string, number[]> = {};
    for (const c of data.columns) next[colKey(c.id)] = [];
    for (const t of [...data.tasks].sort((a, b) => a.position - b.position)) {
      const k = colKey(t.columnId);
      (next[k] ??= []).push(t.id);
    }
    setContainers(next);
  }, [data, activeId]);

  const move = useMutation({
    mutationFn: (v: { id: number; columnId: number; position: number }) =>
      apiPost(`/tasks/${v.id}/move`, { columnId: v.columnId, position: v.position }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['board', boardId] }),
  });

  const reorderCols = useMutation({
    mutationFn: (orderedIds: number[]) => apiPost('/columns/reorder', { orderedIds }),
    onMutate: async (orderedIds) => {
      await qc.cancelQueries({ queryKey: ['board', boardId] });
      const prev = qc.getQueryData<BoardFull>(['board', boardId]);
      if (prev) {
        const byId = new Map(prev.columns.map((c) => [c.id, c]));
        const columns = orderedIds.map((id, i) => ({ ...byId.get(id)!, position: i }));
        qc.setQueryData<BoardFull>(['board', boardId], { ...prev, columns });
      }
      return { prev };
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(['board', boardId], ctx.prev); },
    onSettled: () => qc.invalidateQueries({ queryKey: ['board', boardId] }),
  });

  if (boardId === null) {
    return (
      <div className="grid h-full place-items-center text-slate-500">
        <p className="text-sm">Pick a board from the left, or create one with the + next to a folder.</p>
      </div>
    );
  }
  if (error) return <div className="p-6"><ErrorNote error={error} onRetry={() => refetch()} /></div>;
  if (isLoading || !data) return <div className="p-6 text-sm text-slate-500">Loading board...</div>;

  const findContainer = (key: string): string | undefined => {
    if (key in containers) return key;
    return Object.keys(containers).find((c) => containers[c]!.includes(idFromKey(key)));
  };

  function onDragOver(e: DragOverEvent) {
    const activeKey = String(e.active.id);
    const overKey = e.over ? String(e.over.id) : null;
    if (!overKey) return;
    if (activeKey.startsWith('col-')) return; // columns reorder on drop only
    const from = findContainer(activeKey);
    const to = findContainer(overKey);
    if (!from || !to || from === to) return;
    setContainers((prev) => {
      const activeItems = prev[from]!;
      const overItems = prev[to]!;
      const activeIdNum = idFromKey(activeKey);
      const overIndex = overKey.startsWith('col-') ? overItems.length : overItems.indexOf(idFromKey(overKey));
      const next = { ...prev };
      next[from] = activeItems.filter((i) => i !== activeIdNum);
      next[to] = [...overItems.slice(0, overIndex < 0 ? overItems.length : overIndex), activeIdNum, ...overItems.slice(overIndex < 0 ? overItems.length : overIndex)];
      return next;
    });
  }

  function onDragEnd(e: DragEndEvent) {
    const activeKey = String(e.active.id);
    const overKey = e.over ? String(e.over.id) : null;
    setActiveId(null);
    if (!overKey) return;

    // Reordering a whole column.
    if (activeKey.startsWith('col-')) {
      const overCol = overKey.startsWith('col-') ? overKey : findContainer(overKey);
      if (!overCol || overCol === activeKey || !data) return;
      const ids = data.columns.map((c) => c.id);
      const oldIndex = ids.indexOf(idFromKey(activeKey));
      const newIndex = ids.indexOf(idFromKey(overCol));
      if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return;
      reorderCols.mutate(arrayMove(ids, oldIndex, newIndex));
      return;
    }

    const from = findContainer(activeKey);
    const to = findContainer(overKey);
    if (!from || !to) return;
    const activeIdNum = idFromKey(activeKey);

    let finalContainers = containers;
    if (from === to) {
      const items = containers[to]!;
      const oldIndex = items.indexOf(activeIdNum);
      const newIndex = overKey.startsWith('col-') ? items.length - 1 : items.indexOf(idFromKey(overKey));
      if (oldIndex !== newIndex && newIndex >= 0) {
        finalContainers = { ...containers, [to]: arrayMove(items, oldIndex, newIndex) };
        setContainers(finalContainers);
      }
    }
    const columnId = idFromKey(to);
    const position = finalContainers[to]!.indexOf(activeIdNum);
    move.mutate({ id: activeIdNum, columnId, position });
  }

  const activeTask = activeId && !activeId.startsWith('col-') ? taskMap.get(idFromKey(activeId)) : null;
  const activeCol = activeId?.startsWith('col-') ? data.columns.find((c) => colKey(c.id) === activeId) ?? null : null;

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-800 px-6 py-3">
        <h2 className="font-display text-lg font-semibold text-slate-100">{data.board.name}</h2>
        {data.board.description && <p className="text-sm text-slate-400">{data.board.description}</p>}
        {client && onNavigate && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-xs text-slate-500">{client.name}:</span>
            <button onClick={() => launch('billing', { new: 'invoice', folder: String(client.id) })}
              className="rounded-lg border border-slate-700 px-2.5 py-1 text-xs text-slate-300 hover:border-[var(--accent)] hover:text-[var(--accent)]">
              Raise invoice
            </button>
            <button onClick={() => launch('billing', { new: 'quote', folder: String(client.id) })}
              className="rounded-lg border border-slate-700 px-2.5 py-1 text-xs text-slate-300 hover:border-[var(--accent)] hover:text-[var(--accent)]">
              New quote
            </button>
            <button onClick={() => launch('offerings', { sub: String(client.id) })}
              className="rounded-lg border border-slate-700 px-2.5 py-1 text-xs text-slate-300 hover:border-[var(--accent)] hover:text-[var(--accent)]">
              Start subscription
            </button>
          </div>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <BoardFilters value={filters} onChange={setFilters} />
          <button onClick={() => setShowActions(true)} title="Copy this board, or start one from a template"
            className="ml-auto flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-slate-800">
            <Copy size={13} /> Copy / template
          </button>
          <div className="flex shrink-0 gap-1 rounded-lg bg-slate-900 p-1">
            {(['board', 'list'] as const).map((m) => (
              <button key={m} onClick={() => setModeSticky(m)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium capitalize ${
                  mode === m ? 'bg-slate-700 text-slate-100' : 'text-slate-400 hover:text-slate-200'}`}>
                {m}
              </button>
            ))}
          </div>
        </div>
      </div>
      {mode === 'list' ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <BoardListView boardId={boardId} columns={data.columns}
            tasks={applyFilters(data.tasks, filters)}
            labelsByTask={labelsByTask} userMap={userMap} onOpen={setOpenTaskId} />
        </div>
      ) : (
      <DndContext sensors={sensors} collisionDetection={closestCorners}
        onDragStart={(e: DragStartEvent) => setActiveId(String(e.active.id))}
        onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={() => setActiveId(null)}>
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-4">
          <SortableContext items={data.columns.map((c) => colKey(c.id))} strategy={horizontalListSortingStrategy}>
            {data.columns.map((col) => (
              <ColumnLane key={col.id} column={col} boardId={boardId}
                taskIds={(containers[colKey(col.id)] ?? []).filter((tid) => { const t = taskMap.get(tid); return t ? applyFilters([t], filters).length > 0 : false; })}
                taskMap={taskMap} labelsByTask={labelsByTask} userMap={userMap} onOpen={setOpenTaskId} />
            ))}
          </SortableContext>
          <AddColumn boardId={boardId} />
        </div>
        <DragOverlay>
          {activeTask ? <CardInner task={activeTask} labels={labelsByTask.get(activeTask.id) ?? []} userMap={userMap} dragging /> : null}
          {activeCol ? (
            <div className="w-72 rounded-xl border border-violet-500/60 bg-slate-900 px-3 py-2.5 shadow-xl">
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: activeCol.color }} />
                <span className="text-sm font-medium text-slate-200">{activeCol.name}</span>
              </div>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
      )}

      {showActions && (
        <BoardActions boardId={boardId} boardName={data.board.name}
          onClose={() => setShowActions(false)}
          onCreated={() => { setShowActions(false); qc.invalidateQueries({ queryKey: ['folders'] }); }} />
      )}

      {openTaskId !== null && <CardDetail taskId={openTaskId} boardId={boardId} onClose={() => setOpenTaskId(null)} />}
    </div>
  );
}

function ColumnLane({ column, boardId, taskIds, taskMap, labelsByTask, userMap, onOpen }: {
  column: Column; boardId: number; taskIds: number[];
  taskMap: Map<number, Task>; labelsByTask: Map<number, CardLabel[]>; userMap: Map<number, TeamUser>;
  onOpen: (id: number) => void;
}) {
  const qc = useQueryClient();
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, transform, transition, isOver, isDragging } =
    useSortable({ id: colKey(column.id) });
  const style = { transform: CSS.Transform.toString(transform), transition };
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const invalidateBoard = () => qc.invalidateQueries({ queryKey: ['board', boardId] });
  const createTask = useMutation({
    mutationFn: (t: string) => apiPost('/tasks', { boardId, columnId: column.id, title: t }),
    onSuccess: () => { invalidateBoard(); setTitle(''); setAdding(false); },
  });
  const renameCol = useMutation({ mutationFn: (name: string) => apiPatch(`/columns/${column.id}`, { name }), onSuccess: invalidateBoard });
  const deleteCol = useMutation({ mutationFn: () => apiDelete(`/columns/${column.id}`), onSuccess: invalidateBoard });

  return (
    <div ref={setNodeRef} style={style}
      className={`group/col flex max-h-full w-72 shrink-0 flex-col rounded-xl border bg-slate-900/40 ${isDragging ? 'opacity-40' : ''} ${isOver ? 'border-violet-500/60 bg-violet-500/5' : 'border-slate-800'}`}>
      <div className="flex items-center gap-2 px-3 py-2.5">
        <span ref={setActivatorNodeRef} {...attributes} {...listeners}
          className="-ml-1 cursor-grab text-slate-500 hover:text-slate-300 active:cursor-grabbing" title="Drag to reorder">
          <GripVertical size={14} />
        </span>
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: column.color }} />
        <span className="text-sm font-medium text-slate-200">{column.name}</span>
        <span className="ml-auto text-xs text-slate-500">{taskIds.length}</span>
        <Menu align="right"
          trigger={<span className="text-slate-500 opacity-0 hover:text-slate-200 group-hover/col:opacity-100"><MoreHorizontal size={15} /></span>}
          items={[
            { label: 'Rename column', onClick: async () => { const n = await promptDialog('Rename column', column.name); if (n?.trim()) renameCol.mutate(n.trim()); } },
            { label: 'Delete column', danger: true, onClick: async () => { if (await confirmDialog(`Delete "${column.name}"${taskIds.length ? ` and its ${taskIds.length} card(s)` : ''}?`)) deleteCol.mutate(); } },
          ]} />
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
        <SortableContext items={taskIds.map(cardKey)} strategy={verticalListSortingStrategy}>
          {taskIds.map((id) => {
            const t = taskMap.get(id);
            return t ? <SortableCard key={id} task={t} labels={labelsByTask.get(id) ?? []} userMap={userMap} onOpen={onOpen} /> : null;
          })}
        </SortableContext>

        {adding ? (
          <div className="rounded-lg border border-slate-700 bg-slate-900 p-2">
            <textarea autoFocus value={title} onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (title.trim()) createTask.mutate(title.trim()); } if (e.key === 'Escape') setAdding(false); }}
              placeholder="Card title..." rows={2}
              className="w-full resize-none bg-transparent text-sm text-slate-100 placeholder-slate-500 outline-none" />
            <div className="mt-1 flex gap-2">
              <button onClick={() => title.trim() && createTask.mutate(title.trim())} className="rounded bg-violet-600 px-2 py-1 text-xs text-[var(--accent-ink)] hover:bg-violet-500">Add</button>
              <button onClick={() => setAdding(false)} className="px-2 py-1 text-xs text-slate-400 hover:text-slate-200">Cancel</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setAdding(true)} className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-xs text-slate-500 hover:bg-slate-800/60 hover:text-slate-300">
            <Plus size={14} /> Add card
          </button>
        )}
      </div>
    </div>
  );
}

function SortableCard({ task, labels, userMap, onOpen }: { task: Task; labels: CardLabel[]; userMap: Map<number, TeamUser>; onOpen: (id: number) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: cardKey(task.id) });
  const style = { transform: CSS.Transform.toString(transform), transition };
  return (
    <div ref={setNodeRef} style={style} {...listeners} {...attributes}
      onClick={() => { if (!isDragging) onOpen(task.id); }}
      className={isDragging ? 'opacity-40' : ''}>
      <CardInner task={task} labels={labels} userMap={userMap} />
    </div>
  );
}

function CardInner({ task, labels, userMap, dragging }: { task: Task; labels: CardLabel[]; userMap: Map<number, TeamUser>; dragging?: boolean }) {
  const p = PRIORITY[task.priority];
  const assignee = task.assignedTo ? userMap.get(task.assignedTo) : null;
  return (
    <div className={`cursor-grab rounded-lg border border-slate-700/70 bg-slate-800/80 p-2.5 shadow-sm active:cursor-grabbing ${dragging ? 'rotate-2 shadow-xl' : ''} ${task.isCompleted ? 'opacity-60' : ''}`}>
      {labels.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {labels.map((l) => (
            <span key={l.id} className="rounded px-1.5 py-0.5 text-[10px] font-medium" style={{ background: `${l.color}22`, color: l.color }}>{l.name}</span>
          ))}
        </div>
      )}
      <p className={`text-sm text-slate-100 ${task.isCompleted ? 'line-through' : ''}`}>{task.title}</p>
      {(p || task.dueDate || assignee) && (
        <div className="mt-2 flex items-center gap-2 text-[11px]">
          {p && (
            <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5" style={{ background: `${p.color}22`, color: p.color }}>
              <Flag size={10} /> {p.label}
            </span>
          )}
          {task.dueDate && <span className="text-slate-400">{task.dueDate}</span>}
          {assignee && (
            <span className="ml-auto grid h-5 w-5 place-items-center rounded-full bg-violet-600/30 text-[9px] font-semibold text-violet-200" title={assignee.name}>
              {initials(assignee.name)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function AddColumn({ boardId }: { boardId: number }) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: (n: string) => apiPost('/columns', { boardId, name: n }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['board', boardId] }); setName(''); setAdding(false); },
  });
  if (!adding) {
    return (
      <button onClick={() => setAdding(true)} className="flex h-11 w-72 shrink-0 items-center gap-1.5 rounded-xl border border-dashed border-slate-700 px-3 text-sm text-slate-500 hover:border-slate-500 hover:text-slate-300">
        <Plus size={15} /> Add column
      </button>
    );
  }
  return (
    <div className="w-72 shrink-0 rounded-xl border border-slate-700 bg-slate-900 p-2">
      <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) create.mutate(name.trim()); if (e.key === 'Escape') setAdding(false); }}
        placeholder="Column name" className="w-full bg-transparent text-sm text-slate-100 placeholder-slate-500 outline-none" />
      <div className="mt-1 flex gap-2">
        <button onClick={() => name.trim() && create.mutate(name.trim())} className="rounded bg-violet-600 px-2 py-1 text-xs text-[var(--accent-ink)] hover:bg-violet-500">Add</button>
        <button onClick={() => setAdding(false)} className="px-2 py-1 text-xs text-slate-400 hover:text-slate-200">Cancel</button>
      </div>
    </div>
  );
}
