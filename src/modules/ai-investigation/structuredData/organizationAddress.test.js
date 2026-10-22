import test from 'node:test';
import assert from 'node:assert/strict';
import { collectEvidence } from '../evidence/evidenceCollector.js';
import { resolveInvestigationPlan } from '../evidence/investigationPlans.js';
import { validateModelOutput, scanPlaceholders } from '../contract/investigationContract.js';
import { validatePostChangeDocument } from './organizationAddressAnalyzer.js';
import { resolveFixCapabilities } from '../capabilities/fixCapabilities.js';
import { deriveLifecycle } from '../service/lifecycleService.js';
import { createApprovalService } from '../service/approvalService.js';
import { InvestigationRunner } from '../service/investigationOrchestrator.js';
import { validateConfirmedAddressInput } from '../../schema-evidence/organizationAddress.js';
import { addressHashOf } from '../../schema-evidence/organizationAddressStore.js';
import { SITE, PROJECT, ELIGIBLE, NOT_SUPPORTED, fakeFetcher, fakeLlm, makeDeps, goodAnswer, waitFor } from '../testKit.js';

const HOME = `${SITE}/`;
const ORG_ID = `${SITE}/#organization`;
const ISSUE = { issueId: 'organization_schema', pageUrl: HOME, title: 'Organization schema incomplete - missing recommended fields: address', category: 'Structured Data' };
const graph = ({ org = {}, extra = [], context = true } = {}) => ({
  ...(context ? { '@context': 'https://schema.org' } : {}),
  '@graph': [
    { '@type': 'Organization', '@id': ORG_ID, name: 'Sapphire Digital Agency', url: SITE, logo: { '@type': 'ImageObject', url: `${SITE}/logo.png` }, sameAs: ['https://www.facebook.com/sapphire'], ...org },
    { '@type': 'WebSite', '@id': `${SITE}/#website`, url: SITE, name: 'Sapphire', publisher: { '@id': ORG_ID } },
    { '@type': 'WebPage', '@id': `${SITE}/#webpage`, url: HOME, name: 'Home' },
    ...extra,
  ],
});
const rmPage = (doc, { cls = 'rank-math-schema', more = '' } = {}) => `<!doctype html><html lang="en"><head><title>Home</title><link rel="canonical" href="${HOME}"><script type="application/ld+json" class="${cls}">${JSON.stringify(doc)}</script>${more}</head><body><header><nav><ul><li><a href="/about-us">About</a></li></ul></nav></header><main><h1>Home</h1></main></body></html>`;
const CONFIRMED_FIELDS = { streetAddress: '12 Harbour Road', addressLocality: 'Mumbai' };
const confirmedRecord = (fields = CONFIRMED_FIELDS, over = {}) => ({ fields, basis: 'typed', confirmedAt: '2026-10-20T10:00:00.000Z', confirmedBy: 'u1', revision: 1, addressHash: addressHashOf(fields), source: 'user_provided', state: 'confirmed_by_user', verifiedExternally: false, website: SITE, issueId: 'organization_schema', entityId: ORG_ID, ...over });
const placesPartial = { siteUrl: SITE, verifiedBusiness: { placeId: 'x', name: 'Sapphire', address: 'new york', city: 'new york' } };

async function analyse({ doc = graph(), page = rmPage(doc), addressSources = null, over = {} } = {}) {
  const iss = { ...ISSUE };
  const deps = makeDeps({ fetcher: fakeFetcher({ [HOME]: { body: page } }), loadSiblings: async () => [], loadAddressContext: async () => ({ site: null, profile: null, addressSources }), ...over });
  const ledger = await collectEvidence({ project: PROJECT, issue: iss, plan: resolveInvestigationPlan(iss), deps });
  const analysis = ledger.items.find((i) => i.kind === 'structured_analysis' && i.data?.analyzerId === 'organization_address');
  return { ledger, analysis, data: analysis?.data };
}
const validate = (ledger, over = {}, caps = ELIGIBLE) => validateModelOutput(goodAnswer({
  issueStatus: 'confirmed', findings: [{ statement: 'The Organization entity has no address.', basis: 'observed', absence: true, evidenceIds: [ledger.first('page').id] }], evidence: [{ evidenceId: ledger.first('page').id, finding: 'no address' }],
  proposedChanges: [], codeOrConfiguration: [], ...over,
}), { ledger, capabilities: caps, pageUrl: HOME, siteUrl: PROJECT.siteUrl });
const check = (v, id) => v.value.safetyChecks.find((c) => c.id === id);

// ── 1. missing address, nothing confirmed ──────────────────────────────────────────────────
test('missing Organization address, no confirmed address: entity recognised, NO publishable payload, blockers are explicit, nothing is invented', async () => {
  const { ledger, data } = await analyse({ addressSources: { confirmed: null, project: null, owner: null } });
  assert.equal(data.entity.id, ORG_ID);
  assert.equal(data.entity.publishedBy, 'rank_math');
  assert.equal(data.entity.idIsRankMathOrganization, true);
  assert.equal(data.existingAddress.state, 'missing');
  assert.equal(data.publishable, false);
  assert.equal(data.proposal, null);
  assert.deepEqual(data.minimumRequired, ['streetAddress', 'addressLocality']);
  assert.ok(data.blockers.some((b) => b.code === 'ADDRESS_UNCONFIRMED' && /street address and city are required/.test(b.action)));
  assert.equal(data.confirmation.state, 'none');
  assert.match(data.guidance.schemaOrg, /OPTIONAL/);
  assert.match(data.guidance.searchEngines, /recommended property, not a required one/);
  const v = validate(ledger);
  assert.equal(v.value.proposalState.status, 'awaiting_information');
  assert.deepEqual(v.value.codeOrConfiguration, []);
  assert.deepEqual(v.value.proposedChanges, []);
  assert.equal(v.value.automaticFixEligibility.eligible, false);
  assert.ok(v.value.automaticFixEligibility.blockers.includes('ADDRESS_UNCONFIRMED'));
});

test('the model\'s own draft (placeholder PHP, JSON-LD without @context) is DISCARDED when the address is unknown: no payload, the discard is recorded', async () => {
  const { ledger } = await analyse({ addressSources: null });
  const draft = {
    codeOrConfiguration: [
      { language: 'php', purpose: 'inject', content: "$data['Organization']['address'] = [ 'streetAddress' => '[STREET ADDRESS]', 'addressLocality' => '[CITY]' ]; // Replace ALL placeholder values" },
      { language: 'json-ld', purpose: 'example', content: JSON.stringify({ '@type': 'PostalAddress', streetAddress: 'VERIFIED STREET ADDRESS', addressLocality: 'new york' }) },
    ],
    proposedChanges: [{ changeType: 'add', target: { url: HOME }, after: '{"streetAddress":"[STREET ADDRESS]"}', description: 'add address' }],
    automaticFixEligibility: { eligible: true },
  };
  const v = validate(ledger, draft);
  assert.deepEqual(v.value.codeOrConfiguration, []);
  assert.deepEqual(v.value.proposedChanges, []);
  assert.equal(v.value.discardedModelProposal.length, 1);
  assert.deepEqual([v.value.discardedModelProposal[0].codeBlocks, v.value.discardedModelProposal[0].changes], [2, 1]);
  assert.match(v.value.discardedModelProposal[0].reason, /Withheld/);
  assert.equal(v.value.lifecycle.fixProposed, false);
  assert.equal(v.value.lifecycle.proposalState, 'awaiting_information');
  assert.equal(v.value.automaticFixEligibility.eligible, false);
  assert.ok(!JSON.stringify(v.value).includes('[STREET ADDRESS]'), 'no placeholder text reaches the result');
  assert.ok(!JSON.stringify(v.value.implementationPlan).includes('[STREET'));
});

// ── 2. Google Places "new york" ──────────────────────────────────────────────────────────
test('an incomplete Google Places result ("new york", no website) is shown as UNVERIFIED and unusable; it never fills address fields', async () => {
  const { ledger, data } = await analyse({ addressSources: { confirmed: null, project: placesPartial, owner: null } });
  const places = data.candidates.find((c) => c.source === 'verified_business');
  assert.ok(places);
  assert.equal(places.trust, 'unverified');
  assert.match(places.trustLabel, /Unverified/);
  assert.equal(places.usable, false);
  assert.match(places.notUsableBecause, /no website/);
  assert.equal(places.sourceLabel, 'the business you selected when creating this project (Google Places)');
  assert.deepEqual(places.fields, { addressLocality: 'new york' }, 'only what the source holds: no street, region, postal code or country was inferred');
  assert.equal(data.proposal, null);
  assert.equal(data.publishable, false);
  const msg = data.blockers.find((b) => b.code === 'ADDRESS_UNCONFIRMED').message;
  assert.match(msg, /not verified for this website/);
  assert.match(msg, /needs streetAddress and addressLocality|incomplete/);
  assert.equal(validate(ledger).value.proposalState.status, 'awaiting_information');
});

test('a Places listing for a DIFFERENT website, and a same-site listing that still lacks a street, are both unusable', async () => {
  const other = await analyse({ addressSources: { confirmed: null, project: { siteUrl: SITE, verifiedBusiness: { name: 'Other', address: '1 Other St, Delhi', city: 'Delhi', website: 'https://other-brand.example' } }, owner: null } });
  assert.match(other.data.candidates[0].notUsableBecause, /different site/);
  assert.equal(other.data.publishable, false);
  const sameSiteNoStreet = await analyse({ addressSources: { confirmed: null, project: { siteUrl: SITE, verifiedBusiness: { name: 'Sapphire', address: 'Mumbai', city: 'Mumbai', website: SITE } }, owner: null } });
  const c = sameSiteNoStreet.data.candidates[0];
  assert.equal(c.usable, false);
  assert.match(c.notUsableBecause, /missing streetAddress/);
  assert.equal(sameSiteNoStreet.data.publishable, false);
});

// ── 3. user-confirmed complete address ────────────────────────────────────────────────────
test('a user-confirmed complete address: the server builds a minimal change for the EXISTING entity, labelled as a user assertion, validated on the page\'s JSON-LD document', async () => {
  const { ledger, data } = await analyse({ addressSources: { confirmed: confirmedRecord(), project: placesPartial, owner: null } });
  assert.equal(data.publishable, true);
  assert.equal(data.confirmation.state, 'confirmed_by_user');
  assert.equal(data.confirmation.verifiedExternally, false);
  assert.equal(data.confirmation.boundToThisWebsite, true);
  assert.deepEqual(data.proposal.fields, CONFIRMED_FIELDS, 'only the confirmed fields: region/postal code/country are NOT invented');
  assert.equal(data.proposal.value['@type'], 'PostalAddress');
  assert.match(data.proposal.basisLabel, /user assertion — not independently verified/);
  assert.equal(data.proposal.entityId, ORG_ID);
  const after = data.proposal.entityAfter;
  assert.equal(after['@id'], ORG_ID);
  assert.equal(after.name, 'Sapphire Digital Agency');
  assert.deepEqual(after.sameAs, ['https://www.facebook.com/sapphire']);
  assert.ok(data.validation.postChange.valid);
  assert.deepEqual(data.validation.postChange.checks.map((c) => [c.name, c.passed]), [['entity_found_once', true], ['context_present', true], ['no_second_organization_entity', true], ['only_address_changed', true], ['valid_postal_address', true], ['no_placeholders', true]]);

  const v = validate(ledger);
  assert.equal(v.value.proposalState.status, 'publishable');
  assert.equal(v.value.codeOrConfiguration.length, 1);
  const block = v.value.codeOrConfiguration[0];
  assert.equal(block.language, 'json-fragment');
  assert.equal(block.serverOwned, true);
  assert.match(block.purpose, /EXISTING Organization node/);
  assert.match(block.purpose, /competing Organization entity/);
  assert.deepEqual(JSON.parse(block.content), { address: { '@type': 'PostalAddress', streetAddress: '12 Harbour Road', addressLocality: 'Mumbai' } });
  assert.ok(!/"@context"/.test(block.content), 'a fragment of an existing node: @context stays on the page document');
  assert.equal(v.value.lifecycle.fixProposed, true);
  assert.equal(v.value.automaticFixEligibility.eligible, true);
  assert.deepEqual(v.value.automaticFixEligibility.requirements.map((r) => [r.code, r.met]), [['EVIDENCE_SUPPORTS_ISSUE', true], ['CONFIRMED_COMPLETE_INPUT', true], ['VALID_PROPOSAL', true], ['NO_CONFLICTING_MARKUP', true], ['CMS_CAPABILITY', true], ['PROPOSAL_FINGERPRINT_CURRENT', true], ['USER_APPROVAL', false]]);
  assert.match(v.value.recommendedSolution.routeNote, /LIKELY route/);
  assert.match(v.value.implementationPlan[0].detail, /Likely route: Rank Math → Titles & Meta → Local SEO/);
  assert.match(v.value.implementationPlan[0].detail, /Odito has not verified it/);
});

test('confirmed and complete, but the site has no supported adapter: the change is still proposed (manually), eligibility is false with the reason and blocker code', async () => {
  const { ledger } = await analyse({ addressSources: { confirmed: confirmedRecord(), project: null, owner: null } });
  const v = validate(ledger, {}, { ...NOT_SUPPORTED });
  assert.equal(v.value.lifecycle.fixProposed, true);
  assert.equal(v.value.automaticFixEligibility.eligible, false);
  assert.ok(v.value.automaticFixEligibility.blockers.includes('NO_AUTOMATIC_ADAPTER'));
  assert.equal(check(v, 'automatic_fix_capability').status, 'blocked');
  assert.match(check(v, 'automatic_fix_capability').action, /manual steps/);
  assert.ok(v.value.implementationPlan.length >= 3);
});

test('address confirmation input: street and city required, placeholders and markup refused, optional fields are never filled in', () => {
  assert.deepEqual(validateConfirmedAddressInput({ streetAddress: '  12 Harbour   Road ', addressLocality: 'Mumbai' }).fields, { streetAddress: '12 Harbour Road', addressLocality: 'Mumbai' });
  assert.throws(() => validateConfirmedAddressInput({ streetAddress: '12 Harbour Road' }), (e) => e.field === 'addressLocality');
  assert.throws(() => validateConfirmedAddressInput({ addressLocality: 'Mumbai' }), (e) => e.field === 'streetAddress');
  assert.throws(() => validateConfirmedAddressInput({ streetAddress: '[STREET ADDRESS]', addressLocality: 'Mumbai' }), (e) => e.field === 'streetAddress');
  assert.throws(() => validateConfirmedAddressInput({ streetAddress: 'Your street here', addressLocality: 'Mumbai' }), (e) => /placeholder/.test(e.message));
  assert.throws(() => validateConfirmedAddressInput({ streetAddress: '123 Main St', addressLocality: 'Mumbai' }), (e) => /placeholder/.test(e.message));
  assert.throws(() => validateConfirmedAddressInput({ streetAddress: '<script>x</script>', addressLocality: 'Mumbai' }), (e) => e.field === 'streetAddress');
  assert.throws(() => validateConfirmedAddressInput({ streetAddress: '12 Harbour Road', addressLocality: 'n/a' }), (e) => e.field === 'addressLocality');
  assert.deepEqual(validateConfirmedAddressInput({ streetAddress: '12 Harbour Road', addressLocality: 'Mumbai', evil: 'x', '@id': 'y' }).fields, { streetAddress: '12 Harbour Road', addressLocality: 'Mumbai' }, 'unknown keys are ignored');
});

test('a confirmation given for ANOTHER website is not evidence for this one', async () => {
  const { data } = await analyse({ addressSources: { confirmed: confirmedRecord(CONFIRMED_FIELDS, { website: 'https://another-site.example' }), project: { siteUrl: SITE }, owner: null } });
  assert.equal(data.publishable, false);
  assert.equal(data.confirmation.boundToThisWebsite, false);
  assert.ok(data.blockers.some((b) => b.code === 'CONFIRMATION_FOR_OTHER_WEBSITE'));
});

// ── 4/5. @context, placeholders ──────────────────────────────────────────────────────────
test('JSON-LD document without @context: the change is NOT proposed (validated on the document it would live in)', async () => {
  const { ledger, data } = await analyse({ doc: graph({ context: false }), addressSources: { confirmed: confirmedRecord(), project: null, owner: null } });
  assert.equal(data.publishable, false);
  assert.ok(data.blockers.some((b) => b.code === 'PROPOSAL_FAILED_VALIDATION' && /@context/.test(b.message)));
  assert.equal(data.validation.postChange.checks.find((c) => c.name === 'context_present').passed, false);
  const v = validate(ledger);
  assert.deepEqual(v.value.codeOrConfiguration, []);
  assert.equal(v.value.automaticFixEligibility.eligible, false);
  assert.equal(check(v, 'post_change_document_valid').status, 'failed');
});

test('validatePostChangeDocument: unambiguous single node, context at document level, only address changes, no placeholders, valid PostalAddress', () => {
  const doc = graph();
  const ok = validatePostChangeDocument({ before: doc, entityId: ORG_ID, address: { '@type': 'PostalAddress', ...CONFIRMED_FIELDS } });
  assert.equal(ok.valid, true);
  assert.equal(doc['@graph'][0].address, undefined, 'the original document is never mutated');
  const twice = graph({ extra: [{ '@type': 'Organization', '@id': ORG_ID, name: 'Dup' }] });
  assert.equal(validatePostChangeDocument({ before: twice, entityId: ORG_ID, address: { '@type': 'PostalAddress', ...CONFIRMED_FIELDS } }).valid, false);
  assert.equal(validatePostChangeDocument({ before: doc, entityId: ORG_ID, address: { '@type': 'PostalAddress', streetAddress: '[STREET ADDRESS]', addressLocality: 'X' } }).valid, false);
  assert.equal(validatePostChangeDocument({ before: doc, entityId: ORG_ID, address: { '@type': 'PostalAddress', streetAddress: '12 Harbour Road' } }).valid, false, 'no city');
  assert.equal(validatePostChangeDocument({ before: doc, entityId: `${SITE}/#nope`, address: { '@type': 'PostalAddress', ...CONFIRMED_FIELDS } }).valid, false, 'entity not in the document');
  assert.equal(validatePostChangeDocument({ before: null, entityId: ORG_ID, address: {} }).valid, false);
});

test('a stored confirmation that contains placeholder text (legacy record) is refused by the proposal contract', async () => {
  const bad = { streetAddress: '123 Main Street', addressLocality: 'Springfield' };
  const { data } = await analyse({ addressSources: { confirmed: confirmedRecord(bad), project: null, owner: null } });
  assert.equal(data.publishable, false);
  assert.ok(data.blockers.some((b) => b.code === 'PROPOSAL_FAILED_VALIDATION'), JSON.stringify(data.blockers));
  assert.equal(data.proposal, null);
});

test('placeholder scan: placeholders in ANY proposed code or change make a non-server-owned proposal blocked, not publishable', () => {
  assert.deepEqual(scanPlaceholders([{ content: "'streetAddress' => '[STREET ADDRESS]'" }], []), ['[STREET ADDRESS]']);
  assert.ok(scanPlaceholders([{ content: 'Replace ALL placeholder values' }], []).length);
  assert.ok(scanPlaceholders([], [{ after: 'YOUR_CITY', before: null, description: '' }]).length);
  assert.deepEqual(scanPlaceholders([{ content: JSON.stringify({ streetAddress: '12 Harbour Road' }) }], [{ after: '12 Harbour Road', before: null, description: 'Add address' }]), []);
});

// ── 6. duplicate Organization ────────────────────────────────────────────────────────────
test('duplicate / competing Organization entities: the right one cannot be identified; nothing is proposed even with a confirmed address', async () => {
  const doc = graph({ extra: [{ '@type': 'Organization', '@id': `${SITE}/#another-organization`, name: 'Sapphire (theme)', url: SITE }] });
  const { ledger, data } = await analyse({ doc, addressSources: { confirmed: confirmedRecord(), project: null, owner: null } });
  assert.equal(data.publishable, false);
  assert.ok(data.blockers.some((b) => b.code === 'DUPLICATE_ORGANIZATION_ENTITY'));
  const v = validate(ledger);
  assert.equal(check(v, 'entity_identified_once').status, 'failed');
  assert.deepEqual(v.value.codeOrConfiguration, []);
  assert.equal(v.value.automaticFixEligibility.eligible, false);
});

test('an address the entity ALREADY has is never overwritten: nothing to propose', async () => {
  const { ledger, data } = await analyse({ doc: graph({ org: { address: { '@type': 'PostalAddress', streetAddress: '1 Existing Rd', addressLocality: 'Pune' } } }), addressSources: { confirmed: confirmedRecord(), project: null, owner: null } });
  assert.equal(data.status, 'no_change');
  assert.equal(data.publishable, false);
  const v = validateModelOutput(goodAnswer({ issueStatus: 'already_resolved', proposedChanges: [], codeOrConfiguration: [], findings: [{ statement: 'The entity already has an address.', basis: 'observed', evidenceIds: [ledger.first('page').id] }] }), { ledger, capabilities: ELIGIBLE, pageUrl: HOME, siteUrl: PROJECT.siteUrl });
  assert.equal(v.value.proposalState.status, 'none');
  assert.equal(v.value.lifecycle.fixProposed, false);
});

// ── honest unknowns are not blocking failures ────────────────────────────────────────────
test('an honestly acknowledged unknown ("the address is not in the evidence") is NOT a failed check; an overclaimed absence IS', async () => {
  const { ledger } = await analyse({ addressSources: null });
  const pageId = ledger.first('page').id;
  const honest = validate(ledger, { findings: [{ statement: 'The business address is not available in the evidence.', basis: 'unknown', absence: true, evidenceIds: [] }, { statement: 'The Organization has no address.', basis: 'observed', absence: true, evidenceIds: [pageId] }] });
  assert.equal(check(honest, 'absence_claims_established').status, 'passed');
  assert.match(check(honest, 'absence_claims_established').detail, /acknowledged unknowns/);
  const over = validate(ledger, { findings: [{ statement: 'There is definitely no address anywhere on the site.', basis: 'observed', absence: true, evidenceIds: [ledger.first('detector').id] }] });
  assert.equal(check(over, 'absence_claims_established').status, 'failed');
});

// ── checks: records, labels, not_run ─────────────────────────────────────────────────────
test('every check is a record with id, label, status, detail and (when blocked) an action; nothing is empty; not-run checks are labelled not_run', async () => {
  const { ledger } = await analyse({ addressSources: { confirmed: null, project: placesPartial, owner: null } });
  const v = validate(ledger);
  const checks = v.value.safetyChecks;
  assert.ok(checks.length >= 8);
  for (const c of checks) {
    assert.ok(c.id && c.name === c.id && c.label && c.detail, JSON.stringify(c));
    assert.ok(['passed', 'failed', 'blocked', 'not_run'].includes(c.status));
    assert.equal(c.passed, c.status === 'passed');
  }
  for (const id of ['urls_backed_by_evidence', 'markup_syntactically_valid', 'no_duplicate_markup', 'no_unresolved_placeholders', 'post_change_document_valid']) assert.equal(check(v, id).status, 'not_run', id);
  assert.equal(check(v, 'address_confirmed_and_complete').status, 'blocked');
  assert.ok(check(v, 'address_confirmed_and_complete').action);
  assert.equal(check(v, 'concrete_proposal_present').status, 'blocked');
  assert.ok(checks.filter((c) => c.status === 'blocked').every((c) => c.action));
  assert.equal(v.value.blockers.filter((b) => b.code === 'NO_PROPOSAL').length, 0, 'the generic code is not repeated next to the specific blocker');
});

// ── 7. capabilities (operation-aware) ────────────────────────────────────────────────────
const CONNECTED = { connected: true, bridgeInstalled: true, ambiguous: false, provider: 'rank_math', organizationAddressSupported: true };
const siteSchema = (org = {}) => async () => ({ supported: true, organization: { kind: 'company', localSeoActive: true, ...org } });
const caps = (integration, schema, operation = 'address') => resolveFixCapabilities({ issueId: 'organization_schema', projectId: 'p', operation }, { loadIntegration: async () => integration, loadSiteSchema: schema });

test('Organization address capability: "WordPress is connected" is not enough — the Bridge, provider, Local SEO module and live settings must all check out', async () => {
  assert.equal((await caps(CONNECTED, siteSchema())).eligibility, 'eligible');
  const noBridgeAddr = await caps({ ...CONNECTED, organizationAddressSupported: false }, siteSchema());
  assert.equal(noBridgeAddr.eligibility, 'requires_integration_setup');
  assert.ok(noBridgeAddr.missingCapabilities.includes('odito_seo_bridge_organization_address'));
  const yoast = await caps({ ...CONNECTED, provider: 'yoast' }, siteSchema());
  assert.ok(yoast.missingCapabilities.includes('seo_plugin_rank_math'));
  const localOff = await caps(CONNECTED, siteSchema({ localSeoActive: false }));
  assert.ok(localOff.missingCapabilities.includes('rank_math_local_seo_module'));
  const person = await caps(CONNECTED, siteSchema({ kind: 'person' }));
  assert.ok(person.missingCapabilities.includes('rank_math_company_entity'));
  const unreadable = await caps(CONNECTED, async () => { throw new Error('boom'); });
  assert.equal(unreadable.eligibility, 'requires_integration_setup');
  assert.ok(unreadable.missingCapabilities.includes('rank_math_site_settings_unreadable'), 'unverified Local SEO state is NOT assumed ok');
  const notConnected = await caps({ connected: false }, siteSchema());
  assert.deepEqual(notConnected.missingCapabilities, ['wordpress_connection']);
  assert.ok(notConnected.operations[0].includes('address'));
  // without an operation the older behaviour is unchanged
  assert.equal((await resolveFixCapabilities({ issueId: 'organization_schema', projectId: 'p' }, { loadIntegration: async () => ({ ...CONNECTED, organizationAddressSupported: false }) })).eligibility, 'eligible');
});

test('blocker codes for capability gaps reach the result (WORDPRESS_NOT_CONNECTED, BRIDGE_ADDRESS_UNSUPPORTED, LOCAL_SEO_MODULE_OFF)', async () => {
  const { ledger } = await analyse({ addressSources: { confirmed: confirmedRecord(), project: null, owner: null } });
  const notConn = validate(ledger, {}, await caps({ connected: false }, siteSchema()));
  assert.ok(notConn.value.blockers.some((b) => b.code === 'WORDPRESS_NOT_CONNECTED' && b.category === 'capability'));
  const noAddr = validate(ledger, {}, await caps({ ...CONNECTED, organizationAddressSupported: false }, siteSchema()));
  assert.ok(noAddr.value.blockers.some((b) => b.code === 'BRIDGE_ADDRESS_UNSUPPORTED'));
  const off = validate(ledger, {}, await caps(CONNECTED, siteSchema({ localSeoActive: false })));
  assert.ok(off.value.blockers.some((b) => b.code === 'LOCAL_SEO_MODULE_OFF'));
  assert.equal(off.value.lifecycle.fixProposed, true, 'the change itself is still a valid proposal (manual route)');
  assert.equal(off.value.automaticFixEligibility.eligible, false);
});

// ── lifecycle stages ─────────────────────────────────────────────────────────────────────
const inv = (over = {}, resultOver = {}) => ({ _id: 'i1', createdAt: '2026-10-21T10:00:00.000Z', result: { proposalState: { status: 'awaiting_information' }, blockers: [{ code: 'ADDRESS_UNCONFIRMED', message: 'm', action: 'a', category: 'information' }], lifecycle: { fixProposed: false }, proposal: { fingerprint: 'fp1' }, ...resultOver }, ...over });

test('lifecycle: generated, blocked/awaiting-information, NOT applied, verification not started — the initial state of this investigation', () => {
  const l = deriveLifecycle({ investigation: inv(), task: null });
  assert.deepEqual(l.stages.recommendation, { state: 'generated' });
  assert.equal(l.stages.proposal.state, 'awaiting_information');
  assert.equal(l.stages.proposal.blockers[0].code, 'ADDRESS_UNCONFIRMED');
  assert.equal(l.stages.approval.state, 'blocked');
  assert.equal(l.stages.application.state, 'not_started');
  assert.equal(l.stages.verification.state, 'not_started');
  assert.deepEqual([l.fixProposed, l.fixApplied, l.fixVerified], [false, false, false]);
  assert.equal(deriveLifecycle({ investigation: inv({}, { proposalState: { status: 'blocked' } }), task: null }).stages.proposal.state, 'blocked');
  assert.equal(deriveLifecycle({ investigation: inv({}, { proposalState: { status: 'none' }, blockers: [] }), task: null }).stages.approval.state, 'not_required');
});

test('lifecycle: proposal available -> awaiting approval -> approved -> used; invalidated approval; application failed; verification pending/failed/verified', () => {
  const publishable = { proposalState: { status: 'publishable' }, blockers: [], lifecycle: { fixProposed: true } };
  const L = (over, task = null) => deriveLifecycle({ investigation: inv(over, publishable), task });
  assert.equal(L({}).stages.proposal.state, 'available');
  assert.equal(L({}).stages.approval.state, 'awaiting');
  assert.equal(L({ approval: { fingerprint: 'fp1' } }).stages.approval.state, 'approved');
  assert.equal(L({ approval: { fingerprint: 'fp1', invalidatedAt: 'x' } }).stages.approval.state, 'invalidated');
  assert.equal(L({ approval: { fingerprint: 'fp1', consumedAt: '2026-10-21T11:00:00.000Z' } }).stages.approval.state, 'used');
  const failed = L({ approval: { fingerprint: 'fp1', lastFailure: { code: 'WRITE_FAILED', message: 'WordPress rejected it', at: 'x' } } });
  assert.equal(failed.stages.application.state, 'failed');
  assert.equal(failed.stages.application.failure.code, 'WRITE_FAILED');
  assert.equal(failed.fixApplied, false);
  const wrote = new Date('2026-10-21T12:00:00.000Z');
  const task = (verification = {}, status = 'implemented') => ({ status, fixHistory: [{ fixApplied: { externalWrite: { system: 'wordpress', field: 'organization_schema', writtenAt: wrote } }, implementedAt: wrote, verification }] });
  const applied = L({ approval: { fingerprint: 'fp1', consumedAt: '2026-10-21T11:00:00.000Z' } }, task());
  assert.deepEqual([applied.stages.application.state, applied.stages.verification.state], ['applied', 'not_started']);
  const pending = L({ approval: { fingerprint: 'fp1', consumedAt: '2026-10-21T11:00:00.000Z' }, lifecycle: { verificationStatus: 'pending', verificationRunId: 'r1' } }, task());
  assert.equal(pending.stages.verification.state, 'pending');
  const vFailed = L({ approval: { fingerprint: 'fp1', consumedAt: '2026-10-21T11:00:00.000Z' } }, task({ verifiedAt: new Date('2026-10-21T13:00:00.000Z'), result: 'reopened' }, 'reopened'));
  assert.equal(vFailed.stages.verification.state, 'failed');
  const verified = L({ approval: { fingerprint: 'fp1', consumedAt: '2026-10-21T11:00:00.000Z' } }, task({ verifiedAt: new Date('2026-10-21T13:00:00.000Z'), result: 'verified_fixed' }, 'verified_fixed'));
  assert.deepEqual([verified.stages.application.state, verified.stages.verification.state], ['applied', 'verified']);
});

test('a NEW investigation cannot inherit applied/verified status from a task bound to a different investigation or proposal', () => {
  const wrote = new Date('2026-10-21T12:00:00.000Z');
  const verifiedTask = (binding) => ({ status: 'verified_fixed', investigationBinding: binding, fixHistory: [{ implementedAt: wrote, fixApplied: { externalWrite: { system: 'wordpress', field: 'organization_schema', writtenAt: wrote } }, verification: { verifiedAt: new Date('2026-10-21T13:00:00.000Z'), result: 'verified_fixed' } }] });
  const publishable = { proposalState: { status: 'publishable' }, blockers: [], proposal: { fingerprint: 'NEW' }, lifecycle: { fixProposed: true } };
  const other = deriveLifecycle({ investigation: inv({ _id: 'i2', createdAt: '2026-10-21T09:00:00.000Z' }, publishable), task: verifiedTask({ investigationId: 'i1', fingerprint: 'OLD' }) });
  assert.deepEqual([other.fixApplied, other.fixVerified, other.stages.application.state, other.stages.verification.state], [false, false, 'not_started', 'not_started']);
  const sameInvDifferentProposal = deriveLifecycle({ investigation: inv({ _id: 'i2', createdAt: '2026-10-21T09:00:00.000Z' }, publishable), task: verifiedTask({ investigationId: 'i2', fingerprint: 'OLD' }) });
  assert.equal(sameInvDifferentProposal.fixVerified, false);
  const mine = deriveLifecycle({ investigation: inv({ _id: 'i2', createdAt: '2026-10-21T09:00:00.000Z' }, publishable), task: verifiedTask({ investigationId: 'i2', fingerprint: 'NEW' }) });
  assert.deepEqual([mine.fixApplied, mine.fixVerified], [true, true]);
});

// ── 8. proposal / confirmation changed after approval ────────────────────────────────────
async function approvedSetup({ confirmedNow }) {
  const confirmed = { current: confirmedRecord() };
  const deps = makeDeps({ fetcher: fakeFetcher({ [HOME]: { body: rmPage(graph()) } }), llm: fakeLlm([goodAnswer({ issueStatus: 'confirmed', findings: [{ statement: 'no address', basis: 'observed', absence: true, evidenceIds: ['E3'] }], proposedChanges: [], codeOrConfiguration: [] })]), resolveCapabilities: async () => ELIGIBLE, loadSiblings: async () => [], loadAddressContext: async () => ({ site: null, profile: null, addressSources: { confirmed: confirmed.current, project: null, owner: null } }) });
  const runner = new InvestigationRunner(deps);
  const { record } = await runner.start({ project: PROJECT, userId: 'u1', issue: { ...ISSUE } });
  await waitFor(runner, record._id);
  const saved = await deps.store.findById(record._id, PROJECT.id);
  const approvals = createApprovalService({ store: deps.store, resolveCapabilities: async () => ELIGIBLE, loadConfirmedAddress: async () => confirmedNow(confirmed) });
  const task = { _id: 't1', projectId: PROJECT.id, issueKey: 'organization_schema', pageUrl: HOME, recommendationId: 'rec1', status: 'task_created', investigationBinding: { investigationId: String(saved._id), fingerprint: saved.result.proposal.fingerprint, recommendationId: 'rec1' } };
  return { deps, runner, saved, approvals, task, confirmed };
}

test('the proposal is bound to the confirmed address: its hash, status and website are part of the fingerprint', async () => {
  const a = await approvedSetup({ confirmedNow: (c) => c.current });
  assert.equal(a.saved.result.proposal.bindings.addressStatus, 'confirmed_by_owner');
  assert.equal(a.saved.result.proposal.bindings.addressHash, addressHashOf(CONFIRMED_FIELDS));
  assert.equal(a.saved.result.proposal.bindings.entityId, ORG_ID);
  assert.equal(a.saved.result.proposal.hasProposal, true);
  assert.match(a.saved.result.proposal.fingerprint, /^[0-9a-f]{64}$/);
});

test('PROPOSAL CHANGED AFTER APPROVAL: if the confirmed address changes (or disappears) the approval cannot be claimed and approving is refused', async () => {
  const s = await approvedSetup({ confirmedNow: (c) => c.current });
  const fp = s.saved.result.proposal.fingerprint;
  await s.approvals.approve({ investigationId: s.saved._id, projectId: PROJECT.id, userId: 'u1', fingerprint: fp, loadTask: async () => s.task });
  const claim = await s.approvals.claimForApply(s.task);
  assert.equal(claim.legacy, false);
  await claim.release({ code: 'WRITE_FAILED', message: 'x' });
  const after = await s.deps.store.findById(s.saved._id, PROJECT.id);
  assert.equal(after.approval.lastFailure.code, 'WRITE_FAILED', 'a failed application is recorded');
  assert.equal(after.approval.consumedAt, null);
  // the user confirms a DIFFERENT address
  s.confirmed.current = confirmedRecord({ streetAddress: '99 Other Lane', addressLocality: 'Pune' });
  await assert.rejects(s.approvals.claimForApply(s.task), (e) => e.code === 'ADDRESS_CHANGED' && e.statusCode === 409);
  await assert.rejects(s.approvals.approve({ investigationId: s.saved._id, projectId: PROJECT.id, userId: 'u1', fingerprint: fp, loadTask: async () => s.task }), (e) => e.code === 'ADDRESS_CHANGED');
  // the confirmation is removed
  s.confirmed.current = null;
  const gone = createApprovalService({ store: s.deps.store, resolveCapabilities: async () => ELIGIBLE, loadConfirmedAddress: async () => null });
  await assert.rejects(gone.claimForApply(s.task), (e) => e.code === 'ADDRESS_CONFIRMATION_MISSING');
  // and one confirmed for another website
  const other = createApprovalService({ store: s.deps.store, resolveCapabilities: async () => ELIGIBLE, loadConfirmedAddress: async () => confirmedRecord(CONFIRMED_FIELDS, { website: 'https://another.example' }) });
  await assert.rejects(other.claimForApply(s.task), (e) => e.code === 'CONFIRMATION_FOR_OTHER_WEBSITE');
});

test('a blocked / awaiting-information investigation has nothing to approve or prepare, whatever the client sends', async () => {
  const deps = makeDeps({ fetcher: fakeFetcher({ [HOME]: { body: rmPage(graph()) } }), llm: fakeLlm([goodAnswer({ issueStatus: 'confirmed', findings: [{ statement: 'no address', basis: 'observed', absence: true, evidenceIds: ['E3'] }], proposedChanges: [], codeOrConfiguration: [] })]), resolveCapabilities: async () => ELIGIBLE, loadSiblings: async () => [], loadAddressContext: async () => ({ site: null, profile: null, addressSources: null }) });
  const runner = new InvestigationRunner(deps);
  const { record } = await runner.start({ project: PROJECT, userId: 'u1', issue: { ...ISSUE } });
  await waitFor(runner, record._id);
  const saved = await deps.store.findById(record._id, PROJECT.id);
  assert.equal(saved.result.proposal.hasProposal, false);
  assert.equal(saved.result.proposal.status, 'awaiting_information');
  const approvals = createApprovalService({ store: deps.store, resolveCapabilities: async () => ELIGIBLE });
  await assert.rejects(approvals.approve({ investigationId: saved._id, projectId: PROJECT.id, userId: 'u', fingerprint: saved.result.proposal.fingerprint, loadTask: async () => null }), (e) => e.code === 'NOTHING_TO_APPROVE' && /ADDRESS_UNCONFIRMED/.test(e.message));
  const { prepareFix } = await import('../service/fixPreparationService.js');
  await assert.rejects(prepareFix({ investigation: saved, project: PROJECT, userId: 'u' }, { resolveCapabilities: async () => ELIGIBLE }), (e) => e.code === 'PROPOSAL_NOT_PUBLISHABLE' && e.details.blockers.length > 0 && e.details.manualPlan.length > 0);
});
