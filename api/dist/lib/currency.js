/**
 * What money is, everywhere in Klippy.
 *
 * Klippy sells outside South Africa, so "the amount" is never a bare number: it is
 * a number plus the currency it is denominated in, and the two have to travel
 * together. The rand assumption used to be spread across a dozen files as
 * `?? 'ZAR'` fallbacks and two hardcoded `R ` prefixes; this module is the one
 * place that knows anything about currencies, so there is a single answer to
 * "how many decimals does this have" and "what do we call it".
 *
 * Deliberately NOT here: exchange rates. Klippy never converts. A workspace
 * billing in two currencies sees two totals, not one invented one. Rates move
 * daily, the right rate depends on the date and the purpose (invoice date, payment
 * date, tax authority's published rate), and quietly picking one would produce
 * confident numbers that are wrong in a way nobody could audit.
 */
/**
 * The currencies Klippy offers.
 *
 * Curated rather than the full ISO 4217 list: a picker with 180 entries, most of
 * them non-convertible or defunct, is worse at the actual job of finding your own
 * currency. This covers the places software is bought.
 */
export const CURRENCIES = [
    { code: 'AED', name: 'UAE Dirham', symbol: 'AED', decimals: 2 },
    { code: 'ARS', name: 'Argentine Peso', symbol: '$', decimals: 2 },
    { code: 'AUD', name: 'Australian Dollar', symbol: 'A$', decimals: 2 },
    { code: 'BHD', name: 'Bahraini Dinar', symbol: 'BD', decimals: 3 },
    { code: 'BRL', name: 'Brazilian Real', symbol: 'R$', decimals: 2 },
    { code: 'BWP', name: 'Botswana Pula', symbol: 'P', decimals: 2 },
    { code: 'CAD', name: 'Canadian Dollar', symbol: 'C$', decimals: 2 },
    { code: 'CHF', name: 'Swiss Franc', symbol: 'CHF', decimals: 2 },
    { code: 'CLP', name: 'Chilean Peso', symbol: '$', decimals: 0 },
    { code: 'CNY', name: 'Chinese Yuan', symbol: '¥', decimals: 2 },
    { code: 'COP', name: 'Colombian Peso', symbol: '$', decimals: 2 },
    { code: 'CZK', name: 'Czech Koruna', symbol: 'Kč', decimals: 2 },
    { code: 'DKK', name: 'Danish Krone', symbol: 'kr', decimals: 2 },
    { code: 'EGP', name: 'Egyptian Pound', symbol: 'E£', decimals: 2 },
    { code: 'EUR', name: 'Euro', symbol: '€', decimals: 2 },
    { code: 'GBP', name: 'Pound Sterling', symbol: '£', decimals: 2 },
    { code: 'GHS', name: 'Ghanaian Cedi', symbol: 'GH₵', decimals: 2 },
    { code: 'HKD', name: 'Hong Kong Dollar', symbol: 'HK$', decimals: 2 },
    { code: 'HUF', name: 'Hungarian Forint', symbol: 'Ft', decimals: 2 },
    { code: 'IDR', name: 'Indonesian Rupiah', symbol: 'Rp', decimals: 2 },
    { code: 'ILS', name: 'Israeli New Shekel', symbol: '₪', decimals: 2 },
    { code: 'INR', name: 'Indian Rupee', symbol: '₹', decimals: 2 },
    { code: 'JPY', name: 'Japanese Yen', symbol: '¥', decimals: 0 },
    { code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', decimals: 2 },
    { code: 'KRW', name: 'South Korean Won', symbol: '₩', decimals: 0 },
    { code: 'KWD', name: 'Kuwaiti Dinar', symbol: 'KD', decimals: 3 },
    { code: 'MAD', name: 'Moroccan Dirham', symbol: 'MAD', decimals: 2 },
    { code: 'MUR', name: 'Mauritian Rupee', symbol: 'Rs', decimals: 2 },
    { code: 'MXN', name: 'Mexican Peso', symbol: 'MX$', decimals: 2 },
    { code: 'MYR', name: 'Malaysian Ringgit', symbol: 'RM', decimals: 2 },
    { code: 'MZN', name: 'Mozambican Metical', symbol: 'MT', decimals: 2 },
    { code: 'NAD', name: 'Namibian Dollar', symbol: 'N$', decimals: 2 },
    { code: 'NGN', name: 'Nigerian Naira', symbol: '₦', decimals: 2 },
    { code: 'NOK', name: 'Norwegian Krone', symbol: 'kr', decimals: 2 },
    { code: 'NZD', name: 'New Zealand Dollar', symbol: 'NZ$', decimals: 2 },
    { code: 'PHP', name: 'Philippine Peso', symbol: '₱', decimals: 2 },
    { code: 'PKR', name: 'Pakistani Rupee', symbol: 'Rs', decimals: 2 },
    { code: 'PLN', name: 'Polish Zloty', symbol: 'zł', decimals: 2 },
    { code: 'QAR', name: 'Qatari Riyal', symbol: 'QR', decimals: 2 },
    { code: 'RON', name: 'Romanian Leu', symbol: 'lei', decimals: 2 },
    { code: 'SAR', name: 'Saudi Riyal', symbol: 'SR', decimals: 2 },
    { code: 'SEK', name: 'Swedish Krona', symbol: 'kr', decimals: 2 },
    { code: 'SGD', name: 'Singapore Dollar', symbol: 'S$', decimals: 2 },
    { code: 'THB', name: 'Thai Baht', symbol: '฿', decimals: 2 },
    { code: 'TRY', name: 'Turkish Lira', symbol: '₺', decimals: 2 },
    { code: 'TZS', name: 'Tanzanian Shilling', symbol: 'TSh', decimals: 2 },
    { code: 'UAH', name: 'Ukrainian Hryvnia', symbol: '₴', decimals: 2 },
    { code: 'USD', name: 'US Dollar', symbol: '$', decimals: 2 },
    { code: 'VND', name: 'Vietnamese Dong', symbol: '₫', decimals: 0 },
    { code: 'ZAR', name: 'South African Rand', symbol: 'R', decimals: 2 },
    { code: 'ZMW', name: 'Zambian Kwacha', symbol: 'K', decimals: 2 },
];
const BY_CODE = new Map(CURRENCIES.map((c) => [c.code, c]));
/** The workspace default when nothing has been chosen. */
export const DEFAULT_CURRENCY = 'ZAR';
export function currencyInfo(code) {
    return BY_CODE.get((code ?? '').toUpperCase())
        ?? { code: (code || DEFAULT_CURRENCY).toUpperCase(), name: (code || DEFAULT_CURRENCY).toUpperCase(), symbol: (code || DEFAULT_CURRENCY).toUpperCase(), decimals: 2 };
}
/**
 * True if this is a currency we know about.
 *
 * Unknown codes are still accepted everywhere and treated as two-decimal, because
 * refusing to render an invoice over an unrecognised code would be a worse failure
 * than showing it slightly wrong. This exists so settings can reject a typo at the
 * point it is entered, which is the only place it can be fixed cheaply.
 */
export function isKnownCurrency(code) {
    return BY_CODE.has(code.toUpperCase());
}
export function decimalsFor(code) {
    return currencyInfo(code).decimals;
}
/**
 * Round an amount to what the currency can actually express.
 *
 * A yen invoice for 1150.50 cannot be paid: there is no half yen. Rounding at the
 * point a total is computed, rather than hiding it at display time, keeps the
 * stored figure and the figure the client is asked for identical, which is what
 * reconciliation depends on.
 */
export function roundMoney(n, code) {
    const f = 10 ** decimalsFor(code);
    return Math.round(n * f) / f;
}
/**
 * How an amount reads on a document.
 *
 * ISO code rather than symbol, on purpose: `$1,200` is four different amounts
 * depending on whether the sender is in Washington, Sydney, Toronto or Santiago,
 * and an invoice crossing a border has to be unambiguous. Deterministic too, with
 * no dependence on the server's locale, so the same invoice renders identically
 * wherever it is generated.
 */
export function formatMoney(v, code) {
    const n = typeof v === 'string' ? Number(v) : v;
    const info = currencyInfo(code);
    const fixed = (Number.isFinite(n) ? n : 0).toFixed(info.decimals);
    const [whole = '0', frac] = fixed.split('.');
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return `${info.code} ${frac ? `${grouped}.${frac}` : grouped}`;
}
/**
 * Currencies PayFast can settle.
 *
 * PayFast is a South African gateway and takes rand only. A business invoicing in
 * dollars that had a PayFast key configured would otherwise get a "Pay online"
 * button that either fails at the gateway or, worse, charges the number as rand.
 * Every path that offers online payment checks this first.
 */
export function payfastSupports(code) {
    return (code ?? DEFAULT_CURRENCY).toUpperCase() === 'ZAR';
}
//# sourceMappingURL=currency.js.map