import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

/**
 * The fonts the composer draws text with. They are FILES shipped with Odito (assets/fonts, all SIL Open Font License), handed to
 * the renderer by path - so a design looks the same on a laptop, in CI and on a server with no fonts installed, and a font
 * is never fetched at render time. The brand's own heading / body font is used when it is one of these families; any other
 * name falls back to Poppins (and the composition reports that, so the UI never claims a font it did not use).
 */
const here = path.dirname(fileURLToPath(import.meta.url));
export const FONT_DIR = path.resolve(here, '../../../../../../assets/fonts');

const WEIGHT_NAME = Object.freeze({ 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold' });

/** family -> the file for each weight (static families list each weight; variable families have one file for all). */
const FAMILIES = Object.freeze({
  Poppins: { files: { 400: 'Poppins-Regular.ttf', 500: 'Poppins-Medium.ttf', 600: 'Poppins-SemiBold.ttf', 700: 'Poppins-Bold.ttf', 800: 'Poppins-ExtraBold.ttf' } },
  Montserrat: { variable: 'Montserrat.var.ttf' },
  Inter: { variable: 'Inter.var.ttf' },
  Manrope: { variable: 'Manrope.var.ttf' },
  Sora: { variable: 'Sora.var.ttf' },
  'Open Sans': { variable: 'OpenSans.var.ttf' },
  'DM Sans': { files: { 400: 'DM_Sans/DMSans-Regular.ttf', 500: 'DM_Sans/DMSans-Medium.ttf', 600: 'DM_Sans/DMSans-SemiBold.ttf', 700: 'DM_Sans/DMSans-Bold.ttf' } },
});

/** The file of the nearest shipped weight (a family without ExtraBold uses Bold, never Regular). */
function fileForWeight(def, w) {
  if (def.variable) return def.variable;
  if (def.files[w]) return def.files[w];
  const weights = Object.keys(def.files).map(Number).sort((a, b) => Math.abs(a - w) - Math.abs(b - w) || b - a);
  return def.files[weights[0]];
}

export const DEFAULT_FAMILY = 'Poppins';
export const AVAILABLE_FAMILIES = Object.freeze(Object.keys(FAMILIES));

const byLower = new Map(AVAILABLE_FAMILIES.map((f) => [f.toLowerCase(), f]));

/** The shipped family a brand font name refers to ("Poppins", "poppins semibold", "Inter, sans-serif"), or null. */
export function matchFamily(name) {
  const first = String(name || '').split(',')[0].replace(/['"]/g, '').trim().toLowerCase();
  if (!first) return null;
  if (byLower.has(first)) return byLower.get(first);
  for (const [lower, family] of byLower) if (first.startsWith(`${lower} `)) return family;
  return null;
}

/**
 * A brand's OWN uploaded font (Brand Kit), registered under a key (e.g. "brand:<project>:heading") with its real family name and the files
 * it has (400 regular and / or 700 bold, absolute paths in private storage). Re-registering a key replaces it.
 */
const CUSTOM = new Map();
export function registerCustomFamily(key, { family, files }) {
  CUSTOM.set(key, { family, files: { ...files } });
}
export const isCustomFamily = (key) => CUSTOM.has(key);

/**
 * { heading, body } families for a brief's typography, with whether each came from the brand. `custom` = { heading, body } keys of the
 * brand's uploaded fonts (registerCustomFamily): an uploaded font wins over a shipped family of the same name.
 */
export function resolveTypography(typography = {}, custom = null) {
  const headingCustom = custom?.heading && CUSTOM.has(custom.heading) ? custom.heading : null;
  const bodyCustom = custom?.body && CUSTOM.has(custom.body) ? custom.body : null;
  const heading = headingCustom || matchFamily(typography.heading);
  const body = bodyCustom || matchFamily(typography.body);
  return {
    heading: heading || DEFAULT_FAMILY,
    body: body || heading || DEFAULT_FAMILY,
    headingFromBrand: !!heading,
    bodyFromBrand: !!body,
    headingUploaded: !!headingCustom,
    bodyUploaded: !!bodyCustom,
    brandFontUnavailable: !!((typography.heading && !heading) || (typography.body && !body)),
  };
}

/** { font, fontfile } for the renderer: family + weight -> the pango font name and the file it lives in. */
export function fontSpec(family, weight = 400) {
  const custom = CUSTOM.get(family);
  if (custom) {
    // an uploaded family has a regular and / or a bold file: the nearest one (500 -> regular, 600 / 800 -> bold)
    const want = weight >= 600 ? 700 : 400;
    const drawn = custom.files[want] ? want : Number(Object.keys(custom.files)[0]);
    return { family: custom.family, weight: drawn, weightName: drawn >= 700 ? 'Bold' : 'Regular', fontfile: custom.files[drawn] };
  }
  const def = FAMILIES[family] || FAMILIES[DEFAULT_FAMILY];
  const name = FAMILIES[family] ? family : DEFAULT_FAMILY;
  const w = WEIGHT_NAME[weight] ? weight : 400;
  const file = fileForWeight(def, w);
  // a static family is drawn at the weight its file has (pango needs the name of what the file really is)
  const drawnWeight = def.variable ? w : Number(Object.keys(def.files).find((k) => def.files[k] === file));
  return { family: name, weight: drawnWeight, weightName: WEIGHT_NAME[drawnWeight], fontfile: path.join(FONT_DIR, file) };
}

/** True when every shipped font file is present (a deployment check, and a precondition the composer tests assert). */
export function fontsInstalled() {
  return AVAILABLE_FAMILIES.every((family) => {
    const def = FAMILIES[family];
    const files = def.variable ? [def.variable] : Object.values(def.files);
    return files.every((f) => fs.existsSync(path.join(FONT_DIR, f)));
  });
}
