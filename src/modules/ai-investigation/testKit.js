/**
 * Test fixtures for the investigation engine: a scripted website, a scripted model, an in-memory store.
 * Nothing here touches the network, a database, or a real model.
 */

import { createMemoryStore } from './service/investigationStore.js';
import { clearLiveEvidenceCache } from './evidence/evidenceLedger.js';

export const SITE = 'https://www.sapphiredigitalagency.com';
export const PAGE = `${SITE}/about-us`;
export const PROJECT = { id: '64b000000000000000000001', siteUrl: `${SITE}/`, cms: null, framework: null };

export const jsonLd = (v) => `<script type="application/ld+json">${JSON.stringify(v)}</script>`;
export const breadcrumbLd = (...items) => ({
  '@context': 'https://schema.org', '@type': 'BreadcrumbList',
  itemListElement: items.map(([name, item], i) => ({ '@type': 'ListItem', position: i + 1, name, ...(item ? { item } : {}) })),
});

export const page = ({ head = '', body = '', title = 'About Us | Sapphire' } = {}) => `<!doctype html><html lang="en"><head><title>${title}</title><link rel="canonical" href="${PAGE}">${head}</head>
<body><header><nav><ul><li><a href="/">Home</a></li><li><a href="/about-us">About Us</a></li><li><a href="/services">Services</a></li></ul></nav></header><main><h1>${title}</h1>${body}</main></body></html>`;

export const VISIBLE_CRUMBS = '<nav aria-label="Breadcrumb"><ol><li><a href="/">Home</a></li><li aria-current="page">About Us</li></ol></nav>';

/** Fake fetcher: `routes` maps URL -> { status?, body?, headers?, redirects?, throw? }. Records every call. */
export function fakeFetcher(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const r = routes[url] ?? routes[url.replace(/\/$/, '')];
    if (!r) return { finalUrl: url, status: 404, headers: { 'content-type': 'text/html' }, body: 'not found', redirects: [] };
    if (r.throw) throw r.throw;
    return { finalUrl: r.finalUrl || url, status: r.status ?? 200, headers: { 'content-type': 'text/html; charset=utf-8', ...(r.headers || {}) }, body: r.body ?? '', redirects: r.redirects || [] };
  };
  fn.calls = calls;
  return fn;
}

/** Fake model: `replies` is an array of strings/objects/Errors consumed in order (last one repeats). */
export function fakeLlm(replies) {
  const seen = [];
  let i = 0;
  return {
    seen,
    isAvailable: () => true,
    async complete(req) {
      seen.push(req);
      const next = replies[Math.min(i, replies.length - 1)]; i += 1;
      if (next instanceof Error) throw next;
      if (typeof next === 'function') return next(req);
      return { text: typeof next === 'string' ? next : JSON.stringify(next), model: 'fake-model', tokens: { input: 100, output: 50 } };
    },
  };
}

export const ELIGIBLE = {
  eligibility: 'eligible', adapterId: 'wordpress_seo_bridge', field: 'breadcrumb_schema', scope: 'site', typedFix: true,
  requiredCapabilities: ['wordpress_connection', 'odito_seo_bridge'], missingCapabilities: [], operations: ['write:breadcrumb_schema'], reason: 'A trusted adapter can apply this after your approval.',
};
export const NOT_SUPPORTED = {
  eligibility: 'not_supported', adapterId: null, field: null, scope: null, typedFix: false,
  requiredCapabilities: [], missingCapabilities: [], operations: [], reason: 'Odito has no automatic-fix adapter for this issue type. A manual implementation plan is provided instead.',
};

/** Builds engine deps with sensible offline defaults. */
export function makeDeps(over = {}) {
  clearLiveEvidenceCache();
  return {
    store: createMemoryStore(),
    llm: fakeLlm([{}]),
    fetcher: fakeFetcher({}),
    resolveCapabilities: async () => NOT_SUPPORTED,
    loadDetectorContext: async (_p, issueId) => ({ currentState: { note: `detector flagged ${issueId}` }, expectedState: {} }),
    loadCrawlPage: async () => ({ title: 'About Us', canonical: PAGE, httpStatus: 200, structuredDataTypes: [], structuredData: [], crawledAt: '2026-10-20T08:00:00.000Z', pageIssues: [] }),
    loadSiblings: async () => [`${SITE}/services`],
    renderPage: null,
    now: () => Date.parse('2026-10-21T10:00:00.000Z'),
    sleep: async () => {},
    log: () => {},
    ...over,
  };
}

/** A schema-valid model answer; override any field. */
export const goodAnswer = (over = {}) => ({
  investigationStatus: 'complete', issueStatus: 'confirmed', confidence: { score: 0.85, label: 'high' },
  summary: 'The page has a visible breadcrumb but no BreadcrumbList JSON-LD.',
  evidence: [{ evidenceId: 'E3', finding: 'Live page has no BreadcrumbList.' }],
  rootCause: { category: 'page_markup', description: 'Breadcrumb is rendered visually only.', symptomVersusCause: 'Detector reports missing schema; the cause is that the theme emits no structured data.' },
  reasoning: 'E3 shows no JSON-LD; visible breadcrumb Home > About Us.',
  recommendedSolution: { method: 'automatic_fix', strategy: 'Add BreadcrumbList JSON-LD matching the visible breadcrumb.', rationale: 'Matches what users see.' },
  implementationPlan: [{ detail: 'Add the JSON-LD to the page head.', owner: 'odito' }],
  proposedChanges: [{ changeType: 'add', target: { url: PAGE, location: 'head' }, after: 'BreadcrumbList JSON-LD', description: 'Add schema' }],
  codeOrConfiguration: [{ language: 'json-ld', purpose: 'Breadcrumb schema', content: JSON.stringify(breadcrumbLd(['Home', `${SITE}/`], ['About Us', PAGE])) }],
  automaticFixEligibility: { eligible: true },
  risks: [{ risk: 'Duplicate schema if a plugin adds one later.', severity: 'low', mitigation: 'Re-check after apply.' }],
  validationPlan: [{ check: 'Re-fetch page', method: 'fetch + parse JSON-LD', expected: 'One valid BreadcrumbList' }],
  limitations: [], additionalEvidenceRequested: [], requiresHumanApproval: true,
  ...over,
});

export const issue = (over = {}) => ({ issueId: 'breadcrumblist_schema', pageUrl: PAGE, title: 'BreadcrumbList schema missing', category: 'Structured Data', severity: 'medium', ...over });

export const waitFor = async (runner, id) => { await runner.running.get(String(id)); };
