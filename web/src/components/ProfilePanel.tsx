import { useState, type FormEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPatch, apiPost } from '../lib/api';
import { pushSupported, enablePush, disablePush, currentSubscription, sendTestPush } from '../lib/push';
import { useEffect } from 'react';
import { useAuth } from '../lib/auth';
import { notify } from './ConfirmDialog';
import { fieldClass } from './ui';

export function ProfilePanel() {
  const { user, account, refresh } = useAuth();
  const [name, setName] = useState(user?.name ?? '');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [digest, setDigest] = useState(user?.dailyDigest ?? true);

  const field = fieldClass;

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
          className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-[var(--accent-ink)] hover:bg-violet-500 disabled:opacity-60">
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
          className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-[var(--accent-ink)] hover:bg-violet-500 disabled:opacity-60">
          Change password
        </button>
        <p className="text-[11px] text-slate-500">Changing your password signs you out everywhere else.</p>
      </form>

      <TwoFactorSection />
      <SessionsSection />
    </div>
  );
}

/**
 * TOTP two-factor. Setup stores the secret server-side but nothing turns on
 * until a real code from the app checks out, so a half-finished setup can never
 * lock anyone out. Any authenticator app works: Google Authenticator, Authy,
 * 1Password, Aegis.
 */
function TwoFactorSection() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['2fa'],
    queryFn: () => apiGet<{ enabled: boolean; pending: boolean }>('/auth/2fa'),
  });
  const [setup, setSetup] = useState<{ secret: string; otpauth: string } | null>(null);
  const [codeIn, setCodeIn] = useState('');
  const [disabling, setDisabling] = useState(false);

  const start = useMutation({
    mutationFn: () => apiPost<{ secret: string; otpauth: string }>('/auth/2fa/setup', {}),
    onSuccess: (r) => { setSetup(r); setCodeIn(''); },
    onError: (e) => notify(e instanceof Error ? e.message : 'Could not start setup.', 'error'),
  });
  const enable = useMutation({
    mutationFn: () => apiPost('/auth/2fa/enable', { code: codeIn }),
    onSuccess: () => {
      setSetup(null); setCodeIn('');
      qc.invalidateQueries({ queryKey: ['2fa'] });
      notify('Two-factor is on. You will be asked for a code at every sign-in.');
    },
    onError: (e) => notify(e instanceof Error ? e.message : 'That code did not work.', 'error'),
  });
  const disable = useMutation({
    mutationFn: () => apiPost('/auth/2fa/disable', { code: codeIn }),
    onSuccess: () => {
      setDisabling(false); setCodeIn('');
      qc.invalidateQueries({ queryKey: ['2fa'] });
      notify('Two-factor is off.');
    },
    onError: (e) => notify(e instanceof Error ? e.message : 'That code did not work.', 'error'),
  });

  const field = fieldClass;

  return (
    <div className="border-t border-slate-800 pt-5">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-sm text-slate-200">Two-factor authentication</span>
        {data?.enabled && (
          <span className="rounded bg-green-500/15 px-1.5 py-0.5 text-[10px] font-medium text-green-300">On</span>
        )}
      </div>
      <p className="mb-3 text-[11px] text-slate-500">
        A 6-digit code from your phone at every sign-in, so a stolen password alone is not enough.
      </p>

      {!data?.enabled && !setup && (
        <button onClick={() => start.mutate()} disabled={start.isPending}
          className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-50">
          Turn on two-factor
        </button>
      )}

      {setup && (
        <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/40 p-4">
          <p className="text-xs text-slate-400">
            1. In your authenticator app, add an account and enter this key (or open the link on your phone):
          </p>
          <code className="block break-all rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-xs tracking-wider text-slate-200">{setup.secret}</code>
          <a href={setup.otpauth} className="inline-block text-xs text-violet-400 hover:text-violet-300">Open in authenticator app</a>
          <p className="text-xs text-slate-400">2. Then enter the code it shows, to prove the app is set up:</p>
          <div className="flex gap-2">
            <input className={field} inputMode="numeric" autoComplete="one-time-code" placeholder="6-digit code"
              value={codeIn} onChange={(e) => setCodeIn(e.target.value)} />
            <button onClick={() => enable.mutate()} disabled={enable.isPending || codeIn.trim().length < 6}
              className="shrink-0 rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-[var(--accent-ink)] hover:bg-violet-500 disabled:opacity-60">
              Confirm
            </button>
          </div>
          <button onClick={() => { setSetup(null); setCodeIn(''); }} className="text-xs text-slate-500 hover:text-slate-300">Cancel</button>
        </div>
      )}

      {data?.enabled && !disabling && (
        <button onClick={() => { setDisabling(true); setCodeIn(''); }}
          className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800">
          Turn off
        </button>
      )}
      {data?.enabled && disabling && (
        <div className="flex gap-2">
          <input className={field} inputMode="numeric" autoComplete="one-time-code" placeholder="Current 6-digit code"
            value={codeIn} onChange={(e) => setCodeIn(e.target.value)} />
          <button onClick={() => disable.mutate()} disabled={disable.isPending || codeIn.trim().length < 6}
            className="shrink-0 rounded-lg border border-red-500/40 px-4 py-2 text-sm text-red-300 hover:bg-red-500/10 disabled:opacity-50">
            Turn off
          </button>
          <button onClick={() => { setDisabling(false); setCodeIn(''); }}
            className="shrink-0 rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-400 hover:bg-slate-800">
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

/** One button that kills every other session: other browsers, other machines. */
function SessionsSection() {
  const out = useMutation({
    mutationFn: () => apiPost('/auth/logout-all', {}),
    onSuccess: () => notify('Done. Every other device is signed out; this one stays in.'),
    onError: (e) => notify(e instanceof Error ? e.message : 'Could not do that.', 'error'),
  });
  return (
    <div className="border-t border-slate-800 pt-5">
      <div className="mb-1 text-sm text-slate-200">Sessions</div>
      <p className="mb-3 text-[11px] text-slate-500">
        Left yourself signed in on a shared machine, or lost a laptop? This signs out every session except this one.
      </p>
      <button onClick={() => out.mutate()} disabled={out.isPending}
        className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-50">
        Sign out everywhere else
      </button>
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
