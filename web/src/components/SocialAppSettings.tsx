import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Trash2, ExternalLink } from 'lucide-react';
import { apiGet, apiPut, apiDelete } from '../lib/api';
import { fieldClass, btnPrimary, btnSecondary } from './ui';
import { notify, confirmDialog } from './ConfirmDialog';
import type { SocialAppSetting } from '../lib/socialTypes';

/**
 * The app details a workspace connects through, set up here rather than on a server.
 *
 * These were environment variables, which meant opening cPanel to use a feature.
 * Nobody running Klippy has an SSH session, and asking for one is asking them not to
 * bother. So they live in the database, encrypted, and are edited here.
 *
 * WHAT THIS IS NOT is the account you post to. This is the developer app that makes a
 * login dialog possible at all; connecting a Page happens above and needs this first.
 * The copy says so, because "app id" means nothing to somebody who only wants to post
 * to their own Facebook page.
 */

interface AppConfig {
  provider: 'meta' | 'linkedin';
  title: string;
  idLabel: string;
  secretLabel: string;
  help: string;
  link: string;
  extra: string | null;
  extraHelp: string | null;
}

const META: AppConfig = {
  provider: 'meta',
  title: 'Meta app, for Facebook and Instagram',
  idLabel: 'App ID',
  secretLabel: 'App secret',
  help: 'From developers.facebook.com, My Apps, your app, Settings then Basic.',
  link: 'https://developers.facebook.com/apps/',
  extra: 'Login configuration ID',
  extraHelp: 'Optional. From Facebook Login for Business, Configurations.',
};

const LINKEDIN: AppConfig = {
  provider: 'linkedin',
  title: 'LinkedIn app',
  idLabel: 'Client ID',
  secretLabel: 'Client secret',
  help: 'From linkedin.com/developers, your app, the Auth tab.',
  link: 'https://www.linkedin.com/developers/apps',
  extra: null,
  extraHelp: null,
};

export function SocialAppSettings() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['social-app-settings'],
    queryFn: () => apiGet<{ settings: SocialAppSetting[] }>('/social/app-settings'),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['social-app-settings'] });
    // The accounts list above reads whether a connection is even possible, so it has
    // to be refetched or the Connect button stays hidden after a successful save.
    qc.invalidateQueries({ queryKey: ['social-accounts'] });
  };

  return (
    <div className="space-y-3">
      {[META, LINKEDIN].map((cfg) => (
        <AppCard key={cfg.provider} cfg={cfg}
          current={data?.settings.find((s) => s.provider === cfg.provider)}
          onSaved={refresh} />
      ))}
    </div>
  );
}

function AppCard({ cfg, current, onSaved }: {
  cfg: AppConfig;
  current?: SocialAppSetting;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [configId, setConfigId] = useState('');

  const save = useMutation({
    mutationFn: () => apiPut(`/social/app-settings/${cfg.provider}`, {
      appId: appId.trim(),
      // Left out entirely when blank, which the server reads as "keep the one you
      // have" rather than "clear it".
      ...(appSecret.trim() ? { appSecret: appSecret.trim() } : {}),
      ...(cfg.extra ? { configId: configId.trim() || null } : {}),
    }),
    onSuccess: () => {
      setOpen(false);
      setAppSecret('');
      onSaved();
      notify('Saved. You can connect an account now.', 'ok');
    },
    onError: (e: Error) => notify(e.message, 'error'),
  });

  const clear = useMutation({
    mutationFn: () => apiDelete<{ message?: string }>(`/social/app-settings/${cfg.provider}`),
    onSuccess: (r) => { onSaved(); notify(r?.message ?? 'Removed.', 'ok'); },
    onError: (e: Error) => notify(e.message, 'error'),
  });

  const ready = current?.source === 'workspace' || current?.source === 'server';

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <KeyRound size={14} className="text-slate-500" />
        <span className="text-sm font-medium text-slate-200">{cfg.title}</span>
        {current?.source === 'workspace' && <span className="text-[11px] text-emerald-300">set up</span>}
        {current?.source === 'server' && <span className="text-[11px] text-slate-400">provided by Klippy</span>}
        {current?.source === 'none' && <span className="text-[11px] text-amber-300">not set up</span>}
        <div className="flex-1" />
        {!open && (
          <button
            onClick={() => {
              setAppId(current?.appId ?? '');
              setConfigId(current?.configId ?? '');
              setOpen(true);
            }}
            className={btnSecondary + ' !px-3 !py-1.5 text-xs'}>
            {ready ? 'Change' : 'Set it up'}
          </button>
        )}
        {current?.source === 'workspace' && !open && (
          <button
            onClick={async () => {
              const yes = await confirmDialog(
                'Remove these app details? Accounts already connected keep posting. Only new connections would need them again.',
                { confirmLabel: 'Remove' });
              if (yes) clear.mutate();
            }}
            title="Remove"
            className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-red-400">
            <Trash2 size={13} />
          </button>
        )}
      </div>

      {!open && current?.appId && <p className="num mt-1 text-[11px] text-slate-500">{current.appId}</p>}

      {open && (
        <form onSubmit={(e) => { e.preventDefault(); if (appId.trim()) save.mutate(); }} className="mt-3 space-y-2">
          <p className="text-[11px] text-slate-500">
            {cfg.help}{' '}
            <a href={cfg.link} target="_blank" rel="noreferrer"
              className="inline-flex items-center gap-0.5 text-[var(--accent)] hover:underline">
              open it <ExternalLink size={10} />
            </a>
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-[11px] text-slate-500">{cfg.idLabel}</span>
              <input className={fieldClass} value={appId} onChange={(e) => setAppId(e.target.value)} required autoFocus />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] text-slate-500">
                {cfg.secretLabel}{current?.hasSecret ? ', leave blank to keep' : ''}
              </span>
              <input className={fieldClass} type="password" value={appSecret}
                onChange={(e) => setAppSecret(e.target.value)}
                placeholder={current?.hasSecret ? 'unchanged' : ''} />
            </label>
            {cfg.extra && (
              <label className="block sm:col-span-2">
                <span className="mb-1 block text-[11px] text-slate-500">{cfg.extra}</span>
                <input className={fieldClass} value={configId} onChange={(e) => setConfigId(e.target.value)} />
                <span className="mt-1 block text-[11px] text-slate-500">{cfg.extraHelp}</span>
              </label>
            )}
          </div>
          <div className="flex gap-2">
            <button type="submit" disabled={!appId.trim() || save.isPending} className={btnPrimary}>Save</button>
            <button type="button" onClick={() => { setOpen(false); setAppSecret(''); }} className={btnSecondary}>
              Cancel
            </button>
          </div>
          <p className="text-[11px] text-slate-500">
            The secret is encrypted before it is stored and is never sent back to this screen.
          </p>
        </form>
      )}
    </div>
  );
}
