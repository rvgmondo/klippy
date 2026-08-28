import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Clock, Plus, ArrowUp, ArrowDown, Check, X } from 'lucide-react';
import { apiGet, apiPost, apiPatch } from '../lib/api';
import { fieldInlineClass, btnPrimary, Skeleton } from './ui';
import { ErrorNote } from './ErrorNote';

/**
 * Home as one Eisenhower matrix across every business.
 *
 * Ruben plans on paper: a cross drawn on a page, everything from all of his
 * businesses written into four quadrants. This is that, with the half a machine can
 * do already done. Urgency is never asked for, it is computed from dates Klippy
 * holds anyway, so the page is never blank and never needs sorting before it is
 * useful. The only thing asked of a person is the judgement a machine cannot make.
 *
 * The design carries an argument, so it is worth writing down before someone
 * "tidies" it:
 *
 *  - DO TODAY IS SMALL AND RED. Fires are a cost, not an achievement. Every matrix
 *    ever drawn fills this box because calling your work urgent feels good, and the
 *    layout should make that feel expensive rather than productive.
 *  - THE REAL WORK IS THE BIG CALM ONE. Important and not urgent is the only
 *    quadrant that compounds, and the only one nothing external will ever remind you
 *    about. When it is empty the page says so loudly, because an empty top right is
 *    the single most useful thing this screen can tell him.
 *  - THERE IS NO DELEGATE BOX. Classic Eisenhower says delegate; a sole founder has
 *    nobody to delegate to, so that quadrant is "fast or automate" instead, and
 *    Klippy already empties parts of it by itself.
 */

type Kind = 'manual' | 'task' | 'invoice' | 'quote' | 'deal';

interface FocusItem {
  key: string; kind: Kind; refId: number | null;
  title: string; detail: string | null;
  businessId: number | null;
  urgent: boolean; important: boolean;
  due: string | null; overdueBy: number | null;
  view: string;
}
interface FocusData {
  today: string;
  businesses: { id: number; name: string; color: string | null }[];
  quadrants: Record<'now' | 'real' | 'quick' | 'later', FocusItem[]>;
  counts: Record<'now' | 'real' | 'quick' | 'later', number>;
}

type QuadKey = 'now' | 'real' | 'quick' | 'later';

const QUADRANTS: {
  key: QuadKey; title: string; hint: string;
  tone: 'fire' | 'calm' | 'plain';
}[] = [
  { key: 'now', title: 'Do today', hint: 'Urgent and important', tone: 'fire' },
  { key: 'real', title: 'The real work', hint: 'Important, no deadline', tone: 'calm' },
  { key: 'quick', title: 'Fast or automate', hint: 'Urgent, not important', tone: 'plain' },
  { key: 'later', title: 'Let it go', hint: 'Neither', tone: 'plain' },
];

const KIND_LABEL: Record<Kind, string> = {
  manual: '', task: 'Card', invoice: 'Invoice', quote: 'Quote', deal: 'Deal',
};

/** A stable colour per business, so the same company reads the same everywhere. */
const FALLBACK_COLORS = ['#7F77DD', '#1D9E75', '#D85A30', '#378ADD', '#D4537E', '#BA7517'];

export function FocusMatrix({ onNavigate }: { onNavigate?: (view: string) => void }) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState<QuadKey | null>(null);
  const [draft, setDraft] = useState('');
  const [draftBiz, setDraftBiz] = useState<number | ''>('');

  const { data, isLoading, error } = useQuery({
    queryKey: ['focus'],
    queryFn: () => apiGet<FocusData>('/focus'),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ['focus'] });

  const judge = useMutation({
    mutationFn: (v: { item: FocusItem; important: boolean }) =>
      v.item.kind === 'manual'
        ? apiPatch(`/focus/${v.item.refId}`, { important: v.important })
        : apiPatch('/focus/judge', {
          kind: v.item.kind, refId: v.item.refId, important: v.important,
          businessId: v.item.businessId ?? undefined,
        }),
    onSuccess: refresh,
  });
  const add = useMutation({
    mutationFn: (v: { title: string; important: boolean; businessId: number | null }) =>
      apiPost('/focus', v),
    onSuccess: () => { setDraft(''); setAdding(null); refresh(); },
  });
  const done = useMutation({
    mutationFn: (id: number) => apiPost(`/focus/${id}/done`),
    onSuccess: refresh,
  });

  const colorOf = (bid: number | null) => {
    if (bid == null || !data) return '#888780';
    const i = data.businesses.findIndex((b) => b.id === bid);
    const b = data.businesses[i];
    return b?.color || FALLBACK_COLORS[Math.max(0, i) % FALLBACK_COLORS.length]!;
  };
  const nameOf = (bid: number | null) =>
    data?.businesses.find((b) => b.id === bid)?.name ?? null;

  if (error) return <ErrorNote error={error} />;

  if (isLoading || !data) {
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-44 rounded-2xl" />)}
      </div>
    );
  }

  const startAdd = (q: QuadKey) => {
    setAdding(q);
    setDraft('');
    setDraftBiz(data.businesses.length === 1 ? data.businesses[0]!.id : '');
  };

  const submitAdd = (q: QuadKey) => {
    const title = draft.trim();
    if (!title) return;
    add.mutate({
      title,
      // Adding into a quadrant means what it says: the left column is the important
      // half of the cross.
      important: q === 'now' || q === 'real',
      businessId: draftBiz === '' ? null : Number(draftBiz),
    });
  };

  const renderItem = (item: FocusItem) => {
    const overdue = (item.overdueBy ?? 0) > 0;
    const canOpen = item.kind !== 'manual' && onNavigate;
    return (
      <li key={item.key}
        className="tap group flex items-start gap-2 rounded-lg border border-slate-800 bg-slate-900/70 px-2.5 py-2">
        <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
          style={{ background: colorOf(item.businessId) }}
          title={nameOf(item.businessId) ?? 'No business'} />
        <button
          type="button"
          onClick={canOpen ? () => onNavigate!(item.view) : undefined}
          className={`min-w-0 flex-1 text-left ${canOpen ? 'hover:text-[var(--accent)]' : 'cursor-default'}`}>
          <span className="block truncate text-[13px] text-slate-100">{item.title}</span>
          {(item.detail || KIND_LABEL[item.kind]) && (
            <span className="mt-0.5 block truncate text-[11px] text-slate-500">
              {[KIND_LABEL[item.kind], item.detail].filter(Boolean).join(' - ')}
            </span>
          )}
        </button>
        {overdue && (
          <span className="mt-0.5 flex shrink-0 items-center gap-1 text-[11px] text-red-300">
            <Clock size={11} aria-hidden="true" />{item.overdueBy}d
          </span>
        )}
        <div className="flex shrink-0 items-center gap-0.5 opacity-100 lg:opacity-0 lg:group-hover:opacity-100 lg:group-focus-within:opacity-100">
          {item.kind === 'manual' && (
            <button type="button" onClick={() => done.mutate(item.refId!)}
              title="Done" aria-label={`Mark "${item.title}" done`}
              className="tap rounded p-1 text-slate-500 hover:text-[var(--accent)]">
              <Check size={13} />
            </button>
          )}
          <button
            type="button"
            onClick={() => judge.mutate({ item, important: !item.important })}
            title={item.important ? 'Move down: not important' : 'Move up: important'}
            aria-label={item.important
              ? `Move "${item.title}" to not important`
              : `Move "${item.title}" to important`}
            className="tap rounded p-1 text-slate-500 hover:text-slate-200">
            {item.important ? <ArrowDown size={13} /> : <ArrowUp size={13} />}
          </button>
        </div>
      </li>
    );
  };

  const quadStyle = (tone: 'fire' | 'calm' | 'plain') =>
    tone === 'fire'
      ? 'border-red-500/25 bg-red-500/[0.06]'
      : tone === 'calm'
        ? 'border-[var(--accent)]/30 bg-[var(--accent-quiet)]'
        : 'border-slate-800 bg-slate-900/40';
  const titleStyle = (tone: 'fire' | 'calm' | 'plain') =>
    tone === 'fire' ? 'text-red-300' : tone === 'calm' ? 'text-[var(--accent)]' : 'text-slate-300';

  const renderQuad = (q: typeof QUADRANTS[number]) => {
    const items = data.quadrants[q.key] ?? [];
    return (
      <section key={q.key} className={`rounded-2xl border p-3 sm:p-4 ${quadStyle(q.tone)}`}>
        <div className="mb-2.5 flex items-baseline justify-between gap-2">
          <div className="min-w-0">
            <h3 className={`text-sm font-semibold ${titleStyle(q.tone)}`}>{q.title}</h3>
            <p className="truncate text-[11px] text-slate-500">{q.hint}</p>
          </div>
          <span className="shrink-0 text-[11px] text-slate-500">
            {q.key === 'real' && items.length > 0 ? 'protect this' : items.length || ''}
          </span>
        </div>

        {items.length > 0 ? (
          <ul className="space-y-1.5">{items.map(renderItem)}</ul>
        ) : (
          <p className="py-1 text-[12px] text-slate-500">
            {q.key === 'now' ? 'Nothing on fire. Good.'
              : q.key === 'real' ? 'Empty. This is the work that grows the business, and nothing will remind you about it.'
                : q.key === 'quick' ? 'Nothing here.'
                  : 'Nothing here.'}
          </p>
        )}

        {adding === q.key ? (
          <form
            onSubmit={(e) => { e.preventDefault(); submitAdd(q.key); }}
            className="mt-2 space-y-1.5">
            <input
              autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
              placeholder="What actually matters?" className={fieldInlineClass + ' w-full'}
              aria-label={`Add to ${q.title}`} />
            <div className="flex items-center gap-1.5">
              {data.businesses.length > 1 && (
                <select value={draftBiz} onChange={(e) => setDraftBiz(e.target.value === '' ? '' : Number(e.target.value))}
                  className={fieldInlineClass} aria-label="Business">
                  <option value="">No business</option>
                  {data.businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              )}
              <button type="submit" disabled={!draft.trim() || add.isPending}
                className={btnPrimary + ' px-3 py-1.5 text-xs'}>Add</button>
              <button type="button" onClick={() => setAdding(null)}
                className="tap rounded p-1.5 text-slate-500 hover:text-slate-200" aria-label="Cancel">
                <X size={14} />
              </button>
            </div>
          </form>
        ) : (
          <button type="button" onClick={() => startAdd(q.key)}
            className="tap mt-2 flex items-center gap-1 text-[11px] text-slate-500 hover:text-slate-300">
            <Plus size={12} /> Add
          </button>
        )}
      </section>
    );
  };

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-200">One page, every business</h2>
        {data.businesses.length > 1 && (
          <div className="flex flex-wrap items-center gap-2.5">
            {data.businesses.map((b) => (
              <span key={b.id} className="flex items-center gap-1.5 text-[11px] text-slate-400">
                <span className="h-2 w-2 rounded-full" style={{ background: colorOf(b.id) }} />
                {b.name}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* One grid, not two.
          The rails and the column headings are the only things that need a wide
          screen; hiding them takes them out of the layout entirely, so on a phone
          the four quadrants simply flow down the single column in the order they are
          written: fires, real work, quick, bin. Rendering the quadrants twice (once
          per breakpoint) would duplicate every add-form and every button in the DOM. */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[auto_1fr_1fr] lg:gap-2">
        <div className="hidden lg:block" />
        <div className="hidden pb-1 text-center text-[11px] uppercase tracking-wide text-slate-500 lg:block">Urgent</div>
        <div className="hidden pb-1 text-center text-[11px] uppercase tracking-wide text-slate-500 lg:block">Not urgent</div>

        <div className="hidden items-center justify-center pr-1 lg:flex">
          <span className="rotate-180 text-[11px] uppercase tracking-wide text-slate-500"
            style={{ writingMode: 'vertical-rl' }}>Important</span>
        </div>
        {renderQuad(QUADRANTS[0]!)}
        {renderQuad(QUADRANTS[1]!)}

        <div className="hidden items-center justify-center pr-1 lg:flex">
          <span className="rotate-180 text-[11px] uppercase tracking-wide text-slate-500"
            style={{ writingMode: 'vertical-rl' }}>Not important</span>
        </div>
        {renderQuad(QUADRANTS[2]!)}
        {renderQuad(QUADRANTS[3]!)}
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
        The urgent side fills itself from your due dates, overdue invoices and expiring
        quotes. You only move things up or down for importance.
      </p>
    </div>
  );
}
