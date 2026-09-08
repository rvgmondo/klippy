import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, ApiError } from '../lib/api';
import { usePageTitle, useNoIndex } from '../lib/publicPage';

/**
 * The page a client opens to sign off a post.
 *
 * Everything about it is built around one fact: this is read on a phone, by somebody
 * who runs a coffee shop, in the two minutes between things. So there is no login, no
 * account, no app to install, nothing to learn and exactly two buttons. It loads in
 * one request and works on a bad line.
 *
 * It is also the only screen in Klippy a client will ever see, so it wears the
 * business's own name and colour and says nothing about the tool behind it.
 *
 * Light, like the portal and for the same reason: the app is dark because staff stare
 * at it all day, and this is a page somebody opens three times a month.
 */

interface ApprovalView {
  brand: { name: string; color: string; logoUrl: string | null };
  outcome: 'awaiting' | 'approved' | 'changes' | 'closed';
  post: {
    caption: string;
    firstComment: string | null;
    postType: string;
    scheduledAt: string | null;
    whenLabel: string | null;
    networks: { network: 'instagram' | 'facebook' | 'linkedin'; caption: string }[];
    media: { id: number; mimeType: string | null; altText: string | null; url: string | null }[];
  };
  decision: { name: string | null; at: string } | null;
}

const NETWORK_LABEL: Record<string, string> = {
  instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn',
};
const NETWORK_TINT: Record<string, string> = {
  instagram: 'bg-pink-50 text-pink-700 border-pink-200',
  facebook: 'bg-blue-50 text-blue-700 border-blue-200',
  linkedin: 'bg-sky-50 text-sky-700 border-sky-200',
};

/**
 * The token, from either link shape. See the note on approvalUrl in routes/social.ts.
 *
 * Not exported: main.tsx keeps its own copy of this check on purpose, so deciding
 * WHICH of the three apps to load does not pull in the chunk for any of them.
 */
function approvalToken(): string | null {
  const q = new URLSearchParams(window.location.search).get('approve');
  if (q) return q;
  const m = /^\/approve\/([A-Za-z0-9]+)/.exec(window.location.pathname);
  return m ? m[1] : null;
}

export function ApprovePage() {
  const token = approvalToken() ?? '';
  const qc = useQueryClient();
  const [name, setName] = useState(() => localStorage.getItem('klippy.approver') ?? '');
  const [comment, setComment] = useState('');
  const [asking, setAsking] = useState(false);

  const { data, isLoading, error } = useQuery<ApprovalView>({
    queryKey: ['approval', token],
    queryFn: () => apiGet<ApprovalView>(`/approve/${encodeURIComponent(token)}`),
    retry: false,
  });

  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'changes') =>
      apiPost<{ ok: boolean }>(`/approve/${encodeURIComponent(token)}`, {
        decision, name: name.trim(), comment: comment.trim() || undefined,
      }),
    onSuccess: () => {
      // Remembered so the same person is not retyping their name every week. It is
      // their own name in their own browser, and nothing else is kept.
      try { localStorage.setItem('klippy.approver', name.trim()); } catch { /* private mode */ }
      qc.invalidateQueries({ queryKey: ['approval', token] });
      setAsking(false);
      setComment('');
    },
  });

  // Both shared with the portal, which had the same problem: see lib/publicPage.ts.
  usePageTitle(data?.brand.name ? `Approve a post for ${data.brand.name}` : null);
  useNoIndex();

  if (isLoading) {
    return <Shell><p className="py-16 text-center text-sm text-slate-500">Loading...</p></Shell>;
  }

  if (error || !data) {
    const gone = error instanceof ApiError && error.status === 404;
    return (
      <Shell>
        <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center">
          <h1 className="text-base font-semibold text-slate-900">
            {gone ? 'This link is no longer active' : 'Something went wrong'}
          </h1>
          <p className="mt-2 text-sm text-slate-600">
            {gone
              ? 'It may have been withdrawn, or replaced with a newer one. Ask for a fresh link.'
              : 'Try again in a moment. If it keeps happening, tell whoever sent you this.'}
          </p>
        </div>
      </Shell>
    );
  }

  const { brand, post, outcome } = data;
  const accent = /^#[0-9a-f]{3,8}$/i.test(brand.color) ? brand.color : '#6366f1';

  return (
    <Shell brand={brand} accent={accent}>
      {/* ---- what is being asked ------------------------------------------- */}
      <div className="mb-4">
        <h1 className="text-lg font-semibold text-slate-900">
          {outcome === 'awaiting' ? 'Ready for your approval' : 'A post from ' + brand.name}
        </h1>
        {post.whenLabel && (
          <p className="mt-1 text-sm text-slate-600">
            Planned for <span className="font-medium text-slate-800">{post.whenLabel}</span>
          </p>
        )}
      </div>

      {outcome !== 'awaiting' && <OutcomeBanner outcome={outcome} decision={data.decision} />}

      {/* ---- the post, once per network ------------------------------------ */}
      <div className="space-y-4">
        {post.networks.length === 0 && (
          <Preview network={null} caption={post.caption} media={post.media} brand={brand} />
        )}
        {post.networks.map((n) => (
          <Preview key={n.network} network={n.network} caption={n.caption} media={post.media} brand={brand} />
        ))}
      </div>

      {post.firstComment && (
        <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-[11px] uppercase tracking-wide text-slate-500">First comment</div>
          <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{post.firstComment}</p>
          <p className="mt-2 text-xs text-slate-500">
            Posted as a comment underneath, so the caption stays clean.
          </p>
        </div>
      )}

      {/* ---- the two buttons ------------------------------------------------ */}
      {outcome === 'awaiting' && (
        <div className="mt-5 rounded-2xl border border-slate-200 bg-white p-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-700">Your name</span>
            <input
              value={name} onChange={(e) => setName(e.target.value)}
              placeholder="So they know who signed it off"
              className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base text-slate-900 outline-none focus:border-slate-500" />
          </label>

          {asking && (
            <label className="mt-3 block">
              <span className="mb-1 block text-xs font-medium text-slate-700">What needs changing</span>
              <textarea
                value={comment} onChange={(e) => setComment(e.target.value)} rows={4} autoFocus
                placeholder="Be as specific as you like. They see this exactly as you write it."
                className="w-full resize-y rounded-lg border border-slate-300 px-3 py-2.5 text-base text-slate-900 outline-none focus:border-slate-500" />
            </label>
          )}

          {decide.isError && (
            <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {(decide.error as Error).message}
            </p>
          )}

          <div className="mt-4 flex flex-col gap-2 sm:flex-row-reverse">
            {!asking ? (
              <>
                <button
                  onClick={() => decide.mutate('approve')}
                  disabled={!name.trim() || decide.isPending}
                  style={{ backgroundColor: accent }}
                  className="w-full rounded-xl px-4 py-3.5 text-base font-semibold text-white disabled:opacity-50 sm:w-auto sm:flex-1">
                  {decide.isPending ? 'Sending...' : 'Approve this post'}
                </button>
                <button
                  onClick={() => setAsking(true)}
                  className="w-full rounded-xl border border-slate-300 px-4 py-3.5 text-base font-medium text-slate-700 sm:w-auto sm:flex-1">
                  Ask for changes
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => decide.mutate('changes')}
                  disabled={!name.trim() || !comment.trim() || decide.isPending}
                  className="w-full rounded-xl bg-slate-900 px-4 py-3.5 text-base font-semibold text-white disabled:opacity-50 sm:w-auto sm:flex-1">
                  {decide.isPending ? 'Sending...' : 'Send these changes'}
                </button>
                <button
                  onClick={() => { setAsking(false); setComment(''); }}
                  className="w-full rounded-xl border border-slate-300 px-4 py-3.5 text-base font-medium text-slate-700 sm:w-auto sm:flex-1">
                  Back
                </button>
              </>
            )}
          </div>
          <p className="mt-3 text-center text-xs text-slate-500">
            Nothing is posted anywhere until you approve it.
          </p>
        </div>
      )}
    </Shell>
  );
}

function Shell({ children, brand, accent }: {
  children: React.ReactNode;
  brand?: ApprovalView['brand'];
  accent?: string;
}) {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-lg items-center gap-3 px-4 py-4">
          {brand?.logoUrl ? (
            <img src={brand.logoUrl} alt="" className="h-8 max-w-[140px] object-contain" />
          ) : (
            <span className="grid h-8 w-8 place-items-center rounded-lg text-sm font-bold text-white"
              style={{ backgroundColor: accent ?? '#6366f1' }}>
              {(brand?.name ?? 'K').charAt(0).toUpperCase()}
            </span>
          )}
          <span className="truncate text-sm font-semibold">{brand?.name ?? ''}</span>
        </div>
      </header>
      <main className="mx-auto max-w-lg px-4 py-5 pb-16">{children}</main>
    </div>
  );
}

function OutcomeBanner({ outcome, decision }: {
  outcome: ApprovalView['outcome'];
  decision: ApprovalView['decision'];
}) {
  const map = {
    approved: {
      cls: 'border-emerald-200 bg-emerald-50 text-emerald-900',
      title: 'Approved',
      body: decision?.name
        ? `Signed off by ${decision.name}. Nothing more is needed from you.`
        : 'This one is signed off. Nothing more is needed from you.',
    },
    changes: {
      cls: 'border-amber-200 bg-amber-50 text-amber-900',
      title: 'Changes sent',
      body: 'They have your notes and will send it back when it is updated.',
    },
    closed: {
      cls: 'border-slate-200 bg-white text-slate-700',
      title: 'Nothing to do here',
      body: 'This post is no longer waiting on an answer.',
    },
    awaiting: { cls: '', title: '', body: '' },
  }[outcome];

  return (
    <div className={`mb-4 rounded-xl border p-4 ${map.cls}`}>
      <div className="text-sm font-semibold">{map.title}</div>
      <p className="mt-0.5 text-sm">{map.body}</p>
    </div>
  );
}

/**
 * The post roughly as it will look once it is up.
 *
 * Roughly is the honest word and the right target. A pixel copy of Instagram would be
 * a promise this cannot keep, since the real thing depends on their fonts, their app
 * version and their crop. What a client needs to judge is the picture, the words and
 * where it is going, so that is what this shows, in that order.
 */
function Preview({ network, caption, media, brand }: {
  network: 'instagram' | 'facebook' | 'linkedin' | null;
  caption: string;
  media: ApprovalView['post']['media'];
  brand: ApprovalView['brand'];
}) {
  const [more, setMore] = useState(false);
  const long = caption.length > 280;
  const shown = more || !long ? caption : caption.slice(0, 280).trimEnd();

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
      {network && (
        <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-2.5">
          <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${NETWORK_TINT[network]}`}>
            {NETWORK_LABEL[network]}
          </span>
          <span className="truncate text-xs text-slate-500">{brand.name}</span>
        </div>
      )}

      {media.length > 0 && (
        <div className={media.length > 1 ? 'flex snap-x gap-1 overflow-x-auto' : ''}>
          {media.map((m) => (
            <div key={m.id} className={media.length > 1 ? 'w-4/5 shrink-0 snap-start' : ''}>
              {m.mimeType?.startsWith('video/') ? (
                <video src={m.url ?? undefined} controls playsInline
                  className="aspect-square w-full bg-slate-100 object-cover" />
              ) : (
                <img src={m.url ?? undefined} alt={m.altText ?? ''} loading="lazy"
                  className="aspect-square w-full bg-slate-100 object-cover" />
              )}
            </div>
          ))}
        </div>
      )}
      {media.length > 1 && (
        <p className="px-4 pt-2 text-[11px] text-slate-500">
          {media.length} pictures, swipe to see the rest
        </p>
      )}

      <div className="px-4 py-3">
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-800">{shown}</p>
        {long && (
          <button onClick={() => setMore(!more)} className="mt-1 text-sm font-medium text-slate-500">
            {more ? 'Show less' : 'Read more'}
          </button>
        )}
        {!caption.trim() && <p className="text-sm italic text-slate-400">No caption yet.</p>}
      </div>
    </div>
  );
}
