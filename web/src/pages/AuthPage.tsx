import { useState, useEffect, type FormEvent } from 'react';
import { useAuth } from '../lib/auth';
import { apiPost } from '../lib/api';
import { SignupFlow } from './SignupFlow';

type Mode = 'login' | 'signup' | 'forgot' | 'reset' | 'twofactor' | 'invite';

export function AuthPage({ initialMode = 'login', onBack }: { initialMode?: Mode; onBack?: () => void }) {
  const { login, verify2fa } = useAuth();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [resetToken, setResetToken] = useState('');
  // The short-lived ticket a 2FA-enabled login hands back in place of a session.
  const [ticket, setTicket] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [inviteToken, setInviteToken] = useState('');

  // A password-reset link (?reset=TOKEN) drops the user straight into reset mode.
  // An invitation link (?invite=TOKEN) does the same for joining a workspace, and it
  // has to work for someone with NO workspace at all, who therefore cannot sign in
  // yet. So they prove who they are with their own email and password right here,
  // and accepting is what gives them somewhere to sign in to.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('reset');
    if (token) { setResetToken(token); setMode('reset'); return; }
    const invite = params.get('invite');
    if (invite) { setInviteToken(invite); setMode('invite'); }
  }, []);

  function clearResetParam() {
    window.history.replaceState({}, '', window.location.pathname);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null); setNotice(null); setBusy(true);
    try {
      if (mode === 'login') {
        const res = await login(email, password);
        if (res?.twoFactorRequired) { setTicket(res.ticket); setCode(''); setMode('twofactor'); }
      } else if (mode === 'twofactor') {
        await verify2fa(ticket, code);
      } else if (mode === 'forgot') {
        const res = await apiPost<{ message: string }>('/auth/forgot', { email });
        setNotice(res.message ?? 'Check your email for a reset link.');
      } else if (mode === 'invite') {
        await apiPost('/invitations/accept', { token: inviteToken, email, password });
        window.history.replaceState({}, '', window.location.pathname);
        // Straight in rather than back to a sign-in form: they have just typed these
        // exact credentials, and asking for them twice reads as a failure.
        await login(email, password);
      } else if (mode === 'reset') {
        await apiPost('/auth/reset', { token: resetToken, password });
        clearResetParam();
        setNotice('Password updated. You can sign in now.');
        setMode('login'); setPassword('');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally { setBusy(false); }
  }

  const input =
    'w-full rounded-lg bg-slate-900/70 border border-slate-700 px-3 py-2.5 text-sm ' +
    'text-slate-100 placeholder-slate-500 outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20';

  const subtitle = {
    login: 'Sign in',
    signup: 'Create your account',
    forgot: 'Reset your password',
    reset: 'Choose a new password',
    twofactor: 'Enter the code from your authenticator app',
    invite: 'Sign in with your own password to join this workspace',
  }[mode];

  // Signing up is its own short walk, one question per screen.
  if (mode === 'signup') {
    return (
      <div className="h-full overflow-y-auto px-4 py-8">
        <div className="mx-auto w-full max-w-md">
          {onBack && (
            <button onClick={onBack} className="mb-4 text-sm text-slate-400 hover:text-slate-200">&larr; Back to home</button>
          )}
          <SignupFlow onSignIn={() => { setMode('login'); setError(null); setNotice(null); }} />
        </div>
      </div>
    );
  }

  return (
    <div className="h-full grid place-items-center px-4">
      <div className="w-full max-w-sm">
        {onBack && (
          <button onClick={onBack} className="mb-4 text-sm text-slate-400 hover:text-slate-200">&larr; Back to home</button>
        )}
        <div className="mb-8 text-center">
          <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-xl bg-gradient-to-br from-violet-500 to-indigo-600 text-xl font-bold text-white shadow-lg shadow-violet-500/25">K</div>
          <h1 className="text-2xl font-semibold text-slate-100">Klippy</h1>
          <p className="mt-1 text-sm text-slate-400">{subtitle}</p>
        </div>

        <form onSubmit={submit} className="space-y-3">
          {(mode === 'login' || mode === 'signup' || mode === 'forgot' || mode === 'invite') && (
            <input className={input} type="email" placeholder="Email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          )}
          {(mode === 'login' || mode === 'signup' || mode === 'reset' || mode === 'invite') && (
            <input className={input} type="password" placeholder={mode === 'reset' ? 'New password' : 'Password'}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={(e) => setPassword(e.target.value)} required />
          )}

          {mode === 'twofactor' && (
            <input className={input} inputMode="numeric" autoComplete="one-time-code" placeholder="6-digit code"
              value={code} onChange={(e) => setCode(e.target.value)} autoFocus required />
          )}

          {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</div>}
          {notice && <div className="rounded-lg border border-green-500/30 bg-green-500/10 px-3 py-2 text-sm text-green-300">{notice}</div>}

          <button type="submit" disabled={busy} className="w-full rounded-lg bg-violet-600 py-2.5 text-sm font-medium text-[var(--accent-ink)] transition hover:bg-violet-500 disabled:opacity-60">
            {busy ? 'Please wait...'
              : mode === 'login' ? 'Sign in'
              : mode === 'twofactor' ? 'Verify'
              : mode === 'signup' ? 'Create workspace'
              : mode === 'forgot' ? 'Send reset link'
              : mode === 'invite' ? 'Accept and join'
              : 'Update password'}
          </button>
        </form>

        <div className="mt-6 space-y-1 text-center text-sm text-slate-400">
          {mode === 'login' && (
            <>
              <p><button className="text-violet-400 hover:text-violet-300" onClick={() => { setMode('forgot'); setError(null); setNotice(null); }}>Forgot password?</button></p>
              <p>New to Klippy? <button className="font-medium text-violet-400 hover:text-violet-300" onClick={() => { setMode('signup'); setError(null); setNotice(null); }}>Create an account</button></p>
            </>
          )}
          {mode === 'signup' && (
            <p>Already have one? <button className="font-medium text-violet-400 hover:text-violet-300" onClick={() => { setMode('login'); setError(null); setNotice(null); }}>Sign in</button></p>
          )}
          {mode === 'twofactor' && (
            <p><button className="font-medium text-violet-400 hover:text-violet-300" onClick={() => { setMode('login'); setTicket(''); setCode(''); setError(null); }}>Back to sign in</button></p>
          )}
          {(mode === 'forgot' || mode === 'reset') && (
            <p><button className="font-medium text-violet-400 hover:text-violet-300" onClick={() => { setMode('login'); setError(null); setNotice(null); clearResetParam(); }}>Back to sign in</button></p>
          )}
        </div>
      </div>
    </div>
  );
}
