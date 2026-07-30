import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DndContext, useDraggable, useDroppable, PointerSensor, useSensor, useSensors,
  rectIntersection, type DragEndEvent, type CollisionDetection,
} from '@dnd-kit/core';
import { ChevronLeft, ChevronRight, X, Clock, AlertTriangle, CalendarPlus } from 'lucide-react';
import { apiGet, apiPatch } from '../lib/api';
import type { Priority } from '../lib/types';
import type { BusinessSelection } from './BusinessSwitcher';
import { CardDetail } from './CardDetail';

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
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const bizQ = businessId === 'all' ? '' : `&businessId=${businessId}`;
  const key = ['day', date, businessId] as const;
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => apiGet<DayData>(`/tasks/day?date=${date}${bizQ}`),
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
    <div className="flex h-full flex-col">
      {/* Header: date nav + capacity */}
      <div className="shrink-0 border-b border-slate-800 px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <h2 className="font-display text-lg font-semibold text-slate-100">
              {isToday ? 'Today' : new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long' })}
            </h2>
            <p className="num text-xs text-slate-500">
              {new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={() => setDate(shiftDate(date, -1))} title="Previous day"
              className="grid h-8 w-8 place-items-center rounded-lg border border-slate-700 text-slate-400 hover:bg-slate-800 hover:text-slate-200">
              <ChevronLeft size={15} />
            </button>
            <button onClick={() => setDate(todayStr())}
              className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800">
              Today
            </button>
            <button onClick={() => setDate(shiftDate(date, 1))} title="Next day"
              className="grid h-8 w-8 place-items-center rounded-lg border border-slate-700 text-slate-400 hover:bg-slate-800 hover:text-slate-200">
              <ChevronRight size={15} />
            </button>
          </div>

          {/* Capacity: the point of the whole screen. */}
          <div className="ml-auto w-full sm:w-72">
            <div className="mb-1 flex items-baseline justify-between text-xs">
              <span className="text-slate-500">Planned</span>
              <span className={`num font-semibold ${cap?.overcommitted ? 'text-red-400' : 'text-violet-300'}`}>
                {fmtDuration(cap?.plannedMinutes ?? 0)} / {fmtDuration(cap?.workingMinutes ?? 480)}
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
        </div>
      </div>

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
                  <Block key={t.id} task={t}
                    onOpen={() => setOpenTask({ id: t.id, boardId: t.boardId })}
                    onUnschedule={() => patch.mutate({ id: t.id, body: { scheduledStart: null } })}
                    onEstimate={(m) => patch.mutate({ id: t.id, body: { estimateMinutes: m } })} />
                ))}
              </div>
            </div>
          </div>

          {/* Backlog */}
          <BacklogPanel tasks={data?.backlog ?? []}
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
    </div>
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

function Block({ task, onOpen, onUnschedule, onEstimate }: {
  task: DayTask; onOpen: () => void; onUnschedule: () => void; onEstimate: (m: number) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: `t-${task.id}` });
  const mins = task.estimateMinutes ?? DEFAULT_ESTIMATE;
  const top = Math.max(0, (offsetMinutes(task.scheduledStart!) / 60) * PX_PER_HOUR);
  const height = Math.max(26, (mins / 60) * PX_PER_HOUR - 4);
  const style: React.CSSProperties = {
    top, height, transform: transform ? `translate(${transform.x}px, ${transform.y}px)` : undefined,
  };
  return (
    <div ref={setNodeRef} style={style}
      className={`group absolute left-14 right-1 z-20 overflow-hidden rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 shadow-sm ${isDragging ? 'opacity-50' : ''} ${task.isCompleted ? 'opacity-60' : ''}`}>
      <div className="flex h-full items-start gap-2">
        <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ background: PRIORITY_COLOR[task.priority] }} />
        <div className="min-w-0 flex-1 cursor-grab active:cursor-grabbing" {...listeners} {...attributes}>
          <div className={`truncate text-sm text-slate-100 ${task.isCompleted ? 'line-through' : ''}`}>{task.title}</div>
          <div className="num truncate text-[11px] text-slate-500">
            {fmtClock(task.scheduledStart!)}, {fmtDuration(mins)}
            {task.folderName ? `, ${task.folderName}` : ''}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100 max-lg:opacity-100">
          <EstimateMenu value={task.estimateMinutes} onPick={onEstimate} />
          <button onClick={onOpen} title="Open card"
            className="rounded p-1 text-slate-500 hover:bg-slate-700 hover:text-slate-200"><Clock size={12} /></button>
          <button onClick={onUnschedule} title="Unschedule"
            className="rounded p-1 text-slate-500 hover:bg-red-500/10 hover:text-red-400"><X size={12} /></button>
        </div>
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
        className={`num rounded px-1.5 py-1 text-[11px] ${value == null ? 'text-amber-400/90 hover:bg-amber-500/10' : 'text-slate-400 hover:bg-slate-700 hover:text-slate-200'}`}>
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
        className="rounded p-1 text-slate-500 hover:bg-slate-700 hover:text-slate-200">
        <CalendarPlus size={12} />
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

function BacklogPanel({ tasks, onOpen, onEstimate, onSchedule, onNavigate }: {
  tasks: DayTask[]; onOpen: (t: DayTask) => void;
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
            className="rounded p-1 text-slate-500 opacity-0 hover:bg-slate-700 hover:text-slate-200 group-hover:opacity-100 max-lg:opacity-100">
            <Clock size={12} />
          </button>
        </div>
      </div>
    </div>
  );
}
