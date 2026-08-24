import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, X, Mail, Phone } from 'lucide-react';
import { apiGet, apiPost, apiPatch, apiDelete } from '../lib/api';
import type { BusinessSelection } from './BusinessSwitcher';
import { Modal } from './Modal';
import { confirmDialog, notify } from './ConfirmDialog';
import { fieldClass, Skeleton } from './ui';
import { Page, PageHeader, PageBody } from './PageHeader';

/**
 * The people you deal with, as a place of their own.
 *
 * The contacts table had full CRUD and a rich schema, but the only way to reach any
 * of it was a dropdown buried in the deal editor: role and notes could never be
 * entered or read, and the same person across three deals was three scribbles. This
 * is the "who you're dealing with" half of the CRM the schema was already built for.
 */
interface Contact {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  role: string | null;
  notes: string | null;
  businessId: number | null;
  folderId: number | null;
  clientName?: string | null;
}

export function ContactsView({ businessId }: { businessId: BusinessSelection }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Contact | 'new' | null>(null);
  const [search, setSearch] = useState('');
  const bizParam = businessId === 'all' ? '' : `?businessId=${businessId}`;
  const newBusinessId = businessId === 'all' ? undefined : businessId;

  const { data, isLoading } = useQuery({
    queryKey: ['contacts', businessId],
    queryFn: () => apiGet<{ contacts: Contact[] }>(`/contacts${bizParam}`),
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['contacts'] });
  const del = useMutation({ mutationFn: (id: number) => apiDelete(`/contacts/${id}`), onSuccess: invalidate });

  const all = data?.contacts ?? [];
  const q = search.trim().toLowerCase();
  const rows = q
    ? all.filter((c) => [c.name, c.company, c.email, c.role].some((f) => f?.toLowerCase().includes(q)))
    : all;

  return (
    <Page>
      <PageHeader view="contacts" title="Contacts"
        subtitle="The people behind your deals and clients, kept once."
        actions={(
          <>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, company, email..."
              aria-label="Search contacts"
              className="w-44 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-violet-500 sm:w-56" />
            <button onClick={() => setEditing('new')}
              className="flex min-h-10 items-center gap-1.5 rounded-lg bg-violet-600 px-3 text-sm font-medium text-[var(--accent-ink)] hover:bg-violet-500 sm:min-h-9">
              <Plus size={15} /> New contact
            </button>
          </>
        )} />
      <PageBody>

        {isLoading ? (
          <Skeleton className="h-48" />
        ) : rows.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-700 p-8 text-center text-sm text-slate-400">
            {all.length ? 'No contacts match that search.' : 'No contacts yet. Add the people you deal with, or save one from a deal.'}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-800">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800 text-left text-[11px] uppercase tracking-wide text-slate-500">
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Company</th>
                  <th className="px-3 py-2">Contact</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} className="border-t border-slate-800/70">
                    <td className="px-3 py-2">
                      <div className="font-medium text-slate-200">{c.name}</div>
                      {c.role && <div className="text-[11px] text-slate-500">{c.role}</div>}
                    </td>
                    <td className="px-3 py-2 text-slate-300">
                      {c.company || <span className="text-slate-600">-</span>}
                      {c.clientName && <div className="text-[11px] text-slate-500">Client: {c.clientName}</div>}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-col gap-0.5 text-xs">
                        {c.email && <a href={`mailto:${c.email}`} className="flex items-center gap-1.5 text-slate-300 hover:text-violet-300"><Mail size={12} />{c.email}</a>}
                        {c.phone && <a href={`tel:${c.phone}`} className="flex items-center gap-1.5 text-slate-400 hover:text-violet-300"><Phone size={12} />{c.phone}</a>}
                        {!c.email && !c.phone && <span className="text-slate-600">-</span>}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-2">
                        <button onClick={() => setEditing(c)} className="tap text-slate-500 hover:bg-slate-800 hover:text-slate-200" title="Edit"><Pencil size={14} /></button>
                        <button onClick={async () => { if (await confirmDialog(`Delete ${c.name}? Deals linked to them keep their typed details.`, { danger: true })) del.mutate(c.id); }}
                          className="tap text-slate-500 hover:bg-slate-800 hover:text-red-400" title="Delete"><Trash2 size={14} /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </PageBody>

      {editing && (
        <ContactEditor
          contact={editing === 'new' ? null : editing}
          businessId={newBusinessId}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); invalidate(); }}
        />
      )}
    </Page>
  );
}

function ContactEditor({ contact, businessId, onClose, onSaved }: {
  contact: Contact | null;
  businessId?: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = !contact;
  const [name, setName] = useState(contact?.name ?? '');
  const [company, setCompany] = useState(contact?.company ?? '');
  const [role, setRole] = useState(contact?.role ?? '');
  const [email, setEmail] = useState(contact?.email ?? '');
  const [phone, setPhone] = useState(contact?.phone ?? '');
  const [notes, setNotes] = useState(contact?.notes ?? '');
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(), company: company.trim() || null, role: role.trim() || null,
        email: email.trim() || null, phone: phone.trim() || null, notes: notes.trim() || null,
        ...(isNew ? { businessId } : {}),
      };
      return isNew ? apiPost('/contacts', body) : apiPatch(`/contacts/${contact!.id}`, body);
    },
    onSuccess: () => { notify(isNew ? 'Contact added.' : 'Contact saved.'); onSaved(); },
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not save.'),
  });

  const field = fieldClass;
  const label = 'mb-1 block text-xs text-slate-400';

  return (
    <Modal onClose={onClose} variant="panel">
      <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) save.mutate(); }}
        className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-950 p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-100">{isNew ? 'New contact' : 'Edit contact'}</h2>
          <button type="button" onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-800"><X size={16} /></button>
        </div>

        {error && <p className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-300">{error}</p>}

        <label className={label}>Name</label>
        <input autoFocus className={`${field} mb-3`} value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Ndlovu" />

        <div className="mb-3 grid grid-cols-2 gap-2">
          <div>
            <label className={label}>Company</label>
            <input className={field} value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Acme (Pty) Ltd" />
          </div>
          <div>
            <label className={label}>Role</label>
            <input className={field} value={role} onChange={(e) => setRole(e.target.value)} placeholder="Finance manager" />
          </div>
        </div>

        <div className="mb-3 grid grid-cols-2 gap-2">
          <div>
            <label className={label}>Email</label>
            <input className={field} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="jane@acme.co.za" />
          </div>
          <div>
            <label className={label}>Phone</label>
            <input className={field} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+27 82 000 0000" />
          </div>
        </div>

        <label className={label}>Notes</label>
        <textarea className={`${field} mb-4 min-h-[64px] resize-y`} value={notes} onChange={(e) => setNotes(e.target.value)}
          placeholder="Anything worth remembering: how you met, what they care about." />

        <div className="flex items-center gap-3">
          <button type="submit" disabled={!name.trim() || save.isPending}
            className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-[var(--accent-ink)] hover:bg-violet-500 disabled:opacity-50">
            {save.isPending ? 'Saving...' : isNew ? 'Add contact' : 'Save'}
          </button>
          <button type="button" onClick={onClose} className="text-sm text-slate-400 hover:text-slate-200">Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
