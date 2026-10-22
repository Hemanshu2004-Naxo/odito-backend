import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectHtml } from './pageInspector.js';
import { collectEvidence, parseRobotsTxt, isOnSite } from './evidenceCollector.js';
import { resolveInvestigationPlan } from './investigationPlans.js';
import { EvidenceLedger, clearLiveEvidenceCache } from './evidenceLedger.js';
import { SafeFetchError, SSRF_ERROR } from '../net/ssrfGuard.js';
import { decideRender } from './renderDecision.js';
import { compareRawRendered } from './renderComparison.js';
import { PAGE, SITE, PROJECT, page, jsonLd, breadcrumbLd, VISIBLE_CRUMBS, fakeFetcher, makeDeps, issue } from '../testKit.js';

test('inspectHtml: reads JSON-LD (valid + broken), visible breadcrumb, images without alt, nav and a11y signals', () => {
  const html = page({
    head: jsonLd(breadcrumbLd(['Home', `${SITE}/`], ['About Us', PAGE])) + '<script type="application/ld+json">{ broken</script>',
    body: `${VISIBLE_CRUMBS}<img src="/a.png"><img src="/b.png" alt=""><img src="/c.png" alt="ok"><input type="text" name="q"><a href="/x"></a>`,
  });
  const f = inspectHtml(html, PAGE);
  assert.equal(f.title, 'About Us | Sapphire');
  assert.deepEqual(f.canonicalLinks, [PAGE]);
  assert.ok(f.structuredData.jsonLdTypes.includes('BreadcrumbList'));
  assert.equal(f.structuredData.invalidJsonLdBlocks, 1);
  assert.equal(f.structuredData.breadcrumbLists[0].itemCount, 2);
  assert.equal(f.visibleBreadcrumbs[0].items[0].name, 'Home');
  assert.equal(f.images.total, 3);
  assert.equal(f.images.missingAltAttribute, 1);
  assert.equal(f.images.emptyAlt, 1);
  assert.ok(f.accessibilitySignals.some((s) => s.type === 'form_control_without_label'));
  assert.ok(f.accessibilitySignals.some((s) => s.type === 'link_without_accessible_name'));
  assert.ok(f.navigation.some((n) => n.text === 'Services' && n.url === `${SITE}/services`));
});

test('inspectHtml: output is bounded for huge pages', () => {
  const body = Array.from({ length: 500 }, (_, i) => `<a href="/p${i}">Link ${i}</a><img src="/i${i}.png"><h2>H ${i}</h2>`).join('');
  const f = inspectHtml(`<html><body><nav>${body}</nav></body></html>`, PAGE);
  assert.ok(f.navigation.length <= 60);
  assert.ok(f.images.sample.length <= 25);
  assert.ok(f.headings.length <= 40);
});

test('inspectHtml: flags a probable client-rendered shell', () => {
  const html = '<html><head><script src="/a.js"></script><script src="/b.js"></script><script src="/c.js"></script></head><body><div id="root"></div></body></html>';
  const f = inspectHtml(html, PAGE);
  assert.equal(f.rendering.likelyClientRendered, true);
  assert.equal(f.rendering.spaRootEmpty, true);
});

test('parseRobotsTxt: page verdict, AI bots, sitemaps', () => {
  const r = parseRobotsTxt('User-agent: *\nDisallow: /private\nAllow: /private/ok\nUser-agent: GPTBot\nDisallow: /\nSitemap: https://x.test/sitemap.xml', 'https://x.test/private/page');
  assert.equal(r.pageForAllBots, 'disallowed');
  assert.equal(r.aiBots.gptbot, 'disallowed');
  assert.deepEqual(r.sitemaps, ['https://x.test/sitemap.xml']);
  assert.equal(parseRobotsTxt('User-agent: *\nDisallow: /private', 'https://x.test/about').pageForAllBots, 'allowed');
});

test('plans: same engine, different facets by issue family (no per-issue code paths)', () => {
  assert.equal(resolveInvestigationPlan({ issueId: 'breadcrumblist_schema' }).family, 'structured_data');
  assert.ok(resolveInvestigationPlan({ issueId: 'breadcrumblist_schema' }).facets.includes('homepage'));
  assert.equal(resolveInvestigationPlan({ issueId: 'images_missing_alt_text' }).family, 'images_alt');
  assert.equal(resolveInvestigationPlan({ issueId: 'canonical_tag_errors' }).family, 'canonical_redirect');
  assert.equal(resolveInvestigationPlan({ issueId: 'noindex_key_pages' }).family, 'crawlability_indexing');
  assert.equal(resolveInvestigationPlan({ issueId: 'keyboard_accessibility' }).family, 'accessibility');
  assert.equal(resolveInvestigationPlan({ issueId: 'AEO-12', title: 'Answer engine readiness' }).family, 'ai_visibility');
  assert.equal(resolveInvestigationPlan({ issueId: 'totally_new_issue' }).family, 'general');
});

test('isOnSite: www-insensitive, rejects other hosts and garbage', () => {
  assert.equal(isOnSite('https://sapphiredigitalagency.com/x', 'https://www.sapphiredigitalagency.com/'), true);
  assert.equal(isOnSite('https://evil.test/x', 'https://www.sapphiredigitalagency.com/'), false);
  assert.equal(isOnSite('nope', 'https://www.sapphiredigitalagency.com/'), false);
});

const run = (over = {}, iss = issue()) => {
  const deps = makeDeps(over);
  const plan = resolveInvestigationPlan(iss);
  return collectEvidence({ project: PROJECT, issue: iss, plan, deps }).then((ledger) => ({ ledger, deps }));
};

test('collector: records source, method and timestamp for every item; page facts come from the LIVE fetch', async () => {
  const fetcher = fakeFetcher({ [PAGE]: { body: page({ body: VISIBLE_CRUMBS }) }, [`${SITE}/`]: { body: page() }, [`${SITE}/services`]: { body: page({ title: 'Services' }) } });
  const { ledger } = await run({ fetcher });
  const kinds = ledger.items.map((i) => i.kind);
  for (const k of ['detector', 'crawl_page', 'page', 'rendering_comparison', 'render_decision', 'homepage', 'sibling']) assert.ok(kinds.includes(k), k);
  assert.ok(!kinds.includes('rendered_dom'), 'a plain server-rendered page is not rendered');
  assert.ok(ledger.items.every((i) => i.source && i.method && i.retrievedAt));
  const pageItem = ledger.first('page');
  assert.equal(pageItem.source, 'live_fetch');
  assert.equal(pageItem.data.facts.visibleBreadcrumbs.length, 1);
  // Stored crawl keeps ITS OWN timestamp: it is never presented as current.
  assert.equal(ledger.first('crawl_page').retrievedAt, '2026-10-20T08:00:00.000Z');
  assert.equal(ledger.first('crawl_page').source, 'crawl_data');
});

const SHELL = '<!doctype html><html><head><title>App</title><script src="/a.js"></script><script src="/b.js"></script><script src="/c.js"></script></head><body><div id="root"></div></body></html>';
const renderedFacts = (html) => inspectHtml(html, PAGE);
const okRender = (html, extra = {}) => async () => ({ facts: renderedFacts(html), finalUrl: PAGE, httpStatus: 200, redirects: [], timings: { totalMs: 321, navigationMs: 200, settleMs: 100 }, htmlBytes: html.length, htmlTruncated: false, requests: { total: 9, allowed: 8, blocked: 1, blockedByReason: {}, blockedSample: [], thirdPartyHosts: [] }, engine: 'chromium', ...extra });

test('collector: render decision is recorded; a plain page is NOT rendered even when a renderer exists (no unnecessary rendering)', async () => {
  let calls = 0;
  const { ledger } = await run({ fetcher: fakeFetcher({ [PAGE]: { body: page({ body: VISIBLE_CRUMBS }) } }), renderPage: async () => { calls += 1; return {}; } });
  assert.equal(calls, 0);
  const d = ledger.first('render_decision');
  assert.equal(d.data.render, false);
  assert.match(d.summary, /Rendering skipped/);
  assert.equal(ledger.find('rendered_dom').length, 0);
});

test('collector: JS-dependent page without a renderer -> rendered_dom is UNAVAILABLE (never silently skipped)', async () => {
  const { ledger } = await run({ fetcher: fakeFetcher({ [PAGE]: { body: SHELL } }) });
  assert.equal(ledger.first('render_decision').data.render, true);
  const r = ledger.find('rendered_dom')[0];
  assert.equal(r.status, 'unavailable');
  assert.equal(r.error.code, 'RENDER_UNAVAILABLE');
});

test('collector: families whose diagnosis cannot depend on the DOM never render, whatever the page looks like', async () => {
  let calls = 0;
  const iss = issue({ issueId: 'noindex_key_pages', title: 'Noindex', category: 'Indexability' });
  const deps = makeDeps({ fetcher: fakeFetcher({ [PAGE]: { body: SHELL } }), renderPage: async () => { calls += 1; return {}; } });
  const ledger = await collectEvidence({ project: PROJECT, issue: iss, plan: resolveInvestigationPlan(iss), deps });
  assert.equal(calls, 0);
  assert.match(ledger.first('render_decision').summary, /cannot change the diagnosis/);
});

test('collector: a JS-built page is rendered through deps.renderPage with site scope; raw and rendered evidence are compared with provenance', async () => {
  const rendered = page({ head: jsonLd(breadcrumbLd(['Home', `${SITE}/`], ['About', PAGE])), body: VISIBLE_CRUMBS });
  let seen;
  const { ledger } = await run({ fetcher: fakeFetcher({ [PAGE]: { body: SHELL } }), renderPage: async (url, opts) => { seen = { url, ...opts }; return okRender(rendered)(); } });
  assert.equal(seen.url, PAGE);
  assert.equal(seen.siteUrl, PROJECT.siteUrl);
  assert.equal(seen.projectId, PROJECT.id);
  const ren = ledger.first('rendered_dom');
  assert.match(ren.method, /headless render/);
  assert.match(ren.summary, /321 ms/);
  const cmp = ledger.first('raw_vs_rendered');
  assert.equal(cmp.source, 'derived_analysis');
  assert.deepEqual(cmp.derivedFrom, [ledger.first('page').id, ren.id]);
  assert.deepEqual(cmp.data.jsonLdTypesOnlyRendered.includes('BreadcrumbList'), true);
  assert.equal(cmp.data.identical, false);
  assert.ok(cmp.data.differences.some((d) => d.aspect === 'breadcrumbListCount'));
});

test('collector: render failures are recorded with the right status (blocked by policy / timeout / busy) and never fail the investigation', async () => {
  const cases = [['RENDER_NAVIGATION_BLOCKED', 'blocked'], ['RENDER_POLICY_VIOLATION', 'blocked'], ['RENDER_TIMEOUT', 'error'], ['RENDER_FAILED', 'error'], ['RENDERER_BUSY', 'unavailable'], ['RENDERER_UNAVAILABLE', 'unavailable'], ['RENDER_CANCELLED', 'unavailable']];
  for (const [code, status] of cases) {
    const { ledger } = await run({ fetcher: fakeFetcher({ [PAGE]: { body: SHELL } }), renderPage: async () => { throw Object.assign(new Error(`boom ${code}`), { code, details: { requests: { total: 3 } } }); } });
    const r = ledger.find('rendered_dom')[0];
    assert.equal(r.status, status, code);
    assert.equal(r.error.code, code);
    assert.equal(ledger.find('raw_vs_rendered').length, 0);
    assert.ok(ledger.first('page'), 'raw evidence is unaffected');
  }
});

test('collector: unreachable page -> explicit error entry, stored crawl evidence still collected', async () => {
  const fetcher = fakeFetcher({ [PAGE]: { throw: new SafeFetchError(SSRF_ERROR.TIMEOUT, 'The page took too long to respond.') } });
  const { ledger } = await run({ fetcher });
  const p = ledger.find('page')[0];
  assert.equal(p.status, 'error');
  assert.equal(p.error.code, SSRF_ERROR.TIMEOUT);
  assert.ok(ledger.first('crawl_page'));
  assert.equal(ledger.first('page'), null);
});

test('collector: HTTP 403/500 is an error entry (blocked page), not "no problems found"', async () => {
  const { ledger } = await run({ fetcher: fakeFetcher({ [PAGE]: { status: 403, body: 'Forbidden' } }) });
  const p = ledger.find('page')[0];
  assert.equal(p.status, 'error');
  assert.equal(p.error.code, 'HTTP_403');
});

test('collector: SSRF-blocked destination is recorded as blocked', async () => {
  const { ledger } = await run({ fetcher: fakeFetcher({ [PAGE]: { throw: new SafeFetchError(SSRF_ERROR.BLOCKED_ADDRESS, 'This address is not publicly routable.') } }) });
  assert.equal(ledger.find('page')[0].status, 'blocked');
});

test('collector: a URL outside the audited site is never fetched', async () => {
  const fetcher = fakeFetcher({});
  const deps = makeDeps({ fetcher });
  const iss = issue({ pageUrl: 'https://evil.example/steal' });
  const ledger = await collectEvidence({ project: PROJECT, issue: iss, plan: resolveInvestigationPlan(iss), deps });
  assert.equal(fetcher.calls.length, 0);
  assert.equal(ledger.items[0].status, 'blocked');
  assert.equal(ledger.items[0].error.code, 'OUT_OF_SCOPE');
});

test('collector: each URL is fetched once per investigation', async () => {
  const fetcher = fakeFetcher({ [PAGE]: { body: page() }, [`${SITE}/`]: { body: page() }, [`${SITE}/services`]: { body: page() } });
  await run({ fetcher });
  assert.equal(fetcher.calls.filter((u) => u === PAGE).length, 1);
  assert.equal(new Set(fetcher.calls).size, fetcher.calls.length);
});

test('ledger: recent live evidence is reused across investigations with its ORIGINAL retrieval time and flagged fromCache', async () => {
  const fetcher = fakeFetcher({ [PAGE]: { body: page() }, [`${SITE}/`]: { body: page() }, [`${SITE}/services`]: { body: page() } });
  const base = makeDeps({ fetcher }); // clears the cache once
  const t0 = Date.parse('2026-10-21T10:00:00.000Z');
  const go = (now) => collectEvidence({ project: PROJECT, issue: issue(), plan: resolveInvestigationPlan(issue()), deps: { ...base, now: () => now } });
  const first = await go(t0);
  const second = await go(t0 + 30_000);
  const stale = await go(t0 + 10 * 60_000);
  clearLiveEvidenceCache();
  assert.equal(first.first('page').fromCache, false);
  assert.equal(second.first('page').fromCache, true);
  assert.equal(second.first('page').retrievedAt, first.first('page').retrievedAt, 'a cached item must not look newer than it is');
  assert.equal(stale.first('page').fromCache, false, 'expired entries are refetched');
});

test('ledger: freshness helpers', () => {
  let now = 1_000_000;
  const l = new EvidenceLedger({ now: () => now });
  const item = l.add({ kind: 'x', source: 's', method: 'm' });
  now += 5000;
  assert.equal(l.isFresh(item, 10_000), true);
  assert.equal(l.isFresh(item, 1000), false);
});

test('collector: robots.txt / sitemap facets for crawlability issues', async () => {
  const iss = issue({ issueId: 'noindex_key_pages', title: 'Noindex', category: 'Indexability' });
  const fetcher = fakeFetcher({
    [PAGE]: { body: page({ head: '<meta name="robots" content="noindex">' }), headers: { 'x-robots-tag': 'noindex' } },
    [`${SITE}/robots.txt`]: { body: `User-agent: *\nDisallow: /about-us\nSitemap: ${SITE}/sitemap_index.xml`, headers: { 'content-type': 'text/plain' } },
    [`${SITE}/sitemap_index.xml`]: { body: `<urlset><url><loc>${PAGE}</loc></url></urlset>`, headers: { 'content-type': 'application/xml' } },
  });
  const deps = makeDeps({ fetcher });
  const ledger = await collectEvidence({ project: PROJECT, issue: iss, plan: resolveInvestigationPlan(iss), deps });
  assert.equal(ledger.first('robots_txt').data.parsed.pageForAllBots, 'disallowed');
  assert.equal(ledger.first('sitemap').data.summary.pageListed, true);
  assert.equal(ledger.first('response_headers').data.headers['x-robots-tag'], 'noindex');
});

test('inspectHtml: Open Graph tags are read (regression: cheerio .map flattening broke this on every real page with og: tags)', () => {
  const f = inspectHtml('<html><head><meta property="og:locale" content="en_US"><meta property="og:title" content="About"><meta property="og:type" content="website"></head><body></body></html>', PAGE);
  assert.deepEqual(f.openGraph, { 'og:locale': 'en_US', 'og:title': 'About', 'og:type': 'website' });
});

test('decideRender: policy table — signals trigger, absence of signals does not, "never" families never', () => {
  const plain = inspectHtml(page({ body: '<p>' + 'text '.repeat(400) + '</p>' }), PAGE);
  const shell = inspectHtml(SHELL, PAGE);
  const sf = { family: 'structured_data' };
  assert.equal(decideRender({ plan: sf, rawFacts: plain }).render, false);
  assert.equal(decideRender({ plan: sf, rawFacts: shell }).render, true);
  assert.equal(decideRender({ plan: sf, rawFacts: plain, comparison: { inCrawlOnly: ['BreadcrumbList'] } }).render, true, 'crawl saw markup the raw HTML lacks');
  assert.equal(decideRender({ plan: { family: 'performance' }, rawFacts: shell }).render, false);
  assert.equal(decideRender({ plan: { family: 'crawlability_indexing' }, rawFacts: shell }).render, false);
  assert.equal(decideRender({ plan: sf, rawFacts: null }).render, false);
  const sparse = inspectHtml('<html><body><p>' + 'text '.repeat(400) + '</p></body></html>', PAGE);
  assert.equal(decideRender({ plan: { family: 'internal_links' }, rawFacts: sparse }).render, true, 'almost no links in raw HTML');
  const scripty = inspectHtml('<html><head><script src="1.js"></script><script src="2.js"></script><script src="3.js"></script></head><body><p>' + 'text '.repeat(400) + '</p></body></html>', PAGE);
  assert.equal(decideRender({ plan: { family: 'accessibility' }, rawFacts: scripty }).render, true);
  assert.equal(decideRender({ plan: { family: 'accessibility' }, rawFacts: plain }).render, false);
});

test('compareRawRendered: reports exactly what JavaScript changed', () => {
  const raw = inspectHtml(page({ body: '<img src="/a.png">' }), PAGE);
  const ren = inspectHtml(page({ head: jsonLd(breadcrumbLd(['Home', `${SITE}/`], ['About', PAGE])), body: VISIBLE_CRUMBS + '<img src="/a.png" alt="ok">' }), PAGE);
  const c = compareRawRendered(raw, ren);
  assert.equal(c.identical, false);
  assert.deepEqual(c.jsonLdTypesOnlyRendered.filter((t) => t === 'BreadcrumbList'), ['BreadcrumbList']);
  assert.deepEqual(c.differences.map((d) => d.aspect).sort(), ['breadcrumbListCount', 'imagesMissingAlt', 'jsonLdTypes', 'visibleBreadcrumbItems'].sort());
  assert.equal(compareRawRendered(raw, raw).identical, true);
});
