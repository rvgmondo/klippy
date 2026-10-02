import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Mail, LifeBuoy, Send, Check, X, RotateCcw } from 'lucide-react';
import { apiGet, apiPost, ApiError } from '../lib/api';
import { notify } from './ConfirmDialog';
import { Card, btnPrimary, btnSecondary, fieldClass } from './ui';

/**
 * Talking to one client: their help requests from the portal, and every email
 * written to them from Klippy.
 *
 * Help requests come first because they are the ones somebody is waiting on. The
 * status words say who owes the next message, which is all a small business needs
 * to know about a conversation.
 */

interface SentEmail {
  id: number; to: string; subject: string; body: string; status: 'sent' | 'failed';
  error: string | null; createdAt: string; by: string | null;
}
interface HelpRow { id: number; subject: string; status: 'open' | 'answered' | 'closed'; lastMessageAt: string; createdAt: string }
interface HelpThread {
  request: { id: number; subject: string; status: HelpRow['status']; askedBy: { name: string | null; email: string } | null; taskId: number | null };
  messages: { id: number; fromClient: boolean; authorName: string | null; body: string; createdAt: string }[];
}

const STATUS: Record<HelpRow['status'], { label: string; cls: string }> = {
  open: { label: 'Waiting on you', cls: 'bg-amber-500/15 text-amber-300' },
  answered: { label: 'Answered', cls: 'bg-sky-500/15 text-sky-300' },
  closed: { label: 'Done', cls: 'bg-slate-700/60 text-slate-400' },
};

const when = (iso: string) => new Date(iso).toLocaleString(undefined, {
  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
});

export function ClientMessages({ clientId, openHelpId, onWrite }: {
  clientId: number;
  openHelpId: number | null;
  onWrite: () => void;
}) {
  const help = useQuery({
    queryKey: ['client-help', clientId],
    queryFn: () => apiGet<{ requests: HelpRow[] }>(`/support?folderId=${clientId}`),
  });
  const emails = useQuery({
    queryKey: ['client-emails', clientId],
    queryFn: () => apiGet<{ emails: SentEmail[] }>(`/clients/${clientId}/emails`),
  });
  const [open, setOpen] = useState<number | null>(openHelpId);
  const [shown, setShown] = useState<number | null>(null);

  const requests = help.data?.requests ?? [];
  const sent = emails.data?.emails ?? [];

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <h2 className="mb-1 flex items-center gap-2 font-semibold text-slate-100"><LifeBuoy size={15} /> Help requests</h2>
        <p className="mb-3 text-xs text-slate-500">What they asked for in their portal. Your answer is emailed to them and shows in their portal.</p>
        {requests.length === 0 ? (
          <p className="text-sm text-slate-400">Nothing asked yet.</p>
        ) : (
          <ul className="space-y-2">
            {requests.map((r) => (
              <li key={r.id} className="rounded-lg border border-slate-800">
                <button onClick={() => setOpen(open === r.id ? null : r.id)}
                  className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-slate-800/40">
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-slate-100">{r.subject}</span>
                    <span className="block text-xs text-slate-500">{when(r.lastMessageAt)}</span>
                  </span>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS[r.status].cls}`}>{STATUS[r.status].label}</span>
                </button>
                {open === r.id && <HelpConversation id={r.id} clientId={clientId} />}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <div className="mb-1 flex items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 font-semibold text-slate-100"><Mail size={15} /> Emails you sent</h2>
          <button onClick={onWrite}
            className={`${btnSecondary} inline-flex items-center gap-1.5 px-3 py-1.5`}><Send size={13} /> Write</button>
        </div>
        <p className="mb-3 text-xs text-slate-500">Written from Klippy. Their replies go to your normal inbox.</p>
        {sent.length === 0 ? (
          <p className="text-sm text-slate-400">Nothing sent from Klippy yet.</p>
        ) : (
          <ul className="space-y-2">
            {sent.map((e) => (
              <li key={e.id} className="rounded-lg border border-slate-800">
                <button onClick={() => setShown(shown === e.id ? null : e.id)} className="w-full px-3 py-2.5 text-left hover:bg-slate-800/40">
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium text-slate-100">{e.subject}</span>
                    {e.status === 'failed' && <span className="shrink-0 text-[11px] text-red-400">Not sent</span>}
                  </span>
                  <span className="block truncate text-xs text-slate-500">
                    {when(e.createdAt)}, to {e.to}{e.by ? `, by ${e.by}` : ''}
                  </span>
                </button>
                {shown === e.id && (
                  <div className="border-t border-slate-800 px-3 py-2.5">
                    {e.error && <p className="mb-2 text-xs text-red-400">{e.error}</p>}
                    <p className="whitespace-pre-line text-sm text-slate-300">{e.body}</p>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function HelpConversation({ id, clientId }: { id: number; clientId: number }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['help', id], queryFn: () => apiGet<HelpThread>(`/support/${id}`) });
  const [text, setText] = useState('');
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['help', id] });
    void qc.invalidateQueries({ queryKey: ['client-help', clientId] });
    void qc.invalidateQueries({ queryKey: ['home'] });
  };
  const reply = useMutation({
    mutationFn: (close: boolean) => apiPost<{ emailed: boolean }>(`/support/${id}/reply`, { body: text, close }),
    onSuccess: (r) => {
      setText(''); refresh();
      notify(r.emailed ? 'Sent. They have it by email too.' : 'Saved. They will see it in their portal, but no email went out.', r.emailed ? 'ok' : 'error');
    },
    onError: (e) => notify(e instanceof ApiError ? e.message : 'That did not send.', 'error'),
  });
  const setStatus = useMutation({
    mutationFn: (status: HelpRow['status']) => apiPost(`/support/${id}/status`, { status }),
    onSuccess: refresh,
  });
  if (!data) return <p className="border-t border-slate-800 px-3 py-3 text-xs text-slate-500">Loading</p>;
  const closed = data.request.status === 'closed';

  return (
    <div className="space-y-3 border-t border-slate-800 px-3 py-3">
      {data.request.askedBy && (
        <p className="text-xs text-slate-500">Asked by {data.request.askedBy.name || data.request.askedBy.email}{data.request.taskId ? '. It is also a card on their board.' : '.'}</p>
      )}
      <ul className="space-y-2">
        {data.messages.map((m) => (
          <li key={m.id} className={`max-w-[92%] rounded-xl px-3 py-2 text-sm ${m.fromClient
            ? 'bg-slate-800/70 text-slate-200' : 'ml-auto bg-[var(--accent-quiet)] text-slate-100'}`}>
            <p className="mb-0.5 text-[11px] text-slate-500">{m.fromClient ? (m.authorName || 'Client') : (m.authorName || 'You')}, {when(m.createdAt)}</p>
            <p className="whitespace-pre-line">{m.body}</p>
          </li>
        ))}
      </ul>
      <textarea className={`${fieldClass} min-h-[88px] resize-y`} value={text} onChange={(e) => setText(e.target.value)}
        placeholder="Write your answer" aria-label="Your answer" />
      <div className="flex flex-wrap gap-2">
        <button className={`${btnPrimary} inline-flex items-center gap-1.5`} disabled={!text.trim() || reply.isPending}
          onClick={() => reply.mutate(false)}><Send size={14} /> Send</button>
        <button className={`${btnSecondary} inline-flex items-center gap-1.5`} disabled={!text.trim() || reply.isPending}
          onClick={() => reply.mutate(true)}><Check size={14} /> Send and mark done</button>
        {closed ? (
          <button className={`${btnSecondary} inline-flex items-center gap-1.5`} onClick={() => setStatus.mutate('open')}><RotateCcw size={14} /> Open again</button>
        ) : (
          <button className={`${btnSecondary} inline-flex items-center gap-1.5`} onClick={() => setStatus.mutate('closed')}><X size={14} /> Mark done without replying</button>
        )}
      </div>
    </div>
  );
}

/**
 * Write a client an email, from the business's own address.
 *
 * The addresses on file are offered as ticks, because picking is faster than
 * typing and cannot be misspelt; another address can still be added.
 */
export function EmailComposer({ clientId, clientName, addresses, onClose }: {
  clientId: number; clientName: string; addresses: string[]; onClose: () => void;
}) {
  const qc = useQueryClient();
  const [picked, setPicked] = useState<string[]>(addresses.slice(0, 1));
  const [other, setOther] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const extra = other.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
  const to = [...new Set([...picked, ...extra])];
  const send = useMutation({
    mutationFn: () => apiPost('/clients/' + clientId + '/emails', { to, subject, body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['client-emails', clientId] });
      notify('Sent.', 'ok');
      onClose();
    },
    onError: (e) => {
      void qc.invalidateQueries({ queryKey: ['client-emails', clientId] });
      notify(e instanceof ApiError ? e.message : 'That did not send.', 'error');
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center sm:p-4" onClick={onClose}>
      <div className="max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-t-2xl border border-slate-700 bg-slate-900 p-4 sm:rounded-2xl sm:p-5"
        onClick={(e) => e.stopPropagation()} role="dialog" aria-label={`Email ${clientName}`}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold text-slate-100">Email {clientName}</h2>
          <button onClick={onClose} className="grid h-9 w-9 place-items-center rounded-lg text-slate-400 hover:bg-slate-800" aria-label="Close"><X size={16} /></button>
        </div>
        <div className="space-y-3">
          <div>
            <p className="mb-1 text-xs text-slate-500">To</p>
            {addresses.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-2">
                {addresses.map((a) => (
                  <label key={a} className={`inline-flex cursor-pointer focus-within:ring-2 focus-within:ring-[var(--accent)] items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${picked.includes(a)
                    ? 'border-[var(--accent)] text-slate-100' : 'border-slate-700 text-slate-400'}`}>
                    <input type="checkbox" className="sr-only" checked={picked.includes(a)}
                      onChange={() => setPicked(picked.includes(a) ? picked.filter((x) => x !== a) : [...picked, a])} />
                    {picked.includes(a) && <Check size={12} />}{a}
                  </label>
                ))}
              </div>
            )}
            <input className={fieldClass} value={other} onChange={(e) => setOther(e.target.value)} inputMode="email"
              aria-label={addresses.length ? 'Another address' : 'Their email address'}
              placeholder={addresses.length ? 'Another address (optional)' : 'Their email address'} />
          </div>
          <div>
            <label htmlFor="mail-subject" className="mb-1 block text-xs text-slate-500">Subject</label>
            <input id="mail-subject" className={fieldClass} value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} />
          </div>
          <div>
            <label htmlFor="mail-body" className="mb-1 block text-xs text-slate-500">Message</label>
            <textarea id="mail-body" className={`${fieldClass} min-h-[180px] resize-y`} value={body} onChange={(e) => setBody(e.target.value)}
              placeholder={'Hi,\n\n'} />
          </div>
          <p className="text-[11px] text-slate-500">It goes from this business's email address with your logo, and a copy is kept on this client. Replies go to your normal inbox.</p>
          <div className="flex justify-end gap-2">
            <button className={btnSecondary} onClick={onClose}>Cancel</button>
            <button className={`${btnPrimary} inline-flex items-center gap-1.5`}
              disabled={to.length === 0 || !subject.trim() || !body.trim() || send.isPending}
              onClick={() => send.mutate()}><Send size={14} /> {send.isPending ? 'Sending' : 'Send'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

