import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';

dotenv.config();

import { resolveLocalLocationCode } from './localLocationResolver.js';
import { COUNTRY_TO_LOCATION_CODE } from './dataforseoLocationService.js';

// Regression coverage for: a 'local' scope project with no stored country
// (e.g. onboarded via a bare city name like "mumbai", verified_business only
// populated with {city}, no countryCode) silently ranked against Google US
// (locationCode 2840) whenever the DataForSEO locations lookup failed or a
// city name didn't match — this is a real, reproduced-in-dev-data bug for
// project Krishnaeyecentre-Com. The fix: never guess US when the country is
// genuinely unknown; return an explicit unresolved result and let the caller
// (KeywordRankingService.resolveLocationForProject) turn that into a clear
// "configure your project's location" error instead of proceeding.
//
// These tests use a city name that cannot exist in DataForSEO's dataset, so
// they exercise Priority 4 (or the fetch-error branch) deterministically
// regardless of whether the DataForSEO API is reachable in this environment.

const UNMATCHABLE_CITY = 'Nonexistent-City-Zzzqx-Regression-Test';

describe('resolveLocalLocationCode — never silently guesses US', () => {
  test('known, supported country resolves to that country — never US — even when city/API lookup misses', async () => {
    const resolution = await resolveLocalLocationCode({
      verifiedBusiness: { city: UNMATCHABLE_CITY, countryCode: 'IN' },
      country: null,
      address: null,
    });

    assert.equal(resolution.locationCode, COUNTRY_TO_LOCATION_CODE.IN, 'must resolve to India, not fall through to a US default');
    assert.notEqual(resolution.locationCode, COUNTRY_TO_LOCATION_CODE.US);
  });

  test('unknown country and unmatchable city returns an explicit unresolved result, not a US guess', async () => {
    const resolution = await resolveLocalLocationCode({
      verifiedBusiness: { city: UNMATCHABLE_CITY, countryCode: null },
      country: null,
      address: null,
    });

    assert.equal(resolution.locationCode, null, 'must be explicitly unresolved, never silently default to any country');
    assert.equal(resolution.confidence, 'none');
  });

  test('a project explicitly targeting the US still resolves to the US (the fix must not break the legitimate case)', async () => {
    const resolution = await resolveLocalLocationCode({
      verifiedBusiness: { city: UNMATCHABLE_CITY, countryCode: 'US' },
      country: null,
      address: null,
    });

    assert.equal(resolution.locationCode, COUNTRY_TO_LOCATION_CODE.US);
  });
});
