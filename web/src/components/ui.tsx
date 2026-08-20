import type { ReactNode } from 'react';

/**
 * The shared UI primitives: one place each visual decision is made.
 *
 * The design system used to stop at CSS variables. Every screen hand-copied its
 * own input class, and by the time there were 25 copies they had drifted three
 * ways (background, padding, focus colour), with one screen dropping its focus
 * ring entirely, which is a WCAG failure invisible until a keyboard user hits it.
 * That is precisely the module-to-module inconsistency a single codebase exists to
 * prevent, forming from the inside.
 *
 * Class constants rather than only components, deliberately: most call sites
 * compose (`field + ' col-span-6'`), and a string keeps that migration mechanical.
 * New code should prefer the components below.
 */

/** The one input look. Focus ring included, always. */
export const fieldClass = 'w-full rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-[var(--accent)] disabled:opacity-50';
/** The same, sized to sit inline rather than fill its parent. */
export const fieldInlineClass = 'rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-[var(--accent)] disabled:opacity-50';
/** Compact filter-bar inputs (dates, small selects). */
export const fieldCompactClass = 'rounded-lg border border-slate-700 bg-slate-900/70 px-2 py-1 text-xs text-slate-100 outline-none focus:border-[var(--accent)]';

/** The one primary button look; `btnSecondary` for the quiet twin. */
export const btnPrimary = 'rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-ink)] hover:opacity-90 disabled:opacity-50';
export const btnSecondary = 'rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-50';

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-slate-800 bg-slate-900/40 p-4 ${className}`}>{children}</div>;
}

export function Tile({ label, value, accent, warn, hint }: {
  label: string; value: string; accent?: boolean; warn?: boolean; hint?: string;
}) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
      <div className="mb-1 text-xs text-slate-400">{label}</div>
      <div className={`num text-2xl font-semibold ${warn ? 'text-red-400' : accent ? 'text-violet-300' : 'text-slate-100'}`}>{value}</div>
      {hint && <div className="num mt-1 text-[11px] text-slate-500">{hint}</div>}
    </div>
  );
}

/**
 * A loading state that looks like loading, not like zero.
 *
 * Dashboards used to fall back to `?? 0` while fetching, flashing "R 0 revenue" at
 * whoever opened the app, which reads as bad news rather than as a wait. A shimmer
 * says "still counting" and announces busy to a screen reader.
 */
export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div role="status" aria-label="Loading"
      className={`animate-pulse rounded-lg bg-slate-800/70 ${className}`} />
  );
}

export function SkeletonTile() {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
      <Skeleton className="mb-2 h-3 w-20" />
      <Skeleton className="h-7 w-24" />
    </div>
  );
}

/**
 * An empty state that is an on-ramp, not a shrug.
 *
 * Fifteen screens said "No X yet." and stopped. An empty screen is the one moment
 * the user is guaranteed to be reading, so it gets an icon, one line of why this
 * screen matters, and the button that starts it.
 */
export function EmptyState({ icon, title, body, actionLabel, onAction }: {
  icon?: ReactNode; title: string; body?: string;
  actionLabel?: string; onAction?: () => void;
}) {
  return (
    <div className="rounded-xl border border-dashed border-slate-700 p-8 text-center">
      {icon && <div className="mb-3 flex justify-center text-slate-600">{icon}</div>}
      <p className="text-sm font-medium text-slate-300">{title}</p>
      {body && <p className="mx-auto mt-1 max-w-sm text-xs text-slate-500">{body}</p>}
      {actionLabel && onAction && (
        <button onClick={onAction} className={`${btnPrimary} mt-4`}>{actionLabel}</button>
      )}
    </div>
  );
}
