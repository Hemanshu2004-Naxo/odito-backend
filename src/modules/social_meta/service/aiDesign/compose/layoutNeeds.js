/**
 * What each layout template needs from a brief to be honest (pure data: no rendering, no imports), shared by the composer
 * (which refuses an unsatisfiable layout) and the design strategy (which only ever chooses a satisfiable one).
 */
export const LAYOUT_NEEDS = Object.freeze({
  photo_hero: { photo: true },
  service_list: { photo: true, services: 2 },
  announcement_banner: { photo: 'optional' },
  infographic_points: { points: 3 },
  insight_stats: { figures: 1 },
  product_hero: { productImage: true },
  statement_quote: {},
});

/** Layouts whose picture is the AI-generated visual (always or when available). */
export const PHOTO_LAYOUT_IDS = Object.freeze(Object.keys(LAYOUT_NEEDS).filter((id) => LAYOUT_NEEDS[id].photo));

/** The first thing a brief is missing for the layout (points / services / figures / product_photo), or null. */
export function missingForLayout(layoutId, brief, { productImages = 0 } = {}) {
  const needs = LAYOUT_NEEDS[layoutId];
  if (!needs) return 'unknown_layout';
  if (needs.points && (brief.points || []).length < needs.points) return 'points';
  if (needs.services && (brief.services || []).length < needs.services) return 'services';
  if (needs.figures && (brief.figures || []).length < needs.figures) return 'figures';
  if (needs.productImage && productImages < 1) return 'product_photo';
  return null;
}
