import { getAnchorSettings, saveAnchorSettings } from '../service/anchorSettingsService.js';
import { parseAnchorSettingsBody } from '../validator/anchorSettingsInput.js';
import { ANCHOR_SETTINGS } from '../config.js';
import { sendError } from './domainOverviewController.js';

/**
 * The project's saved anchor settings. Runs AFTER auth + validateProjectAccess(): `req.project` is a project the user owns.
 * Every response carries the settings as saved, so the browser never has to guess the result of a write.
 */

const LIMITS = Object.freeze({ brand_terms: ANCHOR_SETTINGS.maxBrandTerms, target_keywords: ANCHOR_SETTINGS.maxTargetKeywords, term_length: ANCHOR_SETTINGS.maxTermLength });

function reply(res, settings) {
  res.set('Cache-Control', 'no-store');
  return res.status(200).json({ success: true, data: { ...settings, limits: LIMITS } });
}

const context = (req) => ({ userId: String(req.user?._id || ''), projectId: String(req.project?._id || '') });

/** GET /projects/:projectId/anchor-settings */
export async function getSettings(req, res) {
  try {
    return reply(res, await getAnchorSettings(req.project._id));
  } catch (err) {
    return sendError(res, err, context(req));
  }
}

/** PUT /projects/:projectId/anchor-settings   { brand_terms: string[], target_keywords: string[] } */
export async function putSettings(req, res) {
  try {
    const { brandTerms, targetKeywords } = parseAnchorSettingsBody(req.body);
    return reply(res, await saveAnchorSettings({ projectId: req.project._id, brandTerms, targetKeywords }));
  } catch (err) {
    return sendError(res, err, context(req));
  }
}
