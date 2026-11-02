import SeoProject from '../../app_user/model/SeoProject.js';
import BusinessProfileMetadata from '../../app_user/model/BusinessProfileMetadata.js';
import { normalizeTargetDomain } from '../../dataforseo-api/shared/targetDomain.js';
import { industryLabel } from '../../../config/industries.js';

/**
 * What the relevance classifier knows about the PROJECT: its own words for what it does and where it operates. Built only from fields
 * that exist (nothing is assumed populated) and never from the request.
 *
 * Trust rule (same as the schema-evidence module): the connected Google Business Profile's categories count only when its website is on
 * the same host as the project's own site. A profile that belongs to another brand must not shape the project's relevance judgement.
 */

const hostOf = (url) => { try { return normalizeTargetDomain(url); } catch { return null; } };
const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const finite = (n) => (typeof n === 'number' && Number.isFinite(n) ? n : null);

/** Pure: project + profile documents -> the classifier's profile. */
export function buildProfile(project, gbp = null) {
  if (!project) return null;
  const own = hostOf(project.main_url);
  const gbpHost = gbp?.website ? hostOf(gbp.website) : null;
  const trusted = Boolean(own && gbpHost && own === gbpHost);
  const vb = project.verified_business ?? {};
  const lat = finite(vb.location?.lat); const lng = finite(vb.location?.lng);
  const country = clean(project.country);
  return {
    ownDomain: own,
    ownPlaceId: clean(vb.placeId),
    address: clean(vb.address),
    industry: clean(project.industry),
    industryLabel: industryLabel(project.industry),
    subIndustry: clean(project.sub_industry),
    businessType: clean(project.business_type),
    services: (project.visibility_profile?.services ?? []).map(clean).filter(Boolean).slice(0, 20),
    gbp: { trusted, category: trusted ? clean(gbp.category) : null, secondary: trusted ? (gbp.secondary_categories ?? []).map(clean).filter(Boolean).slice(0, 10) : [], connected: Boolean(gbp) },
    scope: project.seo_scope === 'national' ? 'national' : project.seo_scope === 'local' ? 'local' : null,
    city: clean(project.target_city) ?? clean(vb.city),
    state: clean(project.target_state) ?? clean(vb.state),
    countryIso2: country && country.length === 2 ? country.toUpperCase() : clean(vb.countryCode)?.toUpperCase() ?? null,
    coords: lat !== null && lng !== null ? { lat, lng } : null,
  };
}

/** Loads the project and its connected Business Profile category, and builds the profile. Null when the project is gone. */
export async function loadProjectProfile(projectId) {
  const project = await SeoProject.findOne({ _id: projectId, is_deleted: { $ne: true } })
    .select('main_url industry sub_industry business_type seo_scope target_city target_state country verified_business visibility_profile').lean();
  if (!project) return null;
  const gbp = await BusinessProfileMetadata.findOne({ project_id: projectId }).select('category secondary_categories website').sort({ _id: -1 }).lean();
  return buildProfile(project, gbp);
}
