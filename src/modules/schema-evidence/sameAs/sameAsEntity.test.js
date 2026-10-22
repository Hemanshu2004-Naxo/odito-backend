import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSameAsEntity } from './sameAsEntity.js';
import { buildSameAsPatch, renderRecommendedJsonLd } from './sameAsMarkup.js';
import { inspectRenderedSameAs, verifyRenderedSameAs } from './sameAsVerification.js';

const SITE = 'https://www.acme-agency.com/';
const ORG_ID = `${SITE}#organization`;
const rankMathOrg = (extra = {}) => ({ '@type': 'Organization', '@id': ORG_ID, name: 'Acme', url: SITE, logo: { '@type': 'ImageObject', url: `${SITE}logo.png` }, ...extra });
const doc = (url, ...graph) => ({ url, structured_data: [{ '@context': 'https://schema.org', '@graph': graph }] });
const sitePages = (n, org = rankMathOrg()) => [doc(SITE, org), ...Array.from({ length: n - 1 }, (_, i) => doc(`${SITE}p${i}/`, org))];

test('entity: absent sameAs on a shared Rank Math Organization → one site-wide source, every page affected', () => {
  const r = resolveSameAsEntity({ pages: sitePages(5), pageUrl: `${SITE}p1/` });
  assert.equal(r.state, 'absent');
  assert.equal(r.entity.id, ORG_ID); assert.equal(r.entity.hasHomeOrganizationId, true);
  assert.equal(r.scope.shared, true); assert.equal(r.scope.affectedPages.length, 5);
});

test('entity: empty array vs populated are distinguished and existing values are kept verbatim', () => {
  assert.equal(resolveSameAsEntity({ pages: sitePages(2, rankMathOrg({ sameAs: [] })), pageUrl: SITE }).state, 'empty');
  assert.equal(resolveSameAsEntity({ pages: sitePages(2, rankMathOrg({ sameAs: ['', '  '] })), pageUrl: SITE }).state, 'empty');
  const r = resolveSameAsEntity({ pages: sitePages(2, rankMathOrg({ sameAs: ['https://www.facebook.com/acme', 'https://www.facebook.com/acme/', 'notaurl'] })), pageUrl: SITE });
  assert.equal(r.state, 'populated');
  assert.equal(r.existing.valid.length, 1); assert.equal(r.existing.duplicates.length, 1); assert.equal(r.existing.invalid.length, 1);
});

test('entity: a Person sameAs is never the organization sameAs', () => {
  const person = { '@type': 'Person', '@id': `${SITE}author/x/`, name: 'Pat', sameAs: ['https://twitter.com/pat'] };
  const r = resolveSameAsEntity({ pages: [doc(SITE, rankMathOrg(), person)], pageUrl: SITE });
  assert.equal(r.state, 'absent'); assert.equal(r.personSameAsOnly, true);
  assert.deepEqual(r.existing.raw, []);
});

test('entity: all JSON-LD forms are read (graph in a string, array of blocks, subtype)', () => {
  const pages = [{ url: SITE, structured_data: [JSON.stringify({ '@context': 'https://schema.org', '@graph': [{ '@type': ['Hospital', 'Organization'], '@id': ORG_ID, name: 'Acme', url: SITE, sameAs: 'https://www.linkedin.com/company/acme' }] })] }];
  const r = resolveSameAsEntity({ pages, pageUrl: SITE });
  assert.equal(r.state, 'populated'); assert.deepEqual(r.entity.types, ['Hospital', 'Organization']);
  assert.deepEqual(r.existing.raw, ['https://www.linkedin.com/company/acme']);
});

test('entity: two Organizations with different @ids are not merged', () => {
  const second = { '@type': 'Organization', '@id': `${SITE}#theme-org`, name: 'Acme', url: SITE };
  const r = resolveSameAsEntity({ pages: [doc(SITE, rankMathOrg(), second)], pageUrl: SITE });
  assert.equal(r.state, 'multiple_entities');
  const across = resolveSameAsEntity({ pages: [doc(SITE, rankMathOrg()), doc(`${SITE}x/`, second)], pageUrl: SITE });
  assert.equal(across.state, 'multiple_entities');
});

test('entity: an entity of another site (a reviewed business) is not ours', () => {
  const foreign = { '@type': 'Organization', '@id': 'https://other-company.org/#org', name: 'Other', url: 'https://other-company.org/' };
  const r = resolveSameAsEntity({ pages: [doc(SITE, rankMathOrg(), foreign)], pageUrl: SITE });
  assert.equal(r.state, 'absent'); assert.equal(r.entity.id, ORG_ID);
});

test('entity: page-specific markup (different sameAs / only one page) is not treated as shared', () => {
  const pages = [doc(SITE, rankMathOrg({ sameAs: ['https://www.facebook.com/a'] })), doc(`${SITE}a/`, rankMathOrg({ sameAs: ['https://www.facebook.com/b'] })), doc(`${SITE}b/`, rankMathOrg({ sameAs: ['https://www.facebook.com/c'] }))];
  const r = resolveSameAsEntity({ pages, pageUrl: `${SITE}a/` });
  assert.equal(r.scope.shared, false);
  assert.equal(resolveSameAsEntity({ pages: [doc(SITE, rankMathOrg())], pageUrl: SITE }).scope.shared, false);
});

test('entity: a theme-generated entity (not <home>#organization) is flagged, a finding on a page without an entity uses the site entity', () => {
  const theme = resolveSameAsEntity({ pages: [doc(SITE, { '@type': 'Organization', '@id': `${SITE}#theme`, name: 'Acme', url: SITE })], pageUrl: SITE });
  assert.equal(theme.entity.hasHomeOrganizationId, false);
  const r = resolveSameAsEntity({ pages: [doc(SITE, rankMathOrg()), doc(`${SITE}blank/`, { '@type': 'WebPage', '@id': `${SITE}blank/#webpage` })], pageUrl: `${SITE}blank/` });
  assert.equal(r.entity.id, ORG_ID);
  assert.equal(resolveSameAsEntity({ pages: [], pageUrl: SITE }).state, 'no_entity');
});

// ── deterministic patch ──────────────────────────────────────────────────────────────────────────────────────────

test('patch: only sameAs changes; every other property keeps its value and order; sameAs is appended when it did not exist', () => {
  const node = { '@type': 'Organization', '@id': ORG_ID, name: 'Acme', url: SITE, logo: { '@type': 'ImageObject', url: 'l.png' }, address: { '@type': 'PostalAddress', streetAddress: '1 Main' }, contactPoint: [{ telephone: '+1' }] };
  const r = buildSameAsPatch({ node, add: ['https://www.linkedin.com/company/acme'] });
  assert.deepEqual(Object.keys(r.node), [...Object.keys(node), 'sameAs']);
  for (const k of Object.keys(node)) assert.deepEqual(r.node[k], node[k]);
  assert.deepEqual(r.node.sameAs, ['https://www.linkedin.com/company/acme']);
  assert.notEqual(r.node, node); assert.equal('sameAs' in node, false); // the input is never mutated
});

test('patch: existing values (even unparseable ones) stay in place, duplicates are not added, distinct profiles are never merged away', () => {
  const node = { '@type': 'Organization', name: 'Acme', sameAs: ['https://www.facebook.com/acme', { '@id': 'x' }, 'https://www.facebook.com/acme-two'] };
  const r = buildSameAsPatch({ node, add: ['https://facebook.com/acme/', 'https://www.facebook.com/acme-two', 'https://www.linkedin.com/company/acme'] });
  assert.deepEqual(r.node.sameAs, ['https://www.facebook.com/acme', { '@id': 'x' }, 'https://www.facebook.com/acme-two', 'https://www.linkedin.com/company/acme']);
  assert.deepEqual(r.added, ['https://www.linkedin.com/company/acme']);
  assert.equal(Object.keys(r.node)[2], 'sameAs'); // position kept
});

test('patch: an explicit removal drops exactly that value; an emptied list removes the property instead of writing []', () => {
  const node = { name: 'Acme', sameAs: ['https://www.facebook.com/a', 'https://www.facebook.com/b'] };
  assert.deepEqual(buildSameAsPatch({ node, remove: ['https://www.facebook.com/a/'] }).node.sameAs, ['https://www.facebook.com/b']);
  const emptied = buildSameAsPatch({ node: { name: 'x', sameAs: ['https://www.facebook.com/a'] }, remove: ['https://www.facebook.com/a'] });
  assert.equal('sameAs' in emptied.node, false); assert.equal(emptied.sameAs, null);
  assert.equal('sameAs' in buildSameAsPatch({ node: { name: 'x' }, add: [] }).node, false);
});

test('patch: renders valid JSON-LD with the context, round-trips', () => {
  const text = renderRecommendedJsonLd(buildSameAsPatch({ node: { '@type': 'Organization', '@id': ORG_ID, name: 'Acme' }, add: ['https://www.instagram.com/acme'] }).node);
  const parsed = JSON.parse(text);
  assert.equal(parsed['@context'], 'https://schema.org'); assert.deepEqual(parsed.sameAs, ['https://www.instagram.com/acme']);
});

// ── rendered verification ────────────────────────────────────────────────────────────────────────────────────────

const rendered = (...graph) => [{ '@context': 'https://schema.org', '@graph': graph }];
const expected = (extra = {}) => ({ entityId: ORG_ID, add: ['https://www.linkedin.com/company/acme'], keep: ['https://www.facebook.com/acme'], remove: [], organizationsBefore: 1, ...extra });
const checkOf = (r, name) => r.checks.find((c) => c.name === name);

test('verify: approved URLs on the intended entity, previous values kept, no duplicate entity → verified', () => {
  const r = inspectRenderedSameAs({ structuredData: rendered(rankMathOrg({ sameAs: ['https://www.facebook.com/acme', 'https://linkedin.com/company/acme/'] })), pageUrl: SITE, expected: expected() });
  assert.equal(r.status, 'verified'); assert.ok(r.checks.every((c) => c.ok));
  assert.deepEqual(r.rendered.sameAs.length, 2);
});

test('verify: saved but not rendered (cache / other source) is a failure that says so, never success', () => {
  const r = inspectRenderedSameAs({ structuredData: rendered(rankMathOrg({ sameAs: ['https://www.facebook.com/acme'] })), pageUrl: SITE, expected: expected() });
  assert.equal(r.status, 'failed'); assert.equal(r.code, 'NOT_IN_RENDERED_PAGE');
  assert.equal(checkOf(r, 'approved_urls_present').ok, false);
  assert.ok(r.reasons.some((x) => /cache/i.test(x)));
});

test('verify: the URL on a different node (a Person) does not count for the Organization', () => {
  const person = { '@type': 'Person', '@id': `${SITE}author/x/`, name: 'Pat', sameAs: ['https://www.linkedin.com/company/acme'] };
  const r = inspectRenderedSameAs({ structuredData: rendered(rankMathOrg({ sameAs: ['https://www.facebook.com/acme'] }), person), pageUrl: SITE, expected: expected() });
  assert.equal(r.status, 'failed');
});

test('verify: a lost previous value, a value that should be gone, a second Organization and a missing entity each fail', () => {
  const lost = inspectRenderedSameAs({ structuredData: rendered(rankMathOrg({ sameAs: ['https://www.linkedin.com/company/acme'] })), pageUrl: SITE, expected: expected() });
  assert.equal(checkOf(lost, 'existing_values_preserved').ok, false);
  const stays = inspectRenderedSameAs({ structuredData: rendered(rankMathOrg({ sameAs: ['https://www.facebook.com/acme', 'https://www.linkedin.com/company/acme', 'https://www.facebook.com/old'] })), pageUrl: SITE, expected: expected({ remove: ['https://www.facebook.com/old'] }) });
  assert.equal(checkOf(stays, 'removed_values_gone').ok, false);
  const dup = inspectRenderedSameAs({ structuredData: rendered(rankMathOrg({ sameAs: ['https://www.facebook.com/acme', 'https://www.linkedin.com/company/acme'] }), { '@type': 'Organization', '@id': `${SITE}#other`, name: 'Acme', url: SITE }), pageUrl: SITE, expected: expected() });
  assert.equal(checkOf(dup, 'no_second_organization').ok, false);
  const gone = inspectRenderedSameAs({ structuredData: rendered({ '@type': 'WebSite', url: SITE }), pageUrl: SITE, expected: expected() });
  assert.equal(gone.status, 'failed'); assert.equal(checkOf(gone, 'entity_present').ok, false);
});

test('verify: no JSON-LD or an unfetchable page is unverifiable, not a failure', async () => {
  assert.equal(inspectRenderedSameAs({ structuredData: [], pageUrl: SITE, expected: expected() }).status, 'unverifiable');
  const e = new Error('The public page returned HTTP 503.'); e.code = 'BAD_STATUS';
  const r = await verifyRenderedSameAs({ pageUrl: SITE, siteUrl: SITE, expected: expected() }, { fetchHtml: async () => { throw e; } });
  assert.equal(r.status, 'unverifiable'); assert.equal(r.code, 'BAD_STATUS');
});

test('verify: live wrapper parses the fetched HTML (including a block that fails to parse)', async () => {
  const html = `<html><head><script type="application/ld+json">${JSON.stringify(rendered(rankMathOrg({ sameAs: ['https://www.facebook.com/acme', 'https://www.linkedin.com/company/acme'] })))}</script><script type="application/ld+json">{bad</script></head></html>`;
  let seen;
  const r = await verifyRenderedSameAs({ pageUrl: SITE, siteUrl: SITE, expected: expected() }, { fetchHtml: async (u, o) => { seen = o; return { status: 200, html }; } });
  assert.equal(seen.cacheBust, true);
  assert.equal(checkOf(r, 'parseable_json_ld').ok, false); // a broken block is reported
  assert.equal(checkOf(r, 'approved_urls_present').ok, true);
});
