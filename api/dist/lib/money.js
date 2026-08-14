/**
 * The one way money becomes a string for the database.
 *
 * Seven files had their own byte-identical copy of this. It looks harmless until
 * one of them is "improved" and money starts rounding differently depending on
 * which route wrote it, which is the sort of bug that shows up as a one-cent
 * discrepancy nobody can reproduce.
 *
 * Rounds to the cent, then fixes two decimals, in that order. toFixed alone
 * rounds half-to-even on some values, so 1.005 would land on 1.00; rounding the
 * cents first gives the answer a person expects from an invoice.
 *
 * Not for display. Anything shown to a human wants a currency and thousands
 * separators, which is a different job and stays with whoever is drawing it.
 */
export const money = (n) => (Math.round(n * 100) / 100).toFixed(2);
/** Whole cents, for anything that bills in them. */
export const cents = (n) => Math.round(n * 100);
//# sourceMappingURL=money.js.map