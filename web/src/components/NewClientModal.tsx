import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { apiPatch, apiPost } from '../lib/api';
import { Modal } from './Modal';
import type { Folder } from '../lib/types';

/**
 * Adding a client, with the details that make everything else work.
 *
 * A browser prompt asking only for a name is quick to build and expensive
 * afterwards: without a billing email a recurring invoice can only ever be a draft
 * somebody sends by hand, nothing can be chased automatically, and the portal has
 * nobody to invite. Those facts are known at the moment the client is created and
 * awkward to remember later, so this asks for them once, up front, and lets you
 * skip anything you do not have yet.
 */
export function NewClientModal({ businessId, businessName, pillar, label, onClose, onCreated }: {
  businessId: number;
  businessName: string;
  pillar: 'delivery' | 'operations';
  label: string;
  onClose: () => void;
  onCreated: (folder: Folder) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [billingEmail, setBillingEmail] = useState('');
  const [vatNumber, setVatNumber] = useState('');
  const [address, setAddress] = useState('');
  const [notes, setNotes] = useState('');
  const [invite, setInvite] = useState(false);
  const [err, setErr] = useState('');

  const create = useMutation({
    mutationFn: async () => {
      const { folder } = await apiPost<{ folder: Folder }>('/folders', {
        name: name.trim(), parentId: null, businessId, pillar,
        ...(billingEmail.trim() ? { billingEmail: billingEmail.trim() } : {}),
      });
      // The rest goes through the ordinary update, so there is one place that
      // validates a client's details rather than two that can drift apart.
      if (vatNumber.trim() || address.trim() || notes.trim()) {
        await apiPatch(`/folders/${folder.id}`, {
          billingVatNumber: vatNumber.trim() || null,
          billingAddress: address.trim() || null,
          notes: notes.trim() || null,
        }).catch(() => { /* the client exists; details can be edited after */ });
      }
      if (invite && billingEmail.trim()) {
        await apiPost(`/folders/${folder.id}/portal-users`, {
          email: billingEmail.trim(), invite: true,
        }).catch(() => { /* the client exists; the invite can be resent */ });
      }
      return folder;
    },
    onSuccess: (folder) => {
      qc.invalidateQueries({ queryKey: ['folders'] });
      onCreated(folder);
    },
    onError: (e) => setErr(e instanceof Error ? e.message : 'Could not add that client.'),
  });

  const field = 'w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-[var(--accent)]';
  const lbl = 'mb-1 block text-xs font-medium text-slate-400';

  return (
    <Modal onClose={onClose} size="md" labelledBy="new-client-title"
      confirmClose={() => (name.trim() || billingEmail.trim()
        ? window.confirm('Close without adding this client?') : true)}>
      <form className="p-5" onSubmit={(e) => { e.preventDefault(); if (name.trim()) create.mutate(); }}>
        <div className="mb-1 flex items-center justify-between">
          <h2 id="new-client-title" className="text-base font-semibold text-slate-100">
            New {label.toLowerCase()}
          </h2>
          <button type="button" onClick={onClose} className="text-slate-500 hover:text-slate-300"><X size={16} /></button>
        </div>
        <p className="mb-4 text-xs text-slate-500">In {businessName}. Only the name is required.</p>

        {err && <p className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-300">{err}</p>}

        <div className="space-y-3">
          <div>
            <label className={lbl}>Name</label>
            <input className={field} autoFocus value={name} onChange={(e) => setName(e.target.value)}
              placeholder="Acme (Pty) Ltd" />
          </div>

          <div>
            <label className={lbl}>Billing email</label>
            <input className={field} type="email" value={billingEmail}
              onChange={(e) => setBillingEmail(e.target.value)} placeholder="accounts@acme.co.za" />
            <p className="mt-1 text-[11px] text-slate-500">
              Where invoices and payment reminders go. Without it a recurring invoice can only ever be a
              draft you send by hand.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={lbl}>VAT number</label>
              <input className={field} value={vatNumber} onChange={(e) => setVatNumber(e.target.value)}
                placeholder="Optional" />
            </div>
            <div>
              <label className={lbl}>Billing address</label>
              <input className={field} value={address} onChange={(e) => setAddress(e.target.value)}
                placeholder="Optional" />
            </div>
          </div>

          <div>
            <label className={lbl}>Notes</label>
            <textarea className={field} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)}
              placeholder="Anything worth remembering about them" />
          </div>

          {billingEmail.trim() && (
            <label className="flex items-start gap-2 text-sm text-slate-300">
              <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
                checked={invite} onChange={(e) => setInvite(e.target.checked)} />
              <span>
                Send them a portal sign-in link now
                <span className="block text-[11px] text-slate-500">
                  They can see their invoices, pay online and check their hosting.
                </span>
              </span>
            </label>
          )}
        </div>

        <div className="mt-5 flex items-center gap-3 border-t border-slate-800 pt-4">
          <button type="submit" disabled={!name.trim() || create.isPending}
            className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-ink)] hover:opacity-90 disabled:opacity-50">
            {create.isPending ? 'Adding...' : `Add ${label.toLowerCase()}`}
          </button>
          <button type="button" onClick={onClose} className="text-sm text-slate-400 hover:text-slate-200">
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}
