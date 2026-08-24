import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { apiGet } from '../lib/api';
import { navigateTo } from '../lib/urlAction';
import { areaOf } from './Sidebar';
import type { Business } from '../lib/types';

/**
 * The one frame every screen wears.
 *
 * Three problems this replaces. Eight of fourteen screens had no title anywhere
 * on a desktop (the app header's view label is phone-only), so on Billing the
 * word "Billing" appeared nowhere on screen. Content widths drifted between
 * siblings (Billing max-w-5xl, Expenses max-w-4xl, Home max-w-6xl), so the
 * column visibly changed shape as you moved around one area. And the sibling
 * screens of an area lived in a 239px column off to the left which, on Home and
 * Admin, held nothing but a sentence of filler.
 *
 * So: the title, the area's sibling screens as tabs, and the primary action all
 * sit together at the top of the content, at one width, sticky on the screens
 * that scroll. The tabs put "Billing / Collections / Cash flow / Expenses"
 * directly above the thing they switch, which is both nearer the content and
 * 239px cheaper than a column.
 */
export function PageHeader({ view, title, subtitle, actions, children }: {
  /** Which view this is, so the sibling tabs and the current one are known. */
  view: string;
  title: ReactNode;
  subtitle?: ReactNode;
  /** The primary action. Stays reachable: on scrolling screens the bar sticks. */
  actions?: ReactNode;
  /** Filters, date ranges, stat strips: their own row under the title. */
  children?: ReactNode;
}) {
  const area = areaOf(view);
  const { data } = useQuery({
    queryKey: ['businesses'],
    queryFn: () => apiGet<{ businesses: Business[] }>('/businesses'),
    staleTime: 5 * 60 * 1000,
  });
  const { data: catalogue } = useQuery({
    queryKey: ['modules'],
    queryFn: () => apiGet<{ modules: { key: string; label: string }[] }>('/modules'),
    staleTime: 60 * 60 * 1000,
  });

  // Which of this area's screens this workspace actually uses. Same rule as the
  // rail: nothing resolved yet means show everything rather than an empty bar.
  const enabled = new Set((data?.businesses ?? []).flatMap((b) => b.modules ?? []));
  const labelOf = (k: string) => catalogue?.modules.find((m) => m.key === k)?.label ?? k;
  const tabs = area.modules
    .filter((k) => enabled.size === 0 || enabled.has(k))
    .map((k) => ({ key: k, label: labelOf(k) }));
  // Contacts is not a module (the people behind deals are always there), so it
  // rides along with Sales exactly as it does in the rail.
  if (area.key === 'sales') tabs.push({ key: 'contacts', label: 'Contacts' });

  return (
    <div className="sticky top-0 z-20 shrink-0 border-b border-slate-800 bg-slate-950/85 px-4 pt-4 backdrop-blur sm:px-6">
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <h1 className="font-display text-xl font-bold leading-tight text-slate-100 sm:text-2xl">{title}</h1>
            {subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
        </div>

        {children && <div className="mt-3">{children}</div>}

        {tabs.length > 1 ? (
          <nav className="-mb-px mt-3 flex gap-1 overflow-x-auto" aria-label={`${area.label} screens`}>
            {tabs.map((t) => {
              const on = t.key === view;
              return (
                <button key={t.key} onClick={() => navigateTo(t.key)}
                  aria-current={on ? 'page' : undefined}
                  className={`shrink-0 whitespace-nowrap border-b-2 px-3 pb-2.5 pt-1 text-sm ${
                    on
                      ? 'border-[var(--accent)] font-medium text-slate-100'
                      : 'border-transparent text-slate-500 hover:text-slate-200'}`}>
                  {t.label}
                </button>
              );
            })}
          </nav>
        ) : (
          <div className="h-4" />
        )}
      </div>
    </div>
  );
}

/**
 * The body every scrolling screen shares: one width, one padding, so moving
 * between two screens in the same area no longer changes the shape of the page.
 */
export function PageBody({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className="px-4 pb-8 pt-5 sm:px-6">
      <div className={`mx-auto max-w-6xl ${className}`}>{children}</div>
    </div>
  );
}

/** The scroll container a standard screen lives in. */
export function Page({ children }: { children: ReactNode }) {
  return <div className="h-full overflow-y-auto">{children}</div>;
}

/**
 * A screen whose content is a canvas that manages its own scrolling (a board, a
 * pipeline, a day plan). Same header, no page scroll.
 */
export function CanvasPage({ children }: { children: ReactNode }) {
  return <div className="flex h-full flex-col">{children}</div>;
}
