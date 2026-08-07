import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPatch, apiPost, apiDelete } from '../lib/api';
import { ErrorNote } from './ErrorNote';

interface Configured {
  whmHost: string; whmUser: string; hasToken: boolean;
  allowSelfSigned: boolean; enabled: boolean; live: boolean;
  suspendAfterDays: number | null; warnBeforeDays: number;
}
interface Status {
  configured: Configured;
  source: 'own' | 'workspace' | 'none';
  effectiveHost: string;
  serverReady: boolean;
}
interface TestResult { ok: boolean; message: string; packages: string[] }

/**
 * Connecting Klippy to the WHM server that creates hosting accounts.
 *
 * Deliberately WHM and not WHMCS. WHMCS is a billing system, and Klippy already
 * bills: invoices, recurring cycles, PayFast, reminders. Putting WHMCS in the middle
 * would mean two systems invoicing the same client. WHM is the layer underneath that
 * just makes accounts, which was the only missing piece.
 */
export function HostingPanel({ businessId }: { businessId?: number } = {}) {
  const qc = useQueryClient();
  const base = businessId ? `/businesses/${businessId}/hosting` : '/account/hosting';
  const { data, error, refetch } = useQuery({
    queryKey: ['hosting', businessId ?? 0], queryFn: () => apiGet<Status>(base), retry: false,
  });

  const [host, setHost] = useState('');
  const [user, setUser] = useState('root');
  const [token, setToken] = useState('');
  const [selfSigned, setSelfSigned] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);

  useEffect(() => {
    if (data && !loaded) {
      setHost(data.configured.whmHost);
      setUser(data.configured.whmUser || 'root');
      setSelfSigned(data.configured.allowSelfSigned);
      setLoaded(true);
    }
  }, [data, loaded]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['hosting'] });
  const save = useMutation({
    mutationFn: (patch?: Record<string, unknown>) => apiPatch(base, patch ?? {
      whmHost: host, whmUser: user, allowSelfSigned: selfSigned,
      ...(token ? { whmToken: token } : {}),
    }),
    onSuccess: () => { setToken(''); setSaved(true); setTimeout(() => setSaved(false), 2000); invalidate(); },
  });
  const useWorkspace = useMutation({
    mutationFn: () => apiDelete(base),
    onSuccess: () => { setLoaded(false); invalidate(); },
  });
  const runTest = useMutation({
    mutationFn: () => apiPost<TestResult>('/hosting/test', {
      ...(businessId ? { businessId } : {}),
      whmHost: host, whmUser: user, allowSelfSigned: selfSigned,
      ...(token ? { whmToken: token } : {}),
    }),
    onSuccess: (r) => setTest(r),
    onError: (e) => setTest({ ok: false, message: e instanceof Error ? e.message : 'Test failed.', packages: [] }),
  });

  if (error) return <ErrorNote error={error} onRetry={() => refetch()} />;
  if (!data) return <p className="text-sm text-slate-500">Loading...</p>;

  const field = 'w-full rounded-lg bg-slate-900/70 border border-slate-700 px-3 py-2.5 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-[var(--accent)]';
  const label = 'mb-1 block text-xs font-medium text-slate-400';
  const c = data.configured;

  return (
    <div className="space-y-5">
      <p className="text-xs text-slate-500">
        When a client pays an invoice for a hosting offering, Klippy creates the cPanel account on your
        server and emails them the login. Set the offering to provision hosting, and put the domain on
        the subscription.
      </p>

      {businessId && (
        <div className={`rounded-xl border p-3 text-xs ${
          data.source === 'own' ? 'border-slate-700 bg-slate-800/40 text-slate-300'
            : 'border-sky-500/30 bg-sky-500/10 text-sky-300'}`}>
          {data.source === 'own' ? (
            <>
              This business provisions on <span className="text-slate-100">{data.effectiveHost || 'not enabled'}</span>.
              <button onClick={() => useWorkspace.mutate()} disabled={useWorkspace.isPending}
                className="ml-2 underline hover:text-slate-100 disabled:opacity-50">
                Use the workspace server instead
              </button>
            </>
          ) : data.source === 'workspace' ? (
            <>Using the workspace server, <span>{data.effectiveHost || 'not enabled'}</span>. Fill this in to give
              this business its own.</>
          ) : (
            <>No server set up yet, here or on the workspace.</>
          )}
        </div>
      )}

      {!data.serverReady && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">
          The server cannot store secrets yet. Add <span className="text-red-200">PAYMENTS_SECRET</span> to the app
          environment and restart before entering your API token.
        </div>
      )}

      <div>
        <label className={label}>WHM hostname</label>
        <input className={field} value={host} onChange={(e) => setHost(e.target.value)} placeholder="server.yourhost.co.za" />
        <p className="mt-1 text-[11px] text-slate-500">Just the hostname. Klippy uses port 2087.</p>
      </div>
      <div>
        <label className={label}>WHM username</label>
        <input className={field} value={user} onChange={(e) => setUser(e.target.value)} placeholder="root" />
      </div>
      <div>
        <label className={label}>API token</label>
        <input type="password" className={field} value={token} onChange={(e) => setToken(e.target.value)}
          placeholder={c.hasToken ? 'Set. Leave blank to keep it.' : 'From WHM > Manage API Tokens'} />
        <p className="mt-1 text-[11px] text-slate-500">
          A WHM token has enormous power over that server, so give it only the privileges it needs:
          create accounts, suspend and unsuspend. It is stored encrypted and never shown again.
        </p>
      </div>

      <label className="flex items-center gap-2 text-sm text-slate-300">
        <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={selfSigned}
          onChange={(e) => setSelfSigned(e.target.checked)} />
        Allow a self-signed certificate
      </label>
      <p className="-mt-3 text-[11px] text-slate-500">
        Many WHM servers serve port 2087 with their own certificate. Only tick this if you know that is
        the case for yours, since it turns off the check that you are talking to the right server.
      </p>

      <div className="flex flex-wrap items-center gap-3 border-t border-slate-800 pt-4">
        <button onClick={() => save.mutate(undefined)} disabled={save.isPending || !data.serverReady}
          className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-ink)] hover:opacity-90 disabled:opacity-60">
          {save.isPending ? 'Saving...' : 'Save'}
        </button>
        <button onClick={() => runTest.mutate()} disabled={runTest.isPending || !host}
          className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-50">
          {runTest.isPending ? 'Testing...' : 'Test connection'}
        </button>
        {saved && <span className="text-sm text-violet-300">Saved</span>}
      </div>
      {save.error && <ErrorNote error={save.error} />}

      {test && (
        <div className={`rounded-xl border p-3 text-xs ${
          test.ok ? 'border-green-500/25 bg-green-500/5 text-green-300' : 'border-red-500/25 bg-red-500/5 text-red-300'}`}>
          {test.message}
          {test.ok && test.packages.length > 0 && (
            <div className="mt-1.5 text-slate-400">
              Packages on this server: <span className="text-slate-200">{test.packages.join(', ')}</span>.
              Use one of these names on the offering.
            </div>
          )}
        </div>
      )}

      <div className="space-y-3 border-t border-slate-800 pt-4">
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={c.enabled}
            disabled={save.isPending}
            onChange={(e) => save.mutate({ enabled: e.target.checked })} />
          Provision hosting from paid invoices
        </label>

        {c.enabled && (
          <>
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
              Klippy has never created an account on this server. Leave dry run on until you have watched
              one billing run list the right domains and usernames. In dry run nothing is created on the
              server: each run writes down what it would have done.
              <span className="mt-1.5 block text-amber-200/80">
                Klippy suspends and restores accounts, but never deletes one. Terminating hosting destroys
                a customer's site and mail, so that stays a decision you make in WHM yourself.
              </span>
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={c.live}
                disabled={save.isPending}
                onChange={(e) => save.mutate({ live: e.target.checked })} />
              <span className={c.live ? 'text-red-300' : ''}>
                {c.live ? 'Live: accounts are really created' : 'Dry run: write down what it would create, create nothing'}
              </span>
            </label>
          </>
        )}
      </div>

      {c.enabled && (
        <div className="space-y-3 border-t border-slate-800 pt-4">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              Suspending unpaid hosting
            </div>
            <p className="mt-0.5 text-[11px] text-slate-500">
              Only counts invoices from the subscription that owns the hosting, so an unpaid consulting
              invoice never takes a website down. Off unless you set a number of days.
            </p>
          </div>

          <label className="flex items-center gap-2 text-sm text-slate-300">
            <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]"
              checked={c.suspendAfterDays != null} disabled={save.isPending}
              onChange={(e) => save.mutate({ suspendAfterDays: e.target.checked ? 14 : null })} />
            Suspend hosting when an invoice goes unpaid
          </label>

          {c.suspendAfterDays != null && (
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className={label}>Days overdue before suspending</label>
                <input inputMode="numeric" defaultValue={String(c.suspendAfterDays)}
                  onBlur={(e) => {
                    const v = Number(e.target.value);
                    if (v >= 1 && v <= 365 && v !== c.suspendAfterDays) save.mutate({ suspendAfterDays: v });
                  }}
                  className="w-24 rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-2 text-sm num text-slate-100 outline-none focus:border-[var(--accent)]" />
              </div>
              <div>
                <label className={label}>Warn this many days first</label>
                <input inputMode="numeric" defaultValue={String(c.warnBeforeDays)}
                  onBlur={(e) => {
                    const v = Number(e.target.value);
                    if (v >= 0 && v <= 60 && v !== c.warnBeforeDays) save.mutate({ warnBeforeDays: v });
                  }}
                  className="w-24 rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-2 text-sm num text-slate-100 outline-none focus:border-[var(--accent)]" />
              </div>
            </div>
          )}

          {c.suspendAfterDays != null && (
            <p className="text-[11px] text-slate-500">
              {c.warnBeforeDays > 0
                ? `A warning email goes out at ${Math.max(0, c.suspendAfterDays - c.warnBeforeDays)} days overdue, and the site is switched off at ${c.suspendAfterDays}.`
                : `The site is switched off at ${c.suspendAfterDays} days overdue with no warning email. Consider warning first: a site going dark unannounced reads as a fault, and the support call costs more than the invoice.`}
              {' '}Paying restores it straight away, not the next morning.
              {!c.live && ' While dry run is on, nothing is suspended: the run just lists who would be.'}
            </p>
          )}
        </div>
      )}

      <HostingAccounts businessId={businessId} />
    </div>
  );
}

interface HostingAccount {
  id: number; domain: string; username: string | null; whmPackage: string | null;
  status: string; detail: string | null; clientName: string | null; createdAt: string;
  businessName?: string | null; subscriptionId?: number;
}

/**
 * What has actually been provisioned, and the suspend control.
 *
 * Scoped to the business when viewed under one. Hosting set up against a business
 * used to appear only on the workspace screen, which looks exactly like it went to
 * the wrong place.
 */
function HostingAccounts({ businessId }: { businessId?: number }) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['hosting-accounts', businessId ?? 0],
    queryFn: () => apiGet<{ accounts: HostingAccount[] }>(
      businessId ? `/hosting/accounts?businessId=${businessId}` : '/hosting/accounts'),
    retry: false,
  });
  const [err, setErr] = useState('');
  const retry = useMutation({
    mutationFn: (subscriptionId: number) => apiPost(`/subscriptions/${subscriptionId}/provision`),
    onSuccess: () => { setErr(''); qc.invalidateQueries({ queryKey: ['hosting-accounts'] }); },
    onError: (e) => setErr(e instanceof Error ? e.message : 'Could not try again.'),
  });
  const suspend = useMutation({
    mutationFn: (v: { id: number; suspend: boolean }) =>
      apiPost(`/hosting/accounts/${v.id}/suspend`, { suspend: v.suspend }),
    onSuccess: () => { setErr(''); qc.invalidateQueries({ queryKey: ['hosting-accounts'] }); },
    onError: (e) => setErr(e instanceof Error ? e.message : 'Could not change that account.'),
  });
  const rows = data?.accounts ?? [];

  return (
    <section className="mt-6 border-t border-slate-800 pt-5">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Hosting accounts</h3>
      {err && <p className="mb-2 text-xs text-red-400">{err}</p>}
      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-700 p-4 text-xs text-slate-400">
          Nothing provisioned yet. Accounts appear here once an invoice for a hosting offering is paid.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-800">
          <table className="w-full text-sm">
            <thead className="bg-slate-900/50 text-left text-xs text-slate-500">
              <tr>
                <th className="px-3 py-2 font-medium">Domain</th>
                <th className="px-3 py-2 font-medium">Client</th>
                {!businessId && <th className="px-3 py-2 font-medium">Business</th>}
                <th className="px-3 py-2 font-medium">cPanel user</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id} className="border-t border-slate-800">
                  <td className="px-3 py-2 text-slate-200">{a.domain}</td>
                  <td className="px-3 py-2 text-slate-400">{a.clientName ?? '-'}</td>
                  {!businessId && <td className="px-3 py-2 text-slate-400">{a.businessName ?? '-'}</td>}
                  <td className="px-3 py-2 num text-slate-400">{a.username ?? '-'}</td>
                  <td className="px-3 py-2">
                    <span className={`rounded-md px-2 py-0.5 text-[11px] ${
                      a.status === 'active' ? 'bg-green-600/30 text-green-200'
                        : a.status === 'suspended' ? 'bg-amber-600/30 text-amber-200'
                        : a.status === 'failed' ? 'bg-red-600/30 text-red-200'
                        : 'bg-slate-800 text-slate-400'}`}>
                      {a.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    {(a.status === 'active' || a.status === 'suspended') && (
                      <button
                        onClick={() => suspend.mutate({ id: a.id, suspend: a.status === 'active' })}
                        disabled={suspend.isPending}
                        className="rounded-lg border border-slate-700 px-2.5 py-1 text-[11px] text-slate-300 hover:bg-slate-800 disabled:opacity-50">
                        {a.status === 'active' ? 'Suspend' : 'Restore'}
                      </button>
                    )}
                    {(a.status === 'failed' || a.status === 'dry-run') && a.subscriptionId && (
                      <button onClick={() => retry.mutate(a.subscriptionId!)} disabled={retry.isPending}
                        className="rounded-lg border border-slate-700 px-2.5 py-1 text-[11px] text-slate-300 hover:bg-slate-800 disabled:opacity-50">
                        {retry.isPending ? 'Trying...' : 'Try again'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows.filter((a) => a.status === 'failed' && a.detail).map((a) => (
        <p key={a.id} className="mt-2 rounded-lg border border-red-500/25 bg-red-500/5 px-3 py-2 text-[11px] text-red-300">
          <span className="text-red-200">{a.domain}</span>: {a.detail}
        </p>
      ))}
    </section>
  );
}
