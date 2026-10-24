import SeoProject from '../../../../app_user/model/SeoProject.js';
import SocialBusinessProfile from '../../../../social_meta/model/SocialBusinessProfile.js';
import { ResponseUtil } from '../../../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../../../utils/LoggerUtil.js';
import { INDUSTRIES, isIndustryValue } from '../../../../../config/industries.js';
import { normalizeBusinessProfile } from '../../services/businessProfileService.js';
import { sanitizeFact } from '../../utils/text.js';
import { sanitizeList, buildQuestionInputs } from '../services/questionInputs.js';

/**
 * The business profile that AI-visibility questions are built from: GET shows what is stored (confirmed), what is only suggested, what
 * the questions will actually use, and what is missing or contradictory; PUT saves the customer's confirmation.
 *
 * Storage is the project itself (SeoProject.industry / sub_industry / target_city / location_source / visibility_profile). Nothing
 * here writes Social AI's profile; its services and competitors are shown as suggestions only. Every write is validated server-side
 * and a field is changed only when it is present in the body.
 *
 * Mounted behind auth + validateProjectAccess() (req.project is owned by the caller).
 */

const LIST_FIELDS = {
  services: 'services',
  targetCities: 'target_cities',
  serviceAreas: 'service_areas',
  customerTypes: 'customer_types',
  customerProblems: 'customer_problems',
  requirements: 'requirements',
  buyingRequirements: 'buying_requirements',
};

const loadProject = (id) => SeoProject.findOne({ _id: id, is_deleted: { $ne: true } }).lean();
const loadSocial = async (id) => {
  try { return await SocialBusinessProfile.findOne({ project_id: id }).select('services competitors').lean(); } catch { return null; }
};

/** The view model the profile screen renders. Exported for tests. */
export function toProfileDto(project, social) {
  const profile = normalizeBusinessProfile({ project, socialProfile: social });
  const { inputs, missing } = buildQuestionInputs(profile);
  const vp = project.visibility_profile || {};
  const confirmedList = (k) => (Array.isArray(vp[LIST_FIELDS[k]]) ? vp[LIST_FIELDS[k]] : []);
  const missingProfile = [];
  if (!isIndustryValue(project.industry)) missingProfile.push('industry');
  if (!profile.business.subIndustry) missingProfile.push('sub_industry');
  if (project.seo_scope === 'local' && !profile.market.city) missingProfile.push('target_city');
  return {
    project: {
      name: profile.business.name,
      website: project.main_url || null,
      businessType: project.business_type || null,
      industry: isIndustryValue(project.industry) ? project.industry : null,
      legacyIndustryText: project.industry && !isIndustryValue(project.industry) ? project.industry : null,
      subIndustry: project.sub_industry || null,
      targetCity: project.target_city || null,
      locationSource: project.location_source || null,
      location: project.location || null,
      country: project.country || null,
      seoScope: project.seo_scope || null,
      physicalCity: profile.market.physicalCity,
    },
    confirmed: {
      ...Object.fromEntries(Object.keys(LIST_FIELDS).map((k) => [k, confirmedList(k)])),
      language: vp.language || null,
      updatedAt: vp.updated_at || null,
    },
    // Shown to the customer to accept or ignore; never used until confirmed (except services, which the questions already fall back to).
    suggestions: {
      services: confirmedList('services').length ? [] : profile.business.services,
      servicesSource: confirmedList('services').length ? null : profile.business.servicesSource,
      city: profile.market.city && profile.market.citySource !== 'project.target_city' && profile.market.citySource !== 'visibility_profile.target_cities'
        ? { value: profile.market.city, source: profile.market.citySource } : null,
      competitors: profile.business.competitors,
    },
    // What the next question set would actually use.
    resolved: {
      category: inputs.categories[0] || null,
      services: inputs.services,
      targetCities: inputs.cities,
      citySource: profile.market.citySource,
      scope: profile.market.effectiveScope,
      language: inputs.language,
    },
    completeness: {
      missingProfile,
      missingForQuestions: missing,
      conflicts: profile.market.conflicts,
      warnings: profile.warnings,
      ready: !profile.warnings.includes('location_conflict') && inputs.categories.length + inputs.services.length > 0,
    },
    profileHash: profile.profileHash,
    industries: INDUSTRIES,
  };
}

export async function getProfile(req, res) {
  try {
    const project = await loadProject(req.project._id);
    if (!project) return res.status(404).json(ResponseUtil.error('Project not found', 404));
    return res.json(ResponseUtil.success(toProfileDto(project, await loadSocial(project._id))));
  } catch (error) {
    LoggerUtil.error('AI Visibility profile: load failed', { projectId: String(req.project?._id) });
    return res.status(500).json(ResponseUtil.error('Could not load the business profile', 500));
  }
}

/**
 * Validate a PUT body into a MongoDB $set. Only keys present are touched; null / [] clears a field. Returns the per-field errors instead
 * of silently dropping anything the customer typed.
 */
export function buildProfileUpdate(body = {}) {
  const set = {};
  const errors = {};
  const text = (field, max) => {
    const raw = body[field];
    if (raw === null || raw === '') return null;
    if (typeof raw !== 'string') { errors[field] = 'Must be text'; return undefined; }
    if (raw.trim().length > max) { errors[field] = `Keep it under ${max} characters`; return undefined; }
    const { value, flagged } = sanitizeFact(raw, max);
    if (flagged) { errors[field] = 'Contains a web address or text that is not allowed'; return undefined; }
    return value;
  };
  if ('industry' in body) {
    if (body.industry === null || body.industry === '') set.industry = null;
    else if (!isIndustryValue(body.industry)) errors.industry = 'Choose an industry from the list';
    else set.industry = body.industry;
  }
  if ('subIndustry' in body) { const v = text('subIndustry', 100); if (v !== undefined) set.sub_industry = v; }
  if ('targetCity' in body) {
    const v = text('targetCity', 100);
    if (v !== undefined) { set.target_city = v; set.location_source = v ? 'user_entered' : null; }
  }
  for (const [key, field] of Object.entries(LIST_FIELDS)) {
    if (!(key in body)) continue;
    if (body[key] === null) { set[`visibility_profile.${field}`] = []; continue; }
    if (!Array.isArray(body[key])) { errors[key] = 'Must be a list'; continue; }
    const { values, rejected, tooMany } = sanitizeList(body[key]);
    if (rejected) { errors[key] = 'Some entries are too long, or contain a web address or text that is not allowed'; continue; }
    if (tooMany) { errors[key] = 'Up to 10 entries'; continue; }
    set[`visibility_profile.${field}`] = values;
  }
  if ('language' in body) {
    if (body.language === null) set['visibility_profile.language'] = null;
    else if (typeof body.language !== 'string' || !/^[a-z]{2}(-[a-z]{2})?$/i.test(body.language)) errors.language = 'Choose a language';
    else set['visibility_profile.language'] = body.language.toLowerCase();
  }
  return { set, errors };
}

export async function updateProfile(req, res) {
  try {
    const { set, errors } = buildProfileUpdate(req.body && typeof req.body === 'object' ? req.body : {});
    if (Object.keys(errors).length) return res.status(422).json(ResponseUtil.error('Some details could not be saved', 422, { code: 'INVALID_PROFILE', fields: errors }));
    if (!Object.keys(set).length) return res.status(400).json(ResponseUtil.error('Nothing to save', 400, { code: 'NO_CHANGES' }));
    if (Object.keys(set).some((k) => k.startsWith('visibility_profile.'))) set['visibility_profile.updated_at'] = new Date();
    const updated = await SeoProject.findOneAndUpdate(
      { _id: req.project._id, user_id: req.project.user_id, is_deleted: { $ne: true } },
      { $set: set },
      { new: true, runValidators: true },
    ).lean();
    if (!updated) return res.status(404).json(ResponseUtil.error('Project not found', 404));
    return res.json(ResponseUtil.success(toProfileDto(updated, await loadSocial(updated._id)), 'Business profile saved'));
  } catch (error) {
    LoggerUtil.error('AI Visibility profile: save failed', { projectId: String(req.project?._id), name: error?.name });
    if (error?.name === 'ValidationError') return res.status(422).json(ResponseUtil.error('Some details could not be saved', 422, { code: 'INVALID_PROFILE' }));
    return res.status(500).json(ResponseUtil.error('Could not save the business profile', 500));
  }
}

export default { getProfile, updateProfile, toProfileDto, buildProfileUpdate };
