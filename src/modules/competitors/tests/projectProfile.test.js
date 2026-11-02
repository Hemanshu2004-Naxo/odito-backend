import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProfile } from '../service/projectProfile.js';
import { isStale } from '../service/assessmentStore.js';
import { REGISTRY_VERSION } from '../config/domainRegistry.js';
import { RULES_VERSION } from '../service/relevanceClassifier.js';

const project = (over = {}) => ({
  main_url: 'https://www.krishnaeyecentre.com/', industry: 'healthcare', sub_industry: 'Eye Hospital', business_type: null, seo_scope: 'local',
  target_city: 'Nashik', target_state: 'Maharashtra', country: 'in', verified_business: { city: 'Nashik', state: 'Maharashtra', countryCode: 'IN', location: { lat: 19.9975, lng: 73.7898 } },
  visibility_profile: { services: ['Cataract surgery', ' LASIK ', ''] }, ...over,
});

describe('buildProfile: only what exists, and the Business Profile trust rule', () => {
  test('a project with everything: terms, geography and coordinates', () => {
    const p = buildProfile(project(), { category: 'Eye care center', secondary_categories: ['Ophthalmologist'], website: 'https://krishnaeyecentre.com/contact' });
    assert.deepEqual([p.ownDomain, p.subIndustry, p.industry, p.scope, p.city, p.state, p.countryIso2], ['krishnaeyecentre.com', 'Eye Hospital', 'healthcare', 'local', 'Nashik', 'Maharashtra', 'IN']);
    assert.deepEqual(p.services, ['Cataract surgery', 'LASIK']);
    assert.deepEqual(p.coords, { lat: 19.9975, lng: 73.7898 });
    assert.deepEqual([p.gbp.trusted, p.gbp.category, p.gbp.secondary], [true, 'Eye care center', ['Ophthalmologist']]);
  });

  test('a Business Profile on ANOTHER website is not trusted and gives no category (it may describe another brand)', () => {
    const p = buildProfile(project(), { category: 'Hospital', secondary_categories: ['Clinic'], website: 'https://some-hospital-network.com' });
    assert.deepEqual([p.gbp.trusted, p.gbp.category, p.gbp.secondary, p.gbp.connected], [false, null, [], true]);
  });

  test('a Business Profile with no website cannot be trusted; no Business Profile at all is simply absent', () => {
    assert.equal(buildProfile(project(), { category: 'Hospital', website: null }).gbp.trusted, false);
    assert.deepEqual(buildProfile(project(), null).gbp, { trusted: false, category: null, secondary: [], connected: false });
  });

  test('an empty project: every field is null or empty, nothing is invented', () => {
    const p = buildProfile({ main_url: 'https://x.com', verified_business: {} });
    assert.deepEqual([p.industry, p.subIndustry, p.scope, p.city, p.state, p.countryIso2, p.coords], [null, null, null, null, null, null, null]);
    assert.deepEqual(p.services, []);
  });

  test('the city falls back to the verified business, the country to its country code; coordinates need both numbers', () => {
    const p = buildProfile(project({ target_city: null, target_state: null, country: null, verified_business: { city: 'Pune', state: 'MH', countryCode: 'in', location: { lat: 18.5, lng: null } } }));
    assert.deepEqual([p.city, p.state, p.countryIso2, p.coords], ['Pune', 'MH', 'IN', null]);
  });

  test('a project that is not found gives no profile', () => assert.equal(buildProfile(null), null));
});

describe('isStale: when an assessment must be done again', () => {
  const NOW = Date.parse('2026-11-02T12:00:00Z');
  const done = (over = {}, autoOver = {}) => ({ status: 'done', auto: { rules_version: RULES_VERSION, registry_version: REGISTRY_VERSION, assessed_at: new Date(NOW - 3600e3), fetch_failed: false, ...autoOver }, ...over });
  test('none yet, failed, or without a result: stale', () => {
    assert.equal(isStale(null, NOW), true);
    assert.equal(isStale({ status: 'failed' }, NOW), true);
    assert.equal(isStale({ status: 'done' }, NOW), true);
  });
  test('already queued or running: not stale (it is on its way)', () => {
    assert.equal(isStale({ status: 'pending' }, NOW), false);
    assert.equal(isStale({ status: 'processing' }, NOW), false);
  });
  test('fresh: not stale; a month old: stale; rules or registry changed: stale', () => {
    assert.equal(isStale(done(), NOW), false);
    assert.equal(isStale(done({}, { assessed_at: new Date(NOW - 31 * 86400e3) }), NOW), true);
    assert.equal(isStale(done({}, { rules_version: 'old' }), NOW), true);
    assert.equal(isStale(done({}, { registry_version: 'old' }), NOW), true);
  });
  test('a site that could not be read is tried again after six hours, not a month', () => {
    assert.equal(isStale(done({}, { fetch_failed: true, assessed_at: new Date(NOW - 3600e3) }), NOW), false);
    assert.equal(isStale(done({}, { fetch_failed: true, assessed_at: new Date(NOW - 7 * 3600e3) }), NOW), true);
  });
});
