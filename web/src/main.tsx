import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './index.css';
import { AuthProvider } from './lib/auth';
import { Root } from './Root';
import { PortalRoot, isPortalRequest } from './portal/PortalRoot';
import { ConfirmHost } from './components/ConfirmDialog';
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
        <ErrorBoundary portal><PortalRoot /></ErrorBoundary>
      ) : (
        <ErrorBoundary>
          <AuthProvider>
            <ThemeSync />
            <Root />
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
