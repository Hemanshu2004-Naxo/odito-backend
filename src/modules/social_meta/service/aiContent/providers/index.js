import { OpenAIContentProvider } from './openAIContentProvider.js';

/**
 * Which provider writes single posts. One line to change when the provider changes; the generation
 * service only knows the contract (isAvailable / generateContent), never the vendor.
 *
 * The instance holds no request state - only the SDK client built for the current API key - so one
 * per process is safe; the key itself is re-read on every call.
 */
let instance = null;
export function getDefaultContentProvider() {
  if (!instance) instance = new OpenAIContentProvider();
  return instance;
}

export { OpenAIContentProvider };
