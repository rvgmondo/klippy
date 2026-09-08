/**
 * What the social API hands back, in one place.
 *
 * The caption limits are duplicated from the server on purpose. The server is the
 * authority and refuses anything over the line, but a character count that only
 * appears after a round trip is not a character count anyone can write against. When
 * these disagree the server wins; keep them in step with docs/social/API-NOTES.md
 * rows X-LIM-01 and X-LIM-03.
 */

export type SocialNetwork = 'instagram' | 'facebook' | 'linkedin';

export const NETWORK_META: Record<SocialNetwork, {
  label: string; short: string; captionMax: number; tint: string;
}> = {
  // No brand icons: lucide dropped them, and chasing trademarked marks through a
  // dependency that keeps removing them is not worth it. A two-letter badge in the
  // network's own colour reads faster at calendar-card size anyway.
  instagram: { label: 'Instagram', short: 'IG', captionMax: 2200, tint: 'bg-pink-500/15 text-pink-300 border-pink-500/30' },
  facebook: { label: 'Facebook', short: 'FB', captionMax: 63206, tint: 'bg-blue-500/15 text-blue-300 border-blue-500/30' },
  linkedin: { label: 'LinkedIn', short: 'LI', captionMax: 3000, tint: 'bg-sky-500/15 text-sky-300 border-sky-500/30' },
};

export const ALL_NETWORKS: SocialNetwork[] = ['instagram', 'facebook', 'linkedin'];

export type SocialStatus =
  | 'draft' | 'needs_media' | 'awaiting_approval' | 'approved' | 'scheduled'
  | 'publishing' | 'published' | 'partially_published' | 'failed' | 'needs_manual' | 'cancelled';

export interface SocialIssue {
  network: SocialNetwork;
  field: 'caption' | 'firstComment' | 'media' | 'postType' | 'account' | 'schedule';
  message: string;
  rule?: string;
  severity: 'error' | 'warning';
}

export interface SocialTarget {
  id: number;
  postId: number;
  network: SocialNetwork;
  status: 'pending' | 'publishing' | 'published' | 'failed' | 'skipped' | 'manual_done';
  socialAccountId: number | null;
  captionOverride: string | null;
  permalink: string | null;
  error: string | null;
  publishedAt: string | null;
  attempts: number;
}

export interface SocialMedia {
  id: number;
  position: number;
  mimeType: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  altText: string | null;
  publicUrl: string | null;
}

export interface SocialPost {
  id: number;
  businessId: number;
  folderId: number | null;
  title: string;
  caption: string | null;
  firstComment: string | null;
  postType: 'post' | 'carousel' | 'reel' | 'story';
  scheduledAt: string | null;
  timezone: string | null;
  status: SocialStatus;
  deliveryMode: 'auto' | 'manual';
  mediaAsk: string | null;
  mediaAskDue: string | null;
  attempts: number;
}

/** The list shape: media carries `url` rather than the detail shape's `publicUrl`. */
export interface SocialPostListItem extends SocialPost {
  targets: SocialTarget[];
  media: { id: number; position: number; mimeType: string | null; url: string | null; altText: string | null }[];
}

export interface SocialPostDetail {
  post: SocialPost;
  targets: SocialTarget[];
  media: SocialMedia[];
  log: { id: number; level: 'info' | 'warn' | 'error'; message: string; createdAt: string }[];
  timezone: string;
}

export interface SocialAccountsResponse {
  accounts: {
    id: number; businessId: number; network: SocialNetwork;
    displayName: string; avatarUrl: string | null;
    status: 'connected' | 'expired' | 'revoked' | 'error';
    lastError: string | null; tokenExpiresAt: string | null;
  }[];
  serverReady: boolean;
  networks: { network: SocialNetwork; connected: boolean; canAutoPublish: boolean; note: string }[];
}
