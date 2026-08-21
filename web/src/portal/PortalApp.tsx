import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPatch, apiPost } from '../lib/api';
import { money as fmt } from '../lib/money';
import type { PortalMe } from './PortalRoot';

interface Doc {
  id: number; type: 'invoice' | 'quote' | 'credit_note'; number: string;
  issueDate: string; dueDate: string | null; status: string;
  total: string; currency: string; outstanding: number;
  decision: 'accepted' | 'declined' | null; decisionAt: string | null;
}
interface HostingRow {
  id: number; domain: string; username: string | null; whmPackage: string | null;
  status: string; display: string; outstanding: string; currency: string;
  unpaidInvoiceId: number | null;
}

const TYPE_LABEL: Record<string, string> = {
  invoice: 'Invoice', quote: 'Quote', credit_note: 'Credit note',
};

const money = (currency: string, v: string | number) => fmt(v, currency);

/**
 * The portal proper.
 *
 * Ordered by what a client actually came for. Anything owed is at the top, because
 * "how much do I owe and how do I pay it" is the question that brought them here;
 * everything else is reference material they will scroll to.
 */
export function PortalApp({ me, onSignedOut }: { me: PortalMe; onSignedOut: () => void }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'documents' | 'statement' | 'report' | 'hosting' | 'details'>('documents');
  const accent = { background: 'var(--portal-accent, #0f172a)' };

  const { data } = useQuery({
    queryKey: ['portal-docs'],
    queryFn: () => apiGet<{
      documents: Doc[];
      /** What is owed, per currency. Never one number: see the API for why. */
      outstanding: { currency: string; amount: string }[];
    }>('/portal/documents'),
  });
  const docs = data?.documents ?? [];
  const owed = (data?.outstanding ?? []).filter((o) => Number(o.amount) > 0);

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
            {me.preview ? 'End preview' : 'Sign out'}
          </button>
        </div>
      </header>

      {me.preview && (
        <div className="bg-amber-100 px-4 py-2 text-center text-xs text-amber-900">
          You are previewing this portal as staff. Nothing here can be changed, paid or accepted:
          only the client can do that.
        </div>
      )}

      <main className="mx-auto max-w-3xl px-4 py-6">
        {paid && (
          <div className="mb-4 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800">
            Thank you. Your payment for {paid} is being confirmed and this page will update shortly.
          </div>
        )}

        {owed.length > 0 && (
          <div className="mb-6 rounded-xl border border-slate-200 bg-white p-4">
            <div className="text-xs uppercase tracking-wide text-slate-500">Outstanding</div>
            {/* One figure per currency. A client billed in two used to be shown the
                sum of both, labelled with whichever invoice came first. */}
            <div className="mt-1 flex flex-wrap items-baseline gap-x-6 gap-y-1">
              {owed.map((o) => (
                <div key={o.currency} className="text-2xl font-semibold num">
                  {money(o.currency, o.amount)}
                </div>
              ))}
            </div>
          </div>
        )}

        <nav className="mb-4 flex gap-1 border-b border-slate-200">
          {([['documents', 'Invoices and quotes'], ['statement', 'Statement'], ['report', 'Work report'], ['hosting', 'Hosting'], ['details', 'Your details']] as const)
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
            payError={pay.error instanceof Error ? pay.error.message : ''} accent={accent}
            readOnly={!!me.preview} />
        )}
        {tab === 'statement' && <Statement />}
        {tab === 'report' && <WorkReport />}
        {tab === 'hosting' && <Hosting accent={accent} onPay={(id) => pay.mutate(id)} />}
        {tab === 'details' && (me.preview
          ? <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
              The client edits their own details here. Hidden while previewing.
            </p>
          : <Details me={me} accent={accent} />)}
      </main>
    </div>
  );
}

const todayStr = () => new Date().toISOString().slice(0, 10);

interface DocLine { id: number; description: string; detail: string | null; quantity: string; unitPrice: string; amount: string }

/**
 * The line breakdown for one document, fetched on demand.
 *
 * The portal used to show only a total and a Pay button, so a client accepted every
 * figure blind and had to email to ask what a charge was for. This is the same detail
 * that is on the PDF, in the page, one click away, so "what is this?" answers itself.
 */
function DocLines({ id, currency }: { id: number; currency: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['portal-doc', id],
    queryFn: () => apiGet<{ lines: DocLine[] }>(`/portal/documents/${id}`),
  });
  if (isLoading) return <div className="mt-3 text-xs text-slate-400">Loading items...</div>;
  const lines = data?.lines ?? [];
  if (!lines.length) return <div className="mt-3 text-xs text-slate-400">No line items.</div>;
  return (
    <table className="mt-3 w-full text-xs">
      <thead>
        <tr className="border-b border-slate-200 text-left text-[10px] uppercase tracking-wide text-slate-400">
          <th className="py-1 pr-2">Description</th>
          <th className="py-1 px-2 text-right">Qty</th>
          <th className="py-1 pl-2 text-right">Amount</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((l) => (
          <tr key={l.id} className="border-b border-slate-100 align-top last:border-0">
            <td className="py-1.5 pr-2 text-slate-700">
              {l.description}
              {l.detail && <div className="mt-0.5 whitespace-pre-line text-[11px] leading-snug text-slate-400">{l.detail}</div>}
            </td>
            <td className="py-1.5 px-2 text-right num text-slate-500">{Number(l.quantity)}</td>
            <td className="py-1.5 pl-2 text-right num text-slate-700">{money(currency, l.amount)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Documents({ docs, onPay, paying, payError, accent, readOnly }: {
  docs: Doc[]; onPay: (id: number) => void; paying: boolean; payError: string;
  accent: React.CSSProperties; readOnly?: boolean;
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(0);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState<number | null>(null);

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
            {d.type === 'invoice' && d.outstanding > 0 && (() => {
              const overdue = !!d.dueDate && d.dueDate < todayStr();
              return (
                <span className={`rounded-md px-2 py-0.5 ${overdue ? 'bg-red-100 font-medium text-red-800' : 'bg-amber-100 text-amber-800'}`}>
                  {money(d.currency, d.outstanding)} outstanding
                  {d.dueDate ? (overdue ? `, overdue since ${d.dueDate}` : `, due ${d.dueDate}`) : ''}
                </span>
              );
            })()}
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

          {open === d.id && <DocLines id={d.id} currency={d.currency} />}
          <div className="mt-3 flex flex-wrap gap-2">
            <button onClick={() => setOpen(open === d.id ? null : d.id)}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-50">
              {open === d.id ? 'Hide items' : 'View items'}
            </button>
            <a href={`/api/v1/portal/documents/${d.id}/pdf`} target="_blank" rel="noreferrer"
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-50">
              Download PDF
            </a>
            {!readOnly && d.type === 'invoice' && d.outstanding > 0 && d.status !== 'void' && (
              <button onClick={() => onPay(d.id)} disabled={paying}
                className="rounded-lg px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60" style={accent}>
                {paying ? 'Opening...' : `Pay ${money(d.currency, d.outstanding)}`}
              </button>
            )}
            {!readOnly && d.type === 'quote' && d.status === 'sent' && !d.decision && (
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

/**
 * The question only the client can answer.
 *
 * Klippy cannot know which domain someone bought hosting for. Rather than leaving a
 * paying customer with nothing while somebody remembers to ask, the sale asks them,
 * and this is where they answer. Sits above their existing hosting because it is
 * the one thing on this page that needs doing.
 */
function AwaitingDomain() {
  const qc = useQueryClient();
  const [values, setValues] = useState<Record<number, string>>({});
  const [done, setDone] = useState('');
  const [err, setErr] = useState('');

  const { data } = useQuery({
    queryKey: ['portal-awaiting'],
    queryFn: () => apiGet<{
      awaiting: {
        id: number; offeringName: string;
        onHoldingAddress: boolean; holdingDomain: string | null;
      }[];
    }>('/portal/hosting/awaiting'),
  });
  const submit = useMutation({
    mutationFn: (v: { id: number; domain: string }) =>
      apiPost<{ message: string }>(`/portal/hosting/${v.id}/domain`, { domain: v.domain }),
    onSuccess: (r) => {
      setErr(''); setDone(r.message);
      qc.invalidateQueries({ queryKey: ['portal-awaiting'] });
      qc.invalidateQueries({ queryKey: ['portal-hosting'] });
    },
    onError: (e) => setErr(e instanceof Error ? e.message : 'Could not save that.'),
  });

  const rows = data?.awaiting ?? [];
  if (done) {
    return <div className="mb-3 rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-800">{done}</div>;
  }
  if (!rows.length) return null;

  return (
    <div className="mb-3 space-y-3">
      {rows.map((a) => (
        <div key={a.id} className={`rounded-xl border p-4 ${
          a.onHoldingAddress ? 'border-sky-200 bg-sky-50' : 'border-amber-200 bg-amber-50'}`}>
          <div className={`text-sm font-medium ${a.onHoldingAddress ? 'text-sky-900' : 'text-amber-900'}`}>
            {a.onHoldingAddress
              ? 'Ready to use your own domain?'
              : `Which domain is your ${a.offeringName} for?`}
          </div>
          <p className={`mt-0.5 text-xs ${a.onHoldingAddress ? 'text-sky-800' : 'text-amber-800'}`}>
            {a.onHoldingAddress
              ? `Your hosting is already running on ${a.holdingDomain}. When you have your own domain, enter it here and we will move your site across. Nothing you have built is lost.`
              : 'Enter it and your hosting is set up straight away, usually within a minute.'}
          </p>
          {err && <p className="mt-2 text-xs text-red-700">{err}</p>}
          <form className="mt-2 flex flex-wrap gap-2"
            onSubmit={(e) => { e.preventDefault(); submit.mutate({ id: a.id, domain: values[a.id] ?? '' }); }}>
            <input
              className={`min-w-0 flex-1 rounded-lg border bg-white px-3 py-2 text-sm outline-none ${
                a.onHoldingAddress ? 'border-sky-300 focus:border-sky-500' : 'border-amber-300 focus:border-amber-500'}`}
              placeholder="yourbusiness.co.za"
              value={values[a.id] ?? ''}
              onChange={(e) => setValues({ ...values, [a.id]: e.target.value })} />
            <button type="submit" disabled={submit.isPending || !(values[a.id] ?? '').trim()}
              className={`rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50 ${
                a.onHoldingAddress ? 'bg-sky-700 hover:bg-sky-800' : 'bg-amber-700 hover:bg-amber-800'}`}>
              {submit.isPending
                ? (a.onHoldingAddress ? 'Moving...' : 'Setting up...')
                : (a.onHoldingAddress ? 'Use this domain' : 'Set up my hosting')}
            </button>
          </form>
          <p className={`mt-1.5 text-[11px] ${a.onHoldingAddress ? 'text-sky-800/80' : 'text-amber-800/80'}`}>
            No http and no www, just the domain.
            {a.onHoldingAddress
              ? ' Point your domain at us first, or it will not load once we move it. If you built a site on the temporary address, some links may still point at the old one and need updating.'
              : ' If you have not registered one yet, reply to our email and we will help.'}
          </p>
        </div>
      ))}
    </div>
  );
}

interface StatementLine { date: string; kind: string; ref: string; change: string; balance: string }

/**
 * A running-balance statement: every invoice, credit and payment, oldest first.
 *
 * The endpoint existed and nothing called it, so a client had no way to reconcile
 * their account with their own books. Drawn in one currency at a time, because a
 * running balance across two is not a number; a switcher appears only when the
 * client has been billed in more than one.
 */
function Statement() {
  const [cur, setCur] = useState<string | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ['portal-statement', cur],
    queryFn: () => apiGet<{ statement: StatementLine[]; closingBalance: string; currency: string; currencies: string[] }>(
      `/portal/statement${cur ? `?currency=${cur}` : ''}`),
  });
  if (isLoading) return <p className="text-sm text-slate-500">Loading...</p>;
  const rows = data?.statement ?? [];
  const currency = data?.currency ?? 'ZAR';
  const others = data?.currencies ?? [];
  const KIND: Record<string, string> = { invoice: 'Invoice', credit_note: 'Credit note', payment: 'Payment' };

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-800">Statement of account</h2>
        {others.length > 1 && (
          <select value={currency} onChange={(e) => setCur(e.target.value)}
            className="rounded-lg border border-slate-300 px-2 py-1 text-xs">
            {others.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        )}
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-slate-500">No activity yet.</p>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-slate-200 text-left text-[10px] uppercase tracking-wide text-slate-400">
              <th className="py-1 pr-2">Date</th>
              <th className="py-1 px-2">Detail</th>
              <th className="py-1 px-2 text-right">Change</th>
              <th className="py-1 pl-2 text-right">Balance</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((l, i) => (
              <tr key={i} className="border-b border-slate-100 last:border-0">
                <td className="py-1.5 pr-2 num text-slate-500">{l.date}</td>
                <td className="py-1.5 px-2 text-slate-700">{KIND[l.kind] ?? l.kind} {l.ref}</td>
                <td className={`py-1.5 px-2 text-right num ${Number(l.change) < 0 ? 'text-green-700' : 'text-slate-700'}`}>{money(currency, l.change)}</td>
                <td className="py-1.5 pl-2 text-right num font-medium text-slate-800">{money(currency, l.balance)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-slate-300">
              <td colSpan={3} className="py-2 pr-2 text-right font-medium text-slate-600">Balance owing</td>
              <td className="py-2 pl-2 text-right num font-semibold text-slate-900">{money(currency, data?.closingBalance ?? 0)}</td>
            </tr>
          </tfoot>
        </table>
      )}
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
    return (
      <div>
        <AwaitingDomain />
        <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
          No hosting on your account.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <AwaitingDomain />
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
              {Number(h.outstanding) > 0 ? ` of ${money(h.currency, h.outstanding)}` : ''}.
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

/**
 * What the business actually did this month: cards finished and hours worked,
 * straight from the boards and timers. The standing answer to "what am I
 * paying for?".
 */
function WorkReport() {
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const { data, isLoading } = useQuery({
    queryKey: ['portal-report', month],
    queryFn: () => apiGet<{
      month: string;
      boards: { name: string; hours: number }[];
      completed: { title: string; on: string | null; board: string | null }[];
      totalHours: number;
    }>(`/portal/report?month=${month}`),
  });

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">Work this month</h2>
        <input type="month" value={month} onChange={(e) => setMonth(e.target.value)}
          className="rounded-lg border border-slate-300 px-2 py-1 text-xs text-slate-700" />
      </div>
      {isLoading && <p className="py-4 text-center text-xs text-slate-400">Loading.</p>}
      {data && data.boards.length === 0 && data.completed.length === 0 && (
        <p className="py-6 text-center text-sm text-slate-500">No work recorded for {data.month}.</p>
      )}
      {data && data.totalHours > 0 && (
        <div className="mb-4">
          <div className="text-xs uppercase tracking-wide text-slate-500">Hours worked</div>
          <div className="text-2xl font-semibold num">{data.totalHours}h</div>
          <div className="mt-2 space-y-1">
            {data.boards.map((b) => (
              <div key={b.name} className="flex items-baseline justify-between text-sm">
                <span className="text-slate-700">{b.name}</span>
                <span className="num text-slate-500">{b.hours}h</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {data && data.completed.length > 0 && (
        <div>
          <div className="mb-1 text-xs uppercase tracking-wide text-slate-500">Finished</div>
          <ul className="space-y-1">
            {data.completed.map((cItem, i) => (
              <li key={i} className="flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0 truncate text-slate-700">{cItem.title}</span>
                <span className="num shrink-0 text-xs text-slate-400">{cItem.on ?? ''}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
