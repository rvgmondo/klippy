import { useState } from 'react';
import { confirmDialog, notify } from './ConfirmDialog';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DndContext, useDraggable, useDroppable, PointerSensor, useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core';
import { Plus, MoreHorizontal, ArrowRightLeft, X } from 'lucide-react';
import { apiGet, apiPost, apiPatch, apiDelete } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Menu } from './Menu';
import { Modal } from './Modal';
import type { BusinessSelection } from './BusinessSwitcher';

type Stage = 'lead' | 'contacted' | 'proposal' | 'won' | 'lost';
interface Deal {
  id: number; title: string; company: string | null; contactName: string | null;
  contactEmail: string | null; contactPhone: string | null; value: string;
  stage: Stage; notes: string | null; clientFolderId: number | null;
  contactId?: number | null; source?: string | null;
  nextFollowUpAt?: string | null; followUpNote?: string | null;
}
interface Contact { id: number; name: string; email: string | null; company: string | null }
interface Activity {
  id: number; kind: 'note' | 'call' | 'email' | 'meeting' | 'stage';
  body: string | null; occurredAt: string;
}
interface Summary { openCount: number; pipelineValue: number; wonThisMonth: number; wonValueThisMonth: number }

const STAGES: { key: Stage; label: string; color: string }[] = [
  { key: 'lead', label: 'Lead', color: '#64748b' },
  { key: 'contacted', label: 'Contacted', color: '#3b82f6' },
  { key: 'proposal', label: 'Proposal', color: '#eab308' },
  { key: 'won', label: 'Won', color: '#22c55e' },
  { key: 'lost', label: 'Lost', color: '#ef4444' },
];

export function PipelineView({ businessId, onGoToClients }: { businessId: BusinessSelection; onGoToClients?: () => void }) {
  const qc = useQueryClient();
  const { account } = useAuth();
  const cur = account?.currency ?? 'ZAR';
  const money = (v: number | string) => {
    const n = typeof v === 'string' ? Number(v) : v;
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(n); }
    catch { return `${cur} ${n.toFixed(0)}`; }
  };
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const bizQ = businessId === 'all' ? '' : `?businessId=${businessId}`;
  const { data } = useQuery({ queryKey: ['deals', businessId], queryFn: () => apiGet<{ deals: Deal[]; summary: Summary }>(`/deals${bizQ}`) });
  const deals = data?.deals ?? [];
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['deals'] });
    // The follow-up strip is a different query over the same data. Without this a
    // date you just set, or a deal you just won, keeps showing in the strip until
    // the page is reloaded.
    qc.invalidateQueries({ queryKey: ['follow-ups'] });
  };
  const newBusinessId = businessId === 'all' ? undefined : businessId;

  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Deal | null>(null);

  const move = useMutation({
    mutationFn: (v: { id: number; stage: Stage }) => apiPost(`/deals/${v.id}/move`, { stage: v.stage, position: 99999 }),
    onSuccess: invalidate,
  });
  const convert = useMutation({
    mutationFn: (id: number) => apiPost<{ name: string }>(`/deals/${id}/convert`),
    onSuccess: (r) => { invalidate(); qc.invalidateQueries({ queryKey: ['folders'] }); notify(`${r.name} is now a client under Delivery.`); },
    onError: (e) => notify(e instanceof Error ? e.message : 'Could not convert.', 'error'),
  });
  const del = useMutation({ mutationFn: (id: number) => apiDelete(`/deals/${id}`), onSuccess: invalidate });

  function onDragEnd(e: DragEndEvent) {
    const id = Number(e.active.id);
    const over = e.over?.id?.toString() ?? '';
    if (!over.startsWith('stage-')) return;
    const stage = over.slice(6) as Stage;
    const deal = deals.find((d) => d.id === id);
    if (deal && deal.stage !== stage) move.mutate({ id, stage });
  }

  const s = data?.summary;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-800 px-4 py-3 sm:px-6">
        <div>
          <h2 className="font-display text-lg font-semibold text-slate-100">Pipeline</h2>
          <p className="text-xs text-slate-500">Acquisition. Turn leads into clients.</p>
        </div>
        {s && (
          <div className="flex gap-4 text-xs">
            <Stat label="Open deals" value={String(s.openCount)} />
            <Stat label="Pipeline value" value={money(s.pipelineValue)} accent />
            <Stat label="Won this month" value={`${s.wonThisMonth}, ${money(s.wonValueThisMonth)}`} />
          </div>
        )}
        <button onClick={() => setAdding(true)} className="ml-auto flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-medium text-[var(--accent-ink)] hover:bg-violet-500">
          <Plus size={15} /> New deal
        </button>
      </div>

      <FollowUpStrip businessId={typeof businessId === 'number' ? businessId : undefined}
        onOpen={(dealId) => {
          const d = deals.find((x) => x.id === dealId);
          if (d) setEditing(d);
        }} />

      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-4">
          {STAGES.map((st) => (
            <StageLane key={st.key} stage={st} deals={deals.filter((d) => d.stage === st.key)}
              money={money} onOpen={setEditing}
              onConvert={(id) => convert.mutate(id)} onDelete={(id) => del.mutate(id)} onGoToClients={onGoToClients} />
          ))}
        </div>
      </DndContext>

      {adding && <DealEditor businessId={newBusinessId} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); invalidate(); }} />}
      {editing && <DealEditor deal={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); invalidate(); }} />}
    </div>
  );
}

/**
 * What is due to be chased, above the board.
 *
 * The pipeline shows what exists; this shows what needs doing today, which is a
 * different question and the one that actually loses money when nobody answers it.
 * Hidden entirely when nothing is due, so it never becomes furniture people stop
 * reading.
 */
function FollowUpStrip({ businessId, onOpen }: {
  businessId?: number; onOpen: (dealId: number) => void;
}) {
  const { data } = useQuery({
    queryKey: ['follow-ups', businessId],
    queryFn: () => apiGet<{
      followUps: { id: number; title: string; company: string | null; nextFollowUpAt: string;
        followUpNote: string | null; contactName: string | null }[];
      today: string;
    }>('/deals/follow-ups'),
  });
  const rows = data?.followUps ?? [];
  if (!rows.length) return null;

  const late = (d: string) => Math.round(
    (Date.parse((data!.today) + 'T00:00:00Z') - Date.parse(d + 'T00:00:00Z')) / 86400000);

  return (
    <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3">
      <div className="mb-1.5 text-xs font-semibold text-amber-200">
        {rows.length} to follow up
      </div>
      <div className="space-y-1">
        {rows.slice(0, 6).map((f) => {
          const d = late(f.nextFollowUpAt);
          return (
            <button key={f.id} onClick={() => onOpen(f.id)}
              className="flex w-full flex-wrap items-baseline gap-x-2 rounded-lg px-1.5 py-1 text-left text-xs hover:bg-amber-500/10">
              <span className="font-medium text-amber-100">{f.title}</span>
              {f.company && <span className="text-amber-200/70">{f.company}</span>}
              <span className={d > 0 ? 'text-red-300' : 'text-amber-200/70'}>
                {d > 0 ? `${d} day${d === 1 ? '' : 's'} overdue` : 'today'}
              </span>
              {f.followUpNote && <span className="text-amber-200/60">{f.followUpNote}</span>}
            </button>
          );
        })}
        {rows.length > 6 && (
          <div className="px-1.5 pt-1 text-[11px] text-amber-200/70">and {rows.length - 6} more</div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className={`num font-semibold ${accent ? 'text-violet-300' : 'text-slate-200'}`}>{value}</div>
    </div>
  );
}

function StageLane({ stage, deals, money, onOpen, onConvert, onDelete, onGoToClients }: {
  stage: { key: Stage; label: string; color: string }; deals: Deal[]; money: (v: number | string) => string;
  onOpen: (d: Deal) => void; onConvert: (id: number) => void; onDelete: (id: number) => void; onGoToClients?: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `stage-${stage.key}` });
  const total = deals.reduce((s, d) => s + Number(d.value), 0);
  return (
    <div ref={setNodeRef} className={`flex max-h-full w-72 shrink-0 flex-col rounded-2xl border bg-slate-900 ${isOver ? 'border-[var(--accent)]/60 bg-[var(--accent-quiet)]' : 'border-slate-800'}`}>
      <div className="flex items-center gap-2 px-3 py-2.5">
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: stage.color }} />
        <span className="font-display text-sm font-semibold text-slate-200">{stage.label}</span>
        <span className="num ml-auto text-xs text-slate-500">{deals.length}, {money(total)}</span>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
        {deals.map((d) => (
          <DealCard key={d.id} deal={d} money={money} onOpen={onOpen} onConvert={onConvert} onDelete={onDelete} onGoToClients={onGoToClients} />
        ))}
      </div>
    </div>
  );
}

/** How late a follow-up is, in plain words. Null when there is nothing to chase. */
function followUpState(deal: Deal, today: string): { label: string; overdue: boolean } | null {
  if (!deal.nextFollowUpAt) return null;
  if (deal.stage === 'won' || deal.stage === 'lost') return null;
  const days = Math.round(
    (Date.parse(today + 'T00:00:00Z') - Date.parse(deal.nextFollowUpAt + 'T00:00:00Z')) / 86400000);
  if (days > 0) return { label: `${days}d overdue`, overdue: true };
  if (days === 0) return { label: 'follow up today', overdue: true };
  return { label: `follow up ${deal.nextFollowUpAt}`, overdue: false };
}

function DealCard({ deal, money, onOpen, onConvert, onDelete, onGoToClients }: {
  deal: Deal; money: (v: number | string) => string; onOpen: (d: Deal) => void;
  onConvert: (id: number) => void; onDelete: (id: number) => void; onGoToClients?: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: deal.id });
  const style = transform ? { transform: `translate(${transform.x}px, ${transform.y}px)` } : undefined;
  return (
    <div ref={setNodeRef} style={style} {...listeners} {...attributes}
      onClick={() => { if (!isDragging) onOpen(deal); }}
      className={`cursor-grab rounded-lg border border-slate-700/70 bg-slate-800/80 p-2.5 shadow-sm active:cursor-grabbing ${isDragging ? 'opacity-50' : ''}`}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-slate-100">{deal.title}</p>
          {deal.company && <p className="truncate text-xs text-slate-400">{deal.company}</p>}
        </div>
        <Menu align="right"
          trigger={<span className="text-slate-500 hover:text-slate-200"><MoreHorizontal size={15} /></span>}
          items={[
            ...(deal.clientFolderId
              ? [{ label: 'Open client (Delivery)', onClick: () => onGoToClients?.() }]
              : [{ label: 'Convert to client', onClick: async () => { if (await confirmDialog(`Turn "${deal.company || deal.title}" into a Delivery client?`)) onConvert(deal.id); } }]),
            { label: 'Delete', danger: true, onClick: async () => { if (await confirmDialog('Delete this deal?', { danger: true })) onDelete(deal.id); } },
          ]}
        />
      </div>
      <div className="mt-2 flex items-center justify-between text-[11px]">
        <span className="num font-medium text-violet-300">{money(deal.value)}</span>
        {deal.clientFolderId && (
          <span className="inline-flex items-center gap-1 rounded bg-green-600/20 px-1.5 py-0.5 text-green-300"><ArrowRightLeft size={10} /> client</span>
        )}
      </div>

      {/* An overdue chase should be visible on the board, not only after opening
          the deal. That is the whole point of writing the date down. */}
      {(() => {
        const f = followUpState(deal, new Date().toISOString().slice(0, 10));
        if (!f) return null;
        return (
          <div className={`mt-1.5 rounded px-1.5 py-0.5 text-[10px] ${
            f.overdue ? 'bg-red-600/20 text-red-300' : 'bg-slate-700/60 text-slate-400'}`}>
            {f.label}
          </div>
        );
      })()}
    </div>
  );
}

function DealEditor({ deal, businessId, onClose, onSaved }: { deal?: Deal; businessId?: number; onClose: () => void; onSaved: () => void }) {
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

  const field = 'w-full rounded-lg bg-slate-900/70 border border-slate-700 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-violet-500';

  return (
    <Modal onClose={onClose} variant="panel">
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
