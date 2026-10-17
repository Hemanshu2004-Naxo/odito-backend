import test from 'node:test';
import assert from 'node:assert/strict';
import { planBreadcrumbFix, manualInstructions, BREADCRUMB_PLAN_VERSION } from './breadcrumbFixPlan.js';

const HOME = 'https://www.acme.test/';
const PAGE = 'https://www.acme.test/services/local-seo/';
const TRAIL = [{ name: 'Home', url: HOME }, { name: 'Services', url: 'https://www.acme.test/services/' }, { name: 'Local SEO', url: PAGE }];
const ctx = { projectId: 'p1', connectionId: 'c1', pageUrl: 'https://www.acme.test/services/local-seo' };
const base = () => ({
  trail: TRAIL, live: { status: 'missing', problems: [] }, enabledNow: false, provider: 'rank_math',
  predicted: { predictable: true, urls: TRAIL.map((t) => t.url), reason: null }, resource: { resolved: true },
  affectedPages: ['https://www.acme.test/a', 'https://www.acme.test/b'], context: ctx, capabilities: { siteSchemaSupported: true },
});
const plan = (over = {}) => planBreadcrumbFix({ ...base(), ...over });

test('ready: Rank Math would build exactly the confirmed trail → one change, the site-wide scope and its pages listed', () => {
  const p = plan();
  assert.equal(p.status, 'ready');
  assert.deepEqual(p.changes.map((c) => [c.field, c.kind, c.before, c.after]), [['breadcrumbs_enabled', 'enable', '', 'on']]);
  assert.equal(p.scope.kind, 'site_wide'); assert.equal(p.scope.affectedCount, 2);
  assert.match(p.target.label, /Rank Math/); assert.match(p.fingerprint, /^[a-f0-9]{64}$/);
  assert.ok(p.warnings.some((w) => w.code === 'SITE_WIDE'));
  assert.equal(p.manual, null);
});

test('no confirmed trail: nothing is switched on without a trail the owner approved', () => {
  for (const trail of [null, [], [TRAIL[0]]]) {
    const p = plan({ trail });
    assert.equal(p.status, 'validation_failed'); assert.equal(p.code, 'TRAIL_NOT_CONFIRMED'); assert.deepEqual(p.changes, []);
  }
});

test('the page already outputs a valid BreadcrumbList: nothing to change (stale finding), never a second one', () => {
  const p = plan({ live: { status: 'valid' } });
  assert.equal(p.status, 'nothing_to_change'); assert.equal(p.code, 'STALE_FINDING');
});

test('an invalid or duplicated existing BreadcrumbList is unsupported with its own steps, never "enable another"', () => {
  const bad = plan({ live: { status: 'invalid', problems: ['relative_or_invalid_url'] } });
  assert.equal(bad.status, 'unsupported'); assert.equal(bad.code, 'EXISTING_BREADCRUMB_INVALID'); assert.match(bad.message, /relative_or_invalid_url/);
  assert.match(bad.manual.steps.join(' '), /correct or remove it/);
  assert.equal(plan({ live: { status: 'duplicate' } }).code, 'EXISTING_BREADCRUMB_INVALID');
});

test('the trail Rank Math would build differs → unsupported TRAIL_WOULD_DIFFER, says both trails, offers the manual path', () => {
  const p = plan({ predicted: { predictable: true, urls: [HOME, PAGE], reason: null } });
  assert.equal(p.status, 'unsupported'); assert.equal(p.code, 'TRAIL_WOULD_DIFFER');
  assert.match(p.message, /would build this trail/); assert.ok(p.message.includes('https://www.acme.test/services/'));
  assert.deepEqual(p.changes, []); assert.ok(p.manual.steps.length >= 2); assert.equal(p.target, null);
});

test('URL keys ignore only a trailing slash when comparing the predicted and the confirmed trail', () => {
  assert.equal(plan({ predicted: { predictable: true, urls: ['https://www.acme.test', 'https://www.acme.test/services', 'https://www.acme.test/services/local-seo'], reason: null } }).status, 'ready');
});

test('a trail Rank Math decides at render time (posts) cannot be predicted: allowed, flagged, and verified after the change', () => {
  const p = plan({ predicted: { predictable: false, urls: [], reason: 'Rank Math builds a post trail from its category.' } });
  assert.equal(p.status, 'ready');
  assert.equal(p.warnings.find((w) => w.code === 'TRAIL_NOT_PREDICTABLE').message, 'Rank Math builds a post trail from its category.');
});

test('unsupported sources: another SEO plugin, several, none, WordPress not connected, person-less provider → manual steps and no change', () => {
  assert.match(plan({ provider: 'yoast' }).manual.steps[0], /Yoast SEO/);
  assert.match(plan({ provider: 'aioseo' }).manual.steps[0], /All in One SEO/);
  assert.match(plan({ provider: 'none' }).manual.steps[0], /<head>/);
  assert.equal(plan({ provider: 'multiple' }).code, 'PROVIDER_NOT_SUPPORTED');
  const off = plan({ unavailable: { code: 'WORDPRESS_NOT_CONNECTED', message: 'WordPress is not connected.' }, provider: 'none' });
  assert.equal(off.status, 'unsupported'); assert.equal(off.code, 'WORDPRESS_NOT_CONNECTED'); assert.deepEqual(off.changes, []);
  for (const p of [plan({ provider: 'yoast' }), off]) assert.equal(p.changes.length, 0);
});

test('an old Bridge blocks; breadcrumbs already on yet missing is unsupported (something else prevents it); an unresolved page is unsupported', () => {
  assert.equal(plan({ capabilities: {} }).code, 'BRIDGE_UPDATE_REQUIRED');
  const on = plan({ enabledNow: true });
  assert.equal(on.status, 'unsupported'); assert.equal(on.code, 'BREADCRUMBS_ALREADY_ON');
  assert.equal(plan({ resource: { resolved: false, message: 'Not a page.' } }).code, 'PAGE_NOT_RESOLVED');
});

test('the fingerprint changes with anything that changes the meaning, and not otherwise', () => {
  const a = plan();
  assert.equal(plan().fingerprint, a.fingerprint);
  assert.notEqual(plan({ trail: [TRAIL[0], { name: 'Local SEO', url: PAGE }] , predicted: { predictable: true, urls: [HOME, PAGE], reason: null } }).fingerprint, a.fingerprint);
  assert.notEqual(plan({ trail: TRAIL.map((t, i) => (i === 1 ? { ...t, name: 'Our Services' } : t)) }).fingerprint, a.fingerprint);
  assert.notEqual(plan({ enabledNow: true }).fingerprint, a.fingerprint);
  assert.notEqual(plan({ live: { status: 'valid' } }).fingerprint, a.fingerprint);
  assert.notEqual(plan({ context: { ...ctx, connectionId: 'c2' } }).fingerprint, a.fingerprint);
  assert.notEqual(plan({ provider: 'yoast' }).fingerprint, a.fingerprint);
  assert.equal(BREADCRUMB_PLAN_VERSION, 1);
});

test('manual instructions always say to publish the trail in ONE place only', () => {
  for (const provider of ['rank_math', 'yoast', 'none', 'multiple', 'weird']) assert.match(manualInstructions(provider).join(' '), /ONE place only/);
});
