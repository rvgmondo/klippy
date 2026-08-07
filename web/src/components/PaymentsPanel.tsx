import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPatch } from '../lib/api';
import { ErrorNote } from './ErrorNote';

interface Configured {
  merchantId: string; hasMerchantKey: boolean; hasPassphrase: boolean;
  sandbox: boolean; enabled: boolean;
  autoDebitEnabled: boolean; autoDebitLive: boolean; autoDebitMax: string;
}
interface Status { configured: Configured; serverReady: boolean }

/**
 * PayFast setup, so clients can pay invoices online. Deliberately blunt about the
 * fact that it should be tested in sandbox before it is trusted with real money.
 */
export function PaymentsPanel() {
  const qc = useQueryClient();
  const { data, error, refetch } = useQuery({
    queryKey: ['payfast'], queryFn: () => apiGet<Status>('/account/payfast'), retry: false,
  });

  const [merchantId, setMerchantId] = useState('');
  const [merchantKey, setMerchantKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [sandbox, setSandbox] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data && !loaded) {
      setMerchantId(data.configured.merchantId);
      setSandbox(data.configured.sandbox);
      setEnabled(data.configured.enabled);
      setLoaded(true);
    }
  }, [data, loaded]);

  const save = useMutation({
    mutationFn: () => apiPatch('/account/payfast', {
      merchantId,
      // Only send secrets when the field was actually filled, so a blank leaves the
      // stored value untouched.
      ...(merchantKey ? { merchantKey } : {}),
      ...(passphrase ? { passphrase } : {}),
      sandbox, enabled,
    }),
    onSuccess: () => {
      setMerchantKey(''); setPassphrase('');
      setSaved(true); setTimeout(() => setSaved(false), 2000);
      qc.invalidateQueries({ queryKey: ['payfast'] });
    },
  });

  if (error) return <ErrorNote error={error} onRetry={() => refetch()} />;
  if (!data) return <p className="text-sm text-slate-500">Loading...</p>;

  const field = 'w-full rounded-lg bg-slate-900/70 border border-slate-700 px-3 py-2.5 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-[var(--accent)]';
  const label = 'mb-1 block text-xs font-medium text-slate-400';

  return (
    <div className="space-y-5">
      <p className="text-xs text-slate-500">
        Let clients pay an invoice online with card or Instant EFT through PayFast. When they
        pay, the invoice marks itself paid.
      </p>

      {!data.serverReady && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">
          The server cannot store payment secrets yet. Add <span className="text-red-200">PAYMENTS_SECRET</span> (a
          long random string) to the app environment and restart before entering your keys.
        </div>
      )}

      <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
        This is new and unproven against live PayFast. Keep <span className="text-amber-200">Sandbox</span> on and
        run a full test payment before switching it on for real clients.
      </div>

      <div>
        <label className={label}>Merchant ID</label>
        <input className={field} value={merchantId} onChange={(e) => setMerchantId(e.target.value)} placeholder="10000100" />
      </div>
      <div>
        <label className={label}>Merchant key</label>
        <input type="password" className={field} value={merchantKey} onChange={(e) => setMerchantKey(e.target.value)}
          placeholder={data.configured.hasMerchantKey ? 'Set. Leave blank to keep it.' : 'Your PayFast merchant key'} />
      </div>
      <div>
        <label className={label}>Passphrase (optional but recommended)</label>
        <input type="password" className={field} value={passphrase} onChange={(e) => setPassphrase(e.target.value)}
          placeholder={data.configured.hasPassphrase ? 'Set. Leave blank to keep it.' : 'From your PayFast dashboard'} />
        <p className="mt-1 text-[11px] text-slate-500">Set the same passphrase in your PayFast account settings.</p>
      </div>

      <label className="flex items-center gap-2 text-sm text-slate-300">
        <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={sandbox} onChange={(e) => setSandbox(e.target.checked)} />
        Sandbox mode (test credentials, no real money)
      </label>
      <label className="flex items-center gap-2 text-sm text-slate-300">
        <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Enable PayFast on invoices
      </label>

      {save.error && <ErrorNote error={save.error} />}
      <div className="flex items-center gap-3 border-t border-slate-800 pt-4">
        <button onClick={() => save.mutate()} disabled={save.isPending || !data.serverReady}
          className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-ink)] hover:opacity-90 disabled:opacity-60">
          {save.isPending ? 'Saving...' : 'Save PayFast settings'}
        </button>
        {saved && <span className="text-sm text-violet-300">Saved</span>}
      </div>

      <AutoDebitPanel configured={data.configured} />
      <PayfastActivity />
    </div>
  );
}

/**
 * Charging a saved card on a schedule.
 *
 * Presented as three deliberate steps rather than one switch, because this is the
 * only part of Klippy that takes money with nobody watching. The order matters:
 * turn it on, watch a dry run bill the right people for the right amounts, and only
 * then let it charge. The copy says what each switch actually does instead of
 * leaving the reader to find out with a client's card.
 */
function AutoDebitPanel({ configured }: { configured: Configured }) {
  const qc = useQueryClient();
  const [max, setMax] = useState(configured.autoDebitMax);
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) => apiPatch('/account/payfast', patch),
    onSuccess: () => {
      setSaved(true); setTimeout(() => setSaved(false), 2000);
      qc.invalidateQueries({ queryKey: ['payfast'] });
    },
  });

  const on = configured.autoDebitEnabled;
  const live = configured.autoDebitLive;

  return (
    <section className="mt-6 space-y-3 border-t border-slate-800 pt-5">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Auto-debit</h3>
        <p className="mt-0.5 text-[11px] text-slate-500">
          Charge a client's saved card automatically when their subscription bills, instead of emailing
          an invoice and waiting. A card is only saved after that client has paid one invoice online.
        </p>
      </div>

      <label className="flex items-center gap-2 text-sm text-slate-300">
        <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]"
          checked={on} disabled={!configured.enabled || save.isPending}
          onChange={(e) => save.mutate({ autoDebitEnabled: e.target.checked })} />
        Allow auto-debit on this workspace
      </label>
      {!configured.enabled && (
        <p className="text-[11px] text-slate-500">Switch PayFast on above first.</p>
      )}

      {on && (
        <>
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
            Auto-debit has never charged a card from this install. Leave dry run on until you have watched
            one billing run list the right clients and the right amounts. In dry run nothing is taken:
            each run writes down what it would have charged, and you can read it below.
            <span className="mt-1.5 block text-amber-200/80">
              A saved card is money you can move without the client present, so make sure they have agreed
              to it. That agreement is between you and them, not something Klippy can give you.
            </span>
          </div>

          <label className="flex items-center gap-2 text-sm text-slate-300">
            <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]"
              checked={live} disabled={save.isPending}
              onChange={(e) => save.mutate({ autoDebitLive: e.target.checked })} />
            <span className={live ? 'text-red-300' : ''}>
              {live ? 'Live: real cards are charged' : 'Dry run: write down what it would charge, take nothing'}
            </span>
          </label>

          <div>
            <label className="mb-1 block text-xs font-medium text-slate-400">Most it may charge at once</label>
            <div className="flex items-center gap-2">
              <input inputMode="decimal" value={max} onChange={(e) => setMax(e.target.value)}
                className="w-36 rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-2 text-sm num text-slate-100 outline-none focus:border-[var(--accent)]" />
              <button onClick={() => save.mutate({ autoDebitMax: Number(max) })}
                disabled={save.isPending || !(Number(max) > 0)}
                className="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-50">
                Set limit
              </button>
              {saved && <span className="text-xs text-violet-300">Saved</span>}
            </div>
            <p className="mt-1 text-[11px] text-slate-500">
              Anything above this is refused and left as an unpaid invoice for you to look at. It is the
              backstop against a wrong price debiting a client for a fortune.
            </p>
          </div>
        </>
      )}

      {save.error && <ErrorNote error={save.error} />}
      {on && <AutoDebitActivity />}
    </section>
  );
}

/** What auto-debit has done, including what it refused to do. */
function AutoDebitActivity() {
  const { data, refetch, isFetching } = useQuery({
    queryKey: ['autodebit-activity'],
    queryFn: () => apiGet<{
      activity: { id: number; at: string; ok: boolean; outcome: string; detail: Record<string, unknown> }[];
    }>('/account/autodebit/activity'),
    retry: false,
  });
  const rows = data?.activity ?? [];

  return (
    <div className="mt-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Recent auto-debit runs</span>
        <button onClick={() => refetch()} disabled={isFetching}
          className="rounded-lg border border-slate-700 px-2.5 py-1 text-[11px] text-slate-300 hover:bg-slate-800 disabled:opacity-50">
          {isFetching ? 'Checking...' : 'Refresh'}
        </button>
      </div>
      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-700 p-3 text-[11px] text-slate-400">
          Nothing yet. Recurring billing runs each morning; whatever it charges or refuses shows up here.
        </div>
      ) : (
        <div className="space-y-1.5">
          {rows.map((r) => {
            const outcome = String(r.detail.outcome ?? '');
            const tone = outcome === 'charged' ? 'border-green-500/25 bg-green-500/5 text-green-300'
              : outcome === 'dry-run' ? 'border-sky-500/25 bg-sky-500/5 text-sky-300'
              : outcome === 'failed' ? 'border-red-500/25 bg-red-500/5 text-red-300'
              : 'border-slate-700 bg-slate-800/40 text-slate-400';
            return (
              <div key={r.id} className={`rounded-lg border px-3 py-2 ${tone}`}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-xs font-medium">{String(r.detail.number ?? '')} {outcome}</span>
                  <span className="num text-[10px] opacity-70">{new Date(r.at).toLocaleString()}</span>
                </div>
                <p className="mt-0.5 text-[11px] text-slate-300">{r.outcome}</p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * What PayFast has actually sent, most recent first.
 *
 * A payment that silently does not arrive is the worst thing to debug: the money
 * leaves the customer, the invoice stays unpaid, and there is nothing to look at.
 * Each row says which check passed or failed and why, so the answer is here rather
 * than in a log file on the server.
 */
export function PayfastActivity() {
  const { data, refetch, isFetching } = useQuery({
    queryKey: ['payfast-activity'],
    queryFn: () => apiGet<{
      activity: { id: number; at: string; ok: boolean; outcome: string; detail: Record<string, unknown> }[];
    }>('/account/payfast/activity'),
    retry: false,
  });
  const rows = data?.activity ?? [];

  return (
    <section className="mt-6 border-t border-slate-800 pt-5">
      <div className="mb-2 flex items-center justify-between">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Recent PayFast notifications</h3>
          <p className="mt-0.5 text-[11px] text-slate-500">
            PayFast tells the server about a payment separately from sending the customer back here.
            If an invoice is not marked paid, the reason is in this list.
          </p>
        </div>
        <button onClick={() => refetch()} disabled={isFetching}
          className="shrink-0 rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-50">
          {isFetching ? 'Checking...' : 'Refresh'}
        </button>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-700 p-4 text-xs text-slate-400">
          Nothing received yet. If you have paid a sandbox invoice and this is still empty, PayFast never
          reached the server: check that your app URL is the public https address and that
          /api/v1/payfast/notify is reachable from outside.
        </div>
      ) : (
        <div className="space-y-1.5">
          {rows.map((r) => (
            <div key={r.id}
              className={`rounded-lg border px-3 py-2 ${r.ok ? 'border-green-500/25 bg-green-500/5' : 'border-amber-500/25 bg-amber-500/5'}`}>
              <div className="flex items-baseline justify-between gap-3">
                <span className={`text-xs font-medium ${r.ok ? 'text-green-300' : 'text-amber-300'}`}>
                  {String(r.detail.number ?? '')}
                </span>
                <span className="num text-[10px] text-slate-500">{new Date(r.at).toLocaleString()}</span>
              </div>
              <p className="mt-0.5 text-[11px] text-slate-300">{r.outcome}</p>
              <p className="mt-1 text-[10px] text-slate-500">
                status {String(r.detail.paymentStatus)} | they sent {String(r.detail.amountGross)},
                invoice is {String(r.detail.expected)} | signature theirs {String(r.detail.signatureTheirs)},
                ours {String(r.detail.signatureOurs)} | passphrase {r.detail.passphraseSet ? 'set' : 'not set'}
              </p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
