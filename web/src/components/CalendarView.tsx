import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { apiGet } from '../lib/api';
import type { CalendarTask, Priority } from '../lib/types';
import { CardDetail } from './CardDetail';
import { QuickAddTask } from './QuickAddTask';

type View = 'day' | 'week' | 'month' | 'year';

const PRIORITY_COLOR: Record<Priority, string> = {
  none: '#6366f1', low: '#64748b', medium: '#eab308', high: '#f97316', urgent: '#ef4444',
};
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const startOfWeek = (d: Date) => { const x = new Date(d); const day = (x.getDay() + 6) % 7; return addDays(x, -day); }; // Monday
const sameDay = (a: Date, b: Date) => iso(a) === iso(b);

export function CalendarView() {
  const [view, setView] = useState<View>('month');
  const [cursor, setCursor] = useState(new Date());
  const [openTask, setOpenTask] = useState<{ id: number; boardId: number } | null>(null);
  const [addDate, setAddDate] = useState<string | null>(null);

  const range = useMemo(() => computeRange(view, cursor), [view, cursor]);
  const { data } = useQuery({
    queryKey: ['calendar', range.from, range.to],
    queryFn: () => apiGet<{ tasks: CalendarTask[] }>(`/tasks/calendar?from=${range.from}&to=${range.to}`),
  });
  const tasks = data?.tasks ?? [];
  const byDay = useMemo(() => {
    const m = new Map<string, CalendarTask[]>();
    for (const t of tasks) { const k = t.dueDate; (m.get(k) ?? m.set(k, []).get(k)!).push(t); }
    return m;
  }, [tasks]);

  function shift(dir: number) {
    if (view === 'day') setCursor(addDays(cursor, dir));
    else if (view === 'week') setCursor(addDays(cursor, dir * 7));
    else if (view === 'month') setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + dir, 1));
    else setCursor(new Date(cursor.getFullYear() + dir, cursor.getMonth(), 1));
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
        <div className="flex items-center gap-2">
          <button onClick={() => shift(-1)} className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-800"><ChevronLeft size={16} /></button>
          <button onClick={() => shift(1)} className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-800"><ChevronRight size={16} /></button>
          <button onClick={() => setCursor(new Date())} className="rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-slate-800">Today</button>
          <h2 className="ml-2 text-lg font-semibold text-slate-100">{titleFor(view, cursor)}</h2>
        </div>
        <div className="flex gap-1 rounded-lg bg-slate-900 p-1">
          {(['day', 'week', 'month', 'year'] as View[]).map((v) => (
            <button key={v} onClick={() => setView(v)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium capitalize ${view === v ? 'bg-slate-700 text-slate-100' : 'text-slate-400 hover:text-slate-200'}`}>{v}</button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-2 sm:p-4">
        {view === 'month' && <MonthGrid cursor={cursor} byDay={byDay} onOpen={setOpenTask} onAdd={setAddDate} />}
        {view === 'week' && <WeekGrid cursor={cursor} byDay={byDay} onOpen={setOpenTask} onAdd={setAddDate} />}
        {view === 'day' && <DayList cursor={cursor} byDay={byDay} onOpen={setOpenTask} onAdd={setAddDate} />}
        {view === 'year' && <YearGrid cursor={cursor} byDay={byDay} onPick={(d) => { setCursor(d); setView('month'); }} />}
      </div>

      {openTask && <CardDetail taskId={openTask.id} boardId={openTask.boardId} onClose={() => setOpenTask(null)} />}
      {addDate && <QuickAddTask dueDate={addDate} onClose={() => setAddDate(null)} />}
    </div>
  );
}

type OpenFn = (t: { id: number; boardId: number }) => void;

function TaskPill({ t, onOpen }: { t: CalendarTask; onOpen: OpenFn }) {
  return (
    <button onClick={() => onOpen({ id: t.id, boardId: t.boardId })}
      className="flex w-full items-center gap-1.5 truncate rounded px-1.5 py-0.5 text-left text-[11px] hover:brightness-125"
      style={{ background: `${PRIORITY_COLOR[t.priority]}22`, color: PRIORITY_COLOR[t.priority] }}>
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: PRIORITY_COLOR[t.priority] }} />
      <span className={`truncate ${t.isCompleted ? 'line-through opacity-70' : ''}`}>{t.title}</span>
    </button>
  );
}

function MonthGrid({ cursor, byDay, onOpen, onAdd }: { cursor: Date; byDay: Map<string, CalendarTask[]>; onOpen: OpenFn; onAdd: (d: string) => void }) {
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const gridStart = startOfWeek(first);
  const days = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  const today = new Date();
  return (
    <div className="grid grid-cols-7 overflow-hidden rounded-xl border border-slate-800">
      {DOW.map((d) => (
        <div key={d} className="border-b border-slate-800 bg-slate-900/50 px-1 py-1.5 text-center text-[10px] font-medium text-slate-500 sm:px-2 sm:text-[11px]">
          <span className="sm:hidden">{d[0]}</span><span className="hidden sm:inline">{d}</span>
        </div>
      ))}
      {days.map((d, i) => {
        const inMonth = d.getMonth() === cursor.getMonth();
        const list = byDay.get(iso(d)) ?? [];
        const max = 3;
        return (
          <div key={i} className={`group/day relative min-h-16 border-b border-r border-slate-800 p-1 sm:min-h-24 sm:p-1.5 ${inMonth ? '' : 'bg-slate-950/60'}`}>
            <div className="mb-1 flex items-center justify-between">
              <button onClick={() => onAdd(iso(d))} title="Add a card on this day"
                className="grid h-5 w-5 place-items-center rounded text-slate-500 opacity-0 hover:bg-slate-800 hover:text-violet-300 focus:opacity-100 group-hover/day:opacity-100">
                <Plus size={12} />
              </button>
              <span className={`text-[11px] sm:text-xs ${sameDay(d, today) ? 'font-bold text-violet-400' : inMonth ? 'text-slate-400' : 'text-slate-500'}`}>{d.getDate()}</span>
            </div>
            <div className="space-y-1">
              {list.slice(0, max).map((t) => <TaskPill key={t.id} t={t} onOpen={onOpen} />)}
              {list.length > max && <div className="px-1 text-[10px] text-slate-500">+{list.length - max} more</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function WeekGrid({ cursor, byDay, onOpen, onAdd }: { cursor: Date; byDay: Map<string, CalendarTask[]>; onOpen: OpenFn; onAdd: (d: string) => void }) {
  const start = startOfWeek(cursor);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const today = new Date();
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-7">
      {days.map((d, i) => {
        const list = byDay.get(iso(d)) ?? [];
        return (
          <div key={i} className="min-h-24 rounded-xl border border-slate-800 p-2 lg:min-h-64">
            <div className="mb-2 flex items-center justify-between">
              <span className={`text-xs ${sameDay(d, today) ? 'font-bold text-violet-400' : 'text-slate-400'}`}>{DOW[i]} {d.getDate()}</span>
              <button onClick={() => onAdd(iso(d))} title="Add a card on this day"
                className="grid h-5 w-5 place-items-center rounded text-slate-500 hover:bg-slate-800 hover:text-violet-300">
                <Plus size={12} />
              </button>
            </div>
            <div className="space-y-1">{list.map((t) => <TaskPill key={t.id} t={t} onOpen={onOpen} />)}</div>
          </div>
        );
      })}
    </div>
  );
}

function DayList({ cursor, byDay, onOpen, onAdd }: { cursor: Date; byDay: Map<string, CalendarTask[]>; onOpen: OpenFn; onAdd: (d: string) => void }) {
  const list = byDay.get(iso(cursor)) ?? [];
  return (
    <div className="mx-auto max-w-2xl space-y-2">
      <button onClick={() => onAdd(iso(cursor))}
        className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-slate-700 p-3 text-sm text-slate-400 hover:border-slate-500 hover:text-slate-200">
        <Plus size={15} /> Add a card on this day
      </button>
      {list.length === 0 && <p className="py-8 text-center text-sm text-slate-500">Nothing due this day.</p>}
      {list.map((t) => (
        <button key={t.id} onClick={() => onOpen({ id: t.id, boardId: t.boardId })}
          className="flex w-full items-center gap-3 rounded-xl border border-slate-800 p-3 text-left hover:bg-slate-900">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: PRIORITY_COLOR[t.priority] }} />
          <span className={`text-sm ${t.isCompleted ? 'text-slate-500 line-through' : 'text-slate-200'}`}>{t.title}</span>
        </button>
      ))}
    </div>
  );
}

function YearGrid({ cursor, byDay, onPick }: { cursor: Date; byDay: Map<string, CalendarTask[]>; onPick: (d: Date) => void }) {
  const year = cursor.getFullYear();
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
      {MONTHS.map((name, m) => {
        const first = new Date(year, m, 1);
        const gridStart = startOfWeek(first);
        const days = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
        return (
          <button key={m} onClick={() => onPick(new Date(year, m, 1))}
            className="rounded-xl border border-slate-800 p-3 text-left hover:border-slate-600">
            <div className="mb-2 text-sm font-medium text-slate-200">{name}</div>
            <div className="grid grid-cols-7 gap-0.5">
              {days.map((d, i) => {
                const count = (byDay.get(iso(d)) ?? []).length;
                return (
                  <div key={i} className={`grid h-4 place-items-center text-[9px] ${d.getMonth() === m ? 'text-slate-500' : 'text-slate-700'}`}>
                    {count > 0 ? <span className="h-2.5 w-2.5 rounded-full bg-violet-500/80" /> : d.getMonth() === m ? d.getDate() : ''}
                  </div>
                );
              })}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function computeRange(view: View, cursor: Date): { from: string; to: string } {
  if (view === 'day') return { from: iso(cursor), to: iso(cursor) };
  if (view === 'week') { const s = startOfWeek(cursor); return { from: iso(s), to: iso(addDays(s, 6)) }; }
  if (view === 'month') {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const s = startOfWeek(first);
    return { from: iso(s), to: iso(addDays(s, 41)) };
  }
  return { from: `${cursor.getFullYear()}-01-01`, to: `${cursor.getFullYear()}-12-31` };
}

function titleFor(view: View, cursor: Date): string {
  if (view === 'year') return `${cursor.getFullYear()}`;
  if (view === 'month') return `${MONTHS[cursor.getMonth()]} ${cursor.getFullYear()}`;
  if (view === 'week') { const s = startOfWeek(cursor); const e = addDays(s, 6); return `${MONTHS[s.getMonth()].slice(0, 3)} ${s.getDate()} - ${MONTHS[e.getMonth()].slice(0, 3)} ${e.getDate()}`; }
  return `${DOW[(cursor.getDay() + 6) % 7]}, ${MONTHS[cursor.getMonth()]} ${cursor.getDate()}`;
}
