import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTION_FOR_STATE, applyAddressToEntity, buildOrganizationAddressContract, diffJsonLines, looksLikePlaceholder, mergedEntityScript, validateAddressFixContract,
} from './organizationAddressContract.js';
import { buildOrganizationSections } from './organizationRecommendation.js';
import { applyImageProbes, buildSchemaEvidence, summarizeSchemaEvidence } from '../../schema-evidence/schemaEvidence.js';
import { sanitizeGeneratedSchema } from '../../schema-evidence/schemaOutputGuard.js';
import { analyzeSiteEntity } from '../../schema-evidence/siteEntity.js';
import {
  LOGO_URL, ORG_ID, ORIGIN, OTHER_ADDRESS, TEST_ADDRESS, TEST_ADDRESS_NODE, homePageDoc, organizationNode, pageDoc, probeOk, yoastGraph,
} from '../../schema-evidence/__fixtures__/addressSite.js';

const build = ({ graph = yoastGraph(), pages = null, addressSources = null } = {}) => {
  const doc = homePageDoc(graph);
  const site = analyzeSiteEntity(pages || [doc]);
  const ev = buildSchemaEvidence({ issueId: 'organization_schema', pageUrl: doc.url, pageData: doc, pageType: 'homepage', site, addressSources });
  return applyImageProbes(ev, [probeOk(LOGO_URL)]);
};
const withConfirmed = () => build({ addressSources: { confirmed: { fields: TEST_ADDRESS, confirmedAt: new Date('2026-10-01') } } });
const contractOf = (ev) => buildOrganizationAddressContract({ evidence: ev, projectId: 'project-1' });
const clone = (v) => JSON.parse(JSON.stringify(v));

describe('the contract for "Organization has no address"', () => {
  test('with a confirmed address it is ready, bound to the entity, and requires approval without modifying anything', () => {
    const ev = withConfirmed();
    const c = contractOf(ev);
    assert.equal(c.kind, 'organization_address');
    assert.equal(c.state, 'ready');
    assert.equal(c.action, 'review_and_apply');
    assert.equal(c.missingProperty, 'address');
    assert.equal(c.entity.id, ORG_ID);
    assert.equal(c.context.projectId, 'project-1');
    assert.equal(c.currentState.addressState, 'missing');
    assert.equal(c.currentState.confirmedByEvidence, true);
    assert.equal(c.requiresApproval, true);
    assert.equal(c.modifiesWebsite, false);
    assert.equal(c.proposal.status, 'confirmed_by_owner');
    assert.deepEqual(c.proposal.value, TEST_ADDRESS_NODE);
    assert.ok(c.verification.requires.length >= 4);
    assert.deepEqual(c.validation, { valid: true, errors: [] });
  });

  test('THE EXACT DIFF for the test case: the entity gains an address and nothing else changes (identity, type, logo, sameAs intact)', () => {
    const c = contractOf(withConfirmed());
    assert.deepEqual(c.diff.changes, [{ path: 'address', kind: 'add', before: null, after: TEST_ADDRESS_NODE }]);
    const added = c.diff.lines.filter((l) => l.type === 'add').map((l) => l.text.trim());
    assert.deepEqual(c.diff.lines.filter((l) => l.type === 'remove'), []);
    assert.equal(added[0], '"address": {');
    assert.ok(added.includes('"streetAddress": "14 Lakeview Road",'));
    assert.ok(added.includes('"addressCountry": "IN"'));
    // the unrelated properties are unchanged context lines
    const context = c.diff.lines.filter((l) => l.type === 'context').map((l) => l.text);
    assert.ok(context.some((t) => t.includes(`"@id": "${ORG_ID}"`)));
    assert.ok(context.some((t) => t.includes('"@type": "Organization"')));
    assert.ok(context.some((t) => t.includes('"sameAs"')));
    assert.ok(context.some((t) => t.includes('#/schema/logo/image/')));
    // before is exactly the entity on the page; after is before + address
    assert.equal(c.diff.after.address && Object.keys(c.diff.after).length, Object.keys(c.diff.before).length + 1);
    assert.deepEqual(applyAddressToEntity(c.diff.before, TEST_ADDRESS_NODE), c.diff.after);
  });

  test('the merged-entity script keeps one entity with the same @id', () => {
    const script = mergedEntityScript(contractOf(withConfirmed()));
    const json = JSON.parse(script.replace(/^<script[^>]*>\n?/, '').replace(/\n?<\/script>$/, ''));
    assert.equal(json['@id'], ORG_ID);
    assert.deepEqual(json.address, TEST_ADDRESS_NODE);
    assert.equal(json['@graph'], undefined, 'one entity, not a second graph');
  });

  test('state -> action: ready=Review & Apply, anything needing the owner=Confirm Address, review=Review Changes', () => {
    assert.deepEqual(ACTION_FOR_STATE, { ready: 'review_and_apply', needs_confirmation: 'confirm_address', conflict: 'confirm_address', unavailable: 'confirm_address', needs_review: 'review_changes' });
    const none = contractOf(build());
    assert.equal(none.state, 'unavailable');
    assert.equal(none.action, 'confirm_address');
    assert.equal(none.proposal, null);
    assert.equal(none.diff, null, 'no Apply-able diff exists without an address');
  });

  test('conflicting addresses: both alternatives are carried with their sources, no proposal, Confirm Address', () => {
    const doc = homePageDoc();
    const contact = pageDoc('/contact', [{ '@context': 'https://schema.org', '@graph': [organizationNode({ address: TEST_ADDRESS_NODE })] }]);
    const other = pageDoc('/about', [{ '@context': 'https://schema.org', '@graph': [{ '@type': 'Place', '@id': `${ORIGIN}/#place`, address: { '@type': 'PostalAddress', ...OTHER_ADDRESS } }, organizationNode({ location: { '@id': `${ORIGIN}/#place` } })] }]);
    const c = contractOf(build({ pages: [doc, contact, other] }));
    assert.equal(c.state, 'conflict');
    assert.equal(c.action, 'confirm_address');
    assert.equal(c.evidence.alternatives.length, 2);
    assert.equal(c.proposal, null);
  });

  test('several Organization entities -> needs_review (Review Changes), nothing proposed', () => {
    const dup = [{ '@context': 'https://schema.org', '@graph': [organizationNode(), organizationNode({ name: 'Eye Hospital Test Site (copy)' })] }];
    const c = contractOf(build({ graph: dup, addressSources: { confirmed: { fields: TEST_ADDRESS } } }));
    assert.equal(c.state, 'needs_review');
    assert.equal(c.action, 'review_changes');
    assert.equal(c.proposal, null);
  });

  test('not an address finding (a complete address already present) -> no contract', () => {
    const ev = build({ graph: yoastGraph({ address: TEST_ADDRESS_NODE }) });
    assert.equal(contractOf(ev), null);
  });

  test('the browser summary carries the contract; the evidence summary never carries raw nodes', () => {
    const ev = withConfirmed();
    const s = summarizeSchemaEvidence(ev);
    assert.equal(s.organization.address.state, 'ready');
    assert.equal(JSON.stringify(s.organization).includes('"node"'), false);
  });
});

describe('validation rejects malformed or unsafe proposals (nothing unvalidated is ever offered)', () => {
  const ready = () => { const ev = withConfirmed(); return { ev, c: clone(contractOf(ev)) }; };
  const errorsFor = (mutate) => { const { ev, c } = ready(); mutate(c); return validateAddressFixContract(c, ev).errors.join(' | '); };

  test('a valid contract passes', () => {
    const { ev, c } = ready();
    assert.deepEqual(validateAddressFixContract(c, ev), { valid: true, errors: [] });
  });

  test('placeholder text is rejected (the brief\'s own examples included)', () => {
    for (const bad of ['Verified street address', 'Your street here', 'N/A', 'TBD', '[street]', '<street>', '123 Main St', 'Lorem ipsum']) {
      assert.equal(looksLikePlaceholder(bad), true, bad);
    }
    for (const good of ['City Centre Mall, Block B', 'The Mall Road', '14 Lakeview Road', 'Rivertown']) assert.equal(looksLikePlaceholder(good), false, good);
    assert.match(errorsFor((c) => { c.proposal.value.streetAddress = 'Verified street address'; c.diff.after.address.streetAddress = 'Verified street address'; }), /placeholder/);
  });

  test('a value no source supplied is rejected, however well-formed (fabricated street / postal code / locality / country)', () => {
    for (const [field, value] of [['streetAddress', '77 Invented Avenue'], ['postalCode', '999999'], ['addressLocality', 'Faketown'], ['addressCountry', 'FR']]) {
      const msg = errorsFor((c) => { c.proposal.value[field] = value; c.diff.after.address[field] = value; });
      assert.match(msg, new RegExp(`"${field}" \\(".*"\\) is not supported by any verified source`), field);
    }
  });

  test('an unknown property inside the address, or a non-string value, is rejected', () => {
    assert.match(errorsFor((c) => { c.proposal.value.geo = '12,34'; c.diff.after.address.geo = '12,34'; }), /Unexpected property "geo"/);
    assert.match(errorsFor((c) => { c.proposal.value.postalCode = 560001; c.diff.after.address.postalCode = 560001; }), /must be non-empty text/);
  });

  test('a missing street or city is rejected', () => {
    assert.match(errorsFor((c) => { delete c.proposal.value.streetAddress; delete c.diff.after.address.streetAddress; }), /no streetAddress/);
  });

  test('a change to anything other than address is rejected (@id, type, name, logo, extra property)', () => {
    assert.match(errorsFor((c) => { c.diff.after['@id'] = `${ORIGIN}/#another`; }), /alters properties other than address|@id must not change/);
    assert.match(errorsFor((c) => { c.diff.after['@type'] = 'LocalBusiness'; }), /alters properties other than address|type must not change/);
    assert.match(errorsFor((c) => { c.diff.after.name = 'Renamed'; }), /alters properties other than address/);
    assert.match(errorsFor((c) => { delete c.diff.after.logo; }), /alters properties other than address/);
    assert.match(errorsFor((c) => { c.diff.after.telephone = '+000'; }), /alters properties other than address/);
  });

  test('a "before" that is not the entity currently on the page is rejected (stale / forged)', () => {
    assert.match(errorsFor((c) => { c.diff.before.name = 'Something else'; c.diff.after.name = 'Something else'; }), /not the entity currently on the page/);
  });

  test('an unverified status, a missing value, or a change that modifies the site is rejected', () => {
    assert.match(errorsFor((c) => { c.proposal.status = 'uncertain'; }), /not verified or confirmed/);
    assert.match(errorsFor((c) => { c.proposal.value = null; }), /must carry an address value/);
    assert.match(errorsFor((c) => { c.modifiesWebsite = true; }), /must not modify the website/);
    assert.match(errorsFor((c) => { c.requiresApproval = false; }), /require approval/);
    assert.match(errorsFor((c) => { c.diff.changes.push({ path: 'logo' }); }), /exactly the address/);
  });

  test('an invalid proposal downgrades the contract to Review Changes with no diff — no Apply can be offered', () => {
    const ev = withConfirmed();
    ev.organization.address.proposal.value.streetAddress = '77 Invented Avenue'; // simulate a corrupted/forged proposal
    const c = contractOf(ev);
    assert.equal(c.state, 'needs_review');
    assert.equal(c.action, 'review_changes');
    assert.equal(c.diff, null);
    assert.equal(c.proposal.status, 'rejected');
    assert.equal(c.validation.valid, false);
  });

  test('a model-written address that no source supports is stripped by the output guard (the AI path cannot publish one)', () => {
    const ev = build();
    const modelOutput = { '@context': 'https://schema.org', '@type': 'Organization', '@id': ORG_ID, name: 'Eye Hospital Test Site', url: `${ORIGIN}/`, address: { '@type': 'PostalAddress', streetAddress: '1 Fabricated Way', addressLocality: 'Nowhere' } };
    const { schema, removed } = sanitizeGeneratedSchema(modelOutput, ev);
    const org = Array.isArray(schema) ? schema[0] : schema;
    assert.equal(org.address, undefined);
    assert.ok(removed.some((r) => r.field === 'address'));
  });
});

describe('the recommendation text speaks about the missing address, not about duplicates', () => {
  test('REGRESSION: the reported "A second copy would create a duplicate entity" text is gone for an address finding', () => {
    for (const ev of [build(), withConfirmed()]) {
      const s = buildOrganizationSections(ev);
      const all = JSON.stringify(s);
      assert.doesNotMatch(all, /second copy would create a duplicate/i);
      assert.doesNotMatch(all, /no new .* markup is needed here/i);
      assert.match(s.whyThisMatters, /address/i);
      assert.match(s.recommendedFix, /address property of your existing Organization/);
    }
  });

  test('ready: names each value with its source, keeps the entity, shows the merged entity, and states nothing was deployed', () => {
    const s = buildOrganizationSections(withConfirmed());
    assert.match(s.recommendedFix, /street: 14 Lakeview Road — from confirmed by you in ODITO/);
    assert.match(s.recommendedFix, /Do NOT add a second Organization block/);
    assert.match(s.recommendedFix, /does not change your website/);
    assert.match(s.implementationExample.content, /REPLACE your existing Organization/);
    assert.match(s.implementationExample.content, /"@id": "https:\/\/eye-hospital\.example\/#organization"/);
    assert.equal(s.sourceAttribution.contextSources.schemaAction, 'generate');
    assert.deepEqual(s.sourceAttribution.contextSources.schemaAddress.fields, TEST_ADDRESS);
    assert.equal(s.sourceAttribution.contextSources.llmUsed, false);
    assert.equal(JSON.parse(s.recommendedVersion).address.streetAddress, '14 Lakeview Road');
  });

  test('no address anywhere: asks for it, shows no markup, and says nothing was guessed', () => {
    const s = buildOrganizationSections(build());
    assert.match(s.recommendedFix, /ODITO needs your confirmation of the full address/);
    assert.match(s.recommendedFix, /Nothing was guessed/);
    assert.match(s.implementationExample.content, /no markup is shown yet/);
    assert.equal(s.sourceAttribution.contextSources.schemaAction, 'needs_input');
    assert.equal(s.sourceAttribution.contextSources.schemaAddress.fields, null);
  });

  test('conflict: lists every alternative with its source', () => {
    const doc = homePageDoc();
    const contact = pageDoc('/contact', [{ '@context': 'https://schema.org', '@graph': [organizationNode({ address: TEST_ADDRESS_NODE })] }]);
    const other = pageDoc('/about', [{ '@context': 'https://schema.org', '@graph': [{ '@type': 'Place', '@id': `${ORIGIN}/#place`, address: { '@type': 'PostalAddress', ...OTHER_ADDRESS } }, organizationNode({ location: { '@id': `${ORIGIN}/#place` } })] }]);
    const s = buildOrganizationSections(build({ pages: [doc, contact, other] }));
    assert.match(s.recommendedFix, /Different addresses were found/);
    assert.match(s.recommendedFix, /14 Lakeview Road/);
    assert.match(s.recommendedFix, /9 Harbour Street/);
  });

  test('diffJsonLines is deterministic', () => {
    const a = { a: 1, b: { c: 2 } };
    const b = { a: 1, b: { c: 2 }, d: 3 };
    assert.deepEqual(diffJsonLines(a, b), diffJsonLines(clone(a), clone(b)));
    assert.deepEqual(diffJsonLines(a, a).filter((l) => l.type !== 'context'), []);
  });
});
