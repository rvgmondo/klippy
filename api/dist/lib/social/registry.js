import { instagramAdapter, facebookAdapter, metaConfigured } from './adapters/meta.js';
/**
 * Which networks Klippy can actually publish to right now.
 *
 * One lookup, so the composer, the publisher and the accounts screen all answer the
 * question the same way. A network with no adapter, or one whose app credentials are
 * not set on this server, is NOT a broken network: it is a network whose posts get
 * handed to a person instead. Saying that clearly is what lets the calendar be useful
 * before a single platform approval lands.
 */
const ADAPTERS = {
    instagram: instagramAdapter,
    facebook: facebookAdapter,
    // LinkedIn arrives in phase 4. Until then its posts take the manual path, which is
    // the same path they would take anyway while the Community Management API approval
    // is pending, so nothing about the plan changes when it lands.
};
export function adapterFor(network) {
    return ADAPTERS[network] ?? null;
}
/** True when this network can be published to without a person. */
export function canAutoPublish(network) {
    const a = ADAPTERS[network];
    return !!a && a.canPublish;
}
/** Why a network cannot autopublish, in words a person can act on. */
export function whyNotAutomatic(network) {
    if (!ADAPTERS[network]) {
        return 'Klippy cannot post to this automatically yet. Posts to it are sent to you at the scheduled time.';
    }
    if (!metaConfigured()) {
        return 'The Meta app is not set up on this server yet, so posts are sent to you to put up.';
    }
    return 'Connect an account to let Klippy post to this automatically.';
}
//# sourceMappingURL=registry.js.map