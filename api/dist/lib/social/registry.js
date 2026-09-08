import { instagramAdapter, facebookAdapter } from './adapters/meta.js';
import { linkedinAdapter } from './adapters/linkedin.js';
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
    linkedin: linkedinAdapter,
};
export function adapterFor(network) {
    return ADAPTERS[network] ?? null;
}
/** True when this network can be published to without a person. */
export function canAutoPublish(network) {
    const a = ADAPTERS[network];
    return !!a && a.canPublish;
}
/**
 * Why a network cannot post by itself, in words a person can act on.
 *
 * Two genuinely different reasons, and conflating them sends someone to the wrong
 * screen: either Klippy has no app to log in through, which is a settings problem, or
 * nothing has been connected, which is a Connect problem.
 */
export function whyNotAutomatic(network, opts = { canConnect: false }) {
    if (!ADAPTERS[network]) {
        return 'Klippy cannot post to this automatically yet. Posts to it are sent to you at the scheduled time.';
    }
    if (!opts.canConnect) {
        return network === 'linkedin'
            ? 'Add your LinkedIn app details below and you can connect a Page.'
            : 'Add your Meta app details below and you can connect a Page and its Instagram account.';
    }
    return 'Connect an account to let Klippy post to this automatically.';
}
//# sourceMappingURL=registry.js.map