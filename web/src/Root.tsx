import { useState } from 'react';
import { useAuth } from './lib/auth';
import { AuthPage } from './pages/AuthPage';
import { Workspace } from './pages/Workspace';
import { LandingPage } from './pages/LandingPage';

export function Root() {
  const { user, loading } = useAuth();
  // Not-logged-in visitors see the landing page first, unless they arrive on a
  // password-reset link, in which case go straight to the auth screen.
  const hasResetToken = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('reset');
  const [auth, setAuth] = useState<null | 'login' | 'signup'>(hasResetToken ? 'login' : null);

  if (loading) {
    return (
      <div className="h-full grid place-items-center text-slate-500">
        <div className="animate-pulse text-sm">Loading Klippy...</div>
      </div>
    );
  }

  if (user) return <Workspace />;

  if (auth || hasResetToken) {
    return <AuthPage initialMode={auth ?? 'login'} onBack={() => setAuth(null)} />;
  }

  return <LandingPage onGetStarted={() => setAuth('signup')} onLogin={() => setAuth('login')} />;
}
