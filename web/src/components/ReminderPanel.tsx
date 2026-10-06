import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, BellOff, CalendarClock } from 'lucide-react';
import { apiGet, apiPatch, ApiError } from '../lib/api';
import { money } from '../lib/money';
import { navigateTo } from '../lib/urlAction';
import { notify } from './ConfirmDialog';
import { btnSecondary, fieldClass } from './ui';

/**
 * Reminders on one invoice: what went, when the next one goes, and the controls.
 *
 * "Next" is worked out by the server with the same rule the daily run uses, so
 * the date here is the date it goes. When nothing is coming, it says why, in the
 * same words, because "why did they not get a reminder" is the other half of the
 * question.
 */

interface State {
  plan: { next: string | null; kind: 'reminder' | 'final' | null; reason: string | null; moved: boolean };
  history: { id: number; kind: 'reminder' | 'final' | 'chase'; channels: string; sentTo: string | null; amount: string | null; createdAt: string; by: string | null }[];
  lastReminderOn: string | null;
  paused: boolean; clientPaused: boolean; clientName: string;
  nextReminderOn: string | null;
  schedule: { enabled: boolean; offsets: number[]; finalAfter: number | null };
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const say = (d: string) => `${Number(d.slice(8, 10))} ${MON[Number(d.slice(5, 7)) - 1]}`;
const todayIso = () => new Date().toISOString().slice(0, 10);
const inDays = (d: string) => Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${todayIso()}T00:00:00Z`)) / 86400000);
const KIND: Record<string, string> = { reminder: 'Reminder', final: 'Final notice', chase: 'Chased by hand' };

export function ReminderPanel({ docId, currency, folderId }: { docId: number; currency: string; folderId: number | null }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['reminders', docId], queryFn: () => apiGet<State>(`/documents/${docId}/reminders`) });
  const [moving, setMoving] = useState(false);
  const [date, setDate] = useState('');

  const done = (s: State) => {
    qc.setQueryData(['reminders', docId], s);
    void qc.invalidateQueries({ queryKey: ['collections'] });
    void qc.invalidateQueries({ queryKey: ['home'] });
  };
  const change = useMutation({
    mutationFn: (body: { paused?: boolean; nextReminderOn?: string | null }) => apiPatch<State>(`/documents/${docId}/reminders`, body),
    onSuccess: (s, body) => {
      done(s); setMoving(false);
      notify(body.paused === true ? 'Reminders paused for this invoice.' : body.paused === false ? 'Reminders back on.'
        : body.nextReminderOn ? `The next reminder goes on ${say(body.nextReminderOn)}.` : 'Back on the normal schedule.', 'ok');
    },
    onError: (e) => notify(e instanceof ApiError ? e.message : 'That did not save.', 'error'),
  });
  const client = useMutation({
    mutationFn: (paused: boolean) => apiPatch(`/clients/${folderId}/reminders`, { paused }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['reminders', docId] }); void qc.invalidateQueries({ queryKey: ['client', folderId] }); },
    onError: (e) => notify(e instanceof ApiError ? e.message : 'That did not save.', 'error'),
  });

  if (!data) return null;
  const { plan } = data;
  const n = plan.next ? inDays(plan.next) : null;
  const when = plan.next ? (n === 0 ? 'today' : n === 1 ? 'tomorrow' : `on ${say(plan.next)}, in ${n} days`) : '';
  // Only an invoice that is actually being chased (or deliberately not) has controls.
  const chaseable = !!plan.next || data.paused || data.clientPaused || plan.reason === 'No more reminders on the schedule.';

  return (
    <section>
      <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-slate-200"><BellRing size={14} /> Reminders</h3>
      <div className="space-y-3 rounded-xl border border-slate-800 p-3 text-sm">
        <div className="flex items-start gap-2">
          {plan.next ? <CalendarClock size={15} className="mt-0.5 shrink-0 text-[var(--accent)]" /> : <BellOff size={15} className="mt-0.5 shrink-0 text-slate-500" />}
          <p className="text-slate-300">
            {plan.next
              ? <>{plan.kind === 'final' ? 'The final notice' : 'The next reminder'} goes <span className="font-medium text-slate-100">{when}</span>{plan.moved ? ', a date you chose' : ''}.</>
              : plan.reason}
            <span className="block text-xs text-slate-500">
              {data.lastReminderOn ? `Last one went on ${say(data.lastReminderOn)}.` : 'None sent yet.'}
              {data.schedule.enabled && !plan.moved ? ` Schedule: ${data.schedule.offsets.map((o) => (o < 0 ? `${-o} days before due` : o === 0 ? 'on the due date' : `${o} days after`)).join(', ')}.` : ''}
            </span>
          </p>
        </div>

        {chaseable && (
          <div className="flex flex-wrap gap-2">
            {data.paused ? (
              <button className={`${btnSecondary} px-3 py-1.5`} disabled={change.isPending} onClick={() => change.mutate({ paused: false })}>Turn reminders back on</button>
            ) : !data.clientPaused && (
              <button className={`${btnSecondary} px-3 py-1.5`} disabled={change.isPending} onClick={() => change.mutate({ paused: true })}>Pause for this invoice</button>
            )}
            {!data.clientPaused && (
              <button className={`${btnSecondary} px-3 py-1.5`} onClick={() => { setMoving(!moving); setDate(plan.next ?? todayIso()); }}>Change the date</button>
            )}
            {data.nextReminderOn && (
              <button className={`${btnSecondary} px-3 py-1.5`} disabled={change.isPending} onClick={() => change.mutate({ nextReminderOn: null })}>Back to the schedule</button>
            )}
            {folderId != null && (
              <button className={`${btnSecondary} px-3 py-1.5`} disabled={client.isPending} onClick={() => client.mutate(!data.clientPaused)}>
                {data.clientPaused ? `Chase ${data.clientName} again` : `Never chase ${data.clientName}`}
              </button>
            )}
          </div>
        )}
        {moving && (
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-slate-500">Next reminder on
              <input type="date" min={todayIso()} className={`${fieldClass} mt-1`} value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
            <button className={`${btnSecondary} px-3 py-2`} disabled={!date || change.isPending} onClick={() => change.mutate({ nextReminderOn: date })}>Save</button>
          </div>
        )}
        {data.clientPaused && <p className="text-xs text-amber-300">Nothing is sent to {data.clientName} automatically. Chase still works when you press it.</p>}

        {data.history.length > 0 && (
          <ul className="space-y-1 border-t border-slate-800 pt-2 text-xs">
            {data.history.map((h) => (
              <li key={h.id} className="flex justify-between gap-3 text-slate-400">
                <span>{say(h.createdAt.slice(0, 10))}, {KIND[h.kind]}{h.by ? ` by ${h.by}` : ''}, by {h.channels}</span>
                {h.amount && <span className="num shrink-0">{money(h.amount, currency)}</span>}
              </li>
            ))}
          </ul>
        )}
        {!data.schedule.enabled && (
          <button onClick={() => navigateTo('settings', { s: 'biz:reminders' })} className="text-xs text-[var(--accent)]">Turn reminders on in Settings</button>
        )}
      </div>
    </section>
  );
}
