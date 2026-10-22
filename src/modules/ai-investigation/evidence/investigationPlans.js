/**
 * investigationPlans — which evidence an issue needs. DATA, not code paths: the orchestrator, master prompt,
 * contract and verification are shared; only the list of facets differs per issue family.
 *
 * Facets (each implemented once in evidenceCollector):
 *   page        live fetch + inspect of the affected URL (always)
 *   siblings    a few same-site pages from the crawl, to learn site conventions
 *   homepage    the site root, for global navigation / shared templates
 *   robots_txt  /robots.txt
 *   sitemap     sitemap(s) referenced by robots.txt or /sitemap.xml
 *   llms_txt    /llms.txt (AI discoverability)
 *   headers     response headers of the page (cache, x-robots-tag, link)
 */

export const FACETS = Object.freeze(['page', 'siblings', 'homepage', 'robots_txt', 'sitemap', 'llms_txt', 'headers']);

// First match wins; patterns are tested against `${issueId} ${category} ${title}` lower-cased.
const PLAN_RULES = [
  { family: 'structured_data', test: /schema|structured|json-?ld|breadcrumb|faq|organization|sameas|rating|article|person|product|microdata/, facets: ['page', 'homepage', 'siblings'] },
  { family: 'crawlability_indexing', test: /robots|sitemap|index|crawl|noindex|disallow/, facets: ['page', 'robots_txt', 'sitemap', 'headers'] },
  { family: 'ai_visibility', test: /\bai\b|aeo|geo\b|aiso|llm|answer.?engine|generative|chatgpt|perplexity/, facets: ['page', 'robots_txt', 'llms_txt', 'sitemap'] },
  { family: 'canonical_redirect', test: /canonical|redirect|duplicate|hreflang|http.?status|301|302|404/, facets: ['page', 'headers', 'sitemap'] },
  { family: 'images_alt', test: /\balt\b|image|img/, facets: ['page', 'siblings'] },
  { family: 'accessibility', test: /accessib|aria|a11y|label|keyboard|contrast|focus|wcag|landmark/, facets: ['page'] },
  { family: 'performance', test: /speed|performance|lcp|cls|inp|fcp|ttfb|core.?web|render.?block|lazy|compress|cache/, facets: ['page', 'headers'] },
  { family: 'metadata_content', test: /title|meta|description|heading|h1|h2|keyword|content|og:|open.?graph|twitter/, facets: ['page', 'siblings'] },
  { family: 'internal_links', test: /link|anchor|orphan|navigation|depth/, facets: ['page', 'homepage'] },
];

const DEFAULT_PLAN = Object.freeze({ family: 'general', facets: ['page', 'homepage'] });

export function resolveInvestigationPlan({ issueId = '', category = '', title = '' } = {}) {
  const haystack = `${issueId} ${category} ${title}`.toLowerCase();
  const rule = PLAN_RULES.find((r) => r.test.test(haystack));
  const plan = rule ? { family: rule.family, facets: rule.facets } : DEFAULT_PLAN;
  return { family: plan.family, facets: [...plan.facets] };
}

export default { resolveInvestigationPlan, FACETS };
