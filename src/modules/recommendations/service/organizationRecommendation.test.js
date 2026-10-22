import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import schemaValidator from '../validators/SchemaValidator.js';
import {
  buildOrganizationJsonLd, buildOrganizationSections, organizationFingerprint, OrganizationRecommendationError,
} from './organizationRecommendation.js';
import { applyGuardToSections, sanitizeGeneratedSchema } from '../../schema-evidence/schemaOutputGuard.js';
import { applyImageProbes, buildSchemaEvidence, fingerprintKeyOf } from '../../schema-evidence/schemaEvidence.js';
import { analyzeSiteEntity } from '../../schema-evidence/siteEntity.js';
import { normalizeBusinessProfile } from '../../schema-evidence/businessProfileFacts.js';
import { HOME, ORG_ID, ORIGIN, REAL_LOGO, probeOk } from '../../schema-evidence/__fixtures__/clinicSite.js';
import { ADDRESS, hospitalSitePages, page } from '../../schema-evidence/__fixtures__/hospitalSite.js';

const site = (pages = hospitalSitePages()) => analyzeSiteEntity(pages);
const withoutHome = () => hospitalSitePages().filter((p) => p.url !== `${ORIGIN}/`);
const gbp = (over = {}) => normalizeBusinessProfile({ business_name: 'Clinic Eye Centre', category: 'Hospital', phone: '+91 11 4000 0000', website: `${ORIGIN}/`, address: '2-A Trust House, Parel, Mumbai', business_status: 'OPEN', ...over }, { siteUrl: ORIGIN });

function evidenceFor(path, { pageType = null, structured_data = [], siteData = null, profile = null, probes = [], issueId = 'organization_schema', images = [] } = {}) {
  const pageData = page(path, structured_data, { meta_tags: { 'og:site_name': ['Clinic Eye Centre'] }, images });
  return applyImageProbes(buildSchemaEvidence({ issueId, pageUrl: pageData.url, pageData, pageType, site: siteData, profile }), probes);
}
const jsonLdOf = (sections) => JSON.parse(/<script[^>]*>([\s\S]*?)<\/script>/.exec(sections.implementationExample.content)[1]);
const runPipeline = (ev) => {
  const built = buildOrganizationSections(ev);
  const { sections } = applyGuardToSections(built, ev);
  const validation = schemaValidator.validate(sections, { identity: { issueId: 'organization_schema' }, pageContext: { pageUrl: ev.url.display }, schemaEvidence: ev });
  return { built, sections, validation };
};

describe('deterministic organization recommendation — Organization', () => {
  test('a plain Organization from verified facts only; passes the guard AND the validator; no invented contact data', () => {
    const ev = evidenceFor('/', { pageType: 'homepage', siteData: site([]) });
    const { sections, validation } = runPipeline(ev);
    assert.equal(validation.valid, true, validation.errors.join(' | '));
    const ld = jsonLdOf(sections);
    assert.equal(ld['@type'], 'Organization');
    assert.equal(ld['@id'], `${HOME}#organization`);
    assert.equal(ld.name, 'Clinic Eye Centre');
    assert.equal(ld.url, HOME);
    for (const f of ['telephone', 'address', 'geo', 'openingHoursSpecification', 'sameAs', 'logo', 'contactPoint']) assert.equal(ld[f], undefined, f);
    assert.match(sections.recommendedFix, /plain Organization/);
    assert.match(sections.recommendedFix, /does not change your website/);
    assert.equal(sections.sourceAttribution.contextSources.schemaType, 'Organization');
    assert.equal(sections.sourceAttribution.contextSources.llmUsed, false);
    assert.equal(sections.sourceAttribution.generatedBy, 'template');
  });

  test('a verified (fetched) logo is published with its MEASURED size; an unverified one never is', () => {
    const withLogo = evidenceFor('/', { pageType: 'homepage', siteData: site([]), structured_data: [{ '@type': 'Organization', name: 'Clinic Eye Centre', url: HOME, logo: REAL_LOGO }], probes: [probeOk(REAL_LOGO)] });
    assert.deepEqual(buildOrganizationJsonLd(withLogo).logo, { '@type': 'ImageObject', url: REAL_LOGO, width: 178, height: 59 });
    const noProbe = evidenceFor('/', { pageType: 'homepage', siteData: site([]), structured_data: [{ '@type': 'Organization', name: 'Clinic Eye Centre', url: HOME, logo: REAL_LOGO }] });
    assert.equal(buildOrganizationJsonLd(noProbe).logo, undefined);
  });
});

describe('deterministic organization recommendation — LocalBusiness', () => {
  test('a verified address and phone (Business Profile for THIS site, unmapped category) -> LocalBusiness with exactly those facts', () => {
    const ev = evidenceFor('/', { pageType: 'homepage', siteData: site([]), profile: gbp({ category: 'Eye care center' }) });
    const { sections, validation } = runPipeline(ev);
    assert.equal(validation.valid, true, validation.errors.join(' | '));
    const ld = jsonLdOf(sections);
    assert.equal(ld['@type'], 'LocalBusiness');
    assert.equal(ld.address, '2-A Trust House, Parel, Mumbai');
    assert.equal(ld.telephone, '+91 11 4000 0000');
    assert.match(sections.recommendedFix, /Google Business Profile/);
    assert.match(sections.recommendedFix, /verified to belong to this website/);
  });

  test('the guard no longer flattens an intended LocalBusiness: the verified address is present, so the type is kept', () => {
    const ev = evidenceFor('/', { pageType: 'homepage', siteData: site([]), profile: gbp({ category: 'Eye care center' }) });
    const { schema, notes } = sanitizeGeneratedSchema({ '@context': 'https://schema.org', '@type': 'LocalBusiness', name: 'Clinic Eye Centre', url: HOME }, ev);
    assert.equal(schema['@type'], 'LocalBusiness');
    assert.equal(schema.address, '2-A Trust House, Parel, Mumbai');
    assert.ok(!notes.some((n) => /published as an Organization/.test(n)));
  });

  test('location page without an address: needs_input — NO JSON-LD, the question names the missing fact', () => {
    const ev = evidenceFor('/contact', { pageType: 'contact', siteData: site([]) });
    const { sections } = runPipeline(ev);
    assert.doesNotMatch(sections.implementationExample.content, /<script/);
    assert.match(sections.implementationExample.content, /needs your input: Street address/);
    assert.match(sections.recommendedFix, /Street address of the location/);
    assert.match(sections.recommendedFix, /Nothing was guessed/);
    assert.equal(sections.sourceAttribution.contextSources.schemaAction, 'needs_input');
  });
});

describe('deterministic organization recommendation — Hospital', () => {
  test('site markup says Hospital -> Hospital, reusing the @id; address from the site; passes the validator', () => {
    const ev = evidenceFor('/', { pageType: 'homepage', siteData: site(withoutHome()) });
    const { sections, validation } = runPipeline(ev);
    assert.equal(validation.valid, true, validation.errors.join(' | '));
    const ld = jsonLdOf(sections);
    assert.deepEqual(ld['@type'], ['Hospital', 'Organization'], "the site's own type list is reused as published");
    assert.equal(ld['@id'], ORG_ID);
    assert.deepEqual(ld.address, ADDRESS);
    assert.equal(ld.telephone, '+918447637606');
    assert.match(sections.recommendedFix, /already identifies the business as Hospital/);
    assert.match(sections.recommendedFix, /existing @id/);
  });

  test('Hospital without an address is never produced', () => {
    const ev = evidenceFor('/', { pageType: 'homepage', siteData: site([]), profile: gbp({ address: null }) });
    assert.equal(ev.organization.intent.type, 'Hospital');
    assert.equal(ev.organization.intent.action, 'needs_input');
    assert.doesNotMatch(buildOrganizationSections(ev).implementationExample.content, /<script/);
  });
});

describe('deterministic organization recommendation — reuse / reference / extend', () => {
  test('a generic page: no JSON-LD, explains that the site entity (a Hospital) lives on the homepage and is referenced by @id', () => {
    const ev = evidenceFor('/gallery', { pageType: 'generic', structured_data: [{ '@type': 'Optometric' }], siteData: site() });
    const { sections } = runPipeline(ev);
    assert.doesNotMatch(sections.implementationExample.content, /<script/);
    assert.match(sections.recommendedFix, /No new Hospital markup is needed/);
    assert.match(sections.recommendedFix, new RegExp(ORG_ID.replace(/[/.]/g, '\\$&')));
    assert.match(sections.recommendedFix, /needs no standalone/);
    assert.match(sections.recommendedFix, /reference it by @id/);
  });

  test('a complete existing entity: reuse, nothing duplicated', () => {
    const ev = evidenceFor('/', { pageType: 'homepage', structured_data: hospitalSitePages()[0].structured_data, siteData: site(), probes: [probeOk(REAL_LOGO)] });
    const { sections } = runPipeline(ev);
    assert.doesNotMatch(sections.implementationExample.content, /<script/);
    assert.match(sections.recommendedFix, /stays exactly as it is/);
    assert.equal(sections.sourceAttribution.contextSources.schemaAction, 'reuse');
  });

  test('an existing Hospital missing its logo is EXTENDED: type and @id preserved, only the verified logo added, other properties kept out of the diff', () => {
    const bare = [{ '@type': ['Hospital', 'Organization'], '@id': ORG_ID, name: 'Clinic Eye Centre', url: HOME, description: 'Eye care since 1990.', telephone: '+918447637606', address: ADDRESS }];
    const ev = evidenceFor('/', { pageType: 'homepage', structured_data: bare, siteData: site(), probes: [probeOk(REAL_LOGO)], images: [{ src: REAL_LOGO, alt: 'Clinic logo' }] });
    const { sections, validation } = runPipeline(ev);
    assert.equal(validation.valid, true, validation.errors.join(' | '));
    const ld = jsonLdOf(sections);
    assert.deepEqual(ld['@type'], ['Hospital', 'Organization']);
    assert.equal(ld['@id'], ORG_ID);
    assert.equal(ld.description, 'Eye care since 1990.');
    assert.equal(ld.logo.url, REAL_LOGO);
    assert.deepEqual(sections.changeSummary.items.map((i) => i.field), ['logo']);
    assert.match(sections.recommendedFix, /Do NOT add a second block/);
  });

  test('never downgrades: whatever the model wrote, an existing Hospital stays Hospital + Organization', () => {
    const ev = evidenceFor('/', { pageType: 'homepage', structured_data: hospitalSitePages()[0].structured_data, siteData: site() });
    const { schema } = sanitizeGeneratedSchema({ '@context': 'https://schema.org', '@type': 'Organization', name: 'Clinic Eye Centre', url: HOME }, ev);
    assert.deepEqual(schema['@type'], ['Hospital', 'Organization']);
    assert.equal(schema['@id'], ORG_ID);
  });
});

describe('guard + validator enforce the intent', () => {
  test('a model that claims Hospital without evidence is brought back to the intended type', () => {
    const ev = evidenceFor('/', { pageType: 'homepage', siteData: site([]) });
    const { schema, notes } = sanitizeGeneratedSchema({ '@context': 'https://schema.org', '@type': ['Hospital', 'Organization'], name: 'Clinic Eye Centre', url: HOME, address: '1 Made Up Rd' }, ev);
    assert.equal(schema['@type'], 'Organization');
    assert.equal(schema.address, undefined);
    assert.ok(notes.some((n) => /published as an Organization/.test(n)));
  });

  test('the validator rejects a type that mismatches the intent (even if the guard was skipped)', () => {
    const hospital = evidenceFor('/', { pageType: 'homepage', siteData: site(withoutHome()) });
    const generic = { implementationExample: { type: 'html', content: `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Organization', '@id': ORG_ID, name: 'Clinic Eye Centre', url: HOME, address: ADDRESS, telephone: '+918447637606' })}</script>` }, recommendedVersion: 'x'.repeat(40) };
    const down = schemaValidator.validate(generic, { identity: { issueId: 'organization_schema' }, pageContext: { pageUrl: HOME }, schemaEvidence: hospital });
    assert.ok(down.errors.some((e) => /schema intent for this page is Hospital/.test(e)), down.errors.join(' | '));

    const plain = evidenceFor('/', { pageType: 'homepage', siteData: site([]) });
    const inflated = { implementationExample: { type: 'html', content: `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': ['Dentist', 'Organization'], name: 'Clinic Eye Centre', url: HOME, '@id': `${HOME}#organization` })}</script>` }, recommendedVersion: 'x'.repeat(40) };
    const up = schemaValidator.validate(inflated, { identity: { issueId: 'organization_schema' }, pageContext: { pageUrl: HOME }, schemaEvidence: plain });
    assert.ok(up.errors.some((e) => /not supported by the verified evidence/.test(e)), up.errors.join(' | '));
  });

  test('a physical type generated while the intent still waits for the address is an error', () => {
    const ev = evidenceFor('/contact', { pageType: 'contact', siteData: site([]) });
    const out = { implementationExample: { type: 'html', content: `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'LocalBusiness', name: 'Clinic Eye Centre', url: HOME, '@id': `${HOME}#organization` })}</script>` }, recommendedVersion: 'x'.repeat(40) };
    const r = schemaValidator.validate(out, { identity: { issueId: 'organization_schema' }, pageContext: { pageUrl: HOME }, schemaEvidence: ev });
    assert.ok(r.errors.some((e) => /without a verified address/.test(e)), r.errors.join(' | '));
  });
});

describe('cache fingerprint is intent-aware', () => {
  const key = (ev) => organizationFingerprint('proj', ev.url.crawlKey, ev);

  test('same evidence -> same key; the output is deterministic', () => {
    const a = evidenceFor('/', { pageType: 'homepage', siteData: site([]) });
    const b = evidenceFor('/', { pageType: 'homepage', siteData: site([]) });
    assert.equal(key(a), key(b));
    assert.deepEqual(buildOrganizationSections(a), buildOrganizationSections(b));
  });

  test('a different intent never reuses an older recommendation (Organization -> Hospital after a profile is verified)', () => {
    const before = evidenceFor('/', { pageType: 'homepage', siteData: site([]) });
    const after = evidenceFor('/', { pageType: 'homepage', siteData: site([]), profile: gbp() });
    assert.notEqual(key(before), key(after));
    assert.notEqual(before.fingerprintKey, after.fingerprintKey);
  });

  test('a newly available fact (address on the site), a new verified logo or a changed reuse target changes the key', () => {
    const none = evidenceFor('/contact', { pageType: 'contact', siteData: site([]) });
    const found = evidenceFor('/contact', { pageType: 'contact', siteData: site(withoutHome()) });
    assert.notEqual(key(none), key(found));
    const noLogo = evidenceFor('/', { pageType: 'homepage', siteData: site([]) });
    const logo = evidenceFor('/', { pageType: 'homepage', siteData: site([]), structured_data: [{ '@type': 'Organization', name: 'Clinic Eye Centre', url: HOME, logo: REAL_LOGO }], probes: [probeOk(REAL_LOGO)] });
    assert.notEqual(key(noLogo), key(logo));
  });

  test('the key differs between pages and between projects', () => {
    const ev = evidenceFor('/', { pageType: 'homepage', siteData: site([]) });
    assert.notEqual(organizationFingerprint('p1', ev.url.crawlKey, ev), organizationFingerprint('p2', ev.url.crawlKey, ev));
    assert.notEqual(organizationFingerprint('p1', ev.url.crawlKey, ev), organizationFingerprint('p1', `${ORIGIN}/other`, ev));
  });

  test('non-organization evidence keys are untouched by the intent (breadcrumb/article caches are not invalidated)', () => {
    const pageData = page('/x', []);
    const a = buildSchemaEvidence({ issueId: 'breadcrumblist_schema', pageUrl: pageData.url, pageData, pageType: 'generic' });
    const b = buildSchemaEvidence({ issueId: 'breadcrumblist_schema', pageUrl: pageData.url, pageData, pageType: 'generic', site: site(), profile: gbp() });
    assert.equal(a.fingerprintKey, b.fingerprintKey);
    assert.equal(fingerprintKeyOf(a), a.fingerprintKey);
  });
});

describe('failure modes', () => {
  test('no intent -> a refusal, nothing is built', () => {
    assert.throws(() => buildOrganizationSections({ organization: {} }), (e) => e instanceof OrganizationRecommendationError && e.code === 'SCHEMA_INTENT_MISSING');
  });

  test('the output never contains placeholder text', () => {
    const cases = [
      evidenceFor('/', { pageType: 'homepage', siteData: site([]) }),
      evidenceFor('/contact', { pageType: 'contact', siteData: site([]) }),
      evidenceFor('/gallery', { pageType: 'generic', siteData: site() }),
      evidenceFor('/', { pageType: 'homepage', siteData: site([]), profile: gbp() }),
    ];
    for (const ev of cases) {
      const s = buildOrganizationSections(ev);
      const text = JSON.stringify(s);
      assert.doesNotMatch(text, /\[(business|company) name\]|your company name|lorem ipsum|example\.com|yourdomain/i);
    }
  });
});
