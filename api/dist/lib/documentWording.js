export function documentWording(type, business, account) {
    const invoiceFooter = business?.invoiceFooter ?? account?.invoiceFooter ?? null;
    const bank = business?.bankDetails ?? account?.bankDetails ?? null;
    if (type === 'quote') {
        return { footer: business?.quoteFooter || invoiceFooter, bank: business?.quoteShowBank ? bank : null };
    }
    if (type === 'credit_note')
        return { footer: business?.creditNoteFooter || null, bank: null };
    return { footer: invoiceFooter, bank };
}
//# sourceMappingURL=documentWording.js.map