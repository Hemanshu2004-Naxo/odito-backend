import SeoRankingCurrent from '../../app_user/model/SeoRankingCurrent.js';
import SeoProject from '../../app_user/model/SeoProject.js';
import KeywordRankingService from './keywordRankingService.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * Keeps the TRACKED keywords' location (seo_rankings_current: location, location_code, country - what every add / rescan reads) in step
 * with the project's confirmed business location. Called after the Business Information location is saved.
 *
 * Local-scope projects only: a national project is ranked per country and has no business-location city to follow.
 * Never throws: the business location is already saved, so a failed sync is reported ({ synced: false, reason }) and the tracked
 * location is left exactly as it was - never half-updated, never guessed.
 *
 * Existing keywords keep the ranks they already have (they were measured at the OLD location); `changed` tells the caller that a
 * rescan is needed for them to reflect the new one.
 *
 * @returns {Promise<{ synced: boolean, changed: boolean, reason?: string, location?: string|null, locationCode?: number }>}
 */
export async function syncTrackedLocation(projectId, userId, { resolve = (id) => new KeywordRankingService().resolveLocationForProject(id) } = {}) {
  try {
    const project = await SeoProject.findOne({ _id: projectId, user_id: userId }).select('seo_scope verified_business location country').lean();
    if (!project) return { synced: false, changed: false, reason: 'PROJECT_NOT_FOUND' };
    if (project.seo_scope !== 'local') return { synced: false, changed: false, reason: 'NOT_LOCAL_SCOPE' };
    const address = project.verified_business?.address || project.location || null;
    if (!address) return { synced: false, changed: false, reason: 'NO_ADDRESS' };

    const canonical = await SeoRankingCurrent.findOne({ project_id: projectId, user_id: userId }).select('location location_code country').lean();
    if (!canonical) return { synced: false, changed: false, reason: 'NO_TRACKED_KEYWORDS' };

    // Already in step (same address, country known): nothing to look up. Keeps the read-time / pre-scan callers to two cheap queries.
    if (canonical.location === address && canonical.country && Number.isInteger(canonical.location_code)) return { synced: true, changed: false, location: address, locationCode: canonical.location_code };

    const { locationCode, resolvedCountry } = await resolve(String(projectId));
    if (!Number.isInteger(locationCode)) return { synced: false, changed: false, reason: 'LOCATION_UNRESOLVED' };

    const country = (resolvedCountry || project.country || canonical.country || null);
    const set = { location: address, location_code: locationCode, ...(country ? { country: String(country).toUpperCase() } : {}) };
    const changed = canonical.location_code !== locationCode || canonical.location !== address || (set.country && canonical.country !== set.country);
    if (changed) await SeoRankingCurrent.updateOne({ project_id: projectId, user_id: userId }, { $set: set });
    LoggerUtil.info('Tracked location synced with business location', { projectId: String(projectId), changed, locationCode });
    return { synced: true, changed, location: address, locationCode };
  } catch (err) {
    LoggerUtil.warn('Tracked location sync failed; tracked location left unchanged', { projectId: String(projectId), error: err?.message });
    return { synced: false, changed: false, reason: 'LOCATION_UNRESOLVED' };
  }
}
