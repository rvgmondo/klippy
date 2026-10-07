import { useState } from 'react';
import { promptDialog } from './ConfirmDialog';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DndContext, useDraggable, useDroppable, PointerSensor, TouchSensor, useSensor, useSensors,
  rectIntersection, type DragEndEvent, type CollisionDetection,
} from '@dnd-kit/core';
import { ChevronLeft, ChevronRight, X, AlertTriangle, CalendarPlus, Play, Square, Plus, Maximize2, Users, Check } from 'lucide-react';
import { apiGet, apiPatch, apiPost } from '../lib/api';
import type { Priority } from '../lib/types';
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
interface DayMeeting {
  id: number; title: string; kind: string; startAt: string; endAt: string | null;
  location: string | null; folderId: number | null; minutes: number;
}
interface DayData {
  date: string;
  scheduled: DayTask[];
  backlog: DayTask[];
  meetings?: DayMeeting[];
  capacity: {
    workingMinutes: number; plannedMinutes: number; remainingMinutes: number;
    overcommitted: boolean; unestimated: number;
    meetingMinutes?: number; taskMinutes?: number;
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
                <span className="text-slate-500">
                  {fmtDuration(cap?.remainingMinutes ?? 0)} left
                  {cap?.meetingMinutes
                    ? (cap.taskMinutes ? `. Planned: ${fmtDuration(cap.meetingMinutes)} of meetings, ${fmtDuration(cap.taskMinutes)} of work` : `. ${fmtDuration(cap.meetingMinutes)} of the day is meetings`)
                    : ''}
                </span>
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
          {/* On a phone: the day as a list, in time order. A timeline you have to drag
              onto is unusable on a narrow screen, and it overlapped the list below it. */}
          <PhonePlan tasks={data?.scheduled ?? []} meetings={data?.meetings ?? []} runningTaskId={runningTaskId}
            onToggleTimer={(id) => toggleTimer.mutate(id)}
            onOpen={(t) => setOpenTask({ id: t.id, boardId: t.boardId })}
            onDone={(t) => patch.mutate({ id: t.id, body: { isCompleted: !t.isCompleted } })}
            onUnschedule={(t) => patch.mutate({ id: t.id, body: { scheduledStart: null } })}
            onMeeting={() => onNavigate?.('calendar')} />

          {/* Timeline */}
          <div className="hidden min-h-0 flex-1 lg:block lg:overflow-y-auto">
            <div className="relative rounded-2xl border border-slate-800 bg-slate-900 p-3">
              <div className="relative" style={{ height: hours.length * PX_PER_HOUR }}>
                {hours.map((h, i) => (
                  <HourSlot key={h} hour={h} top={i * PX_PER_HOUR} />
                ))}
                {/* Now line */}
                {isToday && <NowLine />}
                {/* Meetings: fixed, because they happen when they happen. */}
                {(data?.meetings ?? []).map((m) => (
                  <MeetingBlock key={`m${m.id}`} meeting={m} onOpen={() => onNavigate?.('calendar')} />
                ))}
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
            runningTaskId={runningTaskId} onToggleTimer={(id) => toggleTimer.mutate(id)}
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
          <button onClick={onOpen} title="Open task" aria-label="Open task"
            className="tap text-slate-500 hover:bg-slate-700 hover:text-slate-200"><Maximize2 size={13} /></button>
          <button onClick={onUnschedule} title="Take it off the plan"
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

  // Every board in one request. This used to ask once per client, which after an
  // import was fifty requests before the box could say where a task would go.
  const boardsQ = useQuery({
    queryKey: ['boards-all'],
    queryFn: () => apiGet<{ boards: (BoardOption & { businessId: number | null; firstColumnId: number })[] }>('/boards/all'),
    select: (d) => d.boards.filter((b) => businessId === 'all' || b.businessId === businessId),
  });
  const boards = boardsQ.data ?? [];

  const remembered = Number(localStorage.getItem('klippy.quickAddBoard') || 0) || null;
  const target = boardId ?? (boards.some((b) => b.id === remembered) ? remembered : boards[0]?.id ?? null);

  const add = useMutation({
    mutationFn: async (t: string) => {
      if (!target) throw new Error('No board to add to yet.');
      // A card needs a column: the board's first one that is not "done".
      const columnId = boards.find((b) => b.id === target)?.firstColumnId;
      if (!columnId) throw new Error('That board has no columns.');
      return apiPost('/tasks', { boardId: target, columnId, title: t });
    },
    onSuccess: () => {
      setTitle('');
      if (target) localStorage.setItem('klippy.quickAddBoard', String(target));
      qc.invalidateQueries({ queryKey: ['day'] });
      qc.invalidateQueries({ queryKey: ['board'] });
      qc.invalidateQueries({ queryKey: ['tasks-all'] });
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

function BacklogPanel({ tasks, businessId, runningTaskId, onToggleTimer, onOpen, onEstimate, onSchedule, onNavigate }: {
  tasks: DayTask[]; businessId: BusinessSelection; onOpen: (t: DayTask) => void;
  runningTaskId: number | null; onToggleTimer: (id: number) => void;
  onEstimate: (id: number, m: number) => void; onSchedule: (id: number, hour: number) => void;
  onNavigate?: (v: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: 'backlog' });
  return (
    <div ref={setNodeRef}
      className={`flex w-full shrink-0 flex-col rounded-2xl border bg-slate-900 lg:w-80 ${isOver ? 'border-[var(--accent)]/60 bg-[var(--accent-quiet)]' : 'border-slate-800'}`}>
      <div className="flex items-center gap-2 border-b border-slate-800 px-4 py-3">
        <span className="font-display text-sm font-semibold text-slate-100">Not planned yet</span>
        <span className="num text-[11px] text-slate-500">{tasks.length}</span>
      </div>

      {/* Capture work without leaving the planner. Having to go to a board first is
          the quickest way to stop planning altogether. */}
      <QuickAdd businessId={businessId} />

      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
        {tasks.length === 0 && (
          <p className="px-2 py-8 text-center text-xs text-slate-500">
            Nothing waiting. Drag a block here to take it off the plan.
          </p>
        )}
        {tasks.map((t) => (
          <BacklogCard key={t.id} task={t} running={runningTaskId === t.id} onToggleTimer={() => onToggleTimer(t.id)}
            onOpen={() => onOpen(t)} onEstimate={(m) => onEstimate(t.id, m)} onSchedule={(h) => onSchedule(t.id, h)} />
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

function BacklogCard({ task, running, onToggleTimer, onOpen, onEstimate, onSchedule }: {
  task: DayTask; running: boolean; onToggleTimer: () => void; onOpen: () => void;
  onEstimate: (m: number) => void; onSchedule: (hour: number) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: `t-${task.id}` });
  const style = transform ? { transform: `translate(${transform.x}px, ${transform.y}px)` } : undefined;
  return (
    <div ref={setNodeRef} style={style}
      className={`group rounded-lg border border-slate-700/70 bg-slate-800/80 p-2.5 ${isDragging ? 'opacity-50' : ''}`}>
      {/* On a phone the buttons take their own row, so the task's name is readable. */}
      <div className="flex flex-wrap items-start gap-2 lg:flex-nowrap">
        <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: PRIORITY_COLOR[task.priority] }} />
        <div className="min-w-0 flex-1 cursor-grab active:cursor-grabbing max-lg:basis-[calc(100%-1.25rem)]" {...listeners} {...attributes}>
          <div className="truncate text-sm text-slate-100">{task.title}</div>
          <div className="flex flex-wrap items-center gap-x-1.5 text-[11px] text-slate-500">
            <DueTag due={task.dueDate} />
            <span className="truncate">{[task.folderName, task.boardName].filter(Boolean).join(' / ')}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5 max-lg:w-full max-lg:justify-end">
          <EstimateMenu value={task.estimateMinutes} onPick={onEstimate} />
          <ScheduleMenu onPick={onSchedule} />
          <button onClick={onToggleTimer} title={running ? 'Stop the timer' : 'Start the timer'} aria-label={running ? 'Stop the timer' : 'Start the timer'}
            className={`tap ${running ? 'text-[var(--accent)]' : 'text-slate-500 hover:bg-slate-700 hover:text-slate-200'}`}>
            {running ? <Square size={13} /> : <Play size={13} />}
          </button>
          <button onClick={onOpen} title="Open task" aria-label="Open task"
            className="tap text-slate-500 hover:bg-slate-700 hover:text-slate-200">
            <Maximize2 size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}

/** Late, due today, or the day it is due, in words. */
function DueTag({ due }: { due: string | null }) {
  if (!due) return null;
  const today = todayStr();
  if (due < today) {
    const [y, m, d] = due.split('-').map(Number) as [number, number, number];
    const [ty, tm, td] = today.split('-').map(Number) as [number, number, number];
    const n = Math.round((new Date(ty, tm - 1, td).getTime() - new Date(y, m - 1, d).getTime()) / 86400000);
    return <span className="shrink-0 rounded bg-red-500/15 px-1.5 font-medium text-red-300">{n} {n === 1 ? 'day' : 'days'} late</span>;
  }
  if (due === today) return <span className="shrink-0 rounded bg-amber-500/15 px-1.5 font-medium text-amber-300">Due today</span>;
  return <span className="shrink-0">Due {new Date(`${due}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</span>;
}

/** A meeting on the day. Fixed in place: it happens when it happens. */
function MeetingBlock({ meeting, onOpen }: { meeting: DayMeeting; onOpen: () => void }) {
  const top = Math.max(0, (offsetMinutes(meeting.startAt) / 60) * PX_PER_HOUR);
  const height = Math.max(26, (meeting.minutes / 60) * PX_PER_HOUR - 4);
  return (
    <button onClick={onOpen} style={{ top, height }}
      className="absolute left-14 right-1 z-10 overflow-hidden rounded-lg border border-sky-500/30 bg-sky-500/10 px-2.5 py-1.5 text-left hover:bg-sky-500/15">
      <div className="flex items-center gap-1.5 truncate text-sm text-sky-100">
        <Users size={12} className="shrink-0 text-sky-300" /> {meeting.title}
      </div>
      <div className="num truncate text-[11px] text-sky-300/80">
        {fmtClock(meeting.startAt)}, {fmtDuration(meeting.minutes)}{meeting.location ? `, ${meeting.location}` : ''}
      </div>
    </button>
  );
}

/** The planned day on a phone: meetings and planned tasks together, earliest first. */
function PhonePlan({ tasks, meetings, runningTaskId, onToggleTimer, onOpen, onDone, onUnschedule, onMeeting }: {
  tasks: DayTask[]; meetings: DayMeeting[]; runningTaskId: number | null;
  onToggleTimer: (id: number) => void; onOpen: (t: DayTask) => void; onDone: (t: DayTask) => void;
  onUnschedule: (t: DayTask) => void; onMeeting: () => void;
}) {
  const rows = [
    ...meetings.map((m) => ({ at: m.startAt, meeting: m, task: null as DayTask | null })),
    ...tasks.map((t) => ({ at: t.scheduledStart!, meeting: null as DayMeeting | null, task: t })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  return (
    <div className="lg:hidden">
      <div className="mb-2 font-display text-sm font-semibold text-slate-100">Planned for the day</div>
      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-700 px-3 py-4 text-sm text-slate-500">
          Nothing planned yet. Tap the calendar on a task below to give it a time.
        </p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-800">
          {rows.map((r) => r.meeting ? (
            <button key={`m${r.meeting.id}`} onClick={onMeeting}
              className="flex w-full items-center gap-3 border-b border-slate-800 bg-sky-500/5 px-3 py-2.5 text-left last:border-b-0">
              <span className="num w-12 shrink-0 text-xs text-sky-300">{fmtClock(r.meeting.startAt)}</span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 truncate text-sm text-slate-100"><Users size={13} className="shrink-0 text-sky-300" />{r.meeting.title}</span>
                <span className="block truncate text-xs text-slate-500">{fmtDuration(r.meeting.minutes)}{r.meeting.location ? `, ${r.meeting.location}` : ''}</span>
              </span>
            </button>
          ) : (
            <div key={`t${r.task!.id}`} className="flex items-center gap-2 border-b border-slate-800 bg-slate-900/40 px-3 py-2 last:border-b-0">
              <span className="num w-12 shrink-0 text-xs text-slate-400">{fmtClock(r.task!.scheduledStart!)}</span>
              <button onClick={() => onOpen(r.task!)} className="min-w-0 flex-1 text-left">
                <span className={`block truncate text-sm ${r.task!.isCompleted ? 'text-slate-500 line-through' : 'text-slate-100'}`}>{r.task!.title}</span>
                <span className="block truncate text-xs text-slate-500">
                  {fmtDuration(r.task!.estimateMinutes ?? DEFAULT_ESTIMATE)}{r.task!.folderName ? `, ${r.task!.folderName}` : ''}
                </span>
              </button>
              <button onClick={() => onToggleTimer(r.task!.id)} aria-label={runningTaskId === r.task!.id ? 'Stop the timer' : 'Start the timer'}
                className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg ${runningTaskId === r.task!.id ? 'text-[var(--accent)]' : 'text-slate-400 hover:bg-slate-800'}`}>
                {runningTaskId === r.task!.id ? <Square size={15} /> : <Play size={15} />}
              </button>
              <button onClick={() => onDone(r.task!)} aria-label={r.task!.isCompleted ? 'Not done after all' : 'Done'}
                className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg ${r.task!.isCompleted ? 'text-emerald-400' : 'text-slate-400 hover:bg-slate-800'}`}>
                <Check size={16} />
              </button>
              <button onClick={() => onUnschedule(r.task!)} aria-label="Take it off the plan"
                className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-slate-500 hover:bg-slate-800"><X size={15} /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
