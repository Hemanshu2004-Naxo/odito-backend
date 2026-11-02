import { ValidationFailure, normalizeDomainInput, normalizeTargetDomain } from '../../dataforseo-api/shared/targetDomain.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import { ASSESSMENT_CLASSES } from '../model/CompetitorAssessment.js';
import {
  MAX_DOMAINS_PER_REQUEST, clearOverride, listAssessments, requestAssessments, setOverride, toAssessmentDto,
} from '../service/assessmentStore.js';

/**
 * Business relevance of websites for a project. Runs AFTER auth + validateProjectAccess(): `req.project` is a project the user owns, and the
 * project id never comes from the body. Domains are cleaned and validated here, so nothing user-supplied reaches a fetch unchecked.
 */

const STATUS = Object.freeze({ ASSESSMENTS_UNAVAILABLE: 503 });
const bad = (field, message) => new ValidationFailure(field, message);

const ownDomainOf = (project) => { try { return normalizeTargetDomain(project.main_url); } catch { return null; } };

function sendError(res, err, req) {
  if (err instanceof ValidationFailure) return res.status(STATUS[err.code] ?? 400).json({ success: false, code: err.code, field: err.field, message: err.message });
  LoggerUtil.error('Competitor assessments: unexpected error', err, { userId: String(req.user?._id || ''), projectId: String(req.project?._id || '') });
  return res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' });
}
const ok = (res, data) => { res.set('Cache-Control', 'no-store'); return res.status(200).json({ success: true, data }); };

/** raw list -> { domains (clean, unique, own site removed), invalid, skippedOwn } */
export function cleanDomains(raw, ownDomain) {
  if (!Array.isArray(raw) || raw.length === 0) throw bad('domains', 'Send the domains to assess as a list.');
  if (raw.length > MAX_DOMAINS_PER_REQUEST) throw bad('domains', `At most ${MAX_DOMAINS_PER_REQUEST} domains can be assessed at once.`);
  const domains = []; const invalid = []; const skippedOwn = [];
  for (const r of raw) {
    const d = typeof r === 'string' ? normalizeDomainInput(r) : null;
    if (!d) invalid.push(String(r).slice(0, 60));
    else if (ownDomain && d === ownDomain) skippedOwn.push(d);
    else if (!domains.includes(d)) domains.push(d);
  }
  if (domains.length === 0) throw bad('domains', 'None of the domains is valid.');
  return { domains, invalid, skippedOwn };
}

/** POST /projects/:projectId/competitor-assessments/request  { domains: string[], force?: boolean } */
export async function request(req, res) {
  try {
    const { domains, invalid, skippedOwn } = cleanDomains(req.body?.domains, ownDomainOf(req.project));
    const docs = await requestAssessments({ projectId: req.project._id, domains, force: req.body?.force === true });
    return ok(res, { assessments: docs.map(toAssessmentDto), invalid, skippedOwn });
  } catch (err) { return sendError(res, err, req); }
}

/** GET /projects/:projectId/competitor-assessments?domains=a.com,b.com - what is stored. Makes no request to any site or provider. */
export async function list(req, res) {
  try {
    const raw = String(req.query.domains ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const { domains } = cleanDomains(raw, ownDomainOf(req.project));
    const docs = await listAssessments({ projectId: req.project._id, domains });
    return ok(res, { assessments: docs.map(toAssessmentDto) });
  } catch (err) { return sendError(res, err, req); }
}

function oneDomain(raw, project) {
  const d = typeof raw === 'string' ? normalizeDomainInput(raw) : null;
  if (!d) throw bad('domain', 'Enter a valid domain.');
  if (d === ownDomainOf(project)) throw bad('domain', 'This is your own website.');
  return d;
}

/** PUT /projects/:projectId/competitor-assessments/override  { domain, class, note? } */
export async function override(req, res) {
  try {
    const domain = oneDomain(req.body?.domain, req.project);
    const cls = req.body?.class;
    if (!ASSESSMENT_CLASSES.includes(cls)) throw bad('class', `class must be one of: ${ASSESSMENT_CLASSES.join(', ')}.`);
    const note = req.body?.note == null ? null : String(req.body.note).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 500) || null;
    if (req.body?.note != null && typeof req.body.note !== 'string') throw bad('note', 'note must be text.');
    const doc = await setOverride({ projectId: req.project._id, domain, cls, note, userId: req.user?._id });
    return ok(res, { assessment: toAssessmentDto(doc) });
  } catch (err) { return sendError(res, err, req); }
}

/** DELETE /projects/:projectId/competitor-assessments/override?domain=a.com */
export async function removeOverride(req, res) {
  try {
    const domain = oneDomain(req.query.domain ?? req.body?.domain, req.project);
    const doc = await clearOverride({ projectId: req.project._id, domain });
    return ok(res, { assessment: doc ? toAssessmentDto(doc) : null });
  } catch (err) { return sendError(res, err, req); }
}
