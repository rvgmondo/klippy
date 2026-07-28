import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Trash2 } from 'lucide-react';

export interface MenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
  /** If set, a small trash icon is shown at the right of the row that calls this instead of onClick. */
  onDelete?: () => void;
}

/** Lightweight click-to-open dropdown. Closes on outside click or Escape. */
export function Menu({ trigger, items, align = 'right', fullWidth }: { trigger: ReactNode; items: MenuItem[]; align?: 'left' | 'right'; fullWidth?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <div ref={ref} className={`relative ${fullWidth ? 'w-full' : ''}`}>
      <button onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }} className={`flex items-center ${fullWidth ? 'w-full' : ''}`}>
        {trigger}
      </button>
      {open && (
        <div className={`absolute z-30 mt-1 min-w-36 overflow-hidden rounded-lg border border-slate-700 bg-slate-900 py-1 shadow-xl ${align === 'right' ? 'right-0' : 'left-0'}`}>
          {items.map((it, i) => (
            <div key={i} className="group flex items-center">
              <button
                onClick={(e) => { e.stopPropagation(); setOpen(false); it.onClick(); }}
                className={`block flex-1 truncate px-3 py-1.5 text-left text-xs ${it.danger ? 'text-red-400 hover:bg-red-500/10' : 'text-slate-200 hover:bg-slate-800'}`}>
                {it.label}
              </button>
              {it.onDelete && (
                <button
                  onClick={(e) => { e.stopPropagation(); it.onDelete!(); }}
                  title="Delete"
                  className="mr-1.5 shrink-0 rounded p-1 text-slate-500 opacity-0 hover:bg-red-500/10 hover:text-red-400 group-hover:opacity-100">
                  <Trash2 size={12} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
