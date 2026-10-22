/**
 * Colour handling for the composer: the REAL brand colours are the source; everything else is a tint or shade of them
 * (a deep tone for text panels, a soft tint for backgrounds) so a design looks like the brand, not like a template.
 * With no brand colour configured a neutral professional palette is used and the composition says so.
 */

export function parseColor(value) {
  const m = String(value || '').trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

export const toHex = ({ r, g, b }) => `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;

const lin = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
export function luminance(hex) {
  const c = parseColor(hex);
  return c ? 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b) : 0;
}
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export function mix(a, b, t) {
  const x = parseColor(a); const y = parseColor(b);
  if (!x || !y) return a;
  return toHex({ r: x.r + (y.r - x.r) * t, g: x.g + (y.g - x.g) * t, b: x.b + (y.b - x.b) * t });
}
export const darken = (hex, t) => mix(hex, '#000000', t);
export const lighten = (hex, t) => mix(hex, '#ffffff', t);

function saturation(hex) {
  const c = parseColor(hex);
  if (!c) return 0;
  const max = Math.max(c.r, c.g, c.b); const min = Math.min(c.r, c.g, c.b);
  return max === 0 ? 0 : (max - min) / max;
}

const NEUTRAL = Object.freeze({ deep: '#0f172a', bright: '#4f46e5' });
const INK_DARK = '#0b1220';

/** The text colour that reads on `bg` (white or near-black, whichever has the higher contrast). */
// Creative text is large and bold, so white is kept whenever it meets the large-text contrast (3:1), which is what makes white on a brand orange read well.
export const readableOn = (bg) => (contrast(bg, '#ffffff') >= 3 ? '#ffffff' : INK_DARK);

/**
 * @param {{ primary?: string|null, secondary?: string|null, accent?: string|null }} brand
 * @returns {{ deep, bright, soft, paper, ink, muted, white, onDeep, onBright, fromBrand: boolean, notes: string[] }}
 *   deep    - the dark brand tone (panels, headline ink)
 *   bright  - the lively brand tone (accents, buttons, emphasis)
 *   soft    - a very light tint of the deep tone (backgrounds), paper - white
 */
export function buildPalette(brand = {}) {
  const given = [brand.primary, brand.secondary, brand.accent].map((c) => (parseColor(c) ? toHex(parseColor(c)) : null)).filter(Boolean);
  const notes = [];
  let deep; let bright;
  if (!given.length) {
    ({ deep, bright } = NEUTRAL);
    notes.push('brand_colors_missing');
  } else {
    const byDark = [...given].sort((a, b) => luminance(a) - luminance(b));
    const darkest = byDark[0];
    // deep: the darkest brand colour, made darker only when it is too light to carry white text
    deep = contrast(darkest, '#ffffff') >= 4.5 ? darkest : darken(darkest, 0.55);
    // bright: the most saturated of the OTHER colours; with a single colour, the brand colour itself (or a lighter tone of it)
    const others = given.filter((c) => c !== darkest);
    const pool = others.length ? others : [darkest];
    bright = [...pool].sort((a, b) => saturation(b) - saturation(a))[0];
    if (contrast(bright, deep) < 2) bright = others.length ? bright : lighten(darkest, 0.35);
    if (given.length === 1 && bright === deep) bright = lighten(deep, 0.4);
  }
  return {
    deep, bright,
    soft: mix(deep, '#ffffff', 0.93),
    paper: '#ffffff',
    ink: darken(deep, 0.35),
    muted: mix(deep, '#ffffff', 0.38),
    white: '#ffffff',
    onDeep: readableOn(deep),
    onBright: readableOn(bright),
    fromBrand: given.length > 0,
    notes,
  };
}
