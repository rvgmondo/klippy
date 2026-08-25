import { Suspense, lazy, useState } from 'react';
import { useAuth } from './lib/auth';
import { AuthPage } from './pages/AuthPage';
import { Workspace } from './pages/Workspace';
/**
 * The public page is its own chunk. It carries the marketing motion stack (GSAP,
 * Lenis) and a WebGL hero, none of which a signed-in founder should ever
 * download to look at their invoices. Statically imported, all of it landed in
 * the main app bundle.
 */
const LandingPage = lazy(() => import('./pages/LandingPage').then((m) => ({ default: m.LandingPage })));

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

  return (
    <Suspense fallback={<div className="h-full bg-[#0e1013]" />}>
      <LandingPage onGetStarted={() => setAuth('signup')} onLogin={() => setAuth('login')} />
    </Suspense>
  );
}
