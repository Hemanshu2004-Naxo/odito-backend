import { buildDesignBrief, checkBrief } from './designStrategy.js';
import { renderVisualPrompt, providerSizeFor } from './designVisual.js';
import { PLATFORM_DESIGN } from './designConfig.js';

/**
 * Brief -> requests. A design is built in two halves, and only ONE of them is a prompt:
 *   - the PHOTOGRAPH (when the layout carries one): renderVisualPrompt asks the image model for a picture with no text in it;
 *   - the COMPOSITION: the composer draws every word, the logo and the contact details from the brief itself.
 * So the prompt can never misspell a headline, redraw a logo or invent a phone number - it never contains any of them.
 */

export const DESIGN_PROMPT_VERSION = 'social-ai-design-v4';

/** The frame (in pixels of the final design) the photograph is cropped into, by layout and canvas: decides the size requested from the model. */
export function visualFrameFor(layoutId, width, height) {
  const wide = width / height >= 1.25;
  switch (layoutId) {
    case 'photo_hero': return wide ? { w: width * 0.54, h: height } : { w: width, h: height * 0.62 };
    case 'service_list': return wide ? { w: (width * 0.4) * 0.78, h: (width * 0.4) * 0.78 } : { w: width * 0.47, h: width * 0.47 };
    case 'announcement_banner': return { w: Math.min(width, height) * 0.5, h: Math.min(width, height) * 0.5 };
    default: return null;
  }
}

/**
 * The whole step: context -> brief -> (photograph prompt). Returns the brief (the service stores only its safe summary, never a
 * prompt) and the deterministic quality problems found in it. `visualPrompt` is null for layouts without a photograph.
 *
 * @param {object} a  see designStrategy.buildDesignBrief; plus `snapshotData` / `strategy`
 */
export function buildDesignRequest(a) {
  const brief = buildDesignBrief(a);
  const problems = checkBrief(brief, { prohibitedPhrases: a.prohibitedPhrases || [], caption: a.caption, planItem: a.planItem || null });
  const finalSize = PLATFORM_DESIGN[a.platform]?.size || '1024x1024';
  const [width, height] = finalSize.split('x').map(Number);
  let visualPrompt = null;
  let visualSize = null;
  if (brief.photography.required) {
    const frame = visualFrameFor(brief.layoutId, width, height);
    visualSize = providerSizeFor(frame.w, frame.h);
    visualPrompt = renderVisualPrompt(brief, { size: visualSize, snapshotData: a.snapshotData });
  }
  return { brief, visualPrompt, visualSize, size: { width, height }, problems };
}

export const platformSize = (platform) => PLATFORM_DESIGN[platform]?.size || null;

export default { DESIGN_PROMPT_VERSION, buildDesignRequest, visualFrameFor };
