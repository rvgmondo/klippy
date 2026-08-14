import { useQuery } from '@tanstack/react-query';
import { apiGet } from './api';
import { useAuth } from './auth';
import type { Business } from './types';
import type { CurrencyOption } from './money';

/**
 * What the screen you are looking at is denominated in.
 *
 * Same rule as the server's `currencyFor`: the business decides, and falls back to
 * the workspace. Kept in one hook so a view never has to reach for
 * `account.currency` directly, which is how two screens ended up hardcoding rand.
 *
 * With "all businesses" selected there is no single right answer, so it returns the
 * workspace currency. Views that show a TOTAL across businesses must not rely on
 * that: the server sends those broken down per currency, and adding them up is
 * exactly the mistake this whole change exists to stop.
 */
export function useCurrency(businessId: number | 'all' | null | undefined): string {
  const { account } = useAuth();
  const { data } = useQuery({
    queryKey: ['businesses'],
    queryFn: () => apiGet<{ businesses: Business[] }>('/businesses'),
    staleTime: 60_000,
  });
  const fallback = account?.currency || 'ZAR';
  if (businessId == null || businessId === 'all') return fallback;
  return data?.businesses.find((b) => b.id === businessId)?.currency || fallback;
}

/** The currencies on offer, from the server so there is only ever one list. */
export function useCurrencyOptions() {
  const { data } = useQuery({
    queryKey: ['currencies'],
    queryFn: () => apiGet<{ currencies: CurrencyOption[] }>('/currencies'),
    staleTime: Infinity,
  });
  return data?.currencies ?? [];
}
