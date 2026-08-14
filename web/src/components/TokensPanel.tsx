import { useState } from 'react';
import { confirmDialog } from './ConfirmDialog';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Copy, Check } from 'lucide-react';
import { apiGet, apiPost, apiDelete } from '../lib/api';

interface Token { id: number; name: string; lastUsedAt: string | null; createdAt: string }

export function TokensPanel() {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const tokens = useQuery({ queryKey: ['tokens'], queryFn: () => apiGet<{ tokens: Token[] }>('/tokens') });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['tokens'] });

  const create = useMutation({
    mutationFn: () => apiPost<{ secret: string }>('/tokens', { name: name.trim() }),
    onSuccess: (res) => { setSecret(res.secret); setName(''); invalidate(); },
  });
  const del = useMutation({ mutationFn: (id: number) => apiDelete(`/tokens/${id}`), onSuccess: invalidate });

  const field = 'rounded-lg bg-slate-900/70 border border-slate-700 px-3 py-2 text-sm text-slate-100 outline-none focus:border-violet-500';

  return (
    <div className="space-y-5">
      <p className="text-xs text-slate-500">
        Access tokens let the Klippy browser extension (or other tools) talk to your workspace.
        Treat a token like a password.
      </p>

      <div className="flex gap-2">
        <input className={field + ' flex-1'} placeholder="What is it for? e.g. Browser extension"
          value={name} onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) create.mutate(); }} />
        <button onClick={() => name.trim() && create.mutate()} disabled={!name.trim() || create.isPending}
          className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-2 text-sm text-[var(--accent-ink)] hover:bg-violet-500 disabled:opacity-60">
          <Plus size={15} /> Create
        </button>
      </div>

      {secret && (
        <div className="rounded-xl border border-green-500/30 bg-green-500/10 p-3">
          <p className="mb-2 text-xs text-green-300">
            Copy this now. It is shown once and never again.
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 overflow-x-auto rounded bg-slate-950 px-2 py-1.5 text-xs text-slate-200">{secret}</code>
            <button
              onClick={() => { navigator.clipboard?.writeText(secret); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
              className="flex shrink-0 items-center gap-1 rounded-lg border border-slate-700 px-2 py-1.5 text-xs text-slate-300 hover:bg-slate-800">
              {copied ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy</>}
            </button>
          </div>
          <button onClick={() => setSecret(null)} className="mt-2 text-[11px] text-slate-400 hover:text-slate-200">
            I have saved it, hide this
          </button>
        </div>
      )}

      <div className="space-y-1">
        {(tokens.data?.tokens ?? []).length === 0 && <p className="text-sm text-slate-500">No tokens yet.</p>}
        {(tokens.data?.tokens ?? []).map((t) => (
          <div key={t.id} className="group flex items-center gap-2 rounded-lg border border-slate-800 px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm text-slate-200">{t.name}</div>
              <div className="text-[11px] text-slate-500">
                {t.lastUsedAt ? `Last used ${new Date(t.lastUsedAt).toLocaleString()}` : 'Never used'}
              </div>
            </div>
            <button onClick={async () => { if (await confirmDialog(`Revoke "${t.name}"? Anything using it stops working.`, { danger: true })) del.mutate(t.id); }}
              className="text-slate-500 hover:text-red-400"><Trash2 size={14} /></button>
          </div>
        ))}
      </div>
    </div>
  );
}
