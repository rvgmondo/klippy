import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DndContext, useDraggable, useDroppable, PointerSensor, useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core';
import { Plus, MoreHorizontal, ArrowRightLeft, X } from 'lucide-react';
import { apiGet, apiPost, apiPatch, apiDelete } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Menu } from './Menu';
import type { BusinessSelection } from './BusinessSwitcher';

type Stage = 'lead' | 'contacted' | 'proposal' | 'won' | 'lost';
interface Deal {
  id: number; title: string; company: string | null; contactName: string | null;
  contactEmail: string | null; contactPhone: string | null; value: string;
  stage: Stage; notes: string | null; clientFolderId: number | null;
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
  const invalidate = () => { qc.invalidateQueries({ queryKey: ['deals'] }); };
  const newBusinessId = businessId === 'all' ? undefined : businessId;

  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Deal | null>(null);

  const move = useMutation({
    mutationFn: (v: { id: number; stage: Stage }) => apiPost(`/deals/${v.id}/move`, { stage: v.stage, position: 99999 }),
    onSuccess: invalidate,
  });
  const convert = useMutation({
    mutationFn: (id: number) => apiPost<{ name: string }>(`/deals/${id}/convert`),
    onSuccess: (r) => { invalidate(); qc.invalidateQueries({ queryKey: ['folders'] }); alert(`${r.name} is now a client under Delivery.`); },
    onError: (e) => alert(e instanceof Error ? e.message : 'Could not convert.'),
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
          <h2 className="text-lg font-semibold text-slate-100">Pipeline</h2>
          <p className="text-xs text-slate-500">Acquisition · turn leads into clients</p>
        </div>
        {s && (
          <div className="flex gap-4 text-xs">
            <Stat label="Open deals" value={String(s.openCount)} />
            <Stat label="Pipeline value" value={money(s.pipelineValue)} accent />
            <Stat label="Won this month" value={`${s.wonThisMonth} · ${money(s.wonValueThisMonth)}`} />
          </div>
        )}
        <button onClick={() => setAdding(true)} className="ml-auto flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-500">
          <Plus size={15} /> New deal
        </button>
      </div>

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

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className={`font-semibold ${accent ? 'text-violet-300' : 'text-slate-200'}`}>{value}</div>
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
    <div ref={setNodeRef} className={`flex max-h-full w-72 shrink-0 flex-col rounded-xl border bg-slate-900/40 ${isOver ? 'border-violet-500/60 bg-violet-500/5' : 'border-slate-800'}`}>
      <div className="flex items-center gap-2 px-3 py-2.5">
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: stage.color }} />
        <span className="text-sm font-medium text-slate-200">{stage.label}</span>
        <span className="ml-auto text-xs text-slate-500">{deals.length} · {money(total)}</span>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
        {deals.map((d) => (
          <DealCard key={d.id} deal={d} money={money} onOpen={onOpen} onConvert={onConvert} onDelete={onDelete} onGoToClients={onGoToClients} />
        ))}
      </div>
    </div>
  );
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
              : [{ label: 'Convert to client', onClick: () => { if (confirm(`Turn "${deal.company || deal.title}" into a Delivery client?`)) onConvert(deal.id); } }]),
            { label: 'Delete', danger: true, onClick: () => { if (confirm('Delete this deal?')) onDelete(deal.id); } },
          ]}
        />
      </div>
      <div className="mt-2 flex items-center justify-between text-[11px]">
        <span className="font-medium text-violet-300">{money(deal.value)}</span>
        {deal.clientFolderId && (
          <span className="inline-flex items-center gap-1 rounded bg-green-600/20 px-1.5 py-0.5 text-green-300"><ArrowRightLeft size={10} /> client</span>
        )}
      </div>
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
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        title: title.trim(), company: company.trim() || null, contactName: contactName.trim() || null,
        contactEmail: contactEmail.trim() || null, contactPhone: contactPhone.trim() || null,
        value: Number(value) || 0, notes: notes.trim() || null,
        ...(isNew && businessId ? { businessId } : {}),
      };
      return isNew ? apiPost('/deals', body) : apiPatch(`/deals/${deal!.id}`, body);
    },
    onSuccess: onSaved,
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not save.'),
  });

  const field = 'w-full rounded-lg bg-slate-900/70 border border-slate-700 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-violet-500';

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-950 p-5" onClick={(e) => e.stopPropagation()}>
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
          <textarea className={field + ' min-h-16 resize-y'} placeholder="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</div>}
          <button onClick={() => title.trim() ? save.mutate() : setError('Give the deal a title.')} disabled={save.isPending}
            className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-60">
            {save.isPending ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
