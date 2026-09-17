import { useQuery } from '@tanstack/react-query';
import { apiGet } from './api';
import type { Business } from './types';
import type { BusinessSelection } from '../components/BusinessSwitcher';

/**
 * The business a create button acts for, or null when there is no single answer.
 *
 * "All businesses" is where every browser starts: first sign-in, a new phone, the
 * installed app, a private window. For a workspace with ONE business that is not a
 * choice anyone made, yet New post, Add a sale, Connect, Add one and Lead form all hid
 * themselves and asked the owner to "pick one business above" from a list of one. So a
 * lone business counts as selected here, the same rule the task form on Home already
 * used.
 *
 * Only for acting. Lists and totals keep using the raw selection, so what "All
 * businesses" adds up to does not change.
 *
 * A selected id is checked against the workspace's own businesses. Switching workspace
 * does not clear a remembered selection, and an id from the previous workspace would
 * otherwise keep every create button showing for a business that is not here.
 *
 * `loading` is true until the list has arrived. Screens hide both the button AND the
 * "pick one business" note until then, so a one-business owner is not told to pick a
 * business for the half second before their button appears.
 */
export function useActingBusiness(selection: BusinessSelection): { id: number | null; loading: boolean } {
  const { data, isLoading } = useQuery({
    queryKey: ['businesses'],
    queryFn: () => apiGet<{ businesses: Business[] }>('/businesses'),
    staleTime: 60_000,
  });
  if (!data) return { id: null, loading: isLoading };
  const list = data.businesses;
  if (selection === 'all') return { id: list.length === 1 ? list[0]!.id : null, loading: false };
  return { id: list.some((b) => b.id === selection) ? selection : null, loading: false };
}
