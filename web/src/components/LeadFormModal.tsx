import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, Copy, ExternalLink } from 'lucide-react';
import { apiGet } from '../lib/api';
import { Modal } from './Modal';
import { notify } from './ConfirmDialog';
import { Skeleton } from './ui';

/**
 * The pipeline's front door.
 *
 * Every lead used to arrive somewhere else and wait for the founder to re-type it.
 * This hands over two things: a hosted form to link from anywhere (an email
 * signature, a WhatsApp status, a QR code), and a snippet to paste into a real
 * website. Either way, submissions land in the pipeline as leads, marked
 * "Website form", with the founder out of the typing loop.
 */
export function LeadFormModal({ businessId, onClose }: { businessId: number; onClose: () => void }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['lead-link', businessId],
    queryFn: () => apiGet<{ url: string; embed: string }>(`/businesses/${businessId}/lead-link`),
    retry: false,
  });
  const [copied, setCopied] = useState<'url' | 'embed' | null>(null);

  const copy = async (kind: 'url' | 'embed', text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      setTimeout(() => setCopied(null), 1600);
    } catch {
      notify('Could not copy. Select the text and copy it by hand.', 'error');
    }
  };

  return (
    <Modal onClose={onClose} size="md">
      <div className="p-5">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-100">Your lead form</h2>
          <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-slate-500 hover:bg-slate-800 hover:text-slate-300"><X size={16} /></button>
        </div>
        <p className="mb-4 text-xs text-slate-500">
          Anyone who fills this in lands in your pipeline as a lead, marked "Website form".
          No typing, no lost scraps of paper.
        </p>

        {isLoading && <Skeleton className="h-24" />}
        {error != null && (
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
            {error instanceof Error ? error.message : 'Could not build the link.'}
          </p>
        )}

        {data && (
          <div className="space-y-4">
            <div>
              <div className="mb-1 text-xs font-medium text-slate-400">Share this link</div>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-2 text-xs text-slate-300">{data.url}</code>
                <button onClick={() => copy('url', data.url)} title="Copy the link"
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-slate-700 text-slate-400 hover:bg-slate-800">
                  <Copy size={14} />
                </button>
                <a href={data.url} target="_blank" rel="noreferrer" title="Open the hosted form"
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-slate-700 text-slate-400 hover:bg-slate-800">
                  <ExternalLink size={14} />
                </a>
              </div>
              {copied === 'url' && <p className="mt-1 text-[11px] text-green-400">Copied.</p>}
            </div>

            <div>
              <div className="mb-1 text-xs font-medium text-slate-400">Or paste this into your website</div>
              <pre className="overflow-x-auto rounded-lg border border-slate-700 bg-slate-900/70 p-3 text-[11px] leading-relaxed text-slate-300">{data.embed}</pre>
              <button onClick={() => copy('embed', data.embed)}
                className="mt-2 rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800">
                {copied === 'embed' ? 'Copied' : 'Copy the snippet'}
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
