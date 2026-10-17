import crypto from 'crypto';
import { RecommendationRefusedError } from './recommendationRefusal.js';
import {
  generateBreadcrumbListJsonLd, serializeJsonLdForScript, breadcrumbUrlKey,
} from '../../schema-evidence/breadcrumbHierarchy.js';

/**
 * Deterministic recommendation for `breadcrumblist_schema` when the SITE OWNER supplied the hierarchy.
 *
 * Like faq_schema, this never calls the LLM: the correct BreadcrumbList is fully determined by the
 * validated names/URLs the owner confirmed (and the canonical URL ODITO verified from the crawl). Any model
 * involvement would be a chance to rename a page, "fix" a URL or invent a parent. Every prose field is a
 * fixed template.
 *
 * `recommendedVersion` stays the literal "enabled": that string is the contract of the existing Rank Math
 * breadcrumb toggle (providerCapabilityRegistry.js / valueNormalization.normalizeBreadcrumbEnableValue). The
 * JSON-LD lives in implementationExample, exactly where the LLM path puts its example.
 *
 * Generating this recommendation changes nothing on the website and nothing in any task: it is not
 * "implemented" and certainly not "verified" until a recrawl observes the deployed markup.
 */

export class BreadcrumbRecommendationError extends RecommendationRefusedError {
  constructor(code, message, statusCode = 422) {
    super(code, message, statusCode);
    this.name = 'BreadcrumbRecommendationError';
  }
}

/** Fingerprint keyed to the exact trail, so changing any name/URL/order never serves a stale recommendation. */
export function breadcrumbFingerprint(projectId, pageUrl, evidence) {
  const trail = evidence.breadcrumb.hierarchy.items.map((i) => [i.position, i.name, i.url]);
  return crypto
    .createHash('sha256')
    .update(`breadcrumb_user_hierarchy|${projectId}|${pageUrl}|${evidence.url.display}|${JSON.stringify(trail)}`)
    .digest('hex');
}

/**
 * The generated JSON-LD must be EXACTLY the generator's shape for exactly these items — no extra field,
 * nothing renamed, nothing reordered. Returns a list of problems (empty = exact).
 */
export function checkBreadcrumbJsonLdMatches(jsonLd, items) {
  const problems = [];
  const keys = (o) => (o && typeof o === 'object' ? Object.keys(o).sort().join(',') : '');
  if (!jsonLd || typeof jsonLd !== 'object' || Array.isArray(jsonLd)) return ['The JSON-LD is not a single object.'];
  if (keys(jsonLd) !== '@context,@type,itemListElement') problems.push(`Unexpected top-level fields: ${keys(jsonLd)}`);
  if (jsonLd['@context'] !== 'https://schema.org') problems.push('@context must be "https://schema.org".');
  if (jsonLd['@type'] !== 'BreadcrumbList') problems.push('@type must be "BreadcrumbList".');
  const list = jsonLd.itemListElement;
  if (!Array.isArray(list) || list.length !== items.length) { problems.push(`itemListElement must contain exactly ${items.length} items.`); return problems; }
  list.forEach((el, i) => {
    if (keys(el) !== '@type,item,name,position') problems.push(`Item ${i + 1} has unexpected fields: ${keys(el)}`);
    if (el['@type'] !== 'ListItem') problems.push(`Item ${i + 1} must be a ListItem.`);
    if (el.position !== i + 1) problems.push(`Item ${i + 1} has position ${el.position}; positions must be consecutive from 1.`);
    if (el.name !== items[i].name) problems.push(`Item ${i + 1} name does not match the confirmed name.`);
    if (el.item !== items[i].url) problems.push(`Item ${i + 1} URL does not match the confirmed URL.`);
  });
  const keysSeen = new Set(list.map((el) => breadcrumbUrlKey(el.item)));
  if (keysSeen.size !== list.length) problems.push('Two items point to the same URL.');
  return problems;
}

/**
 * @param {object} evidence  schemaEvidence whose breadcrumb.hierarchy.status === 'user_provided'
 * @returns {object} sections in the shape Recommendation.sections expects
 */
export function buildBreadcrumbSections(evidence) {
  const h = evidence.breadcrumb.hierarchy;
  if (h.status !== 'user_provided' || !h.items?.length) {
    throw new BreadcrumbRecommendationError('BREADCRUMB_HIERARCHY_UNVERIFIED', 'There is no confirmed breadcrumb hierarchy to build the schema from.');
  }
  const items = h.items;
  const jsonLd = generateBreadcrumbListJsonLd(items);
  const problems = checkBreadcrumbJsonLdMatches(jsonLd, items);
  if (problems.length) throw new BreadcrumbRecommendationError('BREADCRUMB_OUTPUT_INVALID', `The generated BreadcrumbList did not pass validation: ${problems.join(' ')}`);

  const trail = items.map((i) => i.name).join(' › ');
  const code = `<script type="application/ld+json">\n${serializeJsonLdForScript(jsonLd)}\n</script>`;

  return {
    whyThisMatters:
      'BreadcrumbList structured data tells search engines and AI answer engines where this page sits in your site ' +
      'and lets search results show the trail instead of a bare URL. Odito could not find a valid trail on the page, ' +
      'so this markup is built only from the hierarchy you confirmed.',
    recommendedFix: [
      `1. Review the trail: ${trail}. It was generated only from the pages and URLs you confirmed; the last item is this page's ${evidence.breadcrumb.userProvided?.canonicalSource === 'user_confirmed' ? 'URL as you confirmed it (no canonical tag was found)' : 'verified canonical URL'}.`,
      '2. Add it to the page in ONE of these ways — not both, or the page will output two BreadcrumbList entities:',
      '   • Your SEO plugin (for example Rank Math → Titles & Meta → Misc → Breadcrumbs): enabling breadcrumbs lets the plugin build the trail from your real page structure. If your site is connected, Odito can switch this setting on for you.',
      '   • Paste the JSON-LD below into this page\'s <head> (your theme\'s header-scripts or custom-code field) — only if the page does not already output a BreadcrumbList.',
      '3. Generating or copying this code does not change your website. Mark the task as implemented once it is live; Odito re-checks the page\'s actual markup on the next recrawl and only then reports it as fixed.',
    ].join('\n'),
    implementationExample: { type: 'html', content: code },
    expectedImpact: [
      'Search engines and AI answer engines can read this page\'s position in your site as structured data.',
      'The trail always matches the hierarchy you confirmed — no page was inferred or invented.',
    ],
    estimatedRecovery: { aiVisibility: 8, semanticTrust: 12, freshness: 0, accessibility: 0 },
    difficulty: 'easy',
    estimatedFixTime: '10 minutes',
    recommendedVersion: 'enabled',
    changeSummary: {
      items: [{
        field: 'BreadcrumbList schema (JSON-LD)',
        changeType: 'add',
        before: 'No valid BreadcrumbList on the page',
        after: `BreadcrumbList with ${items.length} items: ${trail}`,
        reason: 'The crawl found no valid breadcrumb trail; the hierarchy was confirmed by the site owner.',
        priority: 'medium',
      }],
    },
    sourceAttribution: {
      generatedBy: 'template',
      promptPath: 'deterministic_user_breadcrumb_hierarchy',
      promptGroup: null,
      contextSources: { userProvidedItems: items.length, evidenceHash: evidence.breadcrumb.userProvided?.evidenceHash || null, canonicalSource: evidence.breadcrumb.userProvided?.canonicalSource || null, llmUsed: false },
      modelUsed: null,
      cacheStatus: 'miss',
    },
  };
}

export default { BreadcrumbRecommendationError, breadcrumbFingerprint, buildBreadcrumbSections, checkBreadcrumbJsonLdMatches };
