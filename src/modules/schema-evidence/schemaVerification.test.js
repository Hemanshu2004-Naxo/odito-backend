import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { appliesToVerification, verifySchemaFix } from './schemaVerification.js';
import {
  ABOUT_CANONICAL, ABOUT_CRAWL_KEY, HOME, ORIGIN, REAL_LOGO,
  aboutPageData, graphWithOrganization, probe404, probeHtml200, probeOk, probeTimeout,
} from './__fixtures__/clinicSite.js';

const T0 = new Date('2026-10-01T10:00:00Z');
const AFTER = new Date('2026-10-02T10:00:00Z').toISOString();
const BEFORE = new Date('2026-09-30T10:00:00Z').toISOString();

// A verifier double: answers per URL, and records which URLs were asked about.
const verifier = (answers) => { const asked = []; const fn = async (urls) => { asked.push(...urls); return urls.map((u) => (answers[u] ? answers[u] : probeTimeout(u))); }; fn.asked = asked; return fn; };
const run = (issueKey, pageDoc, answers = {}, implementedAt = T0) => verifySchemaFix({ issueKey, pageDoc, implementedAt, verifyImages: verifier(answers) });
const page = (over = {}) => aboutPageData({ scraped_at: AFTER, ...over });

describe('appliesToVerification', () => {
  test('schema issues (legacy + V2) are inspected; everything else keeps its existing verification', () => {
    for (const k of ['organization_schema', 'primary_organization_schema', 'article_schema', 'breadcrumblist_schema', 'AISO-A1', 'GEO-S5', 'GEO-S2']) assert.equal(appliesToVerification(k), true, k);
    for (const k of ['title_missing', 'sameas_array', 'faq_schema', 'aggregate_rating_schema', 'canonical_tag_errors', 'images_missing_alt_text']) assert.equal(appliesToVerification(k), false, k);
  });
});

describe('verifySchemaFix — Organization', () => {
  test('valid fix observed on recrawl -> verified', async () => {
    const r = await run('organization_schema', page(), { [REAL_LOGO]: probeOk(REAL_LOGO) });
    assert.equal(r.status, 'verified');
    assert.deepEqual(r.reasons, []);
    assert.ok(r.checks.every((c) => c.ok));
  });

  test('REGRESSION: the issue is gone but the deployed logo is a 404 -> failed, with the URL in the reason', async () => {
    const r = await run('organization_schema', page(), { [REAL_LOGO]: probe404(REAL_LOGO) });
    assert.equal(r.status, 'failed');
    assert.match(r.reasons.join(' '), /clinic-logo\.png is not usable: HTTP 404/);
  });

  test('HTTP 200 serving an HTML page as the logo -> failed', async () => {
    const r = await run('organization_schema', page(), { [REAL_LOGO]: probeHtml200(REAL_LOGO) });
    assert.equal(r.status, 'failed');
  });

  test('the invented upload path fails exactly like any dead logo', async () => {
    const bad = `${ORIGIN}/wp-content/uploads/logo.png`;
    const pd = page({ structured_data: graphWithOrganization({ logo: bad }) });
    const r = await run('organization_schema', pd, { [bad]: probe404(bad) });
    assert.equal(r.status, 'failed');
    assert.match(r.reasons.join(' '), /uploads\/logo\.png/);
  });

  test('a logo that cannot be fetched right now -> unverifiable (pending), never verified and never failed', async () => {
    const r = await run('organization_schema', page(), { [REAL_LOGO]: probeTimeout(REAL_LOGO) });
    assert.equal(r.status, 'unverifiable');
    assert.match(r.reasons.join(' '), /could not be fetched right now/);
  });

  test('a failure elsewhere wins over an unfetchable asset (it is actionable now)', async () => {
    const pd = page({ structured_data: [...graphWithOrganization(), ...graphWithOrganization()] });
    const r = await run('organization_schema', pd, { [REAL_LOGO]: probeTimeout(REAL_LOGO) });
    assert.equal(r.status, 'failed');
    assert.match(r.reasons.join(' '), /more than once/);
  });

  test('the fix was never deployed: no Organization in the markup -> failed (not verified just because the audit finding is gone)', async () => {
    const r = await run('organization_schema', page({ structured_data: [{ '@type': 'WebSite', name: 'X' }] }));
    assert.equal(r.status, 'failed');
    assert.match(r.reasons.join(' '), /No Organization entity/);
  });

  test('a deployed duplicate entity with a conflicting @id fails', async () => {
    const pd = page({ structured_data: [...graphWithOrganization(), { '@type': 'Organization', '@id': `${ORIGIN}/#org-2`, name: 'Clinic', url: HOME }] });
    assert.equal((await run('organization_schema', pd, { [REAL_LOGO]: probeOk(REAL_LOGO) })).status, 'failed');
  });

  test('missing name / off-site url fail', async () => {
    const noName = page({ structured_data: graphWithOrganization({ name: '' }) });
    assert.equal((await run('organization_schema', noName, { [REAL_LOGO]: probeOk(REAL_LOGO) })).status, 'failed');
    const offSite = page({ structured_data: graphWithOrganization({ url: 'https://elsewhere.example/' }) });
    assert.equal((await run('organization_schema', offSite)).status, 'failed');
  });

  test('an organization with no logo declared is not failed for it (the logo is optional); no image is fetched', async () => {
    const v = verifier({});
    const pd = page({ structured_data: graphWithOrganization({ logo: undefined }) });
    const r = await verifySchemaFix({ issueKey: 'organization_schema', pageDoc: pd, implementedAt: T0, verifyImages: v });
    assert.equal(r.status, 'verified');
    assert.deepEqual(v.asked, []);
  });

  test('V2 issue ids (AISO-A1 / GEO-S5) are inspected the same way', async () => {
    assert.equal((await run('AISO-A1', page(), { [REAL_LOGO]: probe404(REAL_LOGO) })).status, 'failed');
    assert.equal((await run('GEO-S5', page(), { [REAL_LOGO]: probeOk(REAL_LOGO) })).status, 'verified');
  });

  test('only the DECLARED logo is fetched, not weaker HTML hints', async () => {
    const v = verifier({ [REAL_LOGO]: probeOk(REAL_LOGO) });
    await verifySchemaFix({ issueKey: 'organization_schema', pageDoc: page(), implementedAt: T0, verifyImages: v });
    assert.deepEqual(v.asked, [REAL_LOGO]);
  });
});

describe('verifySchemaFix — availability and freshness', () => {
  test('site unavailable / page absent from the crawl -> unverifiable', async () => {
    const r = await run('organization_schema', null);
    assert.equal(r.status, 'unverifiable');
    assert.match(r.reasons[0], /not found in the latest crawl/);
    assert.equal((await run('organization_schema', {})).status, 'unverifiable');
  });

  test('the page has not been re-crawled since the fix -> unverifiable, even if the markup looks right', async () => {
    const r = await run('organization_schema', page({ scraped_at: BEFORE }), { [REAL_LOGO]: probeOk(REAL_LOGO) });
    assert.equal(r.status, 'unverifiable');
    assert.match(r.reasons[0], /not been re-crawled since the fix/);
  });

  test('freshness is only enforced when both timestamps are known', async () => {
    const pd = page(); delete pd.scraped_at;
    assert.equal((await run('organization_schema', pd, { [REAL_LOGO]: probeOk(REAL_LOGO) })).status, 'verified');
    assert.equal((await run('organization_schema', page({ scraped_at: BEFORE }), { [REAL_LOGO]: probeOk(REAL_LOGO) }, null)).status, 'verified');
  });

  test('a throwing verifier degrades to unverifiable, not to success', async () => {
    const r = await verifySchemaFix({ issueKey: 'organization_schema', pageDoc: page(), implementedAt: T0, verifyImages: async () => { throw new Error('worker down'); } });
    assert.equal(r.status, 'unverifiable');
  });

  test('issue types without schema inspection are reported as such', async () => {
    assert.equal((await run('title_missing', page())).status, 'unverifiable');
  });
});

describe('verifySchemaFix — BreadcrumbList', () => {
  const li = (position, name, item) => ({ '@type': 'ListItem', position, name, item });
  const trail = (items) => ({ '@type': 'BreadcrumbList', itemListElement: items });
  const withTrail = (...lists) => page({ structured_data: [...graphWithOrganization(), ...lists] });

  test('a correct trail ending at the canonical URL (trailing slash) verifies, though the crawl key has none', async () => {
    const r = await run('breadcrumblist_schema', withTrail(trail([li(1, 'Home', HOME), li(2, 'About us', ABOUT_CANONICAL)])));
    assert.equal(page().url, ABOUT_CRAWL_KEY);
    assert.equal(r.status, 'verified');
  });

  test('the last item may differ from the canonical only by the trailing slash', async () => {
    const r = await run('breadcrumblist_schema', withTrail(trail([li(1, 'Home', HOME), li(2, 'About us', ABOUT_CRAWL_KEY)])));
    assert.equal(r.status, 'verified');
  });

  test('a trail whose last item points at a different page fails', async () => {
    const r = await run('breadcrumblist_schema', withTrail(trail([li(1, 'Home', HOME), li(2, 'Other', `${ORIGIN}/other/`)])));
    assert.equal(r.status, 'failed');
    assert.match(r.reasons.join(' '), /last item/);
  });

  test('no BreadcrumbList deployed -> failed', async () => {
    const r = await run('breadcrumblist_schema', page());
    assert.equal(r.status, 'failed');
    assert.match(r.reasons.join(' '), /No BreadcrumbList/);
  });

  test('invalid positions / relative URLs / duplicates / a single item fail with the problem named', async () => {
    assert.match((await run('breadcrumblist_schema', withTrail(trail([li(1, 'Home', HOME), li(3, 'About', ABOUT_CANONICAL)])))).reasons.join(' '), /position_not_sequential/);
    assert.match((await run('breadcrumblist_schema', withTrail(trail([li(1, 'Home', '/'), li(2, 'About', ABOUT_CANONICAL)])))).reasons.join(' '), /relative_or_invalid_url/);
    assert.match((await run('breadcrumblist_schema', withTrail(trail([li(1, 'A', ABOUT_CANONICAL), li(2, 'B', ABOUT_CANONICAL)])))).reasons.join(' '), /duplicate_url/);
    assert.equal((await run('breadcrumblist_schema', withTrail(trail([li(1, 'About', ABOUT_CANONICAL)])))).status, 'failed');
  });

  test('two BreadcrumbLists fail', async () => {
    const t = trail([li(1, 'Home', HOME), li(2, 'About', ABOUT_CANONICAL)]);
    assert.equal((await run('breadcrumblist_schema', withTrail(t, t))).status, 'failed');
  });

  test('cross-site breadcrumb parents fail', async () => {
    const r = await run('breadcrumblist_schema', withTrail(trail([li(1, 'Home', 'https://other.example/'), li(2, 'About', ABOUT_CANONICAL)])));
    assert.match(r.reasons.join(' '), /cross_site_url/);
  });
});

describe('verifySchemaFix — Article', () => {
  const POST = `${ORIGIN}/blog/five-tips`;
  const postDoc = (article, meta = {}) => page({
    url: POST, canonical: `${POST}/`, title: 'Five tips', word_count: 900, images: [], meta_tags: meta, content: { headings: { h1: ['Five tips'] } },
    structured_data: article ? [{ '@context': 'https://schema.org', '@graph': [article] }] : [],
  });
  const good = { '@type': 'BlogPosting', headline: 'Five tips', datePublished: '2026-01-02T03:04:05+05:30', dateModified: '2026-02-03T04:05:06+05:30', author: { '@type': 'Person', name: 'Dr A' } };

  test('a complete Article on a genuine article page verifies', async () => {
    const r = await run('article_schema', { ...postDoc(good), page_type: 'blog' });
    assert.equal(r.status, 'verified');
  });

  test('no Article deployed -> failed', async () => {
    assert.match((await run('article_schema', postDoc(null))).reasons.join(' '), /No Article/);
  });

  test('missing headline, malformed dates and modified-before-published fail with reasons', async () => {
    const r = await run('article_schema', { ...postDoc({ '@type': 'Article', datePublished: 'March 5th', dateModified: '2026-02-30' }), page_type: 'blog' });
    assert.equal(r.status, 'failed');
    const text = r.reasons.join(' ');
    assert.match(text, /datePublished is missing or invalid/);
    assert.match(text, /dateModified is missing or invalid/);
    const swapped = await run('article_schema', { ...postDoc({ ...good, datePublished: '2026-03-01', dateModified: '2026-02-01' }), page_type: 'blog' });
    assert.match(swapped.reasons.join(' '), /dateModified is earlier than datePublished/);
  });

  test('two Article entities fail', async () => {
    const pd = { ...postDoc(good), page_type: 'blog' };
    pd.structured_data = [{ '@graph': [good, { ...good, '@type': 'Article' }] }];
    assert.match((await run('article_schema', pd)).reasons.join(' '), /2 Article entities/);
  });

  test('Article markup on a page that is not an article fails, whatever the markup says', async () => {
    const contact = { ...page({ url: `${ORIGIN}/contact`, canonical: `${ORIGIN}/contact/`, structured_data: [good], word_count: 200, meta_tags: {} }), page_type: 'contact' };
    const r = await run('article_schema', contact);
    assert.equal(r.status, 'failed');
    assert.match(r.reasons.join(' '), /not an article/);
  });

  test('a real post that carries its own article signals (og:type) verifies even when classified generically', async () => {
    const pd = { ...postDoc(good, { 'og:type': ['article'] }), page_type: 'generic' };
    assert.equal((await run('article_schema', pd)).status, 'verified');
  });

  test('a broken article image fails; an unfetchable one is pending', async () => {
    const img = 'https://clinic.example/img/hero.jpg';
    const doc = { ...postDoc({ ...good, image: img }), page_type: 'blog' };
    assert.equal((await run('article_schema', doc, { [img]: probe404(img) })).status, 'failed');
    assert.equal((await run('article_schema', doc, { [img]: probeTimeout(img) })).status, 'unverifiable');
    assert.equal((await run('article_schema', doc, { [img]: probeOk(img, { format: 'jpeg' }) })).status, 'verified');
  });
});
