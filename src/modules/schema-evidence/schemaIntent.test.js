import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { applyImageProbes, buildSchemaEvidence, summarizeSchemaEvidence } from './schemaEvidence.js';
import { analyzeSiteEntity } from './siteEntity.js';
import { normalizeBusinessProfile } from './businessProfileFacts.js';
import { INTENTS, resolveSchemaIntent, specificTypeOf } from './schemaIntent.js';
import { HOME, ORG_ID, ORIGIN, REAL_LOGO, probeOk } from './__fixtures__/clinicSite.js';
import { ADDRESS, hospitalSitePages, page } from './__fixtures__/hospitalSite.js';

const site = (pages = hospitalSitePages()) => analyzeSiteEntity(pages);
const gbp = (over = {}) => normalizeBusinessProfile({
  business_name: 'Clinic Eye Centre', category: 'Hospital', phone: '+91 11 4000 0000', website: `${ORIGIN}/`, address: '2-A Trust House, Parel, Mumbai', business_status: 'OPEN', ...over,
}, { siteUrl: ORIGIN });

/** Evidence for the organization issue of one page of a crawl. */
function evidenceFor(path, { pageType = null, structured_data = [], siteData = null, profile = null, issueId = 'organization_schema', probes = [] } = {}) {
  const pageData = page(path, structured_data, { meta_tags: { 'og:site_name': ['Clinic Eye Centre'] } });
  return applyImageProbes(buildSchemaEvidence({ issueId, pageUrl: pageData.url, pageData, pageType, site: siteData, profile }), probes);
}
const intentOf = (ev) => ev.organization.intent;

describe('resolveSchemaIntent — Organization', () => {
  test('homepage, no entity anywhere, no physical evidence -> a plain Organization, generated', () => {
    const i = intentOf(evidenceFor('/', { pageType: 'homepage', siteData: site([]) }));
    assert.equal(i.intent, INTENTS.ORGANIZATION);
    assert.equal(i.action, 'generate');
    assert.equal(i.type, 'Organization');
    assert.equal(i.typeSource, 'default');
    assert.equal(i.scope, 'homepage');
    assert.deepEqual(i.missing, []);
    assert.ok(i.reasons.some((r) => /plain Organization/.test(r)));
  });

  test('no name on the page and no other source -> needs_input for the name, not an invented one', () => {
    const pageData = page('/', []);
    const ev = applyImageProbes(buildSchemaEvidence({ issueId: 'organization_schema', pageUrl: pageData.url, pageData, pageType: 'homepage', site: site([]) }), []);
    assert.equal(intentOf(ev).action, 'needs_input');
    assert.deepEqual(intentOf(ev).missing.map((m) => m.field), ['name']);
  });
});

describe('resolveSchemaIntent — LocalBusiness', () => {
  test('location page with a verified address on the site, no specific type known -> LocalBusiness', () => {
    const s = site([page('/', [{ '@type': 'Organization', '@id': ORG_ID, name: 'Clinic', url: HOME, address: ADDRESS }]), page('/contact', [])]);
    // a plain Organization (with an address) is not a physical-location claim: the site has no Place
    const i = intentOf(evidenceFor('/contact', { pageType: 'contact', siteData: s }));
    assert.equal(i.type, 'LocalBusiness');
    assert.equal(i.intent, INTENTS.LOCAL_BUSINESS);
    assert.equal(i.scope, 'location_page');
    assert.equal(i.id, ORG_ID, 'the existing @id is reused, not re-minted');
  });

  test('location page with NO address anywhere -> needs_input (address); never a guessed one, never a silent Organization', () => {
    const ev = evidenceFor('/contact', { pageType: 'contact', siteData: site([]) });
    const i = intentOf(ev);
    assert.equal(i.intent, INTENTS.LOCAL_BUSINESS);
    assert.equal(i.action, 'needs_input');
    assert.deepEqual(i.missing.map((m) => m.field), ['address']);
    assert.equal(ev.organization.contact.address, undefined);
  });

  test('a plain Organization on a location page is extended to a LocalBusiness when the address is verified (same @id)', () => {
    const s = site([page('/', hospitalSitePages()[0].structured_data)]);
    const org = [{ '@type': 'Organization', '@id': ORG_ID, name: 'Clinic Eye Centre', url: HOME }];
    const i = intentOf(evidenceFor('/contact', { pageType: 'contact', structured_data: org, siteData: s }));
    assert.equal(i.action, 'generate');
    assert.equal(i.id, ORG_ID);
    assert.ok(i.types.includes('Hospital') || i.types.includes('LocalBusiness'));
    assert.ok(!i.types.includes('Organization') || i.types.length >= 1);
  });
});

describe('resolveSchemaIntent — Hospital (only with evidence)', () => {
  test('the site\'s own markup says Hospital -> a missing homepage entity is a Hospital, reusing the @id and the Place address', () => {
    const s = site(hospitalSitePages().filter((p) => !p.url.endsWith('/') || p.url !== `${ORIGIN}/`));
    const ev = evidenceFor('/', { pageType: 'homepage', siteData: s });
    const i = intentOf(ev);
    assert.equal(i.intent, INTENTS.HOSPITAL);
    assert.equal(i.type, 'Hospital');
    assert.equal(i.typeSource, 'existing_markup');
    assert.equal(i.id, ORG_ID);
    assert.equal(i.action, 'generate');
    assert.deepEqual(ev.organization.contact.address, ADDRESS);
    assert.equal(ev.organization.factSources.address, 'site_entity_markup');
  });

  test('a verified Business Profile with a Hospital category (and a matching website) -> Hospital with the profile address', () => {
    const ev = evidenceFor('/', { pageType: 'homepage', siteData: site([]), profile: gbp() });
    const i = intentOf(ev);
    assert.equal(i.intent, INTENTS.HOSPITAL);
    assert.equal(i.typeSource, 'business_profile');
    assert.equal(ev.organization.contact.address, '2-A Trust House, Parel, Mumbai');
    assert.equal(ev.organization.factSources.address, 'google_business_profile');
    assert.equal(ev.organization.contact.telephone, '+91 11 4000 0000');
  });

  test('REGRESSION: a Business Profile for ANOTHER website is ignored: Organization, its address/phone never used, the reason is reported', () => {
    const ev = evidenceFor('/', { pageType: 'homepage', siteData: site([]), profile: gbp({ website: 'https://asg-other.example/' }) });
    const i = intentOf(ev);
    assert.equal(i.type, 'Organization');
    assert.equal(ev.organization.contact.address, undefined);
    assert.equal(ev.organization.contact.telephone, undefined);
    assert.ok(i.notes.some((n) => /different website/.test(n)));
    assert.equal(ev.organization.businessProfile.trusted, false);
  });

  test('a Hospital is never chosen without evidence: an unmapped profile category gives LocalBusiness (Hospital only from a real signal)', () => {
    const i = intentOf(evidenceFor('/', { pageType: 'homepage', siteData: site([]), profile: gbp({ category: 'Eye care center' }) }));
    assert.equal(i.type, 'LocalBusiness');
    assert.equal(i.typeSource, 'verified_address');
  });

  test('a specific subtype is recognised through the hierarchy and kept (Hospital is a LocalBusiness; Dentist stays Dentist)', () => {
    assert.equal(specificTypeOf(['Hospital', 'Organization']), 'Hospital');
    assert.equal(specificTypeOf(['LocalBusiness', 'Dentist']), 'Dentist');
    assert.equal(specificTypeOf(['Organization']), null);
    assert.equal(specificTypeOf(['Optometric']), null, 'an invalid type is not a subtype');
  });
});

describe('resolveSchemaIntent — reuse / reference (no duplicates)', () => {
  test('the page already declares the entity -> reuse, same @id and types, no downgrade, nothing to change', () => {
    const ev = evidenceFor('/', { pageType: 'homepage', structured_data: hospitalSitePages()[0].structured_data, siteData: site(), probes: [probeOk(REAL_LOGO)] });
    const i = intentOf(ev);
    assert.equal(i.intent, INTENTS.ALREADY_PRESENT);
    assert.equal(i.action, 'reuse');
    assert.equal(i.type, 'Hospital');
    assert.deepEqual(i.types, ['Hospital', 'Organization']);
    assert.equal(i.id, ORG_ID);
    assert.deepEqual(i.delta, []);
  });

  test('an incomplete existing entity is EXTENDED with verified facts only (action generate, delta lists what changes)', () => {
    const bare = [{ '@type': ['Hospital', 'Organization'], '@id': ORG_ID, name: 'Clinic Eye Centre', url: HOME }];
    const ev = evidenceFor('/', { pageType: 'homepage', structured_data: bare, siteData: site(), probes: [probeOk(REAL_LOGO)] });
    const i = intentOf(ev);
    assert.equal(i.action, 'generate');
    assert.equal(i.mode, 'extend_existing');
    assert.equal(i.intent, INTENTS.HOSPITAL);
    assert.deepEqual(i.types, ['Hospital', 'Organization']);
  });

  test('the 7-page scenario: a gallery / appointment / service page is told to REFERENCE the site entity, never to create one', () => {
    for (const path of ['/gallery', '/appointment', '/cataract-surgery', '/lasik']) {
      const ev = evidenceFor(path, { pageType: 'generic', structured_data: [{ '@type': 'Optometric', name: 'x' }], siteData: site() });
      const i = intentOf(ev);
      assert.equal(i.intent, INTENTS.ALREADY_PRESENT, path);
      assert.equal(i.action, 'reference', path);
      assert.equal(i.scope, 'non_entity_page');
      assert.equal(i.type, 'Hospital');
      assert.equal(i.id, ORG_ID);
      assert.equal(i.reuse.pageUrl, `${ORIGIN}/`);
      assert.equal(ev.organization.present, false, 'page-level evidence is unchanged: the page itself has no entity');
    }
  });

  test('a non-entity page on a site with NO entity: the recommendation is for the HOMEPAGE', () => {
    const i = intentOf(evidenceFor('/gallery', { pageType: 'generic', siteData: site([]) }));
    assert.equal(i.action, 'generate');
    assert.equal(i.placement, 'homepage');
    assert.equal(i.scope, 'non_entity_page');
  });
});

describe('resolveSchemaIntent — purity and the evidence summary', () => {
  test('pure and deterministic', () => {
    const args = { pageUrl: HOME, pageType: 'homepage', organization: { primary: null, name: { value: 'A', source: 'og:site_name', verified: true }, logo: { status: 'none' } }, site: site([]), profile: null };
    assert.deepEqual(resolveSchemaIntent(args), resolveSchemaIntent(args));
  });

  test('the UI summary carries the intent, fact sources and profile trust — and no raw schema nodes', () => {
    const ev = evidenceFor('/', { pageType: 'homepage', siteData: site([]), profile: gbp() });
    const sum = summarizeSchemaEvidence(ev);
    assert.equal(sum.organization.intent.intent, INTENTS.HOSPITAL);
    assert.equal(sum.organization.businessProfile.trusted, true);
    assert.ok(sum.organization.factSources.address);
    assert.equal(JSON.stringify(sum).includes('"node"'), false);
  });

  test('breadcrumb/article evidence is untouched: no organization intent is computed', () => {
    const pageData = page('/x', []);
    const ev = buildSchemaEvidence({ issueId: 'breadcrumblist_schema', pageUrl: pageData.url, pageData, pageType: 'generic', site: site() });
    assert.equal(ev.organization.intent, undefined);
    assert.equal(summarizeSchemaEvidence(ev).organization, null);
  });
});
