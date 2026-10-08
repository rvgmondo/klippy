import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Trash2, CalendarDays } from 'lucide-react';
import { apiDelete, apiGet, apiPost, ApiError } from '../lib/api';
import { confirmDialog, notify } from './ConfirmDialog';
import { Modal } from './Modal';
import { btnPrimary, btnSecondary, fieldClass } from './ui';

/**
 * Reading your Outlook, Google or Apple calendar into Klippy.
 *
 * One-way: meetings come in and show on the calendar and in Today, so the day
 * plan accounts for them. They are changed where they live, not here. Private to
 * the person who adds them.
 */

interface Feed { id: number; name: string; host: string; lastSyncedAt: string | null; lastError: string | null; eventCount: number }

const ago = (iso: string | null) => {
  if (!iso) return 'not read yet';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};

export function CalendarFeedsModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['calendar-feeds'], queryFn: () => apiGet<{ feeds: Feed[] }>('/calendar-feeds') });
  const [url, setUrl] = useState('');
  const [how, setHow] = useState<'outlook' | 'google' | 'apple'>('outlook');
  const refreshAll = () => {
    void qc.invalidateQueries({ queryKey: ['calendar-feeds'] });
    void qc.invalidateQueries({ queryKey: ['external-events'] });
    void qc.invalidateQueries({ queryKey: ['day'] });
  };
  const add = useMutation({
    mutationFn: () => apiPost<{ feed: Feed; synced: { count: number } }>('/calendar-feeds', { url }),
    onSuccess: (r) => { setUrl(''); refreshAll(); notify(`Connected. ${r.synced.count} meetings read in.`, 'ok'); },
    onError: (e) => notify(e instanceof ApiError ? e.message : 'That calendar could not be read.', 'error'),
  });
  const refresh = useMutation({
    mutationFn: (id: number) => apiPost<{ synced: { ok: boolean; count: number; error?: string } }>(`/calendar-feeds/${id}/refresh`),
    onSuccess: (r) => { refreshAll(); notify(r.synced.ok ? `Read again: ${r.synced.count} meetings.` : r.synced.error ?? 'Could not read it.', r.synced.ok ? 'ok' : 'error'); },
  });
  const remove = useMutation({
    mutationFn: (id: number) => apiDelete(`/calendar-feeds/${id}`),
    onSuccess: () => { refreshAll(); notify('Removed. Its meetings no longer show in Klippy.', 'ok'); },
  });
  const feeds = data?.feeds ?? [];

  return (
    <Modal onClose={onClose}>
      <div className="max-h-[85vh] space-y-5 overflow-y-auto p-5">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold text-slate-100"><CalendarDays size={17} /> Your calendars</h2>
          <p className="mt-1 text-sm text-slate-400">
            Read your Outlook, Google or Apple calendar into Klippy, so your meetings show on the calendar and Today plans around them.
            It works one way: add and change meetings in your own calendar, and Klippy picks them up within about 15 minutes. Only you see them.
          </p>
        </div>

        {feeds.length > 0 && (
          <ul className="space-y-2">
            {feeds.map((f) => (
              <li key={f.id} className="rounded-lg border border-slate-800 p-3">
                <div className="flex items-start justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-slate-100">{f.name}</span>
                    <span className="block truncate text-xs text-slate-500">{f.host}, read {ago(f.lastSyncedAt)}, {f.eventCount} meetings</span>
                  </span>
                  <span className="flex shrink-0 gap-1">
                    <button onClick={() => refresh.mutate(f.id)} disabled={refresh.isPending} title="Read it again now"
                      className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-slate-200"><RefreshCw size={14} /></button>
                    <button onClick={async () => { if (await confirmDialog(`Stop reading ${f.name}? Its meetings disappear from Klippy. Your calendar itself is not touched.`, { confirmLabel: 'Remove', danger: true })) remove.mutate(f.id); }}
                      title="Remove" className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-red-300"><Trash2 size={14} /></button>
                  </span>
                </div>
                {f.lastError && <p className="mt-2 text-xs text-amber-300">{f.lastError}</p>}
              </li>
            ))}
          </ul>
        )}

        <div className="space-y-3 rounded-lg border border-slate-800 p-3">
          <p className="text-sm font-medium text-slate-200">Add a calendar</p>
          <div className="flex gap-1 text-xs">
            {(['outlook', 'google', 'apple'] as const).map((k) => (
              <button key={k} onClick={() => setHow(k)} aria-pressed={how === k}
                className={`rounded-md px-2.5 py-1 ${how === k ? 'bg-slate-700 text-slate-100' : 'text-slate-400 hover:bg-slate-800'}`}>
                {k === 'outlook' ? 'Outlook' : k === 'google' ? 'Google' : 'Apple'}
              </button>
            ))}
          </div>
          <ol className="list-decimal space-y-1 pl-5 text-xs text-slate-400">
            {how === 'outlook' && <>
              <li>Open Outlook on the web (outlook.office.com or outlook.live.com).</li>
              <li>Settings, Calendar, Shared calendars, then Publish a calendar.</li>
              <li>Pick your calendar, choose "Can view all details", and press Publish.</li>
              <li>Copy the <strong>ICS</strong> link (not the HTML one) and paste it below.</li>
            </>}
            {how === 'google' && <>
              <li>Open Google Calendar on a computer and go to Settings.</li>
              <li>Under "Settings for my calendars", pick your calendar.</li>
              <li>Under "Integrate calendar", copy the <strong>Secret address in iCal format</strong> and paste it below.</li>
            </>}
            {how === 'apple' && <>
              <li>In the Calendar app on a Mac, right-click the calendar and choose Share Calendar.</li>
              <li>Tick Public Calendar, copy the webcal:// link, and paste it below.</li>
            </>}
          </ol>
          <p className="text-[11px] text-slate-500">That link lets anyone holding it read your calendar, so Klippy keeps it encrypted and never shows it again.</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://outlook.office365.com/owa/calendar/.../calendar.ics"
              aria-label="Calendar link" className={`${fieldClass} flex-1`} />
            <button onClick={() => add.mutate()} disabled={url.trim().length < 8 || add.isPending} className={btnPrimary}>
              {add.isPending ? 'Reading it' : 'Connect'}
            </button>
          </div>
        </div>

        <div className="flex justify-end"><button onClick={onClose} className={btnSecondary}>Done</button></div>
      </div>
    </Modal>
  );
}
