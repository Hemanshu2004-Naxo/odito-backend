import { applyDomainListChange, getDomainLists } from '../service/domainListService.js';
import { parseDomainListChange } from '../validator/domainListInput.js';
import { normalizeTargetDomain } from '../../shared/targetDomain.js';
import { DOMAIN_LISTS } from '../config.js';
import { sendError } from './domainOverviewController.js';

/**
 * The project's saved disavow / reviewed lists. Runs AFTER auth + validateProjectAccess(): `req.project` is a project the user owns.
 * Every response carries both lists as saved, so the browser never has to guess the result of a write — and never refetches the data
 * provider for one: a disavow is a change to OUR lists only.
 */

const LIMITS = Object.freeze({ perList: DOMAIN_LISTS.maxPerList, perChange: DOMAIN_LISTS.maxPerChange });

const ownDomainOf = (project) => { try { return normalizeTargetDomain(project.main_url); } catch { return null; } };

function reply(res, lists) {
  res.set('Cache-Control', 'no-store');
  return res.status(200).json({ success: true, data: { ...lists, limits: LIMITS } });
}

const context = (req) => ({ userId: String(req.user?._id || ''), projectId: String(req.project?._id || '') });

/** GET /projects/:projectId/referring-domain-settings */
export async function getSettings(req, res) {
  try {
    return reply(res, await getDomainLists(req.project._id));
  } catch (err) {
    return sendError(res, err, context(req));
  }
}

/** PATCH /projects/:projectId/referring-domain-settings   { disavowed: { add, remove }, reviewed: { add, remove } } */
export async function patchSettings(req, res) {
  try {
    const change = parseDomainListChange(req.body, ownDomainOf(req.project));
    return reply(res, await applyDomainListChange({ projectId: req.project._id, change }));
  } catch (err) {
    return sendError(res, err, context(req));
  }
}
