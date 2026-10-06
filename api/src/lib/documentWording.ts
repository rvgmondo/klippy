/**
 * What a document says at the bottom, and whether it carries the bank details,
 * by type. One rule, used by the on-screen document and the PDF alike, which
 * used to disagree (a quote showed bank details on screen and not in the PDF).
 *
 * - Invoice: the invoice terms, and the bank details to pay into.
 * - Quote: the quote's own terms, else the invoice terms (what quotes always
 *   showed, so nobody's quotes lose their terms the day this ships); bank
 *   details only when the business has asked for them.
 * - Credit note: its own note, or nothing. Payment terms on a credit note ask
 *   the client to pay a document that gives them money back.
 */
type Source = {
  invoiceFooter?: string | null; bankDetails?: string | null;
  quoteFooter?: string | null; quoteShowBank?: boolean | null; creditNoteFooter?: string | null;
} | undefined;

export function documentWording(type: string, business: Source, account: Source): { footer: string | null; bank: string | null } {
  const invoiceFooter = business?.invoiceFooter ?? account?.invoiceFooter ?? null;
  const bank = business?.bankDetails ?? account?.bankDetails ?? null;
  if (type === 'quote') {
    return { footer: business?.quoteFooter || invoiceFooter, bank: business?.quoteShowBank ? bank : null };
  }
  if (type === 'credit_note') return { footer: business?.creditNoteFooter || null, bank: null };
  return { footer: invoiceFooter, bank };
}
