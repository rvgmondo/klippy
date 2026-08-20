import { useState } from 'react';
import { confirmDialog, notify, promptDialog } from './ConfirmDialog';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DndContext, useDraggable, useDroppable, PointerSensor, useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core';
import { Plus, MoreHorizontal, ArrowRightLeft } from 'lucide-react';
import { apiGet, apiPost, apiDelete } from '../lib/api';
import { Menu } from './Menu';
import type { Stage, Deal, Summary } from './pipelineShared';
import { DealEditor } from './DealEditor';
import {} from './Modal';
import type { BusinessSelection } from './BusinessSwitcher';
import { moneyRound } from '../lib/money';
import { useUrlAction } from '../lib/urlAction';
import { useCurrency } from '../lib/useCurrency';


const STAGES: { key: Stage; label: string; color: string }[] = [
  { key: 'lead', label: 'Lead', color: '#64748b' },
  { key: 'contacted', label: 'Contacted', color: '#3b82f6' },
  { key: 'proposal', label: 'Proposal', color: '#eab308' },
  { key: 'won', label: 'Won', color: '#22c55e' },
  { key: 'lost', label: 'Lost', color: '#ef4444' },
];

export function PipelineView({ businessId, onOpenClient }: { businessId: BusinessSelection; onOpenClient?: (folderId: number) => void }) {
  const qc = useQueryClient();
  // Deal values read in the currency the selected business bills in.
  const cur = useCurrency(businessId);
  const money = (v: number | string) => moneyRound(v, cur);
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
  useUrlAction('new', (v) => { if (v === 'deal') setAdding(true); });
  const [editing, setEditing] = useState<Deal | null>(null);

  const move = useMutation({
    mutationFn: (v: { id: number; stage: Stage; lostReason?: string | null }) =>
      apiPost(`/deals/${v.id}/move`, { stage: v.stage, position: 99999, lostReason: v.lostReason ?? null }),
    onSuccess: invalidate,
  });
  const convert = useMutation({
    mutationFn: (id: number) => apiPost<{ name: string; folderId: number | null }>(`/deals/${id}/convert`),
    onSuccess: (r) => {
      invalidate(); qc.invalidateQueries({ queryKey: ['folders'] });
      notify(`${r.name} is now a client under Delivery.`);
      // Land on the client that was just created, not on a blank Boards screen.
      if (r.folderId) onOpenClient?.(r.folderId);
    },
    onError: (e) => notify(e instanceof Error ? e.message : 'Could not convert.', 'error'),
  });
  const del = useMutation({ mutationFn: (id: number) => apiDelete(`/deals/${id}`), onSuccess: invalidate });

  async function onDragEnd(e: DragEndEvent) {
    const id = Number(e.active.id);
    const over = e.over?.id?.toString() ?? '';
    if (!over.startsWith('stage-')) return;
    const stage = over.slice(6) as Stage;
    const deal = deals.find((d) => d.id === id);
    if (!deal || deal.stage === stage) return;
    // Capture WHY the moment a deal is lost, while the reason is fresh. Blank is
    // allowed; "why we lose" is unlearnable without at least the chance to record it.
    if (stage === 'lost') {
      const reason = await promptDialog('Why was this deal lost? (optional)', '', { confirmLabel: 'Mark lost' });
      if (reason === null) return; // cancelled the drop
      move.mutate({ id, stage, lostReason: reason.trim() || null });
      return;
    }
    move.mutate({ id, stage });
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
            {s.winRate != null && <Stat label="Win rate" value={`${s.winRate}%`} accent />}
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
              onConvert={(id) => convert.mutate(id)} onDelete={(id) => del.mutate(id)} onOpenClient={onOpenClient} />
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

function StageLane({ stage, deals, money, onOpen, onConvert, onDelete, onOpenClient }: {
  stage: { key: Stage; label: string; color: string }; deals: Deal[]; money: (v: number | string) => string;
  onOpen: (d: Deal) => void; onConvert: (id: number) => void; onDelete: (id: number) => void; onOpenClient?: (folderId: number) => void;
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
          <DealCard key={d.id} deal={d} money={money} onOpen={onOpen} onConvert={onConvert} onDelete={onDelete} onOpenClient={onOpenClient} />
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

function DealCard({ deal, money, onOpen, onConvert, onDelete, onOpenClient }: {
  deal: Deal; money: (v: number | string) => string; onOpen: (d: Deal) => void;
  onConvert: (id: number) => void; onDelete: (id: number) => void; onOpenClient?: (folderId: number) => void;
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
              ? [{ label: 'Open client (Delivery)', onClick: () => onOpenClient?.(deal.clientFolderId!) }]
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

