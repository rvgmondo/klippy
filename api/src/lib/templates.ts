/**
 * Starter setups, one per business type.
 *
 * A blank three-pillar structure still leaves someone staring at nothing, wondering
 * what belongs where. Every type here gets the same three things underneath, because
 * every business runs on them: something to deliver, an engine that brings customers
 * in, and the money admin. What differs is the shape, since a services client is not
 * a product order, a software trial, or a piece of content.
 *
 * Deliberately short lists. A starter that arrives with forty cards gets deleted; one
 * with five gets used.
 */

export type BusinessType = 'services' | 'products' | 'code' | 'content';

export interface SeedCard { title: string; description?: string; column?: number }
export interface TemplateBoard { name: string; description: string; cards: SeedCard[] }
export interface TemplateArea { name: string; notes: string; boards: TemplateBoard[] }
export interface Template {
  /** Client-facing work: one worked example of the thing this business delivers. */
  delivery: TemplateArea[];
  /** The internal machine: how customers arrive, and how the money is handled. */
  operations: TemplateArea[];
  deals: { title: string; company?: string; value: number; stage: 'lead' | 'contacted' | 'proposal'; notes: string }[];
  offerings: { name: string; price: number; cost?: number; unit?: string; recurring?: boolean; stockQty?: number; reorderPoint?: number }[];
}

/** Every business bills, chases and reviews. Only the first card differs. */
const moneyBoard = (firstCard: string): TemplateBoard => ({
  name: 'Money',
  description: 'Getting paid, and knowing what is left.',
  cards: [
    { title: firstCard },
    { title: 'Chase anything overdue' },
    { title: 'Log this month of expenses', description: 'Expenses feed the profit figure in Reports.' },
    { title: 'Weekly numbers review', description: 'Fifteen minutes on the three pillars: what came in, what shipped, what it cost.' },
    { title: 'Put money aside for tax' },
  ],
});

export const TEMPLATES: Record<BusinessType, Template> = {
  services: {
    delivery: [{
      name: 'Sample Client',
      notes: 'An example client, so Delivery is not empty. Rename it to a real one or delete it.',
      boards: [{
        name: 'Client Delivery',
        description: 'The same run of work for every client, so nothing gets skipped.',
        cards: [
          { title: 'Kickoff call and written brief', description: 'Agree the outcome, the deadline, and what you need from them.' },
          { title: 'Do the work' },
          { title: 'Review with the client' },
          { title: 'Deliver and invoice' },
          { title: 'Ask for a testimonial and a referral', description: 'The easiest sale you will make is to someone referred by a person who just got a result.' },
        ],
      }],
    }],
    operations: [
      {
        name: 'Getting Clients',
        notes: 'The engine that fills the pipeline. Work this even when you are busy.',
        boards: [{
          name: 'Acquisition',
          description: 'Something free and useful, put in front of people who have the problem.',
          cards: [
            { title: 'Build the free thing you lead with', description: 'An audit, a teardown, a first session. Useful on its own, and it shows what working with you is like.' },
            { title: 'List 30 people who already know you' },
            { title: 'Send the offer to all 30' },
            { title: 'Follow up four times', description: 'Most work is won in the follow up. A no is usually a not yet.' },
            { title: 'Publish one piece of proof a week', description: 'A before and after, a result, a testimonial.' },
          ],
        }],
      },
      { name: 'Finance', notes: 'Invoices, costs, and the weekly look at the numbers.', boards: [moneyBoard('Send this week of invoices')] },
      {
        name: 'Admin',
        notes: 'The dull things that bite when ignored.',
        boards: [{
          name: 'Running the business',
          description: 'Tools, contracts, backups.',
          cards: [
            { title: 'Review tools and subscriptions', description: 'Cancel what you stopped using.' },
            { title: 'Check backups actually restore' },
            { title: 'Contracts and insurance up to date' },
          ],
        }],
      },
    ],
    deals: [
      { title: 'Referral from a past client', value: 7500, stage: 'lead', notes: 'Warm leads close fastest. Reply the same day.' },
      { title: 'Discovery call booked', company: 'Example Co', value: 12000, stage: 'contacted', notes: 'Confirm the call and send an agenda beforehand.' },
      { title: 'Proposal sent', company: 'Sample Ltd', value: 25000, stage: 'proposal', notes: 'Follow up in two days if you hear nothing.' },
    ],
    offerings: [
      { name: 'Discovery Audit', price: 750, unit: 'project' },
      { name: 'Monthly Retainer', price: 7500, unit: 'month', recurring: true },
    ],
  },

  products: {
    delivery: [{
      name: 'Sample Order',
      notes: 'An example order. Delivery here means fulfilment, not projects.',
      boards: [{
        name: 'Fulfilment',
        description: 'From paid to delivered.',
        cards: [
          { title: 'Order placed and paid' },
          { title: 'Pick, pack and label' },
          { title: 'Ship and send tracking' },
          { title: 'Follow up and ask for a review', description: 'Reviews are what sell the next one.' },
        ],
      }],
    }],
    operations: [
      {
        name: 'Getting Buyers',
        notes: 'Listings, ads, and the reviews that make them work.',
        boards: [{
          name: 'Acquisition',
          description: 'Where buyers find you, and why they trust you.',
          cards: [
            { title: 'Write the product page properly', description: 'Photos, the problem it solves, and the objection it removes.' },
            { title: 'Run the first ad or post' },
            { title: 'Collect reviews from early buyers' },
            { title: 'Start an email list for repeat buyers' },
          ],
        }],
      },
      {
        name: 'Stock and Suppliers',
        notes: 'Nothing kills a product business faster than running out.',
        boards: [{
          name: 'Inventory',
          description: 'What you hold, what is running low, and who supplies it.',
          cards: [
            { title: 'Reorder anything below its reorder point', description: 'Offerings tracks stock and reorder points for you.' },
            { title: 'Supplier contacts and lead times' },
            { title: 'Monthly stock count' },
          ],
        }],
      },
      { name: 'Finance', notes: 'Margins, costs, and the weekly look at the numbers.', boards: [moneyBoard('Record cost of goods sold')] },
    ],
    deals: [
      { title: 'Wholesale enquiry', company: 'Example Retailer', value: 15000, stage: 'lead', notes: 'Ask what volume, and how often.' },
      { title: 'Bulk order quote sent', company: 'Sample Stockist', value: 40000, stage: 'proposal', notes: 'Include price breaks for larger volumes.' },
    ],
    offerings: [
      { name: 'Sample Product', price: 250, cost: 90, unit: 'unit', stockQty: 20, reorderPoint: 5 },
    ],
  },

  code: {
    delivery: [{
      name: 'Sample Customer',
      notes: 'An example customer. Delivery here means getting them to value, fast.',
      boards: [{
        name: 'Customer Onboarding',
        description: 'Trial to paying, without them getting stuck.',
        cards: [
          { title: 'Signed up for a trial' },
          { title: 'Account set up and configured' },
          { title: 'Reached first real value', description: 'The moment the product actually helps. Everything before this is churn risk.' },
          { title: 'Converted to paid' },
        ],
      }],
    }],
    operations: [
      {
        name: 'Getting Users',
        notes: 'How people find the product, and decide to try it.',
        boards: [{
          name: 'Acquisition',
          description: 'Landing page, onboarding emails, proof.',
          cards: [
            { title: 'Landing page says what it does in one line' },
            { title: 'Onboarding emails for new signups' },
            { title: 'Collect testimonials from happy users' },
            { title: 'Talk to five users who did not convert', description: 'They will tell you exactly what to fix.' },
          ],
        }],
      },
      {
        name: 'Product',
        notes: 'Building it, and keeping it running.',
        boards: [{
          name: 'Build',
          description: 'What ships next, and what is broken.',
          cards: [
            { title: 'Next feature' },
            { title: 'Bug triage' },
            { title: 'Write the release notes' },
          ],
        }],
      },
      { name: 'Finance', notes: 'Recurring revenue, costs, and the weekly look at the numbers.', boards: [moneyBoard('Check monthly recurring revenue')] },
    ],
    deals: [
      { title: 'Trial signup worth chasing', company: 'Example Startup', value: 588, stage: 'lead', notes: 'Reach out while they are still in the trial.' },
      { title: 'Demo booked', company: 'Sample Team', value: 2400, stage: 'contacted', notes: 'Ask what they use today, and what it costs them.' },
    ],
    offerings: [
      { name: 'Pro Plan', price: 49, unit: 'month', recurring: true },
      { name: 'Setup and migration', price: 500, unit: 'project' },
    ],
  },

  content: {
    delivery: [{
      name: 'Sample Piece',
      notes: 'An example piece. Delivery here means production.',
      boards: [{
        name: 'Production',
        description: 'Idea to published.',
        cards: [
          { title: 'Idea and outline' },
          { title: 'Draft' },
          { title: 'Edit' },
          { title: 'Publish and promote' },
        ],
      }],
    }],
    operations: [
      {
        name: 'Audience',
        notes: 'Growing the thing sponsors are actually paying for.',
        boards: [{
          name: 'Growth',
          description: 'Publishing rhythm, and the work around it.',
          cards: [
            { title: 'Set a posting schedule you can keep' },
            { title: 'Repurpose the best performing piece' },
            { title: 'Reply to comments and messages' },
          ],
        }],
      },
      {
        name: 'Sponsors',
        notes: 'Turning attention into revenue.',
        boards: [{
          name: 'Monetisation',
          description: 'Media kit, outreach, and delivering what was sold.',
          cards: [
            { title: 'Build a media kit', description: 'Audience size, engagement, who they are, and what a slot costs.' },
            { title: 'Approach ten relevant sponsors' },
            { title: 'Deliver and report on sponsor spots' },
          ],
        }],
      },
      { name: 'Finance', notes: 'Invoices, kit costs, and the weekly look at the numbers.', boards: [moneyBoard('Invoice sponsors')] },
    ],
    deals: [
      { title: 'Sponsor enquiry', company: 'Example Brand', value: 5000, stage: 'lead', notes: 'Send the media kit and a rate.' },
      { title: 'Brand deal in discussion', company: 'Sample Brand', value: 12000, stage: 'contacted', notes: 'Agree deliverables and usage rights in writing.' },
    ],
    offerings: [
      { name: 'Sponsored slot', price: 5000, unit: 'post' },
      { name: 'Monthly partnership', price: 15000, unit: 'month', recurring: true },
    ],
  },
};
