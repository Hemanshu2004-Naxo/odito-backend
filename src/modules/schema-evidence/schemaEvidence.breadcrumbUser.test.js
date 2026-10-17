import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSchemaEvidence, summarizeSchemaEvidence } from './schemaEvidence.js';
import { sanitizeGeneratedSchema, applyGuardToSections } from './schemaOutputGuard.js';
import { renderSchemaEvidence } from './schemaEvidencePrompt.js';
import { verifySchemaFix } from './schemaVerification.js';
import { generateBreadcrumbListJsonLd, serializeJsonLdForScript } from './breadcrumbHierarchy.js';
import { HOME, ORIGIN, graphWithOrganization, aboutPageData } from './__fixtures__/clinicSite.js';

const BLOG_KEY = `${ORIGIN}/blog`;
const BLOG_CANON = `${ORIGIN}/blog/`;
const li = (position, name, item) => ({ '@type': 'ListItem', position, name, item });
const crumb = (...items) => ({ '@type': 'BreadcrumbList', itemListElement: items });
const blogPage = (structured = [], over = {}) => aboutPageData({ url: BLOG_KEY, canonical: BLOG_CANON, title: 'Blog', structured_data: structured, scraped_at: '2026-10-02T10:00:00Z', ...over });
const USER = {
  items: [{ position: 1, name: 'Home', url: HOME }, { position: 2, name: 'Blog', url: BLOG_CANON }],
  evidenceHash: 'h1', submittedAt: '2026-10-01T00:00:00Z', canonicalSource: 'canonical_tag',
};
const build = (pageData, userBreadcrumb) => buildSchemaEvidence({ issueId: 'breadcrumblist_schema', pageUrl: pageData.url, pageData, headingsByTag: { h1: ['Blog'] }, pageType: 'blog', userBreadcrumb });

describe('breadcrumb hierarchy states', () => {
  test('A. nothing on the page, nothing supplied -> unknown, needs input, current page offered from the CANONICAL', () => {
    const ev = build(blogPage());
    assert.equal(ev.breadcrumb.hierarchy.status, 'unknown');
    assert.equal(ev.breadcrumb.needsInput, true);
    assert.equal(ev.breadcrumb.hierarchy.current.url, BLOG_CANON);
    assert.equal(ev.url.crawlKey, BLOG_KEY);
  });

  test('D. nothing on the page, owner-confirmed trail -> user_provided', () => {
    const ev = build(blogPage(), USER);
    assert.equal(ev.breadcrumb.hierarchy.status, 'user_provided');
    assert.equal(ev.breadcrumb.needsInput, false);
    assert.deepEqual(ev.breadcrumb.hierarchy.items.map((i) => i.url), [HOME, BLOG_CANON]);
  });

  test('F. a valid trail already on the page and nothing different supplied -> existing (unchanged behaviour, no re-entry)', () => {
    const ev = build(blogPage([crumb(li(1, 'Home', HOME), li(2, 'Blog', BLOG_CANON))]));
    assert.equal(ev.breadcrumb.hierarchy.status, 'existing');
    assert.equal(ev.breadcrumb.needsInput, false);
  });

  test('F. a valid existing trail that the owner confirmed identically stays "existing" (no duplicate entity is ever generated)', () => {
    const ev = build(blogPage([crumb(li(1, 'Home', HOME), li(2, 'Blog', BLOG_CANON))]), USER);
    assert.equal(ev.breadcrumb.hierarchy.status, 'existing');
  });

  test('G. a valid existing trail that DIFFERS from the owner\'s -> conflict, nothing to generate', () => {
    const ev = build(blogPage([crumb(li(1, 'Home', HOME), li(2, 'News', `${ORIGIN}/news/`), li(3, 'Blog', BLOG_CANON))]), USER);
    assert.equal(ev.breadcrumb.hierarchy.status, 'conflict');
    assert.deepEqual(ev.breadcrumb.hierarchy.items, []);
    assert.equal(ev.breadcrumb.conflict.kind, 'existing_valid_differs');
    assert.equal(ev.breadcrumb.conflict.existingItems.length, 3);
  });

  test('G. an INVALID BreadcrumbList already on the page + owner trail -> conflict (a second entity would duplicate it)', () => {
    const ev = build(blogPage([crumb(li(1, 'Home', HOME), li(5, 'Blog', BLOG_CANON))]), USER);
    assert.equal(ev.breadcrumb.hierarchy.status, 'conflict');
    assert.equal(ev.breadcrumb.conflict.kind, 'existing_invalid');
    assert.ok(ev.breadcrumb.conflict.existingProblems.includes('position_not_sequential'));
  });

  test('an invalid existing trail and nothing supplied stays "unknown"', () => {
    assert.equal(build(blogPage([crumb(li(1, 'Home', HOME), li(5, 'Blog', BLOG_CANON))])).breadcrumb.hierarchy.status, 'unknown');
  });

  test('a saved hierarchy whose last item is no longer the page\'s canonical is STALE and is not used', () => {
    const ev = build(blogPage([], { canonical: `${ORIGIN}/journal/` }), USER);
    assert.equal(ev.breadcrumb.hierarchy.status, 'unknown');
    assert.equal(ev.breadcrumb.userProvided.stale, true);
  });

  test('a trailing-slash difference alone does not make saved evidence stale', () => {
    const ev = build(blogPage([], { canonical: BLOG_KEY }), USER);
    assert.equal(ev.breadcrumb.hierarchy.status, 'user_provided');
  });

  test('Array-typed and @graph markup around the trail does not hide an existing BreadcrumbList', () => {
    const sd = [{ '@context': 'https://schema.org', '@graph': [...graphWithOrganization()[0]['@graph'], { '@type': ['BreadcrumbList'], itemListElement: [li(1, 'Home', HOME), li(2, 'Blog', BLOG_CANON)] }] }];
    assert.equal(build(blogPage(sd)).breadcrumb.hierarchy.status, 'existing');
    assert.equal(build(blogPage(sd), { ...USER, items: [{ position: 1, name: 'X', url: HOME }, { position: 2, name: 'Y', url: `${ORIGIN}/else/` }, { position: 3, name: 'Blog', url: BLOG_CANON }] }).breadcrumb.hierarchy.status, 'conflict');
  });

  test('the fingerprint changes with the owner\'s evidence, its states and any rename; it is stable otherwise', () => {
    const none = build(blogPage()).fingerprintKey;
    const withUser = build(blogPage(), USER).fingerprintKey;
    const renamed = build(blogPage(), { ...USER, evidenceHash: 'h2', items: [{ position: 1, name: 'Start', url: HOME }, USER.items[1]] }).fingerprintKey;
    assert.notEqual(none, withUser);
    assert.notEqual(withUser, renamed);
    assert.equal(withUser, build(blogPage(), USER).fingerprintKey);
  });

  test('the UI summary carries the state, the canonical to match and the saved trail — and no raw schema nodes', () => {
    const s = summarizeSchemaEvidence(build(blogPage(), USER));
    assert.equal(s.breadcrumb.status, 'user_provided');
    assert.deepEqual(s.url, { display: BLOG_CANON, trusted: true, source: 'canonical_tag', crawlKey: BLOG_KEY });
    assert.equal(s.breadcrumb.userProvided.items.length, 2);
    assert.ok(!JSON.stringify(s).includes('"node"'));
    assert.equal(summarizeSchemaEvidence(null), null);
    assert.equal(summarizeSchemaEvidence(buildSchemaEvidence({ issueId: 'organization_schema', pageUrl: BLOG_KEY, pageData: blogPage() })).breadcrumb, null);
  });
});

describe('guard, prompt and verification understand the owner-confirmed trail', () => {
  const ev = build(blogPage(), USER);

  test('the guard keeps the confirmed items (and only those)', () => {
    const generated = generateBreadcrumbListJsonLd(USER.items.map((i) => ({ ...i })));
    assert.deepEqual(sanitizeGeneratedSchema(generated, ev).schema, generated);
    const withExtra = { ...generated, itemListElement: [generated.itemListElement[0], li(2, 'Invented', `${ORIGIN}/invented/`), { ...generated.itemListElement[1], position: 3 }] };
    const { schema, removed } = sanitizeGeneratedSchema(withExtra, ev);
    assert.deepEqual(schema.itemListElement.map((i) => i.item), [HOME, BLOG_CANON]);
    assert.ok(removed.some((r) => /Invented/.test(r.reason)));
  });

  test('in a conflict the guard drops any generated BreadcrumbList', () => {
    const conflict = build(blogPage([crumb(li(1, 'Home', HOME), li(2, 'News', `${ORIGIN}/news/`), li(3, 'Blog', BLOG_CANON))]), USER);
    assert.equal(sanitizeGeneratedSchema(generateBreadcrumbListJsonLd(USER.items), conflict).schema, null);
  });

  test('script-wrapped output stays script-safe after the guard re-serialises it', () => {
    const evil = { ...USER, items: [{ position: 1, name: '</script><b>x</b>', url: HOME }, USER.items[1]] };
    const e = build(blogPage(), evil);
    const code = `<script type="application/ld+json">\n${serializeJsonLdForScript(generateBreadcrumbListJsonLd(evil.items))}\n</script>`;
    const { sections } = applyGuardToSections({ whyThisMatters: 'w', recommendedFix: 'f', implementationExample: { content: code }, recommendedVersion: 'enabled' }, e);
    const inner = sections.implementationExample.content.replace(/^<script[^>]*>\n/, '').replace(/\n<\/script>$/, '');
    assert.ok(!/<|>/.test(inner));
    assert.equal(JSON.parse(inner).itemListElement[0].name, '</script><b>x</b>');
  });

  test('the prompt renderer labels the trail as owner-confirmed', () => {
    assert.match(renderSchemaEvidence(ev), /confirmed by the site owner/);
  });

  describe('deployed-markup verification against the INTENDED hierarchy', () => {
    const deployed = (items) => blogPage([crumb(...items)]);
    const run = (items, intended = USER.items) => verifySchemaFix({ issueKey: 'breadcrumblist_schema', pageDoc: deployed(items), implementedAt: new Date('2026-10-01T00:00:00Z'), intendedBreadcrumb: intended, verifyImages: async () => [] });

    test('the deployed trail equals the confirmed one -> verified', async () => {
      assert.equal((await run([li(1, 'Home', HOME), li(2, 'Blog', BLOG_CANON)])).status, 'verified');
    });

    test('equal apart from a trailing slash and the names -> verified (URLs decide)', async () => {
      assert.equal((await run([li(1, 'Start', `${ORIGIN}`), li(2, 'Our blog', BLOG_KEY)])).status, 'verified');
    });

    test('a VALID trail that is not the confirmed one -> failed, with expected vs found in the reason', async () => {
      const r = await run([li(1, 'Home', HOME), li(2, 'News', `${ORIGIN}/news/`), li(3, 'Blog', BLOG_CANON)]);
      assert.equal(r.status, 'failed');
      assert.match(r.reasons.join(' '), /differs from the hierarchy you confirmed/);
      assert.match(r.reasons.join(' '), /Expected:.*\/blog\//);
    });

    test('a final item without its own URL stands for the page itself', async () => {
      assert.equal((await run([li(1, 'Home', HOME), { '@type': 'ListItem', position: 2, name: 'Blog' }])).status, 'verified');
    });

    test('with no confirmed hierarchy the existing structural checks apply, unchanged', async () => {
      assert.equal((await run([li(1, 'Home', HOME), li(2, 'News', `${ORIGIN}/news/`), li(3, 'Blog', BLOG_CANON)], null)).status, 'verified');
    });

    test('nothing deployed / not recrawled -> never verified', async () => {
      assert.equal((await verifySchemaFix({ issueKey: 'breadcrumblist_schema', pageDoc: blogPage(), implementedAt: new Date('2026-10-01'), intendedBreadcrumb: USER.items, verifyImages: async () => [] })).status, 'failed');
      assert.equal((await verifySchemaFix({ issueKey: 'breadcrumblist_schema', pageDoc: blogPage([crumb(li(1, 'Home', HOME), li(2, 'Blog', BLOG_CANON))], { scraped_at: '2026-09-01T00:00:00Z' }), implementedAt: new Date('2026-10-01'), intendedBreadcrumb: USER.items, verifyImages: async () => [] })).status, 'unverifiable');
      assert.equal((await verifySchemaFix({ issueKey: 'breadcrumblist_schema', pageDoc: null, intendedBreadcrumb: USER.items })).status, 'unverifiable');
    });
  });
});
