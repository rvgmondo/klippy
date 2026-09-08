import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Plus, ChevronLeft, ChevronRight,
  Camera, Copy, Check, ListChecks, CalendarDays, AlertTriangle, Link2,
} from 'lucide-react';
import { apiGet, apiPost } from '../lib/api';
import { Page, PageHeader, PageBody } from './PageHeader';
import { Skeleton, btnPrimary, btnSecondary, fieldCompactClass } from './ui';
import { ErrorNote } from './ErrorNote';
import { notify } from './ConfirmDialog';
import { SocialComposer, StatusPill } from './SocialComposer';
import { SocialAccounts } from './SocialAccounts';
import { iso, hhmm, addDays, monthGrid, weekDays, MONTHS, DOW, sameDay } from '../lib/dates';
import { NETWORK_META, type SocialPostListItem } from '../lib/socialTypes';
import { NetworkBadge } from './NetworkBadge';
import type { BusinessSelection } from './BusinessSwitcher';

/**
 * The social calendar, the queue, and what the client still owes you.
 *
 * Three tabs because there are three genuinely different questions: what is coming up,
 * what needs doing right now, and what is stuck waiting on somebody else. A single
 * list would answer none of them well.
 *
 * The calendar is the front door, and it is a MONTH by default because a social plan
 * is a month-shaped thing. Anyone who wants the detail switches to the week.
 */

type Tab = 'calendar' | 'queue' | 'asks' | 'accounts';

export function SocialView({ businessId }: { businessId: BusinessSelection }) {
  const qc = useQueryClient();
  // Coming back from a network's login lands on Accounts, because that is where the
  // picker appears. Landing on the calendar would look like nothing happened.
  const [tab, setTab] = useState<Tab>(() => {
    const q = new URLSearchParams(window.location.search);
    return q.has('connect') || q.has('connectError') ? 'accounts' : 'calendar';
  });
  const [mode, setMode] = useState<'month' | 'week'>(() => (window.innerWidth < 768 ? 'week' : 'month'));
  const [cursor, setCursor] = useState(new Date());
  const [openId, setOpenId] = useState<number | null>(null);

  const bid = businessId === 'all' ? null : Number(businessId);
  const days = mode === 'month' ? monthGrid(cursor) : weekDays(cursor);
  const from = iso(days[0]!);
  const to = iso(days[days.length - 1]!);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['social-posts', from, to, businessId],
    queryFn: () => apiGet<{ posts: SocialPostListItem[]; timezone: string }>(
      `/social/posts?from=${from}&to=${to}${bid ? `&businessId=${bid}` : ''}`),
  });

  // The queue and the asks are not bounded by the visible dates: something waiting on
  // a photo three weeks out still needs chasing today.
  const all = useQuery({
    queryKey: ['social-posts-all', businessId],
    queryFn: () => apiGet<{ posts: SocialPostListItem[] }>(
      `/social/posts?from=2000-01-01&to=2100-01-01${bid ? `&businessId=${bid}` : ''}`),
  });

  const create = useMutation({
    mutationFn: (when: Date | null) => apiPost<{ id: number }>('/social/posts', {
      businessId: bid,
      title: 'New post',
      // A new post lands on the day that was clicked, at nine, because that is what
      // clicking an empty Tuesday means.
      scheduledAt: when ? new Date(when.getFullYear(), when.getMonth(), when.getDate(), 9, 0).toISOString() : null,
      networks: [],
    }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['social-posts'] });
      qc.invalidateQueries({ queryKey: ['social-posts-all'] });
      setOpenId(r.id);
    },
    onError: (e: Error) => notify(e.message, 'error'),
  });

  const posts = data?.posts ?? [];
  const byDay = useMemo(() => {
    const m = new Map<string, SocialPostListItem[]>();
    for (const p of posts) {
      if (!p.scheduledAt) continue;
      const key = iso(new Date(p.scheduledAt));
      m.set(key, [...(m.get(key) ?? []), p]);
    }
    return m;
  }, [posts]);

  const queue = (all.data?.posts ?? []).filter((p) =>
    ['needs_manual', 'failed', 'partially_published', 'awaiting_approval'].includes(p.status)
    // A post back in draft still holding a live approval link is one the client sent
    // back with notes. Without this it would drop off every list and be waited on by
    // both sides, which is the exact failure the approval flow exists to prevent.
    || sentBack(p));
  const asks = (all.data?.posts ?? []).filter((p) => p.status === 'needs_media' && p.mediaAsk);

  if (error) return <ErrorNote error={error} onRetry={() => refetch()} />;

  return (
    <Page>
      <PageHeader
        view="social" title="Social"
        subtitle="Plan the month, get it signed off, and put it out on time."
        actions={bid ? (
          <button onClick={() => create.mutate(null)} className={btnPrimary + ' flex items-center gap-1.5'}>
            <Plus size={15} /> New post
          </button>
        ) : undefined} />
      <PageBody>
        {!bid && (
          <p className="mb-4 rounded-xl border border-dashed border-slate-700 p-4 text-center text-sm text-slate-400">
            Pick one business above to plan its posts.
          </p>
        )}

        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Tabs tab={tab} setTab={setTab} queue={queue.length} asks={asks.length} />
          <div className="flex-1" />
          {tab === 'calendar' && (
            <>
              <select value={mode} onChange={(e) => setMode(e.target.value as never)} className={fieldCompactClass}>
                <option value="month">Month</option>
                <option value="week">Week</option>
              </select>
              <button onClick={() => setCursor(addDays(cursor, mode === 'month' ? -28 : -7))}
                className="rounded-lg border border-slate-700 p-1.5 text-slate-400 hover:bg-slate-800" aria-label="Back">
                <ChevronLeft size={15} />
              </button>
              <button onClick={() => setCursor(new Date())} className={btnSecondary + ' !px-3 !py-1.5 text-xs'}>Today</button>
              <button onClick={() => setCursor(addDays(cursor, mode === 'month' ? 28 : 7))}
                className="rounded-lg border border-slate-700 p-1.5 text-slate-400 hover:bg-slate-800" aria-label="Forward">
                <ChevronRight size={15} />
              </button>
            </>
          )}
        </div>

        {tab === 'calendar' && (
          <>
            <h3 className="mb-2 text-sm font-medium text-slate-300">
              {MONTHS[cursor.getMonth()]} {cursor.getFullYear()}
            </h3>
            {isLoading ? <Skeleton className="h-96 rounded-xl" /> : (
              <div className="overflow-x-auto">
                <div className="min-w-[640px]">
                  <div className="grid grid-cols-7 gap-px">
                    {DOW.map((d) => (
                      <div key={d} className="px-2 py-1 text-[11px] uppercase tracking-wide text-slate-500">{d}</div>
                    ))}
                  </div>
                  <div className="grid grid-cols-7 gap-px rounded-xl border border-slate-800 bg-slate-800">
                    {days.map((day) => {
                      const key = iso(day);
                      const list = byDay.get(key) ?? [];
                      const otherMonth = mode === 'month' && day.getMonth() !== cursor.getMonth();
                      return (
                        <div key={key}
                          className={`min-h-24 bg-slate-950/60 p-1.5 ${otherMonth ? 'opacity-40' : ''}`}>
                          <div className="mb-1 flex items-center gap-1">
                            <span className={`num text-[11px] ${
                              sameDay(day, new Date()) ? 'rounded bg-[var(--accent)] px-1 text-[var(--accent-ink)]' : 'text-slate-500'}`}>
                              {day.getDate()}
                            </span>
                            <div className="flex-1" />
                            {bid && (
                              <button onClick={() => create.mutate(day)} title="Add a post on this day"
                                className="text-slate-600 opacity-0 transition hover:text-slate-300 focus:opacity-100 group-hover:opacity-100 [div:hover>&]:opacity-100">
                                <Plus size={12} />
                              </button>
                            )}
                          </div>
                          <div className="space-y-1">
                            {list.map((p) => <DayCard key={p.id} post={p} onOpen={() => setOpenId(p.id)} />)}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        {tab === 'queue' && (
          <QueueList posts={queue} onOpen={setOpenId} emptyLabel="Nothing waiting. Everything scheduled is on its way." />
        )}

        {tab === 'asks' && <MediaAsks posts={asks} onOpen={setOpenId} />}

        {tab === 'accounts' && <SocialAccounts businessId={bid} />}
      </PageBody>

      {/* Not gated on a business being picked. The composer looks the post up by id
          and needs nothing else, and gating it meant a row in Needs you could be
          clicked, across every business, and simply do nothing. */}
      {openId != null && (
        <SocialComposer postId={openId} onClose={() => {
          setOpenId(null);
          qc.invalidateQueries({ queryKey: ['social-posts'] });
          qc.invalidateQueries({ queryKey: ['social-posts-all'] });
        }} />
      )}
    </Page>
  );
}

function Tabs({ tab, setTab, queue, asks }: {
  tab: Tab; setTab: (t: Tab) => void; queue: number; asks: number;
}) {
  const items: { key: Tab; label: string; icon: typeof CalendarDays; count?: number }[] = [
    { key: 'calendar', label: 'Calendar', icon: CalendarDays },
    { key: 'queue', label: 'Needs you', icon: ListChecks, count: queue },
    { key: 'asks', label: 'Media asks', icon: Camera, count: asks },
    { key: 'accounts', label: 'Accounts', icon: Link2 },
  ];
  return (
    <div className="flex gap-1">
      {items.map((i) => (
        <button key={i.key} onClick={() => setTab(i.key)}
          className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs transition ${
            tab === i.key ? 'bg-slate-800 text-slate-100' : 'text-slate-400 hover:bg-slate-800/50'}`}>
          <i.icon size={14} /> {i.label}
          {!!i.count && (
            <span className="num rounded-full bg-[var(--accent)] px-1.5 text-[10px] text-[var(--accent-ink)]">{i.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/**
 * A draft still holding a live approval link is a post the client sent back with
 * notes, and "draft" is a useless thing to call that on a card somebody is scanning.
 * The queue and the calendar both read it through here so they cannot disagree.
 */
const sentBack = (p: SocialPostListItem) => p.status === 'draft' && !!p.approvalToken && !p.approvedAt;

function DayCard({ post, onOpen }: { post: SocialPostListItem; onOpen: () => void }) {
  const thumb = post.media[0]?.url;
  return (
    <button onClick={onOpen}
      className="w-full rounded-lg border border-slate-800 bg-slate-900/60 p-1.5 text-left transition hover:border-slate-700">
      <div className="flex items-center gap-1">
        {post.scheduledAt && <span className="num text-[10px] text-slate-500">{hhmm(post.scheduledAt)}</span>}
        <div className="flex gap-0.5">
          {post.targets.map((t) => <NetworkBadge key={t.id} network={t.network} />)}
        </div>
      </div>
      <div className="flex items-start gap-1.5">
        {thumb && <img src={thumb} alt="" className="mt-0.5 h-6 w-6 shrink-0 rounded object-cover" />}
        <span className="line-clamp-2 text-[11px] leading-tight text-slate-300">{post.title}</span>
      </div>
      {post.status !== 'scheduled' && post.status !== 'published' && (
        <div className="scale-90 origin-left">
          {sentBack(post)
            ? <span className="mt-1 inline-block rounded-full border border-amber-500/30 px-2 py-0.5 text-[10px] text-amber-300">changes asked for</span>
            : <StatusPill status={post.status} />}
        </div>
      )}
    </button>
  );
}

function QueueList({ posts, onOpen, emptyLabel }: {
  posts: SocialPostListItem[]; onOpen: (id: number) => void; emptyLabel: string;
}) {
  if (!posts.length) {
    return <p className="rounded-xl border border-dashed border-slate-700 p-6 text-center text-sm text-slate-400">{emptyLabel}</p>;
  }
  return (
    <div className="space-y-2">
      {posts.map((p) => {
        const failed = p.targets.filter((t) => t.error);
        return (
          <button key={p.id} onClick={() => onOpen(p.id)}
            className="flex w-full items-start gap-3 rounded-xl border border-slate-800 bg-slate-900/40 p-3 text-left hover:border-slate-700">
            {p.media[0]?.url && <img src={p.media[0].url!} alt="" className="h-12 w-12 shrink-0 rounded-lg object-cover" />}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate text-sm text-slate-200">{p.title}</span>
                {/* "draft" is technically what it is and useless as a label here.
                    What the person needs to read is that a client sent it back. */}
                {sentBack(p) ? (
                  <span className="mt-1 inline-block rounded-full border border-amber-500/30 px-2 py-0.5 text-[10px] text-amber-300">
                    changes asked for
                  </span>
                ) : (
                  <StatusPill status={p.status} />
                )}
              </div>
              {p.scheduledAt && (
                <div className="num mt-0.5 text-[11px] text-slate-500">
                  {iso(new Date(p.scheduledAt))} at {hhmm(p.scheduledAt)}
                </div>
              )}
              {failed.map((t) => (
                <p key={t.id} className="mt-1 flex items-start gap-1 text-[11px] text-red-400">
                  <AlertTriangle size={11} className="mt-0.5 shrink-0" />
                  <span>{NETWORK_META[t.network].label}: {t.error}</span>
                </p>
              ))}
            </div>
          </button>
        );
      })}
    </div>
  );
}

/**
 * What the client still owes you.
 *
 * The copy button is the point of this tab. Chasing a client for photos happens on
 * WhatsApp, not in Klippy, so the useful output is a plain-text list somebody can
 * paste into a chat in one move.
 */
function MediaAsks({ posts, onOpen }: { posts: SocialPostListItem[]; onOpen: (id: number) => void }) {
  const [copied, setCopied] = useState(false);

  const copyAll = async () => {
    const lines = posts.map((p) => {
      const when = p.scheduledAt ? iso(new Date(p.scheduledAt)) : 'no date yet';
      return `- ${p.title} (${when}): ${p.mediaAsk}`;
    });
    const text = `Hi, here is what we need from you for the next posts:\n\n${lines.join('\n')}\n\nThanks.`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch { notify('Could not copy. Select the text and copy it.', 'error'); }
  };

  if (!posts.length) {
    return (
      <p className="rounded-xl border border-dashed border-slate-700 p-6 text-center text-sm text-slate-400">
        Nothing is waiting on the client. Add an ask to a post and it appears here.
      </p>
    );
  }

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <p className="text-xs text-slate-400">
          {posts.length} post{posts.length === 1 ? '' : 's'} waiting on the client.
        </p>
        <div className="flex-1" />
        <button onClick={copyAll} className={btnSecondary + ' flex items-center gap-1.5 !px-3 !py-1.5 text-xs'}>
          {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy the list'}
        </button>
      </div>
      <div className="space-y-2">
        {posts.map((p) => (
          <button key={p.id} onClick={() => onOpen(p.id)}
            className="flex w-full items-start gap-3 rounded-xl border border-slate-800 bg-slate-900/40 p-3 text-left hover:border-slate-700">
            <Camera size={15} className="mt-0.5 shrink-0 text-amber-300/70" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="truncate text-sm text-slate-200">{p.title}</span>
                {p.scheduledAt && (
                  <span className="num text-[11px] text-slate-500">for {iso(new Date(p.scheduledAt))}</span>
                )}
              </div>
              <p className="mt-0.5 text-xs text-slate-400">{p.mediaAsk}</p>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
