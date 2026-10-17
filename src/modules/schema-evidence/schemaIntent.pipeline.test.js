import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { verifySchemaFix } from './schemaVerification.js';
import { applyImageProbes, buildSchemaEvidence } from './schemaEvidence.js';
import { analyzeSiteEntity } from './siteEntity.js';
import { loadIntendedOrganization } from './organizationIntentStore.js';
import { resolveObjective } from '../recommendations/context/ObjectiveStrategyMap.js';
import promptBuilder from '../recommendations/prompts/PromptBuilder.js';
import { HOME, ORG_ID, ORIGIN, REAL_LOGO, probeOk } from './__fixtures__/clinicSite.js';
import { hospitalGraph, hospitalSitePages, page } from './__fixtures__/hospitalSite.js';

const AFTER = new Date('2026-10-02T10:00:00Z').toISOString();
const IMPL = new Date('2026-10-01T10:00:00Z');
const logoOk = async (urls) => urls.map((u) => probeOk(u));
const doc = (path, structured_data, extra = {}) => ({ ...page(path, structured_data), scraped_at: AFTER, ...extra });
const site = () => analyzeSiteEntity(hospitalSitePages());
const verify = (issueKey, pageDoc, extra = {}) => verifySchemaFix({ issueKey, pageDoc, implementedAt: IMPL, verifyImages: logoOk, ...extra });

describe('verification stays inspection-based and is intent-aware', () => {
  test('a Hospital was recommended and a Hospital is deployed -> verified', async () => {
    const r = await verify('organization_schema', doc('/', hospitalGraph()), { intendedOrganization: { type: 'Hospital', action: 'generate' } });
    assert.equal(r.status, 'verified', r.reasons.join(' | '));
    assert.ok(r.checks.some((c) => c.id === 'organization_type' && c.ok));
  });

  test('REGRESSION: a Hospital was recommended but only a generic Organization is deployed -> failed (the issue disappearing is not proof)', async () => {
    const generic = [{ '@type': 'Organization', '@id': ORG_ID, name: 'Clinic Eye Centre', url: HOME }];
    const r = await verify('organization_schema', doc('/', generic), { intendedOrganization: { type: 'Hospital', action: 'generate' } });
    assert.equal(r.status, 'failed');
    assert.match(r.reasons.join(' '), /typed Organization but the recommendation was Hospital/);
  });

  test('a LocalBusiness was recommended and a more specific Hospital is deployed -> verified (a subtype satisfies it)', async () => {
    const r = await verify('organization_schema', doc('/', hospitalGraph()), { intendedOrganization: { type: 'LocalBusiness', action: 'generate' } });
    assert.equal(r.status, 'verified');
  });

  test('a reuse/reference recommendation adds no type requirement; without an intent the Phase 1 behavior is unchanged', async () => {
    assert.equal((await verify('organization_schema', doc('/', hospitalGraph()), { intendedOrganization: { type: 'Organization', action: 'reuse' } })).status, 'verified');
    assert.equal((await verify('organization_schema', doc('/', hospitalGraph()))).status, 'verified');
  });

  test('a page that needs no standalone entity is satisfied by the site entity — only when the site is known', async () => {
    const gallery = doc('/gallery', [{ '@type': 'Optometric' }], { page_type: { name: 'generic' } });
    const withSite = await verify('organization_schema', gallery, { site: site() });
    assert.equal(withSite.status, 'verified', withSite.reasons.join(' | '));
    assert.ok(withSite.checks.some((c) => c.id === 'organization_site_level'));
    const unknownSite = await verify('organization_schema', gallery);
    assert.equal(unknownSite.status, 'failed', 'Phase 1 behavior without site data: no entity on the page is still a failure');
  });

  test('the homepage (an entity page) still must carry the entity even when other pages do', async () => {
    const r = await verify('organization_schema', doc('/', []), { site: site() });
    assert.equal(r.status, 'failed');
  });

  test('not yet re-crawled -> pending (unverifiable), never success', async () => {
    const r = await verifySchemaFix({ issueKey: 'organization_schema', pageDoc: { ...doc('/', hospitalGraph()), scraped_at: new Date('2026-09-01').toISOString() }, implementedAt: IMPL, verifyImages: logoOk, intendedOrganization: { type: 'Hospital', action: 'generate' } });
    assert.equal(r.status, 'unverifiable');
  });

  test('loadIntendedOrganization reads only a stored schema intent; anything else is null; failures never throw', async () => {
    const found = { findOne: () => ({ sort: () => ({ select: () => ({ lean: async () => ({ sections: { sourceAttribution: { contextSources: { schemaType: 'Hospital', schemaAction: 'generate', schemaIntent: 'hospital_schema', schemaTypes: ['Hospital', 'Organization'] } } } }) }) }) }) };
    assert.deepEqual(await loadIntendedOrganization('p', 'organization_schema', HOME, { model: found }), { type: 'Hospital', types: ['Hospital', 'Organization'], action: 'generate', intent: 'hospital_schema' });
    const legacy = { findOne: () => ({ sort: () => ({ select: () => ({ lean: async () => ({ sections: { sourceAttribution: { contextSources: {} } } }) }) }) }) };
    assert.equal(await loadIntendedOrganization('p', 'organization_schema', HOME, { model: legacy }), null);
    assert.equal(await loadIntendedOrganization('p', 'organization_schema', HOME, { model: { findOne: () => { throw new Error('x'); } } }), null);
    assert.equal(await loadIntendedOrganization(null, 'organization_schema', HOME), null);
  });
});

const evidenceFor = (path, pageType, siteData, structured_data = []) => {
  const pageData = page(path, structured_data, { meta_tags: { 'og:site_name': ['Clinic Eye Centre'] } });
  return applyImageProbes(buildSchemaEvidence({ issueId: 'organization_schema', pageUrl: pageData.url, pageData, pageType, site: siteData }), []);
};

describe('the intent reaches the objective and the prompt', () => {
  test('objective: the target type comes from the intent, not a constant "Organization"', () => {
    const ev = evidenceFor('/', 'homepage', analyzeSiteEntity(hospitalSitePages().slice(1)));
    const obj = resolveObjective('organization_schema', {}, {}, { schemaEvidence: ev });
    assert.match(obj.target, /Hospital/);
    assert.doesNotMatch(obj.target, /^Organization schema/);
    assert.match(obj.constraint, /valid Hospital JSON-LD/);
    assert.match(obj.constraint, /verified address/);
    assert.match(obj.preserveContext, new RegExp(`reuse @id ${ORG_ID.replace(/[/.]/g, '\\$&')}`));
  });

  test('objective: a plain Organization intent, a reference intent and a missing-fact intent each get their own wording; no intent keeps the original', () => {
    const org = resolveObjective('organization_schema', {}, {}, { schemaEvidence: evidenceFor('/', 'homepage', analyzeSiteEntity([])) });
    assert.equal(org.target, 'Organization schema');
    const ref = resolveObjective('organization_schema', {}, {}, { schemaEvidence: evidenceFor('/gallery', 'generic', analyzeSiteEntity(hospitalSitePages())) });
    assert.match(ref.constraint, /do NOT generate a new entity/);
    const ask = resolveObjective('organization_schema', {}, {}, { schemaEvidence: evidenceFor('/contact', 'contact', analyzeSiteEntity([])) });
    assert.match(ask.constraint, /no JSON-LD until the owner supplies: Street address/);
    const none = resolveObjective('organization_schema', {}, {}, {});
    assert.match(none.constraint, /valid Organization JSON-LD with name and url/);
    for (const id of ['primary_organization_schema', 'aiso-a1', 'geo-s5']) assert.ok(resolveObjective(id, {}, {}, { schemaEvidence: evidenceFor('/', 'homepage', analyzeSiteEntity([])) }).target);
  });

  test('prompt: the evidence block states the decided type, the reasons and the fact sources; blocked intents forbid JSON-LD', () => {
    const rc = (ev) => ({
      identity: { issueId: 'AISO-A1', issueType: 'ai_visibility', category: 'Schema', severity: 'high', displayType: 'code', pipeline: 'ai' },
      currentState: { displayType: 'code', isAbsent: true, codeContent: null, checkedFor: 'x', measurement: {}, tableRows: [], listItems: [], summary: 's' },
      expectedState: { description: 'd', measurement: {} },
      pageContext: { pageUrl: HOME, pageType: 'Home', framework: 'unknown', cms: null, canonicalUrl: null },
      contentContext: null, technicalContext: null, aiVisibilityContext: null, missingElementContext: null, schemaEvidence: ev,
      recommendationObjective: { action: 'add', target: 'schema', constraint: 'c', preserveContext: 'p', successCriteria: 's', promptMode: 'element_add', promptGroup: 4 },
    });
    const text = (ev) => { const b = promptBuilder.build(rc(ev), {}); return typeof b === 'string' ? b : b.prompt; };
    const hospital = text(evidenceFor('/', 'homepage', analyzeSiteEntity(hospitalSitePages().slice(1))));
    assert.match(hospital, /SCHEMA INTENT: hospital_schema - publish @type \["Hospital","Organization"\]/);
    assert.match(hospital, /never downgrade a specific type/);
    assert.match(hospital, /Fact sources:/);
    assert.match(text(evidenceFor('/contact', 'contact', analyzeSiteEntity([]))), /BLOCKED: do NOT output JSON-LD\. Ask the owner for: Street address of the location/);
    assert.match(text(evidenceFor('/gallery', 'generic', analyzeSiteEntity(hospitalSitePages()))), /do NOT output a new Organization\/LocalBusiness block/);
  });
});
