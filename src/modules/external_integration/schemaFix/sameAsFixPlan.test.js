import test from 'node:test';
import assert from 'node:assert/strict';
import { planSameAsFix, manualInstructions, SAMEAS_PLAN_VERSION } from './sameAsFixPlan.js';
import { resolveSameAsEntity } from '../../schema-evidence/sameAs/sameAsEntity.js';
import { validateProfileList } from '../../schema-evidence/sameAs/profileUrl.js';

const SITE = 'https://www.acme-agency.com/';
const ORG_ID = `${SITE}#organization`;
const org = (extra = {}) => ({ '@type': 'Organization', '@id': ORG_ID, name: 'Acme', url: SITE, ...extra });
const pagesWith = (node, n = 4) => Array.from({ length: n }, (_, i) => ({ url: i ? `${SITE}p${i}/` : SITE, structured_data: [{ '@graph': [node] }] }));
const entityOf = (node, n) => resolveSameAsEntity({ pages: pagesWith(node, n), pageUrl: SITE });
const live = (extra = {}) => ({ kind: 'company', sameAs: [], protectedSameAs: [], additionalSameAs: [], ...extra });
const pick = (...urls) => validateProfileList(urls, { siteUrl: SITE }).items.map((i) => ({ ...i, origin: 'discovered' }));
const ctx = { projectId: 'p1', connectionId: 'c1', pageUrl: SITE };
const caps = { siteSchemaSupported: true };
const plan = (over = {}) => planSameAsFix({ selection: pick('https://www.linkedin.com/company/acme'), entity: entityOf(org()), site: live(), provider: 'rank_math', context: ctx, capabilities: caps, ...over });

test('ready: absent sameAs on a Rank Math site-wide Organization → one add per approved URL, nothing else', () => {
  const p = plan({ selection: pick('https://www.linkedin.com/company/acme', 'https://www.facebook.com/acme') });
  assert.equal(p.status, 'ready');
  assert.deepEqual(p.changes.map((c) => [c.field, c.kind, c.before, c.after]), [
    ['sameAs', 'add', '', 'https://www.linkedin.com/company/acme'],
    ['sameAs', 'add', '', 'https://www.facebook.com/acme'],
  ]);
  assert.match(p.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(p.target.storage, 'rank-math-options-titles.social_additional_profiles'); assert.match(p.target.label, /Rank Math/);
  assert.equal(p.manual, null);
});

test('no profiles selected: nothing is written, no empty array, the finding stays open', () => {
  const p = plan({ selection: [] });
  assert.equal(p.status, 'nothing_to_change'); assert.equal(p.code, 'NO_PROFILES_SELECTED'); assert.deepEqual(p.changes, []);
});

test('existing values are preserved and an already-published profile is reported, not duplicated', () => {
  const entity = entityOf(org({ sameAs: ['https://www.facebook.com/acme', 'https://www.instagram.com/acme'] }));
  const site = live({ sameAs: ['https://www.facebook.com/acme', 'https://www.instagram.com/acme'], protectedSameAs: ['https://www.facebook.com/acme'], additionalSameAs: ['https://www.instagram.com/acme'] });
  const p = plan({ entity, site, selection: pick('https://facebook.com/acme/', 'https://www.linkedin.com/company/acme', 'https://instagram.com/acme') });
  assert.equal(p.status, 'ready');
  assert.deepEqual(p.changes.map((c) => c.after), ['https://www.linkedin.com/company/acme']);
  assert.deepEqual(p.alreadyPresent.map((a) => a.url).sort(), ['https://www.facebook.com/acme', 'https://www.instagram.com/acme']);
  assert.deepEqual(p.preserved.map((x) => x.value), ['https://www.facebook.com/acme', 'https://www.instagram.com/acme']);
});

test('every selected profile already present → nothing to change', () => {
  const entity = entityOf(org({ sameAs: ['https://www.linkedin.com/company/acme'] }));
  const p = plan({ entity, site: live({ sameAs: ['https://www.linkedin.com/company/acme'], additionalSameAs: ['https://www.linkedin.com/company/acme'] }) });
  assert.equal(p.status, 'nothing_to_change'); assert.equal(p.code, 'ALREADY_PRESENT');
});

test('a second profile on a network the Organization already lists is allowed but called out', () => {
  const entity = entityOf(org({ sameAs: ['https://www.facebook.com/acme-old'] }));
  const p = plan({ entity, site: live({ sameAs: ['https://www.facebook.com/acme-old'], additionalSameAs: ['https://www.facebook.com/acme-old'] }), selection: pick('https://www.facebook.com/acme-new') });
  assert.equal(p.status, 'ready'); assert.equal(p.warnings[0].code, 'SECOND_PROFILE_ON_NETWORK');
});

test('removals: only the managed bucket, only when selected; protected and unknown values are blocked', () => {
  const site = live({ sameAs: ['https://www.facebook.com/acme', 'https://www.instagram.com/old'], protectedSameAs: ['https://www.facebook.com/acme'], additionalSameAs: ['https://www.instagram.com/old'] });
  const entity = entityOf(org({ sameAs: site.sameAs }));
  const ok = plan({ entity, site, selection: [], removals: ['https://instagram.com/old/'] });
  assert.equal(ok.status, 'ready'); assert.deepEqual(ok.changes.map((c) => [c.kind, c.before, c.after]), [['remove', 'https://www.instagram.com/old', '']]);
  const prot = plan({ entity, site, selection: [], removals: ['https://www.facebook.com/acme'] });
  assert.equal(prot.status, 'blocked'); assert.equal(prot.code, 'PROTECTED_PROFILE');
  const unknown = plan({ entity, site, selection: [], removals: ['https://www.linkedin.com/company/never-there'] });
  assert.equal(unknown.code, 'REMOVE_NOT_MANAGED');
});

test('unsupported sources return specific manual instructions and no changes', () => {
  const yoast = plan({ provider: 'yoast' });
  assert.equal(yoast.status, 'unsupported'); assert.equal(yoast.code, 'PROVIDER_NOT_SUPPORTED'); assert.deepEqual(yoast.changes, []);
  assert.match(yoast.manual.steps.join(' '), /Yoast SEO/); assert.match(yoast.manual.steps.join(' '), /do not add a second Organization/);
  assert.match(plan({ provider: 'aioseo' }).manual.steps[0], /All in One SEO/);
  assert.match(plan({ provider: 'none' }).manual.steps[0], /theme/);
  assert.equal(plan({ provider: 'multiple' }).status, 'unsupported');

  const themeEntity = entityOf({ '@type': 'Organization', '@id': `${SITE}#theme-org`, name: 'Acme', url: SITE });
  const theme = plan({ entity: themeEntity });
  assert.equal(theme.status, 'unsupported'); assert.equal(theme.code, 'ORGANIZATION_SOURCE_UNKNOWN'); assert.deepEqual(theme.changes, []);

  const dup = plan({ entity: resolveSameAsEntity({ pages: [{ url: SITE, structured_data: [{ '@graph': [org(), { '@type': 'Organization', '@id': `${SITE}#x`, name: 'Acme', url: SITE }] }] }], pageUrl: SITE }) });
  assert.equal(dup.code, 'DUPLICATE_ENTITIES');
  assert.equal(plan({ site: live({ kind: 'person' }) }).code, 'SITE_IS_PERSON');
  assert.equal(plan({ site: live({ kind: '' }) }).code, 'SITE_IS_PERSON');
});

test('an old Bridge blocks, no entity fails validation', () => {
  assert.equal(plan({ capabilities: {} }).code, 'BRIDGE_UPDATE_REQUIRED');
  assert.equal(plan({ entity: resolveSameAsEntity({ pages: [], pageUrl: SITE }) }).status, 'validation_failed');
});

test('the fingerprint changes with anything that changes the meaning, and not otherwise', () => {
  const a = plan();
  assert.equal(plan().fingerprint, a.fingerprint);
  assert.notEqual(plan({ selection: pick('https://www.linkedin.com/company/other') }).fingerprint, a.fingerprint);
  assert.notEqual(plan({ site: live({ additionalSameAs: ['https://www.instagram.com/x'] }) }).fingerprint, a.fingerprint);
  assert.notEqual(plan({ context: { ...ctx, projectId: 'p2' } }).fingerprint, a.fingerprint);
  assert.notEqual(plan({ context: { ...ctx, connectionId: 'c2' } }).fingerprint, a.fingerprint);
  assert.equal(SAMEAS_PLAN_VERSION, 1);
});

test('manual instructions say whether one change fixes every page', () => {
  assert.match(manualInstructions('rank_math', { entityId: ORG_ID, shared: true }).join(' '), /site-wide/);
  assert.match(manualInstructions('yoast', { shared: false }).join(' '), /specific to this page/);
});
