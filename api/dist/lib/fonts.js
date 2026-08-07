/**
 * The typefaces a business may use.
 *
 * This mirrors web/src/lib/fonts.ts on purpose. The family name ends up
 * interpolated into CSS and into a request to Google, so the SERVER decides what
 * is acceptable; validating only in the browser would mean anyone posting straight
 * to the API could store arbitrary text that later renders as CSS for their
 * colleagues.
 *
 * Keep the two lists in step. If they drift, the server wins and the odd family is
 * simply refused on save.
 */
export const ALLOWED_FONTS = [
    'Bricolage Grotesque', 'Hanken Grotesk', 'Inter', 'Manrope', 'DM Sans',
    'Plus Jakarta Sans', 'Outfit', 'Space Grotesk', 'Sora', 'Poppins',
    'Work Sans', 'Figtree', 'Playfair Display', 'Fraunces', 'Lora',
    'Source Serif 4', 'IBM Plex Sans', 'Libre Franklin', 'Nunito Sans', 'Rubik',
];
const SET = new Set(ALLOWED_FONTS);
export function isAllowedFont(family) {
    return typeof family === 'string' && SET.has(family);
}
//# sourceMappingURL=fonts.js.map