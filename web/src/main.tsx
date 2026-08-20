import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './index.css';
import { AuthProvider } from './lib/auth';
import { ConfirmHost } from './components/ConfirmDialog';

/**
 * The staff app and the client portal are two applications sharing one deploy.
 * They used to share one 700kB bundle too, so a client opening a payment link
 * downloaded the whole staff tool. Each side is now its own chunk, loaded only
 * on the side of the fork that actually runs.
 */
const Root = lazy(() => import('./Root').then((m) => ({ default: m.Root })));
const PortalRoot = lazy(() => import('./portal/PortalRoot').then((m) => ({ default: m.PortalRoot })));

// Inlined from PortalRoot so deciding WHICH app to load does not load either.
function isPortalRequest(): boolean {
  const q = new URLSearchParams(window.location.search);
  return q.has('portal') || window.location.pathname.startsWith('/portal');
}
import { ErrorBoundary } from './components/ErrorBoundary';
import { OfflineBanner } from './components/OfflineBanner';
import { ThemeSync, applyAppearance, readCachedAppearance } from './lib/theme';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

// The client portal is a different application that happens to share a bundle. It
// mounts INSTEAD of Klippy, outside AuthProvider, so it never asks who the staff
// user is and a client never sees a trace of the tool behind their supplier.
const portal = isPortalRequest();

if (!portal) {
  // Paint in the remembered theme immediately, before /me resolves. The portal is
  // always light and takes its colour from the business instead.
  const cached = readCachedAppearance();
  applyAppearance(cached.theme, cached.accent);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {portal ? (
        <ErrorBoundary portal>
          <Suspense fallback={null}><PortalRoot /></Suspense>
        </ErrorBoundary>
      ) : (
        <ErrorBoundary>
          <AuthProvider>
            <ThemeSync />
            <Suspense fallback={null}><Root /></Suspense>
          </AuthProvider>
        </ErrorBoundary>
      )}
      {/* Mounted for both apps: a client deleting nothing still gets asked the same
          way, and confirmDialog falls back to the browser if this is ever missing. */}
      <ConfirmHost />
      <OfflineBanner />
    </QueryClientProvider>
  </StrictMode>,
);

// Register the service worker (makes Klippy installable + enables push).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* non-fatal */ });
  });
}
