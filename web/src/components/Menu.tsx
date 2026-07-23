import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface MenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
}

/** Lightweight click-to-open dropdown. Closes on outside click or Escape. */
export function Menu({ trigger, items, align = 'right' }: { trigger: ReactNode; items: MenuItem[]; align?: 'left' | 'right' }) {
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
    <div ref={ref} className="relative">
      <button onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }} className="flex items-center">
        {trigger}
      </button>
      {open && (
        <div className={`absolute z-30 mt-1 min-w-36 overflow-hidden rounded-lg border border-slate-700 bg-slate-900 py-1 shadow-xl ${align === 'right' ? 'right-0' : 'left-0'}`}>
          {items.map((it, i) => (
            <button key={i}
              onClick={(e) => { e.stopPropagation(); setOpen(false); it.onClick(); }}
              className={`block w-full px-3 py-1.5 text-left text-xs ${it.danger ? 'text-red-400 hover:bg-red-500/10' : 'text-slate-200 hover:bg-slate-800'}`}>
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
