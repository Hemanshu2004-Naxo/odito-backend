import sharp from 'sharp';
import { composeDesign } from './compose/designComposer.js';
import { MAX_IMAGE_PIXELS } from './designConfig.js';
import { assessRaster } from './designQuality.js';

/**
 * Produces ONE finished design from a built request: the photograph (only when the layout carries one, from the existing image
 * provider), then Odito's own composition of every word, the real logo and the contact details over it. Nothing here stores or
 * attaches anything - the caller runs the result through the shared media pipeline (inspect, re-encode, validate, store).
 *
 *   brief ──► photograph (provider, no text) ──► composition (fonts, shapes, real logo, real product photos) ──► PNG
 *
 * A design with no photograph (lists, statistics, quotes, ...) never touches the provider, configured or not. A failed or unavailable photograph fails the design: there is no stand-in picture. Failures keep their own codes (provider errors stay
 * provider errors; a composition problem is DESIGN_COMPOSE_FAILED).
 */

// Test seam only (same convention as the provider override): substitute the composition step, e.g. with one that returns a blank picture. Production never sets it.
let composerOverride = null;
export const setDesignComposerOverride = (fn) => { composerOverride = fn || null; };

const composeFailure = (reason) => Object.assign(new Error('DESIGN_COMPOSE_FAILED'), { code: 'DESIGN_COMPOSE_FAILED', reason });

/** A provider picture as a bounded, decoded raster (never trusted as it came). */
async function normalizeVisual(buffer) {
  return sharp(buffer, { failOn: 'error', limitInputPixels: MAX_IMAGE_PIXELS }).rotate().resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
}

/**
 * @param {object} a
 * @param {object} a.request    from designBrief.buildDesignRequest: { brief, visualPrompt, visualSize, size }
 * @param {{ generateImage: Function }} a.provider
 * @param {string} a.generationId
 * @param {Buffer|null} [a.logo]            the real logo PNG (designMedia.prepareLogo)
 * @param {Buffer[]} [a.productImages]       real product photos (prepared)
 * @param {Buffer|null} [a.visualBuffer]     an existing photograph to re-use (a refinement that does not change the picture)
 * @returns {Promise<{ png: Buffer, visual: Buffer|null, report: object, provider: object|null }>}
 */
export async function produceDesign({ request, provider, generationId, logo = null, productImages = [], visualBuffer = null }) {
  const { brief, visualPrompt, visualSize, size } = request;
  let visual = null;
  let providerResult = null;
  if (brief.photography.required) {
    if (visualBuffer) {
      visual = visualBuffer;
    } else {
      // The provider is needed ONLY here. If it is not configured the design fails before any request is made - there is no stand-in picture.
      if (typeof provider?.isAvailable === 'function' && !provider.isAvailable()) throw Object.assign(new Error('AI_UNAVAILABLE'), { code: 'AI_UNAVAILABLE' });
      providerResult = await provider.generateImage({ prompt: visualPrompt, size: visualSize, generationId: String(generationId), referenceImages: [] });
      try { visual = await normalizeVisual(providerResult.buffer); } catch { throw Object.assign(new Error('MEDIA_INVALID'), { code: 'MEDIA_INVALID', reason: 'visual_not_decodable' }); }
      // a picture that decodes but shows nothing (blank / one colour) is not a photograph: it is refused here, before it is composed and before it is saved
      if ((await assessRaster(visual)).blank) throw Object.assign(new Error('MEDIA_INVALID'), { code: 'MEDIA_INVALID', reason: 'visual_blank' });
    }
  }
  let composed;
  try {
    composed = await (composerOverride || composeDesign)({ brief, size, visual, logo, productImages });
  } catch (error) {
    throw composeFailure(error?.reason || error?.code || 'compose_error');
  }
  // the finished design must carry information too (a layout bug that draws nothing must never be saved as a success)
  const finished = await assessRaster(composed.buffer);
  if (finished.blank) throw composeFailure('blank_output');
  return { png: composed.buffer, visual, report: { ...composed.report, quality: { stdev: finished.stdev, flatShare: finished.flatShare } }, provider: providerResult };
}

export default { produceDesign };
