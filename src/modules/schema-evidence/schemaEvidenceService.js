/**
 * schemaEvidenceService — assembles the verified evidence for one page + issue.
 *
 *   crawl data (seo_page_data) --build--> evidence --verify image URLs--> evidence
 *
 * Used by recommendationService before the prompt is built, for every schema issue that can
 * emit Organization / Article / BreadcrumbList markup (legacy rule ids and V2 hub ids alike).
 * Never throws: when the crawl data or the verifier is unavailable the evidence simply says
 * so (`pageDataAvailable: false`, logo status `unverified`) and the generator omits what it
 * cannot prove.
 */

import pageDataExtractor from '../issue-context/extractors/PageDataExtractor.js';
import { applyImageProbes, buildSchemaEvidence, evidenceKindsFor, imageUrlsToVerify } from './schemaEvidence.js';
import { verifyImageUrls } from './imageVerificationClient.js';
import { getUserBreadcrumbEvidence } from './breadcrumbEvidenceStore.js';
import { collectSiteEntity } from './siteEntity.js';
import { loadBusinessProfileFacts } from './businessProfileFacts.js';
import { loadAddressSources } from './organizationAddressStore.js';

export function appliesTo(issueId) {
  return evidenceKindsFor(issueId).length > 0;
}

/**
 * @param {{ projectId: string, issueId: string, pageUrl: string|null }} params
 * @param {{ extractor?: { extract: Function }, verify?: Function }} [deps] injectable for tests
 * @returns {Promise<object|null>} null when the issue does not need schema evidence
 */
export async function collectSchemaEvidence({ projectId, issueId, pageUrl }, { extractor = pageDataExtractor, verify = verifyImageUrls, loadUserBreadcrumb = getUserBreadcrumbEvidence, loadSite = collectSiteEntity, loadProfile = loadBusinessProfileFacts, loadAddress = loadAddressSources } = {}) {
  if (!appliesTo(issueId) || !pageUrl) return null;

  let extracted = {};
  try {
    extracted = (await extractor.extract(projectId, pageUrl)) || {};
  } catch (err) {
    console.warn(`[SCHEMA_EVIDENCE] page data unavailable for ${issueId}: ${err.message}`);
  }

  // The hierarchy the site owner confirmed for THIS project's page (scoped by projectId), if any.
  let userBreadcrumb = null;
  if (evidenceKindsFor(issueId).includes('breadcrumb')) {
    try {
      userBreadcrumb = await loadUserBreadcrumb(projectId, pageUrl);
    } catch (err) {
      console.warn(`[SCHEMA_EVIDENCE] saved breadcrumb hierarchy unavailable for ${issueId}: ${err.message}`);
    }
  }

  // Organization / LocalBusiness decisions need the SITE's entity (it normally lives on the homepage, not on the page
  // being fixed) and the owner-connected Business Profile. Both are this project's own data (scoped by projectId);
  // each degrades to "nothing found" rather than failing the recommendation.
  let site = null; let profile = null; let addressSources = null;
  if (evidenceKindsFor(issueId).includes('organization')) {
    try { site = await loadSite(projectId); } catch (err) { console.warn(`[SCHEMA_EVIDENCE] site entity unavailable for ${issueId}: ${err.message}`); }
    try {
      const origin = (() => { try { return new URL(pageUrl).origin; } catch { return null; } })();
      profile = await loadProfile(projectId, origin);
    } catch (err) { console.warn(`[SCHEMA_EVIDENCE] business profile unavailable for ${issueId}: ${err.message}`); }
    // Where the organization's postal address could come from beyond the page's markup: the owner-confirmed address and
    // the business details ODITO already stores. Each is this project's own data and degrades to "nothing found".
    try {
      const origin = (() => { try { return new URL(pageUrl).origin; } catch { return null; } })();
      addressSources = await loadAddress(projectId, { siteUrl: origin });
    } catch (err) { console.warn(`[SCHEMA_EVIDENCE] address sources unavailable for ${issueId}: ${err.message}`); }
  }

  const evidence = buildSchemaEvidence({
    issueId, pageUrl, site, profile, addressSources,
    pageData: extracted.pageData || null,
    headingsByTag: extracted.headingsByTag || {},
    pageType: extracted.pageType || null,
    userBreadcrumb,
  });

  const urls = imageUrlsToVerify(evidence);
  if (!urls.length) return applyImageProbes(evidence, []);

  let probes = [];
  try {
    probes = await verify(urls);
  } catch (err) {
    console.warn(`[SCHEMA_EVIDENCE] image verification failed for ${issueId}: ${err.message}`);
  }
  return applyImageProbes(evidence, probes);
}

export default { collectSchemaEvidence, appliesTo };
