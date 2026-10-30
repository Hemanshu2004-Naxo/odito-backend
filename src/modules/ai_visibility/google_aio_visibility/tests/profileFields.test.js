import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProfileUpdate } from '../../shared/questions/controllers/profileController.js';
import { normalizeBusinessProfile } from '../../shared/services/businessProfileService.js';
import { makeProject } from '../../shared/tests/fixtures.js';

describe('profile: country and state', () => {
  test('country is stored as an upper-case ISO-2 code; invalid values are refused; null clears', () => {
    assert.deepEqual(buildProfileUpdate({ country: ' in ' }).set, { country: 'IN' });
    assert.equal(buildProfileUpdate({ country: 'India' }).errors.country, 'Choose a country');
    assert.equal(buildProfileUpdate({ country: 'X1' }).errors.country, 'Choose a country');
    assert.deepEqual(buildProfileUpdate({ country: null }).set, { country: null });
  });
  test('target state is sanitised text', () => {
    assert.deepEqual(buildProfileUpdate({ targetState: 'Maharashtra' }).set, { target_state: 'Maharashtra' });
    assert.ok(buildProfileUpdate({ targetState: 'https://evil.example' }).errors.targetState);
  });
  test('the saved state and country reach the market used for the Google location', () => {
    const project = makeProject({ verified_business: null, target_city: 'Nashik', target_state: 'Maharashtra', location_source: 'user_entered', country: 'IN', seo_scope: 'local', location: null });
    const { market } = normalizeBusinessProfile({ project });
    assert.deepEqual([market.city, market.state, market.countryCode], ['Nashik', 'Maharashtra', 'IN']);
  });
});
