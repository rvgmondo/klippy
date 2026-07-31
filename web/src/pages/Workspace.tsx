import { useEffect, useState } from 'react';
import { Timer, LogOut, Settings, Menu as MenuIcon, X } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { apiPost } from '../lib/api';
import { Sidebar } from '../components/Sidebar';
import { BoardView } from '../components/BoardView';
import { CalendarView } from '../components/CalendarView';
import { FilesView } from '../components/FilesView';
import { ReportsView } from '../components/ReportsView';
import { BillingView } from '../components/BillingView';
import { TodayView } from '../components/TodayView';
import { OfferingsView } from '../components/OfferingsView';
import { ExpensesView } from '../components/ExpensesView';
import { PipelineView } from '../components/PipelineView';
import { DashboardView } from '../components/DashboardView';
import { FocusTimer } from '../components/FocusTimer';
import { TimerChip } from '../components/TimerChip';
import { SettingsModal } from '../components/SettingsModal';
import { SearchBar } from '../components/SearchBar';
import type { BusinessSelection } from '../components/BusinessSwitcher';

type View = 'home' | 'today' | 'pipeline' | 'board' | 'calendar' | 'files' | 'offerings' | 'expenses' | 'reports' | 'billing';

const VIEW_LABELS: Record<View, string> = {
  home: 'Home', pipeline: 'Pipeline', board: 'Board', calendar: 'Calendar',
  today: 'Today', files: 'Files', offerings: 'Offerings', expenses: 'Expenses', reports: 'Reports', billing: 'Billing',
};
const viewLabel = (v: View) => VIEW_LABELS[v] ?? '';

function loadBusiness(): BusinessSelection {
  const s = localStorage.getItem('klippy.business');
  if (!s || s === 'all') return 'all';
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : 'all';
}

export function Workspace() {
  const { user, account, logout } = useAuth();
  const [boardId, setBoardId] = useState<number | null>(null);
  const [view, setView] = useState<View>('home');
  const [showTimer, setShowTimer] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [businessId, setBusinessId] = useState<BusinessSelection>(loadBusiness);
  const selectBusiness = (v: BusinessSelection) => { setBusinessId(v); localStorage.setItem('klippy.business', String(v)); };

  // Nudge the daily jobs whenever the app is opened. Shared hosting stops an idle
  // server, so simply using Klippy (including the installed app on a phone) is what
  // keeps invoicing and reminders moving, with no cron to set up. Cheap and
  // idempotent: it does nothing once the day's runs are already recorded.
  useEffect(() => {
    apiPost('/automation/tick').catch(() => { /* never block the app on this */ });
  }, []);

  return (
    <div className="flex h-full">
      {/* Sidebar: fixed drawer under lg, static column at lg+ */}
      <div
        className={`fixed inset-y-0 left-0 z-40 w-64 transform bg-slate-950 pt-safe pl-safe transition-transform duration-200 lg:static lg:z-auto lg:translate-x-0 ${
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
            <div className="hidden min-w-0 flex-1 sm:block sm:max-w-xs"><SearchBar /></div>
            <TimerChip />
            <button onClick={() => setShowTimer(true)} title="Focus timer"
              className="flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-700 px-2 py-1.5 text-xs text-slate-300 hover:bg-slate-800 sm:px-2.5">
              <Timer size={14} /> <span className="hidden sm:inline">Focus</span>
            </button>
            <div className="hidden text-right lg:block">
              <div className="text-xs font-medium text-slate-200">{user?.name}</div>
              <div className="text-[11px] text-slate-500">{account?.name}</div>
            </div>
            <button onClick={() => setShowSettings(true)} title="Settings"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-slate-200">
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
          <SearchBar />
        </div>

        <main className="min-h-0 flex-1 overflow-hidden pb-safe pr-safe">
          {view === 'home' && <DashboardView businessId={businessId} onNavigate={(v) => setView(v as View)} onPickBusiness={selectBusiness} />}
          {view === 'today' && <TodayView businessId={businessId} onNavigate={(v) => setView(v as View)} />}
          {view === 'pipeline' && <PipelineView businessId={businessId} onGoToClients={() => setView('board')} />}
          {view === 'board' && <BoardView boardId={boardId} />}
          {view === 'calendar' && <CalendarView />}
          {view === 'files' && <FilesView />}
          {view === 'offerings' && <OfferingsView businessId={businessId} />}
          {view === 'expenses' && <ExpensesView businessId={businessId} />}
          {view === 'reports' && <ReportsView businessId={businessId} />}
          {view === 'billing' && <BillingView businessId={businessId} />}
        </main>
      </div>

      {showTimer && <FocusTimer onClose={() => setShowTimer(false)} />}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  );
}
