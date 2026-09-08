import type { Network, SocialAdapter } from './types.js';
import { instagramAdapter, facebookAdapter, metaConfigured } from './adapters/meta.js';
import { linkedinAdapter, linkedinConfigured } from './adapters/linkedin.js';

/**
 * Which networks Klippy can actually publish to right now.
 *
 * One lookup, so the composer, the publisher and the accounts screen all answer the
 * question the same way. A network with no adapter, or one whose app credentials are
 * not set on this server, is NOT a broken network: it is a network whose posts get
 * handed to a person instead. Saying that clearly is what lets the calendar be useful
 * before a single platform approval lands.
 */

const ADAPTERS: Partial<Record<Network, SocialAdapter>> = {
  instagram: instagramAdapter,
  facebook: facebookAdapter,
  linkedin: linkedinAdapter,
};

export function adapterFor(network: Network): SocialAdapter | null {
  return ADAPTERS[network] ?? null;
}

/** True when this network can be published to without a person. */
export function canAutoPublish(network: Network): boolean {
  const a = ADAPTERS[network];
  return !!a && a.canPublish;
}

/** Why a network cannot autopublish, in words a person can act on. */
export function whyNotAutomatic(network: Network): string {
  if (!ADAPTERS[network]) {
    return 'Klippy cannot post to this automatically yet. Posts to it are sent to you at the scheduled time.';
  }
  if ((network === 'instagram' || network === 'facebook') && !metaConfigured()) {
    return 'The Meta app is not set up on this server yet, so posts are sent to you to put up.';
  }
  if (network === 'linkedin' && !linkedinConfigured()) {
    return 'The LinkedIn app is not set up on this server yet, so posts are sent to you to put up.';
  }
  return 'Connect an account to let Klippy post to this automatically.';
}
