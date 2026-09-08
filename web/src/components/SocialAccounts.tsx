import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link2, Unlink, RefreshCw, AlertTriangle, Check, ShieldCheck } from 'lucide-react';
import { apiGet, apiPost, apiDelete } from '../lib/api';
import { btnPrimary, btnSecondary, Skeleton } from './ui';
import { notify, confirmDialog } from './ConfirmDialog';
import { NetworkBadge } from './NetworkBadge';
import { NETWORK_META, ALL_NETWORKS, type SocialNetwork, type SocialAccountsResponse } from '../lib/socialTypes';

/**
 * Connecting the accounts Klippy posts to.
 *
 * The screen is mostly honesty. A network that cannot autopublish yet is still worth
 * showing, because a post to it still works: it gets handed to a person at the right
 * minute. Hiding it, or showing it as broken, would make the calendar look half built
 * during the weeks a platform approval is pending.
 *
 * The connect round trip leaves the app entirely and comes back through a redirect, so
 * this component also handles the return: ?connect= carries a handoff id, and what it
 * opens is a PICKER rather than a confirmation, because one Meta login usually returns
 * several Pages and the Instagram accounts behind them, and attaching all of them
 * would connect things nobody chose.
 */

interface Pending {
  businessId: number;
  network: SocialNetwork;
  accounts: { network: SocialNetwork; externalId: string; displayName: string; avatarUrl: string | null }[];
}

export function SocialAccounts({ businessId }: { businessId: number | null }) {
  const qc = useQueryClient();
  const [handoff, setHandoff] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  // The redirect back from Meta lands here with a handoff id, or with a reason it did
  // not work. Both are cleared from the URL immediately so a refresh does not replay.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const connect = q.get('connect');
    const err = q.get('connectError');
    if (!connect && !err) return;
    q.delete('connect'); q.delete('connectError'); q.delete('connected');
    window.history.replaceState({}, '', window.location.pathname + (q.toString() ? `?${q}` : ''));
    if (err) notify(err, 'error');
    if (connect) setHandoff(connect);
  }, []);

  const { data, isLoading } = useQuery({
    queryKey: ['social-accounts'],
    queryFn: () => apiGet<SocialAccountsResponse>('/social/accounts'),
  });

  const pending = useQuery({
    queryKey: ['social-connect-pending', handoff],
    queryFn: () => apiGet<Pending>(`/social/connect/pending?handoff=${encodeURIComponent(handoff!)}`),
    enabled: !!handoff,
    retry: false,
  });

  useEffect(() => {
    // Everything that came back is ticked to start with. A person who connected one
    // Page usually wants that Page and its Instagram account, and unticking is a
    // smaller ask than hunting for the right two rows.
    if (pending.data) setPicked(new Set(pending.data.accounts.map((a) => a.externalId)));
  }, [pending.data]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['social-accounts'] });

  const start = useMutation({
    mutationFn: (network: SocialNetwork) =>
      apiGet<{ url: string }>(`/social/connect/${network}/start?businessId=${businessId}`),
    onSuccess: (r) => { window.location.href = r.url; },
    onError: (e: Error) => notify(e.message, 'error'),
  });

  const save = useMutation({
    mutationFn: () => apiPost<{ saved: number }>('/social/accounts', {
      handoff, externalIds: [...picked],
    }),
    onSuccess: (r) => {
      setHandoff(null);
      invalidate();
      notify(`Connected ${r.saved} account${r.saved === 1 ? '' : 's'}.`, 'ok');
    },
    onError: (e: Error) => notify(e.message, 'error'),
  });

  const disconnect = useMutation({
    mutationFn: (id: number) => apiDelete<{ message?: string }>(`/social/accounts/${id}`),
    onSuccess: (r) => { invalidate(); notify(r?.message ?? 'Disconnected.', 'ok'); },
    onError: (e: Error) => notify(e.message, 'error'),
  });

  const check = useMutation({
    mutationFn: (id: number) => apiPost<{ ok: boolean; message: string }>(`/social/accounts/${id}/check`),
    onSuccess: (r) => { invalidate(); notify(r.message, r.ok ? 'ok' : 'error'); },
    onError: (e: Error) => notify(e.message, 'error'),
  });

  if (isLoading) return <Skeleton className="h-64 rounded-xl" />;

  const accounts = (data?.accounts ?? []).filter((a) => businessId == null || a.businessId === businessId);
  const capability = new Map((data?.networks ?? []).map((n) => [n.network, n]));

  return (
    <div className="space-y-4">
      {!data?.serverReady && (
        <p className="rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-3 text-xs text-amber-200">
          This server cannot store social tokens yet. Set SOCIAL_TOKEN_KEY in the app
          environment and restart, then accounts can be connected.
        </p>
      )}

      {/* ---- the picker, after coming back from Meta -------------------------- */}
      {handoff && (
        <div className="rounded-xl border border-[var(--accent)]/40 bg-[var(--accent-quiet)] p-4">
          <h3 className="mb-1 text-sm font-semibold text-slate-100">Which of these should Klippy post to?</h3>
          {pending.isLoading && <p className="text-xs text-slate-400">Loading what came back...</p>}
          {pending.error && (
            <p className="text-xs text-red-400">
              That connection has expired. Close this and start again.
            </p>
          )}
          {pending.data && (
            <>
              <p className="mb-3 text-xs text-slate-400">
                One login returns every Page you help run, and the Instagram account behind each.
                Untick anything that is not this client.
              </p>
              <div className="space-y-1">
                {pending.data.accounts.map((a) => (
                  <label key={a.externalId}
                    className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-slate-800/50">
                    <input type="checkbox" checked={picked.has(a.externalId)}
                      onChange={(e) => setPicked((s) => {
                        const next = new Set(s);
                        if (e.target.checked) next.add(a.externalId); else next.delete(a.externalId);
                        return next;
                      })} />
                    <NetworkBadge network={a.network} size="md" />
                    <span className="text-sm text-slate-200">{a.displayName}</span>
                  </label>
                ))}
              </div>
              <div className="mt-3 flex gap-2">
                <button onClick={() => save.mutate()} disabled={!picked.size || save.isPending}
                  className={btnPrimary}>
                  Connect {picked.size} account{picked.size === 1 ? '' : 's'}
                </button>
                <button onClick={() => setHandoff(null)} className={btnSecondary}>Cancel</button>
              </div>
            </>
          )}
        </div>
      )}

      {/* ---- what is connected, and what is merely possible ------------------- */}
      <div className="space-y-2">
        {ALL_NETWORKS.map((n) => {
          const mine = accounts.filter((a) => a.network === n);
          const cap = capability.get(n);
          const connectable = n !== 'linkedin';
          return (
            <div key={n} className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <NetworkBadge network={n} size="md" />
                <span className="text-sm font-medium text-slate-200">{NETWORK_META[n].label}</span>
                {cap?.canAutoPublish && (
                  <span className="flex items-center gap-1 text-[11px] text-emerald-300">
                    <ShieldCheck size={12} /> Klippy posts to this
                  </span>
                )}
                <div className="flex-1" />
                {businessId != null && connectable && (
                  <button onClick={() => start.mutate(n)} disabled={start.isPending || !data?.serverReady}
                    className={btnSecondary + ' flex items-center gap-1.5 !px-3 !py-1.5 text-xs'}>
                    <Link2 size={13} /> {mine.length ? 'Connect another' : 'Connect'}
                  </button>
                )}
              </div>

              {mine.length === 0 ? (
                <p className="text-xs text-slate-500">{cap?.note}</p>
              ) : (
                <div className="space-y-1">
                  {mine.map((a) => (
                    <div key={a.id} className="flex flex-wrap items-center gap-2 rounded-lg px-2 py-1.5 text-sm">
                      {a.avatarUrl
                        ? <img src={a.avatarUrl} alt="" className="h-6 w-6 rounded-full object-cover" />
                        : <div className="h-6 w-6 rounded-full bg-slate-800" />}
                      <span className="text-slate-200">{a.displayName}</span>
                      <StatusDot status={a.status} error={a.lastError} />
                      <div className="flex-1" />
                      <button onClick={() => check.mutate(a.id)} disabled={check.isPending}
                        title="Ask the network whether this connection still works"
                        className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-300">
                        <RefreshCw size={13} className={check.isPending ? 'animate-spin' : ''} />
                      </button>
                      <button
                        onClick={async () => {
                          const yes = await confirmDialog(
                            `Disconnect ${a.displayName}? Posts that already went out keep their links, and anything still scheduled will be sent to you to post by hand.`,
                            { confirmLabel: 'Disconnect' });
                          if (yes) disconnect.mutate(a.id);
                        }}
                        title="Disconnect"
                        className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-red-400">
                        <Unlink size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {businessId == null && (
        <p className="text-[11px] text-slate-500">Pick one business above to connect its accounts.</p>
      )}

      <details className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
        <summary className="cursor-pointer text-sm font-medium text-slate-300">
          What you need before connecting
        </summary>
        <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-xs text-slate-400">
          <li>A Meta app of the Business type, with Facebook Login for Business added.</li>
          <li>Its app id and secret set on this server, so Klippy can talk to Meta at all.</li>
          <li>
            An Instagram Business or Creator account linked to the Facebook Page. Instagram
            publishing runs through the Page, so an unlinked account cannot be posted to.
          </li>
          <li>
            Your own Facebook user needs the Create Content task on the client's Page.
            Klippy only lists Pages you can actually post to, so a Page missing from the
            list is a role problem rather than a Klippy problem.
          </li>
          <li>
            While the app is in development, only people with a role on it can connect.
            Everyone else needs App Review and Business Verification first.
          </li>
        </ol>
        <p className="mt-2 text-[11px] text-slate-500">
          The full checklist, with the exact permissions and what each one is for, is in
          docs/social/API-NOTES.md in the repository.
        </p>
      </details>
    </div>
  );
}

function StatusDot({ status, error }: { status: string; error: string | null }) {
  if (status === 'connected') {
    return <span className="flex items-center gap-1 text-[11px] text-emerald-300"><Check size={11} /> working</span>;
  }
  const label = status === 'expired' ? 'needs reconnecting'
    : status === 'revoked' ? 'access was removed' : 'something is wrong';
  return (
    <span className="flex items-center gap-1 text-[11px] text-amber-300" title={error ?? undefined}>
      <AlertTriangle size={11} /> {label}
    </span>
  );
}
