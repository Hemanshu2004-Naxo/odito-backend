import test from 'node:test';
import assert from 'node:assert/strict';
import { collectEvidence } from '../evidence/evidenceCollector.js';
import { resolveInvestigationPlan } from '../evidence/investigationPlans.js';
import { validateModelOutput } from '../contract/investigationContract.js';
import { assessFindings } from '../contract/evidenceBasis.js';
import { inspectHtml } from '../evidence/pageInspector.js';
import { PAGE, SITE, PROJECT, ELIGIBLE, NOT_SUPPORTED, jsonLd, breadcrumbLd, fakeFetcher, makeDeps, issue, goodAnswer } from '../testKit.js';

const html = ({ nav = '', body = '', head = '', title = 'About Us', h1 = title, canonical = PAGE } = {}) => `<!doctype html><html lang="en"><head><title>${title} | Sapphire</title><link rel="canonical" href="${canonical}">${head}</head><body><header><nav>${nav}</nav></header><main><h1>${h1}</h1>${body}</main></body></html>`;
const FLAT_NAV = '<ul><li><a href="/">Home</a></li><li><a href="/about-us">About Us</a></li><li><a href="/services">Services</a></li></ul>';
const ok = (body) => ({ body });

async function investigate({ routes, page = PAGE, renderPage = null, siblings = [`${SITE}/services`], over = {} }) {
  const fetcher = fakeFetcher(routes);
  const iss = issue({ pageUrl: page });
  const deps = makeDeps({ fetcher, renderPage, loadSiblings: async () => siblings, ...over });
  const ledger = await collectEvidence({ project: PROJECT, issue: iss, plan: resolveInvestigationPlan(iss), deps });
  const analysis = ledger.items.find((i) => i.kind === 'structured_analysis');
  return { ledger, analysis, data: analysis?.data, fetcher };
}
const proposal = (...items) => goodAnswer({ codeOrConfiguration: [{ language: 'json-ld', purpose: 'Breadcrumb schema', content: JSON.stringify(breadcrumbLd(...items)) }] });
const validate = (answer, ledger, capabilities = ELIGIBLE, pageUrl = PAGE) => validateModelOutput(answer, { ledger, capabilities, pageUrl, siteUrl: PROJECT.siteUrl });
const check = (v, name) => v.value.safetyChecks.find((c) => c.name === name);

// ── hierarchy: verified ───────────────────────────────────────────────────────────────────
test('VERIFIED: the page is a top-level item of the homepage menu -> Home is its parent, every level is evidence-backed; the proposal is eligible', async () => {
  const { ledger, data } = await investigate({ routes: { [PAGE]: ok(html({ nav: FLAT_NAV })), [`${SITE}/`]: ok(html({ nav: FLAT_NAV, title: 'Home', canonical: `${SITE}/` })), [`${SITE}/services`]: ok(html({ nav: FLAT_NAV, title: 'Services', canonical: `${SITE}/services` })) } });
  assert.equal(data.status, 'verified');
  assert.equal(data.basis, 'menu_placement');
  assert.deepEqual(data.trail.map((n) => [n.name, n.verified]), [['Home', true], ['About Us', true]]);
  assert.equal(data.trail[0].urlSource, 'top-level item of the homepage menu');
  assert.equal(data.trail[0].nameSource, 'menu link to the site root');
  assert.equal(data.requiresReview, false);
  const v = validate(proposal(['Home', `${SITE}/`], ['About Us', PAGE]), ledger);
  assert.equal(v.ok, true);
  assert.equal(check(v, 'breadcrumb_hierarchy_verified').passed, true);
  assert.equal(v.value.automaticFixEligibility.eligible, true, JSON.stringify(v.value.safetyChecks.filter((c) => !c.passed)));
  assert.equal(v.value.reviewItems.length, 0);
});

test('VERIFIED via a real menu parent: the parent page is fetched and must answer 200 without redirecting elsewhere', async () => {
  const nav = '<ul><li><a href="/">Home</a></li><li><a href="/services">Services</a><ul><li><a href="/services/seo">SEO</a></li></ul></li></ul>';
  const page = `${SITE}/services/seo`;
  const routes = { [page]: ok(html({ nav, title: 'SEO', canonical: page })), [`${SITE}/`]: ok(html({ nav, title: 'Home', canonical: `${SITE}/` })), [`${SITE}/services`]: ok(html({ nav, title: 'Services', canonical: `${SITE}/services` })) };
  const { ledger, data, fetcher } = await investigate({ routes, page, siblings: [] });
  assert.equal(data.status, 'verified');
  assert.deepEqual(data.trail.map((n) => n.name), ['Home', 'Services', 'SEO']);
  assert.ok(fetcher.calls.includes(`${SITE}/services`), 'the parent URL was actually requested');
  assert.equal(data.checkedUrls.find((c) => c.url === `${SITE}/services`).ok, true);
  assert.equal(data.checkedUrls.find((c) => c.url === `${SITE}/`).ok, true, 'the root was verified through the homepage fetch');
  assert.match(data.trail[1].nameSource, /menu parent/);
  const v = validate(proposal(['Home', `${SITE}/`], ['Services', `${SITE}/services`], ['SEO', page]), ledger, ELIGIBLE, page);
  assert.equal(v.value.automaticFixEligibility.eligible, true, JSON.stringify(v.value.safetyChecks.filter((c) => !c.passed)));
});

// ── hierarchy: NOT verified ────────────────────────────────────────────────────────────────
test('UNRESOLVED: the menu parent is a "#" group with no page of its own -> Home is NOT assumed; a person must decide; not eligible', async () => {
  const nav = '<ul><li><a href="/">Home</a></li><li><a href="#">White Label Services</a><ul><li><a href="/local-seo">Local SEO</a></li></ul></li></ul>';
  const page = `${SITE}/local-seo`;
  const { ledger, data } = await investigate({ routes: { [page]: ok(html({ nav, title: 'Local SEO', canonical: page })), [`${SITE}/`]: ok(html({ nav, title: 'Home', canonical: `${SITE}/` })) }, page, siblings: [] });
  assert.equal(data.status, 'unresolved');
  assert.equal(data.requiresReview, true);
  assert.match(data.unresolved[0].reason, /White Label Services.*no page of its own/);
  assert.equal(data.unresolved[0].label, 'White Label Services');
  assert.deepEqual(data.trail, [], 'no trail is invented');
  // The model proposes [Home, Local SEO] anyway: valid JSON-LD, but the server refuses to call it safe.
  const v = validate(proposal(['Home', `${SITE}/`], ['Local SEO', page]), ledger, ELIGIBLE, page);
  assert.equal(v.value.automaticFixEligibility.eligible, false);
  assert.equal(v.value.codeOrConfiguration[0].jsonLd.valid, true, 'syntactically valid is not the same as safe');
  assert.equal(check(v, 'breadcrumb_hierarchy_verified').passed, false);
  assert.match(check(v, 'breadcrumb_hierarchy_verified').detail, /White Label Services/);
  assert.equal(v.value.requiresHumanApproval, true);
  assert.equal(v.value.reviewItems.length, 1);
  assert.equal(v.value.reviewItems[0].status, 'unresolved');
  assert.match(v.value.automaticFixEligibility.reason, /Not applied automatically/);
});

test('INFERRED: no menu placement and no breadcrumb -> the homepage is only ASSUMED to be the parent; requires review', async () => {
  const { ledger, data } = await investigate({ routes: { [PAGE]: ok(html({ nav: '<ul><li><a href="/services">Services</a></li></ul>' })), [`${SITE}/`]: ok(html({ nav: '<ul><li><a href="/services">Services</a></li></ul>', title: 'Home', canonical: `${SITE}/` })) }, siblings: [] });
  assert.equal(data.status, 'inferred');
  assert.equal(data.basis, 'inferred_path');
  assert.ok(data.issues.some((i) => /only assumed/.test(i)));
  assert.equal(data.trail[0].verified, false);
  assert.ok(data.unresolved.some((u) => u.kind === 'label'), 'the root label has no evidence either');
  const v = validate(proposal(['Home', `${SITE}/`], ['About Us', PAGE]), ledger);
  assert.equal(v.value.automaticFixEligibility.eligible, false);
});

test('INFERRED: a parent implied only by the URL path (/blog/post) has no verified name and is not eligible', async () => {
  const page = `${SITE}/blog/hello`;
  const nav = '<ul><li><a href="/">Home</a></li></ul>';
  const { ledger, data } = await investigate({ routes: { [page]: ok(html({ nav, title: 'Hello', canonical: page })), [`${SITE}/`]: ok(html({ nav, title: 'Home', canonical: `${SITE}/` })), [`${SITE}/blog/`]: ok(html({ nav, title: 'Blog', canonical: `${SITE}/blog/` })) }, page, siblings: [] });
  assert.notEqual(data.status, 'verified');
  const blog = data.trail.find((n) => n.url === `${SITE}/blog/`);
  assert.equal(blog.verified, false);
  assert.equal(blog.name, null);
  assert.ok(data.unresolved.some((u) => /No evidence for the label of .*\/blog\//.test(u.reason)));
  assert.equal(validate(proposal(['Home', `${SITE}/`], ['Blog', `${SITE}/blog/`], ['Hello', page]), ledger, ELIGIBLE, page).value.automaticFixEligibility.eligible, false);
});

test('a parent URL that 404s or redirects elsewhere is NOT verified, with the reason recorded', async () => {
  const nav = '<ul><li><a href="/">Home</a></li><li><a href="/services">Services</a><ul><li><a href="/services/seo">SEO</a></li></ul></li></ul>';
  const page = `${SITE}/services/seo`;
  const base = { [page]: ok(html({ nav, title: 'SEO', canonical: page })), [`${SITE}/`]: ok(html({ nav, title: 'Home', canonical: `${SITE}/` })) };
  const gone = await investigate({ routes: base, page, siblings: [] });          // /services -> 404 (fakeFetcher default)
  assert.notEqual(gone.data.status, 'verified');
  assert.equal(gone.data.checkedUrls.find((c) => c.url === `${SITE}/services`).ok, false);
  assert.match(gone.data.issues.join(' '), /could not be confirmed \(HTTP_404\)/);
  const moved = await investigate({ routes: { ...base, [`${SITE}/services`]: { body: html({ title: 'Moved' }), finalUrl: `${SITE}/our-services/` } }, page, siblings: [] });
  assert.notEqual(moved.data.status, 'verified');
  assert.match(moved.data.issues.join(' '), /redirects to https:\/\/www\.sapphiredigitalagency\.com\/our-services\//);
  const v = validate(proposal(['Home', `${SITE}/`], ['Services', `${SITE}/services`], ['SEO', page]), moved.ledger, ELIGIBLE, page);
  assert.equal(check(v, 'breadcrumb_parent_urls_reachable').passed, false);
  assert.equal(v.value.automaticFixEligibility.eligible, false);
});

test('a proposed URL with NO supporting evidence is refused twice over: not in the hierarchy, and not in any retrieved evidence', async () => {
  const { ledger } = await investigate({ routes: { [PAGE]: ok(html({ nav: FLAT_NAV })), [`${SITE}/`]: ok(html({ nav: FLAT_NAV, title: 'Home', canonical: `${SITE}/` })) }, siblings: [] });
  const v = validate(proposal(['Home', `${SITE}/`], ['Company', `${SITE}/company`], ['About Us', PAGE]), ledger);
  assert.equal(check(v, 'breadcrumb_urls_in_hierarchy').passed, false);
  assert.match(check(v, 'breadcrumb_urls_in_hierarchy').detail, /company/);
  assert.equal(check(v, 'urls_backed_by_evidence').passed, false);
  assert.equal(check(v, 'breadcrumb_length_matches_hierarchy').passed, false);
  assert.equal(v.value.automaticFixEligibility.eligible, false);
});

test('labels that differ from the evidenced ones, and a last item that is not the canonical page, are caught', async () => {
  const { ledger } = await investigate({ routes: { [PAGE]: ok(html({ nav: FLAT_NAV })), [`${SITE}/`]: ok(html({ nav: FLAT_NAV, title: 'Home', canonical: `${SITE}/` })) }, siblings: [] });
  const v = validate(proposal(['Start', `${SITE}/`], ['About Us', `${SITE}/about`]), ledger);
  assert.equal(check(v, 'breadcrumb_labels_match_evidence').passed, false);
  assert.equal(check(v, 'breadcrumb_last_is_current_page').passed, false);
  assert.equal(v.value.automaticFixEligibility.eligible, false);
});

// ── existing markup ────────────────────────────────────────────────────────────────────────
test('visible breadcrumb on the page is used as the site owner\'s own hierarchy; JSON-LD that agrees makes it corroborated', async () => {
  const crumbs = '<nav aria-label="Breadcrumb"><ol><li><a href="/">Home</a></li><li><a href="/services">Services</a></li><li aria-current="page">About Us</li></ol></nav>';
  const routes = { [PAGE]: ok(html({ nav: FLAT_NAV, body: crumbs })), [`${SITE}/`]: ok(html({ nav: FLAT_NAV, title: 'Home', canonical: `${SITE}/` })), [`${SITE}/services`]: ok(html({ title: 'Services', canonical: `${SITE}/services` })) };
  const visibleOnly = await investigate({ routes, siblings: [] });
  assert.equal(visibleOnly.data.status, 'verified');
  assert.equal(visibleOnly.data.basis, 'page_markup');
  assert.deepEqual(visibleOnly.data.trail.map((n) => n.name), ['Home', 'Services', 'About Us']);
  assert.equal(visibleOnly.data.flags.visibleWithoutSchema, true);
  const both = await investigate({ routes: { ...routes, [PAGE]: ok(html({ nav: FLAT_NAV, body: crumbs, head: jsonLd(breadcrumbLd(['Home', `${SITE}/`], ['Services', `${SITE}/services`], ['About Us', PAGE])) })) }, siblings: [] });
  assert.equal(both.data.basis, 'page_markup_corroborated');
  assert.equal(both.data.flags.visibleWithoutSchema, false);
});

test('NO visible breadcrumbs but valid JSON-LD: reported as schema describing navigation users cannot see', async () => {
  const withLd = html({ nav: FLAT_NAV, head: jsonLd(breadcrumbLd(['Home', `${SITE}/`], ['About Us', PAGE])) });
  const { data } = await investigate({ routes: { [PAGE]: ok(withLd), [`${SITE}/`]: ok(html({ nav: FLAT_NAV, title: 'Home', canonical: `${SITE}/` })) }, siblings: [] });
  assert.equal(data.flags.schemaWithoutVisible, true);
  assert.equal(data.existing.jsonLdLists, 1);
  assert.ok(data.issues.some((i) => /no breadcrumb is visible/.test(i)));
  assert.equal(data.status, 'verified');
});

test('DUPLICATE / CONFLICTING structured data: two different BreadcrumbLists is a conflict; the proposal is blocked and the analysis demands review', async () => {
  const dup = html({ nav: FLAT_NAV, head: jsonLd(breadcrumbLd(['Home', `${SITE}/`], ['About Us', PAGE])) + jsonLd(breadcrumbLd(['Home', `${SITE}/`], ['Company', `${SITE}/company`], ['About Us', PAGE])) });
  const { ledger, data } = await investigate({ routes: { [PAGE]: ok(dup), [`${SITE}/`]: ok(html({ nav: FLAT_NAV, title: 'Home', canonical: `${SITE}/` })) }, siblings: [] });
  assert.equal(data.flags.markupConflict, true);
  assert.notEqual(data.status, 'verified');
  const v = validate(proposal(['Home', `${SITE}/`], ['About Us', PAGE]), ledger);
  assert.equal(check(v, 'no_duplicate_markup').passed, false);
  assert.equal(v.value.automaticFixEligibility.eligible, false);
});

test('structured data that exists ONLY after JavaScript runs is seen as a duplicate (raw HTML alone would have missed it)', async () => {
  const shell = '<!doctype html><html><head><title>App</title><script src="/a.js"></script><script src="/b.js"></script><script src="/c.js"></script></head><body><div id="root"></div></body></html>';
  const rendered = html({ nav: FLAT_NAV, head: jsonLd(breadcrumbLd(['Home', `${SITE}/`], ['About Us', PAGE])) });
  const renderPage = async () => ({ facts: inspectHtml(rendered, PAGE), finalUrl: PAGE, httpStatus: 200, redirects: [], timings: { totalMs: 5 }, htmlBytes: rendered.length, htmlTruncated: false, requests: { allowed: 1, blocked: 0 }, engine: 'chromium' });
  const { ledger, data } = await investigate({ routes: { [PAGE]: ok(shell), [`${SITE}/`]: ok(html({ nav: FLAT_NAV, title: 'Home', canonical: `${SITE}/` })) }, renderPage, siblings: [] });
  assert.equal(data.flags.jsonLdOnlyAfterJavaScript, true);
  assert.equal(ledger.first('page').data.facts.structuredData.breadcrumbLists.length, 0, 'raw HTML has none');
  const v = validate(proposal(['Home', `${SITE}/`], ['About Us', PAGE]), ledger);
  assert.equal(check(v, 'no_duplicate_markup').passed, false, 'detected through the rendered DOM');
  assert.equal(v.value.automaticFixEligibility.eligible, false);
});

// ── evidence basis ─────────────────────────────────────────────────────────────────────────
const liveLedger = async (over = {}) => (await investigate({ routes: { [PAGE]: ok(html({ nav: FLAT_NAV })), [`${SITE}/`]: ok(html({ nav: FLAT_NAV, title: 'Home', canonical: `${SITE}/` })) }, siblings: [], ...over })).ledger;

test('basis: observed vs corroborated vs inferred vs unknown are decided from the ledger, not from the model\'s label', async () => {
  const ledger = await liveLedger();
  const id = (kind) => ledger.first(kind).id;
  const { findings, downgrades } = assessFindings([
    { statement: 'single source', basis: 'observed', evidenceIds: [id('page')] },
    { statement: 'two sources', basis: 'corroborated', evidenceIds: [id('page'), id('homepage')] },
    { statement: 'claims corroboration with one source', basis: 'corroborated', evidenceIds: [id('page')] },
    { statement: 'claims observation with nothing behind it', basis: 'observed', evidenceIds: ['E999'] },
    { statement: 'honest inference', basis: 'inferred', evidenceIds: [id('page')] },
    { statement: 'admitted unknown', basis: 'unknown', evidenceIds: [] },
  ], ledger);
  assert.deepEqual(findings.map((f) => f.basis), ['observed', 'corroborated', 'observed', 'inferred', 'inferred', 'unknown']);
  assert.equal(findings[2].claimedBasis, 'corroborated');
  assert.ok(downgrades.some((d) => /only one independent source/.test(d)));
  assert.ok(downgrades.some((d) => /E999/.test(d)));
});

test('ABSENCE: a stored crawl or the detector cannot establish that something is missing; a live observation can', async () => {
  const ledger = await liveLedger();
  const crawl = ledger.first('crawl_page').id; const det = ledger.first('detector').id; const page = ledger.first('page').id;
  const { findings } = assessFindings([
    { statement: 'no BreadcrumbList (crawl only)', absence: true, evidenceIds: [crawl] },
    { statement: 'no BreadcrumbList (detector only)', absence: true, evidenceIds: [det] },
    { statement: 'no BreadcrumbList (live page)', absence: true, evidenceIds: [page] },
  ], ledger);
  assert.deepEqual(findings.map((f) => f.basis), ['unknown', 'unknown', 'observed']);
  assert.match(findings[0].note, /live observation/);
});

test('ABSENCE with JavaScript involved: not established unless the RENDERED DOM was obtained; if rendering failed the claim stays unknown and the limit is stated', async () => {
  const shell = '<!doctype html><html><head><title>App</title><script src="/a.js"></script><script src="/b.js"></script><script src="/c.js"></script></head><body><div id="root"></div></body></html>';
  const routes = { [PAGE]: ok(shell), [`${SITE}/`]: ok(html({ nav: FLAT_NAV, title: 'Home', canonical: `${SITE}/` })) };
  // rendering needed but fails
  const failed = await investigate({ routes, siblings: [], renderPage: async () => { throw Object.assign(new Error('timeout'), { code: 'RENDER_TIMEOUT' }); } });
  const answer = goodAnswer({ findings: [{ statement: 'The page has no BreadcrumbList.', basis: 'observed', absence: true, evidenceIds: [failed.ledger.first('page').id] }] });
  const v = validate(answer, failed.ledger);
  assert.equal(v.value.findings[0].basis, 'unknown');
  assert.equal(check(v, 'absence_claims_established').passed, false);
  assert.equal(check(v, 'rendered_state_known').passed, false);
  assert.equal(v.value.automaticFixEligibility.eligible, false);
  assert.ok(v.value.limitations.some((l) => /Rendering was needed/.test(l)));
  assert.equal(v.value.investigationStatus, 'partial', 'a "complete" claim is downgraded');
  // rendering succeeds and the rendered DOM also lacks it -> established, corroborated by two views
  const renderedHtml = html({ nav: FLAT_NAV });
  const renderPage = async () => ({ facts: inspectHtml(renderedHtml, PAGE), finalUrl: PAGE, httpStatus: 200, redirects: [], timings: { totalMs: 5 }, htmlBytes: 10, htmlTruncated: false, requests: {}, engine: 'chromium' });
  const good = await investigate({ routes, siblings: [], renderPage });
  const a2 = goodAnswer({ findings: [{ statement: 'The page has no BreadcrumbList, raw or rendered.', basis: 'corroborated', absence: true, evidenceIds: [good.ledger.first('page').id, good.ledger.first('rendered_dom').id] }] });
  assert.equal(validate(a2, good.ledger).value.findings[0].basis, 'corroborated');
  // truncated rendered DOM cannot support an absence either
  good.ledger.first('rendered_dom').data.htmlTruncated = true;
  assert.equal(validate(a2, good.ledger).value.findings[0].basis, 'unknown');
});

test('ELIGIBILITY never comes from model confidence: 0.99 confidence with a failed safety check is ineligible; all checks passing with no adapter is ineligible', async () => {
  const { ledger } = await investigate({ routes: { [PAGE]: ok(html({ nav: FLAT_NAV })), [`${SITE}/`]: ok(html({ nav: FLAT_NAV, title: 'Home', canonical: `${SITE}/` })) }, siblings: [] });
  const confident = proposal(['Home', `${SITE}/`], ['Company', `${SITE}/company`], ['About Us', PAGE]);
  confident.confidence = { score: 0.99, label: 'high' };
  const bad = validate(confident, ledger);
  assert.equal(bad.value.automaticFixEligibility.eligible, false);
  const fine = validate(proposal(['Home', `${SITE}/`], ['About Us', PAGE]), ledger, NOT_SUPPORTED);
  assert.equal(fine.value.safetyChecks.filter((c) => c.status !== 'not_run' && c.id !== 'automatic_fix_capability').every((c) => c.passed), true);
  assert.equal(fine.value.safetyChecks.find((c) => c.id === 'automatic_fix_capability').status, 'blocked');
  assert.equal(fine.value.automaticFixEligibility.eligible, false, 'all checks pass but Odito has no adapter');
  const okAll = validate(proposal(['Home', `${SITE}/`], ['About Us', PAGE]), ledger);
  okAll.value.confidence.score; // confidence is reported, never consulted
  assert.equal(okAll.value.automaticFixEligibility.eligible, true);
  const lowConf = proposal(['Home', `${SITE}/`], ['About Us', PAGE]); lowConf.confidence = { score: 0.05, label: 'low' };
  assert.equal(validate(lowConf, ledger).value.automaticFixEligibility.eligible, true, 'low model confidence does not block what the server verified (the person still approves)');
});

test('the issue must be supported by observed/corroborated evidence, not just asserted', async () => {
  const ledger = await liveLedger();
  const v = validate(goodAnswer({ evidence: [], findings: [{ statement: 'It is missing, trust me.', basis: 'observed', evidenceIds: [] }] }), ledger);
  assert.equal(check(v, 'issue_supported_by_evidence').passed, false);
  assert.equal(v.value.automaticFixEligibility.eligible, false);
});

test('REAL-SITE SHAPE (found live): About Us is a top-level menu item but the site has no "Home" link and no breadcrumbs -> the root URL is verified, its LABEL is not; one unresolved item with a clearly-marked suggestion; review required', async () => {
  const nav = '<ul><li><a href="/become-a-partner/">Become A Partner</a></li><li><a href="/about-us">About Us</a></li><li><a href="#">White Label Services</a><ul><li><a href="/local-seo/">Local SEO</a></li></ul></li></ul>';
  const { ledger, data } = await investigate({ routes: { [PAGE]: ok(html({ nav })), [`${SITE}/`]: ok(html({ nav, title: 'Home', canonical: `${SITE}/` })) }, siblings: [] });
  assert.equal(data.status, 'inferred');
  assert.equal(data.trail[0].urlSource, 'top-level item of the homepage menu');
  assert.equal(data.trail[0].url, `${SITE}/`);
  assert.equal(data.trail[0].name, null, 'the label is NOT invented');
  assert.equal(data.trail[0].verified, false);
  assert.equal(data.trail[1].verified, true);
  assert.equal(data.unresolved.length, 1, 'one unresolved level, not two');
  assert.deepEqual([data.unresolved[0].kind, data.unresolved[0].position, data.unresolved[0].suggestion], ['label', 1, 'Home']);
  assert.match(data.unresolved[0].suggestionBasis, /nothing on this site confirms/);
  // the proposal [Home, About Us] has valid URLs and valid JSON-LD but is NOT eligible: a person must choose the label
  const v = validate(proposal(['Home', `${SITE}/`], ['About Us', PAGE]), ledger);
  assert.equal(v.value.codeOrConfiguration[0].jsonLd.valid, true);
  assert.equal(check(v, 'breadcrumb_urls_in_hierarchy').passed, true);
  assert.equal(check(v, 'breadcrumb_hierarchy_verified').passed, false);
  assert.equal(v.value.automaticFixEligibility.eligible, false);
  assert.equal(v.value.reviewItems[0].unresolved[0].suggestion, 'Home');
  assert.equal(v.value.requiresHumanApproval, true);
});

test('once a person-visible evidence of the root label exists (a "Home" menu link), the same page becomes verified', async () => {
  const nav = '<ul><li><a href="/">Home</a></li><li><a href="/about-us">About Us</a></li></ul>';
  const { data } = await investigate({ routes: { [PAGE]: ok(html({ nav })), [`${SITE}/`]: ok(html({ nav, title: 'Home', canonical: `${SITE}/` })) }, siblings: [] });
  assert.equal(data.status, 'verified');
});

test('proposing the same JSON-LD block twice does not list its checks twice', async () => {
  const { ledger } = await investigate({ routes: { [PAGE]: ok(html({ nav: FLAT_NAV })), [`${SITE}/`]: ok(html({ nav: FLAT_NAV, title: 'Home', canonical: `${SITE}/` })) }, siblings: [] });
  const block = { language: 'json-ld', purpose: 'x', content: JSON.stringify(breadcrumbLd(['Home', `${SITE}/`], ['About Us', PAGE])) };
  const v = validate(goodAnswer({ codeOrConfiguration: [block, { ...block, language: 'json' }] }), ledger);
  const names = v.value.safetyChecks.map((c) => c.name);
  assert.equal(names.length, new Set(names).size, `duplicate checks: ${names.join(',')}`);
});
