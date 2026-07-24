import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { X, Trash2, Plus, Check, Square, CheckSquare } from 'lucide-react';
import { apiGet, apiPatch, apiPost, apiDelete } from '../lib/api';
import type { Label, Priority, TaskDetail, TeamUser } from '../lib/types';
import { TimeSection } from './TimeSection';
import { FilesSection } from './FilesSection';
import { LabelsSection } from './LabelsSection';

const PRIORITIES: { value: Priority; label: string; color: string }[] = [
  { value: 'none', label: 'None', color: '#64748b' },
  { value: 'low', label: 'Low', color: '#64748b' },
  { value: 'medium', label: 'Medium', color: '#eab308' },
  { value: 'high', label: 'High', color: '#f97316' },
  { value: 'urgent', label: 'Urgent', color: '#ef4444' },
];

export function CardDetail({ taskId, boardId, onClose }: { taskId: number; boardId: number; onClose: () => void }) {
  const qc = useQueryClient();
  const key = ['task', taskId, 'detail'];
  const { data } = useQuery({ queryKey: key, queryFn: () => apiGet<TaskDetail>(`/tasks/${taskId}/detail`) });
  const { data: usersData } = useQuery({ queryKey: ['users'], queryFn: () => apiGet<{ users: TeamUser[] }>('/users') });

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [newSub, setNewSub] = useState('');
  const [newComment, setNewComment] = useState('');

  useEffect(() => {
    if (data) { setTitle(data.task.title); setDescription(data.task.description ?? ''); }
  }, [data?.task.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: key });
    qc.invalidateQueries({ queryKey: ['board', boardId] });
  };
  const patchTask = useMutation({ mutationFn: (v: Record<string, unknown>) => apiPatch(`/tasks/${taskId}`, v), onSuccess: invalidate });
  const addSub = useMutation({ mutationFn: (t: string) => apiPost('/subtasks', { taskId, title: t }), onSuccess: () => { setNewSub(''); invalidate(); } });
  const toggleSub = useMutation({ mutationFn: (v: { id: number; isCompleted: boolean }) => apiPatch(`/subtasks/${v.id}`, { isCompleted: v.isCompleted }), onSuccess: invalidate });
  const delSub = useMutation({ mutationFn: (id: number) => apiDelete(`/subtasks/${id}`), onSuccess: invalidate });
  const addComment = useMutation({ mutationFn: (c: string) => apiPost('/comments', { taskId, comment: c }), onSuccess: () => { setNewComment(''); invalidate(); } });
  const delTask = useMutation({ mutationFn: () => apiDelete(`/tasks/${taskId}`), onSuccess: () => { qc.invalidateQueries({ queryKey: ['board', boardId] }); onClose(); } });

  const t = data?.task;
  const doneSubs = data?.subtasks.filter((s) => s.isCompleted).length ?? 0;

  const field = 'w-full rounded-lg bg-slate-900/70 border border-slate-700 px-3 py-2 text-sm text-slate-100 outline-none focus:border-violet-500';

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/50" onClick={onClose}>
      <div className="flex h-full w-full max-w-md flex-col border-l border-slate-800 bg-slate-950" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
          <div className="flex items-center gap-2">
            <button onClick={() => t && patchTask.mutate({ isCompleted: !t.isCompleted })}
              className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs ${t?.isCompleted ? 'bg-green-600/20 text-green-300' : 'border border-slate-700 text-slate-300 hover:bg-slate-800'}`}>
              <Check size={13} /> {t?.isCompleted ? 'Completed' : 'Mark done'}
            </button>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={() => { if (confirm('Delete this card?')) delTask.mutate(); }}
              className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-red-500/10 hover:text-red-400"><Trash2 size={15} /></button>
            <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-800"><X size={16} /></button>
          </div>
        </div>

        {!data ? <div className="p-6 text-sm text-slate-500">Loading...</div> : (
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
            <input className={field + ' text-base font-medium'} value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => title.trim() && title !== t?.title && patchTask.mutate({ title: title.trim() })} />

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs text-slate-500">Priority</label>
                <select className={field} value={t?.priority}
                  onChange={(e) => patchTask.mutate({ priority: e.target.value })}>
                  {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-500">Due date</label>
                <input type="date" className={field} value={t?.dueDate ?? ''}
                  onChange={(e) => patchTask.mutate({ dueDate: e.target.value || null })} />
              </div>
            </div>

            <div>
              <label className="mb-1 block text-xs text-slate-500">Repeats</label>
              <select className={field} value={t?.recurrence ?? 'none'}
                onChange={(e) => patchTask.mutate({ recurrence: e.target.value })}>
                <option value="none">Does not repeat</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="biweekly">Every 2 weeks</option>
                <option value="monthly">Monthly</option>
              </select>
              {t?.recurrence && t.recurrence !== 'none' && (
                <p className="mt-1 text-[11px] text-slate-500">
                  {t.dueDate
                    ? 'When you mark this done, the next one is created automatically.'
                    : 'Set a due date so the next one knows when to land.'}
                </p>
              )}
            </div>

            <div>
              <label className="mb-1 block text-xs text-slate-500">Assignee</label>
              <select className={field} value={t?.assignedTo ?? ''}
                onChange={(e) => patchTask.mutate({ assignedTo: e.target.value ? Number(e.target.value) : null })}>
                <option value="">Unassigned</option>
                {(usersData?.users ?? []).filter((u) => u.isActive).map((u) => (
                  <option key={u.id} value={u.id}>{u.name}</option>
                ))}
              </select>
            </div>

            <LabelsSection taskId={taskId} boardId={boardId} current={data.labels as Label[]} />

            <div>
              <label className="mb-1 block text-xs text-slate-500">Description</label>
              <textarea className={field + ' min-h-24 resize-y'} value={description}
                onChange={(e) => setDescription(e.target.value)}
                onBlur={() => description !== (t?.description ?? '') && patchTask.mutate({ description: description || null })}
                placeholder="Add more detail..." />
            </div>

            {/* Subtasks */}
            <div>
              <div className="mb-2 flex items-center justify-between">
                <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">Subtasks</label>
                {data.subtasks.length > 0 && <span className="text-xs text-slate-500">{doneSubs}/{data.subtasks.length}</span>}
              </div>
              <div className="space-y-1">
                {data.subtasks.map((s) => (
                  <div key={s.id} className="group flex items-center gap-2 rounded-md px-1 py-1 hover:bg-slate-900">
                    <button onClick={() => toggleSub.mutate({ id: s.id, isCompleted: !s.isCompleted })} className="text-slate-400 hover:text-violet-400">
                      {s.isCompleted ? <CheckSquare size={16} className="text-violet-400" /> : <Square size={16} />}
                    </button>
                    <span className={`flex-1 text-sm ${s.isCompleted ? 'text-slate-500 line-through' : 'text-slate-200'}`}>{s.title}</span>
                    <button onClick={() => delSub.mutate(s.id)} className="hidden text-slate-500 hover:text-red-400 group-hover:block"><Trash2 size={13} /></button>
                  </div>
                ))}
              </div>
              <div className="mt-2 flex gap-2">
                <input className={field} placeholder="Add a subtask..." value={newSub}
                  onChange={(e) => setNewSub(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && newSub.trim()) addSub.mutate(newSub.trim()); }} />
                <button onClick={() => newSub.trim() && addSub.mutate(newSub.trim())}
                  className="grid w-9 shrink-0 place-items-center rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700"><Plus size={16} /></button>
              </div>
            </div>

            <TimeSection taskId={taskId} />

            <FilesSection taskId={taskId} />

            {/* Comments */}
            <div>
              <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-slate-500">Comments</label>
              <div className="flex gap-2">
                <textarea className={field + ' min-h-16 resize-y'} placeholder="Write a comment..." value={newComment}
                  onChange={(e) => setNewComment(e.target.value)} />
              </div>
              <button onClick={() => newComment.trim() && addComment.mutate(newComment.trim())}
                className="mt-1 rounded-lg bg-violet-600 px-3 py-1.5 text-xs text-white hover:bg-violet-500">Comment</button>
              <div className="mt-3 space-y-3">
                {data.comments.map((c) => (
                  <div key={c.id} className="text-sm">
                    <div className="flex items-baseline gap-2">
                      <span className="font-medium text-slate-200">{c.authorName ?? 'Someone'}</span>
                      <span className="text-[11px] text-slate-500">{new Date(c.createdAt).toLocaleString()}</span>
                    </div>
                    <p className="whitespace-pre-wrap text-slate-300">{c.comment}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
