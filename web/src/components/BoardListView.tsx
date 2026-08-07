import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Circle, Plus } from 'lucide-react';
import { useState } from 'react';
import { apiPost, apiPatch } from '../lib/api';

interface Column { id: number; name: string; color: string; isDoneColumn: boolean; position: number }
interface Task {
  id: number; title: string; columnId: number; position: number;
  dueDate: string | null; priority: string; isCompleted: boolean;
  assignedTo: number | null; estimateMinutes: number | null;
}
interface CardLabel { id: number; name: string; color: string }
interface TeamUser { id: number; name: string }

const PRIORITY_COLOR: Record<string, string> = {
  none: 'transparent', low: '#64748b', medium: '#3b82f6', high: '#f59e0b', urgent: '#ef4444',
};

/**
 * The same board as a list.
 *
 * A kanban asks you to think in columns and to drag things around to say what is
 * happening. That is a lot of ceremony when the honest question is "what is on this
 * client, and what is late". This view is the same cards, grouped by column, as
 * plain rows you can tick off, with the due date and who has it in line. Nothing
 * new to learn, and the board is still there for anyone who prefers it.
 */
export function BoardListView({ boardId, columns, tasks, labelsByTask, userMap, onOpen }: {
  boardId: number;
  columns: Column[];
  tasks: Task[];
  labelsByTask: Map<number, CardLabel[]>;
  userMap: Map<number, TeamUser>;
  onOpen: (id: number) => void;
}) {
  const qc = useQueryClient();
  const today = new Date().toISOString().slice(0, 10);
  const invalidate = () => qc.invalidateQueries({ queryKey: ['board', boardId] });

  const toggle = useMutation({
    mutationFn: (v: { id: number; isCompleted: boolean }) => apiPatch(`/tasks/${v.id}`, { isCompleted: v.isCompleted }),
    onSuccess: invalidate,
  });

  return (
    <div className="mx-auto max-w-4xl space-y-5 p-4 sm:p-6">
      {columns.map((col) => {
        const rows = tasks.filter((t) => t.columnId === col.id).sort((a, b) => a.position - b.position);
        return (
          <section key={col.id}>
            <div className="mb-1.5 flex items-center gap-2 px-1">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: col.color }} />
              <h3 className="text-sm font-semibold text-slate-200">{col.name}</h3>
              <span className="text-[11px] text-slate-500">{rows.length}</span>
            </div>

            <div className="overflow-hidden rounded-xl border border-slate-800">
              {rows.length === 0 && (
                <p className="px-3 py-4 text-center text-[11px] text-slate-500">Nothing here.</p>
              )}
              {rows.map((t) => {
                const overdue = t.dueDate && t.dueDate < today && !t.isCompleted;
                const labels = labelsByTask.get(t.id) ?? [];
                return (
                  <div key={t.id}
                    className="flex items-center gap-2.5 border-b border-slate-800/60 px-2 py-2.5 last:border-0 hover:bg-slate-800/30 sm:px-3">
                    {/* Ticking a row off is the whole point of a list. */}
                    <button
                      onClick={() => toggle.mutate({ id: t.id, isCompleted: !t.isCompleted })}
                      title={t.isCompleted ? 'Mark as not done' : 'Mark as done'}
                      className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-slate-500 hover:bg-slate-700/50 hover:text-slate-200">
                      {t.isCompleted
                        ? <Check size={15} className="text-green-400" />
                        : <Circle size={15} />}
                    </button>

                    {t.priority !== 'none' && (
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: PRIORITY_COLOR[t.priority] }} title={t.priority} />
                    )}

                    <button onClick={() => onOpen(t.id)} className="min-w-0 flex-1 text-left">
                      <div className={`truncate text-sm ${t.isCompleted ? 'text-slate-500 line-through' : 'text-slate-200'}`}>
                        {t.title}
                      </div>
                      {labels.length > 0 && (
                        <div className="mt-0.5 flex flex-wrap gap-1">
                          {labels.map((l) => (
                            <span key={l.id} className="rounded px-1.5 py-px text-[10px]"
                              style={{ background: `${l.color}22`, color: l.color }}>{l.name}</span>
                          ))}
                        </div>
                      )}
                    </button>

                    {t.dueDate && (
                      <span className={`num shrink-0 text-[11px] ${overdue ? 'text-red-300' : 'text-slate-500'}`}>
                        {t.dueDate.slice(5)}
                      </span>
                    )}
                    {t.assignedTo && userMap.get(t.assignedTo) && (
                      <span title={userMap.get(t.assignedTo)!.name}
                        className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-slate-700 text-[10px] font-medium text-slate-200">
                        {userMap.get(t.assignedTo)!.name[0]?.toUpperCase()}
                      </span>
                    )}
                  </div>
                );
              })}
              <QuickAdd boardId={boardId} columnId={col.id} onAdded={invalidate} />
            </div>
          </section>
        );
      })}
    </div>
  );
}

/** Add a card without leaving the list or opening anything. */
function QuickAdd({ boardId, columnId, onAdded }: { boardId: number; columnId: number; onAdded: () => void }) {
  const [title, setTitle] = useState('');
  const add = useMutation({
    mutationFn: (t: string) => apiPost('/tasks', { boardId, columnId, title: t }),
    onSuccess: () => { setTitle(''); onAdded(); },
  });
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); if (title.trim()) add.mutate(title.trim()); }}
      className="flex items-center gap-2 border-t border-slate-800/60 px-2 py-1.5 sm:px-3">
      <Plus size={14} className="shrink-0 text-slate-600" />
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a card"
        className="min-w-0 flex-1 bg-transparent py-1 text-sm text-slate-200 placeholder-slate-600 outline-none" />
      {title.trim() && (
        <button type="submit" disabled={add.isPending}
          className="shrink-0 rounded-md bg-[var(--accent)] px-2 py-1 text-[11px] font-medium text-[var(--accent-ink)] disabled:opacity-60">
          Add
        </button>
      )}
    </form>
  );
}
