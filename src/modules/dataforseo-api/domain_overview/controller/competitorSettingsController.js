import { addDomains, getCompetitorSettings, removeDomain } from '../service/competitorSettingsService.js';
import { parseExcludedBody, parseOneDomain, parseTrackedBody } from '../validator/competitorSettingsInput.js';
import { normalizeTargetDomain } from '../../shared/targetDomain.js';
import { COMPETITORS_QUERY } from '../config.js';
import { sendError } from './domainOverviewController.js';

/**
 * The project's saved competitor lists. Runs AFTER auth + validateProjectAccess(): `req.project` is a project the user owns.
 * Every response carries both lists as saved, so the browser never has to guess the result of a write.
 */

const LIMITS = Object.freeze({ tracked: COMPETITORS_QUERY.maxTrackedDomains, excluded: COMPETITORS_QUERY.maxExcludedDomains });

/** The project's own domain, or null when its URL is unusable (then nothing is compared against it). */
function projectDomainOf(project) {
  try { return normalizeTargetDomain(project.main_url); } catch { return null; }
}

function reply(res, settings) {
  res.set('Cache-Control', 'no-store');
  return res.status(200).json({ success: true, data: { ...settings, limits: LIMITS } });
}

const context = (req) => ({ userId: String(req.user?._id || ''), projectId: String(req.project?._id || '') });

/** GET /projects/:projectId/competitor-settings */
export async function getSettings(req, res) {
  try {
    return reply(res, await getCompetitorSettings(req.project._id));
  } catch (err) {
    return sendError(res, err, context(req));
  }
}

/** POST /projects/:projectId/competitor-settings/tracked   { domain } */
export async function addTracked(req, res) {
  try {
    const domains = parseTrackedBody(req.body);
    return reply(res, await addDomains({ projectId: req.project._id, list: 'tracked', domains, projectDomain: projectDomainOf(req.project) }));
  } catch (err) {
    return sendError(res, err, context(req));
  }
}

/** DELETE /projects/:projectId/competitor-settings/tracked/:domain */
export async function removeTracked(req, res) {
  try {
    const domain = parseOneDomain(req.params.domain);
    return reply(res, await removeDomain({ projectId: req.project._id, list: 'tracked', domain }));
  } catch (err) {
    return sendError(res, err, context(req));
  }
}

/** POST /projects/:projectId/competitor-settings/excluded   { domain } | { domains: [...] } */
export async function addExcluded(req, res) {
  try {
    const domains = parseExcludedBody(req.body);
    return reply(res, await addDomains({ projectId: req.project._id, list: 'excluded', domains, projectDomain: projectDomainOf(req.project) }));
  } catch (err) {
    return sendError(res, err, context(req));
  }
}

/** DELETE /projects/:projectId/competitor-settings/excluded/:domain */
export async function removeExcluded(req, res) {
  try {
    const domain = parseOneDomain(req.params.domain);
    return reply(res, await removeDomain({ projectId: req.project._id, list: 'excluded', domain }));
  } catch (err) {
    return sendError(res, err, context(req));
  }
}
