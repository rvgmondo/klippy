import { useState } from 'react';
import { LayoutGrid, CalendarDays, Timer, LogOut, Home, Settings } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { Sidebar } from '../components/Sidebar';
import { BoardView } from '../components/BoardView';
import { CalendarView } from '../components/CalendarView';
import { DashboardView } from '../components/DashboardView';
import { FocusTimer } from '../components/FocusTimer';
import { TimerChip } from '../components/TimerChip';
import { SettingsModal } from '../components/SettingsModal';
import { SearchBar } from '../components/SearchBar';

type View = 'home' | 'board' | 'calendar';

export function Workspace() {
  const { user, account, logout } = useAuth();
  const [boardId, setBoardId] = useState<number | null>(null);
  const [view, setView] = useState<View>('home');
  const [showTimer, setShowTimer] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  return (
    <div className="flex h-full">
      <Sidebar selectedBoardId={boardId} onSelectBoard={(id) => { setBoardId(id); setView('board'); }} />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar */}
        <header className="flex h-14 items-center justify-between border-b border-slate-800 px-4">
          <div className="flex items-center gap-1 rounded-lg bg-slate-900 p-1">
            <TabButton active={view === 'home'} onClick={() => setView('home')} icon={<Home size={15} />} label="Home" />
            <TabButton active={view === 'board'} onClick={() => setView('board')} icon={<LayoutGrid size={15} />} label="Board" />
            <TabButton active={view === 'calendar'} onClick={() => setView('calendar')} icon={<CalendarDays size={15} />} label="Calendar" />
          </div>
          <div className="flex items-center gap-3">
            <SearchBar />
            <TimerChip />
            <button onClick={() => setShowTimer(true)}
              className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-slate-800">
              <Timer size={14} /> Focus
            </button>
            <div className="text-right">
              <div className="text-xs font-medium text-slate-200">{user?.name}</div>
              <div className="text-[11px] text-slate-500">{account?.name}</div>
            </div>
            <button onClick={() => setShowSettings(true)} title="Workspace settings"
              className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-slate-200">
              <Settings size={15} />
            </button>
            <button onClick={logout} title="Sign out"
              className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-slate-200">
              <LogOut size={15} />
            </button>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-hidden">
          {view === 'home' && <DashboardView />}
          {view === 'board' && <BoardView boardId={boardId} />}
          {view === 'calendar' && <CalendarView />}
        </main>
      </div>

      {showTimer && <FocusTimer onClose={() => setShowTimer(false)} />}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  );
}

function TabButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button onClick={onClick}
      className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition ${
        active ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-slate-200'}`}>
      {icon} {label}
    </button>
  );
}

