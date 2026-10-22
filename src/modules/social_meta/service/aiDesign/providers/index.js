import { OpenAIImageProvider } from './openAIImageProvider.js';

/**
 * Which provider draws design images. One line to change when the vendor changes; the design service only
 * knows the contract (isAvailable / generateImage), never the vendor. The instance holds no request state -
 * only the SDK client for the current key - so one per process is safe.
 */
let instance = null;
export function getDefaultImageProvider() {
  if (!instance) instance = new OpenAIImageProvider();
  return instance;
}

export { OpenAIImageProvider };
