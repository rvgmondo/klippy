import { useEffect, useState, useRef } from 'react';
import { Timer, LogOut, Settings, Menu as MenuIcon, X, Search } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { apiPost } from '../lib/api';
import { notify } from '../components/ConfirmDialog';
import { Sidebar } from '../components/Sidebar';
import { BoardView } from '../components/BoardView';
import { CalendarView } from '../components/CalendarView';
import { FilesView } from '../components/FilesView';
import { ReportsView } from '../components/ReportsView';
import { BillingView } from '../components/BillingView';
import { CollectionsView } from '../components/CollectionsView';
import { CashflowView } from '../components/CashflowView';
import { BrandThemeSync } from '../components/BrandThemeSync';
import { TodayView } from '../components/TodayView';
import { OfferingsView } from '../components/OfferingsView';
import { ExpensesView } from '../components/ExpensesView';
import { PipelineView } from '../components/PipelineView';
import { ContactsView } from '../components/ContactsView';
import { DashboardView } from '../components/DashboardView';
import { TakingsView } from '../components/TakingsView';
import { FocusTimer } from '../components/FocusTimer';
import { TimerChip } from '../components/TimerChip';
import { NotificationsBell } from '../components/NotificationsBell';
import { SettingsView } from '../components/SettingsView';
import { MobileTabBar } from '../components/MobileTabBar';
import { CommandPalette } from '../components/CommandPalette';
import { WorkspaceSwitcher } from '../components/WorkspaceSwitcher';
import { apiGet } from '../lib/api';
import { BusinessSwitcher, type BusinessSelection } from '../components/BusinessSwitcher';

type View = 'home' | 'today' | 'pipeline' | 'contacts' | 'board' | 'calendar' | 'files' | 'offerings' | 'expenses' | 'takings' | 'reports' | 'billing' | 'collections' | 'cashflow' | 'settings';


function loadBusiness(): BusinessSelection {
  const s = localStorage.getItem('klippy.business');
  if (!s || s === 'all') return 'all';
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : 'all';
}

const ALL_VIEWS: View[] = ['home', 'today', 'pipeline', 'contacts', 'board', 'calendar', 'files', 'takings',
  'offerings', 'expenses', 'reports', 'billing', 'collections', 'cashflow', 'settings'];

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
  const { user, logout } = useAuth();
  const initial = readUrlState();
  const [boardId, setBoardId] = useState<number | null>(initial.boardId);
  const [view, setView] = useState<View>(initial.view);
  const [showTimer, setShowTimer] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  /**
   * An invitation link opened while already signed in.
   *
   * Someone who already uses Klippy clicks the link from their inbox and lands here,
   * signed in, with ?invite= still on the URL. Doing nothing would look like a dead
   * link and they would ask the person who invited them to send another. The session
   * already proves who they are, so it just accepts, says so, and cleans the URL.
   */
  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('invite');
    if (!token) return;
    const q = new URLSearchParams(window.location.search);
    q.delete('invite');
    window.history.replaceState({}, '', window.location.pathname + (q.toString() ? '?' + q : ''));
    apiPost<{ message?: string }>('/invitations/accept', { token })
      .then((r) => notify(r.message ?? 'You have joined. Switch to it from the workspace menu.', 'ok'))
      .catch((e: Error) => notify(e.message, 'error'));
  }, []);

  // Anything in the tree can change the view by writing it to the URL
  // (page-header tabs, the onboarding checklist, an empty state). The workspace
  // owns the state; the URL is how everything else asks it to move.
  useEffect(() => {
    const sync = () => {
      const next = readUrlState();
      setView(next.view);
      if (next.boardId != null) setBoardId(next.boardId);
    };
    window.addEventListener('klippy:params', sync);
    return () => window.removeEventListener('klippy:params', sync);
  }, []);

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
        /* A 19rem drawer on phones, where it is the whole navigation. On a
           desktop it shrinks to whatever the rail needs: the second column only
           appears for Work, which is the one area with a tree in it. */
        className={`fixed inset-y-0 left-0 z-40 w-[19rem] transform bg-slate-950 pt-safe pl-safe transition-transform duration-200 lg:static lg:z-auto lg:w-auto lg:translate-x-0 ${
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

          {/* Which business you are working in: the one piece of context that
              follows you between every area, so it belongs in the global bar
              rather than in a column that no longer exists on most screens. */}
          <div className="min-w-0 max-w-[13rem] flex-1 sm:max-w-xs">
            <BusinessSwitcher value={businessId} onChange={selectBusiness} full />
          </div>

          <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-1.5 sm:gap-3">
            {/* A full search field where there is room, a 36px icon where there
                is not. It used to disappear below sm and reappear as its own
                52px bar under the header, which is the same control twice. */}
            <button onClick={() => setPaletteOpen(true)} aria-label="Search everything"
              className="flex h-9 w-9 shrink-0 items-center justify-center gap-2 rounded-lg border border-slate-700 bg-slate-900 text-slate-500 hover:border-slate-600 hover:text-slate-400 sm:h-auto sm:w-auto sm:min-w-0 sm:flex-1 sm:justify-start sm:px-3 sm:py-2 sm:text-sm md:max-w-xs">
              <Search size={14} className="shrink-0" />
              <span className="hidden truncate sm:inline">Search everything...</span>
              <kbd className="ml-auto hidden shrink-0 rounded border border-slate-700 px-1.5 py-0.5 text-[10px] md:inline">Ctrl K</kbd>
            </button>
            <TimerChip />
            <NotificationsBell />
            <button onClick={() => setShowTimer(true)} title="Focus timer"
              className="flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 text-xs text-slate-300 hover:bg-slate-800">
              <Timer size={14} /> <span className="hidden sm:inline">Focus</span>
            </button>
            <div className="hidden items-center gap-2 lg:flex">
              <div className="text-right">
                <div className="text-xs font-medium text-slate-200">{user?.name}</div>
              </div>
              {/* The workspace switcher was fully built and imported nowhere. A person
                  in two workspaces had no way to move between them. */}
              <WorkspaceSwitcher />
            </div>
            {/* On phones the Admin tab reaches Settings and the drawer carries Sign
                out; keeping both here as 32px icons only crowded the one row that
                has to hold the timer and the bell. */}
            <button onClick={() => setView('settings')} title="Settings"
              className={`hidden h-9 w-9 shrink-0 place-items-center rounded-lg hover:bg-slate-800 hover:text-slate-200 lg:grid ${
                view === 'settings' ? 'text-[var(--accent)]' : 'text-slate-400'
              }`}>
              <Settings size={15} />
            </button>
            <button onClick={logout} title="Sign out"
              className="hidden h-9 w-9 shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-slate-200 lg:grid">
              <LogOut size={15} />
            </button>
          </div>
        </header>

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
          {view === 'takings' && <TakingsView businessId={businessId} />}
          {view === 'reports' && <ReportsView businessId={businessId} />}
          {view === 'billing' && <BillingView businessId={businessId} />}
          {view === 'collections' && <CollectionsView businessId={businessId} />}
          {view === 'cashflow' && <CashflowView businessId={businessId} />}
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
