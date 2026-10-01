import { Home, Briefcase, Users, Wallet, Menu, type LucideIcon } from 'lucide-react';
import { areaOf } from './Sidebar';
import type { BusinessSelection } from './BusinessSwitcher';

/**
 * Phone navigation: the four doors used every day, plus Menu for the rest. The
 * drawer behind Menu carries Sales, Settings, the area's own screens and the
 * boards tree.
 *
 * Hidden from lg upward, where the rail does this job.
 */
const TABS: { key: string; label: string; icon: LucideIcon; view: string }[] = [
  { key: 'home', label: 'Home', icon: Home, view: 'home' },
  { key: 'clients', label: 'Clients', icon: Users, view: 'clients' },
  { key: 'work', label: 'Work', icon: Briefcase, view: 'today' },
  { key: 'money', label: 'Money', icon: Wallet, view: 'billing' },
];

export function MobileTabBar({ view, onNavigate, onOpenMore }: {
  view: string;
  businessId: BusinessSelection;
  onNavigate: (v: string) => void;
  onOpenMore: () => void;
}) {
  const active = areaOf(view).key;
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t border-slate-800 bg-slate-950/95 pb-safe backdrop-blur lg:hidden">
      {TABS.map((t) => {
        const Icon = t.icon;
        const on = active === t.key;
        return (
          <button key={t.key} onClick={() => onNavigate(t.view)}
            className={`flex min-h-[52px] flex-1 flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition ${
              on ? 'text-[var(--accent)]' : 'text-slate-500 hover:text-slate-300'}`}>
            <Icon size={19} />
            {t.label}
          </button>
        );
      })}
      {/* Sales, Settings and everything inside an area live behind Menu, so the four
          doors used every day stay one thumb away. */}
      <button onClick={onOpenMore}
        className={`flex min-h-[52px] flex-1 flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition ${
          active === 'sales' || active === 'settings' ? 'text-[var(--accent)]' : 'text-slate-500 hover:text-slate-300'}`}>
        <Menu size={19} />
        Menu
      </button>
    </nav>
  );
}
