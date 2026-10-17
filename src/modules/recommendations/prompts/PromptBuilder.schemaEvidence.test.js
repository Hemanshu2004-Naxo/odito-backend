import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import promptBuilder from './PromptBuilder.js';
import { resolveGroup } from './GroupRegistry.js';
import { applyImageProbes, buildSchemaEvidence } from '../../schema-evidence/schemaEvidence.js';
import { ABOUT_CRAWL_KEY, INVENTED_LOGO, REAL_LOGO, aboutPageData, probe404, probeOk } from '../../schema-evidence/__fixtures__/clinicSite.js';

const objective = (over = {}) => ({
  action: 'add', target: 'schema', constraint: 'valid JSON-LD', preserveContext: 'keep existing', successCriteria: 'valid', promptMode: 'element_add', promptGroup: 4, ...over,
});

const rcFor = (issueId, { schemaEvidence = null, isAbsent = false, pageUrl = ABOUT_CRAWL_KEY } = {}) => ({
  identity: { issueId, issueType: 'on_page', category: 'Schema', severity: 'high', displayType: 'code', pipeline: 'on_page' },
  currentState: { displayType: 'code', isAbsent, rawValue: null, codeContent: isAbsent ? null : '{"@type":"Organization","name":"Clinic"}', checkedFor: 'x', measurement: {}, tableRows: [], listItems: [], summary: 's' },
  expectedState: { description: 'd', measurement: {} },
  pageContext: { pageUrl, pageType: 'About', framework: 'unknown', cms: null, canonicalUrl: null },
  contentContext: null, technicalContext: null, aiVisibilityContext: null, missingElementContext: null,
  schemaEvidence,
  recommendationObjective: objective(),
});

const evidence = (issueId, probes = []) => applyImageProbes(
  buildSchemaEvidence({ issueId, pageUrl: ABOUT_CRAWL_KEY, pageData: aboutPageData(), headingsByTag: { h1: ['About Us'] }, pageType: 'about' }), probes);

describe('PromptBuilder — schema evidence', () => {
  test('SMOKE: every prompt group still builds, with and without evidence (a mis-scoped variable here would throw for ALL issues of that group)', () => {
    const ids = ['title_missing', 'meta_description_missing', 'thin_content', 'service_pages_800_words', 'canonical_tag_errors', 'noindex_key_pages',
      'organization_schema', 'breadcrumblist_schema', 'sameas_array', 'faq_schema', 'article_schema', 'images_missing_alt_text', 'keyboard_accessibility',
      'AISO-A1', 'GEO-S5', 'GEO-S2', 'AEO-F1'];
    const groups = new Set();
    for (const id of ids) {
      groups.add(resolveGroup(id));
      for (const schemaEvidence of [null, evidence('organization_schema', [probeOk(REAL_LOGO)])]) {
        for (const isAbsent of [false, true]) {
          const built = promptBuilder.build(rcFor(id, { schemaEvidence, isAbsent }), { title: 't' });
          const text = typeof built === 'string' ? built : built.prompt;
          assert.equal(typeof text, 'string', id);
          assert.ok(text.length > 100, id);
        }
      }
    }
    assert.ok(groups.size >= 6, `only exercised groups ${[...groups]}`);
  });

  test('only schema-emitting prompts carry the evidence block; technical/text prompts never do', () => {
    const ev = evidence('organization_schema', [probeOk(REAL_LOGO)]);
    const build = (id, e) => { const b = promptBuilder.build(rcFor(id, { schemaEvidence: e }), {}); return typeof b === 'string' ? b : b.prompt; };
    assert.match(build('organization_schema', ev), /Logo: VERIFIED/);
    assert.match(build('AISO-A1', ev), /Logo: VERIFIED/);
    assert.match(build('GEO-S5', ev), /Logo: VERIFIED/);
    assert.match(build('breadcrumblist_schema', evidence('breadcrumblist_schema')), /BREADCRUMB:/);
    assert.doesNotMatch(build('canonical_tag_errors', ev), /VERIFIED SCHEMA EVIDENCE/);
    assert.doesNotMatch(build('title_missing', ev), /VERIFIED SCHEMA EVIDENCE/);
    assert.doesNotMatch(build('organization_schema', null), /VERIFIED SCHEMA EVIDENCE \(/);
  });

  test('a 404 logo is forbidden by name and the model is told not to derive anything from title/URL', () => {
    const ev = evidence('organization_schema', [probe404(REAL_LOGO)]);
    const b = promptBuilder.build(rcFor('organization_schema', { schemaEvidence: ev }), {});
    const text = typeof b === 'string' ? b : b.prompt;
    assert.match(text, /Logo: NOT AVAILABLE/);
    assert.doesNotMatch(text, /derive from page URL and page title/);
    assert.doesNotMatch(text, new RegExp(`Logo: VERIFIED`));
    assert.ok(!text.includes(INVENTED_LOGO));
  });

  test('without evidence the schema prompt no longer invites guessing a logo or contact data from the page title', () => {
    const b = promptBuilder.build(rcFor('organization_schema', { schemaEvidence: null }), {});
    const text = typeof b === 'string' ? b : b.prompt;
    assert.match(text, /never a logo, contact detail or profile URL/);
  });

  test('the breadcrumb prompt demands the verified hierarchy or no JSON-LD at all', () => {
    const b = promptBuilder.build(rcFor('breadcrumblist_schema', { schemaEvidence: evidence('breadcrumblist_schema') }), {});
    const text = typeof b === 'string' ? b : b.prompt;
    assert.match(text, /Hierarchy: UNKNOWN/);
    assert.match(text, /do not write JSON-LD at all/);
  });
});
