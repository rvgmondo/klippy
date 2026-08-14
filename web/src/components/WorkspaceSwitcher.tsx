import { useState } from 'react';
import { promptDialog } from './ConfirmDialog';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown } from 'lucide-react';
import { apiGet, apiPost } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Menu } from './Menu';

interface Workspace {
  accountId: number;
  role: 'owner' | 'admin' | 'member';
  name: string;
  slug: string;
}

export function WorkspaceSwitcher() {
  const qc = useQueryClient();
  const { account, refresh } = useAuth();
  const [busy, setBusy] = useState(false);

  const { data } = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => apiGet<{ workspaces: Workspace[]; activeAccountId: number }>('/workspaces'),
  });
  const spaces = data?.workspaces ?? [];

  const switchTo = useMutation({
    mutationFn: (accountId: number) => apiPost('/workspaces/switch', { accountId }),
    onSuccess: async () => {
      // Everything on screen belongs to the old workspace; drop it all.
      qc.clear();
      await refresh();
      setBusy(false);
    },
  });

  const create = useMutation({
    mutationFn: (name: string) => apiPost('/workspaces', { name }),
    onSuccess: async () => { qc.clear(); await refresh(); },
  });

  const items = [
    ...spaces.map((w) => ({
      label: `${w.accountId === account?.id ? '✓ ' : '   '}${w.name}`,
      onClick: () => {
        if (w.accountId === account?.id) return;
        setBusy(true);
        switchTo.mutate(w.accountId);
      },
    })),
    {
      label: '+ New workspace',
      onClick: async () => {
        const name = await promptDialog('Name for the new workspace');
        if (name?.trim()) create.mutate(name.trim());
      },
    },
  ];

  return (
    <Menu
      align="left"
      trigger={
        <span className="flex max-w-44 items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs text-slate-200 hover:bg-slate-800">
          <span className="truncate">{busy ? 'Switching...' : account?.name ?? 'Workspace'}</span>
          <ChevronDown size={13} className="shrink-0 text-slate-400" />
        </span>
      }
      items={items}
    />
  );
}

/** Small helper used by Settings to show which workspaces you belong to. */
export function WorkspaceList() {
  const { account } = useAuth();
  const { data } = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => apiGet<{ workspaces: Workspace[] }>('/workspaces'),
  });
  return (
    <div className="space-y-1">
      {(data?.workspaces ?? []).map((w) => (
        <div key={w.accountId} className="flex items-center gap-2 rounded-lg border border-slate-800 px-3 py-2">
          <span className="flex-1 truncate text-sm text-slate-200">{w.name}</span>
          <span className="text-[11px] uppercase tracking-wide text-slate-500">{w.role}</span>
          {w.accountId === account?.id && <Check size={14} className="text-green-400" />}
        </div>
      ))}
      <p className="pt-1 text-[11px] text-slate-500">
        A workspace is a separate, walled-off account. Most people just need one and manage several
        <span className="text-slate-400"> businesses</span> inside it, using the business menu in the top bar.
      </p>
    </div>
  );
}
