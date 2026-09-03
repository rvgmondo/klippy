import { useQuery } from '@tanstack/react-query';
import { TrendingUp, TrendingDown } from 'lucide-react';
import { apiGet } from '../lib/api';
import { Skeleton } from './ui';
import { money } from '../lib/money';
import type { BusinessSelection } from './BusinessSwitcher';

/**
 * Did this business make money.
 *
 * The question every owner actually has, and the one Klippy could not answer until
 * recently, because it only knew half of each side: revenue meant invoices, so a shop
 * selling over a counter appeared to earn nothing, and costs meant one-off expenses, so
 * every standing cost was missing.
 *
 * Four figures and no more. Earned, spent, kept, and what is earned but not yet in the
 * bank. That last one is the difference between a good month and a good month you can
 * spend, and leaving it out is how a business is surprised by its own balance.
 */

interface Row {
  businessId: number | null; name: string; currency: string;
  invoiced: number; taken: number; earned: number;
  expenses: number; fees: number; spent: number;
  profit: number; received: number; awaited: number; margin: number | null;
}

export function ProfitSection({ businessId, from, to }: {
  businessId: BusinessSelection; from: string; to: string;
}) {
  const only = businessId === 'all' ? '' : `&businessId=${businessId}`;
  const { data, isLoading } = useQuery({
    queryKey: ['profit', from, to, businessId],
    queryFn: () => apiGet<{ rows: Row[] }>(`/reports/profit?from=${from}&to=${to}${only}`),
    retry: false,
  });

  if (isLoading) return <Skeleton className="mb-5 h-32 rounded-xl" />;
  const rows = (data?.rows ?? []).filter((r) => r.earned !== 0 || r.spent !== 0);
  if (!rows.length) return null;

  return (
    <div className="mb-5 space-y-3">
      {rows.map((r) => {
        const up = r.profit >= 0;
        const fmt = (n: number) => money(n, r.currency);
        return (
          <div key={`${r.businessId}:${r.currency}`}
            className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
            <div className="mb-3 flex flex-wrap items-baseline gap-2">
              <h3 className="text-sm font-semibold text-slate-200">
                {businessId === 'all' ? r.name : 'What you kept'}
              </h3>
              {businessId === 'all' && <span className="text-[11px] text-slate-500">{r.currency}</span>}
              <div className="flex-1" />
              {r.margin != null && (
                <span className={`text-xs ${up ? 'text-emerald-400' : 'text-red-400'}`}>
                  {r.margin}% margin
                </span>
              )}
            </div>

            <div className="grid gap-3 sm:grid-cols-4">
              <Figure label="Earned" value={fmt(r.earned)}
                hint={r.taken > 0 && r.invoiced > 0
                  ? `${fmt(r.invoiced)} invoiced, ${fmt(r.taken)} over the counter`
                  : r.taken > 0 ? 'all over the counter' : 'all invoiced'} />
              <Figure label="Spent" value={fmt(r.spent)} warn
                hint={r.fees > 0 ? `includes ${fmt(r.fees)} in card and gateway fees` : undefined} />
              <Figure
                label={up ? 'Kept' : 'Lost'}
                value={fmt(Math.abs(r.profit))}
                accent={up}
                bad={!up}
                icon={up ? <TrendingUp size={13} /> : <TrendingDown size={13} />} />
              {/* The gap between a good month and a good month you can spend. */}
              <Figure label="Still owed to you" value={fmt(r.awaited)}
                hint={r.awaited > 0.005 ? 'earned, not yet in the bank' : 'all of it has landed'} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Figure({ label, value, hint, warn, accent, bad, icon }: {
  label: string; value: string; hint?: string;
  warn?: boolean; accent?: boolean; bad?: boolean; icon?: React.ReactNode;
}) {
  const tone = bad ? 'border-red-500/30 bg-red-500/[0.06]'
    : accent ? 'border-emerald-500/30 bg-emerald-500/[0.06]'
      : warn ? 'border-amber-500/25 bg-amber-500/[0.05]'
        : 'border-slate-800 bg-slate-900/40';
  const ink = bad ? 'text-red-300' : accent ? 'text-emerald-300' : warn ? 'text-amber-300' : 'text-slate-100';
  return (
    <div className={`rounded-lg border p-3 ${tone}`}>
      <div className="flex items-center gap-1 text-[11px] uppercase tracking-wide text-slate-500">
        {icon}{label}
      </div>
      <div className={`num mt-1 text-lg font-semibold ${ink}`}>{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-slate-500">{hint}</div>}
    </div>
  );
}
