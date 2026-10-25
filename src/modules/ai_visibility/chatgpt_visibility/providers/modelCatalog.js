import { DataForSeoService } from '../../../ranking/services/DataForSeoService.js';
import { LoggerUtil } from '../../../../utils/LoggerUtil.js';

/**
 * Which ChatGPT models the configured DataForSEO account supports, from the provider's own (free) model-listing endpoint, cached.
 * A run whose configured model is NOT in the list is refused with MODEL_NOT_SUPPORTED - it is never silently replaced by another
 * model. If the listing cannot be fetched, the run is allowed (the provider then rejects a bad model itself) and a warning is logged.
 */
const TTL_MS = 6 * 60 * 60 * 1000;
let cache = { at: 0, models: null };

export async function listSupportedModels({ fetch = () => DataForSeoService.getChatGptModels(), now = Date.now } = {}) {
  if (cache.models && now() - cache.at < TTL_MS) return cache.models;
  const models = await fetch();
  cache = { at: now(), models };
  return models;
}

/** @returns {Promise<{supported:boolean|null, webSearch:boolean|null, reason:string|null}>} null = could not verify */
export async function checkModel(model, { webSearch = true, fetch, now } = {}) {
  let models;
  try {
    models = await listSupportedModels({ fetch, now });
  } catch (error) {
    LoggerUtil.warn('ChatGPT visibility: model list unavailable; not verifying the configured model', { model });
    return { supported: null, webSearch: null, reason: 'MODEL_LIST_UNAVAILABLE' };
  }
  const m = models.find((x) => x?.model_name === model);
  if (!m) return { supported: false, webSearch: null, reason: 'MODEL_NOT_SUPPORTED' };
  if (webSearch && m.web_search_supported === false) return { supported: false, webSearch: false, reason: 'MODEL_WEB_SEARCH_UNSUPPORTED' };
  return { supported: true, webSearch: m.web_search_supported !== false, reason: null };
}

export const _resetModelCache = () => { cache = { at: 0, models: null }; };

export default { listSupportedModels, checkModel };
