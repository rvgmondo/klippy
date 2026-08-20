import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDelete, apiGet, apiPut } from '../lib/api';
import { Skeleton } from './ui';

/**
 * One answer to "what can this person touch?".
 *
 * Account role, per-business access and team membership used to live on three
 * unconnected screens, so auditing one person meant a tour. This grid shows every
 * person against every business, editable in place. Owners and admins bypass
 * per-business access entirely (that is what those roles mean), so their row says
 * so instead of offering switches that would do nothing.
 */
interface Person {
  userId: number; name: string; email: string; role: 'owner' | 'admin' | 'member'; isActive: boolean;
  access: { businessId: number; role: 'admin' | 'member' | 'viewer' }[];
  teams: { id: number; name: string; color: string }[];
}

const LEVELS = ['none', 'viewer', 'member', 'admin'] as const;

export function AccessGrid() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['access-grid'],
    queryFn: () => apiGet<{ businesses: { id: number; name: string }[]; people: Person[] }>('/access-grid'),
  });

  const setAccess = useMutation({
    mutationFn: (v: { businessId: number; userId: number; role: string }) =>
      v.role === 'none'
        ? apiDelete(`/businesses/${v.businessId}/members/${v.userId}`)
        : apiPut(`/businesses/${v.businessId}/members/${v.userId}`, { role: v.role }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['access-grid'] }),
  });

  if (isLoading) return <div className="mt-6 space-y-2"><Skeleton className="h-8" /><Skeleton className="h-8" /></div>;
  const businesses = data?.businesses ?? [];
  const people = (data?.people ?? []).filter((p) => p.isActive);
  if (businesses.length < 2 && people.length < 2) return null; // nothing to partition yet

  return (
    <div className="mt-8 border-t border-slate-800 pt-6">
      <h3 className="text-sm font-semibold text-slate-200">Who can work where</h3>
      <p className="mb-4 mt-0.5 text-xs text-slate-500">
        Owners and admins can work in every business. A member's access is per business:
        none, viewer (read only), member (can work), or admin of that business.
      </p>
      <div className="overflow-x-auto rounded-xl border border-slate-800">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-800 text-left text-[11px] uppercase tracking-wide text-slate-500">
              <th scope="col" className="px-3 py-2">Person</th>
              {businesses.map((b) => <th scope="col" key={b.id} className="px-3 py-2">{b.name}</th>)}
              <th scope="col" className="px-3 py-2">Teams</th>
            </tr>
          </thead>
          <tbody>
            {people.map((p) => (
              <tr key={p.userId} className="border-b border-slate-800/60 align-top last:border-0">
                <td className="px-3 py-2.5">
                  <div className="font-medium text-slate-200">{p.name}</div>
                  <div className="text-[11px] text-slate-500">{p.role}</div>
                </td>
                {businesses.map((b) => {
                  const grant = p.access.find((a) => a.businessId === b.id);
                  const elevated = p.role === 'owner' || p.role === 'admin';
                  return (
                    <td key={b.id} className="px-3 py-2.5">
                      {elevated ? (
                        <span className="text-xs text-slate-500">Full access</span>
                      ) : (
                        <select
                          value={grant?.role ?? 'none'}
                          onChange={(e) => setAccess.mutate({ businessId: b.id, userId: p.userId, role: e.target.value })}
                          disabled={setAccess.isPending}
                          className="rounded-lg border border-slate-700 bg-slate-900/70 px-2 py-1 text-xs text-slate-100 outline-none focus:border-[var(--accent)]">
                          {LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
                        </select>
                      )}
                    </td>
                  );
                })}
                <td className="px-3 py-2.5">
                  <div className="flex flex-wrap gap-1">
                    {p.teams.length === 0 && <span className="text-xs text-slate-600">None</span>}
                    {p.teams.map((t) => (
                      <span key={t.id} className="inline-flex items-center gap-1 rounded-md border border-slate-700 px-1.5 py-0.5 text-[11px] text-slate-300">
                        <span className="h-2 w-2 rounded-full" style={{ background: t.color }} />
                        {t.name}
                      </span>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
