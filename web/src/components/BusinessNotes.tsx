import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { X, Check } from 'lucide-react';
import { apiPatch } from '../lib/api';

/**
 * A per-business scratchpad: strategy, reminders, whatever the owner wants kept next
 * to the business. Autosaves shortly after typing stops, so it behaves like a notes
 * app rather than a form you have to remember to submit.
 */
export function BusinessNotes({ businessId, businessName, initial, onClose }: {
  businessId: number; businessName: string; initial: string; onClose: () => void;
}) {
  const qc = useQueryClient();
  const [text, setText] = useState(initial);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const dirty = text !== initial;

  const save = useMutation({
    mutationFn: (notes: string) => apiPatch(`/businesses/${businessId}`, { notes }),
    onSuccess: () => {
      setSavedAt(Date.now());
      qc.invalidateQueries({ queryKey: ['businesses'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });

  // Debounced autosave: save a second after the last keystroke.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(() => saveRef.current.mutate(text), 1000);
    return () => clearTimeout(t);
  }, [text, dirty]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const status = save.isPending ? 'Saving...'
    : dirty ? 'Unsaved'
      : savedAt ? 'Saved'
        : '';

  return (
    <Modal onClose={onClose} variant="panel">
      <div className="flex h-[70vh] max-h-[600px] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-950">
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-slate-100">{businessName}</h2>
            <p className="text-[11px] text-slate-500">Notes</p>
          </div>
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1 text-[11px] text-slate-500">
              {status === 'Saved' && <Check size={12} className="text-violet-300" />}{status}
            </span>
            <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-800"><X size={16} /></button>
          </div>
        </div>
        <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)}
          placeholder="Anything worth keeping next to this business: positioning, goals, the login you always forget, ideas for later."
          className="min-h-0 flex-1 resize-none bg-transparent px-5 py-4 text-sm leading-relaxed text-slate-100 placeholder-slate-600 outline-none" />
      </div>
    </Modal>
  );
}
