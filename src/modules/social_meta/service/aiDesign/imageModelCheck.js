import { DESIGN_MODEL, IMAGE_MODEL_SHUTDOWNS } from './designConfig.js';
import { OpenAIImageProvider, pinImageModelSnapshot } from './providers/openAIImageProvider.js';
import { LoggerUtil } from '../../../../utils/LoggerUtil.js';

/**
 * imageModelCheck - is the configured image model usable, and for how long? Run once at boot so a retired or renamed model is reported
 * the moment the server starts, not the first time someone generates a design (gpt-image-1 was retired silently for weeks: every photo
 * failed as "Design generation failed").
 *
 *   - not in the key's model list            -> ERROR (designs with a photograph will fall back to layouts without one)
 *   - on IMAGE_MODEL_SHUTDOWNS, date passed   -> ERROR
 *   - on IMAGE_MODEL_SHUTDOWNS, date ahead    -> WARN (with the date and OpenAI's replacement)
 * Never throws and never blocks the boot: a failed list call is itself only a warning.
 */

export const SHUTDOWN_SOON_DAYS = 120;
const DAY_MS = 86_400_000;

/** Pure: the verdict for `model` given the ids the key can see and today's date. */
export function assessImageModel({ model, available = null, now = new Date(), shutdowns = IMAGE_MODEL_SHUTDOWNS }) {
  const problems = [];
  const imageModels = Array.isArray(available) ? available.filter((id) => /^(gpt-image|chatgpt-image|dall-e)/.test(id)).sort() : null;
  if (imageModels && !imageModels.includes(model)) {
    problems.push({ level: 'error', code: 'IMAGE_MODEL_NOT_AVAILABLE', message: `The configured image model "${model}" is not available to this API key. Designs with a photograph will fall back to layouts without one. Set SOCIAL_AI_DESIGN_MODEL to one of: ${imageModels.join(', ') || '(none)'}.` });
  }
  const scheduled = shutdowns.find((s) => s.model === model);
  if (scheduled) {
    const days = Math.ceil((Date.parse(`${scheduled.shutdown}T00:00:00Z`) - now.getTime()) / DAY_MS);
    if (days <= 0) problems.push({ level: 'error', code: 'IMAGE_MODEL_SHUT_DOWN', message: `The image model "${model}" was shut down by OpenAI on ${scheduled.shutdown}. Replacement: ${scheduled.replacement}.` });
    else problems.push({ level: days <= SHUTDOWN_SOON_DAYS ? 'warn' : 'info', code: 'IMAGE_MODEL_SHUTDOWN_SCHEDULED', message: `The image model "${model}" shuts down on ${scheduled.shutdown} (in ${days} days). Replacement: ${scheduled.replacement}. Change SOCIAL_AI_DESIGN_MODEL before then.` });
  }
  return { model, ok: !problems.some((p) => p.level === 'error'), imageModels, problems };
}

/** The newest dated snapshot ("<model>-YYYY-MM-DD") of an alias in the list, or null (the model itself is already dated, or none exists). */
export function latestSnapshotOf(model, available) {
  if (!Array.isArray(available) || /-\d{4}-\d{2}-\d{2}$/.test(model)) return null;
  const dated = available.filter((id) => id.startsWith(`${model}-`) && /^\d{4}-\d{2}-\d{2}$/.test(id.slice(model.length + 1))).sort();
  return dated.length ? dated[dated.length - 1] : null;
}

/** Lists the models the key can see (one call; ids only). */
async function listModelIds(provider, timeoutMs) {
  const client = provider._getClient();
  const ids = [];
  const run = (async () => { for await (const m of client.models.list({ timeout: timeoutMs, maxRetries: 0 })) ids.push(m.id); })();
  await Promise.race([run, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs))]);
  return ids;
}

/**
 * The boot check. Skipped when no image key is configured (designs with a photograph are then unavailable anyway and say so) and in
 * tests. `listModels` is a test seam.
 */
export async function runImageModelStartupCheck({ model = DESIGN_MODEL, now = new Date(), listModels = null, timeoutMs = 10_000, provider = new OpenAIImageProvider({ model }) } = {}) {
  if (!listModels && !provider.isAvailable()) {
    LoggerUtil.warn('[SOCIAL_AI_DESIGN] image_model_check_skipped', { event: 'image_model_check_skipped', model, reason: 'no image API key configured' });
    return null;
  }
  let available = null;
  try {
    available = listModels ? await listModels() : await listModelIds(provider, timeoutMs);
  } catch (error) {
    LoggerUtil.warn('[SOCIAL_AI_DESIGN] image_model_check_unavailable', { event: 'image_model_check_unavailable', model, reason: String(error?.status || error?.message || 'error').slice(0, 80) });
  }
  const verdict = assessImageModel({ model, available, now });
  // a dated snapshot of the configured alias ("gpt-image-2.6-flare-2026-12-01") is pinned, so the alias moving cannot change the look
  const snapshot = latestSnapshotOf(model, available);
  if (snapshot) {
    pinImageModelSnapshot(model, snapshot);
    LoggerUtil.info('[SOCIAL_AI_DESIGN] image_model_pinned', { event: 'image_model_pinned', model, snapshot });
    verdict.pinned = snapshot;
  }
  for (const p of verdict.problems) {
    const fields = { event: 'image_model_check', model, code: p.code, message: p.message };
    if (p.level === 'error') LoggerUtil.error('[SOCIAL_AI_DESIGN] image_model_check', fields);
    else if (p.level === 'warn') LoggerUtil.warn('[SOCIAL_AI_DESIGN] image_model_check', fields);
    else LoggerUtil.info('[SOCIAL_AI_DESIGN] image_model_check', fields);
  }
  if (verdict.ok && !verdict.problems.length) LoggerUtil.info('[SOCIAL_AI_DESIGN] image_model_check', { event: 'image_model_check', model, code: 'IMAGE_MODEL_OK' });
  return verdict;
}

export default { assessImageModel, runImageModelStartupCheck, SHUTDOWN_SOON_DAYS };
