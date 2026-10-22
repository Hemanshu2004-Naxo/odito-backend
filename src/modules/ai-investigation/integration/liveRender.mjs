/**
 * LIVE render check (real website, real Chrome, production SSRF policy). Opt-in; not part of routine runs.
 *   node src/modules/ai-investigation/integration/liveRender.mjs [pageUrl]
 * Only READS the site. Prints what the production renderer saw and what its navigation policy blocked.
 */
import { createInvestigationRenderer } from '../render/investigationRenderer.js';
import { getPdfBrowserService } from '../../pdf/render/pdfBrowserService.js';
import { inspectHtml } from '../evidence/pageInspector.js';
import { safeFetch } from '../net/ssrfGuard.js';
import { compareRawRendered } from '../evidence/renderComparison.js';

const PAGE = process.argv[2] || 'https://www.sapphiredigitalagency.com/about-us/';
const siteUrl = `${new URL(PAGE).origin}/`;
const renderer = createInvestigationRenderer();
try {
  const raw = await safeFetch(PAGE, { restrictToHost: siteUrl });
  const rawFacts = inspectHtml(raw.body, raw.finalUrl);
  console.log('raw fetch:', raw.status, raw.finalUrl, `${raw.body.length} bytes`, '| jsonLd types:', rawFacts.structuredData.jsonLdTypes.join(','));
  const t0 = Date.now();
  const out = await renderer(PAGE, { siteUrl, projectId: 'live-check' });
  console.log(`render: HTTP ${out.httpStatus} -> ${out.finalUrl} in ${Date.now() - t0} ms (navigation ${out.timings.navigationMs} ms, settle ${out.timings.settleMs} ms)`);
  console.log('rendered jsonLd types:', out.facts.structuredData.jsonLdTypes.join(','), '| html bytes:', out.htmlBytes, 'truncated:', out.htmlTruncated);
  console.log('requests:', JSON.stringify({ total: out.requests.total, allowed: out.requests.allowed, blocked: out.requests.blocked, blockedByReason: out.requests.blockedByReason, thirdPartyHosts: out.requests.thirdPartyHosts.length, bytes: out.requests.bytes }));
  const cmp = compareRawRendered(rawFacts, out.facts);
  console.log('raw vs rendered:', cmp.summary);
  for (const d of cmp.differences) console.log('  -', d.aspect, JSON.stringify(d.raw), '=>', JSON.stringify(d.rendered));
  console.log('breadcrumb: raw lists', rawFacts.structuredData.breadcrumbLists.length, '| rendered lists', out.facts.structuredData.breadcrumbLists.length, '| rendered visible', out.facts.visibleBreadcrumbs.length);
} catch (e) {
  console.log('RENDER FAILED:', e.code, e.message, e.details ? JSON.stringify(e.details.requests?.blockedByReason || {}) : '');
} finally {
  await getPdfBrowserService().closeBrowser();
}
