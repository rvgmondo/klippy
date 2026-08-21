import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Bell, CircleDollarSign, FileCheck2, UserPlus } from 'lucide-react';
import { apiGet, apiPost } from '../lib/api';
import { setUrlParams } from '../lib/urlAction';

interface Item {
  id: number; kind: string; title: string; body: string | null;
  url: string | null; readAt: string | null; createdAt: string;
}

const KIND_ICON: Record<string, typeof Bell> = {
  lead: UserPlus, payment: CircleDollarSign, quote: FileCheck2,
};

const ago = (iso: string) => {
  const mins = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}h`;
  return `${Math.floor(mins / (60 * 24))}d`;
};

/**
 * The inbox bell: leads, payments and quote decisions that happened while you
 * were not looking. Push is per-device and easily dismissed; this is the record
 * that survives until it is read. Opening the panel marks everything read,
 * because a badge that needs manual clearing becomes a permanent red dot.
 */
export function NotificationsBell() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const { data } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => apiGet<{ items: Item[]; unread: number }>('/notifications'),
    refetchInterval: 60_000,
  });

  const markAll = useMutation({
    mutationFn: () => apiPost('/notifications/read', { all: true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && (data?.unread ?? 0) > 0) markAll.mutate();
  };

  const go = (url: string | null) => {
    setOpen(false);
    if (!url) return;
    const v = new URLSearchParams(url.split('?')[1] ?? '').get('v');
    if (v) setUrlParams({ v });
  };

  return (
    <div ref={ref} className="relative shrink-0">
      <button onClick={toggle} title="Notifications" aria-label={`Notifications${data?.unread ? `, ${data.unread} unread` : ''}`}
        className="relative grid h-9 w-9 place-items-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-slate-200">
        <Bell size={15} />
        {(data?.unread ?? 0) > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid min-w-4 place-items-center rounded-full bg-violet-500 px-1 text-[9px] font-bold leading-4 text-white">
            {data!.unread > 9 ? '9+' : data!.unread}
          </span>
        )}
      </button>

      {open && (
        /* Anchored to the bell on desktop; on a phone that anchor would hang the
           320px panel off the left edge, so it becomes a full-width sheet under
           the header instead. */
        <div className="fixed inset-x-2 top-[calc(3.5rem+env(safe-area-inset-top)+0.25rem)] z-50 overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl sm:absolute sm:inset-x-auto sm:right-0 sm:top-10 sm:w-80">
          <div className="border-b border-slate-800 px-3 py-2 text-xs font-semibold text-slate-300">
            Notifications
          </div>
          {(data?.items.length ?? 0) === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-slate-500">
              Nothing yet. New leads, payments and quote decisions land here.
            </p>
          ) : (
            <div className="max-h-96 divide-y divide-slate-800/70 overflow-y-auto">
              {data!.items.map((n) => {
                const Icon = KIND_ICON[n.kind] ?? Bell;
                return (
                  <button key={n.id} onClick={() => go(n.url)}
                    className={`flex w-full items-start gap-2.5 px-3 py-2.5 text-left hover:bg-slate-800/60 ${n.readAt ? 'opacity-70' : ''}`}>
                    <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-slate-800 text-slate-400">
                      <Icon size={13} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-slate-200">{n.title}</span>
                      {n.body && <span className="mt-0.5 block text-[11px] leading-snug text-slate-500">{n.body}</span>}
                    </span>
                    <span className="shrink-0 text-[10px] text-slate-600">{ago(n.createdAt)}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
