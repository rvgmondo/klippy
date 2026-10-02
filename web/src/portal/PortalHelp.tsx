import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, ApiError } from '../lib/api';

/**
 * Asking the business for help, from the portal.
 *
 * Written for a client who is mildly stressed ("my site is down"): one box to
 * say what is wrong, then a plain promise of what happens next. Earlier requests
 * sit underneath with the whole conversation, so nobody has to dig through email
 * to find what was agreed.
 */

interface Req { id: number; subject: string; status: 'open' | 'answered' | 'closed'; lastMessageAt: string }
interface Thread {
  request: { id: number; subject: string; status: Req['status'] };
  messages: { id: number; fromClient: boolean; authorName: string | null; body: string; createdAt: string }[];
}

const STATUS: Record<Req['status'], { label: string; cls: string }> = {
  open: { label: 'With us', cls: 'bg-amber-100 text-amber-800' },
  answered: { label: 'Answered', cls: 'bg-sky-100 text-sky-800' },
  closed: { label: 'Done', cls: 'bg-slate-100 text-slate-600' },
};
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const field = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-500';

export function PortalHelp({ brandName, whatsapp, readOnly, accent, openId }: {
  brandName: string; whatsapp: string | null; readOnly: boolean; accent: React.CSSProperties; openId: number | null;
}) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['portal-help'], queryFn: () => apiGet<{ requests: Req[] }>('/portal/support') });
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [open, setOpen] = useState<number | null>(openId);
  const [sentId, setSentId] = useState<number | null>(null);
  const ask = useMutation({
    mutationFn: () => apiPost<{ id: number }>('/portal/support', { subject, body }),
    onSuccess: (r) => {
      setSubject(''); setBody(''); setSentId(r.id); setOpen(r.id);
      void qc.invalidateQueries({ queryKey: ['portal-help'] });
    },
  });
  const requests = data?.requests ?? [];

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="text-base font-semibold">Ask {brandName} for help</h2>
        <p className="mt-1 text-sm text-slate-500">
          Tell us what is wrong or what you need. We get it straight away, and our answer comes to your email and shows here.
        </p>
        {sentId && (
          <p className="mt-3 rounded-lg bg-green-50 p-3 text-sm text-green-800">Thank you, we have it. You will hear from us by email.</p>
        )}
        <div className="mt-3 space-y-3">
          <input className={field} value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200}
            placeholder="What is it about? For example: Contact form not working" aria-label="What it is about" disabled={readOnly} />
          <textarea className={`${field} min-h-[120px] resize-y`} value={body} onChange={(e) => setBody(e.target.value)}
            placeholder="What happened, and what you need us to do" aria-label="What you need" disabled={readOnly} />
          {ask.error && <p className="text-sm text-red-600">{ask.error instanceof ApiError ? ask.error.message : 'That did not send. Try again.'}</p>}
          <div className="flex flex-wrap items-center gap-3">
            <button onClick={() => ask.mutate()} disabled={readOnly || !subject.trim() || !body.trim() || ask.isPending}
              className="rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50" style={accent}>
              {ask.isPending ? 'Sending' : 'Send'}
            </button>
            {whatsapp && (
              <a href={`https://wa.me/${whatsapp}`} target="_blank" rel="noopener"
                className="text-sm text-emerald-700 underline">Urgent? WhatsApp us</a>
            )}
          </div>
          {readOnly && <p className="text-xs text-slate-500">Previewing as staff, so this cannot be sent.</p>}
        </div>
      </div>

      {requests.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold text-slate-700">Your requests</h3>
          <ul className="space-y-2">
            {requests.map((r) => (
              <li key={r.id} className="rounded-xl border border-slate-200 bg-white">
                <button onClick={() => setOpen(open === r.id ? null : r.id)} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left">
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{r.subject}</span>
                    <span className="block text-xs text-slate-500">{when(r.lastMessageAt)}</span>
                  </span>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${STATUS[r.status].cls}`}>{STATUS[r.status].label}</span>
                </button>
                {open === r.id && <Conversation id={r.id} readOnly={readOnly} accent={accent} />}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Conversation({ id, readOnly, accent }: { id: number; readOnly: boolean; accent: React.CSSProperties }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['portal-help', id], queryFn: () => apiGet<Thread>(`/portal/support/${id}`) });
  const [text, setText] = useState('');
  const reply = useMutation({
    mutationFn: () => apiPost(`/portal/support/${id}/reply`, { body: text }),
    onSuccess: () => {
      setText('');
      void qc.invalidateQueries({ queryKey: ['portal-help'] });
    },
  });
  if (!data) return <p className="border-t border-slate-100 px-4 py-3 text-xs text-slate-500">Loading</p>;
  return (
    <div className="space-y-3 border-t border-slate-100 px-4 py-3">
      <ul className="space-y-2">
        {data.messages.map((m) => (
          <li key={m.id} className={`max-w-[92%] rounded-xl px-3 py-2 text-sm ${m.fromClient ? 'ml-auto bg-slate-100' : 'bg-sky-50'}`}>
            <p className="mb-0.5 text-[11px] text-slate-500">{m.fromClient ? 'You' : (m.authorName || 'Us')}, {when(m.createdAt)}</p>
            <p className="whitespace-pre-line text-slate-800">{m.body}</p>
          </li>
        ))}
      </ul>
      {!readOnly && (
        <>
          <textarea className={`${field} min-h-[80px] resize-y`} value={text} onChange={(e) => setText(e.target.value)}
            placeholder={data.request.status === 'closed' ? 'Not sorted after all? Write here and it opens again' : 'Add something'} />
          {reply.error && <p className="text-sm text-red-600">That did not send. Try again.</p>}
          <button onClick={() => reply.mutate()} disabled={!text.trim() || reply.isPending}
            className="rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50" style={accent}>Send</button>
        </>
      )}
    </div>
  );
}
