import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../lib/api';
import { fieldInlineClass } from './ui';
import type { Business, Folder } from '../lib/types';

/**
 * Which business a new expense, deal, price or meeting belongs to.
 *
 * With "All businesses" showing these used to be filed under the first business
 * without a word, so a Mondo Hosting expense landed in Mondobase's books. The
 * answer is now: the business being shown, else the client's own business, else
 * the only one there is. Only when none of those settles it does the form ask,
 * with a picker that appears in exactly that case.
 */
export function useFromBusiness(shown: number | undefined, clientFolderId?: number | null) {
  const biz = useQuery({
    queryKey: ['businesses'],
    queryFn: () => apiGet<{ businesses: Business[] }>('/businesses'),
    staleTime: 5 * 60 * 1000,
  });
  const folders = useQuery({ queryKey: ['folders'], queryFn: () => apiGet<{ folders: Folder[] }>('/folders') });
  const list = biz.data?.businesses ?? [];
  const [picked, setPicked] = useState<number | null>(null);

  const fromClient = clientFolderId
    ? folders.data?.folders.find((f) => f.id === clientFolderId)?.businessId ?? null
    : null;
  const id = picked ?? shown ?? fromClient ?? (list.length === 1 ? list[0]!.id : null);
  const ask = shown == null && list.length > 1;
  const missing = ask && id == null;

  const element = ask ? (
    <label className="flex flex-wrap items-center gap-2 text-sm text-slate-300">
      <span className="text-slate-400">Which business</span>
      <select className={`${fieldInlineClass} min-w-[11rem]`} value={id ?? ''}
        onChange={(e) => setPicked(e.target.value ? Number(e.target.value) : null)}>
        <option value="">Pick a business</option>
        {list.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
      </select>
      {!picked && fromClient && id === fromClient && (
        <span className="text-xs text-slate-500">from the client</span>
      )}
    </label>
  ) : null;

  return { id: id ?? undefined, element, missing };
}

export const PICK_BUSINESS = 'Pick which business this is for first, so it lands in the right books.';
