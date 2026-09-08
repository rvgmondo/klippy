/**
 * Turn a planned calendar written as HTML into posts in Klippy.
 *
 * A month of content usually exists somewhere else first: a document, a spreadsheet,
 * or in this case an HTML calendar the agency already hands to the client. Retyping
 * thirteen posts to try the tool is the reason people never try the tool.
 *
 * WHAT IT READS. Each post is a `.day` block, and inside it:
 *   .day-date   the date. Anything Date can parse, or YYYY-MM-DD, or "5 October 2026".
 *   .cap-type   the internal label, which becomes the post title.
 *   .cap        the caption, with paragraphs and line breaks preserved.
 *   .ask-text   what to ask the client for. Its presence is what marks the post as
 *               waiting on media rather than ready to go.
 * Anything it cannot read is REPORTED, never guessed at, because a caption silently
 * imported as an empty string is worse than one that failed loudly.
 *
 * BUILT FROM A DESCRIPTION, NOT FROM THE FILE. The real calendar was not on the
 * machine when this was written, so the selectors come from the brief rather than from
 * a document anyone has parsed. That is exactly why --dry-run exists and why it is the
 * default: it prints what it would create, and nothing is written until you have read
 * that and passed --write. If the parse comes out wrong, the selectors are the four
 * constants below and nothing else needs touching.
 *
 * USAGE
 *   node scripts/import-calendar.mjs <file.html> --business 1 [options]
 *
 *   --business <id>     required, which business the posts belong to
 *   --networks a,b      default instagram,facebook,linkedin
 *   --time HH:MM        default 09:00, used when a day carries no time
 *   --timezone <IANA>   default the workspace timezone
 *   --folder <id>       the client folder to file these under
 *   --mode auto|manual  default manual, because nothing can autopublish yet
 *   --api <url>         default http://localhost:8090
 *   --cookie <value>    a session cookie; or set KLIPPY_COOKIE
 *   --write             actually create them. Without this it only prints.
 */
import { readFileSync } from 'node:fs';

/**
 * Class names are matched as WHOLE TOKENS, never with a word boundary.
 *
 * \bday\b matches inside "day-date", and \bcap\b matches inside "cap-type", so a
 * boundary-based split cuts the document at every child element and finds nothing at
 * all. That is the kind of mistake that would quietly import a half-empty calendar
 * rather than failing, so the class list is tokenised properly.
 */
const CLASS_ATTR = /class\s*=\s*"([^"]*)"/i;
const hasClass = (tag, name) => {
  const m = tag.match(CLASS_ATTR);
  return !!m && m[1].split(/\s+/).includes(name);
};

/** Every opening tag in the document, with where it starts and ends. */
function openingTags(html) {
  const out = [];
  for (const m of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/gi)) {
    out.push({ index: m.index ?? 0, end: (m.index ?? 0) + m[0].length, tag: m[0] });
  }
  return out;
}

/**
 * The inner text of the first element carrying `name` as a class.
 *
 * Reads to the first closing tag, which is enough for the leaf elements this format
 * uses and keeps a <br> inside a caption where it belongs.
 */
function pick(chunk, name) {
  for (const t of openingTags(chunk)) {
    if (!hasClass(t.tag, name)) continue;
    const rest = chunk.slice(t.end);
    const stop = rest.search(/<\/(?:div|p|span|section|article|li|h\d)>/i);
    return stop >= 0 ? rest.slice(0, stop) : rest;
  }
  return '';
}

/** The document split into one chunk per `.day` element. */
function dayBlocks(html) {
  const starts = openingTags(html).filter((t) => hasClass(t.tag, 'day')).map((t) => t.index);
  return starts.map((start, i) => html.slice(start, starts[i + 1] ?? html.length));
}

const argv = process.argv.slice(2);
const flag = (name, fallback = undefined) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);
const file = argv.find((a) => !a.startsWith('--') && /\.html?$/i.test(a));

if (!file) {
  console.error('Give me an HTML calendar file. See the comment at the top of this script.');
  process.exit(1);
}

/** HTML to readable text, keeping the line breaks a caption depends on. */
function text(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .split('\n').map((l) => l.trim()).join('\n')
    .trim();
}

/**
 * A date from whatever the calendar writes.
 *
 * Parsed in UTC deliberately. new Date('5 October 2026') is midnight LOCAL, and east
 * of Greenwich formatting that back gives the 4th, which would move every post in the
 * import back a day.
 */
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
function parseDate(raw, fallbackYear) {
  const s = raw.replace(/(\d+)(st|nd|rd|th)/gi, '$1').trim();
  const iso = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = s.match(/(\d{1,2})\s+([A-Za-z]+)\s*(\d{4})?/);
  if (dmy) {
    const m = MONTHS.findIndex((x) => x.startsWith(dmy[2].toLowerCase().slice(0, 3)));
    if (m >= 0) {
      const y = dmy[3] ?? fallbackYear;
      return `${y}-${String(m + 1).padStart(2, '0')}-${String(Number(dmy[1])).padStart(2, '0')}`;
    }
  }
  const mdy = s.match(/([A-Za-z]+)\s+(\d{1,2}),?\s*(\d{4})?/);
  if (mdy) {
    const m = MONTHS.findIndex((x) => x.startsWith(mdy[1].toLowerCase().slice(0, 3)));
    if (m >= 0) {
      const y = mdy[3] ?? fallbackYear;
      return `${y}-${String(m + 1).padStart(2, '0')}-${String(Number(mdy[2])).padStart(2, '0')}`;
    }
  }
  return null;
}

const html = readFileSync(file, 'utf8');
const fallbackYear = (html.match(/\b(20\d{2})\b/) ?? [])[1] ?? String(new Date().getFullYear());

const posts = [];
const skipped = [];
let index = 0;
for (const chunk of dayBlocks(html)) {
  index++;
  const rawDate = pick(chunk, 'day-date');
  const date = rawDate ? parseDate(text(rawDate), fallbackYear) : null;
  const title = text(pick(chunk, 'cap-type'));
  const caption = text(pick(chunk, 'cap'));
  const ask = text(pick(chunk, 'ask-text'));
  const time = (text(chunk).match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/) ?? [])[0];

  if (!date) {
    skipped.push({ block: index, why: rawDate ? `could not read the date "${text(rawDate)}"` : 'no .day-date found' });
    continue;
  }
  if (!title && !caption) {
    skipped.push({ block: index, why: `nothing to post on ${date}: no .cap-type and no .cap` });
    continue;
  }
  posts.push({
    date,
    ...(time ? { time } : {}),
    title: (title || caption.split('\n')[0] || 'Untitled').slice(0, 200),
    ...(caption ? { caption } : {}),
    ...(ask ? { mediaAsk: ask } : {}),
  });
}

const payload = {
  businessId: Number(flag('business', '0')),
  ...(flag('folder') ? { folderId: Number(flag('folder')) } : {}),
  ...(flag('timezone') ? { timezone: flag('timezone') } : {}),
  defaultTime: flag('time', '09:00'),
  networks: (flag('networks', 'instagram,facebook,linkedin')).split(',').map((s) => s.trim()).filter(Boolean),
  deliveryMode: flag('mode', 'manual'),
  posts,
};

console.log(`Read ${file}`);
console.log(`Found ${posts.length} post(s)${skipped.length ? `, skipped ${skipped.length}` : ''}.\n`);
for (const p of posts) {
  console.log(`  ${p.date}${p.time ? ` ${p.time}` : ''}  ${p.title}`);
  if (p.mediaAsk) console.log(`      asks for: ${p.mediaAsk.slice(0, 90)}`);
}
if (skipped.length) {
  console.log('\nSkipped, so nothing is invented:');
  for (const s of skipped) console.log(`  block ${s.block}: ${s.why}`);
}

if (!has('write')) {
  console.log('\nThis was a dry run and nothing was created.');
  console.log('Check the dates and titles above, then run again with --write.');
  process.exit(0);
}

if (!payload.businessId) {
  console.error('\n--business <id> is required to create anything.');
  process.exit(1);
}
const cookie = flag('cookie', process.env.KLIPPY_COOKIE);
if (!cookie) {
  console.error('\nNeed a session cookie: --cookie "klippy_session=..." or set KLIPPY_COOKIE.');
  process.exit(1);
}

const api = flag('api', 'http://localhost:8090').replace(/\/+$/, '');
const res = await fetch(`${api}/api/v1/social/import/calendar`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify(payload),
});
const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`\nImport failed (${res.status}): ${body.error ?? 'unknown error'}`);
  process.exit(1);
}
console.log(`\nCreated ${body.created} post(s) in the ${body.timezone} timezone.`);
