import { useQuery } from '@tanstack/react-query';
import { Filter, X } from 'lucide-react';
import { apiGet } from '../lib/api';
import type { Priority, Task } from '../lib/types';

export interface FilterState {
  assignee: number | 'any';
  priority: Priority | 'any';
  due: 'any' | 'overdue' | 'today' | 'week' | 'none';
  /** Words in the card's title or description. */
  text?: string;
}

export const EMPTY_FILTERS: FilterState = { assignee: 'any', priority: 'any', due: 'any', text: '' };
export const isFiltering = (f: FilterState) =>
  f.assignee !== 'any' || f.priority !== 'any' || f.due !== 'any' || !!f.text?.trim();

// The local date, not UTC: between midnight and 2am in South Africa the UTC date
// is still yesterday, so "due today" showed yesterday's cards.
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Apply the active filters to a board's cards. */
export function applyFilters(tasks: Task[], f: FilterState): Task[] {
  const today = iso(new Date());
  const weekAhead = iso(new Date(Date.now() + 7 * 86400000));
  const words = (f.text ?? '').trim().toLowerCase();
  return tasks.filter((t) => {
    if (words && !`${t.title} ${t.description ?? ''}`.toLowerCase().includes(words)) return false;
    if (f.assignee !== 'any' && t.assignedTo !== f.assignee) return false;
    if (f.priority !== 'any' && t.priority !== f.priority) return false;
    if (f.due !== 'any') {
      if (f.due === 'none') return !t.dueDate;
      if (!t.dueDate) return false;
      if (f.due === 'overdue' && !(t.dueDate < today)) return false;
      if (f.due === 'today' && t.dueDate !== today) return false;
      if (f.due === 'week' && !(t.dueDate >= today && t.dueDate <= weekAhead)) return false;
    }
    return true;
  });
}

export function BoardFilters({ value, onChange }: { value: FilterState; onChange: (f: FilterState) => void }) {
  const people = useQuery({
    queryKey: ['users'],
    queryFn: () => apiGet<{ users: { id: number; name: string; isActive: boolean }[] }>('/users'),
  });

  const sel = 'rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-violet-500';

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="flex items-center gap-1 text-xs text-slate-500"><Filter size={13} /> Filter</span>

      <input className={`${sel} w-40`} value={value.text ?? ''} placeholder="Find a card" aria-label="Find a card"
        onChange={(e) => onChange({ ...value, text: e.target.value })} />

      <select className={sel} value={String(value.assignee)}
        onChange={(e) => onChange({ ...value, assignee: e.target.value === 'any' ? 'any' : Number(e.target.value) })}>
        <option value="any">Anyone</option>
        {(people.data?.users ?? []).filter((u) => u.isActive).map((u) => (
          <option key={u.id} value={u.id}>{u.name}</option>
        ))}
      </select>

      <select className={sel} value={value.priority}
        onChange={(e) => onChange({ ...value, priority: e.target.value as FilterState['priority'] })}>
        <option value="any">Any priority</option>
        <option value="urgent">Urgent</option>
        <option value="high">High</option>
        <option value="medium">Medium</option>
        <option value="low">Low</option>
        <option value="none">No priority</option>
      </select>

      <select className={sel} value={value.due}
        onChange={(e) => onChange({ ...value, due: e.target.value as FilterState['due'] })}>
        <option value="any">Any date</option>
        <option value="overdue">Overdue</option>
        <option value="today">Due today</option>
        <option value="week">Next 7 days</option>
        <option value="none">No due date</option>
      </select>

      {isFiltering(value) && (
        <button onClick={() => onChange(EMPTY_FILTERS)}
          className="flex items-center gap-1 rounded-lg border border-slate-700 px-2 py-1.5 text-xs text-slate-300 hover:bg-slate-800">
          <X size={12} /> Clear
        </button>
      )}
    </div>
  );
}
