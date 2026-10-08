/**
 * Reading a calendar file (.ics), the format Outlook, Google and Apple publish.
 *
 * Written here rather than pulled in as a package because the app is deployed by
 * copying a built folder to cPanel, and a new dependency is one more thing that
 * can be missing on the server. It covers what real published calendars contain:
 *  - folded lines, escaped text, VALUE=DATE all-day events;
 *  - times in UTC (Z), in a named zone (TZID=), or floating;
 *  - Windows zone names (Outlook writes "South Africa Standard Time"), mapped to
 *    real zones, with the file's own VTIMEZONE offset as the fallback;
 *  - repeating events (RRULE: daily, weekly with days, monthly by date or by
 *    "second Tuesday", yearly; INTERVAL, COUNT, UNTIL), skipped dates (EXDATE),
 *    and one-off changes or cancellations of a single occurrence (RECURRENCE-ID);
 *  - cancelled events, which are left out.
 * Only a window of dates is expanded, so a weekly meeting "forever" stays finite.
 */
/** Undo line folding and split into properties. */
function unfold(text) {
    const raw = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const out = [];
    for (const line of raw) {
        if ((line.startsWith(' ') || line.startsWith('\t')) && out.length)
            out[out.length - 1] += line.slice(1);
        else if (line.length)
            out.push(line);
    }
    return out;
}
function parseProp(line) {
    // NAME;PARAM=a;PARAM="b:c":VALUE  (a colon inside quotes is not the separator)
    let i = 0;
    let inQ = false;
    for (; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"')
            inQ = !inQ;
        else if (ch === ':' && !inQ)
            break;
    }
    if (i >= line.length)
        return null;
    const head = line.slice(0, i);
    const value = line.slice(i + 1);
    const parts = head.split(';');
    const params = {};
    for (const p of parts.slice(1)) {
        const eq = p.indexOf('=');
        if (eq > 0)
            params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
    }
    return { name: parts[0].toUpperCase(), params, value };
}
export function parseComponents(text) {
    const root = { type: 'ROOT', props: [], children: [] };
    const stack = [root];
    for (const line of unfold(text)) {
        const p = parseProp(line);
        if (!p)
            continue;
        if (p.name === 'BEGIN') {
            const c = { type: p.value.toUpperCase().trim(), props: [], children: [] };
            stack[stack.length - 1].children.push(c);
            stack.push(c);
        }
        else if (p.name === 'END') {
            if (stack.length > 1)
                stack.pop();
        }
        else {
            stack[stack.length - 1].props.push(p);
        }
    }
    return root;
}
const unescape = (v) => v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1').trim();
const prop = (c, name) => c.props.find((p) => p.name === name);
const props = (c, name) => c.props.filter((p) => p.name === name);
// ---- time zones ----------------------------------------------------------------------
/** Outlook writes Windows zone names. The common ones, mapped to real zones. */
const WINDOWS_ZONES = {
    'South Africa Standard Time': 'Africa/Johannesburg',
    'UTC': 'UTC', 'Coordinated Universal Time': 'UTC',
    'GMT Standard Time': 'Europe/London', 'Greenwich Standard Time': 'Africa/Abidjan',
    'W. Europe Standard Time': 'Europe/Berlin', 'Romance Standard Time': 'Europe/Paris',
    'Central Europe Standard Time': 'Europe/Budapest', 'Central European Standard Time': 'Europe/Warsaw',
    'E. Europe Standard Time': 'Europe/Chisinau', 'FLE Standard Time': 'Europe/Kiev', 'GTB Standard Time': 'Europe/Bucharest',
    'Israel Standard Time': 'Asia/Jerusalem', 'Egypt Standard Time': 'Africa/Cairo',
    'Arabian Standard Time': 'Asia/Dubai', 'Arab Standard Time': 'Asia/Riyadh', 'Russian Standard Time': 'Europe/Moscow',
    'E. Africa Standard Time': 'Africa/Nairobi', 'W. Central Africa Standard Time': 'Africa/Lagos',
    'Namibia Standard Time': 'Africa/Windhoek', 'Mauritius Standard Time': 'Indian/Mauritius',
    'India Standard Time': 'Asia/Kolkata', 'China Standard Time': 'Asia/Shanghai', 'Singapore Standard Time': 'Asia/Singapore',
    'Tokyo Standard Time': 'Asia/Tokyo', 'AUS Eastern Standard Time': 'Australia/Sydney', 'W. Australia Standard Time': 'Australia/Perth',
    'New Zealand Standard Time': 'Pacific/Auckland',
    'Eastern Standard Time': 'America/New_York', 'Central Standard Time': 'America/Chicago',
    'Mountain Standard Time': 'America/Denver', 'Pacific Standard Time': 'America/Los_Angeles',
    'Atlantic Standard Time': 'America/Halifax', 'E. South America Standard Time': 'America/Sao_Paulo',
    'Argentina Standard Time': 'America/Buenos_Aires',
};
const validZone = (z) => { try {
    new Intl.DateTimeFormat('en', { timeZone: z });
    return true;
}
catch {
    return false;
} };
/** Minutes the zone is ahead of UTC at a given instant. */
function zoneOffset(zone, at) {
    const f = new Intl.DateTimeFormat('en-US', {
        timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const parts = Object.fromEntries(f.formatToParts(new Date(at)).map((p) => [p.type, p.value]));
    const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    return Math.round((asUtc - at) / 60000);
}
export function makeResolver(root, defaultZone) {
    // Fixed offsets from the file's own VTIMEZONE blocks, for names we cannot map.
    const fixed = new Map();
    for (const tz of root.children.flatMap((c) => (c.type === 'VCALENDAR' ? c.children : [c])).filter((c) => c.type === 'VTIMEZONE')) {
        const id = prop(tz, 'TZID')?.value;
        const std = tz.children.find((c) => c.type === 'STANDARD') ?? tz.children[0];
        const off = std && prop(std, 'TZOFFSETTO')?.value;
        if (id && off) {
            const m = /^([+-])(\d{2})(\d{2})/.exec(off);
            if (m)
                fixed.set(id, (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])));
        }
    }
    const zoneFor = (tzid) => {
        if (!tzid)
            return defaultZone;
        const clean = tzid.replace(/^\/+/, '');
        if (validZone(clean))
            return clean;
        if (WINDOWS_ZONES[clean])
            return WINDOWS_ZONES[clean];
        return null;
    };
    return (w, tzid) => {
        const naive = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
        const zone = zoneFor(tzid);
        if (zone) {
            // Two passes settle the offset across a daylight-saving change.
            let off = zoneOffset(zone, naive);
            off = zoneOffset(zone, naive - off * 60000);
            return new Date(naive - off * 60000);
        }
        const off = fixed.get(tzid) ?? 0;
        return new Date(naive - off * 60000);
    };
}
function parseWall(v) {
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(v.trim());
    if (!m)
        return null;
    return {
        wall: { y: +m[1], mo: +m[2], d: +m[3], h: +(m[4] ?? 0), mi: +(m[5] ?? 0), s: +(m[6] ?? 0) },
        utc: !!m[7], dateOnly: !m[4],
    };
}
// ---- repeating events -----------------------------------------------------------------
const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const daysInMonth = (y, mo) => new Date(Date.UTC(y, mo, 0)).getUTCDate();
const addDaysWall = (w, n) => {
    const t = new Date(Date.UTC(w.y, w.mo - 1, w.d + n));
    return { ...w, y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
};
const weekday = (w) => new Date(Date.UTC(w.y, w.mo - 1, w.d)).getUTCDay();
/** The nth (1-based, or -1 for last) given weekday of a month, or null. */
function nthWeekday(y, mo, dow, n) {
    const dim = daysInMonth(y, mo);
    const hits = [];
    for (let d = 1; d <= dim; d++)
        if (new Date(Date.UTC(y, mo - 1, d)).getUTCDay() === dow)
            hits.push(d);
    const idx = n > 0 ? n - 1 : hits.length + n;
    return hits[idx] ?? null;
}
/**
 * Wall-clock start times of each occurrence, in order, up to `limit` occurrences or
 * the end of the window. Works on wall time so a 9am meeting stays at 9am across a
 * daylight-saving change.
 */
export function expandRule(start, rrule, untilMs, toInstant, windowEnd) {
    const r = Object.fromEntries(rrule.split(';').map((kv) => kv.split('=')).filter((kv) => kv.length === 2));
    const freq = r.FREQ;
    const interval = Math.max(1, Number(r.INTERVAL ?? 1) || 1);
    const count = r.COUNT ? Number(r.COUNT) : Infinity;
    let until = untilMs;
    if (r.UNTIL) {
        const u = parseWall(r.UNTIL);
        if (u)
            until = u.utc || u.dateOnly ? Date.UTC(u.wall.y, u.wall.mo - 1, u.wall.d, u.dateOnly ? 23 : u.wall.h, u.dateOnly ? 59 : u.wall.mi, u.dateOnly ? 59 : u.wall.s) : toInstant(u.wall);
    }
    const byDay = (r.BYDAY ?? '').split(',').filter(Boolean).map((x) => {
        const m = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(x);
        return m ? { n: m[1] ? Number(m[1]) : null, dow: DAYS.indexOf(m[2]) } : null;
    }).filter((x) => !!x);
    const byMonthDay = (r.BYMONTHDAY ?? '').split(',').filter(Boolean).map(Number);
    const byMonth = (r.BYMONTH ?? '').split(',').filter(Boolean).map(Number);
    const out = [];
    const startMs = toInstant(start);
    const push = (w) => {
        const t = toInstant(w);
        if (t < startMs)
            return true;
        if (until != null && t > until)
            return false;
        if (t > windowEnd)
            return false;
        out.push(w);
        return out.length < count;
    };
    if (freq === 'DAILY') {
        for (let i = 0, w = start; i < 40000; i++, w = addDaysWall(w, interval))
            if (!push(w))
                break;
    }
    else if (freq === 'WEEKLY') {
        const dows = byDay.length ? byDay.map((b) => b.dow) : [weekday(start)];
        // Weeks start on Monday (the iCalendar default WKST).
        const monday = addDaysWall(start, -((weekday(start) + 6) % 7));
        const order = [...dows].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
        outer: for (let wk = 0; wk < 2000; wk++) {
            const base = addDaysWall(monday, wk * 7 * interval);
            for (const dow of order)
                if (!push(addDaysWall(base, (dow + 6) % 7)))
                    break outer;
        }
    }
    else if (freq === 'MONTHLY' || freq === 'YEARLY') {
        const stepMonths = freq === 'MONTHLY' ? interval : 12 * interval;
        outer: for (let k = 0; k < 1200; k++) {
            const total = (start.y * 12 + start.mo - 1) + k * stepMonths;
            const y = Math.floor(total / 12);
            const mo = (total % 12) + 1;
            const months = freq === 'YEARLY' && byMonth.length ? byMonth : [mo];
            for (const m of months) {
                let days = [];
                if (byDay.length && byDay.some((b) => b.n != null)) {
                    days = byDay.map((b) => nthWeekday(y, m, b.dow, b.n ?? 1)).filter((d) => d != null);
                }
                else if (byDay.length) {
                    for (let d = 1; d <= daysInMonth(y, m); d++)
                        if (byDay.some((b) => b.dow === new Date(Date.UTC(y, m - 1, d)).getUTCDay()))
                            days.push(d);
                }
                else if (byMonthDay.length) {
                    days = byMonthDay.map((d) => (d < 0 ? daysInMonth(y, m) + d + 1 : d)).filter((d) => d >= 1 && d <= daysInMonth(y, m));
                }
                else {
                    if (start.d > daysInMonth(y, m))
                        continue; // the 31st does not exist this month: skipped, as the standard says
                    days = [start.d];
                }
                for (const d of days.sort((a, b) => a - b))
                    if (!push({ ...start, y, mo: m, d }))
                        break outer;
            }
        }
    }
    else {
        push(start);
    }
    return out;
}
/**
 * Every event that touches the window, as real instants.
 * `defaultZone` is used for times that name no zone at all.
 */
export function eventsInWindow(text, from, to, defaultZone = 'Africa/Johannesburg') {
    const root = parseComponents(text);
    const resolve = makeResolver(root, defaultZone);
    const cal = root.children.find((c) => c.type === 'VCALENDAR') ?? root;
    const vevents = cal.children.filter((c) => c.type === 'VEVENT');
    const read = (p) => {
        if (!p)
            return null;
        const w = parseWall(p.value);
        if (!w)
            return null;
        const dateOnly = w.dateOnly || p.params.VALUE === 'DATE';
        const at = w.utc ? new Date(Date.UTC(w.wall.y, w.wall.mo - 1, w.wall.d, w.wall.h, w.wall.mi, w.wall.s))
            : dateOnly ? new Date(Date.UTC(w.wall.y, w.wall.mo - 1, w.wall.d))
                : resolve(w.wall, p.params.TZID);
        return { at, wall: w.wall, dateOnly, tzid: p.params.TZID, utc: w.utc };
    };
    // One-off changes to a single occurrence, keyed by uid + the original start.
    const overrides = new Map();
    for (const e of vevents) {
        const rid = read(prop(e, 'RECURRENCE-ID'));
        const uid = prop(e, 'UID')?.value;
        if (rid && uid)
            overrides.set(`${uid}|${rid.at.getTime()}`, e);
    }
    const out = [];
    const fromMs = from.getTime();
    const toMs = to.getTime();
    const toEvent = (e, start, allDay, durationMs, uid) => {
        if ((prop(e, 'STATUS')?.value ?? '').toUpperCase() === 'CANCELLED')
            return null;
        const end = durationMs > 0 ? new Date(start.getTime() + durationMs) : null;
        if ((end ?? start).getTime() < fromMs || start.getTime() > toMs)
            return null;
        return {
            uid, title: unescape(prop(e, 'SUMMARY')?.value ?? '') || 'Busy',
            location: unescape(prop(e, 'LOCATION')?.value ?? '') || null, start, end, allDay,
        };
    };
    for (const e of vevents) {
        if (prop(e, 'RECURRENCE-ID'))
            continue; // handled through its series
        const uid = prop(e, 'UID')?.value ?? `noid-${out.length}`;
        const s = read(prop(e, 'DTSTART'));
        if (!s)
            continue;
        const en = read(prop(e, 'DTEND'));
        let duration = en ? en.at.getTime() - s.at.getTime() : 0;
        if (!en && prop(e, 'DURATION')) {
            const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(prop(e, 'DURATION').value);
            if (m)
                duration = ((+(m[1] ?? 0) * 7 + +(m[2] ?? 0)) * 86400 + +(m[3] ?? 0) * 3600 + +(m[4] ?? 0) * 60 + +(m[5] ?? 0)) * 1000;
        }
        if (!en && s.dateOnly && duration === 0)
            duration = 86400000;
        const rrule = prop(e, 'RRULE')?.value;
        if (!rrule) {
            const ev = toEvent(e, s.at, s.dateOnly, duration, uid);
            if (ev)
                out.push(ev);
            continue;
        }
        const exdates = new Set(props(e, 'EXDATE').flatMap((p) => p.value.split(',').map((v) => {
            const r = read({ ...p, value: v });
            return r ? r.at.getTime() : NaN;
        })));
        const toInstant = (w) => (s.utc ? Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s)
            : s.dateOnly ? Date.UTC(w.y, w.mo - 1, w.d) : resolve(w, s.tzid).getTime());
        for (const w of expandRule(s.wall, rrule, null, toInstant, toMs)) {
            const at = toInstant(w);
            if (exdates.has(at))
                continue;
            const changed = overrides.get(`${uid}|${at}`);
            if (changed) {
                const cs = read(prop(changed, 'DTSTART'));
                const ce = read(prop(changed, 'DTEND'));
                if (!cs)
                    continue;
                const ev = toEvent(changed, cs.at, cs.dateOnly, ce ? ce.at.getTime() - cs.at.getTime() : duration, `${uid}|${at}`);
                if (ev)
                    out.push(ev);
                continue;
            }
            const ev = toEvent(e, new Date(at), s.dateOnly, duration, `${uid}|${at}`);
            if (ev)
                out.push(ev);
        }
    }
    return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}
//# sourceMappingURL=ics.js.map