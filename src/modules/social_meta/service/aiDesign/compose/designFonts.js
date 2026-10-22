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
});

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

/** { heading, body } families for a brief's typography, with whether each came from the brand. */
export function resolveTypography(typography = {}) {
  const heading = matchFamily(typography.heading);
  const body = matchFamily(typography.body);
  return {
    heading: heading || DEFAULT_FAMILY,
    body: body || heading || DEFAULT_FAMILY,
    headingFromBrand: !!heading,
    bodyFromBrand: !!body,
    brandFontUnavailable: !!((typography.heading && !heading) || (typography.body && !body)),
  };
}

/** { font, fontfile } for the renderer: family + weight -> the pango font name and the file it lives in. */
export function fontSpec(family, weight = 400) {
  const def = FAMILIES[family] || FAMILIES[DEFAULT_FAMILY];
  const name = FAMILIES[family] ? family : DEFAULT_FAMILY;
  const w = WEIGHT_NAME[weight] ? weight : 400;
  const file = def.variable || def.files[w] || def.files[400];
  return { family: name, weight: w, weightName: WEIGHT_NAME[w], fontfile: path.join(FONT_DIR, file) };
}

/** True when every shipped font file is present (a deployment check, and a precondition the composer tests assert). */
export function fontsInstalled() {
  return AVAILABLE_FAMILIES.every((family) => {
    const def = FAMILIES[family];
    const files = def.variable ? [def.variable] : Object.values(def.files);
    return files.every((f) => fs.existsSync(path.join(FONT_DIR, f)));
  });
}
