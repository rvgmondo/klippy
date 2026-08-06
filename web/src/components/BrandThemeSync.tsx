import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../lib/api';
import { applyBrandTheme } from '../lib/brandTheme';
import { useAuth } from '../lib/auth';
import type { Business } from '../lib/types';
import type { BusinessSelection } from './BusinessSwitcher';

/**
 * Skins Klippy in the focused business's brand colour.
 *
 * Working "in" a business should feel like working in that business, not in a
 * generic tool, so its brand drives the whole accent ramp and not just its
 * invoices. Viewing all businesses hands the colour back to the person's own
 * accent, since no single brand owns that view.
 */
export function BrandThemeSync({ businessId }: { businessId: BusinessSelection }) {
  const { user } = useAuth();
  const { data } = useQuery({
    queryKey: ['businesses'],
    queryFn: () => apiGet<{ businesses: Business[] }>('/businesses'),
  });

  const focused = businessId === 'all' ? undefined : data?.businesses.find((b) => b.id === businessId);
  const brand = focused?.invoiceAccent ?? null;
  // The person's own theme choice re-derives the ramp, since the readable shades
  // differ between dark and light mode.
  const mode = user?.theme ?? 'dark';

  useEffect(() => {
    applyBrandTheme(brand);
    return () => applyBrandTheme(null);
  }, [brand, mode]);

  return null;
}
