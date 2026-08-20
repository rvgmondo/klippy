import { Home, Briefcase, Target, Wallet, Settings, type LucideIcon } from 'lucide-react';
import { areaOf } from './Sidebar';
import type { BusinessSelection } from './BusinessSwitcher';

/**
 * Phone navigation: the same five words as the desktop rail, so the phone is the
 * same product, not a re-mapping of it. Tapping an area lands on its default
 * screen; tapping the area you are already in opens the drawer, which carries the
 * area's second-level items and the boards tree.
 *
 * Hidden from lg upward, where the rail does this job.
 */
const TABS: { key: string; label: string; icon: LucideIcon; view: string }[] = [
  { key: 'home', label: 'Home', icon: Home, view: 'home' },
  { key: 'work', label: 'Work', icon: Briefcase, view: 'today' },
  { key: 'sales', label: 'Sales', icon: Target, view: 'pipeline' },
  { key: 'money', label: 'Money', icon: Wallet, view: 'billing' },
  { key: 'admin', label: 'Admin', icon: Settings, view: 'settings' },
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
          <button key={t.key} onClick={() => (on ? onOpenMore() : onNavigate(t.view))}
            className={`flex min-h-[52px] flex-1 flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition ${
              on ? 'text-[var(--accent)]' : 'text-slate-500 hover:text-slate-300'}`}>
            <Icon size={19} />
            {t.label}
          </button>
        );
      })}
    </nav>
  );
}
