import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X, Trash2 } from 'lucide-react';
import { apiGet, apiPost, apiPatch, apiDelete } from '../lib/api';
import type { Folder } from '../lib/types';
import type { BusinessSelection } from './BusinessSwitcher';

export interface CalendarEvent {
  id: number; title: string; kind: 'meeting' | 'call' | 'deadline' | 'other';
  startAt: string; endAt: string | null; allDay: boolean;
  location: string | null; attendees: string | null; description: string | null;
  businessId: number | null; folderId: number | null; clientName?: string | null;
}

const KINDS: { value: CalendarEvent['kind']; label: string }[] = [
  { value: 'meeting', label: 'Meeting' },
  { value: 'call', label: 'Call' },
  { value: 'deadline', label: 'Deadline' },
  { value: 'other', label: 'Other' },
];

/** "2026-08-10T09:00" for a datetime-local input, in the viewer's own timezone. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Book a meeting, call or deadline.
 *
 * Klippy could say a task was due on Thursday but not that you had a call with the
 * client at nine, which is half a diary. Attaching it to a client is what makes it
 * a business record rather than a note to self.
 */
export function MeetingModal({ existing, defaultDate, businessId, onClose }: {
  existing?: CalendarEvent;
  defaultDate?: string;
  businessId: BusinessSelection;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const isNew = !existing;

  const startDefault = existing
    ? toLocalInput(existing.startAt)
    : `${defaultDate ?? new Date().toISOString().slice(0, 10)}T09:00`;

  const [title, setTitle] = useState(existing?.title ?? '');
  const [kind, setKind] = useState<CalendarEvent['kind']>(existing?.kind ?? 'meeting');
  const [startAt, setStartAt] = useState(startDefault);
  const [endAt, setEndAt] = useState(existing?.endAt ? toLocalInput(existing.endAt) : '');
  const [allDay, setAllDay] = useState(existing?.allDay ?? false);
  const [location, setLocation] = useState(existing?.location ?? '');
  const [attendees, setAttendees] = useState(existing?.attendees ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [folderId, setFolderId] = useState<string>(existing?.folderId ? String(existing.folderId) : '');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const foldersQ = useQuery({ queryKey: ['folders'], queryFn: () => apiGet<{ folders: Folder[] }>('/folders') });
  const clients = (foldersQ.data?.folders ?? []).filter((f) =>
    f.parentId === null && (businessId === 'all' || f.businessId === businessId));

  const done = () => {
    qc.invalidateQueries({ queryKey: ['calendar-events'] });
    qc.invalidateQueries({ queryKey: ['command-centre'] });
    onClose();
  };

  const save = useMutation({
    mutationFn: () => {
      // Send a full instant, never the naive "2026-08-07T14:00" the input gives us.
      // A naive string is resolved in the SERVER's timezone, so a UTC host would
      // shift every meeting for a South African user by two hours.
      const asInstant = (v: string) => (v ? new Date(v).toISOString() : null);
      const body = {
        title: title.trim(), kind,
        startAt: asInstant(startAt), endAt: asInstant(endAt), allDay,
        location: location.trim() || null, attendees: attendees.trim() || null,
        description: description.trim() || null,
        folderId: folderId ? Number(folderId) : null,
        ...(isNew && businessId !== 'all' ? { businessId } : {}),
      };
      return isNew ? apiPost('/calendar-events', body) : apiPatch(`/calendar-events/${existing!.id}`, body);
    },
    onSuccess: done,
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not save.'),
  });
  const del = useMutation({
    mutationFn: () => apiDelete(`/calendar-events/${existing!.id}`),
    onSuccess: done,
  });

  const field = 'w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-[var(--accent)]';
  const label = 'mb-1 block text-[11px] text-slate-400';

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <form onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); if (title.trim()) save.mutate(); }}
        className="max-h-[88vh] w-full max-w-md overflow-y-auto rounded-2xl border border-slate-700 bg-slate-950 p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-display text-lg font-semibold text-slate-100">{isNew ? 'New meeting' : 'Edit meeting'}</h2>
          <button type="button" onClick={onClose}
            className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-800"><X size={16} /></button>
        </div>

        <label className={label}>What is it</label>
        <input autoFocus className={`${field} mb-3`} value={title} onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Kickoff call with Acme" />

        <div className="mb-3 flex flex-wrap gap-1.5">
          {KINDS.map((k) => (
            <button type="button" key={k.value} onClick={() => setKind(k.value)}
              className={`rounded-full border px-2.5 py-1 text-[11px] ${
                kind === k.value ? 'border-[var(--accent)] bg-[var(--accent-quiet)] text-[var(--accent)]'
                  : 'border-slate-700 text-slate-400 hover:border-slate-600'}`}>
              {k.label}
            </button>
          ))}
        </div>

        <label className="mb-3 flex items-center gap-2 text-sm text-slate-300">
          <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]"
            checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
          All day
        </label>

        <div className="mb-3 grid grid-cols-2 gap-3">
          <div>
            <label className={label}>Starts</label>
            <input type="datetime-local" className={field} value={startAt} onChange={(e) => setStartAt(e.target.value)} />
          </div>
          <div>
            <label className={label}>Ends (optional)</label>
            <input type="datetime-local" className={field} value={endAt} onChange={(e) => setEndAt(e.target.value)} />
          </div>
        </div>

        <label className={label}>Client (optional)</label>
        <select className={`${field} mb-3`} value={folderId} onChange={(e) => setFolderId(e.target.value)}>
          <option value="">Not client specific</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>

        <div className="mb-3 grid grid-cols-2 gap-3">
          <div>
            <label className={label}>Where</label>
            <input className={field} value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Zoom, office..." />
          </div>
          <div>
            <label className={label}>Who</label>
            <input className={field} value={attendees} onChange={(e) => setAttendees(e.target.value)} placeholder="Names or emails" />
          </div>
        </div>

        <label className={label}>Notes</label>
        <textarea className={`${field} mb-4 min-h-[60px] resize-y`} value={description}
          onChange={(e) => setDescription(e.target.value)} placeholder="Agenda, what to prepare..." />

        {error && <p className="mb-3 text-xs text-red-400">{error}</p>}

        <div className="flex items-center gap-2">
          <button type="submit" disabled={!title.trim() || save.isPending}
            className="flex-1 rounded-lg bg-[var(--accent)] py-2 text-sm font-medium text-[var(--accent-ink)] hover:opacity-90 disabled:opacity-50">
            {save.isPending ? 'Saving...' : isNew ? 'Add to calendar' : 'Save'}
          </button>
          {!isNew && (
            <button type="button" onClick={() => { if (confirm('Delete this meeting?')) del.mutate(); }}
              className="grid h-9 w-9 place-items-center rounded-lg border border-slate-700 text-slate-400 hover:bg-red-500/10 hover:text-red-400">
              <Trash2 size={15} />
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
