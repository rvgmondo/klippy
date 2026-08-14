/**
 * How an amount is written on screen.
 *
 * Six files had their own copy of this and two of them just prefixed a rand sign,
 * which meant a workspace billing in dollars saw its expenses and its price list
 * labelled in rand. One helper, one answer.
 *
 * Intl does the real work, and it is worth using rather than hand-rolling: it
 * knows that yen has no decimals and dinars have three, and it groups digits the
 * way the reader's own locale does. The fallback covers a currency code Intl does
 * not recognise, which should not happen but must not blank out a total if it does.
 */
export function money(v: number | string | null | undefined, currency: string): string {
  const n = typeof v === 'string' ? Number(v) : (v ?? 0);
  const safe = Number.isFinite(n) ? n : 0;
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(safe);
  } catch {
    return `${currency} ${safe.toFixed(2)}`;
  }
}

/**
 * The same, with the decimals dropped.
 *
 * For headline figures where the cents are noise: a dashboard reading R 1,2 m does
 * not need to be exact to the cent, and the extra digits cost more in width than
 * they add in meaning. Only ever used where an exact figure is one click away.
 */
export function moneyRound(v: number | string | null | undefined, currency: string): string {
  const n = typeof v === 'string' ? Number(v) : (v ?? 0);
  const safe = Number.isFinite(n) ? n : 0;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency', currency, maximumFractionDigits: 0,
    }).format(safe);
  } catch {
    return `${currency} ${Math.round(safe)}`;
  }
}

export interface CurrencyOption { code: string; name: string; symbol: string; decimals: number }
