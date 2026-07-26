import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Layers } from 'lucide-react';
import { apiGet, apiPost } from '../lib/api';
import { Menu } from './Menu';
import type { Business } from '../lib/types';

export type BusinessSelection = number | 'all';

// Picks which business you're looking at, or "All businesses" for the combined view.
export function BusinessSwitcher({ value, onChange }: {
  value: BusinessSelection;
  onChange: (v: BusinessSelection) => void;
}) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['businesses'], queryFn: () => apiGet<{ businesses: Business[] }>('/businesses') });
  const list = data?.businesses ?? [];

  const create = useMutation({
    mutationFn: (name: string) => apiPost<{ business: Business }>('/businesses', { name }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['businesses'] });
      if (res?.business?.id) onChange(res.business.id);
    },
  });

  const current = value === 'all' ? 'All businesses' : (list.find((b) => b.id === value)?.name ?? 'Business');

  const items = [
    { label: `${value === 'all' ? '✓ ' : '   '}All businesses`, onClick: () => onChange('all') },
    ...list.map((b) => ({
      label: `${b.id === value ? '✓ ' : '   '}${b.name}`,
      onClick: () => onChange(b.id),
    })),
    { label: '+ New business', onClick: () => { const n = window.prompt('Name for the new business'); if (n?.trim()) create.mutate(n.trim()); } },
  ];

  return (
    <Menu
      align="left"
      trigger={
        <span className="flex max-w-52 items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs text-slate-200 hover:bg-slate-800">
          <Layers size={13} className="shrink-0 text-violet-300" />
          <span className="truncate">{current}</span>
          <ChevronDown size={13} className="shrink-0 text-slate-400" />
        </span>
      }
      items={items}
    />
  );
}
