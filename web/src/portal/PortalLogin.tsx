import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { apiPost } from '../lib/api';

/**
 * Signing in.
 *
 * The emailed link leads, because it is the one that always works: nothing to
 * remember, nothing to reset. The password form is there for people who have set
 * one and would rather not wait for mail, but it is deliberately the second thing
 * offered rather than the default.
 *
 * There is no branding on this screen and there cannot be: until someone signs in
 * we do not know which business's portal they are trying to reach, and guessing
 * from the address bar would leak which businesses exist.
 */
export function PortalLogin({ error, onSignedIn }: { error?: string; onSignedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'link' | 'password'>('link');
  const [sent, setSent] = useState('');
  const [failed, setFailed] = useState('');

  const requestLink = useMutation({
    mutationFn: () => apiPost<{ message: string }>('/portal/login', { email }),
    onSuccess: (r) => { setFailed(''); setSent(r.message); },
    onError: (e) => setFailed(e instanceof Error ? e.message : 'Something went wrong.'),
  });

  const signIn = useMutation({
    mutationFn: () => apiPost('/portal/password-login', { email, password }),
    onSuccess: () => { setFailed(''); onSignedIn(); },
    onError: (e) => setFailed(e instanceof Error ? e.message : 'Could not sign you in.'),
  });

  const field = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-slate-500';

  return (
    <div className="grid min-h-screen place-items-center bg-slate-50 px-4">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-lg font-semibold text-slate-900">Your account</h1>
        <p className="mb-6 text-sm text-slate-500">
          See your invoices and quotes, and settle anything outstanding.
        </p>

        {(error || failed) && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">
            {error || failed}
          </div>
        )}

        {sent ? (
          <div className="rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-800">
            {sent}
            <button onClick={() => { setSent(''); }}
              className="mt-2 block text-xs text-green-700 underline">
              Use a different address
            </button>
          </div>
        ) : (
          <form onSubmit={(e) => {
            e.preventDefault();
            if (mode === 'link') requestLink.mutate(); else signIn.mutate();
          }}>
            <label className="mb-1 block text-xs font-medium text-slate-600">Email address</label>
            <input type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)}
              className={field} placeholder="you@company.co.za" />

            {mode === 'password' && (
              <>
                <label className="mb-1 mt-3 block text-xs font-medium text-slate-600">Password</label>
                <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)}
                  className={field} />
              </>
            )}

            <button type="submit" disabled={requestLink.isPending || signIn.isPending}
              className="mt-4 w-full rounded-lg px-4 py-2.5 text-sm font-medium text-white disabled:opacity-60"
              style={{ background: 'var(--portal-accent, #0f172a)' }}>
              {requestLink.isPending || signIn.isPending
                ? 'Just a moment...'
                : mode === 'link' ? 'Email me a sign-in link' : 'Sign in'}
            </button>

            <button type="button"
              onClick={() => { setMode(mode === 'link' ? 'password' : 'link'); setFailed(''); }}
              className="mt-3 w-full text-center text-xs text-slate-500 underline hover:text-slate-700">
              {mode === 'link' ? 'I have a password' : 'Email me a link instead'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
