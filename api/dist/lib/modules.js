/**
 * The four primitives, and which modules belong to each.
 *
 * Every business runs the same four functions: bring work in, do the work, handle
 * the money, keep the machine running. Klippy already had all four as data
 * (deals, folders/boards/time, documents/expenses, files/settings) but the
 * navigation was one flat list, so nothing told you which part of the business you
 * were standing in. Grouping by primitive is what makes it a business operating
 * system rather than a pile of screens.
 *
 * Modules are then switched on per business, because a copywriter has no use for
 * stock levels and a shop has no use for timesheets. Defaults come from the
 * business type; anything can be overridden per business.
 */
export const PRIMITIVES = ['acquisition', 'fulfillment', 'finance', 'admin'];
export const PRIMITIVE_LABEL = {
    acquisition: 'Acquisition',
    fulfillment: 'Fulfillment',
    finance: 'Finance',
    admin: 'Admin',
};
/** One line on what each primitive is for, shown above its nav group. */
export const PRIMITIVE_BLURB = {
    acquisition: 'Bring work in',
    fulfillment: 'Do the work',
    finance: 'Handle the money',
    admin: 'Run the machine',
};
export const MODULES = [
    // Acquisition
    { key: 'pipeline', label: 'Pipeline', primitive: 'acquisition', hint: 'Leads and deals on their way to becoming work.' },
    { key: 'offerings', label: 'Offerings', primitive: 'acquisition', hint: 'What this business sells, and its recurring plans.' },
    // Fulfillment
    { key: 'today', label: 'Today', primitive: 'fulfillment', core: true, hint: 'The day planned against the time you actually have.' },
    { key: 'calendar', label: 'Calendar', primitive: 'fulfillment', hint: 'Everything with a date, by day, week or month.' },
    // A shop fulfilling orders has little use for a timesheet; a studio lives on it.
    { key: 'reports', label: 'Reports', primitive: 'fulfillment', defaultFor: ['services', 'code'], hint: 'Time turned into money, and estimate against actual.' },
    // Finance
    { key: 'billing', label: 'Billing', primitive: 'finance', core: true, hint: 'Quotes, invoices and payments.' },
    { key: 'collections', label: 'Collections', primitive: 'finance', hint: 'Who is overdue and who has been flagged.' },
    { key: 'cashflow', label: 'Cash flow', primitive: 'finance', hint: 'What money should arrive over the next eight weeks.' },
    { key: 'expenses', label: 'Expenses', primitive: 'finance', hint: 'What the business spends, against what it earns.' },
    // A shop takes most of its money over a counter; an agency takes none of it that
    // way, so this is off unless the business actually sells to walk-ins.
    { key: 'takings', label: 'Takings', primitive: 'finance', defaultFor: ['products'], hint: 'Card machine and counter sales, and what the fees cost you.' },
    // Admin
    { key: 'files', label: 'Files', primitive: 'admin', hint: 'Contracts and assets, kept next to the work.' },
];
const BY_KEY = new Map(MODULES.map((m) => [m.key, m]));
/** Modules a business type starts with. */
export function defaultModulesFor(type, secondary = []) {
    const types = [type, ...secondary];
    return MODULES
        .filter((m) => m.core || !m.defaultFor || m.defaultFor.some((t) => types.includes(t)))
        .map((m) => m.key);
}
/**
 * What this business actually shows. A stored list wins, but core modules are
 * always added back and unknown keys dropped, so an old or hand-edited list can
 * never leave someone without Billing.
 */
export function effectiveModules(stored, type, secondary = []) {
    const chosen = stored?.length ? stored.filter((k) => BY_KEY.has(k)) : defaultModulesFor(type, secondary);
    const withCore = new Set(chosen);
    for (const m of MODULES)
        if (m.core)
            withCore.add(m.key);
    // Keep registry order so the nav is stable regardless of how it was saved.
    return MODULES.filter((m) => withCore.has(m.key)).map((m) => m.key);
}
//# sourceMappingURL=modules.js.map