import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../lib/api';
import { Skeleton } from './ui';

/**
 * The Connections roll-up: what each business ACTUALLY resolves to.
 *
 * Per-business overrides for payments, hosting and email are correct for separate
 * legal entities, but scattered forms cannot show a mis-wiring. This table can:
 * each business, its effective merchant account, hosting server and sender, and
 * whether that is its own or inherited from the workspace. Money or a client site
 * landing in the wrong entity is a silent, expensive error only a roll-up kills.
 */
interface Row {
  businessId: number; name: string;
  payments: { scope: 'own' | 'workspace' | 'none'; enabled: boolean; merchantId: string | null };
  hosting: { scope: 'own' | 'workspace' | 'none'; enabled: boolean; live: boolean; host: string | null };
  email: { scope: 'own' | 'workspace' | 'none'; from: string | null };
}

function ScopeCell({ scope, detail, on }: { scope: 'own' | 'workspace' | 'none'; detail?: string | null; on?: boolean }) {
  if (scope === 'none') return <span className="text-xs text-slate-600">Not set up</span>;
  return (
    <span className="text-xs">
      <span className={on === false ? 'text-amber-400' : 'text-slate-200'}>
        {detail || (scope === 'own' ? 'Configured' : 'Workspace default')}
      </span>
      <span className="ml-1.5 text-slate-500">({scope === 'own' ? 'own' : 'inherited'}{on === false ? ', off' : ''})</span>
    </span>
  );
}

export function ConnectionsPanel() {
  const { data, isLoading } = useQuery({
    queryKey: ['connections'],
    queryFn: () => apiGet<{ businesses: Row[] }>('/connections'),
  });

  if (isLoading) return <div className="space-y-2"><Skeleton className="h-8" /><Skeleton className="h-8" /><Skeleton className="h-8" /></div>;
  const rows = data?.businesses ?? [];

  return (
    <div>
      <p className="mb-4 text-xs text-slate-500">
        Where each business's money, hosting and email actually go. "Inherited" means it
        uses the workspace default; configure a business's own under its settings on the left.
      </p>
      <div className="overflow-x-auto rounded-xl border border-slate-800">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-800 text-left text-[11px] uppercase tracking-wide text-slate-500">
              <th scope="col" className="px-3 py-2">Business</th>
              <th scope="col" className="px-3 py-2">Payments go to</th>
              <th scope="col" className="px-3 py-2">Hosting created on</th>
              <th scope="col" className="px-3 py-2">Email sent as</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.businessId} className="border-b border-slate-800/60 last:border-0">
                <td className="px-3 py-2.5 font-medium text-slate-200">{r.name}</td>
                <td className="px-3 py-2.5">
                  <ScopeCell scope={r.payments.scope} on={r.payments.enabled}
                    detail={r.payments.merchantId ? `PayFast ${r.payments.merchantId}` : null} />
                </td>
                <td className="px-3 py-2.5">
                  <ScopeCell scope={r.hosting.scope} on={r.hosting.enabled}
                    detail={r.hosting.host ? `${r.hosting.host}${r.hosting.live ? '' : ' (dry run)'}` : null} />
                </td>
                <td className="px-3 py-2.5">
                  <ScopeCell scope={r.email.scope} detail={r.email.from} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
