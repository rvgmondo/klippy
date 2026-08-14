import { useState } from 'react';
import { promptDialog} from './ConfirmDialog';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {} from '@dnd-kit/utilities';
import {
  ChevronRight, ChevronDown, FolderPlus,
  Home, Target, CalendarDays, CalendarCheck, HardDrive, BarChart3, Receipt, Package, Wallet, AlertTriangle, type LucideIcon,
} from 'lucide-react';
import { apiGet, apiPost} from '../lib/api';
import { FolderList } from './FolderTree';
import { NewClientModal } from './NewClientModal';
import { useAuth } from '../lib/auth';
import {} from './Menu';
import { BusinessSwitcher, type BusinessSelection } from './BusinessSwitcher';
import type { Business, Folder as TFolder } from '../lib/types';

interface Props {
  selectedBoardId: number | null;
  businessId: BusinessSelection;
  view: string;
  onNavigate: (v: string) => void;
  onBusinessChange: (v: BusinessSelection) => void;
  onSelectBoard: (id: number) => void;
}

/**
 * Navigation is grouped by the four primitives every business runs on: bring work
 * in, do the work, handle the money, run the machine. A flat list of ten screens
 * never told you which part of the business you were standing in.
 *
 * Which modules appear is decided per business (see Settings > Modules), so a
 * copywriter is not made to look at stock levels. Home sits above the groups
 * because it spans all four.
 */
const MODULE_ICON: Record<string, LucideIcon> = {
  pipeline: Target, offerings: Package,
  today: CalendarCheck, calendar: CalendarDays, reports: BarChart3,
  billing: Receipt, collections: AlertTriangle, expenses: Wallet,
  files: HardDrive,
};

const PRIMITIVE_ORDER = ['acquisition', 'fulfillment', 'finance', 'admin'] as const;
const PRIMITIVE_LABEL: Record<string, string> = {
  acquisition: 'Acquisition', fulfillment: 'Fulfillment', finance: 'Finance', admin: 'Admin',
};

/**
 * Groups collapse, and stay collapsed.
 *
 * Grouping the modules by primitive made the sidebar readable but cost real estate:
 * the nav took two thirds of the height and squeezed the boards tree, which is the
 * part you are in all day, into a sliver. Collapsed groups keep the structure
 * visible while handing the space back to the work. The group holding wherever you
 * are opens itself, so the current screen is never hidden.
 */
const NAV_OPEN_KEY = 'klippy.navGroups';
function loadOpenGroups(): Record<string, boolean> {
  try { return JSON.parse(localStorage.getItem(NAV_OPEN_KEY) ?? '{}'); } catch { return {}; }
}

/** Which businesses are expanded in the tree, by id. */
const BIZ_OPEN_KEY = 'klippy.openBusinesses';
function loadOpenBiz(): Record<string, boolean> {
  try { return JSON.parse(localStorage.getItem(BIZ_OPEN_KEY) ?? '{}'); } catch { return {}; }
}

function NavButton({ nav, view, onNavigate, compact }: {
  nav: { key: string; label: string; icon: LucideIcon }; view: string;
  onNavigate: (v: string) => void; compact?: boolean;
}) {
  const Icon = nav.icon;
  const active = view === nav.key;
  return (
    <button onClick={() => onNavigate(nav.key)}
      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 text-sm transition ${
        compact ? 'py-1.5' : 'py-2 font-medium'
      } ${active
        ? 'bg-[var(--accent-quiet)] font-medium text-violet-300'
        : 'text-slate-300 hover:bg-slate-800/60 hover:text-slate-100'}`}>
      <Icon size={16} className={`shrink-0 ${active ? 'text-violet-300' : ''}`} /> {nav.label}
    </button>
  );
}

export function Sidebar({ selectedBoardId, businessId, view, onNavigate, onBusinessChange, onSelectBoard }: Props) {
  const { account } = useAuth();
  const { data } = useQuery({ queryKey: ['folders'], queryFn: () => apiGet<{ folders: TFolder[] }>('/folders') });
  const folders = data?.folders ?? [];
  const bizData = useQuery({ queryKey: ['businesses'], queryFn: () => apiGet<{ businesses: Business[] }>('/businesses') });
  const businesses = bizData.data?.businesses ?? [];

  // Which businesses to show: all of them, or just the selected one.
  const shown = businessId === 'all' ? businesses : businesses.filter((b) => b.id === businessId);
  const showHeaders = businessId === 'all' && businesses.length > 1;

  // The module catalogue tells us what exists and where it belongs; the business
  // tells us what it uses. Viewing all businesses shows the union, since hiding a
  // screen that one of them needs would be worse than showing one it does not.
  const catalogue = useQuery({
    queryKey: ['modules'],
    queryFn: () => apiGet<{ modules: { key: string; label: string; primitive: string }[] }>('/modules'),
    staleTime: 60 * 60 * 1000,
  });
  const enabled = new Set(
    businessId === 'all'
      ? businesses.flatMap((b) => b.modules ?? [])
      : (businesses.find((b) => b.id === businessId)?.modules ?? []),
  );
  const defs = catalogue.data?.modules ?? [];
  // Until the catalogue loads, or for a business with nothing resolved yet, fall
  // back to showing everything rather than an empty sidebar.
  const showAll = defs.length === 0 || enabled.size === 0;
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(loadOpenGroups);
  const navGroups = PRIMITIVE_ORDER.map((primitive) => ({
    primitive,
    items: defs
      .filter((m) => m.primitive === primitive && (showAll || enabled.has(m.key)))
      .map((m) => ({ key: m.key, label: m.label, icon: MODULE_ICON[m.key] ?? Home })),
  })).filter((g) => g.items.length > 0);

  return (
    <aside className="flex h-full w-full shrink-0 flex-col border-r border-slate-800 bg-slate-950/40">
      <div className="flex h-14 items-center gap-2 border-b border-slate-800 px-4">
        {account?.hasLogo ? (
          <img src="/api/v1/account/logo" alt="" className="h-7 w-7 shrink-0 rounded-lg object-contain" />
        ) : (
          <div className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-[var(--accent)] text-sm font-bold text-[var(--accent-ink)]">
            {(account?.brandName || 'Klippy')[0]!.toUpperCase()}
          </div>
        )}
        <span className="truncate font-semibold text-slate-100">{account?.brandName || 'Klippy'}</span>
      </div>

      {/* Business switcher */}
      <div className="border-b border-slate-800 px-2 py-2">
        <BusinessSwitcher value={businessId} onChange={onBusinessChange} full />
      </div>

      {/* Primary navigation, grouped by the four primitives and collapsed by
          default so the boards below get the room. */}
      <div className="shrink-0 space-y-0.5 border-b border-slate-800 px-2 py-2">
        <NavButton nav={{ key: 'home', label: 'Home', icon: Home }} view={view} onNavigate={onNavigate} />
        {navGroups.map((g) => {
          // The group you are currently in is always open, so the active screen is
          // never hidden behind a collapsed header.
          const hasActive = g.items.some((i) => i.key === view);
          const open = hasActive || (openGroups[g.primitive] ?? false);
          return (
            <div key={g.primitive}>
              <button
                onClick={() => setOpenGroups((o) => {
                  const next = { ...o, [g.primitive]: !open };
                  try { localStorage.setItem(NAV_OPEN_KEY, JSON.stringify(next)); } catch { /* ignore */ }
                  return next;
                })}
                className="flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500 hover:bg-slate-800/40 hover:text-slate-300">
                {open ? <ChevronDown size={11} className="shrink-0" /> : <ChevronRight size={11} className="shrink-0" />}
                <span className="truncate">{PRIMITIVE_LABEL[g.primitive]}</span>
                {!open && (
                  <span className="ml-auto shrink-0 text-[10px] font-normal normal-case text-slate-600">
                    {g.items.length}
                  </span>
                )}
              </button>
              {open && (
                <div className="space-y-0.5 pb-0.5">
                  {g.items.map((n) => <NavButton key={n.key} nav={n} view={view} onNavigate={onNavigate} compact />)}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* The boards tree: the part you are in all day, so it gets the height. */}
      <div className="shrink-0 px-3.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-slate-600">
        {account?.folderLabelPlural || 'Clients'} and boards
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {shown.length === 0 && (
          <p className="px-2 py-6 text-center text-[11px] text-slate-500">No businesses yet.</p>
        )}
        {shown.map((biz, i) => (
          <BusinessBlock key={biz.id} business={biz} all={folders} showHeader={showHeaders} defaultOpen={i === 0}
            folderLabelSingular={account?.folderLabelSingular} folderLabelPlural={account?.folderLabelPlural}
            selectedBoardId={selectedBoardId} onSelectBoard={onSelectBoard} />
        ))}
      </nav>
    </aside>
  );
}

// One business's slice of the sidebar: its Delivery and Operations sections.
function BusinessBlock({ business, all, showHeader, defaultOpen, folderLabelSingular, folderLabelPlural, selectedBoardId, onSelectBoard }: {
  business: Business; all: TFolder[]; showHeader: boolean; defaultOpen?: boolean;
  folderLabelSingular?: string; folderLabelPlural?: string;
  selectedBoardId: number | null; onSelectBoard: (id: number) => void;
}) {
  const qc = useQueryClient();
  const createFolder = useMutation({
    mutationFn: (v: { name: string; parentId: number | null; businessId: number; pillar: 'delivery' | 'operations' }) => apiPost('/folders', v),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['folders'] }),
  });

  const roots = all.filter((f) => f.parentId === null && f.businessId === business.id);
  const deliveryRoots = roots.filter((f) => (f.pillar ?? 'delivery') !== 'operations');
  const opsRoots = roots.filter((f) => f.pillar === 'operations');

  // A client gets the full form, because the details asked for there are the ones
  // that make invoicing and the portal work and are a nuisance to add later. An
  // internal area is just a folder, so it stays a one-line prompt.
  const [addingClient, setAddingClient] = useState<'delivery' | 'operations' | null>(null);

  async function addTop(pillar: 'delivery' | 'operations') {
    if (pillar === 'delivery') { setAddingClient('delivery'); return; }
    const name = await promptDialog(`New internal area name in ${business.name}`);
    if (name?.trim()) createFolder.mutate({ name: name.trim(), parentId: null, businessId: business.id, pillar });
  }

  // With several businesses the tree used to render all of them fully expanded,
  // which is a wall of folders you have to scroll past to reach the one you want.
  // Each business is now a disclosure, remembered per business.
  // The first business starts open, so the tree is never a row of shut drawers.
  const [open, setOpen] = useState(() => (showHeader ? loadOpenBiz()[business.id] ?? !!defaultOpen : true));
  const toggle = () => setOpen((o) => {
    const next = !o;
    try {
      const all = loadOpenBiz();
      localStorage.setItem(BIZ_OPEN_KEY, JSON.stringify({ ...all, [business.id]: next }));
    } catch { /* ignore */ }
    return next;
  });

  const boardCount = all.filter((f) => f.businessId === business.id).length;

  return (
    <div className={showHeader ? 'mb-1 border-t border-slate-800/70 pt-1 first:border-t-0' : ''}>
      {showHeader && (
        <button onClick={toggle}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-slate-800/40">
          {open ? <ChevronDown size={12} className="shrink-0 text-slate-500" /> : <ChevronRight size={12} className="shrink-0 text-slate-500" />}
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: business.color }} />
          <span className="truncate text-xs font-semibold text-slate-200">{business.name}</span>
          {!open && <span className="ml-auto shrink-0 text-[10px] text-slate-600">{boardCount}</span>}
        </button>
      )}

      {open && (
        <>
          <SectionHeader label={`Delivery / ${folderLabelPlural ?? 'Clients'}`} onAdd={() => addTop('delivery')} />
          {deliveryRoots.length === 0 && (
            <p className="px-2 py-2 text-center text-[11px] text-slate-500">No {folderLabelPlural?.toLowerCase() ?? 'clients'} yet.</p>
          )}
          <FolderList folders={deliveryRoots} all={all} depth={0}
            selectedBoardId={selectedBoardId} onSelectBoard={onSelectBoard} />

          <div className="mt-3">
            <SectionHeader label="Operations / Internal" onAdd={() => addTop('operations')} />
            {opsRoots.length === 0 && (
              <p className="px-2 py-2 text-center text-[11px] text-slate-500">Admin, hiring, finance...</p>
            )}
            <FolderList folders={opsRoots} all={all} depth={0}
              selectedBoardId={selectedBoardId} onSelectBoard={onSelectBoard} />
          </div>
        </>
      )}

      {addingClient && (
        <NewClientModal
          businessId={business.id}
          businessName={business.name}
          pillar={addingClient}
          label={folderLabelSingular ?? 'Client'}
          onClose={() => setAddingClient(null)}
          onCreated={() => setAddingClient(null)}
        />
      )}
    </div>
  );
}

function SectionHeader({ label, onAdd }: { label: string; onAdd: () => void }) {
  return (
    <div className="flex items-center justify-between px-2 pb-1 pt-3">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{label}</span>
      <button onClick={onAdd} title="Add" className="grid h-6 w-6 place-items-center rounded text-slate-400 hover:bg-slate-800 hover:text-slate-200">
        <FolderPlus size={15} />
      </button>
    </div>
  );
}

