import { NETWORK_META, type SocialNetwork } from '../lib/socialTypes';

/**
 * Which network, in two letters.
 *
 * A badge rather than a brand icon: lucide removed the brand marks, and a component
 * that renders nothing when a dependency drops an export is a component that breaks
 * silently. Letters in the network's colour also read at calendar-card size, which a
 * ten-pixel logo does not.
 */
export function NetworkBadge({ network, size = 'sm' }: { network: SocialNetwork; size?: 'sm' | 'md' }) {
  const m = NETWORK_META[network];
  return (
    <span
      title={m.label}
      className={`inline-flex items-center justify-center rounded border font-medium ${m.tint} ${
        size === 'sm' ? 'h-4 min-w-[1.1rem] px-0.5 text-[9px]' : 'h-6 min-w-[1.6rem] px-1.5 text-[11px]'}`}>
      {m.short}
    </span>
  );
}
