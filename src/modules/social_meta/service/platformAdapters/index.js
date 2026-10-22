import facebookAdapter from './facebookAdapter.js';
import instagramAdapter from './instagramAdapter.js';

/**
 * Registry of platform adapters with a REAL, working publish
 * implementation — only Facebook and Instagram exist here. X/LinkedIn/
 * TikTok are deliberately absent: socialPublishingService.js looks up
 * `adapters[platform]` and treats a missing entry as
 * PLATFORM_NOT_SUPPORTED, so adding a real adapter for another provider
 * later is a pure addition here, never a rewrite of the publishing
 * service itself.
 */
const adapters = {
  facebook: facebookAdapter,
  instagram: instagramAdapter,
};

export default adapters;
