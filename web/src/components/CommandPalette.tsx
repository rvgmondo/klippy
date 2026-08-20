import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Home, Target, Wallet, Settings, Users, Receipt, Package,
  CalendarDays, CalendarCheck, BarChart3, HardDrive, AlertTriangle,
  Plus, Building2, SquareKanban, FileText, Search, type LucideIcon,
} from 'lucide-react';
import { apiGet } from '../lib/api';
import { setUrlParams } from '../lib/urlAction';
import type { Business } from '../lib/types';
import type { BusinessSelection } from './BusinessSwitcher';

/**
 * The connective shell: everything is one keystroke away.
 *
 * Klippy's modules share one datastore, but until now nothing let you MOVE like
 * they do: search knew only kanban cards, and jumping or creating across modules
 * meant walking the sidebar. Cmd/Ctrl-K opens this: type to find any client, card,
 * deal, invoice, contact or offering; or run a command to jump to a screen, create
 * across modules, or switch business. This is the single cheapest thing that makes
 * shared objects feel like one memory.
 */

interface SearchResults {
  tasks: { id: number; title: string; boardId: number; boardName: string | null; folderName: string | null }[];
  clients: { id: number; name: string; boardId: number | null }[];
  deals: { id: number; title: string; company: string | null; stage: string }[];
  contacts: { id: number; name: string; company: string | null }[];
  documents: { id: number; number: string; type: string; clientName: string; status: string }[];
  offerings: { id: number; name: string; recurring: boolean }[];
}

interface Entry { key: string; group: string; label: string; sub?: string; icon: LucideIcon; run: () => void }

export function CommandPalette({ open, onClose, onNavigate, onSelectBoard, onBusinessChange }: {
  open: boolean;
  onClose: () => void;
  onNavigate: (view: string) => void;
  onSelectBoard: (boardId: number) => void;
  onBusinessChange: (v: BusinessSelection) => void;
}) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) { setQ(''); setSel(0); setTimeout(() => inputRef.current?.focus(), 30); }
  }, [open]);

  const bizQ = useQuery({
    queryKey: ['businesses'],
    queryFn: () => apiGet<{ businesses: Business[] }>('/businesses'),
    enabled: open,
  });

  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 160);
    return () => clearTimeout(t);
  }, [q]);
  const results = useQuery({
    queryKey: ['palette-search', debounced],
    queryFn: () => apiGet<SearchResults>(`/search?q=${encodeURIComponent(debounced)}`),
    enabled: open && debounced.length >= 2,
  });

  const go = (view: string, params?: Record<string, string>) => {
    if (params) setUrlParams(params);
    onNavigate(view);
    onClose();
  };

  const entries = useMemo<Entry[]>(() => {
    const all: Entry[] = [];
    const term = q.trim().toLowerCase();
    const matches = (label: string) => !term || label.toLowerCase().includes(term);

    const goto: [string, string, LucideIcon][] = [
      ['home', 'Home', Home], ['today', 'Today', CalendarCheck], ['calendar', 'Calendar', CalendarDays],
      ['reports', 'Reports', BarChart3], ['files', 'Files', HardDrive],
      ['pipeline', 'Pipeline', Target], ['offerings', 'Offerings', Package], ['contacts', 'Contacts', Users],
      ['billing', 'Billing', Receipt], ['collections', 'Collections', AlertTriangle], ['expenses', 'Expenses', Wallet],
      ['settings', 'Settings', Settings],
    ];
    for (const [view, label, icon] of goto) {
      if (matches(label)) all.push({ key: `go-${view}`, group: 'Go to', label, icon, run: () => go(view) });
    }

    const creates: [string, string, LucideIcon, string, Record<string, string>][] = [
      ['billing', 'New invoice', Receipt, 'Money', { new: 'invoice' }],
      ['billing', 'New quote', FileText, 'Money', { new: 'quote' }],
      ['pipeline', 'New deal', Target, 'Sales', { new: 'deal' }],
      ['expenses', 'New expense', Wallet, 'Money', { new: 'expense' }],
      ['offerings', 'New offering', Package, 'Sales', { new: 'offering' }],
      ['offerings', 'Start subscription', Plus, 'Sales', { sub: '1' }],
    ];
    for (const [view, label, icon, sub, params] of creates) {
      if (matches(label)) all.push({ key: `new-${label}`, group: 'Create', label, sub, icon, run: () => go(view, params) });
    }

    const businesses = bizQ.data?.businesses ?? [];
    if (matches('All businesses')) {
      all.push({ key: 'biz-all', group: 'Switch business', label: 'All businesses', icon: Building2, run: () => { onBusinessChange('all'); onClose(); } });
    }
    for (const b of businesses) {
      if (matches(b.name)) all.push({ key: `biz-${b.id}`, group: 'Switch business', label: b.name, icon: Building2, run: () => { onBusinessChange(b.id); onClose(); } });
    }

    const r = debounced.length >= 2 ? results.data : undefined;
    if (r) {
      for (const c of r.clients) all.push({
        key: `client-${c.id}`, group: 'Clients', label: c.name, sub: c.boardId ? 'Open their board' : 'No board yet', icon: Users,
        run: () => { if (c.boardId) { onSelectBoard(c.boardId); onClose(); } else go('board'); },
      });
      for (const t of r.tasks) all.push({
        key: `task-${t.id}`, group: 'Cards', label: t.title,
        sub: [t.folderName, t.boardName].filter(Boolean).join(' / '), icon: SquareKanban,
        run: () => { onSelectBoard(t.boardId); onClose(); },
      });
      for (const d of r.documents) all.push({
        key: `doc-${d.id}`, group: 'Documents', label: d.number, sub: `${d.clientName} (${d.status})`, icon: Receipt,
        run: () => go('billing'),
      });
      for (const d of r.deals) all.push({
        key: `deal-${d.id}`, group: 'Deals', label: d.title, sub: d.company ?? d.stage, icon: Target,
        run: () => go('pipeline'),
      });
      for (const c of r.contacts) all.push({
        key: `contact-${c.id}`, group: 'Contacts', label: c.name, sub: c.company ?? undefined, icon: Users,
        run: () => go('contacts'),
      });
      for (const o of r.offerings) all.push({
        key: `off-${o.id}`, group: 'Offerings', label: o.name, sub: o.recurring ? 'recurring' : undefined, icon: Package,
        run: () => go('offerings'),
      });
    }
    return all;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, debounced, results.data, bizQ.data]);

  useEffect(() => { setSel(0); }, [entries.length, debounced]);

  if (!open) return null;

  const clamp = (n: number) => Math.max(0, Math.min(entries.length - 1, n));
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => clamp(s + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => clamp(s - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); entries[sel]?.run(); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };

  let lastGroup = '';
  return createPortal(
    <div className="fixed inset-0 z-[120] bg-black/60 backdrop-blur-sm"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog" aria-modal="true" aria-label="Command palette">
      <div className="mx-auto mt-[12vh] w-full max-w-lg overflow-hidden rounded-2xl border border-slate-700 bg-slate-950 shadow-2xl">
        <div className="flex items-center gap-2 border-b border-slate-800 px-4">
          <Search size={16} className="shrink-0 text-slate-500" />
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey}
            placeholder="Search everything, or type a command..."
            className="w-full bg-transparent py-3.5 text-sm text-slate-100 placeholder-slate-500 outline-none" />
          <kbd className="shrink-0 rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-500">Esc</kbd>
        </div>
        <div className="max-h-[46vh] overflow-y-auto py-1.5">
          {entries.length === 0 && (
            <p className="px-4 py-6 text-center text-sm text-slate-500">
              {debounced.length >= 2 && !results.isLoading ? 'Nothing matches that.' : 'Type to search clients, cards, invoices, deals...'}
            </p>
          )}
          {entries.map((e, i) => {
            const Icon = e.icon;
            const header = e.group !== lastGroup ? e.group : null;
            lastGroup = e.group;
            return (
              <div key={e.key}>
                {header && (
                  <div className="px-4 pb-1 pt-2.5 text-[10px] font-semibold uppercase tracking-wider text-slate-600">{header}</div>
                )}
                <button onMouseEnter={() => setSel(i)} onClick={e.run}
                  className={`flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm ${
                    i === sel ? 'bg-[var(--accent-quiet)] text-slate-100' : 'text-slate-300'}`}>
                  <Icon size={15} className={`shrink-0 ${i === sel ? 'text-violet-300' : 'text-slate-500'}`} />
                  <span className="truncate">{e.label}</span>
                  {e.sub && <span className="ml-auto shrink-0 truncate pl-3 text-xs text-slate-500">{e.sub}</span>}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
