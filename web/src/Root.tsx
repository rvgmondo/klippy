import { useAuth } from './lib/auth';
import { AuthPage } from './pages/AuthPage';
import { Workspace } from './pages/Workspace';

export function Root() {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="h-full grid place-items-center text-slate-500">
        <div className="animate-pulse text-sm">Loading Klippy...</div>
      </div>
    );
  }
  return user ? <Workspace /> : <AuthPage />;
}
