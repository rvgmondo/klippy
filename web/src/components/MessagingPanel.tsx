import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPatch, apiPost, apiDelete } from '../lib/api';
import { notify } from './ConfirmDialog';
import { fieldClass, Skeleton } from './ui';

interface Settings {
  scope: 'own' | 'workspace' | 'none';
  smsProvider: 'none' | 'bulksms';
  smsTokenId: string;
  smsSecretSet: boolean;
  smsSender: string;
  waPhoneNumberId: string;
  waTokenSet: boolean;
  waTemplateName: string;
  waTemplateLang: string;
  remindBySms: boolean;
  remindByWhatsapp: boolean;
  active: { sms: boolean; whatsapp: boolean };
  secretsAvailable: boolean;
}

/**
 * SMS and WhatsApp reminders.
 *
 * Email from a small business gets ignored; a WhatsApp or an SMS gets read.
 * The click-to-chat buttons on Collections and Billing need nothing from here.
 * This panel is for the AUTOMATED layer: the reminder schedule and Chase also
 * sending by SMS (BulkSMS) and WhatsApp (Meta Cloud API) once credentials are
 * in and a channel is switched on. Same shape as Payments: a workspace default,
 * optionally overridden per business.
 */
export function MessagingPanel({ businessId }: { businessId?: number } = {}) {
  const qc = useQueryClient();
  const base = businessId ? `/businesses/${businessId}/messaging` : '/account/messaging';
  const { data, isLoading } = useQuery({ queryKey: ['messaging', businessId ?? 0], queryFn: () => apiGet<Settings>(base) });

  const [smsTokenId, setSmsTokenId] = useState('');
  const [smsSecret, setSmsSecret] = useState('');
  const [smsSender, setSmsSender] = useState('');
  const [waPhoneId, setWaPhoneId] = useState('');
  const [waToken, setWaToken] = useState('');
  const [waTemplate, setWaTemplate] = useState('');
  const [waLang, setWaLang] = useState('en');
  const [testTo, setTestTo] = useState('');

  useEffect(() => {
    if (!data) return;
    setSmsTokenId(data.smsTokenId); setSmsSender(data.smsSender);
    setWaPhoneId(data.waPhoneNumberId); setWaTemplate(data.waTemplateName); setWaLang(data.waTemplateLang || 'en');
  }, [data]);

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiPatch<Settings>(base, body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['messaging'] }); setSmsSecret(''); setWaToken(''); notify('Saved.'); },
    onError: (e) => notify(e instanceof Error ? e.message : 'Could not save.', 'error'),
  });
  const reset = useMutation({
    mutationFn: () => apiDelete(base),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['messaging'] }); notify('Back to the workspace default.'); },
  });
  const test = useMutation({
    mutationFn: (channel: 'sms' | 'whatsapp') => apiPost<{ ok: true; to: string }>('/account/messaging/test', {
      businessId: businessId ?? 0, to: testTo, channel,
    }),
    onSuccess: (r) => notify(`Sent to ${r.to}. Check the phone.`),
    onError: (e) => notify(e instanceof Error ? e.message : 'The provider refused the message.', 'error'),
  });

  const field = fieldClass;
  if (isLoading || !data) return <Skeleton className="h-40" />;

  const inherited = businessId && data.scope === 'workspace';

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-slate-200">SMS and WhatsApp reminders</h3>
        <p className="mt-1 text-xs text-slate-500">
          The WhatsApp buttons on Collections and Billing work already, from your own phone, with nothing set up here.
          This is for Klippy sending on its own: when a channel below is on, the reminder schedule and Chase send it
          alongside the email, to the phone number on the client. Every send is logged under Automation.
        </p>
        {!data.secretsAvailable && (
          <p className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
            The server has no PAYMENTS_SECRET, so API tokens cannot be stored yet.
          </p>
        )}
        {inherited && (
          <p className="mt-2 text-xs text-slate-500">
            This business uses the workspace settings. Saving anything below gives it its own.
          </p>
        )}
      </div>

      {/* ---- SMS -------------------------------------------------------------- */}
      <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
        <div className="mb-1 flex items-center gap-2">
          <h4 className="text-sm font-semibold text-slate-200">SMS via BulkSMS</h4>
          {data.active.sms && <span className="rounded bg-green-500/15 px-1.5 py-0.5 text-[10px] font-medium text-green-300">Sending</span>}
        </div>
        <p className="mb-3 text-xs text-slate-500">
          South African, pay-as-you-go, about R0.30 a message. Sign up at bulksms.com, buy credits, then create an
          API token under Settings &gt; Advanced and paste the pair here.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          <input className={field} placeholder="Token id" value={smsTokenId} onChange={(e) => setSmsTokenId(e.target.value)} autoComplete="off" />
          <input className={field} type="password" placeholder={data.smsSecretSet ? 'Token secret (saved, enter to replace)' : 'Token secret'}
            value={smsSecret} onChange={(e) => setSmsSecret(e.target.value)} autoComplete="new-password" />
          <input className={field} placeholder="Sender id (optional, must be registered with BulkSMS)" value={smsSender} onChange={(e) => setSmsSender(e.target.value)} />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button onClick={() => save.mutate({
            smsProvider: 'bulksms', smsTokenId, smsSender,
            ...(smsSecret ? { smsTokenSecret: smsSecret } : {}),
          })} disabled={save.isPending}
            className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-[var(--accent-ink)] hover:bg-violet-500 disabled:opacity-60">
            Save SMS settings
          </button>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-300">
            <input type="checkbox" className="accent-violet-600" checked={data.remindBySms}
              onChange={(e) => save.mutate({ remindBySms: e.target.checked })} />
            Send reminders by SMS
          </label>
        </div>
      </section>

      {/* ---- WhatsApp --------------------------------------------------------- */}
      <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
        <div className="mb-1 flex items-center gap-2">
          <h4 className="text-sm font-semibold text-slate-200">WhatsApp via Meta Cloud API</h4>
          {data.active.whatsapp && <span className="rounded bg-green-500/15 px-1.5 py-0.5 text-[10px] font-medium text-green-300">Sending</span>}
        </div>
        <p className="mb-3 text-xs text-slate-500">
          Free tier, then roughly R0.50 a reminder. Needs a Meta Business account with a WhatsApp number that is not on
          a personal WhatsApp, and an approved message template. Create a Utility template with exactly five variables
          in this order: client name, invoice number, amount, when it is due, pay link. Then paste the phone number id,
          a permanent access token, and the template name.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          <input className={field} placeholder="Phone number id" value={waPhoneId} onChange={(e) => setWaPhoneId(e.target.value)} autoComplete="off" />
          <input className={field} type="password" placeholder={data.waTokenSet ? 'Access token (saved, enter to replace)' : 'Access token'}
            value={waToken} onChange={(e) => setWaToken(e.target.value)} autoComplete="new-password" />
          <input className={field} placeholder="Template name, e.g. invoice_reminder" value={waTemplate} onChange={(e) => setWaTemplate(e.target.value)} />
          <input className={field} placeholder="Template language code, e.g. en or en_US" value={waLang} onChange={(e) => setWaLang(e.target.value)} />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button onClick={() => save.mutate({
            waPhoneNumberId: waPhoneId, waTemplateName: waTemplate, waTemplateLang: waLang,
            ...(waToken ? { waAccessToken: waToken } : {}),
          })} disabled={save.isPending}
            className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-[var(--accent-ink)] hover:bg-violet-500 disabled:opacity-60">
            Save WhatsApp settings
          </button>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-300">
            <input type="checkbox" className="accent-violet-600" checked={data.remindByWhatsapp}
              onChange={(e) => save.mutate({ remindByWhatsapp: e.target.checked })} />
            Send reminders by WhatsApp
          </label>
        </div>
      </section>

      {/* ---- Test ------------------------------------------------------------- */}
      <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
        <h4 className="mb-1 text-sm font-semibold text-slate-200">Send yourself a test</h4>
        <p className="mb-3 text-xs text-slate-500">Proves the credentials before a client ever sees a message.</p>
        <div className="flex flex-wrap items-center gap-2">
          <input className={`${field} sm:max-w-xs`} placeholder="Your number, e.g. 082 123 4567" value={testTo} onChange={(e) => setTestTo(e.target.value)} inputMode="tel" />
          <button onClick={() => test.mutate('sms')} disabled={test.isPending || !testTo.trim()}
            className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-50">Test SMS</button>
          <button onClick={() => test.mutate('whatsapp')} disabled={test.isPending || !testTo.trim()}
            className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-50">Test WhatsApp</button>
        </div>
      </section>

      {businessId && data.scope === 'own' && (
        <button onClick={() => reset.mutate()} className="text-xs text-slate-500 hover:text-slate-300">
          Remove this business's own settings and use the workspace default
        </button>
      )}
    </div>
  );
}
