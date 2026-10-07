import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, Plus, CheckCircle2, Circle, ListChecks, Flag } from 'lucide-react';
import { apiGet, apiPatch, apiPost, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { notify } from './ConfirmDialog';
import { CardDetail } from './CardDetail';
import { Page, PageHeader, PageBody } from './PageHeader';
import { Skeleton, btnPrimary, fieldClass } from './ui';
import type { BusinessSelection } from './BusinessSwitcher';

/**
 * Every open task, across every client and board, in one list.
 *
 * Before this, open work could only be seen one board at a time, or as the slice
 * Today shows. The questions this answers are the ones asked on a Monday: what is
 * late, what is mine, what is due this week, and what is open for this client.
 * Filters run in the browser over the whole list, so they are instant.
 */

interface Task {
  id: number; title: string; priority: 'none' | 'low' | 'medium' | 'high' | 'urgent'; dueDate: string | null;
  boardId: number; columnId: number; isCompleted: boolean; completedAt: string | null;
  estimateMinutes: number | null; assignedTo: number | null; createdAt: string;
  boardName: string; folderId: number; folderName: string; businessId: number | null;
  pillar: 'delivery' | 'operations'; columnName: string | null;
}
interface BoardOpt { id: number; name: string; folderId: number; folderName: string; firstColumnId: number }
type Due = 'all' | 'late' | 'today' | 'week' | 'nodate';
type Who = 'anyone' | 'me' | 'nobody' | number;
type Group = 'due' | 'client';

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const plusDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00`); d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const say = (d: string) => `${Number(d.slice(8, 10))} ${MON[Number(d.slice(5, 7)) - 1]}`;
const PRIORITY: Record<Task['priority'], { label: string; cls: string } | null> = {
  none: null, low: null,
  medium: { label: 'Medium', cls: 'text-sky-300' },
  high: { label: 'High', cls: 'text-amber-300' },
  urgent: { label: 'Urgent', cls: 'text-red-300' },
};

export function TasksView({ businessId }: { businessId: BusinessSelection }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [showDone, setShowDone] = useState(false);
  const bizParam = businessId === 'all' ? '' : `businessId=${businessId}&`;
  const { data, isLoading } = useQuery({
    queryKey: ['tasks-all', businessId, showDone],
    queryFn: () => apiGet<{ tasks: Task[] }>(`/tasks/all?${bizParam}${showDone ? 'done=true' : ''}`),
  });
  const people = useQuery({ queryKey: ['users'], queryFn: () => apiGet<{ users: { id: number; name: string }[] }>('/users') });
  const boardsQ = useQuery({ queryKey: ['boards-all'], queryFn: () => apiGet<{ boards: BoardOpt[] }>('/boards/all') });

  const [q, setQ] = useState('');
  const [client, setClient] = useState<number | 'all'>('all');
  const [who, setWho] = useState<Who>('anyone');
  const [due, setDue] = useState<Due>('all');
  const [urgentOnly, setUrgentOnly] = useState(false);
  const [group, setGroup] = useState<Group>('due');
  const [open, setOpen] = useState<{ id: number; boardId: number } | null>(null);

  const all = data?.tasks ?? [];
  const today = todayIso();
  const weekEnd = plusDays(today, 7);
  const userName = useMemo(() => new Map((people.data?.users ?? []).map((u) => [u.id, u.name])), [people.data]);
  const clients = useMemo(() => {
    const m = new Map<number, string>();
    for (const t of all) m.set(t.folderId, t.folderName);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [all]);

  const needle = q.trim().toLowerCase();
  const shown = all.filter((t) => {
    if (needle && !`${t.title} ${t.folderName} ${t.boardName}`.toLowerCase().includes(needle)) return false;
    if (client !== 'all' && t.folderId !== client) return false;
    if (who === 'me' && t.assignedTo !== user?.id) return false;
    if (who === 'nobody' && t.assignedTo != null) return false;
    if (typeof who === 'number' && t.assignedTo !== who) return false;
    if (urgentOnly && t.priority !== 'high' && t.priority !== 'urgent') return false;
    if (due === 'late' && !(t.dueDate && t.dueDate < today)) return false;
    if (due === 'today' && t.dueDate !== today) return false;
    if (due === 'week' && !(t.dueDate && t.dueDate >= today && t.dueDate <= weekEnd)) return false;
    if (due === 'nodate' && t.dueDate) return false;
    return true;
  });

  const bucketOf = (t: Task) => (showDone ? 'Done in the last 30 days'
    : !t.dueDate ? 'No date' : t.dueDate < today ? 'Late' : t.dueDate === today ? 'Today' : t.dueDate <= weekEnd ? 'This week' : 'Later');
  const ORDER = ['Late', 'Today', 'This week', 'Later', 'No date', 'Done in the last 30 days'];
  const groups = useMemo(() => {
    const m = new Map<string, Task[]>();
    for (const t of shown) {
      const k = group === 'client' ? t.folderName : bucketOf(t);
      m.set(k, [...(m.get(k) ?? []), t]);
    }
    return [...m.entries()].sort((a, b) => (group === 'client' ? a[0].localeCompare(b[0]) : ORDER.indexOf(a[0]) - ORDER.indexOf(b[0])));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, group]);

  const counts = {
    late: all.filter((t) => t.dueDate && t.dueDate < today).length,
    today: all.filter((t) => t.dueDate === today).length,
    week: all.filter((t) => t.dueDate && t.dueDate >= today && t.dueDate <= weekEnd).length,
    nodate: all.filter((t) => !t.dueDate).length,
  };

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['tasks-all'] });
    void qc.invalidateQueries({ queryKey: ['home'] });
    void qc.invalidateQueries({ queryKey: ['board'] });
    void qc.invalidateQueries({ queryKey: ['day'] });
  };
  const toggle = useMutation({
    mutationFn: (t: Task) => apiPatch(`/tasks/${t.id}`, { isCompleted: !t.isCompleted }),
    onSuccess: (_r, t) => { refresh(); notify(t.isCompleted ? 'Opened again.' : 'Done.', 'ok'); },
    onError: (e) => notify(e instanceof ApiError ? e.message : 'That did not save.', 'error'),
  });

  // ---- quick add ----
  const [title, setTitle] = useState('');
  const [boardFor, setBoardFor] = useState<number | ''>('');
  const [dueFor, setDueFor] = useState('');
  const boards = boardsQ.data?.boards ?? [];
  const add = useMutation({
    mutationFn: () => {
      const b = boards.find((x) => x.id === boardFor) ?? boards[0];
      if (!b) throw new Error('Make a board first, on a client in the Work tree.');
      return apiPost('/tasks', { boardId: b.id, columnId: b.firstColumnId, title: title.trim(), dueDate: dueFor || null });
    },
    onSuccess: () => { setTitle(''); setDueFor(''); refresh(); notify('Added.', 'ok'); },
    onError: (e) => notify(e instanceof Error ? e.message : 'That did not save.', 'error'),
  });

  const chip = (active: boolean) => `rounded-lg px-3 py-1.5 text-sm ${active ? 'bg-slate-700 text-slate-100' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'}`;

  return (
    <Page>
      <PageHeader view="tasks" title="Tasks" subtitle="Every open task, for every client, in one list." />
      <PageBody>
        <form className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/30 p-2"
          onSubmit={(e) => { e.preventDefault(); if (title.trim()) add.mutate(); }}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a task" aria-label="New task"
            className={`${fieldClass} min-w-[12rem] flex-1`} />
          <select value={boardFor} onChange={(e) => setBoardFor(e.target.value ? Number(e.target.value) : '')} aria-label="Board"
            className={`${fieldClass} w-full sm:w-56`}>
            {boards.length === 0 && <option value="">No boards yet</option>}
            {boards.map((b) => <option key={b.id} value={b.id}>{b.folderName}, {b.name}</option>)}
          </select>
          <input type="date" value={dueFor} onChange={(e) => setDueFor(e.target.value)} aria-label="Due date" className={`${fieldClass} w-full sm:w-40`} />
          <button type="submit" disabled={!title.trim() || add.isPending} className={`${btnPrimary} inline-flex items-center gap-1.5`}><Plus size={14} /> Add</button>
        </form>

        <div className="mb-3 flex flex-wrap gap-1">
          {([['all', 'All', all.length], ['late', 'Late', counts.late], ['today', 'Today', counts.today], ['week', 'Next 7 days', counts.week], ['nodate', 'No date', counts.nodate]] as const).map(([k, label, n]) => (
            <button key={k} onClick={() => setDue(k)} aria-pressed={due === k} className={chip(due === k)}>
              {label}<span className={`num ml-1.5 text-xs ${k === 'late' && n ? 'text-red-300' : 'text-slate-500'}`}>{showDone ? '' : n}</span>
            </button>
          ))}
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-2">
          <label className="relative w-full sm:w-60">
            <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a task" aria-label="Find a task" className={`${fieldClass} pl-8`} />
          </label>
          <select value={client === 'all' ? '' : client} onChange={(e) => setClient(e.target.value ? Number(e.target.value) : 'all')} aria-label="Client" className={`${fieldClass} w-full sm:w-48`}>
            <option value="">Every client</option>
            {clients.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
          <select value={String(who)} aria-label="Who"
            onChange={(e) => { const v = e.target.value; setWho(v === 'anyone' || v === 'me' || v === 'nobody' ? v : Number(v)); }}
            className={`${fieldClass} w-full sm:w-44`}>
            <option value="anyone">Anyone</option>
            <option value="me">Mine</option>
            <option value="nobody">Nobody yet</option>
            {(people.data?.users ?? []).filter((u) => u.id !== user?.id).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          <button onClick={() => setUrgentOnly(!urgentOnly)} aria-pressed={urgentOnly} className={`${chip(urgentOnly)} inline-flex items-center gap-1`}><Flag size={13} /> High and urgent</button>
          <div className="ml-auto flex gap-1 rounded-lg bg-slate-900/60 p-1 text-sm">
            <button onClick={() => setGroup('due')} aria-pressed={group === 'due'} className={chip(group === 'due')}>By date</button>
            <button onClick={() => setGroup('client')} aria-pressed={group === 'client'} className={chip(group === 'client')}>By client</button>
          </div>
          <label className="flex items-center gap-1.5 text-sm text-slate-400">
            <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> Done
          </label>
        </div>

        {isLoading ? <Skeleton className="h-48" /> : shown.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-800 p-10 text-center text-sm text-slate-500">
            <ListChecks size={22} className="mx-auto mb-2 opacity-50" />
            {all.length === 0 ? (showDone ? 'Nothing finished in the last 30 days.' : 'No open tasks. Add one above.') : 'Nothing matches these filters.'}
          </div>
        ) : (
          <div className="space-y-5">
            {groups.map(([name, list]) => (
              <section key={name}>
                <h2 className={`mb-1.5 text-xs font-semibold uppercase tracking-wide ${name === 'Late' ? 'text-red-300' : 'text-slate-500'}`}>
                  {name} <span className="num font-normal text-slate-600">{list.length}</span>
                </h2>
                <ul className="overflow-hidden rounded-xl border border-slate-800">
                  {list.map((t) => {
                    const p = PRIORITY[t.priority];
                    const late = !t.isCompleted && t.dueDate && t.dueDate < today;
                    return (
                      <li key={t.id} className="flex items-center gap-3 border-b border-slate-800 bg-slate-900/30 px-3 py-2.5 last:border-b-0 hover:bg-slate-800/40">
                        <button onClick={() => toggle.mutate(t)} aria-label={t.isCompleted ? 'Open again' : 'Mark done'}
                          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-slate-500 hover:text-emerald-300">
                          {t.isCompleted ? <CheckCircle2 size={18} className="text-emerald-400" /> : <Circle size={18} />}
                        </button>
                        <button onClick={() => setOpen({ id: t.id, boardId: t.boardId })} className="min-w-0 flex-1 text-left">
                          <span className={`block truncate text-sm ${t.isCompleted ? 'text-slate-500 line-through' : 'text-slate-100'}`}>{t.title}</span>
                          <span className="block truncate text-xs text-slate-500">
                            {group === 'client' ? '' : `${t.folderName}, `}{t.boardName}{t.columnName ? `, ${t.columnName}` : ''}
                          </span>
                        </button>
                        <span className="hidden shrink-0 text-xs sm:block">
                          {p && <span className={`mr-2 ${p.cls}`}>{p.label}</span>}
                          {t.assignedTo && <span className="text-slate-400">{t.assignedTo === user?.id ? 'You' : userName.get(t.assignedTo) ?? ''}</span>}
                        </span>
                        <span className={`w-16 shrink-0 text-right text-xs ${late ? 'text-red-300' : 'text-slate-400'}`}>
                          {t.dueDate ? (t.dueDate === today ? 'Today' : say(t.dueDate)) : ''}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
      </PageBody>
      {open && <CardDetail taskId={open.id} boardId={open.boardId} onClose={() => { setOpen(null); refresh(); }} />}
    </Page>
  );
}
