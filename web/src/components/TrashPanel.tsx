import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2, RotateCcw, Folder, LayoutGrid } from 'lucide-react';
import { apiGet, apiPost } from '../lib/api';
import { confirmDialog, notify } from './ConfirmDialog';
import { Skeleton } from './ui';

interface TrashItem {
  kind: 'folder' | 'board';
  id: number;
  name: string;
  /** For a board: the client it belongs to. */
  detail: string | null;
  deletedAt: string;
  daysLeft: number;
}

/**
 * The Trash. Deleting a client or a board no longer destroys it: it lands here,
 * restorable with everything intact (subfolders, boards, cards, time) for 30
 * days, after which the nightly housekeeping hard-deletes it. Restore undoes
 * exactly the delete that put it here; purge is the old permanent delete, now
 * demanding a second, honest confirmation.
 */
export function TrashPanel() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['trash'],
    queryFn: () => apiGet<{ items: TrashItem[] }>('/trash'),
  });

  const restore = useMutation({
    mutationFn: (i: TrashItem) => apiPost('/trash/restore', { kind: i.kind, id: i.id }),
    onSuccess: (_r, i) => {
      qc.invalidateQueries();
      notify(`"${i.name}" is back.`);
    },
    onError: (e) => notify(e instanceof Error ? e.message : 'Could not restore.', 'error'),
  });
  const purge = useMutation({
    mutationFn: (i: TrashItem) => apiPost('/trash/purge', { kind: i.kind, id: i.id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['trash'] }),
    onError: (e) => notify(e instanceof Error ? e.message : 'Could not delete.', 'error'),
  });

  const askPurge = async (i: TrashItem) => {
    const yes = await confirmDialog(
      i.kind === 'folder'
        ? `Delete "${i.name}" forever? This permanently deletes the client with every subfolder, board, card and time entry under it, their recurring subscriptions and their portal login. Invoices and payments are kept. There is no undo after this one.`
        : `Delete "${i.name}" forever? This permanently deletes the board with every card and time entry on it. There is no undo after this one.`,
      { confirmLabel: 'Delete forever', danger: true },
    );
    if (yes) purge.mutate(i);
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-slate-500">
        Deleted clients and boards wait here for 30 days, then delete themselves for good.
        Restoring brings back everything that was deleted with them.
      </p>

      {isLoading && <Skeleton className="h-20" />}

      {data && data.items.length === 0 && (
        <div className="rounded-xl border border-dashed border-slate-700 p-8 text-center text-sm text-slate-400">
          The trash is empty.
        </div>
      )}

      {data && data.items.length > 0 && (
        <div className="divide-y divide-slate-800 overflow-hidden rounded-xl border border-slate-800">
          {data.items.map((i) => (
            <div key={`${i.kind}-${i.id}`} className="flex items-center gap-3 px-4 py-3">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-slate-800/80 text-slate-400">
                {i.kind === 'folder' ? <Folder size={15} /> : <LayoutGrid size={15} />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-slate-200">{i.name}</div>
                <div className="text-[11px] text-slate-500">
                  {i.kind === 'folder' ? 'Client' : `Board${i.detail ? ` in ${i.detail}` : ''}`}
                  {' '}deleted {i.deletedAt.slice(0, 10)}
                  {', '}
                  <span className={i.daysLeft <= 5 ? 'text-amber-400' : ''}>
                    {i.daysLeft === 0 ? 'gone tonight' : `${i.daysLeft} day${i.daysLeft === 1 ? '' : 's'} left`}
                  </span>
                </div>
              </div>
              <button onClick={() => restore.mutate(i)} disabled={restore.isPending}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-50">
                <RotateCcw size={12} /> Restore
              </button>
              <button onClick={() => askPurge(i)} disabled={purge.isPending}
                title="Delete forever, right now"
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-red-500/30 px-2.5 py-1.5 text-xs text-red-300 hover:bg-red-500/10 disabled:opacity-50">
                <Trash2 size={12} /> Delete forever
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
