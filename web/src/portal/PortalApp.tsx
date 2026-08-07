import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPatch, apiPost } from '../lib/api';
import type { PortalMe } from './PortalRoot';

interface Doc {
  id: number; type: 'invoice' | 'quote' | 'credit_note'; number: string;
  issueDate: string; dueDate: string | null; status: string;
  total: string; currency: string; outstanding: number;
  decision: 'accepted' | 'declined' | null; decisionAt: string | null;
}
interface HostingRow {
  id: number; domain: string; username: string | null; whmPackage: string | null;
  status: string; display: string; outstanding: string; unpaidInvoiceId: number | null;
}

const TYPE_LABEL: Record<string, string> = {
  invoice: 'Invoice', quote: 'Quote', credit_note: 'Credit note',
};

function money(currency: string, v: string | number) {
  const n = typeof v === 'string' ? Number(v) : v;
  return `${currency} ${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * The portal proper.
 *
 * Ordered by what a client actually came for. Anything owed is at the top, because
 * "how much do I owe and how do I pay it" is the question that brought them here;
 * everything else is reference material they will scroll to.
 */
export function PortalApp({ me, onSignedOut }: { me: PortalMe; onSignedOut: () => void }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'documents' | 'hosting' | 'details'>('documents');
  const accent = { background: 'var(--portal-accent, #0f172a)' };

  const { data } = useQuery({
    queryKey: ['portal-docs'],
    queryFn: () => apiGet<{ documents: Doc[]; totalOutstanding: string }>('/portal/documents'),
  });
  const docs = data?.documents ?? [];
  const currency = docs[0]?.currency ?? 'ZAR';

  const logout = useMutation({
    mutationFn: () => apiPost('/portal/logout'),
    onSuccess: () => { qc.clear(); onSignedOut(); },
  });

  const pay = useMutation({
    mutationFn: (id: number) => apiPost<{ url: string; fields: Record<string, string> }>(`/portal/documents/${id}/pay`),
    onSuccess: (checkout) => {
      // PayFast takes a form POST, not a redirect, so the fields are submitted from
      // a throwaway form rather than pushed into a query string.
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = checkout.url;
      for (const [k, v] of Object.entries(checkout.fields)) {
        const input = document.createElement('input');
        input.type = 'hidden'; input.name = k; input.value = String(v);
        form.appendChild(input);
      }
      document.body.appendChild(form);
      form.submit();
    },
  });

  const paid = new URLSearchParams(window.location.search).get('paid');

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-4">
          {me.brand.hasLogo && (
            <img src="/api/v1/portal/logo" alt="" className="h-8 max-w-[160px] object-contain" />
          )}
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{me.brand.name}</div>
            <div className="truncate text-xs text-slate-500">{me.client.name}</div>
          </div>
          <button onClick={() => logout.mutate()}
            className="ml-auto shrink-0 text-xs text-slate-500 underline hover:text-slate-800">
            Sign out
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-6">
        {paid && (
          <div className="mb-4 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800">
            Thank you. Your payment for {paid} is being confirmed and this page will update shortly.
          </div>
        )}

        {Number(data?.totalOutstanding ?? 0) > 0 && (
          <div className="mb-6 rounded-xl border border-slate-200 bg-white p-4">
            <div className="text-xs uppercase tracking-wide text-slate-500">Outstanding</div>
            <div className="mt-1 text-2xl font-semibold num">
              {money(currency, data!.totalOutstanding)}
            </div>
          </div>
        )}

        <nav className="mb-4 flex gap-1 border-b border-slate-200">
          {([['documents', 'Invoices and quotes'], ['hosting', 'Hosting'], ['details', 'Your details']] as const)
            .map(([id, labelText]) => (
              <button key={id} onClick={() => setTab(id)}
                className={`-mb-px border-b-2 px-3 py-2 text-sm ${
                  tab === id ? 'border-slate-900 font-medium text-slate-900' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>
                {labelText}
              </button>
            ))}
        </nav>

        {tab === 'documents' && (
          <Documents docs={docs} onPay={(id) => pay.mutate(id)} paying={pay.isPending}
            payError={pay.error instanceof Error ? pay.error.message : ''} accent={accent} />
        )}
        {tab === 'hosting' && <Hosting accent={accent} onPay={(id) => pay.mutate(id)} />}
        {tab === 'details' && <Details me={me} accent={accent} />}
      </main>
    </div>
  );
}

function Documents({ docs, onPay, paying, payError, accent }: {
  docs: Doc[]; onPay: (id: number) => void; paying: boolean; payError: string;
  accent: React.CSSProperties;
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(0);
  const [err, setErr] = useState('');

  const decide = useMutation({
    mutationFn: (v: { id: number; decision: 'accepted' | 'declined' }) =>
      apiPost(`/portal/quotes/${v.id}/decision`, { decision: v.decision }),
    onSuccess: () => { setErr(''); qc.invalidateQueries({ queryKey: ['portal-docs'] }); },
    onError: (e) => setErr(e instanceof Error ? e.message : 'Could not record that.'),
  });

  if (!docs.length) {
    return <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
      Nothing here yet.
    </p>;
  }

  return (
    <div className="space-y-2">
      {(payError || err) && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">{payError || err}</div>
      )}
      {docs.map((d) => (
        <div key={d.id} className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <span className="font-medium">{TYPE_LABEL[d.type] ?? d.type} {d.number}</span>
              <span className="ml-2 text-xs text-slate-500">{d.issueDate}</span>
            </div>
            <div className="num font-semibold">{money(d.currency, d.total)}</div>
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
            {d.type === 'invoice' && d.outstanding > 0 && (
              <span className="rounded-md bg-amber-100 px-2 py-0.5 text-amber-800">
                {money(d.currency, d.outstanding)} outstanding
                {d.dueDate ? `, due ${d.dueDate}` : ''}
              </span>
            )}
            {d.type === 'invoice' && d.outstanding <= 0 && d.status !== 'void' && (
              <span className="rounded-md bg-green-100 px-2 py-0.5 text-green-800">Paid</span>
            )}
            {d.status === 'void' && <span className="rounded-md bg-slate-100 px-2 py-0.5 text-slate-500">Cancelled</span>}
            {d.decision && (
              <span className={`rounded-md px-2 py-0.5 ${
                d.decision === 'accepted' ? 'bg-green-100 text-green-800' : 'bg-slate-100 text-slate-600'}`}>
                {d.decision === 'accepted' ? 'Accepted' : 'Declined'}
                {d.decisionAt ? ` on ${new Date(d.decisionAt).toLocaleDateString()}` : ''}
              </span>
            )}
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            <a href={`/api/v1/portal/documents/${d.id}/pdf`} target="_blank" rel="noreferrer"
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-50">
              Download PDF
            </a>
            {d.type === 'invoice' && d.outstanding > 0 && d.status !== 'void' && (
              <button onClick={() => onPay(d.id)} disabled={paying}
                className="rounded-lg px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60" style={accent}>
                {paying ? 'Opening...' : `Pay ${money(d.currency, d.outstanding)}`}
              </button>
            )}
            {d.type === 'quote' && d.status === 'sent' && !d.decision && (
              <>
                <button
                  onClick={() => { setBusy(d.id); decide.mutate({ id: d.id, decision: 'accepted' }); }}
                  disabled={decide.isPending && busy === d.id}
                  className="rounded-lg px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60" style={accent}>
                  Accept this quote
                </button>
                <button
                  onClick={() => { setBusy(d.id); decide.mutate({ id: d.id, decision: 'declined' }); }}
                  disabled={decide.isPending && busy === d.id}
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-50 disabled:opacity-60">
                  Decline
                </button>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function Hosting({ accent, onPay }: { accent: React.CSSProperties; onPay: (id: number) => void }) {
  const { data } = useQuery({
    queryKey: ['portal-hosting'],
    queryFn: () => apiGet<{ hosting: HostingRow[]; cpanelUrl: string | null }>('/portal/hosting'),
  });
  const rows = data?.hosting ?? [];
  if (!rows.length) {
    return <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
      No hosting on your account.
    </p>;
  }
  return (
    <div className="space-y-2">
      {rows.map((h) => (
        <div key={h.id} className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-medium">{h.domain}</span>
            <span className={`rounded-md px-2 py-0.5 text-xs ${
              h.display === 'active' ? 'bg-green-100 text-green-800'
                : h.display === 'suspended' ? 'bg-red-100 text-red-800' : 'bg-slate-100 text-slate-600'}`}>
              {h.display}
            </span>
          </div>
          <div className="mt-1 text-xs text-slate-500">
            {h.whmPackage ? `${h.whmPackage} package` : 'Hosting'}
            {h.username ? ` - username ${h.username}` : ''}
          </div>

          {h.display === 'suspended' && (
            <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800">
              This site is switched off because of an unpaid invoice
              {Number(h.outstanding) > 0 ? ` of ${money('ZAR', h.outstanding)}` : ''}.
              Paying it brings the site straight back.
              {h.unpaidInvoiceId && (
                <button onClick={() => onPay(h.unpaidInvoiceId!)}
                  className="mt-2 block rounded-lg px-3 py-1.5 text-xs font-medium text-white" style={accent}>
                  Pay now and restore
                </button>
              )}
            </div>
          )}

          {data?.cpanelUrl && h.display === 'active' && (
            <a href={data.cpanelUrl} target="_blank" rel="noreferrer"
              className="mt-3 inline-block rounded-lg border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-50">
              Open control panel
            </a>
          )}
        </div>
      ))}
    </div>
  );
}

function Details({ me, accent }: { me: PortalMe; accent: React.CSSProperties }) {
  const qc = useQueryClient();
  const [name, setName] = useState(me.user.name ?? '');
  const [billingEmail, setBillingEmail] = useState(me.client.billingEmail ?? '');
  const [vat, setVat] = useState(me.client.vatNumber ?? '');
  const [address, setAddress] = useState(me.client.address ?? '');
  const [password, setPassword] = useState('');
  const [saved, setSaved] = useState('');

  const save = useMutation({
    mutationFn: () => apiPatch('/portal/profile', {
      name, billingEmail: billingEmail || null, vatNumber: vat || null, address: address || null,
    }),
    onSuccess: () => {
      setSaved('Saved.');
      setTimeout(() => setSaved(''), 2000);
      qc.invalidateQueries({ queryKey: ['portal-me'] });
    },
  });

  const setPw = useMutation({
    mutationFn: (v: string | null) => apiPost('/portal/password', { password: v }),
    onSuccess: () => {
      setPassword('');
      setSaved('Password updated.');
      setTimeout(() => setSaved(''), 2000);
      qc.invalidateQueries({ queryKey: ['portal-me'] });
    },
  });

  const field = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-slate-500';
  const label = 'mb-1 block text-xs font-medium text-slate-600';

  return (
    <div className="space-y-5 rounded-xl border border-slate-200 bg-white p-4">
      <div>
        <label className={label}>Your name</label>
        <input className={field} value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div>
        <label className={label}>Where invoices should be sent</label>
        <input type="email" className={field} value={billingEmail} onChange={(e) => setBillingEmail(e.target.value)} />
      </div>
      <div>
        <label className={label}>VAT number</label>
        <input className={field} value={vat} onChange={(e) => setVat(e.target.value)} />
        <p className="mt-1 text-[11px] text-slate-500">
          Printed on your tax invoices, so it is worth getting right.
        </p>
      </div>
      <div>
        <label className={label}>Billing address</label>
        <textarea className={field} rows={3} value={address} onChange={(e) => setAddress(e.target.value)} />
      </div>

      <div className="flex items-center gap-3">
        <button onClick={() => save.mutate()} disabled={save.isPending}
          className="rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-60" style={accent}>
          {save.isPending ? 'Saving...' : 'Save'}
        </button>
        {saved && <span className="text-sm text-green-700">{saved}</span>}
      </div>

      <div className="border-t border-slate-200 pt-4">
        <div className="text-xs font-medium text-slate-600">Password</div>
        <p className="mt-0.5 text-[11px] text-slate-500">
          {me.user.hasPassword
            ? 'You have a password set. You can still sign in by emailed link at any time.'
            : 'You sign in by emailed link. Set a password if you would rather not wait for email.'}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input type="password" className="w-56 rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500"
            placeholder="At least 10 characters" value={password} onChange={(e) => setPassword(e.target.value)} />
          <button onClick={() => setPw.mutate(password)} disabled={setPw.isPending || password.length < 10}
            className="rounded-lg border border-slate-300 px-3 py-2 text-xs hover:bg-slate-50 disabled:opacity-50">
            {me.user.hasPassword ? 'Change password' : 'Set password'}
          </button>
          {me.user.hasPassword && (
            <button onClick={() => setPw.mutate(null)} disabled={setPw.isPending}
              className="text-xs text-slate-500 underline hover:text-slate-800">
              Remove it
            </button>
          )}
        </div>
        {setPw.error && (
          <p className="mt-1 text-xs text-red-600">
            {setPw.error instanceof Error ? setPw.error.message : 'Could not update the password.'}
          </p>
        )}
      </div>
    </div>
  );
}
