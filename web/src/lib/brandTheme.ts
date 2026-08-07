/**
 * Per-business theming.
 *
 * The design system re-skins the whole app by re-pointing Tailwind's violet ramp
 * at CSS variables (see index.css). The six built-in accents do that with static
 * `[data-accent="..."]` rules, but a business's brand colour is an arbitrary hex,
 * so we derive the same ramp at runtime and write it as inline custom properties
 * on <html>. Inline style beats the attribute rules, so focusing a business skins
 * every screen in its colour; clearing it falls straight back to the person's own
 * accent with nothing left behind.
 */

import { isAllowedFont, loadFont } from './fonts.js';

type Rgb = { r: number; g: number; b: number };

/** The custom properties we set, so clearing removes exactly what we added. */
const VARS = [
  '--accent', '--accent-ink', '--accent-quiet',
  '--color-violet-700', '--color-violet-600', '--color-violet-500',
  '--color-violet-400', '--color-violet-300', '--color-violet-200',
] as const;

function parseHex(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1]!;
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

const toHex = ({ r, g, b }: Rgb) =>
  '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');

/** WCAG relative luminance, used to decide dark-vs-white text on the accent fill. */
function luminance({ r, g, b }: Rgb): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

const mix = (c: Rgb, target: Rgb, amount: number): Rgb => ({
  r: c.r + (target.r - c.r) * amount,
  g: c.g + (target.g - c.g) * amount,
  b: c.b + (target.b - c.b) * amount,
});
const lighten = (c: Rgb, amount: number) => mix(c, { r: 255, g: 255, b: 255 }, amount);
const darken = (c: Rgb, amount: number) => mix(c, { r: 0, g: 0, b: 0 }, amount);

/** WCAG contrast ratio between two colours. */
function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** Solve a little above AA (4.5:1), since rounding back to hex shaves the ratio. */
const AA_TARGET = 4.75;

/**
 * The surface accent text sits on. We take the HARDEST surface in each mode: the
 * LIGHTEST card in dark mode and the DARKEST card in light mode (both slate-800),
 * because those are the ones closest to the text. Clearing here clears everywhere.
 */
const SURFACE: Record<'dark' | 'light', Rgb> = {
  dark: { r: 0x24, g: 0x29, b: 0x32 },
  light: { r: 0xe4, g: 0xe7, b: 0xeb },
};

/**
 * Nudge a colour toward white (dark mode) or black (light mode) until it clears
 * `target` against the surface. Brand colours are arbitrary, so guessing fixed
 * percentages fails at the extremes (a navy brand stays invisible on charcoal, a
 * near-white one washes out on white). Solving for the ratio always lands.
 */
function readable(base: Rgb, mode: 'dark' | 'light', target = AA_TARGET): Rgb {
  const surface = SURFACE[mode];
  const toward: Rgb = mode === 'dark' ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 };
  if (contrast(base, surface) >= target) return base;
  let lo = 0, hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (contrast(mix(base, toward, mid), surface) >= target) hi = mid; else lo = mid;
  }
  return mix(base, toward, hi);
}

/**
 * Build the accent ramp for a brand colour.
 *
 * Fills (700/600/500) stay close to the brand so it still looks like the brand.
 * The pale shades (400/300/200) are used as accent TEXT, so they are solved to
 * clear AA against the surface in the current mode rather than offset by a fixed
 * amount. Ink is whichever of white or a near-black tint reads better on the fill.
 */
export function brandRamp(hex: string, mode: 'dark' | 'light') {
  const base = parseHex(hex);
  if (!base) return null;

  // Text ON the accent fill: take the better of white or a deep tint of the brand,
  // then deepen it if the brand sits in the awkward mid range where neither wins.
  const white: Rgb = { r: 255, g: 255, b: 255 };
  const inkCandidates: Rgb[] = [white, { r: 0, g: 0, b: 0 }];
  for (let amount = 0.8; amount <= 1.0001; amount += 0.04) inkCandidates.push(darken(base, amount));
  // Whichever reads best on the fill wins. A mid-tone brand (a strong red) is the
  // awkward case where neither pure white nor pure black clears AA comfortably, so
  // taking the maximum is the only honest answer.
  const ink = inkCandidates.reduce((best, c) => (contrast(base, c) > contrast(base, best) ? c : best));

  const bright = luminance(base) > 0.4;
  // Fills keep the brand's character: a bright brand fills at the base, a deep one
  // fills slightly darkened so its lighter mid tone can carry the base.
  const fills = bright
    ? { 700: darken(base, 0.28), 600: base, 500: lighten(base, 0.06) }
    : { 700: darken(base, 0.28), 600: darken(base, 0.12), 500: base };

  // Text shades: the first must clear AA, the softer two are stepped further in the
  // same direction so the hierarchy survives, never back below the readable point.
  const t400 = readable(base, mode);
  const step = mode === 'dark' ? lighten : darken;
  const ramp = { ...fills, 400: t400, 300: step(t400, 0.14), 200: step(t400, 0.26) };

  return {
    accent: toHex(base),
    accentInk: toHex(ink),
    accentQuiet: `rgba(${Math.round(base.r)}, ${Math.round(base.g)}, ${Math.round(base.b)}, .14)`,
    ramp: Object.fromEntries(Object.entries(ramp).map(([k, v]) => [k, toHex(v)])) as Record<string, string>,
  };
}

/**
 * Wear a business's typefaces. Each family is fetched from Google once, then the
 * two CSS variables are re-pointed; passing null for both restores the house
 * fonts. Anything not on the curated list is ignored rather than injected.
 */
export function applyBrandFonts(display: string | null | undefined, body: string | null | undefined): void {
  const root = document.documentElement;
  const set = (varName: string, family: string | null | undefined) => {
    if (!isAllowedFont(family)) { root.style.removeProperty(varName); return; }
    loadFont(family);
    // Quoted, so a family with spaces is a single CSS token.
    root.style.setProperty(varName, `"${family}"`);
  };
  set('--font-display', display);
  set('--font-body', body);
}

/** Skin the app in a business's brand colour. Pass null to hand control back. */
export function applyBrandTheme(hex: string | null | undefined) {
  const root = document.documentElement;
  if (!hex) {
    for (const v of VARS) root.style.removeProperty(v);
    return;
  }
  const mode = root.dataset.theme === 'light' ? 'light' : 'dark';
  const built = brandRamp(hex, mode);
  if (!built) {
    for (const v of VARS) root.style.removeProperty(v);
    return;
  }
  root.style.setProperty('--accent', built.accent);
  root.style.setProperty('--accent-ink', built.accentInk);
  root.style.setProperty('--accent-quiet', built.accentQuiet);
  for (const shade of ['700', '600', '500', '400', '300', '200']) {
    root.style.setProperty(`--color-violet-${shade}`, built.ramp[shade]!);
  }
}
