import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { applyGuardToSections, checkSchemaAgainstEvidence, sanitizeGeneratedSchema } from './schemaOutputGuard.js';
import { applyImageProbes, buildSchemaEvidence } from './schemaEvidence.js';
import {
  ABOUT_CANONICAL, HOME, INVENTED_LOGO, ORG_ID, ORIGIN, REAL_LOGO,
  aboutPageData, graphWithOrganization, probe404, probeOk, probeTimeout,
} from './__fixtures__/clinicSite.js';

const HINT = `${ORIGIN}/wp-content/uploads/2024/10/clinic-logo-1.jpg`;
const evidenceFor = (issueId, probes, pageData = aboutPageData(), pageType = 'about', h1 = 'About Us') =>
  applyImageProbes(buildSchemaEvidence({ issueId, pageUrl: pageData.url, pageData, headingsByTag: { h1: [h1] }, pageType }), probes);

// The exact failure from the audit: a generic Organization with an invented logo, a duplicate @id and made-up contact data.
const fabricatedOrg = () => ({
  '@context': 'https://schema.org',
  '@type': 'Organization',
  '@id': `${ORIGIN}/#org`,
  name: 'Clinic Eye Centre',
  url: HOME,
  logo: { '@type': 'ImageObject', url: INVENTED_LOGO, width: 600, height: 60 },
  telephone: '+1-555-0100',
  email: 'info@clinic.example',
  contactPoint: { '@type': 'ContactPoint', telephone: '+1-555-0100', contactType: 'customer service' },
  sameAs: ['https://www.facebook.com/clinic', 'https://twitter.com/clinic'],
  foundingDate: '1998',
});

describe('sanitizeGeneratedSchema — Organization', () => {
  test('REGRESSION: the invented /wp-content/uploads/logo.png is removed, never published', () => {
    const ev = evidenceFor('organization_schema', [probe404(REAL_LOGO), probe404(HINT)]);
    const { schema, removed, notes } = sanitizeGeneratedSchema(fabricatedOrg(), ev);
    assert.equal(schema.logo, undefined);
    assert.ok(removed.some((r) => r.field === 'logo'));
    assert.ok(notes.some((n) => /Logo/.test(n)));
    assert.ok(!JSON.stringify(schema).includes(INVENTED_LOGO));
  });

  test('a logo the model returns that was not fetched is removed even when another logo IS verified', () => {
    const ev = evidenceFor('organization_schema', [probeOk(REAL_LOGO, { width: 178, height: 59 })]);
    const { schema } = sanitizeGeneratedSchema(fabricatedOrg(), ev);
    assert.equal(schema.logo.url, REAL_LOGO);
    assert.deepEqual([schema.logo.width, schema.logo.height], [178, 59]);
  });

  test('a verified logo is added when the model omitted it, with MEASURED dimensions', () => {
    const ev = evidenceFor('organization_schema', [probeOk(REAL_LOGO, { width: 200, height: 70 })]);
    const { schema } = sanitizeGeneratedSchema({ '@context': 'https://schema.org', '@type': 'Organization', name: 'Clinic Eye Centre', url: HOME }, ev);
    assert.deepEqual(schema.logo, { '@type': 'ImageObject', url: REAL_LOGO, width: 200, height: 70 });
  });

  test('measured size unavailable (e.g. SVG without dimensions): no width/height is invented', () => {
    const ev = evidenceFor('organization_schema', [probeOk(REAL_LOGO, { width: null, height: null, format: 'svg' })]);
    const { schema } = sanitizeGeneratedSchema(fabricatedOrg(), ev);
    assert.equal(schema.logo.url, REAL_LOGO);
    assert.equal('width' in schema.logo, false);
    assert.equal('height' in schema.logo, false);
  });

  test('an unverifiable logo (timeout) is omitted, not published and not called broken', () => {
    const ev = evidenceFor('organization_schema', [probeTimeout(REAL_LOGO), probeTimeout(HINT)]);
    const { schema, notes } = sanitizeGeneratedSchema({ '@type': 'Organization', name: 'X', url: HOME, logo: REAL_LOGO }, ev);
    assert.equal(schema.logo, undefined);
    assert.ok(notes.some((n) => /could not be verified right now/.test(n)));
  });

  test('no logo found anywhere: omitted with an explicit "needs your input" note', () => {
    const ev = evidenceFor('organization_schema', [], aboutPageData({ structured_data: [], images: [] }));
    const { schema, notes } = sanitizeGeneratedSchema({ '@type': 'Organization', name: 'Clinic', url: HOME, logo: INVENTED_LOGO }, ev);
    assert.equal(schema.logo, undefined);
    assert.ok(notes.some((n) => /no logo could be found/.test(n)));
  });

  test('fabricated phone / email / contactPoint / foundingDate / social profiles are stripped', () => {
    const ev = evidenceFor('organization_schema', [probeOk(REAL_LOGO)]);
    const { schema, removed } = sanitizeGeneratedSchema(fabricatedOrg(), ev);
    for (const f of ['email', 'contactPoint', 'foundingDate', 'sameAs']) assert.equal(schema[f], undefined, f);
    // the model's invented logo is removed too, then the verified one is put in its place
    assert.deepEqual(removed.map((r) => r.field).sort(), ['contactPoint', 'email', 'foundingDate', 'logo', 'sameAs', 'telephone']);
    assert.equal(schema.logo.url, REAL_LOGO);
  });

  test("the SITE's own contact data always wins: it is kept when the model copied it, restored when the model dropped it, and a different value from the model is discarded", () => {
    const ev = evidenceFor('organization_schema', [probeOk(REAL_LOGO)]);
    const base = { '@type': 'Organization', name: 'Clinic Eye Centre', url: HOME };
    const kept = sanitizeGeneratedSchema({ ...base, telephone: '+918447637606' }, ev);
    assert.equal(kept.schema.telephone, '+918447637606');
    assert.ok(!kept.removed.some((r) => r.field === 'telephone'));
    const restored = sanitizeGeneratedSchema(base, ev).schema;
    assert.equal(restored.telephone, '+918447637606');
    assert.equal(restored.address.addressLocality, 'Parel');
    const different = sanitizeGeneratedSchema({ ...base, telephone: '+918447637607', address: { '@type': 'PostalAddress', streetAddress: 'Somewhere else' } }, ev);
    assert.equal(different.schema.telephone, '+918447637606');
    assert.equal(different.schema.address.streetAddress, '2-A Trust House');
    assert.ok(different.removed.some((r) => r.field === 'telephone' && /already publishes a different value/.test(r.reason)));
  });

  test("sameAs is exactly the site's own list (extra profiles from the model are discarded, nothing is invented)", () => {
    const pd = aboutPageData({ structured_data: graphWithOrganization({ sameAs: ['https://www.facebook.com/clinic/'] }) });
    const ev = evidenceFor('organization_schema', [probeOk(REAL_LOGO)], pd);
    const { schema } = sanitizeGeneratedSchema({ '@type': 'Organization', name: 'Clinic Eye Centre', url: HOME, sameAs: ['https://www.facebook.com/clinic', 'https://twitter.com/made-up'] }, ev);
    assert.deepEqual(schema.sameAs, ['https://www.facebook.com/clinic/']);
    const none = evidenceFor('organization_schema', [], aboutPageData({ structured_data: [], images: [] }));
    assert.equal(sanitizeGeneratedSchema({ '@type': 'Organization', name: 'X', url: HOME, sameAs: ['https://twitter.com/made-up'] }, none).schema.sameAs, undefined);
  });

  test('the existing @id and @type are reused — no second entity identity is minted', () => {
    const ev = evidenceFor('organization_schema', [probeOk(REAL_LOGO)]);
    const { schema } = sanitizeGeneratedSchema(fabricatedOrg(), ev);
    assert.equal(schema['@id'], ORG_ID);
    assert.deepEqual(schema['@type'], ['Hospital', 'Organization']);
  });

  test('with no existing entity, a stable @id on the verified homepage is used (never an invented host)', () => {
    const ev = evidenceFor('organization_schema', [], aboutPageData({ structured_data: [], images: [] }));
    const { schema } = sanitizeGeneratedSchema({ '@type': 'Organization', '@id': 'https://evil.example/#org', name: 'Clinic', url: 'https://evil.example/' }, ev);
    assert.equal(schema['@id'], `${HOME}#organization`);
    assert.equal(schema.url, HOME);
  });

  test('a verified name from the site wins over the model\'s; an unverified name is left for the user to confirm', () => {
    const ev = evidenceFor('organization_schema', [probeOk(REAL_LOGO)]);
    assert.equal(sanitizeGeneratedSchema({ '@type': 'Organization', name: 'Clinic Eye Hospital Pvt', url: HOME }, ev).schema.name, 'Clinic Eye Centre');
  });

  test('two Organization entities in the output collapse to one', () => {
    const ev = evidenceFor('organization_schema', [probeOk(REAL_LOGO)]);
    const { schema, removed } = sanitizeGeneratedSchema({ '@context': 'https://schema.org', '@graph': [{ '@type': 'Organization', name: 'A', url: HOME }, { '@type': 'LocalBusiness', name: 'B', url: HOME }, { '@type': 'WebSite', url: HOME, name: 'W' }] }, ev);
    assert.equal(schema['@graph'].filter((n) => /Organization|LocalBusiness|Hospital/.test(JSON.stringify(n['@type']))).length, 1);
    assert.ok(removed.some((r) => r.field === '(entity)'));
    assert.ok(schema['@graph'].some((n) => n['@type'] === 'WebSite'));
  });

  test('does not mutate its input', () => {
    const ev = evidenceFor('organization_schema', [probe404(REAL_LOGO)]);
    const input = fabricatedOrg();
    const copy = JSON.parse(JSON.stringify(input));
    sanitizeGeneratedSchema(input, ev);
    assert.deepEqual(input, copy);
  });

  test('without evidence it is a no-op', () => {
    const input = fabricatedOrg();
    assert.deepEqual(sanitizeGeneratedSchema(input, null).schema, input);
  });
});

describe('sanitizeGeneratedSchema — BreadcrumbList', () => {
  const li = (position, name, item) => ({ '@type': 'ListItem', position, name, item });
  const withTrail = (items) => aboutPageData({ structured_data: [...graphWithOrganization(), { '@type': 'BreadcrumbList', itemListElement: items }] });

  test('unknown hierarchy: the generated BreadcrumbList is dropped and the user is told why', () => {
    const ev = evidenceFor('breadcrumblist_schema', []);
    const gen = { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [li(1, 'Home', HOME), li(2, 'Company', `${ORIGIN}/company/`), li(3, 'About', `${ORIGIN}/about-us`)] };
    const { schema, notes } = sanitizeGeneratedSchema(gen, ev);
    assert.equal(schema, null);
    assert.ok(notes.some((n) => /could not be verified from the crawl/.test(n)));
  });

  test('in a @graph only the breadcrumb is dropped', () => {
    const ev = evidenceFor('breadcrumblist_schema', []);
    const { schema } = sanitizeGeneratedSchema({ '@context': 'https://schema.org', '@graph': [{ '@type': 'WebSite', name: 'W', url: HOME }, { '@type': 'BreadcrumbList', itemListElement: [li(1, 'Home', HOME), li(2, 'X', `${ORIGIN}/x/`)] }] }, ev);
    assert.deepEqual(schema['@graph'].map((n) => n['@type']), ['WebSite']);
  });

  test('known hierarchy: invented parents are removed, URLs are the verified ones, positions are renumbered', () => {
    const ev = evidenceFor('breadcrumblist_schema', [], withTrail([li(1, 'Home', HOME), li(2, 'About us', ABOUT_CANONICAL)]));
    const gen = { '@type': 'BreadcrumbList', itemListElement: [li(1, 'Home', HOME), li(2, 'Our Company', `${ORIGIN}/company/`), li(3, 'About us', `${ORIGIN}/about-us`)] };
    const { schema, removed } = sanitizeGeneratedSchema(gen, ev);
    // the trailing-slash-less URL is the same page as the verified canonical item, and is published in its verified form
    assert.deepEqual(schema.itemListElement.map((i) => [i.position, i.item]), [[1, HOME], [2, ABOUT_CANONICAL]]);
    assert.ok(removed.some((r) => /Our Company/.test(r.reason)));
  });

  test('a trail that shrinks below two items is dropped', () => {
    const ev = evidenceFor('breadcrumblist_schema', [], withTrail([li(1, 'Home', HOME), li(2, 'About us', ABOUT_CANONICAL)]));
    const { schema } = sanitizeGeneratedSchema({ '@type': 'BreadcrumbList', itemListElement: [li(1, 'Nope', `${ORIGIN}/nope/`), li(2, 'About us', ABOUT_CANONICAL)] }, ev);
    assert.equal(schema, null);
  });
});

describe('sanitizeGeneratedSchema — Article', () => {
  const postData = (meta = {}) => aboutPageData({ url: `${ORIGIN}/blog/five-tips`, canonical: `${ORIGIN}/blog/five-tips/`, structured_data: [], title: 'Five tips', word_count: 800, images: [], meta_tags: meta });
  const ev = (meta, probes = []) => evidenceFor('article_schema', probes, postData(meta), 'blog', 'Five tips');
  const gen = () => ({ '@context': 'https://schema.org', '@type': 'BlogPosting', headline: 'Five Amazing Tips You Won\'t Believe', author: { '@type': 'Person', name: 'Dr Jane Doe' }, datePublished: '2024-01-01', dateModified: '2024-06-01', image: 'https://stock.example/x.jpg', mainEntityOfPage: 'https://elsewhere.example/', publisher: { '@type': 'Organization', logo: { url: INVENTED_LOGO } } });

  test('fabricated author, dates, image and mainEntityOfPage are removed; the page\'s own facts replace them', () => {
    const e = ev({ 'article:published_time': ['2026-01-02T03:04:05+05:30'] });
    const { schema, notes } = sanitizeGeneratedSchema(gen(), e);
    assert.equal(schema.headline, 'Five tips');
    assert.equal(schema.datePublished, '2026-01-02T03:04:05+05:30');
    assert.equal(schema.dateModified, undefined);
    assert.equal(schema.author, undefined);
    assert.equal(schema.image, undefined);
    assert.deepEqual(schema.mainEntityOfPage, { '@type': 'WebPage', '@id': `${ORIGIN}/blog/five-tips/` });
    assert.equal(schema.publisher.logo, undefined);
    assert.ok(notes.some((n) => /author/.test(n)));
  });

  test('an author present on the page, and a verified image, are kept', () => {
    const e = ev({ author: ['Dr A Sharma'], 'og:image': [`${ORIGIN}/img/hero.jpg`] }, [probeOk(`${ORIGIN}/img/hero.jpg`)]);
    const { schema } = sanitizeGeneratedSchema(gen(), e);
    assert.deepEqual(schema.author, { '@type': 'Person', name: 'Dr A Sharma' });
    assert.equal(schema.image, `${ORIGIN}/img/hero.jpg`);
  });

  test('a broken article image is dropped', () => {
    const e = ev({ 'og:image': [`${ORIGIN}/img/hero.jpg`] }, [probe404(`${ORIGIN}/img/hero.jpg`)]);
    assert.equal(sanitizeGeneratedSchema(gen(), e).schema.image, undefined);
  });

  test('timezone offsets are preserved exactly as the page states them', () => {
    const e = ev({ 'article:published_time': ['2026-01-02T03:04:05-08:00'], 'article:modified_time': ['2026-01-03T00:00:00Z'] });
    const { schema } = sanitizeGeneratedSchema(gen(), e);
    assert.equal(schema.datePublished, '2026-01-02T03:04:05-08:00');
    assert.equal(schema.dateModified, '2026-01-03T00:00:00Z');
  });

  test('an existing type (NewsArticle) is kept rather than replaced by the model\'s guess', () => {
    const pd = postData({});
    pd.structured_data = [{ '@type': 'NewsArticle', headline: 'Existing', datePublished: '2026-01-02' }];
    const e = evidenceFor('article_schema', [], pd, 'blog', 'Five tips');
    assert.equal(sanitizeGeneratedSchema(gen(), e).schema['@type'], 'NewsArticle');
  });
});

describe('checkSchemaAgainstEvidence — the read-only backstop used by SchemaValidator', () => {
  test('flags an unverified logo, invented contact data and conflicting @id', () => {
    const ev = evidenceFor('organization_schema', [probe404(REAL_LOGO)]);
    const { errors } = checkSchemaAgainstEvidence(fabricatedOrg(), ev);
    assert.ok(errors.some((e) => /logo URL .* was not verified/.test(e)));
    assert.ok(errors.some((e) => /"telephone" is not present on the site/.test(e)));
    assert.ok(errors.some((e) => /conflicts with the site's existing entity/.test(e)));
  });

  test('passes output that the guard produced', () => {
    const ev = evidenceFor('organization_schema', [probeOk(REAL_LOGO)]);
    const { schema } = sanitizeGeneratedSchema(fabricatedOrg(), ev);
    assert.deepEqual(checkSchemaAgainstEvidence(schema, ev).errors, []);
  });

  test('flags a logo that is not even a URL, a foreign Organization url, a bad sameAs', () => {
    const ev = evidenceFor('organization_schema', [probeOk(REAL_LOGO)]);
    const { errors } = checkSchemaAgainstEvidence({ '@type': 'Organization', '@id': ORG_ID, name: 'X', url: 'https://evil.example/', logo: 'not a url', sameAs: ['javascript:alert(1)'] }, ev);
    assert.ok(errors.some((e) => /logo is not a valid absolute http\(s\) URL/.test(e)));
    assert.ok(errors.some((e) => /not on the audited site/.test(e)));
    assert.ok(errors.some((e) => /sameAs entry/.test(e)));
  });

  test('flags two Organization entities', () => {
    const ev = evidenceFor('organization_schema', [probeOk(REAL_LOGO)]);
    const { errors } = checkSchemaAgainstEvidence([{ '@type': 'Organization', '@id': ORG_ID, name: 'A', url: HOME }, { '@type': 'Organization', '@id': ORG_ID, name: 'B', url: HOME }], ev);
    assert.ok(errors.some((e) => /2 Organization entities/.test(e)));
  });

  test('article: dates must be valid ISO and match the page; author/image need evidence; non-article pages are rejected', () => {
    const pd = aboutPageData({ url: `${ORIGIN}/blog/five-tips`, canonical: `${ORIGIN}/blog/five-tips/`, structured_data: [], word_count: 800, images: [], meta_tags: { 'article:published_time': ['2026-01-02T03:04:05+05:30'] } });
    const ev = evidenceFor('article_schema', [], pd, 'blog');
    const { errors } = checkSchemaAgainstEvidence({ '@type': 'Article', headline: 'H', datePublished: '2026-01-02T03:04:05+05:30', dateModified: 'yesterday', author: { name: 'Zed' }, image: 'https://x.example/i.jpg' }, ev);
    assert.ok(errors.some((e) => /dateModified "yesterday" is not a valid ISO 8601/.test(e)));
    assert.ok(errors.some((e) => /author was generated but no author/.test(e)));
    assert.ok(errors.some((e) => /image was not verified/.test(e)));
    assert.ok(!errors.some((e) => /datePublished/.test(e)));

    const contact = evidenceFor('article_schema', [], aboutPageData({ url: `${ORIGIN}/contact` }), 'contact');
    assert.ok(checkSchemaAgainstEvidence({ '@type': 'Article', headline: 'H' }, contact).errors.some((e) => /not an article/.test(e)));
  });

  test('breadcrumb generated although the hierarchy is unknown is an error', () => {
    const ev = evidenceFor('breadcrumblist_schema', []);
    assert.ok(checkSchemaAgainstEvidence({ '@type': 'BreadcrumbList', itemListElement: [] }, ev).errors.length > 0);
  });

  test('no evidence -> nothing to check', () => {
    assert.deepEqual(checkSchemaAgainstEvidence(fabricatedOrg(), null), { errors: [], warnings: [] });
  });
});

describe('applyGuardToSections — rewriting a recommendation', () => {
  const sectionsWith = (json, wrap = true) => ({
    whyThisMatters: 'why',
    recommendedFix: '1. Paste the markup.',
    implementationExample: { type: 'html', content: wrap ? `<script type="application/ld+json">\n${JSON.stringify(json, null, 2)}\n</script>` : JSON.stringify(json) },
    recommendedVersion: JSON.stringify(json),
    expectedImpact: ['x'],
    estimatedRecovery: {},
  });

  test('both places the schema prompt writes JSON-LD are sanitised; the <script> wrapper is kept', () => {
    const ev = evidenceFor('organization_schema', [probe404(REAL_LOGO), probe404(HINT)]);
    const { sections, report } = applyGuardToSections(sectionsWith(fabricatedOrg()), ev);
    const code = sections.implementationExample.content;
    assert.match(code, /^<script type="application\/ld\+json">/);
    assert.match(code, /<\/script>$/);
    assert.ok(!code.includes(INVENTED_LOGO));
    assert.ok(!sections.recommendedVersion.includes(INVENTED_LOGO));
    assert.ok(!code.includes('+1-555-0100'));
    assert.ok(report.removed.length >= 5);
    assert.doesNotThrow(() => JSON.parse(code.replace(/<\/?script[^>]*>/g, '')));
  });

  test('the user is told what was left out, in recommendedFix', () => {
    const ev = evidenceFor('organization_schema', [probe404(REAL_LOGO), probe404(HINT)]);
    const { sections } = applyGuardToSections(sectionsWith(fabricatedOrg()), ev);
    assert.match(sections.recommendedFix, /ODITO verification notes/);
    assert.match(sections.recommendedFix, /Logo:/);
    assert.match(sections.recommendedFix, /telephone/);
  });

  test('a recommendation that was already correct is returned with no notes added', () => {
    const ev = evidenceFor('organization_schema', [probeOk(REAL_LOGO, { width: 178, height: 59 })]);
    const clean = { '@context': 'https://schema.org', '@type': ['Hospital', 'Organization'], '@id': ORG_ID, name: 'Clinic Eye Centre', url: HOME, logo: { '@type': 'ImageObject', url: REAL_LOGO, width: 178, height: 59 } };
    const { sections } = applyGuardToSections(sectionsWith(clean), ev);
    assert.equal(sections.recommendedFix, '1. Paste the markup.');
  });

  test('unknown breadcrumb hierarchy replaces the code with a plain explanation, not JSON-LD', () => {
    const ev = evidenceFor('breadcrumblist_schema', []);
    const s = sectionsWith({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Home', item: HOME }, { '@type': 'ListItem', position: 2, name: 'About', item: `${ORIGIN}/about-us` }] });
    s.recommendedVersion = 'enabled'; // the single-value Rank Math toggle must be untouched
    const { sections } = applyGuardToSections(s, ev);
    assert.match(sections.implementationExample.content, /could not be verified from the crawl/);
    assert.ok(!sections.implementationExample.content.includes('ListItem'));
    assert.equal(sections.recommendedVersion, 'enabled');
  });

  test('non-JSON content (prose, PHP) and missing evidence are left alone', () => {
    const ev = evidenceFor('organization_schema', [probeOk(REAL_LOGO)]);
    const prose = { ...sectionsWith(fabricatedOrg()), implementationExample: { content: '<?php echo 1; ?>' }, recommendedVersion: 'plain words' };
    assert.equal(applyGuardToSections(prose, ev).sections.implementationExample.content, '<?php echo 1; ?>');
    const s = sectionsWith(fabricatedOrg());
    assert.equal(applyGuardToSections(s, null).sections, s);
  });

  test('JSON containing "$" sequences survives the rewrite intact, and "</script>" in a value can never close the tag', () => {
    const ev = evidenceFor('organization_schema', [probeOk(REAL_LOGO)]);
    const { sections } = applyGuardToSections(sectionsWith({ '@type': 'Organization', name: 'Clinic Eye Centre', url: HOME, description: 'From $5 & up: $& $1 $$' }), ev);
    const parsed = JSON.parse(sections.implementationExample.content.replace(/<\/?script[^>]*>/g, ''));
    assert.equal(parsed.description, 'From $5 & up: $& $1 $$'); // identical JSON; "&" is written as & so nothing can close the <script> tag
  });
});
