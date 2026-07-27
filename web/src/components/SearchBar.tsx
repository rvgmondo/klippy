import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { apiGet } from '../lib/api';
import type { Priority, SearchResult } from '../lib/types';
import { CardDetail } from './CardDetail';

const PRIORITY_COLOR: Record<Priority, string> = {
  none: '#6366f1', low: '#64748b', medium: '#eab308', high: '#f97316', urgent: '#ef4444',
};

export function SearchBar() {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  const [openTask, setOpenTask] = useState<{ id: number; boardId: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 200); return () => clearTimeout(t); }, [q]);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const { data } = useQuery({
    queryKey: ['search', debounced],
    queryFn: () => apiGet<{ tasks: SearchResult[] }>(`/search?q=${encodeURIComponent(debounced)}`),
    enabled: debounced.length > 0,
  });
  const results = data?.tasks ?? [];

  return (
    <div ref={ref} className="relative w-full">
      <Search size={14} className="pointer-events-none absolute left-3 top-2.5 text-slate-500" />
      <input value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)}
        placeholder="Search cards..."
        className="w-full rounded-lg border border-slate-700 bg-slate-900 py-2 pl-8 pr-3 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-violet-500" />

      {open && debounced.length > 0 && (
        <div className="absolute z-40 mt-1 max-h-96 w-full overflow-y-auto rounded-lg border border-slate-700 bg-slate-900 py-1 shadow-xl">
          {results.length === 0 && <div className="px-3 py-3 text-xs text-slate-500">No matches.</div>}
          {results.map((r) => (
            <button key={r.id} onClick={() => { setOpenTask({ id: r.id, boardId: r.boardId }); setOpen(false); }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-slate-800">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: PRIORITY_COLOR[r.priority] }} />
              <span className="min-w-0 flex-1">
                <span className={`block truncate text-sm ${r.isCompleted ? 'text-slate-500 line-through' : 'text-slate-200'}`}>{r.title}</span>
                <span className="block truncate text-[11px] text-slate-500">{r.folderName} / {r.boardName}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {openTask && <CardDetail taskId={openTask.id} boardId={openTask.boardId} onClose={() => setOpenTask(null)} />}
    </div>
  );
}
