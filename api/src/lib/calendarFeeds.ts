import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { calendarFeeds, externalEvents } from '../db/schema.js';
import { withTenant } from './tenant.js';
import { decryptSecret } from './secretbox.js';
import { eventsInWindow } from './ics.js';

/**
 * Reading a published calendar link (Outlook, Google, Apple) into Klippy.
 *
 * The server fetches a URL a person typed, which is how a server is tricked into
 * reading its own private network. So: https only (webcal:// is treated as https),
 * every address the name resolves to must be public, redirects are followed by
 * hand and checked again, the response is capped in size and time, and it must
 * actually be a calendar.
 */

const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 15000;
/** How old a calendar can be before it is read again. */
export const STALE_MS = 15 * 60 * 1000;
/** The window stored: a month back, six months ahead. */
const BACK_DAYS = 31;
const AHEAD_DAYS = 183;

export class FeedError extends Error {}

function isPrivate(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivate(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9')
    || v.startsWith('fea') || v.startsWith('feb') || v.startsWith('ff');
}

/** A typed link, made into a fetchable https URL, or a plain-language error. */
export function normaliseFeedUrl(raw: string): URL {
  let s = raw.trim();
  if (/^webcals?:\/\//i.test(s)) s = s.replace(/^webcals?:\/\//i, 'https://');
  let u: URL;
  try { u = new URL(s); } catch { throw new FeedError('That is not a link. Copy the ICS link from your calendar and paste it here.'); }
  if (u.protocol !== 'https:') throw new FeedError('The link must start with https:// (or webcal://).');
  if (u.username || u.password) throw new FeedError('That link has a password in it, which is not supported.');
  if (u.port && u.port !== '443') throw new FeedError('That link uses an unusual port, which is not supported.');
  return u;
}

async function assertPublic(host: string) {
  if (net.isIP(host)) {
    if (isPrivate(host)) throw new FeedError('That address is not on the public internet.');
    return;
  }
  const addrs = await lookup(host, { all: true }).catch(() => { throw new FeedError(`Could not find ${host}. Check the link.`); });
  if (!addrs.length || addrs.some((a) => isPrivate(a.address))) throw new FeedError('That address is not on the public internet.');
}

/** Fetch the calendar text, safely. */
export async function fetchCalendar(raw: string): Promise<string> {
  let url = normaliseFeedUrl(raw);
  for (let hop = 0; hop < 4; hop++) {
    await assertPublic(url.hostname);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, { redirect: 'manual', signal: ctl.signal, headers: { accept: 'text/calendar, */*', 'user-agent': 'Klippy calendar reader' } });
    } catch {
      clearTimeout(timer);
      throw new FeedError('The calendar did not answer. Check the link, or try again later.');
    }
    if (res.status >= 300 && res.status < 400) {
      clearTimeout(timer);
      const next = res.headers.get('location');
      if (!next) throw new FeedError('The calendar link redirects nowhere.');
      url = normaliseFeedUrl(new URL(next, url).toString());
      continue;
    }
    if (res.status === 401 || res.status === 403) { clearTimeout(timer); throw new FeedError('The calendar refused access. The link may have been turned off; publish it again and paste the new link.'); }
    if (res.status === 404) { clearTimeout(timer); throw new FeedError('Nothing is at that link any more. Publish the calendar again and paste the new link.'); }
    if (!res.ok || !res.body) { clearTimeout(timer); throw new FeedError(`The calendar answered with an error (${res.status}).`); }
    // Read with a ceiling, so a huge or endless response cannot fill memory.
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BYTES) { await reader.cancel(); throw new FeedError('That calendar is too large to read (over 5 MB).'); }
        chunks.push(value);
      }
    } finally { clearTimeout(timer); }
    const text = Buffer.concat(chunks).toString('utf8');
    if (!/BEGIN:VCALENDAR/i.test(text.slice(0, 2000))) {
      throw new FeedError('That link is not a calendar file. In Outlook, copy the ICS link, not the HTML one.');
    }
    return text;
  }
  throw new FeedError('The calendar link redirects too many times.');
}

/** Read one calendar now and replace its stored events. Records the error instead of throwing. */
export async function syncFeed(feedId: number): Promise<{ ok: boolean; count: number; error?: string }> {
  const [feed] = await db.select().from(calendarFeeds).where(eq(calendarFeeds.id, feedId)).limit(1);
  if (!feed) return { ok: false, count: 0, error: 'Not found.' };
  try {
    const text = await fetchCalendar(decryptSecret(feed.urlEnc));
    const from = new Date(Date.now() - BACK_DAYS * 86400000);
    const to = new Date(Date.now() + AHEAD_DAYS * 86400000);
    const evs = eventsInWindow(text, from, to).slice(0, 5000);
    await db.transaction(async (tx) => {
      await tx.delete(externalEvents).where(and(eq(externalEvents.accountId, feed.accountId), eq(externalEvents.feedId, feed.id)));
      for (let i = 0; i < evs.length; i += 500) {
        await tx.insert(externalEvents).values(evs.slice(i, i + 500).map((e) => withTenant(feed.accountId, {
          feedId: feed.id, userId: feed.userId, uid: e.uid.slice(0, 255), title: e.title.slice(0, 300),
          location: e.location?.slice(0, 300) ?? null, startAt: e.start, endAt: e.end, allDay: e.allDay,
        })));
      }
      await tx.update(calendarFeeds).set({ lastSyncedAt: new Date(), lastError: null, eventCount: evs.length })
        .where(eq(calendarFeeds.id, feed.id));
    });
    return { ok: true, count: evs.length };
  } catch (err) {
    const msg = err instanceof FeedError ? err.message : 'Could not read the calendar. It will try again shortly.';
    // Stamped anyway, so a broken link is retried every 15 minutes, not on every page load.
    await db.update(calendarFeeds).set({ lastError: msg.slice(0, 255), lastSyncedAt: new Date() }).where(eq(calendarFeeds.id, feed.id));
    return { ok: false, count: 0, error: msg };
  }
}

/** Read every calendar that is older than STALE_MS. Each one is claimed first, so two runs never read the same one. */
export async function syncStaleFeeds(limit = 20): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_MS);
  const stale = await db.select({ id: calendarFeeds.id, last: calendarFeeds.lastSyncedAt }).from(calendarFeeds)
    .where(or(isNull(calendarFeeds.lastSyncedAt), lt(calendarFeeds.lastSyncedAt, cutoff))).limit(limit);
  let done = 0;
  for (const f of stale) {
    const claim = await db.update(calendarFeeds).set({ lastSyncedAt: new Date() })
      .where(and(eq(calendarFeeds.id, f.id), f.last ? eq(calendarFeeds.lastSyncedAt, f.last) : isNull(calendarFeeds.lastSyncedAt)));
    if (!claim[0].affectedRows) continue;
    await syncFeed(f.id);
    done++;
  }
  return done;
}
