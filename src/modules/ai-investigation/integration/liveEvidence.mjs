/**
 * LIVE evidence check (real website, no model, no database). Opt-in.
 *   node src/modules/ai-investigation/integration/liveEvidence.mjs [pageUrl]
 * Runs the real evidence collector + breadcrumb analyzer with the production SSRF-safe fetcher and prints the hierarchy analysis.
 */
import { collectEvidence } from '../evidence/evidenceCollector.js';
import { resolveInvestigationPlan } from '../evidence/investigationPlans.js';
import { safeFetch } from '../net/ssrfGuard.js';
import { createInvestigationRenderer } from '../render/investigationRenderer.js';
import { getPdfBrowserService } from '../../pdf/render/pdfBrowserService.js';

const PAGE = process.argv[2] || 'https://www.sapphiredigitalagency.com/about-us/';
const FORCE_RENDER = process.env.FORCE_RENDER === '1';
const origin = new URL(PAGE).origin;
const issue = { issueId: 'breadcrumblist_schema', pageUrl: PAGE, title: 'BreadcrumbList schema missing', category: 'Structured Data' };
const renderer = createInvestigationRenderer();
const deps = {
  fetcher: safeFetch, now: () => Date.now(), loadDetectorContext: async () => null, loadCrawlPage: async () => null, loadSiblings: async () => [],
  renderPage: FORCE_RENDER ? renderer : renderer,
};
try {
  const ledger = await collectEvidence({ project: { id: 'live', siteUrl: `${origin}/` }, issue, plan: resolveInvestigationPlan(issue), deps });
  for (const e of ledger.items) console.log(`${e.id} ${e.kind.padEnd(20)} ${e.status.padEnd(11)} ${e.summary.slice(0, 150)}`);
  const a = ledger.items.find((i) => i.kind === 'structured_analysis');
  console.log('\n— breadcrumb hierarchy analysis —');
  console.log(JSON.stringify({ status: a.data.status, basis: a.data.basis, currentUrl: a.data.currentUrl, currentUrlSource: a.data.currentUrlSource, trail: a.data.trail, unresolved: a.data.unresolved, issues: a.data.issues, flags: a.data.flags, conventions: a.data.conventions, checkedUrls: a.data.checkedUrls }, null, 1));
  const home = ledger.first('homepage')?.data?.facts;
  console.log('\nhomepage nav links (first 12):', JSON.stringify((home?.navigation || []).slice(0, 12).map((n) => ({ text: n.text, url: n.url.replace(origin, ''), top: n.topLevel, parent: n.parent?.text || null }))));
} finally {
  await getPdfBrowserService().closeBrowser();
}
