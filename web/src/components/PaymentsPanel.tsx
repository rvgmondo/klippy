import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPatch } from '../lib/api';
import { ErrorNote } from './ErrorNote';

interface Configured {
  merchantId: string; hasMerchantKey: boolean; hasPassphrase: boolean;
  sandbox: boolean; enabled: boolean;
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
    </div>
  );
}
