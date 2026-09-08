/**
 * Date helpers, in one place.
 *
 * These were defined separately in four components, which is fine until two of them
 * disagree. The subtle one is `iso`: it must build the date from LOCAL parts, not from
 * toISOString(). East of Greenwich, toISOString on a date at local midnight reports
 * the day before, so a calendar built on it puts everything in the wrong cell for
 * anyone in South Africa, which is where this is used.
 */

export const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Monday first: a working week starts on Monday for everyone this is built for. */
export const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** YYYY-MM-DD in the viewer's own timezone. Never toISOString: see the note above. */
export const iso = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export const addDays = (d: Date, n: number): Date => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};

export const startOfWeek = (d: Date): Date => {
  const x = new Date(d);
  const day = (x.getDay() + 6) % 7; // Monday = 0
  return addDays(x, -day);
};

export const sameDay = (a: Date, b: Date): boolean => iso(a) === iso(b);

/** HH:MM in the viewer's timezone, from anything the API hands back. */
export const hhmm = (value: string | Date | null | undefined): string => {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/**
 * The six-week grid a month view draws.
 *
 * Always six rows, so the calendar does not change height as the user pages through
 * months, which is the kind of jump that makes a UI feel unstable.
 */
export const monthGrid = (cursor: Date): Date[] => {
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const start = startOfWeek(first);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
};

export const weekDays = (cursor: Date): Date[] => {
  const start = startOfWeek(cursor);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
};

/**
 * A local wall-clock date and time as an ISO string WITH the offset.
 *
 * The offset is what makes it unambiguous: the server stores UTC, and sending a naive
 * string would leave it guessing which zone was meant. Built from the browser's own
 * offset, which is the one the person setting the time is looking at.
 */
export const localIsoWithOffset = (date: string, time: string): string => {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const local = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, hh ?? 0, mm ?? 0, 0, 0);
  const off = -local.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  return `${iso(local)}T${pad(local.getHours())}:${pad(local.getMinutes())}:00${sign}${pad(off / 60)}:${pad(off % 60)}`;
};
