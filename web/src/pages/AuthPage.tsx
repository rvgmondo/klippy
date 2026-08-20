import { useState, useEffect, type FormEvent } from 'react';
import { useAuth } from '../lib/auth';
import { apiPost } from '../lib/api';

type Mode = 'login' | 'signup' | 'forgot' | 'reset';

export function AuthPage({ initialMode = 'login', onBack }: { initialMode?: Mode; onBack?: () => void }) {
  const { login, signup } = useAuth();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [accountName, setAccountName] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [resetToken, setResetToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A password-reset link (?reset=TOKEN) drops the user straight into reset mode.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('reset');
    if (token) { setResetToken(token); setMode('reset'); }
  }, []);

  function clearResetParam() {
    window.history.replaceState({}, '', window.location.pathname);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null); setNotice(null); setBusy(true);
    try {
      if (mode === 'login') await login(email, password);
      else if (mode === 'signup') await signup(accountName, name, email, password);
      else if (mode === 'forgot') {
        const res = await apiPost<{ message: string }>('/auth/forgot', { email });
        setNotice(res.message ?? 'Check your email for a reset link.');
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
    login: 'Sign in to your workspace',
    signup: 'Create your workspace',
    forgot: 'Reset your password',
    reset: 'Choose a new password',
  }[mode];

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
          {mode === 'signup' && (
            <>
              <input className={input} placeholder="Your business name (e.g. Mondobase)" value={accountName} onChange={(e) => setAccountName(e.target.value)} required />
              <input className={input} placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} required />
            </>
          )}
          {(mode === 'login' || mode === 'signup' || mode === 'forgot') && (
            <input className={input} type="email" placeholder="Email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          )}
          {(mode === 'login' || mode === 'signup' || mode === 'reset') && (
            <input className={input} type="password" placeholder={mode === 'reset' ? 'New password' : 'Password'}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={(e) => setPassword(e.target.value)} required />
          )}

          {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</div>}
          {notice && <div className="rounded-lg border border-green-500/30 bg-green-500/10 px-3 py-2 text-sm text-green-300">{notice}</div>}

          <button type="submit" disabled={busy} className="w-full rounded-lg bg-violet-600 py-2.5 text-sm font-medium text-[var(--accent-ink)] transition hover:bg-violet-500 disabled:opacity-60">
            {busy ? 'Please wait...'
              : mode === 'login' ? 'Sign in'
              : mode === 'signup' ? 'Create workspace'
              : mode === 'forgot' ? 'Send reset link'
              : 'Update password'}
          </button>
        </form>

        <div className="mt-6 space-y-1 text-center text-sm text-slate-400">
          {mode === 'login' && (
            <>
              <p><button className="text-violet-400 hover:text-violet-300" onClick={() => { setMode('forgot'); setError(null); setNotice(null); }}>Forgot password?</button></p>
              <p>Don't have a workspace? <button className="font-medium text-violet-400 hover:text-violet-300" onClick={() => { setMode('signup'); setError(null); setNotice(null); }}>Create one</button></p>
            </>
          )}
          {mode === 'signup' && (
            <p>Already have one? <button className="font-medium text-violet-400 hover:text-violet-300" onClick={() => { setMode('login'); setError(null); setNotice(null); }}>Sign in</button></p>
          )}
          {(mode === 'forgot' || mode === 'reset') && (
            <p><button className="font-medium text-violet-400 hover:text-violet-300" onClick={() => { setMode('login'); setError(null); setNotice(null); clearResetParam(); }}>Back to sign in</button></p>
          )}
        </div>
      </div>
    </div>
  );
}
