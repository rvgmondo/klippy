import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { apiGet, apiPost } from '../lib/api';
import type { Board, BoardFull, Folder, Priority } from '../lib/types';

/**
 * Create a card from the calendar: pick a board, we drop it in that board's
 * first column with the clicked date as the due date.
 */
export function QuickAddTask({ dueDate, onClose }: { dueDate: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<Priority>('none');
  const [boardId, setBoardId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load the folder tree, then every folder's boards, so the picker is flat and simple.
  const folders = useQuery({ queryKey: ['folders'], queryFn: () => apiGet<{ folders: Folder[] }>('/folders') });
  const folderIds = (folders.data?.folders ?? []).map((f) => f.id);
  const boards = useQuery({
    queryKey: ['all-boards', folderIds.join(',')],
    enabled: folderIds.length > 0,
    queryFn: async () => {
      const lists = await Promise.all(
        folderIds.map((id) =>
          apiGet<{ boards: Board[] }>(`/boards?folderId=${id}`).then((r) => r.boards).catch(() => [] as Board[]),
        ),
      );
      return lists.flat();
    },
  });

  useEffect(() => {
    if (boardId === null && boards.data && boards.data.length > 0) setBoardId(boards.data[0]!.id);
  }, [boards.data, boardId]);

  const create = useMutation({
    mutationFn: async () => {
      if (!boardId) throw new Error('Pick a board first.');
      // First column of that board is where new cards land.
      const full = await apiGet<BoardFull>(`/boards/${boardId}/full`);
      const firstCol = full.columns[0];
      if (!firstCol) throw new Error('That board has no columns yet.');
      return apiPost('/tasks', { boardId, columnId: firstCol.id, title: title.trim(), priority, dueDate });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['calendar'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      if (boardId) qc.invalidateQueries({ queryKey: ['board', boardId] });
      onClose();
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not create the card.'),
  });

  const field = 'w-full rounded-lg bg-slate-900/70 border border-slate-700 px-3 py-2.5 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-violet-500';
  const noBoards = boards.isFetched && (boards.data?.length ?? 0) === 0;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl border border-slate-700 bg-slate-950 p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-white">New card for {dueDate}</h3>
          <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-800"><X size={16} /></button>
        </div>

        {noBoards ? (
          <p className="text-sm text-slate-400">Create a board first, then you can add cards from the calendar.</p>
        ) : (
          <div className="space-y-3">
            <input autoFocus className={field} placeholder="What needs doing?" value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && title.trim()) create.mutate(); }} />

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs text-slate-500">Board</label>
                <select className={field} value={boardId ?? ''} onChange={(e) => setBoardId(Number(e.target.value))}>
                  {(boards.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-500">Priority</label>
                <select className={field} value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
                  {(['none', 'low', 'medium', 'high', 'urgent'] as Priority[]).map((p) => (
                    <option key={p} value={p}>{p === 'none' ? 'None' : p[0]!.toUpperCase() + p.slice(1)}</option>
                  ))}
                </select>
              </div>
            </div>

            {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</div>}

            <button onClick={() => title.trim() && create.mutate()} disabled={!title.trim() || create.isPending}
              className="w-full rounded-lg bg-violet-600 py-2.5 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-60">
              {create.isPending ? 'Adding...' : 'Add card'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
