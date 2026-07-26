import { useState } from 'react';
import { LayoutGrid, CalendarDays, Timer, LogOut, Home, Settings, Menu as MenuIcon, X, HardDrive, BarChart3, Receipt, Target } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { Sidebar } from '../components/Sidebar';
import { BoardView } from '../components/BoardView';
import { CalendarView } from '../components/CalendarView';
import { FilesView } from '../components/FilesView';
import { ReportsView } from '../components/ReportsView';
import { BillingView } from '../components/BillingView';
import { PipelineView } from '../components/PipelineView';
import { DashboardView } from '../components/DashboardView';
import { FocusTimer } from '../components/FocusTimer';
import { TimerChip } from '../components/TimerChip';
import { SettingsModal } from '../components/SettingsModal';
import { SearchBar } from '../components/SearchBar';
import { WorkspaceSwitcher } from '../components/WorkspaceSwitcher';

type View = 'home' | 'pipeline' | 'board' | 'calendar' | 'files' | 'reports' | 'billing';

export function Workspace() {
  const { user, account, logout } = useAuth();
  const [boardId, setBoardId] = useState<number | null>(null);
  const [view, setView] = useState<View>('home');
  const [showTimer, setShowTimer] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [navOpen, setNavOpen] = useState(false);

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

          <div className="hidden sm:block"><WorkspaceSwitcher /></div>

          <div className="flex shrink-0 items-center gap-1 rounded-lg bg-slate-900 p-1">
            <TabButton active={view === 'home'} onClick={() => setView('home')} icon={<Home size={15} />} label="Home" />
            <TabButton active={view === 'pipeline'} onClick={() => setView('pipeline')} icon={<Target size={15} />} label="Pipeline" />
            <TabButton active={view === 'board'} onClick={() => setView('board')} icon={<LayoutGrid size={15} />} label="Board" />
            <TabButton active={view === 'calendar'} onClick={() => setView('calendar')} icon={<CalendarDays size={15} />} label="Calendar" />
            <TabButton active={view === 'files'} onClick={() => setView('files')} icon={<HardDrive size={15} />} label="Files" />
            <TabButton active={view === 'reports'} onClick={() => setView('reports')} icon={<BarChart3 size={15} />} label="Reports" />
            <TabButton active={view === 'billing'} onClick={() => setView('billing')} icon={<Receipt size={15} />} label="Billing" />
          </div>

          <div className="ml-auto flex min-w-0 items-center gap-1.5 sm:gap-3">
            <div className="hidden min-w-0 md:block"><SearchBar /></div>
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

        {/* Search on small screens sits under the bar so it stays usable */}
        <div className="border-b border-slate-800 px-2 py-2 md:hidden">
          <SearchBar />
        </div>

        <main className="min-h-0 flex-1 overflow-hidden pb-safe pr-safe">
          {view === 'home' && <DashboardView onNavigate={(v) => setView(v as View)} />}
          {view === 'pipeline' && <PipelineView onGoToClients={() => setView('board')} />}
          {view === 'board' && <BoardView boardId={boardId} />}
          {view === 'calendar' && <CalendarView />}
          {view === 'files' && <FilesView />}
          {view === 'reports' && <ReportsView />}
          {view === 'billing' && <BillingView />}
        </main>
      </div>

      {showTimer && <FocusTimer onClose={() => setShowTimer(false)} />}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  );
}

function TabButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button onClick={onClick} title={label}
      className={`flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition sm:px-3 ${
        active ? 'bg-slate-700 text-slate-100' : 'text-slate-400 hover:text-slate-200'}`}>
      {icon} <span className="hidden sm:inline">{label}</span>
    </button>
  );
}
