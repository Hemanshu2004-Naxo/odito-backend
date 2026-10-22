import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';

dotenv.config();

import { checkRanking } from './seoOnboardingController.js';
import { DataForSeoService } from '../../ranking/services/DataForSeoService.js';

// Regression coverage for POST /api/seo/check-ranking — the ACTIVE,
// frontend-facing keyword ranking endpoint (backs /seo/rankings/*, which
// the Keyword Rankings dashboard page actually calls; this is distinct from
// the mostly-unused odito_backend/src/modules/keyword_research module fixed
// earlier). It used to silently default to `COUNTRY_TO_LOCATION_CODE['US']`
// (locationCode 2840) whenever a national-scope project had no `country` in
// the request, or an unsupported one — producing a real ranking POSITION
// checked against the wrong country's SERP with no indication anything was
// wrong. Now it returns 400 instead of guessing.
//
// `DataForSeoService.getSerpOrganic` is monkey-patched for the tests that
// pass the location guard and reach it — `DataForSeoService` is a plain
// exported object (not a class instance), so reassigning its method here
// affects the same object seoOnboardingController.js imported, with no
// network call, no API credit spent, and no 25-second wait. Restored in
// `afterEach` so no test leaks its stub into another file's run.

function mockRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

function emptySerpResponse() {
  return { status_code: 20000, tasks: [{ status_code: 20000, result: [{ items: [] }] }] };
}

let originalGetSerpOrganic;

beforeEach(() => {
  originalGetSerpOrganic = DataForSeoService.getSerpOrganic;
});

afterEach(() => {
  DataForSeoService.getSerpOrganic = originalGetSerpOrganic;
});

describe('checkRanking — never silently defaults to US for an unresolved location', () => {
  test('missing location: national scope with no country returns 400, not a US-defaulted ranking result', async () => {
    const req = { body: { domain: 'example.com', keywords: ['test keyword'], seoScope: 'national', country: null } };
    const res = mockRes();

    await checkRanking(req, res);

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.success, false);
    assert.match(res.body.message, /location could not be determined/i);
  });

  test('unsupported country: national scope with an unsupported code returns 400 naming the supported list', async () => {
    const req = { body: { domain: 'example.com', keywords: ['test keyword'], seoScope: 'national', country: 'ZZ' } };
    const res = mockRes();

    await checkRanking(req, res);

    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /not yet supported/i);
    assert.match(res.body.message, /US/); // the supported-list text must actually list codes
  });

  test('supported country: national scope with a real supported country (IN) resolves 2356 and reaches the SERP call', async () => {
    let capturedLocationCode = null;
    DataForSeoService.getSerpOrganic = async (keyword, locationCode) => {
      capturedLocationCode = locationCode;
      return emptySerpResponse();
    };

    const req = { body: { domain: 'example.com', keywords: ['test keyword'], seoScope: 'national', country: 'IN' } };
    const res = mockRes();

    await checkRanking(req, res);

    assert.equal(res.statusCode, 200, `location guard should not fire for a supported country; got: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.location_code, 2356, 'must rank against India, never a US default');
    assert.equal(capturedLocationCode, 2356, 'the SERP call itself must have used the India location code');
  });

  test('national keyword project: country=US resolves 2840 as a legitimate (non-default) result', async () => {
    DataForSeoService.getSerpOrganic = async () => emptySerpResponse();

    const req = { body: { domain: 'example.com', keywords: ['test keyword'], seoScope: 'national', country: 'US' } };
    const res = mockRes();

    await checkRanking(req, res);

    assert.equal(res.body.data.location_code, 2840);
    assert.equal(res.body.data.mapping_method, 'national_country_code');
  });

  test('local keyword project: seoScope=local with a known city resolves without guessing US', async () => {
    DataForSeoService.getSerpOrganic = async () => emptySerpResponse();

    const req = {
      body: {
        domain: 'example.com',
        keywords: ['test keyword'],
        seoScope: 'local',
        country: 'IN',
        cityName: 'Nashik',
      },
    };
    const res = mockRes();

    await checkRanking(req, res);

    assert.notEqual(res.statusCode, 400, `local scope with a known city/country must not hit the guard; got: ${JSON.stringify(res.body)}`);
    assert.notEqual(res.body.data.location_code, 2840, 'a Nashik/India project must never resolve to the US code');
  });

  test('DataForSEO API failure: a downstream SERP error degrades one keyword to rank:null, never a 500 or a fabricated rank', async () => {
    DataForSeoService.getSerpOrganic = async () => {
      throw new Error('simulated DataForSEO outage');
    };

    const req = { body: { domain: 'example.com', keywords: ['test keyword'], seoScope: 'national', country: 'IN' } };
    const res = mockRes();

    await checkRanking(req, res);

    assert.equal(res.body.success, true, 'a per-keyword SERP failure must not fail the whole request');
    assert.equal(res.body.data.results[0].rank, null);
    assert.equal(res.body.data.results[0].best_rank, null);
  });
});
