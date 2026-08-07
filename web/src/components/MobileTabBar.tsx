import { useQuery } from '@tanstack/react-query';
import { Home, CalendarCheck, Receipt, SquareKanban, MoreHorizontal, type LucideIcon } from 'lucide-react';
import { apiGet } from '../lib/api';
import type { Business } from '../lib/types';
import type { BusinessSelection } from './BusinessSwitcher';

/**
 * Phone navigation.
 *
 * On a phone every screen was behind a hamburger, which is one tap too many for
 * the handful of places you actually go. The four you use daily sit at the bottom
 * where a thumb reaches, and More opens the full drawer for everything else.
 *
 * Hidden from lg upward, where the sidebar does this job properly.
 */
const TABS: { key: string; label: string; icon: LucideIcon }[] = [
  { key: 'home', label: 'Home', icon: Home },
  { key: 'today', label: 'Today', icon: CalendarCheck },
  { key: 'board', label: 'Boards', icon: SquareKanban },
  { key: 'billing', label: 'Billing', icon: Receipt },
];

export function MobileTabBar({ view, businessId, onNavigate, onOpenMore }: {
  view: string;
  businessId: BusinessSelection;
  onNavigate: (v: string) => void;
  onOpenMore: () => void;
}) {
  // Only offer tabs this business actually uses, so a shop is not sent to a
  // screen it switched off.
  const { data } = useQuery({
    queryKey: ['businesses'],
    queryFn: () => apiGet<{ businesses: Business[] }>('/businesses'),
  });
  const enabled = new Set(
    businessId === 'all'
      ? (data?.businesses ?? []).flatMap((b) => b.modules ?? [])
      : (data?.businesses ?? []).find((b) => b.id === businessId)?.modules ?? [],
  );
  // 'home' and 'board' are not modules; they are always available.
  const tabs = TABS.filter((t) => t.key === 'home' || t.key === 'board' || enabled.size === 0 || enabled.has(t.key));

  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t border-slate-800 bg-slate-950/95 pb-safe backdrop-blur lg:hidden">
      {tabs.map((t) => {
        const Icon = t.icon;
        const active = view === t.key;
        return (
          <button key={t.key} onClick={() => onNavigate(t.key)}
            className={`flex min-h-[52px] flex-1 flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition ${
              active ? 'text-[var(--accent)]' : 'text-slate-500 hover:text-slate-300'}`}>
            <Icon size={19} />
            {t.label}
          </button>
        );
      })}
      <button onClick={onOpenMore}
        className="flex min-h-[52px] flex-1 flex-col items-center justify-center gap-0.5 text-[10px] font-medium text-slate-500 hover:text-slate-300">
        <MoreHorizontal size={19} />
        More
      </button>
    </nav>
  );
}
