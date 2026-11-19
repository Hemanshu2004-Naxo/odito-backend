import { carouselEligibility, captionPoints } from './carousel.js';
import { MIN_CAROUSEL_POINTS, MAX_LISTED_POINTS } from './conceptConfig.js';

/**
 * WHICH FORMAT a post's design gets - one rule for Content Approvals (Generate / Regenerate design) and Creative Studio:
 *
 *   1. the format the person picked (the Single image / Carousel switch)                       source 'choice'
 *   2. the post's PLANNED format: the content-calendar item it was written from                  source 'plan'
 *      (SocialContentCalendarItem.format via publication.generation.calendarItemId; 'carousel' -> carousel, any other -> single)
 *   3. the caption: a list of 3-10 items -> carousel, else single                                 source 'caption'
 *
 * It is worked out again on every request (a Regenerate never inherits the previous version's format).
 * A carousel the caption cannot be split into is NEVER quietly turned into a single image: `needsChoice` is set and the person is
 * asked (make a single image, or edit the caption).
 */

export const DESIGN_FORMATS = Object.freeze(['single', 'carousel']);

export const FORMAT_MESSAGES = Object.freeze({
  PLANNED_NO_POINTS: 'Planned as carousel, but the caption has no clear points. Make a single image or edit the caption?',
  CHOSEN_NO_POINTS: 'This caption has no clear points to split into carousel slides. Make a single image or edit the caption?',
  CAROUSEL_UNAVAILABLE: 'Carousels can\'t be made for posts that use real product photos yet. Make a single image instead?',
});

/** The calendar format -> the design format it asks for (null = the plan says nothing about it). */
export const designFormatForPlan = (plannedFormat) => (plannedFormat ? (plannedFormat === 'carousel' ? 'carousel' : 'single') : null);

/**
 * @param {object} args
 * @param {string|null} args.explicit       'single' | 'carousel' the person picked (anything else = no choice)
 * @param {string|null} args.plannedFormat  the calendar item's format (static_post | carousel | reel | video | text_post) or null
 * @param {string} args.caption             the approved caption
 * @param {boolean} [args.carouselAvailable=true]  false when this post's pipeline cannot make a carousel (real product photos)
 * @returns {{ format, source, plannedFormat, plannedDesignFormat, carousel, needsChoice, code, message }}
 */
export function resolveDesignFormat({ explicit = null, plannedFormat = null, caption = '', carouselAvailable = true } = {}) {
  const carousel = carouselEligibility(caption);
  const plannedDesignFormat = designFormatForPlan(plannedFormat);
  let format; let source;
  if (DESIGN_FORMATS.includes(explicit)) { format = explicit; source = 'choice'; }
  else if (plannedDesignFormat) { format = plannedDesignFormat; source = 'plan'; }
  else {
    const n = captionPoints(caption).length;
    format = n >= MIN_CAROUSEL_POINTS && n <= MAX_LISTED_POINTS ? 'carousel' : 'single';
    source = 'caption';
  }
  let needsChoice = false; let code = null; let message = null;
  if (format === 'carousel' && !carouselAvailable) { needsChoice = true; code = 'CAROUSEL_UNAVAILABLE'; message = FORMAT_MESSAGES.CAROUSEL_UNAVAILABLE; }
  else if (format === 'carousel' && !carousel.allowed) {
    needsChoice = true; code = 'CAROUSEL_NEEDS_POINTS';
    message = source === 'plan' ? FORMAT_MESSAGES.PLANNED_NO_POINTS : FORMAT_MESSAGES.CHOSEN_NO_POINTS;
  }
  return { format, source, plannedFormat: plannedFormat || null, plannedDesignFormat, carousel: { ...carousel, available: carouselAvailable }, needsChoice, code, message };
}

/** The post's current design format: a carousel when it carries more than one image. */
export const currentDesignFormat = (pub) => ((pub?.media || []).length > 1 || pub?.design?.format === 'carousel' ? 'carousel' : (pub?.media || []).length ? 'single' : null);

/** A design that does not match its plan (made before formats were followed): planned as carousel, but the current design is one image. */
export const formatMismatch = (pub, plannedFormat) => designFormatForPlan(plannedFormat) === 'carousel' && currentDesignFormat(pub) === 'single';

/** The calendar format to store after a design of `designFormat` was made, so the calendar shows what was actually made (null = keep). */
export function calendarFormatAfter(designFormat, plannedFormat) {
  if (!plannedFormat) return null;
  if (designFormat === 'carousel' && plannedFormat !== 'carousel') return 'carousel';
  if (designFormat === 'single' && plannedFormat === 'carousel') return 'static_post';
  return null;
}
