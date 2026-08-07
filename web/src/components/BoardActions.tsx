import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, LayoutTemplate, X } from 'lucide-react';
import { apiGet, apiPost } from '../lib/api';
import type { Business, Folder as TFolder } from '../lib/types';

interface TemplateInfo { key: string; label: string; blurb: string; columns: string[]; cardCount: number }

/**
 * Copying a board, and starting one from a template.
 *
 * The same processes repeat across clients and across businesses, and rebuilding
 * them by hand loses a step every time. Both actions land in the same dialog
 * because they answer the same question: where should this board go.
 */
export function BoardActions({ boardId, boardName, onClose, onCreated }: {
  boardId: number | null;
  boardName?: string;
  onClose: () => void;
  onCreated: (newBoardId: number) => void;
}) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'copy' | 'template'>(boardId ? 'copy' : 'template');
  const [folderId, setFolderId] = useState<number | ''>('');
  const [name, setName] = useState('');
  const [templateKey, setTemplateKey] = useState('');
  const [includeCards, setIncludeCards] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const foldersQ = useQuery({ queryKey: ['folders'], queryFn: () => apiGet<{ folders: TFolder[] }>('/folders') });
  const bizQ = useQuery({ queryKey: ['businesses'], queryFn: () => apiGet<{ businesses: Business[] }>('/businesses') });
  const templatesQ = useQuery({
    queryKey: ['board-templates'],
    queryFn: () => apiGet<{ templates: TemplateInfo[] }>('/board-templates'),
    staleTime: 60 * 60 * 1000,
  });

  const bizName = new Map((bizQ.data?.businesses ?? []).map((b) => [b.id, b.name]));
  // Only folders you can actually write to appear, grouped by business so
  // "somewhere in the other company" is an obvious choice rather than a guess.
  const folders = (foldersQ.data?.folders ?? []).filter((f) => f.parentId === null);
  const grouped = [...new Map(folders.map((f) => [f.businessId ?? 0, [] as TFolder[]])).keys()]
    .map((bid) => ({ bid, name: bizName.get(bid) ?? 'Uncategorised', items: folders.filter((f) => (f.businessId ?? 0) === bid) }))
    .filter((g) => g.items.length > 0);

  const done = (r: { board: { id: number } }) => {
    qc.invalidateQueries({ queryKey: ['boards'] });
    qc.invalidateQueries({ queryKey: ['folders'] });
    onCreated(r.board.id);
  };

  const copy = useMutation({
    mutationFn: () => apiPost<{ board: { id: number } }>(`/boards/${boardId}/copy`, {
      targetFolderId: Number(folderId), name: name.trim() || undefined, includeCards,
    }),
    onSuccess: done,
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not copy the board.'),
  });
  const fromTemplate = useMutation({
    mutationFn: () => apiPost<{ board: { id: number } }>('/boards/from-template', {
      template: templateKey, folderId: Number(folderId), name: name.trim() || undefined,
    }),
    onSuccess: done,
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not create the board.'),
  });

  const busy = copy.isPending || fromTemplate.isPending;
  const canSubmit = folderId !== '' && (tab === 'copy' ? !!boardId : !!templateKey);
  const field = 'w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-[var(--accent)]';

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}
        className="flex max-h-[88vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-950">
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3">
          <h2 className="text-lg font-semibold text-slate-100">Add a board</h2>
          <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-800"><X size={16} /></button>
        </div>

        <div className="flex gap-1 border-b border-slate-800 px-4 pt-3">
          {boardId && (
            <button onClick={() => setTab('copy')}
              className={`flex items-center gap-1.5 rounded-t-lg px-3 py-2 text-sm font-medium ${tab === 'copy' ? 'bg-slate-900 text-slate-100' : 'text-slate-400 hover:text-slate-200'}`}>
              <Copy size={14} /> Copy this board
            </button>
          )}
          <button onClick={() => setTab('template')}
            className={`flex items-center gap-1.5 rounded-t-lg px-3 py-2 text-sm font-medium ${tab === 'template' ? 'bg-slate-900 text-slate-100' : 'text-slate-400 hover:text-slate-200'}`}>
            <LayoutTemplate size={14} /> From a template
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
          {tab === 'copy' ? (
            <>
              <p className="text-xs text-slate-500">
                Copies <span className="text-slate-300">{boardName}</span> with its columns
                {includeCards ? ' and cards' : ''}. Time tracked, comments, due dates and who a card was
                assigned to stay with the original, since those belong to that run of the work.
              </p>
              <label className="flex items-center gap-2 text-sm text-slate-300">
                <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]"
                  checked={includeCards} onChange={(e) => setIncludeCards(e.target.checked)} />
                Bring the cards across too
              </label>
            </>
          ) : (
            <div className="space-y-2">
              {(templatesQ.data?.templates ?? []).map((t) => (
                <button key={t.key} onClick={() => { setTemplateKey(t.key); if (!name.trim()) setName(''); }}
                  className={`w-full rounded-lg border p-3 text-left transition ${
                    templateKey === t.key ? 'border-[var(--accent)] bg-[var(--accent-quiet)]' : 'border-slate-700 hover:border-slate-600'}`}>
                  <div className="text-sm font-medium text-slate-100">{t.label}</div>
                  <div className="mt-0.5 text-[11px] text-slate-400">{t.blurb}</div>
                  <div className="mt-1 text-[10px] text-slate-500">{t.cardCount} cards, lanes: {t.columns.join(' / ')}</div>
                </button>
              ))}
            </div>
          )}

          <div>
            <label className="mb-1 block text-xs text-slate-400">Put it in</label>
            <select className={field} value={folderId} onChange={(e) => setFolderId(e.target.value ? Number(e.target.value) : '')}>
              <option value="">Choose a folder...</option>
              {grouped.map((g) => (
                <optgroup key={g.bid} label={g.name}>
                  {g.items.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </optgroup>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-xs text-slate-400">Name (optional)</label>
            <input className={field} value={name} onChange={(e) => setName(e.target.value)}
              placeholder={tab === 'copy' ? `${boardName} (copy)` : 'Uses the template name'} />
          </div>

          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>

        <div className="border-t border-slate-800 px-5 py-3">
          <button onClick={() => { setError(null); (tab === 'copy' ? copy : fromTemplate).mutate(); }}
            disabled={!canSubmit || busy}
            className="w-full rounded-lg bg-[var(--accent)] py-2 text-sm font-medium text-[var(--accent-ink)] hover:opacity-90 disabled:opacity-50">
            {busy ? 'Creating...' : tab === 'copy' ? 'Copy board' : 'Create board'}
          </button>
        </div>
      </div>
    </div>
  );
}
