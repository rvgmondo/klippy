import { useState } from 'react';
import { confirmDialog } from './ConfirmDialog';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { apiGet, apiPost, apiPatch } from '../lib/api';
import { Modal } from './Modal';
import type { Deal, Contact, Activity } from './pipelineShared';
import { fieldClass } from './ui';

export function DealEditor({ deal, businessId, onClose, onSaved }: { deal?: Deal; businessId?: number; onClose: () => void; onSaved: () => void }) {
  const isNew = !deal;
  const [title, setTitle] = useState(deal?.title ?? '');
  const [company, setCompany] = useState(deal?.company ?? '');
  const [contactName, setContactName] = useState(deal?.contactName ?? '');
  const [contactEmail, setContactEmail] = useState(deal?.contactEmail ?? '');
  const [contactPhone, setContactPhone] = useState(deal?.contactPhone ?? '');
  const [value, setValue] = useState(deal ? String(Number(deal.value)) : '');
  const [notes, setNotes] = useState(deal?.notes ?? '');
  const [contactId, setContactId] = useState<number | null>(deal?.contactId ?? null);
  const [source, setSource] = useState(deal?.source ?? '');
  const [followUp, setFollowUp] = useState(deal?.nextFollowUpAt ?? '');
  const [followUpNote, setFollowUpNote] = useState(deal?.followUpNote ?? '');
  const [error, setError] = useState<string | null>(null);

  const contactsQ = useQuery({
    queryKey: ['contacts', businessId],
    queryFn: () => apiGet<{ contacts: Contact[] }>(
      businessId ? `/contacts?businessId=${businessId}` : '/contacts'),
  });

  /**
   * Promote whoever is typed on this deal into a saved contact.
   *
   * Contacts were listable and not creatable, so the picker only ever offered
   * people the migration happened to find. Saving from here is the natural moment:
   * the name, email and company are already in front of you, and the deal is
   * linked to the new record straight away rather than needing a second visit.
   */
  const qcp = useQueryClient();
  const saveContact = useMutation({
    mutationFn: () => apiPost<{ contact: Contact }>('/contacts', {
      name: contactName.trim() || company.trim() || title.trim(),
      email: contactEmail.trim() || null,
      phone: contactPhone.trim() || null,
      company: company.trim() || null,
      ...(businessId ? { businessId } : {}),
    }),
    onSuccess: (r) => {
      setContactId(r.contact.id);
      qcp.invalidateQueries({ queryKey: ['contacts'] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not save that contact.'),
  });

  const save = useMutation({
    mutationFn: () => {
      const body = {
        title: title.trim(), company: company.trim() || null, contactName: contactName.trim() || null,
        contactEmail: contactEmail.trim() || null, contactPhone: contactPhone.trim() || null,
        value: Number(value) || 0, notes: notes.trim() || null,
        contactId, source: source.trim() || null,
        nextFollowUpAt: followUp || null, followUpNote: followUpNote.trim() || null,
        ...(isNew && businessId ? { businessId } : {}),
      };
      return isNew ? apiPost('/deals', body) : apiPatch(`/deals/${deal!.id}`, body);
    },
    onSuccess: onSaved,
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not save.'),
  });

  const field = fieldClass;

  return (
    <Modal onClose={onClose} variant="panel"
      confirmClose={() => {
        // The same guard the invoice editor got after real work was lost to a
        // stray backdrop click: only ask when something typed would be lost.
        const dirty = title !== (deal?.title ?? '') || company !== (deal?.company ?? '')
          || contactName !== (deal?.contactName ?? '') || contactEmail !== (deal?.contactEmail ?? '')
          || value !== (deal ? String(Number(deal.value)) : '') || notes !== (deal?.notes ?? '');
        return dirty ? confirmDialog('Close without saving this deal?', { confirmLabel: 'Discard', danger: true }) : true;
      }}>
      <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-950 p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-100">{isNew ? 'New deal' : 'Edit deal'}</h2>
          <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-800"><X size={16} /></button>
        </div>
        <div className="space-y-2">
          <input className={field} placeholder="Deal title (e.g. Website redesign)" value={title} onChange={(e) => setTitle(e.target.value)} />
          <input className={field} placeholder="Company" value={company} onChange={(e) => setCompany(e.target.value)} />
          <div className="grid grid-cols-2 gap-2">
            <input className={field} placeholder="Contact name" value={contactName} onChange={(e) => setContactName(e.target.value)} />
            <input className={field} type="number" placeholder="Value" value={value} onChange={(e) => setValue(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input className={field} placeholder="Email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} />
            <input className={field} placeholder="Phone" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} />
          </div>
          <select className={field} value={contactId ?? ''}
            onChange={(e) => {
              if (e.target.value === '__new') { saveContact.mutate(); return; }
              const v = e.target.value ? Number(e.target.value) : null;
              setContactId(v);
              const c = contactsQ.data?.contacts.find((x) => x.id === v);
              // Keep the flat fields in step, so the deal still reads correctly
              // anywhere the contact record is not loaded alongside it.
              if (c) { setContactName(c.name); setContactEmail(c.email ?? ''); if (c.company) setCompany(c.company); }
            }}>
            <option value="">Link a saved contact (optional)</option>
            {(contactsQ.data?.contacts ?? []).map((c) => (
              <option key={c.id} value={c.id}>{c.name}{c.company ? ' - ' + c.company : ''}</option>
            ))}
            <option value="__new">+ Save this person as a contact</option>
          </select>
          <input className={field} placeholder="Where did this lead come from? (referral, Google, ...)"
            value={source} onChange={(e) => setSource(e.target.value)} />

          {/* The field that actually saves deals. A date turns "I must chase them"
              from something you remember at 2am into something on a list. */}
          <div className="rounded-lg border border-slate-800 p-2.5">
            <div className="mb-1.5 text-[11px] font-medium text-slate-400">Follow up</div>
            <div className="grid grid-cols-2 gap-2">
              <input className={field} type="date" value={followUp} onChange={(e) => setFollowUp(e.target.value)} />
              <input className={field} placeholder="About what?" value={followUpNote}
                onChange={(e) => setFollowUpNote(e.target.value)} />
            </div>
            <p className="mt-1 text-[11px] text-slate-500">
              One email each morning lists whatever is due, the overdue ones first.
            </p>
          </div>

          <textarea className={field + ' min-h-16 resize-y'} placeholder="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</div>}
          <button onClick={() => title.trim() ? save.mutate() : setError('Give the deal a title.')} disabled={save.isPending}
            className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-[var(--accent-ink)] hover:bg-violet-500 disabled:opacity-60">
            {save.isPending ? 'Saving...' : 'Save'}
          </button>

          {!isNew && <DealActivity dealId={deal!.id} />}
        </div>
      </div>
    </Modal>
  );
}

/**
 * What has happened on this deal, newest first.
 *
 * Stage moves are written by the app rather than typed, because the one thing
 * nobody remembers to record is when something moved, and it is the first thing
 * you want when a deal has gone quiet.
 */

function DealActivity({ dealId }: { dealId: number }) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<'note' | 'call' | 'email' | 'meeting'>('note');
  const [body, setBody] = useState('');

  const key = ['deal-activity', dealId];
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => apiGet<{ activity: Activity[] }>(`/deals/${dealId}/activity`),
  });
  const add = useMutation({
    mutationFn: () => apiPost(`/deals/${dealId}/activity`, { kind, body: body.trim() }),
    onSuccess: () => { setBody(''); qc.invalidateQueries({ queryKey: key }); },
  });

  const rows = data?.activity ?? [];
  const f = 'rounded-lg bg-slate-900/70 border border-slate-700 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-violet-500';
  const LABEL: Record<string, string> = { note: 'Note', call: 'Call', email: 'Email', meeting: 'Meeting', stage: 'Stage' };

  return (
    <div className="mt-4 border-t border-slate-800 pt-3">
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">History</div>

      <form className="mb-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (body.trim()) add.mutate(); }}>
        <select className={f} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          <option value="note">Note</option>
          <option value="call">Call</option>
          <option value="email">Email</option>
          <option value="meeting">Meeting</option>
        </select>
        <input className={f + ' flex-1'} placeholder="What happened?" value={body}
          onChange={(e) => setBody(e.target.value)} />
        <button type="submit" disabled={!body.trim() || add.isPending}
          className="rounded-lg border border-slate-700 px-3 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-40">
          Log
        </button>
      </form>

      {rows.length === 0 ? (
        <p className="text-[11px] text-slate-500">Nothing logged yet.</p>
      ) : (
        <div className="max-h-48 space-y-1.5 overflow-y-auto">
          {rows.map((a) => (
            <div key={a.id} className="flex gap-2 text-[11px]">
              <span className={`shrink-0 rounded px-1.5 py-0.5 ${
                a.kind === 'stage' ? 'bg-slate-800 text-slate-400' : 'bg-violet-600/20 text-violet-300'}`}>
                {LABEL[a.kind] ?? a.kind}
              </span>
              <span className="flex-1 text-slate-300">{a.body}</span>
              <span className="shrink-0 num text-slate-600">
                {new Date(a.occurredAt).toLocaleDateString()}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
