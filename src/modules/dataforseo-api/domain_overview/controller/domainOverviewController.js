import { getDomainOverviewSection } from '../service/domainOverviewService.js';
import { parseMonths, parsePeek, parseRefresh, parseSection } from '../validator/domainOverviewValidation.js';
import { parseSectionQuery } from '../service/sectionQuery.js';
import { COMPETITORS_PARAMS } from '../validator/competitorsQuery.js';
import { BACKLINKS_PARAMS } from '../validator/backlinksQuery.js';
import { BACKLINKS_LIST_PARAMS } from '../validator/backlinksListQuery.js';
import { ANCHORS_PARAMS } from '../validator/anchorsQuery.js';
import { REFERRING_DOMAINS_PARAMS } from '../validator/referringDomainsQuery.js';
import { DOMAIN_PAGES_PARAMS } from '../validator/domainPagesQuery.js';
import { getTopPagesSection } from '../service/topPagesService.js';
import { PEEKABLE_SECTIONS, dbFirstReads } from '../config.js';
import { ProviderBudgetExceeded } from '../service/providerBudget.js';
import { mongoRunStore } from '../../seo_data/service/scanRunStore.js';
import { BULK_TRAFFIC_PARAMS } from '../validator/bulkTrafficQuery.js';
import { ValidationFailure } from '../../shared/targetDomain.js';
import { DataForSeoApiError, DATAFORSEO_HTTP_STATUS, DATAFORSEO_USER_MESSAGE } from '../../shared/providerErrors.js';
import { LoggerUtil } from '../../../../utils/LoggerUtil.js';

/**
 * Runs AFTER auth + validateProjectAccess(): `req.user` is the authenticated user and `req.project` a project that user owns.
 * The DataForSEO target is always derived from req.project — never from the request.
 */

export function sendError(res, err, context) {
  if (err instanceof ValidationFailure) {
    // A full list (tracked / excluded) conflicts with what is already saved; everything else is a bad request.
    const status = err.code === 'INVALID_TARGET' ? 422 : /_LIMIT_REACHED$/.test(err.code) ? 409 : 400;
    return res.status(status).json({ success: false, code: err.code, field: err.field, message: err.message });
  }
  if (err instanceof ProviderBudgetExceeded) {
    return res.status(429).json({ success: false, code: 'RATE_LIMITED', message: err.message });
  }
  if (err instanceof DataForSeoApiError) {
    return res.status(DATAFORSEO_HTTP_STATUS[err.code] || 502).json({
      success: false, code: err.code, message: DATAFORSEO_USER_MESSAGE[err.code] || 'The data service is temporarily unavailable.',
    });
  }
  LoggerUtil.error('Domain overview: unexpected error', err, context);
  return res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' });
}

const RANKED_PARAMS = ['limit', 'offset', 'order_by', 'filters'];
/** The query parameters each section understands (besides refresh, and months for the history). */
const ALLOWED_PARAMS = Object.freeze({
  'ranked-keywords': RANKED_PARAMS,
  'competitors': COMPETITORS_PARAMS,
  'backlinks': BACKLINKS_PARAMS,
  'backlinks-list': BACKLINKS_LIST_PARAMS,
  'anchors': ANCHORS_PARAMS,
  'anchor-profile': [],
  'referring-domains': REFERRING_DOMAINS_PARAMS,
  'rd-rank-buckets': [],
  'rd-toxic-count': [],
  'rd-last-30': [],
  'domain-pages': DOMAIN_PAGES_PARAMS,
  'tp-counts': [],
  'tp-fix-first': [],
  'top-pages-traffic': [],
  'bulk-traffic': BULK_TRAFFIC_PARAMS,
});
const MANAGED_PARAMS = [...new Set(Object.values(ALLOWED_PARAMS).flat())];

/** GET /projects/:projectId/domain-overview/:section?refresh=1 */
export async function getSection(req, res) {
  try {
    const section = parseSection(req.params.section);
    const refresh = parseRefresh(req.query.refresh);
    // `months` only means something for the history; sending it to another section is a mistake worth a 400, not a silent no-op.
    if (req.query.months !== undefined && section !== 'history') throw new ValidationFailure('months', 'months applies to the history section only');
    const months = parseMonths(req.query.months);
    const peek = parsePeek(req.query.peek);
    if (peek && !PEEKABLE_SECTIONS.includes(section)) throw new ValidationFailure('peek', `peek applies to ${PEEKABLE_SECTIONS.join(', ')} only`);
    // Each section accepts only its own query parameters (the names overlap: limit / offset / order_by / filters / status), so a parameter
    // meant for another section is a mistake worth a 400, never a silent no-op. Everything is validated against whitelists before a billed call.
    const stray = MANAGED_PARAMS.filter((k) => req.query[k] !== undefined && !(ALLOWED_PARAMS[section] ?? []).includes(k));
    if (stray.length) throw new ValidationFailure('query', `${stray.join(', ')} do not apply to the ${section} section`);
    // A page Refresh while a scan is collecting for this project would buy the same data twice: refuse it, the scan will deliver.
    if (refresh && await mongoRunStore.findActive(req.project._id)) {
      return res.status(409).json({ success: false, code: 'SCAN_IN_PROGRESS', message: 'An SEO scan is collecting data for this project right now. Please wait for it to finish.' });
    }
    const query = parseSectionQuery(section, req.query, req.project);
    // The table and "Fix first" are answered with the traffic per page joined on (see service/topPagesService.js); every other section as it is.
    const ask = section === 'domain-pages' || section === 'tp-fix-first' ? getTopPagesSection : getDomainOverviewSection;
    // Opening a page is READ-ONLY: it answers from what is stored (SEO_DB_FIRST_READS, on by default). Only an explicit refresh (or a scan,
    // see seo_data/) may buy provider data; SEO_DB_FIRST_READS=false restores the old read-through behaviour.
    const data = await ask({ project: req.project, section, refresh, peek, months, query, userId: String(req.user?._id || ''), providerAllowed: !dbFirstReads() || refresh });
    // Per-user project data: nothing between the server and the browser may keep a copy (React Query owns client freshness).
    res.set('Cache-Control', 'no-store');
    return res.status(200).json({ success: true, data });
  } catch (err) {
    return sendError(res, err, { userId: String(req.user?._id || ''), projectId: String(req.project?._id || ''), section: req.params.section });
  }
}
