import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../lib/api';
import type { Folder } from '../lib/types';
import { fieldClass } from './ui';

export interface PickedClient {
  folderId: number | null;
  name: string;
  email: string;
  address: string;
  vatNumber: string;
}

/**
 * Choose which client a document is for.
 *
 * This used to be a free-text name, which quietly cost more than it looked. A typed
 * name is not a link to anything: the invoice carried no folderId, so it never
 * appeared on the client's statement, never reached their portal, and "Acme" and
 * "Acme Pty Ltd" were two different customers as far as every total was concerned.
 *
 * Picking from the list sets the link and fills in the details the client
 * maintains. Typing a name by hand is still allowed, because a one-off invoice to
 * somebody who will never be a client again is a real thing, but it is now the
 * deliberate second option rather than the only one.
 */
export function ClientPicker({ businessId, value, onChange }: {
  businessId?: number;
  value: PickedClient;
  onChange: (v: PickedClient) => void;
}) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [err, setErr] = useState('');

  const { data } = useQuery({
    queryKey: ['folders'],
    queryFn: () => apiGet<{ folders: Folder[] }>('/folders'),
  });
  // Top-level folders are the clients; subfolders are projects inside one.
  const clients = (data?.folders ?? [])
    .filter((f) => !f.parentId && !f.isArchived && (!businessId || f.businessId === businessId))
    .sort((a, b) => a.name.localeCompare(b.name));

  const create = useMutation({
    mutationFn: () => apiPost<{ folder: Folder }>('/folders', {
      name: newName.trim(),
      ...(newEmail.trim() ? { billingEmail: newEmail.trim() } : {}),
      ...(businessId ? { businessId } : {}),
    }),
    onSuccess: (r) => {
      setAdding(false); setNewName(''); setNewEmail(''); setErr('');
      qc.invalidateQueries({ queryKey: ['folders'] });
      onChange({
        folderId: r.folder.id, name: r.folder.name,
        email: r.folder.billingEmail ?? '', address: '', vatNumber: '',
      });
    },
    onError: (e) => setErr(e instanceof Error ? e.message : 'Could not add that client.'),
  });

  const pick = (id: string) => {
    if (id === '__new') { setAdding(true); return; }
    if (id === '') { onChange({ folderId: null, name: '', email: '', address: '', vatNumber: '' }); return; }
    const f = clients.find((c) => String(c.id) === id);
    if (!f) return;
    onChange({
      folderId: f.id,
      name: f.name,
      email: f.billingEmail ?? '',
      // Whatever the client has corrected about themselves in their portal wins,
      // since they are the ones who know their own VAT number.
      address: f.billingAddress ?? '',
      vatNumber: f.billingVatNumber ?? '',
    });
  };

  const field = fieldClass;

  if (adding) {
    return (
      <div className="rounded-lg border border-slate-700 p-3">
        <div className="mb-2 text-xs font-medium text-slate-300">New client</div>
        {err && <p className="mb-2 text-xs text-red-400">{err}</p>}
        <div className="grid gap-2 sm:grid-cols-2">
          <input className={field} autoFocus placeholder="Client name" value={newName}
            onChange={(e) => setNewName(e.target.value)} />
          <input className={field} placeholder="Billing email (optional)" value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)} />
        </div>
        <div className="mt-2 flex gap-2">
          <button type="button" onClick={() => create.mutate()} disabled={!newName.trim() || create.isPending}
            className="rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-500 disabled:opacity-50">
            {create.isPending ? 'Adding...' : 'Add and use'}
          </button>
          <button type="button" onClick={() => { setAdding(false); setErr(''); }}
            className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800">
            Cancel
          </button>
        </div>
        <p className="mt-2 text-[11px] text-slate-500">
          Adding a client here creates them properly, so this invoice shows on their statement and in
          their portal.
        </p>
      </div>
    );
  }

  return (
    <div>
      <select className={field} value={value.folderId ? String(value.folderId) : ''}
        onChange={(e) => pick(e.target.value)}>
        <option value="">Choose a client...</option>
        {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        <option value="__new">+ Add a new client</option>
      </select>

      {!value.folderId && (
        <div className="mt-2">
          <input className={field} placeholder="or type a one-off name"
            value={value.name} onChange={(e) => onChange({ ...value, name: e.target.value })} />
          <p className="mt-1 text-[11px] text-slate-500">
            A typed name is not linked to a client, so it will not appear on their statement or in their
            portal. Fine for a one-off, worth picking from the list otherwise.
          </p>
        </div>
      )}
    </div>
  );
}
