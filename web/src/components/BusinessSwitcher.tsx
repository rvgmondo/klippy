import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Layers } from 'lucide-react';
import { apiGet, apiPost, apiDelete, ApiError } from '../lib/api';
import { Menu } from './Menu';
import { NewBusinessModal } from './NewBusinessModal';
import type { Business, BusinessType } from '../lib/types';

export type BusinessSelection = number | 'all';

// Picks which business you're looking at, or "All businesses" for the combined view.
export function BusinessSwitcher({ value, onChange, full }: {
  value: BusinessSelection;
  onChange: (v: BusinessSelection) => void;
  full?: boolean;
}) {
  const qc = useQueryClient();
  const [showNew, setShowNew] = useState(false);
  const { data } = useQuery({ queryKey: ['businesses'], queryFn: () => apiGet<{ businesses: Business[] }>('/businesses') });
  const list = data?.businesses ?? [];

  const create = useMutation({
    mutationFn: (v: { name: string; type: BusinessType }) => apiPost<{ business: Business }>('/businesses', v),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['businesses'] });
      if (res?.business?.id) onChange(res.business.id);
      setShowNew(false);
    },
    onError: (err) => {
      alert(err instanceof ApiError ? err.message : 'Failed to create business.');
    },
  });

  const del = useMutation({
    mutationFn: (id: number) => apiDelete<{ ok: true }>(`/businesses/${id}`),
    onSuccess: (_res, id) => {
      qc.invalidateQueries({ queryKey: ['businesses'] });
      if (value === id) onChange('all');
    },
    onError: (err) => {
      alert(err instanceof ApiError ? err.message : 'Failed to delete business.');
    },
  });

  const current = value === 'all' ? 'All businesses' : (list.find((b) => b.id === value)?.name ?? 'Business');

  const items = [
    { label: `${value === 'all' ? '✓ ' : '   '}All businesses`, onClick: () => onChange('all') },
    ...list.map((b) => ({
      label: `${b.id === value ? '✓ ' : '   '}${b.name}`,
      onClick: () => onChange(b.id),
      onDelete: () => {
        if (list.length <= 1) { alert('You need at least one business.'); return; }
        if (confirm(`Delete "${b.name}"? This cannot be undone.`)) del.mutate(b.id);
      },
    })),
    { label: '+ New business', onClick: () => setShowNew(true) },
  ];

  return (
    <>
      <Menu
        align="left"
        fullWidth={full}
        trigger={
          <span className={`flex items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs text-slate-200 hover:bg-slate-800 ${full ? 'w-full' : 'max-w-52'}`}>
            <Layers size={13} className="shrink-0 text-violet-300" />
            <span className="flex-1 truncate text-left">{current}</span>
            <ChevronDown size={13} className="shrink-0 text-slate-400" />
          </span>
        }
        items={items}
      />
      {showNew && (
        <NewBusinessModal
          onClose={() => setShowNew(false)}
          isPending={create.isPending}
          onCreate={(name, type) => create.mutate({ name, type })}
        />
      )}
    </>
  );
}
