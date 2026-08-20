import { useQuery } from '@tanstack/react-query';
import { X, Receipt, FileText, Phone, Mail, Users, ArrowRightLeft, StickyNote } from 'lucide-react';
import { apiGet } from '../lib/api';
import { Modal } from './Modal';
import { Skeleton } from './ui';

/**
 * One client's story in order.
 *
 * Every piece already existed: their invoices and quotes in Billing, their deal
 * calls and notes in the pipeline. Nothing showed them as one relationship, so
 * "where do we stand with this client?" meant a tour of modules. This is the
 * answer as a single feed, newest first, read-only.
 */
interface Entry { at: string; kind: string; title: string; detail: string }

const KIND_ICON: Record<string, typeof Receipt> = {
  'document:invoice': Receipt, 'document:quote': FileText, 'document:credit_note': Receipt,
  'deal:call': Phone, 'deal:email': Mail, 'deal:meeting': Users,
  'deal:stage': ArrowRightLeft, 'deal:note': StickyNote,
};

export function ClientTimeline({ folderId, name, onClose }: {
  folderId: number; name: string; onClose: () => void;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['client-timeline', folderId],
    queryFn: () => apiGet<{ entries: Entry[] }>(`/folders/${folderId}/timeline`),
  });

  return (
    <Modal onClose={onClose} variant="drawer">
      <div className="p-5">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-slate-100">{name}</h2>
            <p className="text-xs text-slate-500">Everything that happened with this client, newest first.</p>
          </div>
          <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-800">
            <X size={16} />
          </button>
        </div>

        {isLoading && <div className="space-y-2"><Skeleton className="h-10" /><Skeleton className="h-10" /><Skeleton className="h-10" /></div>}
        {!isLoading && (data?.entries.length ?? 0) === 0 && (
          <p className="py-8 text-center text-sm text-slate-500">Nothing yet. Documents and logged deal activity will land here.</p>
        )}

        <ol className="space-y-0">
          {(data?.entries ?? []).map((e, i) => {
            const Icon = KIND_ICON[e.kind] ?? StickyNote;
            return (
              <li key={i} className="relative flex gap-3 pb-4 pl-1">
                {i < (data?.entries.length ?? 0) - 1 && (
                  <span aria-hidden className="absolute left-[15px] top-7 h-full w-px bg-slate-800" />
                )}
                <span className="z-10 mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full border border-slate-700 bg-slate-900 text-slate-400">
                  <Icon size={13} />
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-sm font-medium text-slate-200">{e.title}</span>
                    <span className="num text-[11px] text-slate-500">{e.at}</span>
                  </div>
                  <p className="mt-0.5 whitespace-pre-line text-xs text-slate-400">{e.detail}</p>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </Modal>
  );
}
