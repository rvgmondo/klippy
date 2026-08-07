/**
 * The typefaces a business can wear.
 *
 * A curated list rather than a free-text box, for two reasons. A family name is
 * interpolated into CSS and requested from Google, so accepting arbitrary text
 * invites both style injection and a request to anywhere; and a list of twenty
 * good pairings is a kinder choice than a search box over a thousand fonts, most
 * of which have no business on an invoice.
 *
 * Each entry names the weights Klippy actually uses, so a business loads two
 * families rather than the whole foundry.
 */

export interface FontDef {
  /** The Google Fonts family name, used verbatim in CSS and in the request. */
  family: string;
  /** Which roles it suits: headings, body text, or both. */
  roles: ('display' | 'body')[];
  note: string;
}

export const FONTS: FontDef[] = [
  { family: 'Bricolage Grotesque', roles: ['display'], note: 'The Klippy default. Characterful, a bit editorial.' },
  { family: 'Hanken Grotesk', roles: ['display', 'body'], note: 'The Klippy default for body. Clean and quiet.' },
  { family: 'Inter', roles: ['display', 'body'], note: 'Neutral and modern. Safe anywhere.' },
  { family: 'Manrope', roles: ['display', 'body'], note: 'Geometric, friendly, slightly technical.' },
  { family: 'DM Sans', roles: ['display', 'body'], note: 'Soft, low contrast, easy to read small.' },
  { family: 'Plus Jakarta Sans', roles: ['display', 'body'], note: 'Confident and contemporary.' },
  { family: 'Outfit', roles: ['display', 'body'], note: 'Rounded geometric. Reads as approachable.' },
  { family: 'Space Grotesk', roles: ['display'], note: 'Quirky and technical. Good for a studio.' },
  { family: 'Sora', roles: ['display'], note: 'Squarish and assertive. Good for software.' },
  { family: 'Poppins', roles: ['display', 'body'], note: 'Geometric and popular. Very legible.' },
  { family: 'Work Sans', roles: ['display', 'body'], note: 'Sturdy and plain. Ages well.' },
  { family: 'Figtree', roles: ['display', 'body'], note: 'Warm and rounded without being cute.' },
  { family: 'Playfair Display', roles: ['display'], note: 'High contrast serif. Luxury, editorial.' },
  { family: 'Fraunces', roles: ['display'], note: 'Characterful serif with a bit of wobble.' },
  { family: 'Lora', roles: ['display', 'body'], note: 'Readable serif. Good for long text.' },
  { family: 'Source Serif 4', roles: ['display', 'body'], note: 'Classic serif that works at small sizes.' },
  { family: 'IBM Plex Sans', roles: ['display', 'body'], note: 'Corporate but human. Very neutral.' },
  { family: 'Libre Franklin', roles: ['display', 'body'], note: 'American gothic. Newsy and solid.' },
  { family: 'Nunito Sans', roles: ['display', 'body'], note: 'Soft and friendly. Good for services.' },
  { family: 'Rubik', roles: ['display', 'body'], note: 'Slightly rounded, a little playful.' },
];

const BY_FAMILY = new Map(FONTS.map((f) => [f.family, f]));

/** Only a family from the list is ever allowed through. */
export function isAllowedFont(family: string | null | undefined): boolean {
  return !!family && BY_FAMILY.has(family);
}

export const fontsFor = (role: 'display' | 'body') => FONTS.filter((f) => f.roles.includes(role));

/** Families the app has already asked Google for, so we ask once. */
const loaded = new Set<string>();

/**
 * Load a family from Google Fonts, once. Ignores anything not on the list, so a
 * stale or hand-edited value cannot cause an arbitrary request.
 */
export function loadFont(family: string | null | undefined): void {
  if (!isAllowedFont(family) || loaded.has(family!)) return;
  loaded.add(family!);
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  const spec = `${family!.replace(/ /g, '+')}:wght@400;500;600;700`;
  link.href = `https://fonts.googleapis.com/css2?family=${spec}&display=swap`;
  document.head.appendChild(link);
}
