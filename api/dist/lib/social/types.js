/**
 * The shapes every network adapter shares.
 *
 * Adapters are pure API clients: they take credentials and data, they call the
 * platform, they return a result. No database access, so an adapter can be reasoned
 * about and tested without a tenant, and a bug in one cannot corrupt another's rows.
 *
 * Every method that touches a documented rule cites its row id in
 * docs/social/API-NOTES.md, so when a platform changes something there is one place
 * to check and one place to fix.
 */
export const NETWORKS = ['instagram', 'facebook', 'linkedin'];
export const NETWORK_LABEL = {
    instagram: 'Instagram',
    facebook: 'Facebook',
    linkedin: 'LinkedIn',
};
/**
 * What went wrong, in a form the publisher can act on without knowing the network.
 *
 * `retryable` is the only thing the cron actually branches on, and getting it wrong
 * is expensive in both directions: retrying a permanent failure burns quota and looks
 * broken, while giving up on a transient one silently drops a client's post.
 */
export class SocialApiError extends Error {
    retryable;
    network;
    code;
    detail;
    constructor(network, message, opts) {
        super(message);
        this.name = 'SocialApiError';
        this.network = network;
        this.retryable = opts.retryable;
        this.code = opts.code ?? null;
        this.detail = opts.detail;
    }
}
/**
 * Dry run: log the exact request an adapter would send and return a fake id.
 *
 * On for the first production week by design. Publishing is the one thing in Klippy
 * that cannot be undone: a post that goes out to a client's audience by mistake
 * cannot be recalled, and "it was a test" is not a thing the audience sees.
 */
export const dryRun = () => process.env.SOCIAL_DRY_RUN === '1';
//# sourceMappingURL=types.js.map