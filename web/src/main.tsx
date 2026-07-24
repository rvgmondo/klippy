import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './index.css';
import { AuthProvider } from './lib/auth';
import { Root } from './Root';
import { ThemeSync, applyAppearance, readCachedAppearance } from './lib/theme';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

// Paint in the remembered theme immediately, before /me resolves.
const cached = readCachedAppearance();
applyAppearance(cached.theme, cached.accent);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ThemeSync />
        <Root />
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
