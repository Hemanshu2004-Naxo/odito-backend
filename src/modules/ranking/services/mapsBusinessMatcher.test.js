import { describe, test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { buildBusinessIdentity, matchBusinessInMapsResults, evaluateCandidate, distanceMeters, normalizeDomain } from './mapsBusinessMatcher.js';
import { MapsRankingService } from './MapsRankingService.js';
import { DataForSeoService } from './DataForSeoService.js';

/**
 * Business-identity matching for Google Maps. Fixtures are the listings from the production log that matched the wrong
 * branch (target "ASG Krishna Eye Centre | An ASG Eye Hospital", krishnaeyecentre.com).
 * Run from backend/:  node --test src/modules/ranking/services/mapsBusinessMatcher.test.js
 */

const TARGET_NAME = 'ASG Krishna Eye Centre | An ASG Eye Hospital';
const SION = 'Rm No 102, Maryland Corner, Main Road, nearby HP Pretol Pump, Sion East, Sion, Mumbai, Maharashtra 400022';
const PAREL = 'A, Room No 2, Dr Ernest Borges Rd, nearby Shirodkar High School, Parel, Mumbai, Maharashtra 400012';
const GHATKOPAR = 'Shop No 101/102, sai vaibhav chs, Jhulelal Chowk, above Eves Saloon, Sindhu Wadi, Ghatkopar East, Mumbai, Maharashtra 400077';

const listing = (rank, title, address, extra = {}) => ({
  type: 'maps_search', rank_group: rank, rank_absolute: rank, title, address,
  domain: 'www.asgeyehospital.com', url: 'https://www.asgeyehospital.com/hospital/x/', ...extra,
});

const asgResults = () => [
  listing(1, 'ASG Mumbai Eye Care | An ASG Eye Hospital', GHATKOPAR),
  listing(2, 'ASG Mumbai Eye Care | An ASG Eye Hospital', 'Plot No 432, Sidheshwar Royale, Chembur, Mumbai, Maharashtra 400071'),
  listing(3, TARGET_NAME, SION),
  listing(4, 'ASG Eye Hospital', 'Sixth Floor, Goodwill Excellency, Vashi, Mumbai, Maharashtra 400703'),
  listing(8, TARGET_NAME, PAREL),
  listing(14, 'ASG Eye Hospital (Corporate Office)', '38th Floor, Sunshine Towers, Dadar West, Parel, Mumbai, Maharashtra 400013', { domain: 'asgeyehospital.com' }),
];

afterEach(() => mock.restoreAll());

describe('the production bug: brand-only match', () => {
  test('"ASG Mumbai Eye Care" (Ghatkopar) is NOT the tracked "ASG Krishna Eye Centre" — shared brand is not identity', () => {
    const identity = buildBusinessIdentity({ name: TARGET_NAME, domain: 'krishnaeyecentre.com' });
    const ev = evaluateCandidate(identity, asgResults()[0]);
    assert.notEqual(ev.verdict, 'branch');
    assert.notEqual(ev.verdict, 'business');
    assert.equal(ev.signals.brandShared, true);
    assert.equal(ev.signals.nameBusiness, false);
  });

  test('with only a brand-level overlap in the results, nothing matches and no rank is invented', () => {
    const identity = buildBusinessIdentity({ name: TARGET_NAME, domain: 'krishnaeyecentre.com' });
    const only = asgResults().filter(r => r.rank_group !== 3 && r.rank_group !== 8);
    const m = matchBusinessInMapsResults(identity, only);
    assert.equal(m.status, 'not_found');
    assert.equal(m.item, null);
  });
});

describe('same brand, different branches', () => {
  test('two identically named branches + a known address: only the tracked branch matches (Sion rank 3, not Parel rank 8)', () => {
    const sion = buildBusinessIdentity({ name: TARGET_NAME, address: SION });
    const m = matchBusinessInMapsResults(sion, asgResults());
    assert.equal(m.status, 'matched');
    assert.equal(m.level, 'branch');
    assert.equal(m.item.rank_group, 3);
    assert.ok(m.basis.includes('address'));

    const parel = buildBusinessIdentity({ name: TARGET_NAME, address: PAREL });
    assert.equal(matchBusinessInMapsResults(parel, asgResults()).item.rank_group, 8);
  });

  test('two identically named branches and NO branch data: ambiguous — no rank, not "first one wins"', () => {
    const identity = buildBusinessIdentity({ name: TARGET_NAME });
    const m = matchBusinessInMapsResults(identity, asgResults());
    assert.equal(m.status, 'ambiguous');
    assert.equal(m.item, null);
    assert.equal(m.candidates, 2);
  });

  test('coordinates alone pick the branch', () => {
    const items = [
      listing(3, TARGET_NAME, SION, { latitude: 19.0390, longitude: 72.8619 }),
      listing(8, TARGET_NAME, PAREL, { latitude: 18.9950, longitude: 72.8400 }),
    ];
    const m = matchBusinessInMapsResults(buildBusinessIdentity({ name: TARGET_NAME, lat: 19.0391, lng: 72.8620 }), items);
    assert.equal(m.item.rank_group, 3);
    assert.ok(m.basis.includes('coordinates'));
  });

  test('a branch with a conflicting address is rejected even though the name is identical', () => {
    const identity = buildBusinessIdentity({ name: TARGET_NAME, address: SION });
    const ev = evaluateCandidate(identity, listing(8, TARGET_NAME, PAREL));
    assert.equal(ev.verdict, 'different_branch');
  });
});

describe('strong identifiers', () => {
  test('Google place_id match wins outright, regardless of the title', () => {
    const items = [listing(5, 'Renamed Clinic', null, { place_id: 'ChIJabc' }), listing(6, TARGET_NAME, SION, { place_id: 'ChIJother' })];
    const m = matchBusinessInMapsResults(buildBusinessIdentity({ name: TARGET_NAME, placeId: 'ChIJabc', address: SION }), items);
    assert.equal(m.item.rank_group, 5);
    assert.deepEqual(m.basis, ['place_id']);
    assert.equal(m.confidence, 100);
  });

  test('a different place_id plus a different address is another place', () => {
    const ev = evaluateCandidate(buildBusinessIdentity({ name: TARGET_NAME, placeId: 'ChIJabc', address: SION }), listing(6, TARGET_NAME, PAREL, { place_id: 'ChIJother' }));
    assert.equal(ev.verdict, 'different_branch');
  });

  test('exact website domain + name matches a single-location business (no branch data needed)', () => {
    const items = [
      listing(1, 'Competitor Dental', 'x', { domain: 'competitor.com', url: 'https://competitor.com' }),
      listing(2, 'Acme Dental Pvt Ltd', '12 Main St', { domain: 'www.acmedental.com', url: 'https://www.acmedental.com/' }),
    ];
    const m = matchBusinessInMapsResults(buildBusinessIdentity({ name: 'Acme Dental', domain: 'https://acmedental.com/' }), items);
    assert.equal(m.status, 'matched');
    assert.equal(m.level, 'business');
    assert.equal(m.item.rank_group, 2);
    assert.ok(m.basis.includes('domain'));
  });

  test('a chain-wide domain alone never confirms a branch: same domain + different address is rejected', () => {
    const identity = buildBusinessIdentity({ name: 'ASG Parel', domain: 'asgeyehospital.com', address: PAREL });
    const ev = evaluateCandidate(identity, listing(1, 'ASG Parel', GHATKOPAR));
    assert.equal(ev.signals.domainExact, true);
    assert.equal(ev.verdict, 'different_branch');
  });

  test('legal-form differences do not break an exact name match', () => {
    const m = matchBusinessInMapsResults(buildBusinessIdentity({ name: 'WOW Infotech' }), [listing(4, 'WOW Infotech Private Limited', null, { domain: 'wow.com' })]);
    assert.equal(m.status, 'matched');
  });

  test('missing identifiers are not fabricated: an empty identity matches nothing', () => {
    const m = matchBusinessInMapsResults(buildBusinessIdentity({}), asgResults());
    assert.equal(m.status, 'not_found');
    assert.equal(m.reason, 'no_identity');
  });
});

describe('helpers', () => {
  test('distanceMeters / normalizeDomain', () => {
    assert.equal(distanceMeters({ lat: 19, lng: 72 }, { lat: 19, lng: 72 }), 0);
    assert.ok(Math.abs(distanceMeters({ lat: 19, lng: 72 }, { lat: 19.01, lng: 72 }) - 1112) < 10);
    assert.equal(distanceMeters(null, { lat: 1, lng: 1 }), null);
    assert.equal(distanceMeters({ lat: 'x', lng: 1 }, { lat: 1, lng: 1 }), null);
    assert.equal(normalizeDomain('https://www.Example.com/a?b=1'), 'example.com');
    assert.equal(normalizeDomain('nothing'), null);
    assert.equal(normalizeDomain(''), null);
  });
});

describe('MapsRankingService.fetchMapsRank (provider faked)', () => {
  const mapsResponse = (items) => ({ tasks: [{ result: [{ items }] }] });

  test('success: returns the tracked branch\'s rank and an explicit success status', async () => {
    mock.method(DataForSeoService, 'getMapsResults', async () => mapsResponse(asgResults()));
    const r = await MapsRankingService.fetchMapsRank('k', TARGET_NAME, 1007785, 'en', 'krishnaeyecentre.com', { address: SION });
    assert.equal(r.maps_status, 'success');
    assert.equal(r.maps_rank, 3);
    assert.equal(r.maps_listing.address, SION);
    assert.equal(r.maps_match.level, 'branch');
  });

  test('the exact production scenario: no address known -> ambiguous -> NOT the Ghatkopar branch, rank null, status not_found', async () => {
    mock.method(DataForSeoService, 'getMapsResults', async () => mapsResponse(asgResults()));
    const r = await MapsRankingService.fetchMapsRank('k', TARGET_NAME, 1007785, 'en', 'krishnaeyecentre.com');
    assert.equal(r.maps_rank, null);
    assert.equal(r.maps_listing, null);
    assert.equal(r.maps_status, 'not_found');
    assert.equal(r.maps_match.status, 'ambiguous');
  });

  test('provider failure is scan_error — distinguishable from not_found', async () => {
    mock.method(DataForSeoService, 'getMapsResults', async () => { throw Object.assign(new Error('boom'), { attempts: 3 }); });
    const r = await MapsRankingService.fetchMapsRank('k', TARGET_NAME, 1, 'en', null);
    assert.equal(r.maps_status, 'scan_error');
    assert.equal(r.attempts, 3);
    assert.equal(r.maps_rank, null);
  });
});
