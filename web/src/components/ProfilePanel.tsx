import { useState, type FormEvent } from 'react';
import { apiPatch } from '../lib/api';
import { pushSupported, enablePush, disablePush, currentSubscription, sendTestPush } from '../lib/push';
import { useEffect } from 'react';
import { useAuth } from '../lib/auth';

export function ProfilePanel() {
  const { user, account, refresh } = useAuth();
  const [name, setName] = useState(user?.name ?? '');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [digest, setDigest] = useState(user?.dailyDigest ?? true);

  const field = 'w-full rounded-lg bg-slate-900/70 border border-slate-700 px-3 py-2.5 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-violet-500';

  async function saveName(e: FormEvent) {
    e.preventDefault();
    setMsg(null); setBusy(true);
    try {
      await apiPatch('/profile', { name: name.trim() });
      await refresh();
      setMsg({ kind: 'ok', text: 'Name updated.' });
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Could not save.' });
    } finally { setBusy(false); }
  }

  async function savePassword(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (next !== confirm) { setMsg({ kind: 'err', text: 'The new passwords do not match.' }); return; }
    setBusy(true);
    try {
      await apiPatch('/profile', { currentPassword: current, newPassword: next });
      setCurrent(''); setNext(''); setConfirm('');
      setMsg({ kind: 'ok', text: 'Password changed.' });
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Could not change password.' });
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-400">
        Signed in as <span className="text-slate-200">{user?.email}</span> ({user?.role}) in {account?.name}
      </div>

      {msg && (
        <div className={`rounded-lg border px-3 py-2 text-sm ${msg.kind === 'ok'
          ? 'border-green-500/30 bg-green-500/10 text-green-300'
          : 'border-red-500/30 bg-red-500/10 text-red-300'}`}>{msg.text}</div>
      )}

      <form onSubmit={saveName} className="space-y-2">
        <label className="block text-xs font-medium text-slate-400">Your name</label>
        <input className={field} value={name} onChange={(e) => setName(e.target.value)} />
        <button type="submit" disabled={busy || !name.trim()}
          className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-60">
          Save name
        </button>
      </form>

      <div className="border-t border-slate-800 pt-5">
        <label className="flex cursor-pointer items-start gap-3">
          <input type="checkbox" className="mt-0.5 h-4 w-4 accent-violet-600"
            checked={digest}
            onChange={async (e) => {
              const v = e.target.checked;
              setDigest(v);
              try { await apiPatch('/profile', { dailyDigest: v }); }
              catch { setDigest(!v); setMsg({ kind: 'err', text: 'Could not save that.' }); }
            }} />
          <span>
            <span className="block text-sm text-slate-200">Morning digest email</span>
            <span className="block text-[11px] text-slate-500">
              A daily email listing what is due today and what is overdue. Only sent when there is something to report.
            </span>
          </span>
        </label>
      </div>

      <NotificationsToggle />

      <form onSubmit={savePassword} className="space-y-2 border-t border-slate-800 pt-5">
        <label className="block text-xs font-medium text-slate-400">Change password</label>
        <input className={field} type="password" placeholder="Current password" autoComplete="current-password"
          value={current} onChange={(e) => setCurrent(e.target.value)} />
        <input className={field} type="password" placeholder="New password (min 8 characters)" autoComplete="new-password"
          value={next} onChange={(e) => setNext(e.target.value)} />
        <input className={field} type="password" placeholder="Confirm new password" autoComplete="new-password"
          value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        <button type="submit" disabled={busy || !current || next.length < 8}
          className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-60">
          Change password
        </button>
      </form>
    </div>
  );
}

function NotificationsToggle() {
  const [supported] = useState(pushSupported());
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => { currentSubscription().then((s) => setOn(!!s)); }, []);

  async function toggle(next: boolean) {
    setBusy(true); setMsg(null);
    try {
      if (next) {
        const r = await enablePush();
        if (!r.ok) { setMsg(r.error ?? 'Could not enable.'); setOn(false); }
        else { setOn(true); setMsg('Notifications on for this device.'); }
      } else {
        await disablePush(); setOn(false); setMsg('Turned off for this device.');
      }
    } finally { setBusy(false); }
  }

  return (
    <div className="border-t border-slate-800 pt-5">
      <div className="mb-1 text-sm text-slate-200">Push notifications</div>
      {!supported ? (
        <p className="text-[11px] text-slate-500">
          This browser cannot do push notifications. On iPhone, add Klippy to your Home Screen first, then enable them from there.
        </p>
      ) : (
        <>
          <label className="flex cursor-pointer items-start gap-3">
            <input type="checkbox" className="mt-0.5 h-4 w-4 accent-violet-600" checked={on} disabled={busy}
              onChange={(e) => toggle(e.target.checked)} />
            <span>
              <span className="block text-sm text-slate-300">Notify me on this device</span>
              <span className="block text-[11px] text-slate-500">
                When a card is assigned to you or someone comments on your card. Per device, so enable it on each one.
              </span>
            </span>
          </label>
          {on && (
            <button onClick={() => sendTestPush()} className="mt-2 rounded-lg border border-slate-700 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-800">
              Send a test
            </button>
          )}
          {msg && <p className="mt-2 text-[11px] text-slate-400">{msg}</p>}
        </>
      )}
    </div>
  );
}
