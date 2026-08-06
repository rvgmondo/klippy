import type { BusinessType } from './templates.js';
import { defaultModulesFor } from './modules.js';

/**
 * Blueprints: what a new business is provisioned with.
 *
 * The four business TYPES decide the shape of the starter content (a services
 * client is not a product order). An ARCHETYPE is a named preset on top of that:
 * "Web hosting" is a services business, but it bills annually, chases hard, and has
 * no use for a timesheet. Picking one on the way in means the app is already
 * arranged for how that business actually runs, rather than something to configure
 * afterwards.
 *
 * Declarative on purpose: a blueprint is data, so adding one is a few lines here
 * and nothing else. Anything omitted falls back to the type's defaults.
 */

export interface Blueprint {
  key: string;
  label: string;
  /** The starter content and default module set come from this. */
  type: BusinessType;
  blurb: string;
  /** Overrides the type's default modules when given. */
  modules?: string[];
  /** Invoicing defaults, for businesses that bill in a particular way. */
  invoicing?: { defaultTaxRate?: number; defaultDueDays?: number };
  /** Reminder schedule: days relative to due, and when to flag as at risk. */
  reminders?: { offsets?: number[]; suspendAfterDays?: number | null };
}

export const BLUEPRINTS: Blueprint[] = [
  {
    key: 'agency',
    label: 'Agency or studio',
    type: 'services',
    blurb: 'Client projects billed by the hour or by the job. Time tracking matters.',
    invoicing: { defaultDueDays: 14 },
  },
  {
    key: 'consultant',
    label: 'Consultant or freelancer',
    type: 'services',
    blurb: 'A handful of clients, retainers, and not much admin.',
    invoicing: { defaultDueDays: 7 },
    reminders: { offsets: [-3, 0, 7, 14] },
  },
  {
    key: 'hosting',
    label: 'Hosting or recurring services',
    type: 'services',
    blurb: 'Subscriptions that renew yearly, invoices that must chase themselves.',
    // Recurring service work is not billed by the hour, so the timesheet report
    // only gets in the way. Collections matters far more than it usually does.
    modules: ['pipeline', 'offerings', 'today', 'calendar', 'billing', 'collections', 'expenses', 'files'],
    invoicing: { defaultDueDays: 7 },
    reminders: { offsets: [-7, -1, 0, 7, 14], suspendAfterDays: 21 },
  },
  {
    key: 'ecommerce',
    label: 'Shop or e-commerce',
    type: 'products',
    blurb: 'Stock, orders and margins. No timesheets.',
    invoicing: { defaultDueDays: 0 },
  },
  {
    key: 'saas',
    label: 'Software or SaaS',
    type: 'code',
    blurb: 'Releases, subscriptions and support, with recurring revenue at the centre.',
    invoicing: { defaultDueDays: 7 },
  },
  {
    key: 'creator',
    label: 'Content or creator',
    type: 'content',
    blurb: 'A publishing calendar, sponsors and briefs.',
    invoicing: { defaultDueDays: 14 },
  },
];

const BY_KEY = new Map(BLUEPRINTS.map((b) => [b.key, b]));

export function blueprint(key: string | undefined | null): Blueprint | undefined {
  return key ? BY_KEY.get(key) : undefined;
}

/** What a business created from this blueprint should be set up with. */
export function provisionFrom(bp: Blueprint) {
  return {
    type: bp.type,
    modules: bp.modules ?? defaultModulesFor(bp.type),
    defaultDueDays: bp.invoicing?.defaultDueDays,
    defaultTaxRate: bp.invoicing?.defaultTaxRate,
    reminderOffsets: bp.reminders?.offsets,
    suspendAfterDays: bp.reminders?.suspendAfterDays,
  };
}
