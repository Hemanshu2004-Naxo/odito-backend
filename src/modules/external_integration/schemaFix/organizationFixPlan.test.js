import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { planOrganizationFix } from './organizationFixPlan.js';
import { applyImageProbes, buildSchemaEvidence } from '../../schema-evidence/schemaEvidence.js';
import { analyzeSiteEntity } from '../../schema-evidence/siteEntity.js';
import { normalizeBusinessProfile } from '../../schema-evidence/businessProfileFacts.js';
import { HOME, ORG_ID, ORIGIN, REAL_LOGO, probeOk } from '../../schema-evidence/__fixtures__/clinicSite.js';
import { hospitalSitePages, page } from '../../schema-evidence/__fixtures__/hospitalSite.js';

const noHome = () => hospitalSitePages().filter((p) => p.url !== `${ORIGIN}/`);
const gbp = (over = {}) => normalizeBusinessProfile({ business_name: 'Clinic Eye Centre', category: 'Hospital', phone: '+91 11 4000 0000', website: `${ORIGIN}/`, address: '2-A Trust House, Parel, Mumbai', business_status: 'OPEN', ...over }, { siteUrl: ORIGIN });

function evidenceFor(path, { pageType = 'homepage', structured_data = [], pages = [], profile = null, probes = [], images = [] } = {}) {
  const pd = page(path, structured_data, { meta_tags: { 'og:site_name': ['Clinic Eye Centre'] }, images });
  return applyImageProbes(buildSchemaEvidence({ issueId: 'organization_schema', pageUrl: pd.url, pageData: pd, pageType, site: analyzeSiteEntity(pages), profile }), probes);
}
const live = (over = {}) => ({ name: '', description: '', url: '', logo: '', type: '', kind: 'company', hasAddress: false, localSeoActive: true, ...over });
const logoImages = [{ src: REAL_LOGO, alt: 'Clinic logo' }];
const fields = (plan) => plan.changes.map((c) => `${c.field}:${c.kind}`);

describe('planOrganizationFix — only verified, minimal, non-destructive changes', () => {
  test('a plain Organization: sets the verified name and the verified logo on an empty Rank Math config; nothing else', () => {
    const ev = evidenceFor('/', { images: logoImages, probes: [probeOk(REAL_LOGO)] });
    const plan = planOrganizationFix({ evidence: ev, site: live(), provider: 'rank_math' });
    assert.equal(plan.status, 'ready');
    assert.deepEqual(fields(plan), ['name:set', 'logo:set']);
    assert.equal(plan.changes[0].after, 'Clinic Eye Centre');
    assert.equal(plan.changes[1].after, REAL_LOGO);
    assert.equal(plan.changes[0].rankMathOption, 'rank-math-options-titles.knowledgegraph_name');
    assert.equal(plan.fingerprint.length, 64);
  });

  test('an UNVERIFIED logo is never proposed', () => {
    const ev = evidenceFor('/', { images: logoImages, probes: [] });
    assert.deepEqual(fields(planOrganizationFix({ evidence: ev, site: live({ name: 'Clinic Eye Centre' }), provider: 'rank_math' })), []);
  });

  test('existing non-empty values are PRESERVED and reported, never overwritten', () => {
    const ev = evidenceFor('/', { images: logoImages, probes: [probeOk(REAL_LOGO)] });
    const plan = planOrganizationFix({ evidence: ev, site: live({ name: 'Old Name', logo: 'https://clinic.example/other.png' }), provider: 'rank_math' });
    assert.deepEqual(plan.changes, []);
    assert.deepEqual(plan.preserved.map((p) => p.field).sort(), ['logo', 'name']);
    assert.equal(plan.status, 'nothing_to_change');
  });

  test('a logo that is PROVEN broken may be replaced by the verified one', () => {
    const broken = 'https://clinic.example/wp-content/uploads/logo.png';
    const ev = evidenceFor('/', {
      structured_data: [{ '@type': 'Organization', '@id': `${HOME}#organization`, name: 'Clinic Eye Centre', url: HOME, logo: broken }],
      images: logoImages, probes: [probeOk(REAL_LOGO), { url: broken, ok: false, status: 'http_error', http_status: 404, conclusive: true, reason: 'HTTP 404' }],
    });
    assert.equal(ev.organization.logo.status, 'replaces_broken_existing');
    const plan = planOrganizationFix({ evidence: ev, site: live({ name: 'Clinic Eye Centre', logo: broken }), provider: 'rank_math' });
    assert.deepEqual(fields(plan), ['logo:replace']);
  });
});

describe('planOrganizationFix — the entity TYPE (LocalBusiness / Hospital)', () => {
  const hospitalEv = () => evidenceFor('/', { pages: noHome() });

  test('Hospital intent + a configured address -> upgrade the business type, never anything unproven', () => {
    const plan = planOrganizationFix({ evidence: hospitalEv(), site: live({ name: 'Clinic Eye Centre', hasAddress: true }), provider: 'rank_math' });
    assert.equal(plan.status, 'ready');
    assert.deepEqual(fields(plan), ['type:upgrade']);
    assert.equal(plan.changes[0].after, 'Hospital');
  });

  test('Hospital intent WITHOUT an address in Rank Math is BLOCKED — a physical type is never published without one', () => {
    const plan = planOrganizationFix({ evidence: hospitalEv(), site: live({ name: 'Clinic Eye Centre', hasAddress: false }), provider: 'rank_math' });
    assert.equal(plan.status, 'blocked');
    assert.equal(plan.code, 'ADDRESS_REQUIRED');
    assert.deepEqual(plan.changes, []);
  });

  test("Hospital intent while Rank Math's Local SEO module is OFF is BLOCKED — the type would be stored but never published", () => {
    const plan = planOrganizationFix({ evidence: hospitalEv(), site: live({ name: 'Clinic Eye Centre', hasAddress: true, localSeoActive: false }), provider: 'rank_math' });
    assert.equal(plan.status, 'blocked');
    assert.equal(plan.code, 'LOCAL_SEO_REQUIRED');
    assert.match(plan.message, /Local SEO module/);
    assert.deepEqual(plan.changes, []);
  });

  test('never downgrades or replaces a specific type: Hospital already set -> no change; an unrelated specific type is kept', () => {
    const same = planOrganizationFix({ evidence: hospitalEv(), site: live({ name: 'Clinic Eye Centre', type: 'Hospital', hasAddress: true }), provider: 'rank_math' });
    assert.equal(same.status, 'nothing_to_change');
    const unrelated = planOrganizationFix({ evidence: hospitalEv(), site: live({ name: 'Clinic Eye Centre', type: 'Dentist', hasAddress: true }), provider: 'rank_math' });
    assert.deepEqual(unrelated.changes, []);
    assert.equal(unrelated.preserved[0].field, 'type');
    assert.match(unrelated.preserved[0].reason, /does not replace a specific type/);
  });

  test('a more specific type than the one Rank Math holds (LocalBusiness -> Hospital) is an allowed refinement', () => {
    const plan = planOrganizationFix({ evidence: hospitalEv(), site: live({ name: 'Clinic Eye Centre', type: 'LocalBusiness', hasAddress: true }), provider: 'rank_math' });
    assert.deepEqual(fields(plan), ['type:set']);
  });

  test('a verified Business Profile for THIS site can drive the type; one for another website cannot', () => {
    const trusted = evidenceFor('/', { profile: gbp() });
    assert.deepEqual(fields(planOrganizationFix({ evidence: trusted, site: live({ name: 'Clinic Eye Centre', hasAddress: true }), provider: 'rank_math' })), ['type:upgrade']);
    const other = evidenceFor('/', { profile: gbp({ website: 'https://asg-other.example/' }) });
    const plan = planOrganizationFix({ evidence: other, site: live({ name: 'Clinic Eye Centre', hasAddress: true }), provider: 'rank_math' });
    assert.deepEqual(plan.changes, []);
  });

  test('facts Odito does not write yet are listed, not silently dropped', () => {
    const plan = planOrganizationFix({ evidence: hospitalEv(), site: live({ name: 'Clinic Eye Centre', hasAddress: true }), provider: 'rank_math' });
    assert.ok(plan.notWritten.some((n) => n.field === 'telephone'));
  });
});

describe('planOrganizationFix — refusing when the fix would be wrong or unsafe', () => {
  const ev = () => evidenceFor('/', {});

  test('only Rank Math is a supported source', () => {
    for (const provider of ['yoast', 'aioseo', 'seopress', 'none']) {
      const plan = planOrganizationFix({ evidence: ev(), site: live(), provider });
      assert.equal(plan.status, 'unsupported', provider);
      assert.equal(plan.code, 'PROVIDER_NOT_SUPPORTED');
    }
  });

  test('a site configured as a PERSON publishes no Organization: unsupported with the reason; an unknown kind is not guessed', () => {
    assert.equal(planOrganizationFix({ evidence: ev(), site: live({ kind: 'person' }), provider: 'rank_math' }).code, 'SITE_IS_PERSON');
    assert.equal(planOrganizationFix({ evidence: ev(), site: live({ kind: '' }), provider: 'rank_math' }).status, 'unsupported');
  });

  test('an entity published by a theme/other plugin (@id not Rank Math\'s) is never duplicated', () => {
    const themeEntity = [{ '@type': 'Organization', '@id': `${ORIGIN}/#theme-org`, name: 'Clinic', url: HOME }];
    const e = evidenceFor('/', { structured_data: themeEntity, pages: [page('/', themeEntity)] });
    const plan = planOrganizationFix({ evidence: e, site: live(), provider: 'rank_math' });
    assert.equal(plan.status, 'unsupported');
    assert.equal(plan.code, 'ORGANIZATION_SOURCE_UNKNOWN');
    assert.deepEqual(plan.changes, []);
  });

  test('an entity WITHOUT an @id is not Rank Math\'s either', () => {
    const e = evidenceFor('/', { structured_data: [{ '@type': 'Organization', name: 'Clinic', url: HOME }] });
    assert.equal(planOrganizationFix({ evidence: e, site: live(), provider: 'rank_math' }).code, 'ORGANIZATION_SOURCE_UNKNOWN');
  });

  test('Rank Math\'s own entity (@id <home>#organization) is fine and is the one that gets updated', () => {
    const own = [{ '@type': 'Organization', '@id': `${HOME}#organization`, name: 'Clinic Eye Centre', url: HOME }];
    const e = evidenceFor('/', { structured_data: own, pages: [page('/', own)], images: logoImages, probes: [probeOk(REAL_LOGO)] });
    const plan = planOrganizationFix({ evidence: e, site: live({ name: 'Clinic Eye Centre' }), provider: 'rank_math' });
    assert.equal(plan.status, 'ready');
    assert.deepEqual(fields(plan), ['logo:set']);
  });

  test('conflicting entity ids on the site are a duplicate problem, not something a setting fixes', () => {
    const a = [{ '@type': 'Organization', '@id': `${HOME}#organization`, name: 'C', url: HOME }];
    const b = [{ '@type': 'Organization', '@id': `${ORIGIN}/#other`, name: 'C', url: HOME }];
    const e = evidenceFor('/', { structured_data: a, pages: [page('/', a), page('/about', b)] });
    assert.equal(planOrganizationFix({ evidence: e, site: live(), provider: 'rank_math' }).code, 'DUPLICATE_ENTITIES');
  });

  test('a missing fact (needs_input) and a page that needs no entity produce NO changes', () => {
    const contact = evidenceFor('/contact', { pageType: 'contact' });
    const p1 = planOrganizationFix({ evidence: contact, site: live(), provider: 'rank_math' });
    assert.equal(p1.status, 'validation_failed');
    assert.equal(p1.code, 'EVIDENCE_INCOMPLETE');
    const gallery = evidenceFor('/gallery', { pageType: 'generic', pages: hospitalSitePages() });
    const p2 = planOrganizationFix({ evidence: gallery, site: live(), provider: 'rank_math' });
    assert.equal(p2.status, 'nothing_to_change');
    assert.equal(p2.code, 'NO_ENTITY_NEEDED');
  });

  test('no intent at all is a validation failure, never a guess', () => {
    assert.equal(planOrganizationFix({ evidence: { organization: {} }, site: live(), provider: 'rank_math' }).status, 'validation_failed');
    assert.equal(planOrganizationFix({ evidence: null, site: live(), provider: 'rank_math' }).status, 'validation_failed');
  });
});

describe('planOrganizationFix — the fingerprint', () => {
  const ev = () => evidenceFor('/', { images: logoImages, probes: [probeOk(REAL_LOGO)] });

  test('stable for identical inputs; changes when the live Rank Math state, the evidence or the verified logo changes', () => {
    const a = planOrganizationFix({ evidence: ev(), site: live(), provider: 'rank_math' });
    const b = planOrganizationFix({ evidence: ev(), site: live(), provider: 'rank_math' });
    assert.equal(a.fingerprint, b.fingerprint);
    assert.notEqual(a.fingerprint, planOrganizationFix({ evidence: ev(), site: live({ name: 'Edited by a person' }), provider: 'rank_math' }).fingerprint);
    assert.notEqual(a.fingerprint, planOrganizationFix({ evidence: evidenceFor('/', { images: logoImages, probes: [] }), site: live(), provider: 'rank_math' }).fingerprint);
  });
});
