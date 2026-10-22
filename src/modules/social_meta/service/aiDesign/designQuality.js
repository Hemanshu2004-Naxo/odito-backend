import sharp from 'sharp';
import { MAX_IMAGE_PIXELS } from './designConfig.js';

/**
 * Deterministic quality gates for a design, applied BEFORE it is saved and called successful. They catch what dimensions and decoding cannot:
 *
 *   - assessRaster: a picture that decodes fine but carries (almost) no information - a blank or single-colour image, which a provider can
 *     return and a bug can compose. Judged on a small downscaled copy by the spread of its pixel values.
 *   - checkComposition: the words a layout is MEANT to show were actually drawn. A numbered layout with five points must have drawn five
 *     points; a statistics layout must have drawn each figure AND the sentence that explains it. An empty card is a failure, not a style.
 *
 * Neither claims the design is beautiful: visual taste is still the human Design Review (and an optional vision evaluator, if one is ever
 * added). These are the objective floor under it, and every failure carries a short code the studio can show.
 */

/** Below this average per-channel standard deviation (0-255) an image is treated as blank. A real photograph is far above it. */
export const BLANK_STDEV = 6;

/**
 * @param {Buffer} buffer
 * @returns {Promise<{ stdev: number, blank: boolean, flatShare: number }>}  flatShare = the share of 16x16 cells that are a single flat colour
 */
export async function assessRaster(buffer) {
  const base = sharp(buffer, { failOn: 'error', limitInputPixels: MAX_IMAGE_PIXELS }).rotate().resize({ width: 256, height: 256, fit: 'inside' }).removeAlpha();
  const stats = await base.clone().stats();
  const stdev = stats.channels.slice(0, 3).reduce((s, c) => s + c.stdev, 0) / 3;
  const { data, info } = await base.clone().raw().toBuffer({ resolveWithObject: true });
  const cell = 16;
  let flat = 0;
  let cells = 0;
  for (let cy = 0; cy + cell <= info.height; cy += cell) {
    for (let cx = 0; cx + cell <= info.width; cx += cell) {
      cells += 1;
      let min = 255;
      let max = 0;
      for (let y = cy; y < cy + cell; y += 1) {
        for (let x = cx; x < cx + cell; x += 1) {
          const v = data[(y * info.width + x) * info.channels];
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
      if (max - min <= 4) flat += 1;
    }
  }
  return { stdev: Math.round(stdev * 10) / 10, blank: stdev < BLANK_STDEV, flatShare: cells ? Math.round((flat / cells) * 100) / 100 : 0 };
}

/** The text labels a layout must have drawn for this brief (labels are set by the layouts themselves, see compose/layoutsStructured.js). */
export function expectedLabels(brief) {
  const out = [];
  if (brief.layoutId !== 'product_hero' || !brief.product?.name) out.push('headline');
  if (brief.layoutId === 'infographic_points') (brief.points || []).slice(0, 5).forEach((_, i) => out.push(`point:${i}`));
  if (brief.layoutId === 'insight_stats') (brief.figures || []).slice(0, 3).forEach((_, i) => out.push(`figure:${i}`, `context:${i}`));
  return out;
}

/** The brief's wording that a label stands for, so a drawn label can be checked against real text. */
const textFor = (brief, label) => {
  const [kind, index] = label.split(':');
  const i = Number(index);
  if (kind === 'point') return brief.points?.[i];
  if (kind === 'figure') return brief.figures?.[i]?.value;
  if (kind === 'context') return brief.figures?.[i]?.context;
  if (kind === 'headline') return brief.headline || brief.product?.name;
  return null;
};

/** BEFORE anything is drawn: the first slot the layout must fill that the brief leaves empty (a card with no words), as a short code, or null. */
export function emptySlot(brief) {
  for (const label of expectedLabels(brief)) if (!String(textFor(brief, label) || '').trim()) return `empty_${label.replace(':', '_')}`;
  return null;
}

/**
 * @param {object} brief   the design brief
 * @param {{ texts: { label: string, size: number, width?: number, height?: number }[], overflow?: string[] }} report  from the composer
 * @returns {string|null}  the first problem (a short code), or null when everything the layout must show was drawn
 */
export function checkComposition(brief, report) {
  const drawn = new Map((report?.texts || []).map((t) => [t.label, t]));
  for (const label of expectedLabels(brief)) {
    const text = textFor(brief, label);
    if (!String(text || '').trim()) return `empty_${label.replace(':', '_')}`; // the brief itself has nothing for this slot
    const placed = drawn.get(label);
    if (!placed) return `missing_${label.replace(':', '_')}`;
    if (!(placed.width > 0) || !(placed.height > 0)) return `invisible_${label.replace(':', '_')}`;
  }
  for (const label of expectedLabels(brief)) if ((report?.overflow || []).includes(label)) return `overflow_${label.replace(':', '_')}`;
  return null;
}

export default { assessRaster, checkComposition, emptySlot, expectedLabels, BLANK_STDEV };
