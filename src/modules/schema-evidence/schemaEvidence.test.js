import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { applyImageProbes, buildSchemaEvidence, imageUrlsToVerify, evidenceKindsFor } from './schemaEvidence.js';
import { renderSchemaEvidence } from './schemaEvidencePrompt.js';
import {
  ABOUT_CANONICAL, ABOUT_CRAWL_KEY, HOME, INVENTED_LOGO, ORG_ID, ORIGIN, REAL_LOGO,
  aboutPageData, graphWithOrganization, probe404, probeHtml200, probeOk, probeTimeout,
} from './__fixtures__/clinicSite.js';

const build = (issueId, pageData = aboutPageData(), extra = {}) => buildSchemaEvidence({ issueId, pageUrl: pageData.url, pageData, headingsByTag: { h1: ['About Us'] }, pageType: 'about', ...extra });

describe('evidenceKindsFor', () => {
  test('legacy and V2 ids map to the schema kinds they emit', () => {
    assert.deepEqual(evidenceKindsFor('organization_schema'), ['organization']);
    assert.deepEqual(evidenceKindsFor('AISO-A1'), ['organization']);
    assert.deepEqual(evidenceKindsFor('GEO-S5'), ['organization']);
    assert.deepEqual(evidenceKindsFor('article_schema'), ['article']);
    assert.deepEqual(evidenceKindsFor('GEO-S2'), ['article']);
    assert.deepEqual(evidenceKindsFor('breadcrumblist_schema'), ['breadcrumb']);
    assert.deepEqual(evidenceKindsFor('title_missing'), []);
    assert.deepEqual(evidenceKindsFor(undefined), []);
  });
});

describe('buildSchemaEvidence — Organization (regression: krishnaeyecentre-style site)', () => {
  test('an existing ["Hospital","Organization"] entity in @graph is found and its id/name/contact are reused', () => {
    const ev = build('AISO-A1');
    assert.equal(ev.organization.present, true);
    assert.equal(ev.organization.id, ORG_ID);
    assert.deepEqual(ev.organization.primary.types, ['Hospital', 'Organization']);
    assert.deepEqual(ev.organization.name, { value: 'Clinic Eye Centre', source: 'existing_organization_schema', verified: true });
    assert.equal(ev.organization.contact.telephone, '+918447637606');
    assert.equal(ev.organization.homepageUrl, HOME);
    assert.equal(ev.organization.entityCount, 1);
  });

  test('the page URL for markup is the canonical (trailing slash), not the crawl key', () => {
    const ev = build('organization_schema');
    assert.equal(ev.pageUrl, ABOUT_CRAWL_KEY);
    assert.equal(ev.url.display, ABOUT_CANONICAL);
    assert.equal(ev.url.trusted, true);
    assert.equal(ev.url.crawlKey, ABOUT_CRAWL_KEY);
  });

  test("the site's own logo is the first candidate and is NOT yet verified", () => {
    const ev = build('organization_schema');
    assert.equal(ev.organization.logo.candidates[0].url, REAL_LOGO);
    assert.equal(ev.organization.logo.candidates[0].trust, 'existing_schema');
    assert.equal(ev.organization.logo.status, 'unverified');
    assert.equal(ev.organization.logo.verified, null);
  });

  test('an image named "logo" is a weak HTML hint, ranked after the schema logo; non-logo images are ignored', () => {
    const ev = build('organization_schema');
    const hints = ev.organization.logo.candidates.filter((c) => c.trust === 'html_hint');
    assert.deepEqual(hints.map((c) => c.url), [`${ORIGIN}/wp-content/uploads/2024/10/clinic-logo-1.jpg`]);
    assert.ok(!ev.organization.logo.candidates.some((c) => /team-photo/.test(c.url)));
  });

  test('og:image is never treated as a logo', () => {
    const ev = build('organization_schema', aboutPageData({ meta_tags: { 'og:image': [`${ORIGIN}/wp-content/uploads/2020/02/NIL_7546-1.jpg`] }, images: [] }));
    assert.ok(!ev.organization.logo.candidates.some((c) => /NIL_7546/.test(c.url)));
  });

  test('image hints exclude client/partner/badge artwork and data URIs', () => {
    const ev = build('organization_schema', aboutPageData({
      structured_data: [],
      images: [
        { src: `${ORIGIN}/img/client-logo-acme.png`, alt: '' },
        { src: `${ORIGIN}/img/partner_logos.png`, alt: 'partner logos' },
        { src: 'data:image/svg+xml;base64,AAAA', alt: 'logo' },
        { src: '/img/site-logo.svg', alt: 'Site logo' },
      ],
    }));
    assert.deepEqual(ev.organization.logo.candidates.map((c) => c.url), [`${ORIGIN}/img/site-logo.svg`]);
  });

  test('no candidates at all -> status none; nothing is invented from the hostname', () => {
    const ev = build('organization_schema', aboutPageData({ structured_data: [], images: [] }));
    assert.equal(ev.organization.logo.status, 'none');
    assert.deepEqual(ev.organization.logo.candidates, []);
    assert.deepEqual(imageUrlsToVerify(ev), []);
    assert.equal(ev.organization.present, false);
    assert.equal(ev.organization.name, null);
    assert.equal(ev.organization.id, null);
    assert.equal(ev.organization.homepageUrl, HOME);
  });

  test('a name is "verified" only from the site\'s own schema / WebSite / og:site_name, never the title', () => {
    const noOrg = aboutPageData({ structured_data: [{ '@type': 'WebSite', name: 'Clinic Eye Centre' }] });
    assert.equal(build('organization_schema', noOrg).organization.name.source, 'existing_website_schema');
    const ogOnly = aboutPageData({ structured_data: [], meta_tags: { 'og:site_name': ['Clinic OG'] } });
    assert.equal(build('organization_schema', ogOnly).organization.name.source, 'og:site_name');
    assert.equal(build('organization_schema', aboutPageData({ structured_data: [] })).organization.name, null);
  });

  test('page data missing entirely degrades to "nothing verified", not an error', () => {
    const ev = buildSchemaEvidence({ issueId: 'organization_schema', pageUrl: ABOUT_CRAWL_KEY, pageData: null });
    assert.equal(ev.pageDataAvailable, false);
    assert.equal(ev.organization.present, false);
    assert.equal(ev.organization.logo.status, 'none');
  });

  test('duplicate organization entities are reported', () => {
    const doubled = aboutPageData({ structured_data: [...graphWithOrganization(), ...graphWithOrganization()] });
    const ev = build('organization_schema', doubled);
    assert.deepEqual(ev.organization.duplicateIds, [{ id: ORG_ID, count: 2 }]);
  });
});

describe('applyImageProbes — logo verification outcomes', () => {
  const ev0 = () => build('organization_schema');
  const hint = `${ORIGIN}/wp-content/uploads/2024/10/clinic-logo-1.jpg`;

  test('existing logo verifies: measured dimensions replace declared ones', () => {
    const ev = applyImageProbes(ev0(), [probeOk(REAL_LOGO, { width: 180, height: 60 })]);
    assert.equal(ev.organization.logo.status, 'verified');
    assert.deepEqual([ev.organization.logo.verified.url, ev.organization.logo.verified.width, ev.organization.logo.verified.height, ev.organization.logo.verified.confidence], [REAL_LOGO, 180, 60, 'high']);
  });

  test('a 404 existing logo is "existing_broken" and nothing is verified', () => {
    const ev = applyImageProbes(ev0(), [probe404(REAL_LOGO), probe404(hint)]);
    assert.equal(ev.organization.logo.verified, null);
    assert.equal(ev.organization.logo.status, 'existing_broken');
  });

  test('HTTP 200 returning HTML is a conclusively broken logo', () => {
    const ev = applyImageProbes(ev0(), [probeHtml200(REAL_LOGO), probeHtml200(hint)]);
    assert.equal(ev.organization.logo.status, 'existing_broken');
    assert.equal(ev.organization.logo.verified, null);
  });

  test('a working HTML-hint image replaces a broken declared logo, flagged as medium confidence', () => {
    const ev = applyImageProbes(ev0(), [probe404(REAL_LOGO), probeOk(hint, { final_url: hint })]);
    assert.equal(ev.organization.logo.status, 'replaces_broken_existing');
    assert.equal(ev.organization.logo.verified.url, hint);
    assert.equal(ev.organization.logo.verified.confidence, 'medium');
  });

  test('a timeout is NOT "broken": the logo stays unverified and unused', () => {
    const ev = applyImageProbes(ev0(), [probeTimeout(REAL_LOGO), probeTimeout(hint)]);
    assert.equal(ev.organization.logo.status, 'unverified');
    assert.equal(ev.organization.logo.verified, null);
  });

  test('no probe results at all (worker down) leaves everything unverified', () => {
    const ev = applyImageProbes(ev0(), []);
    assert.equal(ev.organization.logo.status, 'unverified');
    assert.equal(ev.organization.logo.verified, null);
  });

  test('a redirect to a valid image keeps the site\'s own declared URL when it works', () => {
    const ev = applyImageProbes(ev0(), [probeOk(REAL_LOGO, { final_url: `${ORIGIN}/cdn/logo.png`, redirects: 1 })]);
    assert.equal(ev.organization.logo.verified.url, REAL_LOGO);
    assert.equal(ev.organization.logo.verified.finalUrl, `${ORIGIN}/cdn/logo.png`);
  });

  test('the original evidence object is not mutated', () => {
    const original = ev0();
    applyImageProbes(original, [probeOk(REAL_LOGO)]);
    assert.equal(original.organization.logo.status, 'unverified');
    assert.equal(original.organization.logo.candidates[0].probe, undefined);
  });

  test('the fingerprint key changes when verification changes, and is stable otherwise', () => {
    const a = applyImageProbes(ev0(), [probeOk(REAL_LOGO)]);
    const b = applyImageProbes(ev0(), [probeOk(REAL_LOGO)]);
    const c = applyImageProbes(ev0(), [probe404(REAL_LOGO)]);
    assert.equal(a.fingerprintKey, b.fingerprintKey);
    assert.notEqual(a.fingerprintKey, c.fingerprintKey);
  });
});

describe('buildSchemaEvidence — BreadcrumbList', () => {
  const trail = (items) => ({ '@type': 'BreadcrumbList', itemListElement: items });
  const li = (position, name, item) => ({ '@type': 'ListItem', position, name, item });

  test('hierarchy is "unknown" when the page has no valid trail; no parent is invented', () => {
    const ev = build('breadcrumblist_schema');
    assert.equal(ev.breadcrumb.hierarchy.status, 'unknown');
    assert.deepEqual(ev.breadcrumb.hierarchy.items, []);
    assert.equal(ev.breadcrumb.needsInput, true);
    assert.deepEqual(ev.breadcrumb.hierarchy.current, { name: 'About Us', url: ABOUT_CANONICAL });
  });

  test('a valid existing trail is reused as the verified hierarchy', () => {
    const sd = [...graphWithOrganization(), trail([li(1, 'Home', HOME), li(2, 'About us', ABOUT_CANONICAL)])];
    const ev = build('breadcrumblist_schema', aboutPageData({ structured_data: sd }));
    assert.equal(ev.breadcrumb.hierarchy.status, 'existing');
    assert.deepEqual(ev.breadcrumb.hierarchy.items.map((i) => i.url), [HOME, ABOUT_CANONICAL]);
    assert.equal(ev.breadcrumb.needsInput, false);
  });

  test('an invalid existing trail (bad positions) is not trusted as hierarchy', () => {
    const sd = [trail([li(1, 'Home', HOME), li(5, 'About', ABOUT_CANONICAL)])];
    const ev = build('breadcrumblist_schema', aboutPageData({ structured_data: sd }));
    assert.equal(ev.breadcrumb.hierarchy.status, 'unknown');
    assert.ok(ev.breadcrumb.existing[0].problems.includes('position_not_sequential'));
  });

  test('a single-item trail is not a usable hierarchy', () => {
    const ev = build('breadcrumblist_schema', aboutPageData({ structured_data: [trail([li(1, 'About', ABOUT_CANONICAL)])] }));
    assert.equal(ev.breadcrumb.hierarchy.status, 'unknown');
  });

  test('duplicate BreadcrumbLists are flagged', () => {
    const t = trail([li(1, 'Home', HOME), li(2, 'About', ABOUT_CANONICAL)]);
    assert.equal(build('breadcrumblist_schema', aboutPageData({ structured_data: [t, t] })).breadcrumb.duplicateLists, true);
  });

  test('breadcrumb URLs with encoded paths and query parameters survive untouched', () => {
    const url = `${ORIGIN}/caf%C3%A9/Menu/?lang=en`;
    const sd = [trail([li(1, 'Home', HOME), li(2, 'Menu', url)])];
    const ev = build('breadcrumblist_schema', aboutPageData({ structured_data: sd }));
    assert.equal(ev.breadcrumb.hierarchy.items[1].url, url);
  });
});

describe('buildSchemaEvidence — Article applicability and facts', () => {
  const post = (over = {}) => aboutPageData({
    url: `${ORIGIN}/blog/five-tips`, canonical: `${ORIGIN}/blog/five-tips/`, structured_data: [], title: 'Five tips', word_count: 800, images: [], meta_tags: {}, ...over,
  });
  const art = (pd, pageType = 'blog', h1 = ['Five tips']) => buildSchemaEvidence({ issueId: 'article_schema', pageUrl: pd.url, pageData: pd, headingsByTag: { h1 }, pageType });

  test('a generic or service page is not an article, even with long text', () => {
    assert.equal(art(post(), 'generic').article.applicable, false);
    assert.equal(art(post(), 'service').article.applicable, false);
    assert.equal(art(post({ url: `${ORIGIN}/contact` }), 'contact').article.applicable, false);
  });

  test('a blog section index with no article signals is not an article', () => {
    const index = post({ url: `${ORIGIN}/blog`, word_count: 900 });
    assert.equal(art(index, 'blog').article.applicable, false);
  });

  test('a blog post with a post-like path, length and heading qualifies', () => {
    assert.equal(art(post(), 'blog').article.applicable, true);
    assert.equal(art(post({ word_count: 120 }), 'blog').article.applicable, false);
    assert.equal(art(post(), 'blog', []).article.applicable, false);
  });

  test('og:type=article, article:published_time, or existing Article markup qualify any page type', () => {
    assert.equal(art(post({ url: `${ORIGIN}/story`, meta_tags: { 'og:type': ['article'] } }), 'generic').article.applicable, true);
    assert.equal(art(post({ url: `${ORIGIN}/story`, meta_tags: { 'article:published_time': ['2026-01-02T03:04:05+05:30'] } }), 'generic').article.applicable, true);
    assert.equal(art(post({ url: `${ORIGIN}/story`, structured_data: [{ '@type': 'BlogPosting', headline: 'H' }] }), 'generic').article.applicable, true);
  });

  test('facts come from the page: dates keep their offset, author only from meta/existing markup, nothing is fabricated', () => {
    const pd = post({ meta_tags: { 'article:published_time': ['2026-01-02T03:04:05+05:30'], 'article:modified_time': ['2026-02-03T04:05:06+05:30'], author: ['Dr A Sharma'], 'og:image': [`${ORIGIN}/img/hero.jpg`] } });
    const a = art(pd).article;
    assert.deepEqual(a.datePublished, { value: '2026-01-02T03:04:05+05:30', hasTimezone: true, source: 'article:published_time' });
    assert.equal(a.dateModified.value, '2026-02-03T04:05:06+05:30');
    assert.deepEqual(a.author, { name: 'Dr A Sharma', source: 'meta:author' });
    assert.deepEqual(a.headline, { value: 'Five tips', source: 'h1' });
    assert.deepEqual(a.image.candidates.map((c) => c.url), [`${ORIGIN}/img/hero.jpg`]);
    assert.equal(a.mainEntityOfPage, `${ORIGIN}/blog/five-tips/`);
  });

  test('missing fields are listed as missing, never filled in', () => {
    const a = art(post()).article;
    assert.equal(a.author, null);
    assert.equal(a.datePublished, null);
    assert.deepEqual(a.missing.sort(), ['author', 'datePublished', 'image']);
  });

  test('malformed dates are ignored and reported; modified-before-published is flagged', () => {
    const bad = art(post({ meta_tags: { 'article:published_time': ['March 5th'], 'article:modified_time': ['2026-02-30'] } })).article;
    assert.equal(bad.datePublished, null);
    assert.equal(bad.dateModified, null);
    assert.deepEqual(bad.dateProblems.map((p) => p.reason).sort(), ['impossible_date', 'not_iso_8601']);
    const swapped = art(post({ meta_tags: { 'article:published_time': ['2026-03-01T00:00:00Z'], 'article:modified_time': ['2026-02-01T00:00:00Z'] } })).article;
    assert.ok(swapped.dateProblems.some((p) => p.reason === 'modified_before_published'));
  });

  test('an existing Article is reused: its type, headline and author are kept', () => {
    const pd = post({ structured_data: [{ '@type': 'NewsArticle', headline: 'Existing headline', datePublished: '2026-01-02', author: { '@type': 'Person', name: 'Dr B' } }] });
    const a = art(pd).article;
    assert.equal(a.existing, true);
    assert.deepEqual(a.existingType, ['NewsArticle']);
    assert.equal(a.headline.value, 'Existing headline');
    assert.deepEqual(a.author, { name: 'Dr B', source: 'existing_article_schema' });
  });

  test('article image verification: only a verified image is accepted', () => {
    const pd = post({ meta_tags: { 'og:image': [`${ORIGIN}/img/hero.jpg`] } });
    const ev = art(pd);
    assert.deepEqual(imageUrlsToVerify(ev), [`${ORIGIN}/img/hero.jpg`]);
    assert.equal(applyImageProbes(ev, [probeOk(`${ORIGIN}/img/hero.jpg`)]).article.image.status, 'verified');
    assert.equal(applyImageProbes(ev, [probe404(`${ORIGIN}/img/hero.jpg`)]).article.image.status, 'all_broken');
    assert.equal(applyImageProbes(ev, [probeTimeout(`${ORIGIN}/img/hero.jpg`)]).article.image.status, 'unverified');
  });

  test('an article-kind issue does not probe logos, an organization-kind issue does not probe article images', () => {
    assert.ok(!imageUrlsToVerify(art(post({ images: [{ src: `${ORIGIN}/x/logo.png`, alt: '' }] }))).some((u) => /logo/.test(u)));
  });
});

describe('renderSchemaEvidence — what the model is shown', () => {
  test('a broken existing logo is NOT offered; the invented upload path is explicitly forbidden', () => {
    const ev = applyImageProbes(build('organization_schema'), [probe404(REAL_LOGO), probe404(`${ORIGIN}/wp-content/uploads/2024/10/clinic-logo-1.jpg`)]);
    const text = renderSchemaEvidence(ev);
    assert.match(text, /Logo: NOT AVAILABLE/);
    assert.match(text, /returns an error or is not an image/);
    assert.match(text, /never \/wp-content\/uploads\/logo\.png/);
    assert.ok(!text.includes(REAL_LOGO));
    assert.ok(!text.includes(INVENTED_LOGO));
  });

  test('a verified logo is shown with measured dimensions; the existing @id is to be reused', () => {
    const ev = applyImageProbes(build('organization_schema'), [probeOk(REAL_LOGO, { width: 178, height: 59 })]);
    const text = renderSchemaEvidence(ev);
    assert.match(text, new RegExp(`Logo: VERIFIED "${REAL_LOGO.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
    assert.match(text, /measured 178x59px/);
    assert.match(text, /do NOT create a second Organization/);
    assert.match(text, new RegExp(`@id "${ORG_ID.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  });

  test('contact facts are shown only when the site already publishes them', () => {
    const text = renderSchemaEvidence(applyImageProbes(build('organization_schema'), []));
    assert.match(text, /telephone=\+918447637606/);
    assert.match(text, /NOT AVAILABLE \(omit; never invent\)/);
    const bare = renderSchemaEvidence(applyImageProbes(build('organization_schema', aboutPageData({ structured_data: [], images: [] })), []));
    assert.doesNotMatch(bare, /Already published by the site/);
    assert.match(bare, /Existing entity: none found/);
  });

  test('unknown breadcrumb hierarchy forbids inventing parents; an unconfirmed URL is labelled as such', () => {
    const noCanonical = aboutPageData({ canonical: undefined });
    const text = renderSchemaEvidence(applyImageProbes(build('breadcrumblist_schema', noCanonical), []));
    assert.match(text, /Hierarchy: UNKNOWN/);
    assert.match(text, /Do NOT invent parents/);
    assert.match(text, /NOT CONFIRMED/);
  });

  test('a non-article page tells the model not to generate Article markup', () => {
    const text = renderSchemaEvidence(buildSchemaEvidence({ issueId: 'article_schema', pageUrl: `${ORIGIN}/contact`, pageData: aboutPageData({ url: `${ORIGIN}/contact` }), pageType: 'contact' }));
    assert.match(text, /NOT AN ARTICLE PAGE/);
  });

  test('empty for an issue without evidence', () => {
    assert.equal(renderSchemaEvidence(null), '');
  });
});
