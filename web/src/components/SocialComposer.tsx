import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Upload, X, Trash2, Send, Save, Copy, Check, AlertTriangle, Link2, ExternalLink } from 'lucide-react';
import { apiGet, apiPost, apiPatch, apiDelete } from '../lib/api';
import { Modal } from './Modal';
import { fieldClass, btnPrimary, btnSecondary } from './ui';
import { notify, confirmDialog } from './ConfirmDialog';
import { iso, hhmm, localIsoWithOffset } from '../lib/dates';
import type { SocialNetwork, SocialPostDetail, SocialIssue, SocialAccountsResponse, SocialTarget } from '../lib/socialTypes';
import { NETWORK_META, ALL_NETWORKS } from '../lib/socialTypes';
import { NetworkBadge } from './NetworkBadge';

/**
 * Writing one post.
 *
 * The whole design goal is that a problem shows up HERE, next to the field that
 * causes it, rather than at nine on a Monday inside a cron job where all anyone sees
 * is that the client's post did not go out. So the server is asked to check the post
 * as the person types, and every issue is shown against its own field with the
 * network that complained.
 *
 * Counts are per network for the same reason: 2200 characters is fine for LinkedIn
 * and over the line for Instagram, and one shared number would have to be wrong for
 * one of them.
 */

export function SocialComposer({ postId, onClose }: {
  postId: number;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<{
    title: string; caption: string; firstComment: string;
    postType: 'post' | 'carousel' | 'reel' | 'story';
    deliveryMode: 'auto' | 'manual';
    mediaAsk: string; date: string; time: string;
    networks: SocialNetwork[];
  } | null>(null);
  /**
   * Edits are counted, and a save records the count it carried.
   *
   * A single "dirty" flag lost edits. A save still travelling came back, cleared the flag,
   * and that cancelled the timer for an edit made in the meantime: the drawer showed the
   * new date while the server kept the old one. Now a save marks as saved only what it
   * actually sent, and anything newer still goes.
   */
  const [edits, setEdits] = useState(0);
  const [savedEdits, setSavedEdits] = useState(0);
  const dirty = edits !== savedEdits;
  /**
   * Whether the date or time has been touched since the post was opened.
   *
   * The autosave never sent the time, so moving a post to Thursday saved nothing, and the
   * drawer showed Thursday while the post stayed on Tuesday. It is sent only once touched,
   * because the fields default to today at 09:00 for a post with no date, and sending that
   * on every keystroke would quietly give an undated draft a date.
   */
  const [whenTouched, setWhenTouched] = useState(false);
  const [copied, setCopied] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['social-post', postId],
    queryFn: () => apiGet<SocialPostDetail>(`/social/posts/${postId}`),
    retry: false,
  });
  // A post that cannot be loaded (deleted, another workspace's, or a link from an old
  // email) used to leave the drawer on "Loading" forever.
  useEffect(() => {
    // Only when it never loaded. A background refetch failing on a post already open must
    // not close the drawer on somebody mid-sentence.
    if (!error || data) return;
    notify(`Could not open that post. ${error instanceof Error ? error.message : ''}`.trim(), 'error');
    onClose();
  }, [error, data]);

  // To show which account each network will actually post to.
  const accounts = useQuery({
    queryKey: ['social-accounts'],
    queryFn: () => apiGet<SocialAccountsResponse>('/social/accounts'),
  });

  useEffect(() => {
    if (!data || draft) return;
    const when = data.post.scheduledAt ? new Date(data.post.scheduledAt) : null;
    setDraft({
      title: data.post.title,
      caption: data.post.caption ?? '',
      firstComment: data.post.firstComment ?? '',
      postType: data.post.postType,
      deliveryMode: data.post.deliveryMode,
      mediaAsk: data.post.mediaAsk ?? '',
      date: when ? iso(when) : iso(new Date()),
      time: when ? hhmm(when) : '09:00',
      networks: data.targets.map((t) => t.network),
    });
  }, [data, draft]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['social-post', postId] });
    qc.invalidateQueries({ queryKey: ['social-posts'] });
  };

  /**
   * Say so when a change has just withdrawn the client's link, or taken the post off
   * the schedule.
   *
   * Both happen on an autosave 700ms after somebody fixes a typo. Without a word here the
   * only sign is a status pill quietly changing, the client is left holding a link that no
   * longer opens, and a post that was going out on Tuesday simply does not.
   */
  const sayWhatChanged = (r: unknown) => {
    const x = (r ?? {}) as { approvalWithdrawn?: boolean; unscheduled?: boolean };
    if (x.approvalWithdrawn && x.unscheduled) {
      notify('That changed what the client approved, so the sign-off and the link were withdrawn and the post came off the schedule. Send it round again, then schedule it.', 'ok');
    } else if (x.approvalWithdrawn) {
      notify('That changed what the client approved, so the sign-off and the link were withdrawn. Send it round again.', 'ok');
    } else if (x.unscheduled) {
      notify('That changed what goes out, so the post came off the schedule. Press Schedule when it is ready.', 'ok');
    }
  };

  /**
   * The time the fields describe, or null while they do not describe one yet.
   *
   * A browser reports a date with one part deleted as empty, and a year being typed as
   * 0002. Sent as they are, the first cleared the post's date and the second dated it two
   * thousand years ago.
   */
  const whenOf = (d: NonNullable<typeof draft>): string | null => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date) || !/^\d{2}:\d{2}/.test(d.time)) return null;
    if (Number(d.date.slice(0, 4)) < 2000) return null;
    return localIsoWithOffset(d.date, d.time);
  };
  /**
   * A scheduled post given a time that has already passed.
   *
   * The publisher takes anything scheduled at or before now. Changing the date before the
   * time passes through such moments (tomorrow at eight, moved to tonight at eight, is
   * briefly this morning at eight), so that time is not sent, the post keeps its old one,
   * and the drawer says why. The server refuses it too.
   */
  const passedWhileScheduled = (d: NonNullable<typeof draft>) => {
    const when = whenOf(d);
    return data?.post.status === 'scheduled' && when !== null && new Date(when).getTime() <= Date.now();
  };
  const bodyOf = (d: NonNullable<typeof draft>, withWhen: boolean): Record<string, unknown> => {
    const when = withWhen && !passedWhileScheduled(d) ? whenOf(d) : null;
    return {
      title: d.title, caption: d.caption, firstComment: d.firstComment || null,
      postType: d.postType, deliveryMode: d.deliveryMode,
      mediaAsk: d.mediaAsk || null, networks: d.networks,
      ...(when ? { scheduledAt: when } : {}),
    };
  };

  // One place reacts to a finished save. The autosave used to add a second handler, so
  // every notice showed twice.
  const save = useMutation({
    mutationFn: (v: { body: Record<string, unknown>; seq: number }) => apiPatch(`/social/posts/${postId}`, v.body),
    onSuccess: (r, v) => {
      setSavedEdits((s) => Math.max(s, v.seq));
      invalidate();
      check.mutate();
      sayWhatChanged(r);
    },
    onError: (e: Error) => notify(e.message, 'error'),
  });

  const check = useMutation({
    mutationFn: () => apiPost<{ ok: boolean; issues: SocialIssue[] }>(`/social/posts/${postId}/check`),
  });

  const schedule = useMutation({
    mutationFn: () => apiPost<{ ok: boolean; warnings?: SocialIssue[] }>(
      `/social/posts/${postId}/schedule`,
      { scheduledAt: localIsoWithOffset(draft!.date, draft!.time) },
    ),
    onSuccess: (r) => {
      invalidate();
      notify(r.warnings?.length
        ? `Scheduled, with ${r.warnings.length} thing${r.warnings.length === 1 ? '' : 's'} worth a look.`
        : 'Scheduled.', 'ok');
    },
    onError: (e: Error) => notify(e.message, 'error'),
  });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      // Dimensions are read in the browser, because the server has no image library
      // and Instagram refuses anything outside 0.80 to 1.91. Knowing the size here
      // means the composer can say so before the post is ever scheduled.
      const dims = await readDimensions(file).catch(() => null);
      const q = new URLSearchParams();
      if (dims?.width) q.set('width', String(dims.width));
      if (dims?.height) q.set('height', String(dims.height));
      if (dims?.durationMs) q.set('durationMs', String(Math.round(dims.durationMs)));
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(`/api/v1/social/posts/${postId}/media?${q}`, {
        method: 'POST', body: form, credentials: 'same-origin',
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Upload failed.');
      return res.json();
    },
    onSuccess: (r) => { invalidate(); check.mutate(); sayWhatChanged(r); },
    onError: (e: Error) => notify(e.message, 'error'),
  });

  const removeMedia = useMutation({
    mutationFn: (mediaId: number) => apiDelete(`/social/posts/${postId}/media/${mediaId}`),
    onSuccess: (r) => { invalidate(); check.mutate(); sayWhatChanged(r); },
    onError: (e: Error) => notify(e.message, 'error'),
  });

  // Re-check shortly after typing stops, so issues track what is actually written
  // without a request per keystroke.
  useEffect(() => {
    if (!dirty || !draft) return;
    const t = setTimeout(() => {
      save.mutate({ body: bodyOf(draft, whenTouched), seq: edits });
    }, 700);
    return () => clearTimeout(t);
  }, [dirty, edits, draft, whenTouched]);

  const issues = check.data?.issues ?? [];
  const forField = (field: SocialIssue['field']) => issues.filter((i) => i.field === field);

  const post = data?.post;
  const media = data?.media ?? [];
  const set = <K extends keyof NonNullable<typeof draft>>(k: K, v: NonNullable<typeof draft>[K]) => {
    setDraft((d) => (d ? { ...d, [k]: v } : d));
    setEdits((n) => n + 1);
  };

  const copyCaption = async () => {
    if (!draft) return;
    const text = draft.firstComment ? `${draft.caption}\n\n---\n${draft.firstComment}` : draft.caption;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { notify('Could not copy. Select the text and copy it.', 'error'); }
  };

  return (
    <Modal onClose={onClose} variant="drawer">
      {isLoading || !draft || !post ? (
        <div className="p-6 text-sm text-slate-400">Loading...</div>
      ) : (
        <div className="flex h-full flex-col">
          <div className="flex items-start gap-3 border-b border-slate-800 p-4">
            <div className="min-w-0 flex-1">
              <input
                value={draft.title}
                onChange={(e) => set('title', e.target.value)}
                className="w-full bg-transparent text-base font-semibold text-slate-100 outline-none"
                placeholder="What is this post" />
              <StatusPill status={post.status} />
            </div>
            <button onClick={onClose} className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-300">
              <X size={16} />
            </button>
          </div>

          <div className="flex-1 space-y-4 overflow-y-auto p-4">
            {/* ---- where it goes -------------------------------------------- */}
            <div>
              <label className="mb-1.5 block text-[11px] uppercase tracking-wide text-slate-500">Post it to</label>
              <div className="flex flex-wrap gap-2">
                {ALL_NETWORKS.map((n) => {
                  const on = draft.networks.includes(n);
                  return (
                    <button key={n}
                      onClick={() => set('networks', on ? draft.networks.filter((x) => x !== n) : [...draft.networks, n])}
                      className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs transition ${
                        on ? 'border-[var(--accent)] bg-[var(--accent-quiet)] text-slate-100'
                           : 'border-slate-700 text-slate-400 hover:bg-slate-800'}`}>
                      <NetworkBadge network={n} /> {NETWORK_META[n].label}
                    </button>
                  );
                })}
              </div>
              <WhereItGoes networks={draft.networks} targets={data.targets} businessId={post.businessId}
                accounts={accounts.data?.accounts ?? []} />
              <FieldIssues issues={forField('account')} />
            </div>

            {/* ---- the words ------------------------------------------------ */}
            <div>
              <div className="mb-1.5 flex items-center gap-2">
                <label className="text-[11px] uppercase tracking-wide text-slate-500">Caption</label>
                <div className="flex-1" />
                {/* One count per network, because their limits differ and a single
                    shared number would have to be wrong for one of them. */}
                {draft.networks.map((n) => {
                  const max = NETWORK_META[n].captionMax;
                  const over = draft.caption.length > max;
                  return (
                    <span key={n} className={`num text-[11px] ${over ? 'text-red-400' : 'text-slate-500'}`}>
                      {NETWORK_META[n].short} {draft.caption.length}/{max}
                    </span>
                  );
                })}
              </div>
              <textarea
                value={draft.caption} rows={7}
                onChange={(e) => set('caption', e.target.value)}
                className={fieldClass + ' resize-y font-normal'}
                placeholder="What are you saying" />
              <FieldIssues issues={forField('caption')} />
            </div>

            <div>
              <label className="mb-1.5 block text-[11px] uppercase tracking-wide text-slate-500">
                First comment, optional
              </label>
              <textarea
                value={draft.firstComment} rows={2}
                onChange={(e) => set('firstComment', e.target.value)}
                className={fieldClass + ' resize-y'}
                placeholder="Hashtags, or a link, kept out of the caption" />
              <FieldIssues issues={forField('firstComment')} />
            </div>

            {/* ---- media ---------------------------------------------------- */}
            <div>
              <div className="mb-1.5 flex items-center gap-2">
                <label className="text-[11px] uppercase tracking-wide text-slate-500">Photos and video</label>
                <div className="flex-1" />
                <button onClick={() => fileRef.current?.click()} disabled={upload.isPending}
                  className={btnSecondary + ' flex items-center gap-1.5 !px-2 !py-1 text-xs'}>
                  <Upload size={13} /> {upload.isPending ? 'Uploading...' : 'Add'}
                </button>
                <input ref={fileRef} type="file" hidden
                  accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); e.target.value = ''; }} />
              </div>
              {media.length === 0 ? (
                <p className="rounded-lg border border-dashed border-slate-700 p-3 text-center text-xs text-slate-500">
                  Instagram needs at least one photo. The others can post words alone.
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {media.map((m) => (
                    <div key={m.id} className="group relative">
                      {m.mimeType?.startsWith('video/') ? (
                        <video src={m.publicUrl ?? undefined} className="h-20 w-20 rounded-lg object-cover" muted />
                      ) : (
                        <img src={m.publicUrl ?? undefined} alt={m.altText ?? ''} className="h-20 w-20 rounded-lg object-cover" />
                      )}
                      <button onClick={() => removeMedia.mutate(m.id)}
                        title="Remove from this post. The file itself is kept."
                        className="absolute -right-1 -top-1 rounded-full bg-slate-900 p-1 text-slate-400 opacity-0 transition group-hover:opacity-100 hover:text-red-400">
                        <Trash2 size={11} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <FieldIssues issues={forField('media')} />
            </div>

            {/* ---- when, and how ------------------------------------------- */}
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1.5 block text-[11px] uppercase tracking-wide text-slate-500">Date</label>
                <input type="date" value={draft.date} onChange={(e) => { setWhenTouched(true); set('date', e.target.value); }} className={fieldClass} />
              </div>
              <div>
                <label className="mb-1.5 block text-[11px] uppercase tracking-wide text-slate-500">Time</label>
                <input type="time" value={draft.time} onChange={(e) => { setWhenTouched(true); set('time', e.target.value); }} className={fieldClass} />
              </div>
              {whenTouched && passedWhileScheduled(draft) && (
                <p className="text-[11px] text-amber-300 sm:col-span-2">
                  That time has already passed. The post keeps its old time until you pick one still to come.
                </p>
              )}
              <div>
                <label className="mb-1.5 block text-[11px] uppercase tracking-wide text-slate-500">Type</label>
                <select value={draft.postType} onChange={(e) => set('postType', e.target.value as never)} className={fieldClass}>
                  <option value="post">Single post</option>
                  <option value="carousel">Carousel</option>
                  <option value="reel">Reel</option>
                  <option value="story">Story</option>
                </select>
                <FieldIssues issues={forField('postType')} />
              </div>
              <div>
                <label className="mb-1.5 block text-[11px] uppercase tracking-wide text-slate-500">Delivery</label>
                <select value={draft.deliveryMode} onChange={(e) => set('deliveryMode', e.target.value as never)} className={fieldClass}>
                  <option value="auto">Klippy posts it</option>
                  <option value="manual">Tell me and I will post it</option>
                </select>
              </div>
            </div>
            {draft.deliveryMode === 'auto' && (
              <p className="rounded-lg border border-amber-500/25 bg-amber-500/[0.05] p-2 text-[11px] text-amber-200">
                Klippy cannot post to these networks automatically yet. Until it can, this
                is sent to you at the scheduled time with everything you need to put it up.
              </p>
            )}

            <div>
              <label className="mb-1.5 block text-[11px] uppercase tracking-wide text-slate-500">
                Ask the client for, optional
              </label>
              <input value={draft.mediaAsk} onChange={(e) => set('mediaAsk', e.target.value)}
                className={fieldClass} placeholder="PHOTO: an iced coffee made this week" />
              <p className="mt-1 text-[11px] text-slate-500">
                Filling this in puts the post on the Media asks list until a file arrives.
              </p>
            </div>

            {/* ---- client sign-off ------------------------------------------ */}
            <ApprovalBlock detail={data} postId={postId} onChanged={invalidate} />

            {/* ---- what already happened ------------------------------------ */}
            {data.targets.some((t) => t.permalink || t.error) && (
              <div className="rounded-lg border border-slate-800 p-3">
                <div className="mb-1.5 text-[11px] uppercase tracking-wide text-slate-500">What happened</div>
                {data.targets.map((t) => (
                  <div key={t.id} className="flex items-center gap-2 py-0.5 text-xs">
                    <span className="w-20 text-slate-400">{NETWORK_META[t.network].label}</span>
                    <span className={t.error ? 'text-red-400' : 'text-slate-300'}>
                      {t.error ?? t.status.replace('_', ' ')}
                    </span>
                    {t.permalink && (
                      <a href={t.permalink} target="_blank" rel="noreferrer"
                        className="text-[var(--accent)] hover:underline">view</a>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ---- actions ---------------------------------------------------- */}
          <div className="flex flex-wrap items-center gap-2 border-t border-slate-800 p-4">
            <button onClick={copyCaption} className={btnSecondary + ' flex items-center gap-1.5'}>
              {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy caption'}
            </button>
            <button
              // Same rule as the autosave: an undated draft is not given today at nine just
              // because Save was pressed.
              onClick={() => save.mutate({ body: bodyOf(draft, whenTouched || !!post.scheduledAt), seq: edits })}
              disabled={save.isPending}
              className={btnSecondary + ' flex items-center gap-1.5'}>
              <Save size={14} /> Save
            </button>
            <div className="flex-1" />
            {post.status === 'needs_manual' && (
              <button
                onClick={async () => {
                  const yes = await confirmDialog('Mark this as posted? Do it once it is actually up.', { confirmLabel: 'It is posted' });
                  if (!yes) return;
                  await apiPost(`/social/posts/${postId}/mark-manual-done`, {});
                  invalidate();
                  notify('Marked as posted.', 'ok');
                }}
                className={btnPrimary + ' flex items-center gap-1.5'}>
                <Check size={14} /> Mark as posted
              </button>
            )}
            {/* A post out for sign-off cannot be scheduled, and the server refuses it.
                Offering the button anyway would be inviting a 409. */}
            <button
              onClick={() => schedule.mutate()}
              disabled={schedule.isPending || post.status === 'awaiting_approval'
                || issues.some((i) => i.severity === 'error')}
              title={post.status === 'awaiting_approval'
                ? 'Waiting on the client. Withdraw the link if you want to go ahead without them.'
                : issues.some((i) => i.severity === 'error') ? 'Fix the problems above first' : undefined}
              className={btnPrimary + ' flex items-center gap-1.5'}>
              <Send size={14} /> {post.status === 'scheduled' ? 'Reschedule' : 'Schedule'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/**
 * Which account each network will post to, when that is worth saying.
 *
 * Silent when it is the obvious answer. Spoken when it is not: the account a post was
 * set to has since disconnected, or several accounts are connected on one network and
 * Klippy will not guess between them, so the post will come to a person to put up.
 */
function WhereItGoes({ networks, targets, accounts, businessId }: {
  networks: SocialNetwork[];
  targets: SocialTarget[];
  accounts: SocialAccountsResponse['accounts'];
  businessId: number;
}) {
  const lines = networks.flatMap((n) => {
    const label = NETWORK_META[n].label;
    const target = targets.find((t) => t.network === n);
    const bound = target?.socialAccountId != null ? accounts.find((a) => a.id === target.socialAccountId) : undefined;
    if (bound) {
      return bound.status === 'connected'
        ? [{ key: n, warn: false, text: `${label}: posts to ${bound.displayName}` }]
        : [{ key: n, warn: true, text: `${label}: set to ${bound.displayName}, which needs connecting again under Accounts. Until then it comes to you to post by hand.` }];
    }
    const connected = accounts.filter((a) => a.businessId === businessId && a.network === n && a.status === 'connected');
    return connected.length > 1
      ? [{ key: n, warn: true, text: `${label}: ${connected.length} accounts are connected and Klippy will not guess which one this is for, so it comes to you to post by hand.` }]
      : [];
  });
  if (!lines.length) return null;
  return (
    <div className="mt-2 space-y-1">
      {lines.map((l) => (
        <p key={l.key} className={`text-[11px] ${l.warn ? 'text-amber-300' : 'text-slate-500'}`}>{l.text}</p>
      ))}
    </div>
  );
}

/**
 * Getting a client to say yes.
 *
 * The link is the entire mechanism: no client account, no invitation, no second
 * system to keep in step. Whoever has the link can approve the post, which is exactly
 * how an agency already works over WhatsApp, and it can be taken back in one click.
 *
 * The copy button matters more than it looks. Chasing a sign-off happens in WhatsApp,
 * so the useful thing is a message ready to paste, not a URL on its own.
 */
function ApprovalBlock({ detail, postId, onChanged }: {
  detail: SocialPostDetail;
  postId: number;
  onChanged: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const post = detail.post;
  const url = detail.approvalUrl;
  // The log is newest first, so the first change request in it is the live one.
  const note = detail.log.find((l) => l.message.startsWith('Changes asked for'));

  const request = useMutation({
    mutationFn: () => apiPost<{ approvalUrl: string }>(`/social/posts/${postId}/request-approval`),
    onSuccess: () => { onChanged(); notify('Link ready. Send it to the client.', 'ok'); },
    onError: (e: Error) => notify(e.message, 'error'),
  });

  const revoke = useMutation({
    mutationFn: () => apiPost(`/social/posts/${postId}/revoke-approval`),
    onSuccess: () => { onChanged(); notify('Link withdrawn. It stops working now.', 'ok'); },
    onError: (e: Error) => notify(e.message, 'error'),
  });

  const copyLink = async () => {
    if (!url) return;
    const message = ['Hi, could you have a look at this post before it goes out?', '', url].join('\n');
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { notify('Could not copy. Select the link and copy it.', 'error'); }
  };

  return (
    <div className="rounded-lg border border-slate-800 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-[11px] uppercase tracking-wide text-slate-500">Client sign-off</div>
        <div className="flex-1" />
        {!url && (
          <button onClick={() => request.mutate()} disabled={request.isPending}
            className={btnSecondary + ' flex items-center gap-1.5 !px-2 !py-1 text-xs'}>
            <Link2 size={13} /> {request.isPending ? 'Making a link...' : 'Get an approval link'}
          </button>
        )}
      </div>

      {post.approvedByName && post.approvedAt && (
        <p className="mt-1.5 text-xs text-emerald-300">
          Approved by {post.approvedByName} on {new Date(post.approvedAt).toLocaleDateString()}.
        </p>
      )}

      {/* What they actually asked for, in their words, next to the fields that fix it.
          It reaches a notification as well, but a notification is read once and gone,
          and the person opening this post a day later needs to see the note itself. */}
      {note && !post.approvedAt && (
        <p className="mt-1.5 rounded border border-amber-500/25 bg-amber-500/[0.05] p-2 text-xs text-amber-200">
          {note.message}
        </p>
      )}

      {!url && !post.approvedByName && (
        <p className="mt-1.5 text-[11px] text-slate-500">
          Makes a private link the client can open on their phone. No login, and it
          shows them the post the way it will look.
        </p>
      )}

      {url && (
        <div className="mt-2 space-y-2">
          <div className="num truncate rounded border border-slate-800 bg-slate-900/60 px-2 py-1.5 text-[11px] text-slate-400">
            {url}
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={copyLink} className={btnSecondary + ' flex items-center gap-1.5 !px-2 !py-1 text-xs'}>
              {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy message'}
            </button>
            <a href={url} target="_blank" rel="noreferrer"
              className={btnSecondary + ' flex items-center gap-1.5 !px-2 !py-1 text-xs'}>
              <ExternalLink size={13} /> See what they see
            </a>
            <button
              onClick={async () => {
                const yes = await confirmDialog(
                  'Withdraw this link? It stops working immediately, including in a message already sent.',
                  { confirmLabel: 'Withdraw' });
                if (yes) revoke.mutate();
              }}
              className={btnSecondary + ' flex items-center gap-1.5 !px-2 !py-1 text-xs'}>
              <X size={13} /> Withdraw
            </button>
          </div>
          {post.status === 'awaiting_approval' && (
            <p className="text-[11px] text-slate-500">
              Waiting on them. Their answer lands in your notifications, and any changes
              they ask for show up under What happened.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function FieldIssues({ issues }: { issues: SocialIssue[] }) {
  if (!issues.length) return null;
  return (
    <div className="mt-1.5 space-y-1">
      {issues.map((i, n) => (
        <p key={n} className={`flex items-start gap-1.5 text-[11px] ${
          i.severity === 'error' ? 'text-red-400' : 'text-amber-300'}`}>
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span><span className="text-slate-400">{NETWORK_META[i.network].label}:</span> {i.message}</span>
        </p>
      ))}
    </div>
  );
}

export function StatusPill({ status }: { status: string }) {
  const tone: Record<string, string> = {
    draft: 'text-slate-400 border-slate-700',
    needs_media: 'text-amber-300 border-amber-500/30',
    awaiting_approval: 'text-sky-300 border-sky-500/30',
    approved: 'text-sky-300 border-sky-500/30',
    scheduled: 'text-[var(--accent)] border-[var(--accent)]/40',
    publishing: 'text-[var(--accent)] border-[var(--accent)]/40',
    published: 'text-emerald-300 border-emerald-500/30',
    partially_published: 'text-amber-300 border-amber-500/30',
    failed: 'text-red-400 border-red-500/30',
    needs_manual: 'text-amber-300 border-amber-500/40',
    cancelled: 'text-slate-500 border-slate-800',
  };
  const label: Record<string, string> = {
    needs_media: 'waiting on media',
    awaiting_approval: 'waiting for sign off',
    partially_published: 'partly out',
    needs_manual: 'post it now',
  };
  return (
    <span className={`mt-1 inline-block rounded-full border px-2 py-0.5 text-[10px] ${tone[status] ?? tone.draft}`}>
      {label[status] ?? status.replace('_', ' ')}
    </span>
  );
}

/** Width, height and duration, read in the browser so the server needs no image library. */
async function readDimensions(file: File): Promise<{ width?: number; height?: number; durationMs?: number }> {
  const url = URL.createObjectURL(file);
  try {
    if (file.type.startsWith('video/')) {
      return await new Promise((resolve, reject) => {
        const v = document.createElement('video');
        v.preload = 'metadata';
        v.onloadedmetadata = () => resolve({ width: v.videoWidth, height: v.videoHeight, durationMs: v.duration * 1000 });
        v.onerror = () => reject(new Error('unreadable'));
        v.src = url;
      });
    }
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => reject(new Error('unreadable'));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
