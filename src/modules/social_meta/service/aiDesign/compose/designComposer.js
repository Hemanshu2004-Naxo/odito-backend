import { Scene } from './designPrimitives.js';
import { buildPalette } from './designPalette.js';
import { resolveTypography, fontsInstalled } from './designFonts.js';
import { orientationOf } from './layoutKit.js';
import { PHOTO_LAYOUTS } from './layoutsPhoto.js';
import { STRUCTURED_LAYOUTS } from './layoutsStructured.js';
import { LAYOUT_NEEDS, PHOTO_LAYOUT_IDS, missingForLayout } from './layoutNeeds.js';
import { checkComposition, emptySlot } from '../designQuality.js';

/**
 * The deterministic half of the hybrid design pipeline. Given a design brief (the single source of truth for every word, number,
 * contact detail and colour), the AI-generated PHOTO (when the layout wants one), the REAL logo and the REAL product photos, it
 * draws the finished creative: text from font files, shapes, masked photos, the logo. The image model never renders text here,
 * so a headline, a service name, a phone number or a URL is exactly what the brief says, and the logo is the real file.
 *
 *   composeDesign({ brief, size, visual, logo, productImages }) -> { buffer (PNG), report }
 */

export const LAYOUTS = Object.freeze({ ...PHOTO_LAYOUTS, ...STRUCTURED_LAYOUTS });

const composeError = (code, reason) => Object.assign(new Error(code), { code, reason });

/**
 * @param {object} a
 * @param {object} a.brief            see designStrategy.buildDesignBrief (layout, headline, points, services, cta, contact, ...)
 * @param {{ width: number, height: number }} a.size
 * @param {Buffer|null} [a.visual]    the generated photograph, when the layout is photographic
 * @param {Buffer|null} [a.logo]      the real logo as a PNG (see designMedia.prepareLogo)
 * @param {Buffer[]} [a.productImages] the real product photos
 */
export async function composeDesign({ brief, size, visual = null, logo = null, productImages = [] }) {
  const layout = LAYOUTS[brief?.layoutId];
  if (!layout) throw composeError('COMPOSE_INVALID', 'unknown_layout');
  if (!brief.headline && !(brief.product && brief.product.name)) throw composeError('COMPOSE_INVALID', 'no_headline');
  if (!fontsInstalled()) throw composeError('COMPOSE_UNAVAILABLE', 'fonts_missing');
  const { width: W, height: H } = size;
  if (!(W >= 320 && H >= 320)) throw composeError('COMPOSE_INVALID', 'size');
  const missing = missingForLayout(brief.layoutId, brief, { productImages: productImages.length });
  if (missing) throw composeError('COMPOSE_INVALID', `layout_needs_${missing}`);

  const empty = emptySlot(brief); // a card with nothing to say is refused before it is drawn
  if (empty) throw composeError('COMPOSE_INCOMPLETE', empty);

  const pal = buildPalette(brief.brandColors || {});
  const typography = resolveTypography(brief.typography || {});
  const ctx = {
    W, H, u: Math.min(W, H) / 100, cls: orientationOf(W, H), pal,
    fonts: { heading: typography.heading, body: typography.body },
    brief, visual, logo, productImages, logoStats: null, logoPlaced: false, notes: new Set(pal.notes),
  };
  if (typography.brandFontUnavailable) ctx.notes.add('brand_font_unavailable');

  const scene = new Scene(W, H, pal.paper);
  await layout(scene, ctx);
  // what the layout was meant to show must have been drawn: an empty card is a failure, never a finished design
  const incomplete = checkComposition(brief, scene.report);
  if (incomplete) throw composeError('COMPOSE_INCOMPLETE', incomplete);
  const buffer = await scene.render();
  return {
    buffer,
    report: {
      layout: brief.layoutId, orientation: ctx.cls, width: W, height: H,
      fonts: { heading: typography.heading, body: typography.body, headingFromBrand: typography.headingFromBrand, bodyFromBrand: typography.bodyFromBrand },
      logoApplied: !!logo && ctx.logoPlaced,
      visualUsed: !!visual && !ctx.notes.has('visual_missing'),
      notes: [...ctx.notes],
      shortened: [...scene.report.shortened],
      overflow: [...scene.report.overflow],
      texts: scene.report.texts.map((t) => ({ label: t.label, size: t.size })),
    },
  };
}

export { LAYOUT_NEEDS, PHOTO_LAYOUT_IDS, missingForLayout };
export default { composeDesign, LAYOUTS, LAYOUT_NEEDS, PHOTO_LAYOUT_IDS, missingForLayout };
