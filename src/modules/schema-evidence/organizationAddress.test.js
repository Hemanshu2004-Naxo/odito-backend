import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ADDRESS_FIELDS, TRUST, assessOrganizationAddress, collectAddressCandidates, compareFields, existingAddressState,
  normalizePostalAddress, sameLocation, summarizeAddressAssessment, validateConfirmedAddressInput,
} from './organizationAddress.js';
import { applyImageProbes, buildSchemaEvidence } from './schemaEvidence.js';
import { analyzeSiteEntity } from './siteEntity.js';
import { normalizeBusinessProfile } from './businessProfileFacts.js';
import { flattenJsonLd } from './schemaGraph.js';
import {
  HOME, LOGO_URL, ORG_ID, ORIGIN, OTHER_ADDRESS, TEST_ADDRESS, TEST_ADDRESS_NODE,
  homePageDoc, organizationNode, pageDoc, probeOk, yoastGraph,
} from './__fixtures__/addressSite.js';

const primaryOf = (graph) => flattenJsonLd(graph).find((n) => n['@id'] === ORG_ID);

const evidenceFor = ({ graph = yoastGraph(), pages = null, profile = null, addressSources = null, issueId = 'organization_schema' } = {}) => {
  const doc = homePageDoc(graph);
  const site = analyzeSiteEntity(pages || [doc]);
  const ev = buildSchemaEvidence({ issueId, pageUrl: doc.url, pageData: doc, pageType: 'homepage', site, profile, addressSources });
  return applyImageProbes(ev, [probeOk(LOGO_URL)]);
};

describe('normalizePostalAddress — nothing is composed or guessed', () => {
  test('a structured address keeps only the five PostalAddress fields, trimmed', () => {
    const n = normalizePostalAddress({ '@type': 'PostalAddress', streetAddress: '  14 Lakeview Road ', addressLocality: 'Rivertown', postalCode: 560001, extra: 'ignored', addressCountry: { '@type': 'Country', name: 'India' } });
    assert.deepEqual(n.fields, { streetAddress: '14 Lakeview Road', addressLocality: 'Rivertown', postalCode: '560001', addressCountry: 'India' });
    assert.equal(n.structured, true);
    assert.equal(n.complete, true);
  });

  test('a plain string is kept verbatim and is NOT split into parts', () => {
    const n = normalizePostalAddress('14 Lakeview Road, Rivertown 560001');
    assert.equal(n.structured, false);
    assert.deepEqual(n.fields, {});
    assert.equal(n.formatted, '14 Lakeview Road, Rivertown 560001');
    assert.equal(n.complete, false);
  });

  test('missing parts stay missing: a street-less address is incomplete and reports what is missing', () => {
    const n = normalizePostalAddress({ addressLocality: 'Rivertown', addressRegion: 'Karnataka' });
    assert.equal(n.complete, false);
    assert.deepEqual(n.missing, ['streetAddress']);
    assert.equal('postalCode' in n.fields, false);
  });

  test('empty / junk values are nothing', () => {
    for (const v of [null, undefined, '', '   ', [], {}, { streetAddress: '  ' }]) assert.equal(normalizePostalAddress(v), null, JSON.stringify(v));
  });

  test('control characters are stripped and over-long values are capped', () => {
    const n = normalizePostalAddress({ streetAddress: `14 Lake\u0000view${'x'.repeat(500)}`, addressLocality: 'Rivertown' });
    assert.ok(!n.fields.streetAddress.includes('\u0000'));
    assert.ok(n.fields.streetAddress.length <= 200);
  });
});

describe('comparison: same place vs a conflict', () => {
  test('abbreviations, case, punctuation and country aliases do not create false conflicts', () => {
    const a = { streetAddress: '14 Lakeview Road', addressLocality: 'Rivertown', postalCode: '560 001', addressCountry: 'India' };
    const b = { streetAddress: '14, Lakeview Rd.', addressLocality: 'RIVERTOWN', postalCode: '560001', addressCountry: 'IN' };
    assert.deepEqual(compareFields(a, b).conflicts, []);
    assert.equal(sameLocation(a, b), true);
  });

  test('a different street is a conflict even in the same city', () => {
    const { conflicts } = compareFields(TEST_ADDRESS, { ...TEST_ADDRESS, streetAddress: '99 Other Road' });
    assert.deepEqual(conflicts, ['streetAddress']);
  });

  test('sharing only a city is NOT proof of the same place', () => {
    assert.equal(sameLocation({ addressLocality: 'Rivertown' }, { addressLocality: 'Rivertown', addressRegion: 'Karnataka' }), false);
  });
});

describe('existingAddressState — what the entity holds today', () => {
  test('no entity / absent / empty / text / incomplete / complete', () => {
    assert.equal(existingAddressState(null).state, 'no_entity');
    assert.equal(existingAddressState({ name: 'x' }).state, 'missing');
    assert.equal(existingAddressState({ address: {} }).state, 'missing');
    assert.equal(existingAddressState({ address: { '@type': 'PostalAddress', streetAddress: '' } }).state, 'missing');
    assert.equal(existingAddressState({ address: '14 Lakeview Road, Rivertown' }).state, 'present_text');
    assert.equal(existingAddressState({ address: { addressLocality: 'Rivertown', addressCountry: 'IN' } }).state, 'incomplete');
    assert.equal(existingAddressState({ address: TEST_ADDRESS_NODE }).state, 'present_complete');
  });
});

describe('assessOrganizationAddress — the scenarios that decide what ODITO may propose', () => {
  const entity = (over = {}) => primaryOf(yoastGraph(over));
  const siteNode = (address, over = {}) => ({ pageUrl: `${ORIGIN}/contact`, id: ORG_ID, types: ['Organization'], address, isPrimary: true, isPlace: false, linkedFromPrimary: false, ...over });

  test('1. entity exists, address missing, no source anywhere -> unavailable (the owner is asked), nothing proposed', () => {
    const a = assessOrganizationAddress({ primary: entity(), candidates: collectAddressCandidates({ primary: entity() }) });
    assert.equal(a.state, 'unavailable');
    assert.equal(a.proposal, null);
    assert.equal(a.existing.state, 'missing');
  });

  test('2. a complete address is already present -> no_change; a different verified address is reported, never overwritten', () => {
    const withAddr = entity({ address: TEST_ADDRESS_NODE });
    const same = assessOrganizationAddress({ primary: withAddr, candidates: collectAddressCandidates({ primary: withAddr, site: { addressNodes: [siteNode(TEST_ADDRESS_NODE)] } }) });
    assert.equal(same.state, 'no_change');
    assert.equal(same.reason, 'ADDRESS_PRESENT');

    const differs = assessOrganizationAddress({ primary: withAddr, candidates: collectAddressCandidates({ primary: withAddr, site: { addressNodes: [siteNode({ '@type': 'PostalAddress', ...OTHER_ADDRESS })] } }) });
    assert.equal(differs.state, 'no_change');
    assert.equal(differs.proposal, null);
    assert.match(differs.notes.join(' '), /does not overwrite an address that is already published/);
  });

  test('3. an incomplete address is completed from a verified source; the parts it already has are kept', () => {
    const incomplete = entity({ address: { '@type': 'PostalAddress', addressLocality: 'Rivertown', addressCountry: 'IN' } });
    const a = assessOrganizationAddress({ primary: incomplete, candidates: collectAddressCandidates({ primary: incomplete, site: { addressNodes: [siteNode(TEST_ADDRESS_NODE)] } }) });
    assert.equal(a.state, 'ready');
    assert.equal(a.reason, 'COMPLETES_EXISTING_ADDRESS');
    assert.deepEqual(a.proposal.fields, TEST_ADDRESS);
    assert.equal(a.proposal.fieldSources.addressLocality, 'page_entity_markup', 'a part the entity already has stays as published');
    assert.deepEqual([...a.proposal.completes].sort(), ['addressRegion', 'postalCode', 'streetAddress']);
  });

  test('3b. a candidate that contradicts the existing parts is ignored, not merged', () => {
    const incomplete = entity({ address: { '@type': 'PostalAddress', addressLocality: 'Portville' } });
    const a = assessOrganizationAddress({ primary: incomplete, candidates: collectAddressCandidates({ primary: incomplete, site: { addressNodes: [siteNode(TEST_ADDRESS_NODE)] } }) });
    assert.notEqual(a.state, 'ready');
    assert.match(a.notes.join(' '), /contradict/);
  });

  test('4. a verified, complete address from the site\'s own markup (another page) is proposed with its provenance', () => {
    const a = assessOrganizationAddress({ primary: entity(), candidates: collectAddressCandidates({ primary: entity(), site: { addressNodes: [siteNode(TEST_ADDRESS_NODE)] } }) });
    assert.equal(a.state, 'ready');
    assert.equal(a.proposal.status, 'verified');
    assert.deepEqual(a.proposal.fields, TEST_ADDRESS);
    assert.deepEqual(a.proposal.sources, ['site_entity_markup']);
    assert.equal(a.proposal.value['@type'], 'PostalAddress');
    assert.equal(a.proposal.confidence, 'high');
  });

  test('4b. a Google Business Profile address (street lines only) is a suggestion, never publishable on its own', () => {
    const profile = normalizeBusinessProfile({ website: HOME, business_status: 'OPEN', address: '14 Lakeview Road', business_name: 'x', category: 'Hospital' }, { siteUrl: ORIGIN });
    assert.equal(profile.trusted, true);
    const a = assessOrganizationAddress({ primary: entity(), candidates: collectAddressCandidates({ primary: entity(), profile }) });
    assert.equal(a.state, 'needs_confirmation');
    assert.equal(a.proposal, null);
    assert.equal(a.suggestion.formatted, '14 Lakeview Road');
    assert.equal(a.suggestion.partial, true);
  });

  test('4c. the Places selection (city/state/country, no street) is a partial suggestion and is not merged with a Business Profile street', () => {
    const profile = normalizeBusinessProfile({ website: HOME, business_status: 'OPEN', address: '14 Lakeview Road', business_name: 'x' }, { siteUrl: ORIGIN });
    const project = { siteUrl: ORIGIN, verifiedBusiness: { address: '14 Lakeview Road, Rivertown, Karnataka, India', city: 'Rivertown', state: 'Karnataka', country: 'India', countryCode: 'IN', website: HOME } };
    const a = assessOrganizationAddress({ primary: entity(), candidates: collectAddressCandidates({ primary: entity(), profile, project }) });
    assert.equal(a.state, 'needs_confirmation');
    assert.equal(a.proposal, null, 'two partial sources never combine into a published address');
  });

  test('4d. a Places selection tied to ANOTHER website is not trusted', () => {
    const project = { siteUrl: ORIGIN, verifiedBusiness: { address: '9 Harbour Street', city: 'Portville', website: 'https://someone-else.example/' } };
    const c = collectAddressCandidates({ primary: entity(), project }).find((x) => x.source === 'verified_business');
    assert.equal(c.trust, TRUST.UNVERIFIED);
    assert.match(c.detail, /different site/);
  });

  test('4e. the owner-entered business details (structured) are a usable source', () => {
    const owner = { address: '14 Lakeview Road', city: 'Rivertown', region: 'Karnataka', postalCode: '560001', country: 'IN' };
    const a = assessOrganizationAddress({ primary: entity(), candidates: collectAddressCandidates({ primary: entity(), owner }) });
    assert.equal(a.state, 'ready');
    assert.deepEqual(a.proposal.sources, ['owner_profile']);
    assert.equal(a.proposal.status, 'verified');
  });

  test('4f. extracted free text is never evidence', () => {
    const project = { siteUrl: ORIGIN, contactInfo: { address: '14 Lakeview Road, Rivertown' } };
    const a = assessOrganizationAddress({ primary: entity(), candidates: collectAddressCandidates({ primary: entity(), project }) });
    assert.equal(a.state, 'needs_confirmation');
    assert.equal(a.proposal, null);
  });

  test('5. the address the owner confirmed is used, with status confirmed_by_owner', () => {
    const confirmed = { fields: TEST_ADDRESS, confirmedAt: new Date('2026-10-01') };
    const a = assessOrganizationAddress({ primary: entity(), candidates: collectAddressCandidates({ primary: entity(), confirmed }) });
    assert.equal(a.state, 'ready');
    assert.equal(a.reason, 'CONFIRMED_BY_OWNER');
    assert.equal(a.proposal.status, 'confirmed_by_owner');
    assert.equal(a.proposal.confidence, 'high');
  });

  test('5b. the owner\'s confirmation settles a disagreement between other sources (they are listed as informational)', () => {
    const confirmed = { fields: TEST_ADDRESS };
    const a = assessOrganizationAddress({ primary: entity(), candidates: collectAddressCandidates({ primary: entity(), confirmed, site: { addressNodes: [siteNode({ '@type': 'PostalAddress', ...OTHER_ADDRESS })] } }) });
    assert.equal(a.state, 'ready');
    assert.deepEqual(a.proposal.fields, TEST_ADDRESS);
    assert.match(a.notes.join(' '), /different addresses/);
  });

  test('6. two different complete addresses from the site -> conflict: the alternatives and their sources are shown, nothing is chosen', () => {
    const a = assessOrganizationAddress({
      primary: entity(),
      candidates: collectAddressCandidates({ primary: entity(), site: { addressNodes: [siteNode(TEST_ADDRESS_NODE), siteNode({ '@type': 'PostalAddress', ...OTHER_ADDRESS }, { pageUrl: `${ORIGIN}/about`, id: `${ORIGIN}/#place`, isPrimary: false, isPlace: true, linkedFromPrimary: true })] } }),
    });
    assert.equal(a.state, 'conflict');
    assert.equal(a.proposal, null);
    assert.equal(a.alternatives.length, 2);
    assert.ok(a.alternatives.every((alt) => alt.sources.length && alt.formatted));
  });

  test('7. headquarters vs branch: the organization\'s own address is used and the branch is reported, not substituted', () => {
    const branch = { pageUrl: `${ORIGIN}/branch-two`, id: `${ORIGIN}/#branch-two`, types: ['LocalBusiness'], address: { '@type': 'PostalAddress', ...OTHER_ADDRESS }, isPrimary: false, isPlace: false, linkedFromPrimary: false };
    const a = assessOrganizationAddress({ primary: entity(), candidates: collectAddressCandidates({ primary: entity(), site: { addressNodes: [siteNode(TEST_ADDRESS_NODE), branch] } }) });
    assert.equal(a.state, 'ready');
    assert.deepEqual(a.proposal.fields, TEST_ADDRESS);
    assert.match(a.notes.join(' '), /branch/i);
  });

  test('7b. only a branch address exists -> it is NOT assumed to be the organization\'s; confirmation is required', () => {
    const branch = { pageUrl: `${ORIGIN}/branch-two`, id: `${ORIGIN}/#branch-two`, types: ['LocalBusiness'], address: { '@type': 'PostalAddress', ...OTHER_ADDRESS }, isPrimary: false, isPlace: false, linkedFromPrimary: false };
    const a = assessOrganizationAddress({ primary: entity(), candidates: collectAddressCandidates({ primary: entity(), site: { addressNodes: [branch] } }) });
    assert.equal(a.state, 'needs_confirmation');
    assert.equal(a.reason, 'BRANCH_ONLY');
    assert.equal(a.proposal, null);
  });

  test('7c. several branches and no headquarters -> a conflict the owner resolves', () => {
    const b = (path, address) => ({ pageUrl: `${ORIGIN}${path}`, id: `${ORIGIN}/#${path}`, types: ['LocalBusiness'], address, isPrimary: false, isPlace: false, linkedFromPrimary: false });
    const a = assessOrganizationAddress({ primary: entity(), candidates: collectAddressCandidates({ primary: entity(), site: { addressNodes: [b('/one', TEST_ADDRESS_NODE), b('/two', { '@type': 'PostalAddress', ...OTHER_ADDRESS })] } }) });
    assert.equal(a.state, 'conflict');
  });

  test('8. several Organization entities -> needs_review: ODITO stops and asks for review', () => {
    const a = assessOrganizationAddress({ primary: entity(), candidates: [], entityHealth: { conflictingEntities: true, duplicateIds: [] } });
    assert.equal(a.state, 'needs_review');
    assert.equal(a.reason, 'ENTITY_AMBIGUOUS');
    const dup = assessOrganizationAddress({ primary: entity(), candidates: [], entityHealth: { duplicateIds: [{ id: ORG_ID }] } });
    assert.equal(dup.state, 'needs_review');
  });

  test('9. a page with no Organization entity has nothing to add an address to', () => {
    const a = assessOrganizationAddress({ primary: null, candidates: [] });
    assert.equal(a.state, 'no_change');
    assert.equal(a.reason, 'NO_ENTITY');
  });

  test('an unlinked Place on the page (an event venue) is never the organization\'s address; a LINKED Place is', () => {
    const venue = { '@type': 'Place', '@id': `${ORIGIN}/#venue`, address: { '@type': 'PostalAddress', ...OTHER_ADDRESS } };
    const unlinked = collectAddressCandidates({ pageNodes: [venue], primary: entity() });
    assert.equal(unlinked.length, 0);
    const linkedPrimary = entity({ location: { '@id': `${ORIGIN}/#place` } });
    const place = { '@type': 'Place', '@id': `${ORIGIN}/#place`, address: TEST_ADDRESS_NODE };
    const linked = collectAddressCandidates({ pageNodes: [place], primary: linkedPrimary });
    assert.equal(linked.length, 1);
    assert.equal(linked[0].kind, 'place');
    assert.equal(assessOrganizationAddress({ primary: linkedPrimary, candidates: linked }).state, 'ready');
  });

  test('the summary is browser-safe: no raw nodes, but sources and trust are explicit', () => {
    const a = assessOrganizationAddress({ primary: entity(), candidates: collectAddressCandidates({ primary: entity(), site: { addressNodes: [siteNode(TEST_ADDRESS_NODE)] } }) });
    const s = summarizeAddressAssessment(a);
    assert.equal(s.state, 'ready');
    assert.ok(s.candidates.every((c) => c.sourceLabel && c.trust));
    assert.equal(JSON.stringify(s).includes('"node"'), false);
  });
});

describe('site registry: address-bearing entities across the crawl', () => {
  test('the primary entity, its linked Place and a separate location entity are told apart', () => {
    const placeId = `${ORIGIN}/#place`;
    const homeGraph = [{ '@context': 'https://schema.org', '@graph': [organizationNode({ location: { '@id': placeId } }), { '@type': 'Place', '@id': placeId, address: TEST_ADDRESS_NODE }] }];
    const branchGraph = [{ '@context': 'https://schema.org', '@graph': [{ '@type': 'LocalBusiness', '@id': `${ORIGIN}/#branch`, name: 'Branch', url: `${ORIGIN}/branch`, address: { '@type': 'PostalAddress', ...OTHER_ADDRESS } }] }];
    const site = analyzeSiteEntity([pageDoc('/', homeGraph, { url: ORIGIN }), pageDoc('/branch', branchGraph)]);
    const byId = Object.fromEntries(site.addressNodes.map((n) => [n.id, n]));
    assert.equal(byId[placeId].linkedFromPrimary, true);
    assert.equal(byId[placeId].isPlace, true);
    assert.equal(byId[`${ORIGIN}/#branch`].isPrimary, false);
    assert.equal(byId[`${ORIGIN}/#branch`].linkedFromPrimary, false);
  });
});

describe('owner input validation (Confirm Address)', () => {
  test('accepts a complete address, trims it, ignores unknown fields and keeps canonical order', () => {
    const { fields } = validateConfirmedAddressInput({ addressCountry: 'IN', postalCode: '560 001', streetAddress: '  14 Lakeview Road ', addressLocality: 'Rivertown', addressRegion: 'Karnataka', isOpen: true, userId: 'x' });
    assert.deepEqual(Object.keys(fields), ADDRESS_FIELDS);
    assert.equal(fields.streetAddress, '14 Lakeview Road');
  });

  test('street and city are required; the rest is optional and never invented', () => {
    assert.throws(() => validateConfirmedAddressInput({ addressLocality: 'Rivertown' }), (e) => e.field === 'streetAddress');
    assert.throws(() => validateConfirmedAddressInput({ streetAddress: '14 Lakeview Road' }), (e) => e.field === 'addressLocality');
    const { fields } = validateConfirmedAddressInput({ streetAddress: '14 Lakeview Road', addressLocality: 'Rivertown' });
    assert.deepEqual(fields, { streetAddress: '14 Lakeview Road', addressLocality: 'Rivertown' });
  });

  test('rejects markup, non-text, over-long and malformed values', () => {
    const ok = { streetAddress: '14 Lakeview Road', addressLocality: 'Rivertown' };
    assert.throws(() => validateConfirmedAddressInput({ ...ok, streetAddress: '<script>alert(1)</script>' }), (e) => e.field === 'streetAddress');
    assert.throws(() => validateConfirmedAddressInput({ ...ok, addressLocality: { $gt: '' } }), (e) => e.field === 'addressLocality');
    assert.throws(() => validateConfirmedAddressInput({ ...ok, streetAddress: 'x'.repeat(201) }), (e) => e.field === 'streetAddress');
    assert.throws(() => validateConfirmedAddressInput({ ...ok, postalCode: '56{0}001' }), (e) => e.field === 'postalCode');
    assert.throws(() => validateConfirmedAddressInput(null), (e) => e.field === 'streetAddress');
  });
});

describe('evidence pipeline: from page JSON-LD to an address assessment', () => {
  test('JSON-LD @graph + array @type + address as an array are all handled', () => {
    const graph = [{ '@context': 'https://schema.org', '@graph': [organizationNode({ '@type': ['Organization', 'MedicalOrganization'], address: [TEST_ADDRESS_NODE] })] }];
    const ev = evidenceFor({ graph });
    assert.equal(ev.organization.address.existing.state, 'present_complete');
    assert.equal(ev.organization.intent.action, 'reuse', 'a complete address means nothing is lacking');
  });

  test('REGRESSION (the reported bug): a plain Organization without an address is no longer told "reuse"', () => {
    const ev = evidenceFor();
    assert.equal(ev.organization.address.existing.state, 'missing');
    assert.equal(ev.organization.intent.addressDemand, true);
    assert.notEqual(ev.organization.intent.action, 'reuse');
    assert.equal(ev.organization.intent.action, 'needs_input', 'no source -> the owner is asked');
    assert.equal(ev.organization.intent.missing[0].field, 'address');
  });

  test('with a verified address the entity is EXTENDED: same @id, type unchanged, delta is exactly the address', () => {
    const doc = homePageDoc();
    const contactDoc = pageDoc('/contact', [{ '@context': 'https://schema.org', '@graph': [organizationNode({ address: TEST_ADDRESS_NODE })] }]);
    const ev = evidenceFor({ pages: [doc, contactDoc] });
    const i = ev.organization.intent;
    assert.equal(i.action, 'generate');
    assert.equal(i.mode, 'extend_existing');
    assert.equal(i.type, 'Organization', 'the type is never changed by an address fix');
    assert.equal(i.id, ORG_ID);
    assert.deepEqual(i.delta, [{ field: 'address', kind: 'add' }]);
    assert.deepEqual(ev.organization.contact.address, TEST_ADDRESS_NODE);
    assert.equal(ev.organization.factSources.address, 'site_entity_markup');
  });

  test('the fingerprint changes when an address becomes available, so an older recommendation is never served', () => {
    const none = evidenceFor();
    const confirmed = evidenceFor({ addressSources: { confirmed: { fields: TEST_ADDRESS } } });
    assert.notEqual(none.fingerprintKey, confirmed.fingerprintKey);
  });

  test('a page whose entity is a complete LocalBusiness is untouched by this workflow', () => {
    const graph = [{ '@context': 'https://schema.org', '@graph': [organizationNode({ '@type': ['Hospital', 'Organization'], address: TEST_ADDRESS_NODE })] }];
    const ev = evidenceFor({ graph });
    assert.equal(ev.organization.intent.addressDemand, undefined);
  });
});
