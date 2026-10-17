import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import schemaResolver from './SchemaResolver.js';
import { graphWithOrganization, organization, ABOUT_CRAWL_KEY, ORG_ID, REAL_LOGO } from '../../schema-evidence/__fixtures__/clinicSite.js';

/**
 * REGRESSION: SchemaResolver compared `@type` to a string, so an entity typed
 * ["Hospital","Organization"] (or any subtype, or one inside @graph) was reported as "absent" and
 * the generator "fixed" it by producing a second Organization — with an invented logo URL.
 */
const resolve = (issueId, structured, pageUrl = ABOUT_CRAWL_KEY, extra = {}) => schemaResolver.resolve(issueId, 'code', {
  pageData: { url: pageUrl, structured_data: structured, ...extra }, issuesByCode: {}, issuesByRuleId: {}, visibilityData: {},
});

describe('SchemaResolver — organization_schema / primary_organization_schema', () => {
  for (const issueId of ['organization_schema', 'primary_organization_schema']) {
    test(`${issueId}: ["Hospital","Organization"] in @graph is PRESENT and shown as the current schema`, () => {
      const { currentState } = resolve(issueId, graphWithOrganization());
      assert.equal(currentState.isAbsent, false);
      const shown = JSON.parse(currentState.rawValue);
      assert.equal(shown['@id'], ORG_ID);
      assert.deepEqual(shown['@type'], ['Hospital', 'Organization']);
      assert.equal(shown.logo.url, REAL_LOGO);
    });
  }

  test('a bare subtype, a root object and an array are all found', () => {
    for (const structured of [[organization({ '@type': 'Hospital' })], organization(), [[organization()]]]) {
      assert.equal(resolve('organization_schema', structured).currentState.isAbsent, false);
    }
  });

  test('the SITE\'s organization is shown, not an unrelated one that happens to come first', () => {
    const partner = organization({ '@id': 'https://partner.example/#org', url: 'https://partner.example/', name: 'Partner Inc' });
    const shown = JSON.parse(resolve('organization_schema', [partner, organization()]).currentState.rawValue);
    assert.equal(shown.name, 'Clinic Eye Centre');
  });

  test('only a foreign organization, or no organization at all, is genuinely absent', () => {
    const partner = organization({ '@id': 'https://partner.example/#org', url: 'https://partner.example/' });
    assert.equal(resolve('organization_schema', [partner]).currentState.isAbsent, true);
    assert.equal(resolve('organization_schema', [{ '@type': 'WebSite', name: 'W' }, { '@type': 'Person', name: 'P' }]).currentState.isAbsent, true);
    assert.equal(resolve('organization_schema', []).currentState.isAbsent, true);
    assert.equal(resolve('organization_schema', undefined).currentState.isAbsent, true);
  });

  test('sameas_array reads the same primary entity', () => {
    const present = resolve('sameas_array', graphWithOrganization({ sameAs: ['https://facebook.com/c'] }));
    assert.equal(present.currentState.isAbsent, false);
    assert.ok(!present.currentState.rawValue.includes('(missing)'));
    const missing = resolve('sameas_array', graphWithOrganization());
    assert.match(missing.currentState.rawValue, /"sameAs": "\(missing\)"/);
  });
});

describe('SchemaResolver — other schema lookups understand arrays, @graph and subtypes', () => {
  test('article_schema finds BlogPosting / NewsArticle / array-typed articles inside @graph', () => {
    for (const type of ['BlogPosting', 'NewsArticle', ['Article', 'BlogPosting'], 'TechArticle']) {
      const r = resolve('article_schema', [{ '@context': 'https://schema.org', '@graph': [{ '@type': type, headline: 'H' }] }]);
      assert.equal(r.currentState.isAbsent, false, JSON.stringify(type));
    }
    assert.equal(resolve('article_schema', [{ '@type': 'WebPage' }]).currentState.isAbsent, true);
  });

  test('breadcrumblist_schema finds a BreadcrumbList inside @graph', () => {
    const r = resolve('breadcrumblist_schema', [{ '@graph': [{ '@type': 'WebPage' }, { '@type': 'BreadcrumbList', itemListElement: [] }] }]);
    assert.equal(r.currentState.isAbsent, false);
  });

  test('logo_url_returns_200 shows the broken URL the rule recorded as its detected value', () => {
    const r = schemaResolver.resolve('logo_url_returns_200', 'text', {
      pageData: { structured_data: [] },
      issuesByCode: { logo_url_returns_200: { detected_value: 'https://clinic.example/wp-content/uploads/logo.png' } },
      issuesByRuleId: {}, visibilityData: {},
    });
    assert.equal(r.currentState.rawText ?? r.currentState.rawValue, 'https://clinic.example/wp-content/uploads/logo.png');
  });
});
