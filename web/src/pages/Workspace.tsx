import { useEffect, useState, useRef } from 'react';
import { Timer, LogOut, Settings, Menu as MenuIcon, X, Search } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { apiPost } from '../lib/api';
import { Sidebar } from '../components/Sidebar';
import { BoardView } from '../components/BoardView';
import { CalendarView } from '../components/CalendarView';
import { FilesView } from '../components/FilesView';
import { ReportsView } from '../components/ReportsView';
import { BillingView } from '../components/BillingView';
import { CollectionsView } from '../components/CollectionsView';
import { BrandThemeSync } from '../components/BrandThemeSync';
import { TodayView } from '../components/TodayView';
import { OfferingsView } from '../components/OfferingsView';
import { ExpensesView } from '../components/ExpensesView';
import { PipelineView } from '../components/PipelineView';
import { ContactsView } from '../components/ContactsView';
import { DashboardView } from '../components/DashboardView';
import { FocusTimer } from '../components/FocusTimer';
import { TimerChip } from '../components/TimerChip';
import { SettingsView } from '../components/SettingsView';
import { MobileTabBar } from '../components/MobileTabBar';
import { CommandPalette } from '../components/CommandPalette';
import { apiGet } from '../lib/api';
import type { BusinessSelection } from '../components/BusinessSwitcher';

type View = 'home' | 'today' | 'pipeline' | 'contacts' | 'board' | 'calendar' | 'files' | 'offerings' | 'expenses' | 'reports' | 'billing' | 'collections' | 'settings';

const VIEW_LABELS: Record<View, string> = {
  home: 'Home', pipeline: 'Pipeline', contacts: 'Contacts', board: 'Board', calendar: 'Calendar',
  today: 'Today', files: 'Files', offerings: 'Offerings', expenses: 'Expenses', reports: 'Reports', billing: 'Billing',
  collections: 'Collections', settings: 'Settings',
};
const viewLabel = (v: View) => VIEW_LABELS[v] ?? '';

function loadBusiness(): BusinessSelection {
  const s = localStorage.getItem('klippy.business');
  if (!s || s === 'all') return 'all';
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : 'all';
}

const ALL_VIEWS: View[] = ['home', 'today', 'pipeline', 'contacts', 'board', 'calendar', 'files',
  'offerings', 'expenses', 'reports', 'billing', 'collections', 'settings'];

/**
 * The whole app used to be useState view-switching with no URL, so a push
 * notification could not land anywhere but Home, the phone's back gesture exited
 * the app, and nothing was bookmarkable. This reflects the current view / business /
 * board in the query string and reads it back, without pulling in a router: enough
 * to make deep links, the back button, and push navigation work.
 */
interface UrlState { view: View; businessId: BusinessSelection; boardId: number | null }

function readUrlState(): UrlState {
  const q = new URLSearchParams(window.location.search);
  const v = q.get('v');
  const view: View = v && (ALL_VIEWS as string[]).includes(v) ? (v as View) : 'home';
  const b = q.get('b');
  const businessId: BusinessSelection = b === 'all' ? 'all'
    : (b && /^\d+$/.test(b) ? Number(b) : loadBusiness());
  const bd = q.get('board');
  const boardId = bd && /^\d+$/.test(bd) ? Number(bd) : null;
  return { view, businessId, boardId };
}

function writeUrlState(st: UrlState, replace: boolean): void {
  const q = new URLSearchParams(window.location.search);
  q.set('v', st.view);
  q.set('b', String(st.businessId));
  if (st.view === 'board' && st.boardId != null) q.set('board', String(st.boardId));
  else q.delete('board');
  const url = `${window.location.pathname}?${q.toString()}`;
  if (replace) window.history.replaceState(null, '', url);
  else window.history.pushState(null, '', url);
}

export function Workspace() {
  const { user, account, logout } = useAuth();
  const initial = readUrlState();
  const [boardId, setBoardId] = useState<number | null>(initial.boardId);
  const [view, setView] = useState<View>(initial.view);
  const [showTimer, setShowTimer] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Cmd/Ctrl-K opens the palette from anywhere. The one shortcut worth learning.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Land on a client's actual board. The old path set the Boards view with no
  // board selected, which is a blank screen with a shrug on it.
  const openClient = async (folderId: number) => {
    try {
      const r = await apiGet<{ boards: { id: number }[] }>(`/boards?folderId=${folderId}`);
      const first = r.boards?.[0]?.id ?? null;
      setBoardId(first);
      setView('board');
    } catch {
      setView('board');
    }
  };
  const [businessId, setBusinessId] = useState<BusinessSelection>(initial.businessId);
  const selectBusiness = (v: BusinessSelection) => { setBusinessId(v); localStorage.setItem('klippy.business', String(v)); };

  // Keep the URL in step with the view, so it is deep-linkable and the back button
  // moves between views. The first run replaces (normalising the URL without adding
  // a history entry); later changes push, so Back returns to the previous view.
  const firstSync = useRef(true);
  useEffect(() => {
    writeUrlState({ view, businessId, boardId }, firstSync.current);
    firstSync.current = false;
  }, [view, businessId, boardId]);

  // Back/forward (and the Android back gesture) restore the view from the URL
  // instead of exiting the app.
  useEffect(() => {
    const onPop = () => {
      const st = readUrlState();
      setView(st.view);
      setBusinessId(st.businessId);
      setBoardId(st.boardId);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Nudge the daily jobs whenever the app is opened. Shared hosting stops an idle
  // server, so simply using Klippy (including the installed app on a phone) is what
  // keeps invoicing and reminders moving, with no cron to set up. Cheap and
  // idempotent: it does nothing once the day's runs are already recorded.
  useEffect(() => {
    apiPost('/automation/tick').catch(() => { /* never block the app on this */ });
  }, []);

  return (
    <div className="flex h-full">
      {/* Working in a business skins the app in that business's brand. */}
      <BrandThemeSync businessId={businessId} />

      {/* Sidebar: fixed drawer under lg, static column at lg+ */}
      <div
        className={`fixed inset-y-0 left-0 z-40 w-[19rem] transform bg-slate-950 pt-safe pl-safe transition-transform duration-200 lg:static lg:z-auto lg:translate-x-0 ${
          navOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <Sidebar
          selectedBoardId={boardId}
          businessId={businessId}
          view={view}
          onNavigate={(v) => { setView(v as View); setNavOpen(false); }}
          onBusinessChange={selectBusiness}
          onSelectBoard={(id) => { setBoardId(id); setView('board'); setNavOpen(false); }}
        />
      </div>
      {navOpen && (
        <div className="fixed inset-0 z-30 bg-black/50 lg:hidden" onClick={() => setNavOpen(false)} />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar (h-safe-14 + pt-safe keeps it clear of the iOS status bar) */}
        <header className="flex h-safe-14 shrink-0 items-center gap-2 border-b border-slate-800 px-2 pt-safe pr-safe sm:px-4">
          <button onClick={() => setNavOpen((o) => !o)}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-slate-300 hover:bg-slate-800 lg:hidden">
            {navOpen ? <X size={18} /> : <MenuIcon size={18} />}
          </button>

          {/* Current section name, shown where the sidebar is hidden */}
          <span className="truncate text-sm font-semibold text-slate-100 lg:hidden">{viewLabel(view)}</span>

          <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-1.5 sm:gap-3">
            <button onClick={() => setPaletteOpen(true)}
              className="hidden min-w-0 flex-1 items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-500 hover:border-slate-600 hover:text-slate-400 sm:flex sm:max-w-xs">
              <Search size={14} className="shrink-0" />
              <span className="truncate">Search everything...</span>
              <kbd className="ml-auto shrink-0 rounded border border-slate-700 px-1.5 py-0.5 text-[10px]">Ctrl K</kbd>
            </button>
            <TimerChip />
            <button onClick={() => setShowTimer(true)} title="Focus timer"
              className="flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-700 px-2 py-1.5 text-xs text-slate-300 hover:bg-slate-800 sm:px-2.5">
              <Timer size={14} /> <span className="hidden sm:inline">Focus</span>
            </button>
            <div className="hidden text-right lg:block">
              <div className="text-xs font-medium text-slate-200">{user?.name}</div>
              <div className="text-[11px] text-slate-500">{account?.name}</div>
            </div>
            <button onClick={() => setView('settings')} title="Settings"
              className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg hover:bg-slate-800 hover:text-slate-200 ${
                view === 'settings' ? 'text-[var(--accent)]' : 'text-slate-400'
              }`}>
              <Settings size={15} />
            </button>
            <button onClick={logout} title="Sign out"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-slate-200">
              <LogOut size={15} />
            </button>
          </div>
        </header>

        {/* Search on the smallest screens sits under the bar so it stays usable */}
        <div className="border-b border-slate-800 px-2 py-2 sm:hidden">
          <button onClick={() => setPaletteOpen(true)}
            className="flex w-full items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-500">
            <Search size={14} className="shrink-0" /> Search everything...
          </button>
        </div>

        <main className="min-h-0 flex-1 overflow-hidden pr-safe pb-[calc(52px+env(safe-area-inset-bottom))] lg:pb-safe">
          {view === 'home' && <DashboardView businessId={businessId} onNavigate={(v) => setView(v as View)} onPickBusiness={selectBusiness} />}
          {view === 'today' && <TodayView businessId={businessId} onNavigate={(v) => setView(v as View)} />}
          {view === 'pipeline' && <PipelineView businessId={businessId} onOpenClient={openClient} />}
          {view === 'contacts' && <ContactsView businessId={businessId} />}
          {view === 'board' && <BoardView boardId={boardId} onNavigate={(v) => setView(v as View)} />}
          {view === 'calendar' && <CalendarView businessId={businessId} />}
          {view === 'files' && <FilesView />}
          {view === 'offerings' && <OfferingsView businessId={businessId} />}
          {view === 'expenses' && <ExpensesView businessId={businessId} />}
          {view === 'reports' && <ReportsView businessId={businessId} />}
          {view === 'billing' && <BillingView businessId={businessId} />}
          {view === 'collections' && <CollectionsView businessId={businessId} />}
          {view === 'settings' && <SettingsView businessId={businessId} />}
        </main>
      </div>

      <MobileTabBar view={view} businessId={businessId}
        onNavigate={(v) => setView(v as View)} onOpenMore={() => setNavOpen(true)} />

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)}
        onNavigate={(v) => setView(v as View)}
        onSelectBoard={(id) => { setBoardId(id); setView('board'); }}
        onBusinessChange={selectBusiness} />

      {showTimer && <FocusTimer onClose={() => setShowTimer(false)} />}
    </div>
  );
}
