import { describe, expect, it } from 'vitest';
import { eventsInWindow } from '../src/lib/ics.js';

/**
 * The calendar reader, against the shapes Outlook and Google actually publish.
 * Times are checked in UTC: South Africa is UTC+2 with no daylight saving.
 */
const OUTLOOK = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:Microsoft Exchange Server 2010',
  'BEGIN:VTIMEZONE',
  'TZID:South Africa Standard Time',
  'BEGIN:STANDARD',
  'DTSTART:16010101T000000',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0200',
  'END:STANDARD',
  'END:VTIMEZONE',
  // A one-off meeting, with a folded description line and escaped text.
  'BEGIN:VEVENT',
  'UID:one-off',
  'SUMMARY:Call with Thandi\\, Early Bird',
  'LOCATION:Teams',
  'DTSTART;TZID=South Africa Standard Time:20261012T090000',
  'DTEND;TZID=South Africa Standard Time:20261012T093000',
  'DESCRIPTION:A long line that Outlook folds',
  '  onto the next line',
  'END:VEVENT',
  // Weekly on Monday and Wednesday at 14:00, with one date skipped and one moved.
  'BEGIN:VEVENT',
  'UID:weekly',
  'SUMMARY:Stand-up',
  'DTSTART;TZID=South Africa Standard Time:20261005T140000',
  'DTEND;TZID=South Africa Standard Time:20261005T141500',
  'RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE',
  'EXDATE;TZID=South Africa Standard Time:20261007T140000',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:weekly',
  'RECURRENCE-ID;TZID=South Africa Standard Time:20261012T140000',
  'SUMMARY:Stand-up (moved)',
  'DTSTART;TZID=South Africa Standard Time:20261012T160000',
  'DTEND;TZID=South Africa Standard Time:20261012T161500',
  'END:VEVENT',
  // A cancelled meeting is left out.
  'BEGIN:VEVENT',
  'UID:cancelled',
  'SUMMARY:Gone',
  'STATUS:CANCELLED',
  'DTSTART:20261013T080000Z',
  'DTEND:20261013T090000Z',
  'END:VEVENT',
  // All day.
  'BEGIN:VEVENT',
  'UID:allday',
  'SUMMARY:Public holiday',
  'DTSTART;VALUE=DATE:20261014',
  'DTEND;VALUE=DATE:20261015',
  'END:VEVENT',
  // Monthly on the second Tuesday, three times only.
  'BEGIN:VEVENT',
  'UID:monthly',
  'SUMMARY:Board meeting',
  'DTSTART;TZID=Africa/Johannesburg:20261013T100000',
  'DTEND;TZID=Africa/Johannesburg:20261013T110000',
  'RRULE:FREQ=MONTHLY;BYDAY=2TU;COUNT=3',
  'END:VEVENT',
  // A daily meeting that started years ago and runs until a date.
  'BEGIN:VEVENT',
  'UID:daily',
  'SUMMARY:Daily check',
  'DTSTART:20150101T060000Z',
  'DTEND:20150101T061000Z',
  'RRULE:FREQ=DAILY;UNTIL=20261016T235959Z',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

const window = (from: string, to: string) => eventsInWindow(OUTLOOK, new Date(from), new Date(to));
const titlesOn = (evs: ReturnType<typeof eventsInWindow>, day: string) =>
  evs.filter((e) => e.start.toISOString().slice(0, 10) === day).map((e) => e.title);

describe('reading a published calendar', () => {
  const evs = window('2026-10-01T00:00:00Z', '2027-01-31T00:00:00Z');

  it('reads a one-off meeting in the Outlook zone name, with escaped text', () => {
    const e = evs.find((x) => x.uid === 'one-off')!;
    expect(e.title).toBe('Call with Thandi, Early Bird');
    expect(e.location).toBe('Teams');
    expect(e.start.toISOString()).toBe('2026-10-12T07:00:00.000Z');
    expect(e.end!.toISOString()).toBe('2026-10-12T07:30:00.000Z');
  });

  it('repeats weekly on the right days, skips an excluded date and moves a changed one', () => {
    const standups = evs.filter((x) => x.title.startsWith('Stand-up') && x.start < new Date('2026-10-20T00:00:00Z'));
    expect(standups.map((x) => x.start.toISOString())).toEqual([
      '2026-10-05T12:00:00.000Z', // Mon
      // Wed 7th excluded
      '2026-10-12T14:00:00.000Z', // Mon, moved to 16:00 local
      '2026-10-14T12:00:00.000Z', // Wed
      '2026-10-19T12:00:00.000Z', // Mon
    ]);
    expect(standups[1]!.title).toBe('Stand-up (moved)');
  });

  it('leaves out cancelled meetings', () => {
    expect(evs.some((x) => x.uid === 'cancelled')).toBe(false);
  });

  it('reads all-day events', () => {
    const e = evs.find((x) => x.uid === 'allday')!;
    expect(e.allDay).toBe(true);
    expect(titlesOn(evs, '2026-10-14')).toContain('Public holiday');
  });

  it('repeats monthly on the second Tuesday, the given number of times', () => {
    const board = evs.filter((x) => x.title === 'Board meeting').map((x) => x.start.toISOString().slice(0, 10));
    expect(board).toEqual(['2026-10-13', '2026-11-10', '2026-12-08']);
  });

  it('keeps a daily meeting that started years ago, up to its end date', () => {
    const daily = evs.filter((x) => x.title === 'Daily check').map((x) => x.start.toISOString().slice(0, 10));
    expect(daily[0]).toBe('2026-10-01');
    expect(daily[daily.length - 1]).toBe('2026-10-16');
    expect(daily).toHaveLength(16);
  });

  it('only returns what touches the window', () => {
    const narrow = window('2026-10-12T00:00:00Z', '2026-10-12T23:59:59Z');
    expect(narrow.map((x) => x.title).sort()).toEqual(['Call with Thandi, Early Bird', 'Daily check', 'Stand-up (moved)']);
  });
});
