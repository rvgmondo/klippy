/**
 * The shapes and the money formatter that the billing screens agree on.
 *
 * Pulled out because BillingView had grown to five components in one 756-line
 * file, and a patch aimed at one of them twice landed in another this week: once
 * on a close button, once on an error message. Types that several files share
 * should not live inside one of them.
 */
export interface TreeFolder { id: number; parentId: number | null; name: string }

export type DocType = 'quote' | 'invoice';
export type Status = 'draft' | 'sent' | 'accepted' | 'paid' | 'void';

export interface DocSummary {
  id: number; type: DocType; number: string; clientName: string;
  issueDate: string; dueDate: string | null; status: Status; currency: string; total: string;
}
export interface Line {
  description: string; quantity: number; unitPrice: number;
  /** The longer wording under the title, printed on the document. Usually blank. */
  detail?: string | null;
  /** What is being sold, when it comes from the catalogue. */
  offeringId?: number | null;
  /** Bills again every N months. Null or absent is a one-off. */
  recurringMonths?: number | null;
}
export type DiscountType = 'none' | 'percent' | 'amount';
export interface FullDoc {
  document: DocSummary & {
    clientEmail: string | null; clientAddress: string | null; clientVatNumber: string | null; taxRate: string;
    /** The client this belongs to, so editing keeps the link rather than dropping it. */
    folderId: number | null;
    discountType: DiscountType; discountValue: string; discountAmount: string;
    subtotal: string; taxAmount: string; notes: string | null;
  };
  lines: (Line & { amount: string })[];
  brand: { name: string; hasLogo: boolean; logoUrl: string | null };
  issuer: {
    name: string; logoUrl: string | null; address: string | null; taxNumber: string | null; regNumber: string | null;
    bankDetails: string | null; footer: string | null; accent: string; vatRegistered: boolean;
    fontDisplay: string | null; fontBody: string | null;
    headerHtml: string | null; footerHtml: string | null;
  };
}

export const STATUS_COLOR: Record<Status, string> = {
  draft: 'bg-slate-700 text-slate-200', sent: 'bg-blue-600/30 text-blue-200',
  accepted: 'bg-violet-600/30 text-violet-200', paid: 'bg-green-600/30 text-green-200',
  void: 'bg-slate-800 text-slate-500 line-through',
};

export { money } from '../lib/money';
