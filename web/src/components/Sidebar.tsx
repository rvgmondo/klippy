import { useState } from 'react';
import { promptDialog } from './ConfirmDialog';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ChevronRight, ChevronDown, FolderPlus,
  Home, Briefcase, Target, Wallet, Settings, Users,
  CalendarDays, CalendarCheck, HardDrive, BarChart3, Receipt, Package, AlertTriangle, TrendingUp,
  type LucideIcon, CreditCard,
} from 'lucide-react';
import { apiGet, apiPost } from '../lib/api';
import { FolderList } from './FolderTree';
import { NewClientModal } from './NewClientModal';
import { useUrlAction } from '../lib/urlAction';
import { useAuth } from '../lib/auth';
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
 * THE SPINE. One partition of the product, in the founder's plain voice, used
 * everywhere: Home, Work, Sales, Money, Admin.
 *
 * The app used to offer four competing maps of the same business at once: four
 * "primitives" in this sidebar, three "engines" on Home, two "pillars" in the
 * folder tree, three scopes in Settings. Each was defensible alone; together they
 * meant the user was re-orienting on every screen. These five words are now the
 * only top-level grouping, rendered as an always-visible rail so nothing hides
 * behind collapsed disclosure triangles (which used to bury 9 of 11 modules).
 *
 * The active area owns the second column. The client/board tree lives only inside
 * Work, so the module list and the folder tree stop fighting over one column.
 */
export const AREAS: {
  key: string; label: string; icon: LucideIcon; blurb: string;
  defaultView: string; views: string[]; modules: string[];
}[] = [
  { key: 'home', label: 'Home', icon: Home, blurb: 'The one overview', defaultView: 'home', views: ['home'], modules: [] },
  {
    key: 'work', label: 'Work', icon: Briefcase, blurb: 'Do the work',
    defaultView: 'today', views: ['today', 'board', 'calendar', 'reports', 'files'],
    modules: ['today', 'calendar', 'reports', 'files'],
  },
  {
    key: 'sales', label: 'Sales', icon: Target, blurb: 'Bring work in',
    defaultView: 'pipeline', views: ['pipeline', 'offerings', 'contacts'],
    modules: ['pipeline', 'offerings'],
  },
  {
    key: 'money', label: 'Money', icon: Wallet, blurb: 'Handle the money',
    defaultView: 'billing', views: ['billing', 'collections', 'cashflow', 'expenses', 'takings'],
    modules: ['billing', 'collections', 'cashflow', 'expenses', 'takings'],
  },
  { key: 'admin', label: 'Admin', icon: Settings, blurb: 'Run the machine', defaultView: 'settings', views: ['settings'], modules: [] },
];

export function areaOf(view: string) {
  return AREAS.find((a) => a.views.includes(view)) ?? AREAS[0]!;
}

const MODULE_ICON: Record<string, LucideIcon> = {
  pipeline: Target, offerings: Package,
  today: CalendarCheck, calendar: CalendarDays, reports: BarChart3,
  billing: Receipt, collections: AlertTriangle, cashflow: TrendingUp, expenses: Wallet,
  takings: CreditCard,
  files: HardDrive, contacts: Users,
};

/** Which businesses are expanded in the tree, by id. */
const BIZ_OPEN_KEY = 'klippy.openBusinesses';
function loadOpenBiz(): Record<string, boolean> {
  try { return JSON.parse(localStorage.getItem(BIZ_OPEN_KEY) ?? '{}'); } catch { return {}; }
}

function NavButton({ nav, view, onNavigate, compact }: {
  nav: { key: string; label: string; icon: LucideIcon; hint?: string }; view: string;
  onNavigate: (v: string) => void; compact?: boolean;
}) {
  const Icon = nav.icon;
  const active = view === nav.key;
  return (
    <button onClick={() => onNavigate(nav.key)} title={nav.hint}
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
  // The onboarding checklist (and anything else) can open the New Client modal
  // by URL intent, without knowing where in the tree the button lives.
  const [quickNewClient, setQuickNewClient] = useState(false);
  useUrlAction('new-client', () => setQuickNewClient(true));
  const { data } = useQuery({ queryKey: ['folders'], queryFn: () => apiGet<{ folders: TFolder[] }>('/folders') });
  const folders = data?.folders ?? [];
  const bizData = useQuery({ queryKey: ['businesses'], queryFn: () => apiGet<{ businesses: Business[] }>('/businesses') });
  const businesses = bizData.data?.businesses ?? [];

  // Which businesses to show in the tree: all of them, or just the selected one.
  const shown = businessId === 'all' ? businesses : businesses.filter((b) => b.id === businessId);
  const showHeaders = businessId === 'all' && businesses.length > 1;

  // The module catalogue tells us what exists; the business tells us what it uses.
  // Viewing all businesses shows the union, since hiding a screen one of them needs
  // would be worse than showing one it does not.
  const catalogue = useQuery({
    queryKey: ['modules'],
    queryFn: () => apiGet<{
      primitives: { key: string; label: string; blurb: string }[];
      modules: { key: string; label: string; primitive: string; hint?: string }[];
    }>('/modules'),
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
  const hintOf = (key: string) => defs.find((m) => m.key === key)?.hint;

  const area = areaOf(view);
  // The active area's second-level items, filtered to this business's modules.
  // Contacts is not a module (the people behind deals and clients are always
  // there), so it is appended to Sales rather than gated.
  const items = area.modules
    .filter((k) => showAll || enabled.has(k))
    .map((k) => ({
      key: k,
      label: defs.find((m) => m.key === k)?.label ?? k[0]!.toUpperCase() + k.slice(1),
      icon: MODULE_ICON[k] ?? Home,
      hint: hintOf(k),
    }));
  if (area.key === 'sales') {
    items.push({ key: 'contacts', label: 'Contacts', icon: Users, hint: 'The people behind your deals and clients.' });
  }

  return (
    <>
    <aside className="flex h-full w-full shrink-0 border-r border-slate-800 bg-slate-950/40">
      {/* The area rail: five words, always visible. An app switcher done right,
          five areas rather than forty apps. */}
      {/* Hidden on phones: the bottom tab bar already shows these five, 8px
          below where this would draw them again. */}
      <div className="hidden w-16 shrink-0 flex-col gap-1 border-r border-slate-800 bg-slate-950/70 px-1.5 pb-3 pt-2 lg:flex">
        <div className="mb-1 grid place-items-center py-1">
          {account?.hasLogo ? (
            <img src="/api/v1/account/logo" alt="" className="h-8 w-8 rounded-lg object-contain" />
          ) : (
            <div className="grid h-8 w-8 place-items-center rounded-lg bg-[var(--accent)] text-sm font-bold text-[var(--accent-ink)]">
              {(account?.brandName || 'Klippy')[0]!.toUpperCase()}
            </div>
          )}
        </div>
        {AREAS.map((a) => {
          const Icon = a.icon;
          const active = a.key === area.key;
          return (
            <button key={a.key} onClick={() => onNavigate(active ? view : a.defaultView)} title={a.blurb}
              className={`flex flex-col items-center gap-1 rounded-lg py-2 text-[10px] font-medium transition ${
                active
                  ? 'bg-[var(--accent-quiet)] text-violet-300'
                  : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'}`}>
              <Icon size={18} className="shrink-0" />
              {a.label}
            </button>
          );
        })}
      </div>

      {/*
        The active area's own column.

        It used to be here on every screen, 239px of it, and on Home and Admin it
        held one sentence of filler. The area's sibling screens are now tabs at
        the top of the content (see PageHeader), where they sit directly above
        the thing they switch. What is genuinely a column of its own is the
        clients-and-boards tree, so the column survives for Work and steps aside
        everywhere else. On a phone the drawer IS the navigation, so it keeps the
        full list there whatever the area.
      */}
      <div className={`flex w-[15rem] min-w-0 flex-1 flex-col ${
        view === 'board' || view === 'today' ? '' : 'lg:hidden'}`}>
        <div className="flex h-14 shrink-0 items-center gap-2 border-b border-slate-800 px-3 lg:hidden">
          <span className="truncate font-semibold text-slate-100">{account?.brandName || 'Klippy'}</span>
        </div>

        {/* The business you are in. On a desktop this lives in the app header
            now; the drawer keeps its own copy because the header is out of
            reach behind it. */}
        <div className="border-b border-slate-800 px-2 py-2 lg:hidden">
          <BusinessSwitcher value={businessId} onChange={onBusinessChange} full />
        </div>

        {items.length > 0 && (
          <div className="shrink-0 space-y-0.5 border-b border-slate-800 px-2 py-2 lg:hidden">
            {items.map((n) => <NavButton key={n.key} nav={n} view={view} onNavigate={onNavigate} />)}
          </div>
        )}

        {area.key === 'work' ? (
          <>
            {/* The boards tree lives only inside Work, so the module list and the
                folder tree stop fighting over one column. */}
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
          </>
        ) : (
          <div className="flex-1 px-4 py-4 text-[11px] leading-relaxed text-slate-600">
            {area.blurb}.
          </div>
        )}
      </div>
    </aside>
      {quickNewClient && businesses[0] && (
        <NewClientModal
          businessId={(businessId !== 'all' && businesses.find((b) => b.id === businessId)) ? (businessId as number) : businesses[0].id}
          businessName={(businessId !== 'all' && businesses.find((b) => b.id === businessId)?.name) || businesses[0].name}
          pillar="delivery"
          label={account?.folderLabelSingular ?? 'Client'}
          onClose={() => setQuickNewClient(false)}
          onCreated={() => setQuickNewClient(false)}
        />
      )}
    </>
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
          className="flex w-full items-center gap-2 rounded-md px-2 py-2.5 text-left hover:bg-slate-800/40 lg:py-1.5">
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

