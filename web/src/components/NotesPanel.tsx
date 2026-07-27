import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Copy, Check, Lightbulb, Bug, Wrench, HelpCircle } from 'lucide-react';
import { apiGet, apiPost, apiPatch, apiDelete } from '../lib/api';

type Kind = 'idea' | 'bug' | 'improvement' | 'question';
type Status = 'open' | 'planned' | 'done' | 'dropped';
type Priority = 'low' | 'medium' | 'high';

interface Note {
  id: number; title: string; body: string | null;
  kind: Kind; status: Status; priority: Priority;
  createdAt: string; authorName: string | null;
}

const KIND_ICON: Record<Kind, React.ReactNode> = {
  idea: <Lightbulb size={14} className="text-amber-400" />,
  bug: <Bug size={14} className="text-red-400" />,
  improvement: <Wrench size={14} className="text-blue-400" />,
  question: <HelpCircle size={14} className="text-violet-400" />,
};
const STATUS_COLOR: Record<Status, string> = {
  open: 'text-slate-300', planned: 'text-blue-300', done: 'text-green-400', dropped: 'text-slate-600 line-through',
};

export function NotesPanel() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['notes'], queryFn: () => apiGet<{ notes: Note[] }>('/notes') });
  const notes = data?.notes ?? [];
  const invalidate = () => qc.invalidateQueries({ queryKey: ['notes'] });

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [kind, setKind] = useState<Kind>('idea');
  const [priority, setPriority] = useState<Priority>('medium');
  const [copied, setCopied] = useState(false);
  const [showDone, setShowDone] = useState(false);

  const add = useMutation({
    mutationFn: () => apiPost('/notes', { title: title.trim(), body: body.trim() || null, kind, priority }),
    onSuccess: () => { setTitle(''); setBody(''); invalidate(); },
  });
  const patch = useMutation({
    mutationFn: (v: { id: number; body: Record<string, unknown> }) => apiPatch(`/notes/${v.id}`, v.body),
    onSuccess: invalidate,
  });
  const del = useMutation({ mutationFn: (id: number) => apiDelete(`/notes/${id}`), onSuccess: invalidate });

  async function copyAll() {
    // Grab the same markdown the server produces for handover.
    const res = await fetch('/api/v1/notes/export?all=false', { credentials: 'same-origin' });
    const text = await res.text();
    await navigator.clipboard?.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const field = 'w-full rounded-lg bg-slate-900/70 border border-slate-700 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-violet-500';
  const visible = notes.filter((n) => showDone || (n.status !== 'done' && n.status !== 'dropped'));

  return (
    <div className="space-y-4">
      <p className="text-xs text-slate-500">
        Jot down anything you want changed or added, whenever it occurs to you. When you are
        ready, hit <span className="text-slate-300">Copy all</span> and paste the whole list
        over in one go.
      </p>

      {/* New note */}
      <div className="space-y-2 rounded-xl border border-slate-800 bg-slate-900/40 p-3">
        <input className={field} placeholder="What should change or get added?" value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && title.trim()) add.mutate(); }} />
        <textarea className={field + ' min-h-16 resize-y'} placeholder="Any detail (optional)"
          value={body} onChange={(e) => setBody(e.target.value)} />
        <div className="flex flex-wrap items-center gap-2">
          <select className={field + ' w-auto'} value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            <option value="idea">Idea</option>
            <option value="improvement">Improvement</option>
            <option value="bug">Bug</option>
            <option value="question">Question</option>
          </select>
          <select className={field + ' w-auto'} value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
          <button onClick={() => title.trim() && add.mutate()} disabled={!title.trim()}
            className="ml-auto flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-2 text-xs font-medium text-white hover:bg-violet-500 disabled:opacity-60">
            <Plus size={14} /> Add note
          </button>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button onClick={copyAll}
          className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800">
          {copied ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy all (for handover)</>}
        </button>
        <label className="flex items-center gap-1.5 text-xs text-slate-400">
          <input type="checkbox" className="h-3.5 w-3.5 accent-violet-600" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />
          Show done / dropped
        </label>
        <span className="ml-auto text-xs text-slate-500">{visible.length} shown</span>
      </div>

      {/* List */}
      <div className="space-y-2">
        {visible.length === 0 && <p className="py-6 text-center text-sm text-slate-500">No notes yet.</p>}
        {visible.map((n) => (
          <div key={n.id} className="group rounded-xl border border-slate-800 p-3">
            <div className="flex items-start gap-2">
              <span className="mt-0.5 shrink-0">{KIND_ICON[n.kind]}</span>
              <div className="min-w-0 flex-1">
                <div className={`text-sm font-medium ${STATUS_COLOR[n.status]}`}>{n.title}</div>
                {n.body && <p className="mt-0.5 whitespace-pre-wrap text-xs text-slate-400">{n.body}</p>}
                <div className="mt-1 text-[11px] text-slate-600">
                  {n.priority} priority, {n.authorName ?? 'someone'}, {new Date(n.createdAt).toLocaleDateString()}
                </div>
              </div>
              <select value={n.status} onChange={(e) => patch.mutate({ id: n.id, body: { status: e.target.value } })}
                className="shrink-0 rounded-md border border-slate-700 bg-slate-900 px-1.5 py-1 text-[11px] text-slate-300">
                <option value="open">Open</option>
                <option value="planned">Planned</option>
                <option value="done">Done</option>
                <option value="dropped">Dropped</option>
              </select>
              <button onClick={() => { if (confirm('Delete this note?')) del.mutate(n.id); }}
                className="shrink-0 text-slate-600 hover:text-red-400"><Trash2 size={14} /></button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
