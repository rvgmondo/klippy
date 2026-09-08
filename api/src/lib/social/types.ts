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

export type Network = 'instagram' | 'facebook' | 'linkedin';

export const NETWORKS: Network[] = ['instagram', 'facebook', 'linkedin'];

export const NETWORK_LABEL: Record<Network, string> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  linkedin: 'LinkedIn',
};

export type PostType = 'post' | 'carousel' | 'reel' | 'story';

/** One media item, as publishing needs to see it. */
export interface MediaItem {
  id: number;
  position: number;
  mimeType: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  bytes: number | null;
  altText: string | null;
  /** The public URL Meta will fetch from. Null when no public base is configured. */
  publicUrl: string | null;
  /**
   * Where the bytes actually live.
   *
   * Carried alongside the URL because the two networks want opposite things: Meta
   * fetches from a URL and never sees the file, while LinkedIn refuses URLs entirely
   * and needs the bytes streamed to an upload endpoint. Handing both to every adapter
   * is simpler than a second publish path for the one network that differs.
   */
  storageKey: string | null;
}

/** What a post looks like to an adapter, with nothing tenant-shaped attached. */
export interface PublishablePost {
  id: number;
  title: string;
  caption: string;
  firstComment: string | null;
  postType: PostType;
}

/**
 * A validation failure a person can act on.
 *
 * `field` names the thing on the composer that is wrong, so the message can be shown
 * against it rather than in a general error box, and `network` says which target
 * complained. One media file too tall for Instagram must not read as "the post is
 * broken", because it is fine for the other two.
 */
export interface ValidationIssue {
  network: Network;
  field: 'caption' | 'firstComment' | 'media' | 'postType' | 'account' | 'schedule';
  message: string;
  /** The API-NOTES row this rule comes from, so the rule can be traced. */
  rule?: string;
  /** A warning does not block scheduling; an error does. */
  severity: 'error' | 'warning';
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

export interface PublishResult {
  externalPostId: string;
  permalink: string | null;
}

/**
 * What went wrong, in a form the publisher can act on without knowing the network.
 *
 * `retryable` is the only thing the cron actually branches on, and getting it wrong
 * is expensive in both directions: retrying a permanent failure burns quota and looks
 * broken, while giving up on a transient one silently drops a client's post.
 */
export class SocialApiError extends Error {
  readonly retryable: boolean;
  readonly network: Network;
  readonly code: string | null;
  readonly detail: unknown;

  constructor(network: Network, message: string, opts: { retryable: boolean; code?: string | null; detail?: unknown }) {
    super(message);
    this.name = 'SocialApiError';
    this.network = network;
    this.retryable = opts.retryable;
    this.code = opts.code ?? null;
    this.detail = opts.detail;
  }
}

export interface ConnectedAccount {
  /**
   * Which network this one is.
   *
   * Carried explicitly because ONE Meta connection returns both a Page and the
   * Instagram account linked to it. Inferring it at the call site, from a display
   * name or from whether a token came back, is the kind of guess that files an
   * Instagram account as a Facebook Page and then fails at publish time.
   */
  network: Network;
  externalId: string;
  displayName: string;
  avatarUrl: string | null;
  /** Some networks hand back a per-asset token (a Page token) rather than reusing the user's. */
  accountToken?: string;
}

export interface AdapterCredentials {
  accessToken: string;
  refreshToken: string | null;
  externalId: string;
}

export interface SocialAdapter {
  network: Network;
  /**
   * Whether Klippy can publish to this network without a person.
   *
   * About the ADAPTER existing, not about configuration: publishing runs on the
   * per-account token stored at connect time, so it keeps working even if the app
   * credentials are later cleared. Whether a workspace can start a NEW connection is
   * a separate question, answered by lib/social/credentials.ts.
   */
  canPublish: boolean;

  /**
   * The OAuth entry points are deliberately NOT on this interface.
   *
   * They need the workspace's app id and secret, which differ per workspace and are
   * resolved from the database. Putting them here would mean either threading
   * credentials through every adapter method or letting adapters read global state,
   * and the second is what this refactor removed. routes/socialConnect.ts calls the
   * per-network functions directly instead.
   */
  listPublishableAccounts(userToken: string): Promise<ConnectedAccount[]>;

  /** Sync checks, run before anything is scheduled. Never calls the network. */
  validate(post: PublishablePost, media: MediaItem[]): ValidationResult;

  publish(creds: AdapterCredentials, post: PublishablePost, media: MediaItem[]): Promise<PublishResult>;
  publishFirstComment?(creds: AdapterCredentials, externalPostId: string, text: string): Promise<void>;

  fetchPostMetrics?(creds: AdapterCredentials, externalPostId: string): Promise<Record<string, number>>;
  fetchAccountMetrics?(creds: AdapterCredentials, date: string): Promise<Record<string, number>>;
}

/**
 * Dry run: log the exact request an adapter would send and return a fake id.
 *
 * On for the first production week by design. Publishing is the one thing in Klippy
 * that cannot be undone: a post that goes out to a client's audience by mistake
 * cannot be recalled, and "it was a test" is not a thing the audience sees.
 */
export const dryRun = (): boolean => process.env.SOCIAL_DRY_RUN === '1';
