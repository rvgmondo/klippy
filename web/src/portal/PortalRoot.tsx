import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, ApiError } from '../lib/api';
import { usePageTitle, useNoIndex } from '../lib/publicPage';
import { PortalLogin } from './PortalLogin';
import { PortalApp } from './PortalApp';

export interface PortalMe {
  /** True when a staff member is looking, not the client. Read-only. */
  preview?: boolean;
  user: { name: string | null; email: string; hasPassword: boolean };
  client: { name: string; billingEmail: string | null; phone?: string | null; vatNumber: string | null; address: string | null };
  brand: {
    name: string; accent: string;
    fontDisplay: string | null; fontBody: string | null; hasLogo: boolean;
  };
}

/** Is this request for the client portal rather than the Klippy app? */
export function isPortalRequest(): boolean {
  const q = new URLSearchParams(window.location.search);
  return q.has('portal') || window.location.pathname.startsWith('/portal');
}

/**
 * The client portal shell.
 *
 * Mounted instead of the Klippy app, not inside it, so it never asks who the staff
 * user is and never shows a scrap of Klippy's own chrome. A client is visiting the
 * business they buy from; as far as they are concerned this software has no name.
 *
 * Light, on purpose. The app is dark because it is a tool someone stares at all
 * day; this is a page a customer opens twice a month to settle an invoice, and it
 * should read like the business's own website.
 */
export function PortalRoot() {
  const qc = useQueryClient();
  const [entering, setEntering] = useState(false);
  const [enterError, setEnterError] = useState('');

  const { data, isLoading, refetch } = useQuery<PortalMe | null>({
    queryKey: ['portal-me'],
    queryFn: async () => {
      try {
        return await apiGet<PortalMe>('/portal/me');
      } catch (e) {
        // 401 is the ordinary "not signed in" case, not a failure worth showing.
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    retry: false,
  });

  // A sign-in link lands here. Spend it, then scrub the token out of the address
  // bar so it is not left sitting in history or copied into a support email.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const token = q.get('token');
    if (!token || q.get('portal') !== 'enter') return;
    setEntering(true);
    apiPost('/portal/enter', { token })
      .then(() => {
        window.history.replaceState({}, '', '/?portal=1');
        return qc.invalidateQueries({ queryKey: ['portal-me'] });
      })
      .catch((e) => setEnterError(e instanceof Error ? e.message : 'That link did not work.'))
      .finally(() => setEntering(false));
  }, [qc]);

  // Paint the business's colour into the page, so every button and link below
  // belongs to them rather than to us.
  useEffect(() => {
    if (!data?.brand.accent) return;
    document.documentElement.style.setProperty('--portal-accent', data.brand.accent);
  }, [data?.brand.accent]);

  /**
   * The tab, which was still saying Klippy.
   *
   * Signed in, it is the supplier's name, matching the header. Before that it is the
   * neutral wording the sign-in screen already uses, and it CANNOT be the brand name:
   * until someone signs in we do not know whose portal this is, and guessing from the
   * address bar would leak which businesses exist. Same reason that screen carries no
   * logo.
   */
  usePageTitle(data?.brand.name || 'Your account');
  useNoIndex();

  if (isLoading || entering) {
    return (
      <div className="grid min-h-screen place-items-center bg-slate-50 text-slate-500">
        <p className="animate-pulse text-sm">{entering ? 'Signing you in...' : 'Loading...'}</p>
      </div>
    );
  }

  if (!data) return <PortalLogin error={enterError} onSignedIn={() => refetch()} />;
  return <PortalApp me={data} onSignedOut={() => refetch()} />;
}
