import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import schemaValidator from './SchemaValidator.js';
import validatorRegistry from './ValidatorRegistry.js';
import { GROUP } from '../prompts/GroupRegistry.js';
import { applyImageProbes, buildSchemaEvidence } from '../../schema-evidence/schemaEvidence.js';
import { HOME, INVENTED_LOGO, ORG_ID, ORIGIN, REAL_LOGO, ABOUT_CANONICAL, ABOUT_CRAWL_KEY, aboutPageData, probe404, probeOk } from '../../schema-evidence/__fixtures__/clinicSite.js';

const sections = (json, over = {}) => ({
  whyThisMatters: 'Because entities matter to AI answers.',
  recommendedFix: '1. Paste the markup.',
  implementationExample: { content: typeof json === 'string' ? json : JSON.stringify(json, null, 2) },
  recommendedVersion: typeof json === 'string' ? json : JSON.stringify(json, null, 2),
  expectedImpact: ['Clearer entity'],
  estimatedRecovery: { aiVisibility: 10, semanticTrust: 10, freshness: 0, accessibility: 0 },
  ...over,
});
const rc = (issueId, extra = {}) => ({ identity: { issueId }, pageContext: { pageUrl: ABOUT_CANONICAL }, ...extra });
const org = (over = {}) => ({ '@type': 'Organization', '@id': `${ORIGIN}/#organization`, name: 'Clinic Eye Centre', url: HOME, ...over });
const evidence = (issueId, probes = []) => applyImageProbes(buildSchemaEvidence({ issueId, pageUrl: ABOUT_CRAWL_KEY, pageData: aboutPageData(), headingsByTag: { h1: ['About Us'] }, pageType: 'about' }), probes);

describe('SchemaValidator — JSON-LD structure (@graph, arrays, inherited @context)', () => {
  test('a graph with @context ONLY on the parent is valid (the first node is not required to repeat it)', () => {
    const r = schemaValidator.validate(sections({ '@context': 'https://schema.org', '@graph': [org(), { '@type': 'WebSite', name: 'W', url: HOME }] }), rc('organization_schema'));
    assert.deepEqual(r.errors, []);
    assert.equal(r.satisfiesConstraint, true);
  });

  test('REGRESSION: the Organization is judged by its own type even when it is not the first graph node', () => {
    const r = schemaValidator.validate(sections({ '@context': 'https://schema.org', '@graph': [{ '@type': 'WebPage', '@id': `${ORIGIN}/#webpage` }, { '@type': 'WebSite', url: HOME, name: 'W' }, org()] }), rc('organization_schema'));
    assert.deepEqual(r.errors, []);
  });

  test('required properties are checked on the target entity: an Organization missing name+url fails even if the first node is complete', () => {
    const r = schemaValidator.validate(sections({ '@context': 'https://schema.org', '@graph': [{ '@type': 'WebSite', name: 'W', url: HOME }, { '@type': 'Organization' }] }), rc('organization_schema'));
    assert.ok(r.errors.some((e) => /Organization: missing required properties — name, url/.test(e)));
  });

  test('no Organization at all in an organization_schema recommendation is an error', () => {
    const r = schemaValidator.validate(sections({ '@context': 'https://schema.org', '@type': 'WebSite', name: 'W', url: HOME }), rc('organization_schema'));
    assert.ok(r.errors.some((e) => /no Organization entity was generated/.test(e)));
  });

  test('a subtype (Hospital, ["Hospital","Organization"]) is accepted as the organization', () => {
    for (const t of ['Hospital', ['Hospital', 'Organization'], 'MedicalClinic']) {
      const r = schemaValidator.validate(sections({ '@context': 'https://schema.org', '@type': t, name: 'Clinic', url: HOME }), rc('organization_schema'));
      assert.deepEqual(r.errors, [], JSON.stringify(t));
    }
  });

  test('an array of JSON-LD documents: each needs its own @context', () => {
    const ok = schemaValidator.validate(sections([{ '@context': 'https://schema.org', ...org() }, { '@context': 'https://schema.org', '@type': 'WebSite', name: 'W', url: HOME }]), rc('organization_schema'));
    assert.deepEqual(ok.errors, []);
    const bad = schemaValidator.validate(sections([{ '@context': 'https://schema.org', ...org() }, { '@type': 'WebSite', name: 'W', url: HOME }]), rc('organization_schema'));
    assert.ok(bad.errors.some((e) => /missing @context/.test(e)));
  });

  test('wrong or missing @context, missing @type, still rejected', () => {
    assert.ok(schemaValidator.validate(sections({ '@context': 'https://example.org/vocab', ...org() }), rc('organization_schema')).errors.some((e) => /@context must be/.test(e)));
    assert.ok(schemaValidator.validate(sections(org()), rc('organization_schema')).errors.some((e) => /missing @context/.test(e)));
    assert.ok(schemaValidator.validate(sections({ '@context': 'https://schema.org', '@graph': [{ name: 'no type' }, org()] }), rc('organization_schema')).errors.some((e) => /missing @type/.test(e)));
  });

  test('@context given as an array or an object with @vocab is understood', () => {
    assert.deepEqual(schemaValidator.validate(sections({ '@context': ['https://schema.org', { x: 'y' }], ...org() }), rc('organization_schema')).errors, []);
    assert.deepEqual(schemaValidator.validate(sections({ '@context': { '@vocab': 'https://schema.org/' }, ...org() }), rc('organization_schema')).errors, []);
  });

  test('malformed JSON-LD is rejected with the JSON error', () => {
    const r = schemaValidator.validate(sections('{"@context":"https://schema.org","@type":"Organization","name":'), rc('organization_schema'));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => /not valid JSON/.test(e)));
  });

  test('multiple graph nodes of different types are each type-checked', () => {
    const r = schemaValidator.validate(sections({ '@context': 'https://schema.org', '@graph': [org(), { '@type': 'FAQPage' }, { '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Home', item: HOME }, { '@type': 'ListItem', position: 2, name: 'About', item: ABOUT_CANONICAL }] }] }), rc('organization_schema'));
    assert.deepEqual(r.errors, []); // only the entity the issue is about is held to its required properties
  });
});

describe('SchemaValidator — URL, @id and duplicate checks', () => {
  const wrap = (node) => ({ '@context': 'https://schema.org', ...node });

  test('invalid logo values are errors (not URLs, relative, wrong protocol)', () => {
    for (const logo of ['not a url', '/logo.png', 'javascript:alert(1)', 'data:image/png;base64,AAAA', { '@type': 'ImageObject', url: 'ftp://x/l.png' }, { '@type': 'ImageObject' }]) {
      const r = schemaValidator.validate(sections(wrap(org({ logo }))), rc('organization_schema'));
      assert.ok(r.errors.some((e) => /logo/.test(e)), JSON.stringify(logo));
    }
  });

  test('a well-formed logo with no evidence available passes with a warning that it is unverified', () => {
    const r = schemaValidator.validate(sections(wrap(org({ logo: REAL_LOGO }))), rc('organization_schema'));
    assert.deepEqual(r.errors, []);
    assert.ok(r.warnings.some((w) => /logo URL was not verified/.test(w)));
  });

  test('invalid sameAs entries and an invalid Organization url are errors', () => {
    const r = schemaValidator.validate(sections(wrap(org({ sameAs: ['https://facebook.com/x', 'javascript:alert(1)', 5], url: 'not-a-url' }))), rc('organization_schema'));
    assert.ok(r.errors.some((e) => /sameAs entry "javascript:alert\(1\)"/.test(e)));
    assert.ok(r.errors.some((e) => /sameAs entry 5/.test(e)));
    assert.ok(r.errors.some((e) => /url "not-a-url" is not a valid/.test(e)));
  });

  test('optional fields may be omitted entirely (a minimal organization is valid)', () => {
    assert.deepEqual(schemaValidator.validate(sections(wrap({ '@type': 'Organization', name: 'Clinic', url: HOME })), rc('organization_schema')).errors, []);
  });

  test('duplicate @id and duplicate Organization entities are errors', () => {
    const dupId = schemaValidator.validate(sections({ '@context': 'https://schema.org', '@graph': [org(), org()] }), rc('organization_schema'));
    assert.ok(dupId.errors.some((e) => /is used by 2 entities/.test(e)));
    assert.ok(dupId.errors.some((e) => /2 Organization entities/.test(e)));
    const two = schemaValidator.validate(sections({ '@context': 'https://schema.org', '@graph': [org(), org({ '@id': `${ORIGIN}/#other`, '@type': 'LocalBusiness', address: 'x' })] }), rc('organization_schema'));
    assert.ok(two.errors.some((e) => /2 Organization entities/.test(e)));
  });

  test('placeholders inside the JSON still fail', () => {
    assert.equal(schemaValidator.validate(sections(wrap(org({ name: '[Business Name]' }))), rc('organization_schema')).satisfiesConstraint, false);
  });

  test('Article: headline+author required, partial is a warning, none is an error', () => {
    const base = { '@context': 'https://schema.org', '@type': 'BlogPosting' };
    assert.ok(schemaValidator.validate(sections({ ...base }), rc('article_schema')).errors.some((e) => /headline, author/.test(e)));
    const partial = schemaValidator.validate(sections({ ...base, headline: 'H' }), rc('article_schema'));
    assert.deepEqual(partial.errors, []);
    assert.ok(partial.warnings.some((w) => /missing required properties — author/.test(w)));
  });
});

describe('SchemaValidator — BreadcrumbList', () => {
  const li = (position, name, item) => ({ '@type': 'ListItem', position, name, item });
  const trail = (items) => ({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: items });
  const run = (items) => schemaValidator.validate(sections(trail(items)), rc('breadcrumblist_schema_full')).errors;

  test('positions, URLs, names and duplicates are validated', () => {
    assert.deepEqual(run([li(1, 'Home', HOME), li(2, 'About', ABOUT_CANONICAL)]), []);
    assert.ok(run([li(1, 'Home', HOME), li(3, 'About', ABOUT_CANONICAL)]).some((e) => /positions must be 1, 2, 3/.test(e)));
    assert.ok(run([li(1, 'Home', '/'), li(2, 'About', ABOUT_CANONICAL)]).some((e) => /relative or not a valid absolute URL/.test(e)));
    assert.ok(run([li(1, '', HOME), li(2, 'About', ABOUT_CANONICAL)]).some((e) => /has no name/.test(e)));
    assert.ok(run([li(1, 'A', ABOUT_CANONICAL), li(2, 'B', ABOUT_CANONICAL)]).some((e) => /same URL/.test(e)));
    assert.ok(run([]).some((e) => /no items/.test(e)));
  });

  test('two BreadcrumbLists in one output are an error', () => {
    const one = trail([li(1, 'Home', HOME), li(2, 'About', ABOUT_CANONICAL)]);
    const r = schemaValidator.validate(sections({ '@context': 'https://schema.org', '@graph': [one, one] }), rc('breadcrumblist_schema_full'));
    assert.ok(r.errors.some((e) => /more than one BreadcrumbList/.test(e)));
  });

  test('the Rank Math toggle value "enabled" is unchanged, and an illustrative trail with unverified parents is flagged', () => {
    const ev = evidence('breadcrumblist_schema');
    const good = schemaValidator.validate(sections('enabled', { implementationExample: { content: '<!-- ODITO: hierarchy could not be verified -->' } }), rc('breadcrumblist_schema', { schemaEvidence: ev }));
    assert.deepEqual(good.errors, []);
    assert.equal(good.satisfiesConstraint, true);
    const bad = schemaValidator.validate(sections('enabled', { implementationExample: { content: JSON.stringify(trail([li(1, 'Home', HOME), li(2, 'Made up', `${ORIGIN}/company/`)])) } }), rc('breadcrumblist_schema', { schemaEvidence: ev }));
    assert.equal(bad.satisfiesConstraint, false);
    assert.ok(bad.errors.some((e) => /hierarchy could not be verified/.test(e)));
  });
});

describe('SchemaValidator — evidence', () => {
  test('REGRESSION: the invented /wp-content/uploads/logo.png fails validation when the site\'s real logo is what was verified', () => {
    const ev = evidence('organization_schema', [probeOk(REAL_LOGO)]);
    const r = schemaValidator.validate(sections({ '@context': 'https://schema.org', ...org({ '@id': ORG_ID, logo: { '@type': 'ImageObject', url: INVENTED_LOGO } }) }), rc('organization_schema', { schemaEvidence: ev }));
    assert.equal(r.satisfiesConstraint, false);
    assert.ok(r.errors.some((e) => /was not verified as a working image/.test(e)));
  });

  test('the verified logo passes', () => {
    const ev = evidence('organization_schema', [probeOk(REAL_LOGO)]);
    // The page's own entity is a Hospital: the schema intent keeps that type (a plain Organization would now fail).
    const r = schemaValidator.validate(sections({ '@context': 'https://schema.org', ...org({ '@id': ORG_ID, '@type': ['Hospital', 'Organization'], logo: REAL_LOGO }) }), rc('organization_schema', { schemaEvidence: ev }));
    assert.deepEqual(r.errors, []);
  });

  test('a logo with the site\'s own URL still fails when verification said it is dead', () => {
    const ev = evidence('organization_schema', [probe404(REAL_LOGO)]);
    const r = schemaValidator.validate(sections({ '@context': 'https://schema.org', ...org({ '@id': ORG_ID, logo: REAL_LOGO }) }), rc('organization_schema', { schemaEvidence: ev }));
    assert.equal(r.satisfiesConstraint, false);
  });

  test('prose-only output (no JSON-LD) for an entity issue is not failed by the evidence check', () => {
    const ev = evidence('organization_schema', []);
    const r = schemaValidator.validateEvidence(sections('Gather your logo URL first.', { implementationExample: { content: 'Gather your logo URL first.' } }), rc('AISO-A1', { schemaEvidence: ev }));
    assert.deepEqual(r, { errors: [], warnings: [] });
  });
});

describe('ValidatorRegistry — schema output is always schema-validated', () => {
  const fabricated = sections({ '@context': 'https://schema.org', ...org({ '@id': ORG_ID, logo: INVENTED_LOGO }) });

  test('REGRESSION: an ABSENT organization schema used to be validated only by the placeholder checker; the fabricated logo now fails', () => {
    const ev = evidence('organization_schema', [probeOk(REAL_LOGO)]);
    const ctx = {
      identity: { issueId: 'organization_schema' },
      currentState: { isAbsent: true }, pageContext: { pageUrl: ABOUT_CANONICAL },
      missingElementContext: { isRich: true, businessName: 'Clinic Eye Centre', primaryTopic: 'About Us' },
      schemaEvidence: ev,
    };
    const r = validatorRegistry.validate(fabricated, ctx, GROUP.SCHEMA);
    assert.equal(r.satisfiesConstraint, false);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => /was not verified as a working image/.test(e)));
  });

  test('an absent schema with malformed JSON-LD is now rejected too', () => {
    const ctx = { identity: { issueId: 'schema_markup' }, currentState: { isAbsent: true }, pageContext: { pageUrl: ABOUT_CANONICAL }, missingElementContext: { isRich: false } };
    const r = validatorRegistry.validate(sections('{"@type": "Organization", "name": "Clinic Eye Centre Hospital Group", '), ctx, GROUP.SCHEMA);
    assert.equal(r.valid, false);
  });

  test('entity / E-E-A-T recommendations for AISO-A1 that carry JSON-LD are checked against the evidence', () => {
    const ev = evidence('AISO-A1', [probeOk(REAL_LOGO)]);
    const ctx = { identity: { issueId: 'AISO-A1' }, currentState: { isAbsent: false }, pageContext: { pageUrl: ABOUT_CANONICAL }, schemaEvidence: ev };
    const r = validatorRegistry.validate(fabricated, ctx, GROUP.ENTITY_EEAT);
    assert.equal(r.satisfiesConstraint, false);
    assert.ok(r.errors.some((e) => /was not verified/.test(e)));
  });

  test('non-schema groups without evidence behave exactly as before', () => {
    const r = validatorRegistry.validate(sections('A good title'), { identity: { issueId: 'title_missing' }, currentState: { isAbsent: false } }, GROUP.TEXT_OPTIMIZATION);
    assert.ok(Array.isArray(r.errors));
  });
});
