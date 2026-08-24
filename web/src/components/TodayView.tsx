import { useState } from 'react';
import { promptDialog } from './ConfirmDialog';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DndContext, useDraggable, useDroppable, PointerSensor, TouchSensor, useSensor, useSensors,
  rectIntersection, type DragEndEvent, type CollisionDetection,
} from '@dnd-kit/core';
import { ChevronLeft, ChevronRight, X, Clock, AlertTriangle, CalendarPlus, Play, Square, Plus } from 'lucide-react';
import { apiGet, apiPatch, apiPost } from '../lib/api';
import type { Priority, Folder as TFolder } from '../lib/types';
import type { BusinessSelection } from './BusinessSwitcher';
import { CardDetail } from './CardDetail';
import { ErrorNote } from './ErrorNote';
import { CanvasPage, PageHeader } from './PageHeader';

interface DayTask {
  id: number; title: string; priority: Priority; dueDate: string | null;
  boardId: number; columnId: number; isCompleted: boolean;
  estimateMinutes: number | null; scheduledStart: string | null;
  boardName: string | null; folderName: string | null;
}
interface DayData {
  date: string;
  scheduled: DayTask[];
  backlog: DayTask[];
  capacity: {
    workingMinutes: number; plannedMinutes: number; remainingMinutes: number;
    overcommitted: boolean; unestimated: number;
  };
}

const PRIORITY_COLOR: Record<Priority, string> = {
  none: '#6b7280', low: '#64748b', medium: '#eab308', high: '#f97316', urgent: '#ef4444',
};

// The visible working window. Blocks outside it still show, clamped to the edges.
const DAY_START_HOUR = 6;
const DAY_END_HOUR = 22;
const PX_PER_HOUR = 56;
const DEFAULT_ESTIMATE = 30;

/**
 * Pick the drop target from the cursor, not from rectangle area.
 *
 * The default (rectIntersection) compares overlap area, so the tall "Unscheduled"
 * panel always beat the thin one-hour rows and every drop bounced back to the
 * backlog. pointerWithin alone is the usual fix but returns nothing when a drag
 * ends without fresh pointer coordinates, which silently drops the change.
 *
 * So: take the cursor if we have it, otherwise the centre of the dragged card, and
 * hit-test the droppable rects ourselves. An hour row wins over the panel when both
 * contain the point, because the rows sit inside the timeline and are what the user
 * is aiming at.
 */
const collisionDetection: CollisionDetection = (args) => {
  const { droppableRects, droppableContainers, pointerCoordinates, collisionRect } = args;
  const point = pointerCoordinates ?? {
    x: collisionRect.left + collisionRect.width / 2,
    y: collisionRect.top + collisionRect.height / 2,
  };
  const hits = droppableContainers.filter((c) => {
    const r = droppableRects.get(c.id);
    return !!r && point.x >= r.left && point.x <= r.left + r.width
      && point.y >= r.top && point.y <= r.top + r.height;
  });
  if (hits.length) {
    const slot = hits.find((c) => String(c.id).startsWith('slot-')) ?? hits[0]!;
    return [{ id: slot.id }];
  }
  return rectIntersection(args);
};

const todayStr = () => localDate(new Date());
function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function shiftDate(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number) as [number, number, number];
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return localDate(dt);
}
function fmtDuration(mins: number): string {
  const sign = mins < 0 ? '-' : '';
  const a = Math.abs(mins);
  const h = Math.floor(a / 60), m = a % 60;
  return h > 0 ? `${sign}${h}h${m ? ` ${m}m` : ''}` : `${sign}${m}m`;
}
function fmtClock(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
/** Minutes from the top of the working window, for positioning a block. */
function offsetMinutes(iso: string): number {
  const d = new Date(iso);
  return (d.getHours() - DAY_START_HOUR) * 60 + d.getMinutes();
}
/** Build an ISO timestamp for a given local date + hour. */
function isoAt(dateStr: string, hour: number, minute = 0): string {
  const [y, m, d] = dateStr.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d, hour, minute, 0, 0).toISOString();
}

export function TodayView({ businessId, onNavigate }: {
  businessId: BusinessSelection;
  onNavigate?: (v: string) => void;
}) {
  const qc = useQueryClient();
  const [date, setDate] = useState(todayStr());
  const [openTask, setOpenTask] = useState<{ id: number; boardId: number } | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    // Touch: press-and-hold begins a drag; a quick swipe scrolls the page.
    // Without this, a finger could not scroll a board at all.
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  );

  // How long your working day is. A capacity bar measured against someone else's
  // 8 hours is worse than none, so this is yours and it sticks.
  const [workingHours, setWorkingHours] = useState(() => {
    const saved = Number(localStorage.getItem('klippy.workingHours'));
    return saved >= 1 && saved <= 24 ? saved : 8;
  });
  const setHours = (h: number) => {
    const clamped = Math.min(24, Math.max(1, h));
    setWorkingHours(clamped);
    localStorage.setItem('klippy.workingHours', String(clamped));
  };

  const bizQ = businessId === 'all' ? '' : `&businessId=${businessId}`;
  const key = ['day', date, businessId, workingHours] as const;
  const { data, error, refetch } = useQuery({
    queryKey: key,
    queryFn: () => apiGet<DayData>(`/tasks/day?date=${date}${bizQ}&workingMinutes=${workingHours * 60}`),
    retry: false,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['day'] });
    qc.invalidateQueries({ queryKey: ['board'] });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
  };
  const patch = useMutation({
    mutationFn: (v: { id: number; body: Record<string, unknown> }) => apiPatch(`/tasks/${v.id}`, v.body),
    onSuccess: invalidate,
  });

  // The running timer, so a block can show whether it is the one being worked on.
  // This is what turns the plan into the doing: block it out, then hit play.
  const timer = useQuery({
    queryKey: ['timer'],
    queryFn: () => apiGet<{ current: { id: number; taskId: number } | null }>('/timer/current'),
    refetchInterval: 30000,
  });
  const runningTaskId = timer.data?.current?.taskId ?? null;
  const toggleTimer = useMutation({
    mutationFn: (taskId: number) => (runningTaskId === taskId
      ? apiPost('/timer/stop', {})
      : apiPost('/timer/start', { taskId })),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['timer'] });
      qc.invalidateQueries({ queryKey: ['day'] });
    },
  });

  function onDragEnd(e: DragEndEvent) {
    const taskId = Number(String(e.active.id).replace('t-', ''));
    const over = e.over?.id ? String(e.over.id) : null;
    if (!over) return;
    if (over === 'backlog') {
      patch.mutate({ id: taskId, body: { scheduledStart: null } });
      return;
    }
    if (over.startsWith('slot-')) {
      const hour = Number(over.replace('slot-', ''));
      const task = [...(data?.scheduled ?? []), ...(data?.backlog ?? [])].find((t) => t.id === taskId);
      patch.mutate({
        id: taskId,
        body: {
          scheduledStart: isoAt(date, hour),
          // Give it a default length so it occupies real space on the timeline
          // and counts toward capacity straight away.
          ...(task?.estimateMinutes == null ? { estimateMinutes: DEFAULT_ESTIMATE } : {}),
        },
      });
    }
  }

  const cap = data?.capacity;
  const pct = cap && cap.workingMinutes > 0
    ? Math.min(100, Math.round((cap.plannedMinutes / cap.workingMinutes) * 100)) : 0;
  const isToday = date === todayStr();
  const hours = Array.from({ length: DAY_END_HOUR - DAY_START_HOUR }, (_, i) => DAY_START_HOUR + i);

  return (
    <CanvasPage>
      <PageHeader view="today"
        title={isToday ? 'Today' : new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long' })}
        subtitle={new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}
        actions={(
          <div className="flex items-center gap-1">
            <button onClick={() => setDate(shiftDate(date, -1))} title="Previous day"
              className="grid h-10 w-10 place-items-center rounded-lg border border-slate-700 text-slate-400 hover:bg-slate-800 hover:text-slate-200 sm:h-9 sm:w-9">
              <ChevronLeft size={16} />
            </button>
            <button onClick={() => setDate(todayStr())}
              className="grid min-h-10 place-items-center rounded-lg border border-slate-700 px-3 text-xs text-slate-300 hover:bg-slate-800 sm:min-h-9">
              Today
            </button>
            <button onClick={() => setDate(shiftDate(date, 1))} title="Next day"
              className="grid h-10 w-10 place-items-center rounded-lg border border-slate-700 text-slate-400 hover:bg-slate-800 hover:text-slate-200 sm:h-9 sm:w-9">
              <ChevronRight size={16} />
            </button>
          </div>
        )}>

        {/* Capacity: the point of the whole screen. */}
        <div className="w-full sm:w-72">
            <div className="mb-1 flex items-baseline justify-between text-xs">
              <span className="text-slate-500">Planned</span>
              <span className={`num font-semibold ${cap?.overcommitted ? 'text-red-400' : 'text-violet-300'}`}>
                {fmtDuration(cap?.plannedMinutes ?? 0)} /{' '}
                <button onClick={async () => {
                  const v = await promptDialog('How many hours is your working day?', String(workingHours));
                  if (v && Number(v) > 0) setHours(Number(v));
                }}
                  title="Change the length of your working day"
                  className="underline decoration-dotted underline-offset-2 hover:opacity-80">
                  {fmtDuration(cap?.workingMinutes ?? workingHours * 60)}
                </button>
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-slate-800">
              <div className={`h-full rounded-full transition-all ${cap?.overcommitted ? 'bg-red-500' : 'bg-[var(--accent)]'}`}
                style={{ width: `${pct}%` }} />
            </div>
            <div className="mt-1 flex items-center gap-2 text-[11px]">
              {cap?.overcommitted ? (
                <span className="flex items-center gap-1 text-red-400">
                  <AlertTriangle size={11} /> Over by {fmtDuration(Math.abs(cap.remainingMinutes))}
                </span>
              ) : (
                <span className="text-slate-500">{fmtDuration(cap?.remainingMinutes ?? 0)} left</span>
              )}
              {!!cap?.unestimated && (
                <span className="text-amber-400/90">{cap.unestimated} without an estimate</span>
              )}
            </div>
        </div>
      </PageHeader>

      {error && (
        <div className="px-4 pt-4 sm:px-6">
          <ErrorNote error={error} onRetry={() => refetch()} compact />
        </div>
      )}

      <DndContext sensors={sensors} collisionDetection={collisionDetection} onDragEnd={onDragEnd}>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 lg:flex-row lg:overflow-hidden lg:p-6">
          {/* Timeline */}
          <div className="min-h-0 flex-1 lg:overflow-y-auto">
            <div className="relative rounded-2xl border border-slate-800 bg-slate-900 p-3">
              <div className="relative" style={{ height: hours.length * PX_PER_HOUR }}>
                {hours.map((h, i) => (
                  <HourSlot key={h} hour={h} top={i * PX_PER_HOUR} />
                ))}
                {/* Now line */}
                {isToday && <NowLine />}
                {/* Blocks */}
                {(data?.scheduled ?? []).map((t) => (
                  <Block key={t.id} task={t} running={runningTaskId === t.id}
                    onToggleTimer={() => toggleTimer.mutate(t.id)}
                    onOpen={() => setOpenTask({ id: t.id, boardId: t.boardId })}
                    onUnschedule={() => patch.mutate({ id: t.id, body: { scheduledStart: null } })}
                    onEstimate={(m) => patch.mutate({ id: t.id, body: { estimateMinutes: m } })} />
                ))}
              </div>
            </div>
          </div>

          {/* Backlog */}
          <BacklogPanel tasks={data?.backlog ?? []} businessId={businessId}
            onOpen={(t) => setOpenTask({ id: t.id, boardId: t.boardId })}
            onEstimate={(id, m) => patch.mutate({ id, body: { estimateMinutes: m } })}
            onSchedule={(id, hour) => {
              const t = (data?.backlog ?? []).find((x) => x.id === id);
              patch.mutate({
                id,
                body: {
                  scheduledStart: isoAt(date, hour),
                  ...(t?.estimateMinutes == null ? { estimateMinutes: DEFAULT_ESTIMATE } : {}),
                },
              });
            }}
            onNavigate={onNavigate} />
        </div>
      </DndContext>

      {openTask && <CardDetail taskId={openTask.id} boardId={openTask.boardId} onClose={() => setOpenTask(null)} />}
    </CanvasPage>
  );
}

function HourSlot({ hour, top }: { hour: number; top: number }) {
  const { setNodeRef, isOver } = useDroppable({ id: `slot-${hour}` });
  return (
    <div ref={setNodeRef}
      className={`absolute inset-x-0 border-t border-slate-800/70 ${isOver ? 'bg-[var(--accent-quiet)]' : ''}`}
      style={{ top, height: PX_PER_HOUR }}>
      <span className="num absolute -top-2 left-0 w-12 text-right text-[11px] text-slate-500">
        {String(hour).padStart(2, '0')}:00
      </span>
    </div>
  );
}

function NowLine() {
  const now = new Date();
  const mins = (now.getHours() - DAY_START_HOUR) * 60 + now.getMinutes();
  if (mins < 0 || mins > (DAY_END_HOUR - DAY_START_HOUR) * 60) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 z-10 ml-14 border-t-2 border-red-500/80"
      style={{ top: (mins / 60) * PX_PER_HOUR }}>
      <span className="absolute -top-1.5 -left-1.5 h-3 w-3 rounded-full bg-red-500" />
    </div>
  );
}

function Block({ task, running, onToggleTimer, onOpen, onUnschedule, onEstimate }: {
  task: DayTask; running: boolean; onToggleTimer: () => void;
  onOpen: () => void; onUnschedule: () => void; onEstimate: (m: number) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: `t-${task.id}` });
  // While the bottom edge is being dragged, show the length the pointer implies
  // rather than the saved one, so the block grows under the cursor.
  const [draftMins, setDraftMins] = useState<number | null>(null);
  const mins = draftMins ?? task.estimateMinutes ?? DEFAULT_ESTIMATE;
  const top = Math.max(0, (offsetMinutes(task.scheduledStart!) / 60) * PX_PER_HOUR);
  const height = Math.max(26, (mins / 60) * PX_PER_HOUR - 4);
  const style: React.CSSProperties = {
    top, height, transform: transform ? `translate(${transform.x}px, ${transform.y}px)` : undefined,
  };

  /** Drag the bottom edge to change how long the task is expected to take. */
  function startResize(e: React.PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const startMins = task.estimateMinutes ?? DEFAULT_ESTIMATE;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      const deltaMins = ((ev.clientY - startY) / PX_PER_HOUR) * 60;
      // Snap to a quarter hour: fine enough to be useful, coarse enough to land on.
      const next = Math.max(15, Math.round((startMins + deltaMins) / 15) * 15);
      setDraftMins(Math.min(next, 60 * 12));
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      setDraftMins((v) => {
        if (v != null && v !== startMins) onEstimate(v);
        return null;
      });
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }
  return (
    <div ref={setNodeRef} style={style}
      className={`group absolute left-14 right-1 z-20 overflow-hidden rounded-lg border px-2.5 py-1.5 shadow-sm ${isDragging ? 'opacity-50' : ''} ${task.isCompleted ? 'opacity-60' : ''} ${
        running
          ? 'border-[var(--accent)] bg-[var(--accent-quiet)] ring-1 ring-[var(--accent)]/40'
          : 'border-slate-700 bg-slate-800'}`}>
      <div className="flex h-full items-start gap-2">
        <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ background: PRIORITY_COLOR[task.priority] }} />
        <div className="min-w-0 flex-1 cursor-grab active:cursor-grabbing" {...listeners} {...attributes}>
          <div className={`truncate text-sm text-slate-100 ${task.isCompleted ? 'line-through' : ''}`}>{task.title}</div>
          <div className="num truncate text-[11px] text-slate-500">
            {fmtClock(task.scheduledStart!)}, {fmtDuration(mins)}
            {task.folderName ? `, ${task.folderName}` : ''}
          </div>
        </div>
        {/* The timer button stays visible while running, so it is obvious what is
            being worked on and one click stops it. */}
        <div className={`flex shrink-0 items-center gap-0.5 group-hover:opacity-100 max-lg:opacity-100 ${running ? '' : 'opacity-0'}`}>
          <button onClick={onToggleTimer} title={running ? 'Stop timer' : 'Start timer'}
            className={`tap ${running
              ? 'text-[var(--accent)] hover:bg-slate-800'
              : 'text-slate-500 hover:bg-slate-700 hover:text-slate-200'}`}>
            {running ? <Square size={13} /> : <Play size={13} />}
          </button>
          <EstimateMenu value={task.estimateMinutes} onPick={onEstimate} />
          <button onClick={onOpen} title="Open card"
            className="tap text-slate-500 hover:bg-slate-700 hover:text-slate-200"><Clock size={13} /></button>
          <button onClick={onUnschedule} title="Unschedule"
            className="tap text-slate-500 hover:bg-red-500/10 hover:text-red-400"><X size={13} /></button>
        </div>
      </div>

      {/* Grab the bottom edge to make the block longer or shorter. */}
      <div onPointerDown={startResize} title="Drag to change how long this takes"
        className="absolute inset-x-0 bottom-0 flex h-2.5 cursor-ns-resize items-end justify-center">
        <span className={`mb-0.5 h-1 w-8 rounded-full bg-slate-500 transition-opacity ${draftMins != null ? 'opacity-100' : 'opacity-0 group-hover:opacity-70'}`} />
      </div>
    </div>
  );
}

const ESTIMATES = [15, 30, 45, 60, 90, 120, 180, 240];

function EstimateMenu({ value, onPick }: { value: number | null; onPick: (m: number) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        title="Estimate"
        className={`num tap px-1.5 text-[11px] ${value == null ? 'text-amber-400/90 hover:bg-amber-500/10' : 'text-slate-400 hover:bg-slate-700 hover:text-slate-200'}`}>
        {value == null ? 'est?' : fmtDuration(value)}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={(e) => { e.stopPropagation(); setOpen(false); }} />
          <div className="absolute right-0 z-40 mt-1 grid w-28 grid-cols-2 gap-0.5 rounded-lg border border-slate-700 bg-slate-900 p-1 shadow-xl">
            {ESTIMATES.map((m) => (
              <button key={m} onClick={(e) => { e.stopPropagation(); setOpen(false); onPick(m); }}
                className="num rounded px-1.5 py-1 text-[11px] text-slate-300 hover:bg-slate-800">
                {fmtDuration(m)}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Pick an hour without dragging. Dragging is fine with a mouse but hopeless on a
 * phone inside a scrolling list, so every card can also just be told when to happen.
 */
function ScheduleMenu({ onPick }: { onPick: (hour: number) => void }) {
  const [open, setOpen] = useState(false);
  const hours = Array.from({ length: DAY_END_HOUR - DAY_START_HOUR }, (_, i) => DAY_START_HOUR + i);
  return (
    <div className="relative">
      <button onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }} title="Schedule"
        className="tap text-slate-500 hover:bg-slate-700 hover:text-slate-200">
        <CalendarPlus size={13} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={(e) => { e.stopPropagation(); setOpen(false); }} />
          <div className="absolute right-0 z-40 mt-1 grid max-h-56 w-24 grid-cols-2 gap-0.5 overflow-y-auto rounded-lg border border-slate-700 bg-slate-900 p-1 shadow-xl">
            {hours.map((h) => (
              <button key={h} onClick={(e) => { e.stopPropagation(); setOpen(false); onPick(h); }}
                className="num rounded px-1 py-1 text-[11px] text-slate-300 hover:bg-slate-800">
                {String(h).padStart(2, '0')}:00
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

interface BoardOption { id: number; name: string; folderName: string }

/**
 * Add a task straight from the planner. Picks a sensible board on its own (the last
 * one used, otherwise the first available) so the common case is type a title and
 * press Enter; the board picker only appears once you want to change it.
 */
function QuickAdd({ businessId }: { businessId: BusinessSelection }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [boardId, setBoardId] = useState<number | null>(null);
  const [showPicker, setShowPicker] = useState(false);

  const folders = useQuery({ queryKey: ['folders'], queryFn: () => apiGet<{ folders: TFolder[] }>('/folders') });
  const scoped = (folders.data?.folders ?? []).filter((f) => businessId === 'all' || f.businessId === businessId);
  const boardsQ = useQuery({
    queryKey: ['quickadd-boards', scoped.map((f) => f.id).join(',')],
    enabled: scoped.length > 0,
    queryFn: async () => {
      const lists = await Promise.all(scoped.map(async (f) => {
        const res = await apiGet<{ boards: { id: number; name: string }[] }>(`/boards?folderId=${f.id}`);
        return res.boards.map((b) => ({ id: b.id, name: b.name, folderName: f.name }));
      }));
      return lists.flat() as BoardOption[];
    },
  });
  const boards = boardsQ.data ?? [];

  const remembered = Number(localStorage.getItem('klippy.quickAddBoard') || 0) || null;
  const target = boardId ?? (boards.some((b) => b.id === remembered) ? remembered : boards[0]?.id ?? null);

  const add = useMutation({
    mutationFn: async (t: string) => {
      if (!target) throw new Error('No board to add to yet.');
      // A card needs a column, so use the board's first one.
      const full = await apiGet<{ columns: { id: number }[] }>(`/boards/${target}/full`);
      const columnId = full.columns[0]?.id;
      if (!columnId) throw new Error('That board has no columns.');
      return apiPost('/tasks', { boardId: target, columnId, title: t });
    },
    onSuccess: () => {
      setTitle('');
      if (target) localStorage.setItem('klippy.quickAddBoard', String(target));
      qc.invalidateQueries({ queryKey: ['day'] });
      qc.invalidateQueries({ queryKey: ['board'] });
    },
  });

  const chosen = boards.find((b) => b.id === target);

  return (
    <div className="border-b border-slate-800 px-2 py-2">
      <div className="flex items-center gap-1.5">
        <input value={title} onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && title.trim() && target) add.mutate(title.trim()); }}
          placeholder="Add a task..."
          className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-900/70 px-2.5 py-1.5 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-[var(--accent)]" />
        <button onClick={() => title.trim() && target && add.mutate(title.trim())}
          disabled={!title.trim() || !target || add.isPending}
          className="shrink-0 rounded-lg bg-violet-600 px-2 py-1.5 text-[var(--accent-ink)] hover:bg-violet-500 disabled:opacity-50">
          <Plus size={14} />
        </button>
      </div>
      <div className="mt-1 flex items-center gap-1 px-0.5">
        {chosen ? (
          <button onClick={() => setShowPicker((s) => !s)}
            className="truncate text-[11px] text-slate-500 hover:text-slate-300">
            into {chosen.folderName} / {chosen.name}
          </button>
        ) : (
          <span className="text-[11px] text-slate-500">No boards yet</span>
        )}
        {add.error && <span className="text-[11px] text-red-400">{(add.error as Error).message}</span>}
      </div>
      {showPicker && boards.length > 0 && (
        <select value={target ?? ''} onChange={(e) => { setBoardId(Number(e.target.value)); setShowPicker(false); }}
          className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-200 outline-none">
          {boards.map((b) => <option key={b.id} value={b.id}>{b.folderName} / {b.name}</option>)}
        </select>
      )}
    </div>
  );
}

function BacklogPanel({ tasks, businessId, onOpen, onEstimate, onSchedule, onNavigate }: {
  tasks: DayTask[]; businessId: BusinessSelection; onOpen: (t: DayTask) => void;
  onEstimate: (id: number, m: number) => void; onSchedule: (id: number, hour: number) => void;
  onNavigate?: (v: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: 'backlog' });
  return (
    <div ref={setNodeRef}
      className={`flex w-full shrink-0 flex-col rounded-2xl border bg-slate-900 lg:w-80 ${isOver ? 'border-[var(--accent)]/60 bg-[var(--accent-quiet)]' : 'border-slate-800'}`}>
      <div className="flex items-center gap-2 border-b border-slate-800 px-4 py-3">
        <span className="font-display text-sm font-semibold text-slate-100">Unscheduled</span>
        <span className="num text-[11px] text-slate-500">{tasks.length}</span>
      </div>

      {/* Capture work without leaving the planner. Having to go to a board first is
          the quickest way to stop planning altogether. */}
      <QuickAdd businessId={businessId} />

      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
        {tasks.length === 0 && (
          <p className="px-2 py-8 text-center text-xs text-slate-500">
            Nothing waiting. Drag a block here to unschedule it.
          </p>
        )}
        {tasks.map((t) => (
          <BacklogCard key={t.id} task={t} onOpen={() => onOpen(t)} onEstimate={(m) => onEstimate(t.id, m)} onSchedule={(h) => onSchedule(t.id, h)} />
        ))}
      </div>
      {onNavigate && (
        <button onClick={() => onNavigate('board')}
          className="border-t border-slate-800 px-4 py-2.5 text-left text-[11px] text-slate-500 hover:text-slate-300">
          Open the board to add more
        </button>
      )}
    </div>
  );
}

function BacklogCard({ task, onOpen, onEstimate, onSchedule }: { task: DayTask; onOpen: () => void; onEstimate: (m: number) => void; onSchedule: (hour: number) => void }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: `t-${task.id}` });
  const style = transform ? { transform: `translate(${transform.x}px, ${transform.y}px)` } : undefined;
  return (
    <div ref={setNodeRef} style={style}
      className={`group rounded-lg border border-slate-700/70 bg-slate-800/80 p-2.5 ${isDragging ? 'opacity-50' : ''}`}>
      <div className="flex items-start gap-2">
        <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: PRIORITY_COLOR[task.priority] }} />
        <div className="min-w-0 flex-1 cursor-grab active:cursor-grabbing" {...listeners} {...attributes}>
          <div className="truncate text-sm text-slate-100">{task.title}</div>
          <div className="truncate text-[11px] text-slate-500">
            {[task.folderName, task.boardName].filter(Boolean).join(' / ')}
            {task.dueDate ? `, due ${task.dueDate}` : ''}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <EstimateMenu value={task.estimateMinutes} onPick={onEstimate} />
          <ScheduleMenu onPick={onSchedule} />
          <button onClick={onOpen} title="Open card"
            className="tap text-slate-500 hover:bg-slate-700 hover:text-slate-200 lg:opacity-0 lg:group-hover:opacity-100">
            <Clock size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}
