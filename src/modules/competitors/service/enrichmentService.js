import SeoProject from '../../app_user/model/SeoProject.js';
import { getHeadToHead, getSectionForDomain } from '../../dataforseo-api/domain_overview/service/domainOverviewService.js';
import { resolveMarket } from '../../dataforseo-api/domain_overview/validator/domainOverviewValidation.js';
import { normalizeTargetDomain } from '../../dataforseo-api/shared/targetDomain.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import { backoffMs, getEnrichmentConfig } from '../config/enrichmentConfig.js';
import { classifyFailure, mapBacklinksSection, mapRankSection, mapSharedSection, overallStatus } from './enrichmentMetrics.js';
import { finishRun, reserveProviderCall, saveSection } from './enrichmentStore.js';

/**
 * Enriches ONE claimed competitor with SEO metrics about its website, in the background. Reuses the Domain Overview's provider code and
 * cache (getSectionForDomain), so nothing here talks to DataForSEO itself and an answer another page already bought costs nothing.
 *
 * Sections are fetched and SAVED one by one: a failure in one never discards another. A section that already has a fresh answer from this
 * request cycle is not fetched again on a retry. The comparison against the project's own domain ("shared": the keywords BOTH rank for,
 * DataForSEO Labs domain_intersection) is fetched after the competitor's own rank, because an empty answer is only a real zero when the
 * provider knows the competitor at all (see mapSharedSection).
 */

const SECTIONS = Object.freeze([
  { key: 'rank', provider: 'rank-overview', map: mapRankSection },
  { key: 'backlinks', provider: 'backlinks', map: mapBacklinksSection },
  // Needs the project's own domain and the rank section above; handled specially in the loop.
  { key: 'shared', provider: 'head-to-head', map: null },
]);
const SAFE_OWN = 'OWN_DOMAIN';

const defaultDeps = () => ({
  loadProject: (id) => SeoProject.findOne({ _id: id, is_deleted: { $ne: true } }).select('main_url country language user_id').lean(),
  getSection: getSectionForDomain,
  getHeadToHead,
  reserve: (projectId, cap) => reserveProviderCall(projectId, cap),
  save: saveSection,
  finish: finishRun,
  config: getEnrichmentConfig(),
  now: () => new Date(),
});

/** A section from this request cycle (fetched after the request was made) is fresh: a retry does not buy it again. */
const freshInThisCycle = (existing, requestedAt) => existing && (existing.status === 'ok' || existing.status === 'no_data')
  && existing.fetched_at && requestedAt && new Date(existing.fetched_at) >= new Date(requestedAt);

/**
 * @param {object} claim the document returned by claimNext (lean; enrichment.attempts already counts this run)
 * @param {string} owner the lease owner string used to claim it
 * @returns {Promise<{ outcome: string }>} for logs and tests; never throws
 */
export async function enrichClaimed(claim, owner, deps = {}) {
  const d = { ...defaultDeps(), ...deps };
  const id = claim._id;
  const attempts = claim.enrichment?.attempts ?? 1;
  const log = (message, extra = {}) => LoggerUtil.info(message, { competitorId: String(id), projectId: String(claim.project_id), ...extra });
  try {
    const project = await d.loadProject(claim.project_id);
    if (!project) {
      await d.finish({ id, owner, status: 'failed', errorCode: 'PROJECT_UNAVAILABLE', now: d.now() });
      return { outcome: 'project_unavailable' };
    }
    const market = resolveMarket(project);
    const marketDto = { location: market.location_name, language: market.language_name };
    let own = null;
    try { own = normalizeTargetDomain(project.main_url); } catch { own = null; }
    if (own && claim.domain === own) {
      // The project's own website can never be its competitor (the routes refuse it too): never compare a domain with itself.
      await d.finish({ id, owner, status: 'failed', errorCode: SAFE_OWN, market: marketDto, now: d.now() });
      return { outcome: 'own_domain' };
    }

    const results = { ...(claim.enrichment?.sections ?? {}) };
    const requestedAt = claim.enrichment?.requested_at;
    let totalCost = 0; let providerCalls = 0; let cacheHits = 0; let budgetStopped = false; let leaseLost = false;

    for (const { key, provider, map } of SECTIONS) {
      if (freshInThisCycle(results[key], requestedAt)) continue;
      const startedAt = d.now();
      let section;
      if (key === 'shared' && !own) {
        // Without the project's own domain there is nothing to compare against: say so, never guess.
        section = { status: 'no_data', data: null, fetched_at: startedAt, error_code: 'PROJECT_DOMAIN_UNAVAILABLE', cost: null, attempts };
        if (!(await d.save({ id, owner, key, section, now: d.now() }))) { leaseLost = true; break; }
        results[key] = section;
        continue;
      }
      try {
        // Asked only when a REAL call is about to be bought (never on a cache hit): reserves one of the project's daily calls.
        const onProviderCall = () => d.reserve(claim.project_id, d.config.projectDailyProviderCalls);
        const out = key === 'shared'
          ? await d.getHeadToHead({ projectDomain: own, domain: claim.domain, market, onProviderCall })
          : await d.getSection({ domain: claim.domain, market, section: provider, onProviderCall });
        if (out.cached) cacheHits += 1; else { providerCalls += 1; totalCost += out.cost ?? 0; }
        const mapped = key === 'shared' ? mapSharedSection(out.payload, { competitorHasData: results.rank?.status === 'ok' }) : map(out.payload);
        section = { status: mapped.status, data: mapped.data, fetched_at: out.fetchedAt ?? startedAt, error_code: null, cost: out.cost ?? null, attempts };
      } catch (err) {
        const failure = classifyFailure(err);
        if (!failure.countsAsAttempt) { budgetStopped = true; break; } // out of daily budget: nothing is written for this section; the run waits
        section = { status: 'failed', data: results[key]?.status === 'ok' ? results[key].data : null, fetched_at: results[key]?.fetched_at ?? null, error_code: failure.code, cost: null, attempts, _retryable: failure.retryable };
      }
      const { _retryable, ...stored } = section;
      if (!(await d.save({ id, owner, key, section: stored, now: d.now() }))) { leaseLost = true; break; }
      results[key] = { ...stored, ...(_retryable !== undefined ? { _retryable } : {}) };
    }
    if (leaseLost) { log('Competitor enrichment: lease lost, stopping', { attempts }); return { outcome: 'lease_lost' }; }

    const now = d.now();
    if (budgetStopped) {
      // Out of today's budget: wait (an hour at a time), and give the attempt back - this was not a failure of the competitor.
      const next = new Date(now.getTime() + 60 * 60_000);
      await d.finish({ id, owner, status: 'pending', nextAttemptAt: next, errorCode: 'PROJECT_BUDGET_EXCEEDED', market: marketDto, refundAttempt: true, now });
      log('Competitor enrichment: project daily budget reached, will retry later', { nextAttemptAt: next.toISOString() });
      return { outcome: 'budget' };
    }

    const sections = Object.fromEntries(SECTIONS.map(({ key }) => [key, results[key]]));
    const retryable = SECTIONS.some(({ key }) => sections[key]?.status === 'failed' && (sections[key]._retryable ?? true));
    const anyOk = SECTIONS.some(({ key }) => sections[key]?.status === 'ok');
    const firstError = SECTIONS.map(({ key }) => sections[key]).find((s) => s?.status === 'failed')?.error_code ?? null;
    if (retryable && attempts < d.config.maxAttempts) {
      const next = new Date(now.getTime() + backoffMs(attempts, d.config));
      await d.finish({ id, owner, status: 'pending', nextAttemptAt: next, errorCode: firstError, market: marketDto, succeeded: anyOk, now });
      log('Competitor enrichment: some sections failed, retry scheduled', { attempts, nextAttemptAt: next.toISOString(), errorCode: firstError, providerCalls, cacheHits, cost: totalCost });
      return { outcome: 'retry' };
    }
    const status = overallStatus(sections);
    await d.finish({ id, owner, status, errorCode: firstError, market: marketDto, succeeded: anyOk || status === 'enriched', now });
    log('Competitor enrichment: finished', { status, attempts, providerCalls, cacheHits, cost: totalCost, sections: Object.fromEntries(SECTIONS.map(({ key }) => [key, sections[key]?.status ?? null])) });
    return { outcome: status };
  } catch (err) {
    // Anything unexpected: record a SAFE code, never the message, and let the normal retry rules decide.
    LoggerUtil.error('Competitor enrichment: unexpected error', err, { competitorId: String(id), projectId: String(claim.project_id) });
    const now = d.now();
    const retry = attempts < d.config.maxAttempts;
    await d.finish({ id, owner, status: retry ? 'pending' : 'failed', nextAttemptAt: retry ? new Date(now.getTime() + backoffMs(attempts, d.config)) : null, errorCode: 'ENRICHMENT_ERROR', now }).catch(() => {});
    return { outcome: 'error' };
  }
}
