import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { scanKeywordDevices, buildDeviceResult } from './deviceSerpScan.js';
import { RankingParserService } from './RankingParserService.js';

/**
 * Collection logic: each device is requested independently and reports its own
 * outcome. Provider is faked via the injectable serpFetcher (no network).
 *
 * Run from backend/:  node --test src/modules/ranking/services/deviceSerpScan.test.js
 */

const organic = (rank, domain) => ({ type: 'organic', rank_group: rank, rank_absolute: rank, domain, url: `https://${domain}/p${rank}` });
const serp = (...items) => ({ tasks: [{ status_code: 20000, result: [{ items }] }] });
const filler = (n) => Array.from({ length: n }, (_, i) => organic(i + 1, `other${i + 1}.com`));

const fetcherFor = (byDevice) => async (_k, _l, _lang, { device }) => {
  const v = byDevice[device];
  if (v instanceof Error) throw v;
  return v;
};

describe('scanKeywordDevices', () => {
  test('both devices succeed and are requested with their own device', async () => {
    const seen = [];
    const serpFetcher = async (_k, _l, _lang, { device }) => {
      seen.push(device);
      return device === 'desktop' ? serp(organic(8, 'site.com')) : serp(organic(11, 'site.com'));
    };
    const { desktop, mobile } = await scanKeywordDevices({ keyword: 'k', locationCode: 1, languageCode: 'en', serpFetcher, mobileEnabled: true });
    assert.deepEqual(seen.sort(), ['desktop', 'mobile']);
    assert.equal(buildDeviceResult(desktop, 'site.com').best_rank, 8);
    assert.equal(buildDeviceResult(mobile, 'site.com').best_rank, 11);
  });

  test('desktop succeeds while mobile fails: desktop is NOT failed, mobile carries scan_error and no rank', async () => {
    const serpFetcher = fetcherFor({ desktop: serp(organic(5, 'site.com')), mobile: new Error('timeout') });
    const { desktop, mobile } = await scanKeywordDevices({ keyword: 'k', locationCode: 1, languageCode: 'en', serpFetcher, mobileEnabled: true });
    const d = buildDeviceResult(desktop, 'site.com');
    const m = buildDeviceResult(mobile, 'site.com');
    assert.equal(d.scan_error, null);
    assert.equal(d.best_rank, 5);
    assert.equal(m.scan_error, 'timeout');
    assert.equal(m.best_rank, null);
    assert.deepEqual(m.ranking_urls, []);
  });

  test('mobile succeeds while desktop fails', async () => {
    const serpFetcher = fetcherFor({ desktop: new Error('boom'), mobile: serp(organic(3, 'site.com')) });
    const { desktop, mobile } = await scanKeywordDevices({ keyword: 'k', locationCode: 1, languageCode: 'en', serpFetcher, mobileEnabled: true });
    assert.equal(buildDeviceResult(desktop, 'site.com').scan_error, 'boom');
    assert.equal(buildDeviceResult(mobile, 'site.com').best_rank, 3);
    assert.equal(buildDeviceResult(mobile, 'site.com').scan_error, null);
  });

  test('both devices fail: two independent errors, no exception escapes', async () => {
    const serpFetcher = fetcherFor({ desktop: new Error('e1'), mobile: new Error('e2') });
    const { desktop, mobile } = await scanKeywordDevices({ keyword: 'k', locationCode: 1, languageCode: 'en', serpFetcher, mobileEnabled: true });
    assert.equal(buildDeviceResult(desktop, 'site.com').scan_error, 'e1');
    assert.equal(buildDeviceResult(mobile, 'site.com').scan_error, 'e2');
  });

  test('mobile disabled: only desktop is requested and mobile is null (not an empty result)', async () => {
    let calls = 0;
    const serpFetcher = async () => { calls++; return serp(organic(2, 'site.com')); };
    const { mobile } = await scanKeywordDevices({ keyword: 'k', locationCode: 1, languageCode: 'en', serpFetcher, mobileEnabled: false });
    assert.equal(calls, 1);
    assert.equal(mobile, null);
    assert.equal(buildDeviceResult(mobile, 'site.com'), null);
  });
});

describe('buildDeviceResult — found vs not found vs failed', () => {
  const scan = (data) => ({ device: 'mobile', serpData: data, serpError: null, scanned_at: new Date() });

  test('a successful response containing the domain yields its rank and URLs', () => {
    const r = buildDeviceResult(scan(serp(organic(1, 'a.com'), organic(7, 'site.com'))), 'site.com');
    assert.equal(r.best_rank, 7);
    assert.equal(r.ranking_urls.length, 1);
    assert.equal(r.scan_error, null);
  });

  test('a successful response with no match is a confirmed not-found for the observed depth', () => {
    const r = buildDeviceResult(scan(serp(...filler(100))), 'site.com');
    assert.equal(r.scan_error, null);
    assert.equal(r.best_rank, null);
    assert.deepEqual(r.ranking_urls, []);
    assert.equal(r.tracked_depth, 100);
  });

  test('the tracked range comes from the response, not an assumed constant', () => {
    const r = buildDeviceResult(scan(serp(...filler(37))), 'site.com');
    assert.equal(r.tracked_depth, 37);
  });

  test('a successful but organic-less response proves no range (tracked_depth null)', () => {
    const r = buildDeviceResult(scan(serp()), 'site.com');
    assert.equal(r.scan_error, null);
    assert.equal(r.tracked_depth, null);
  });

  test('a failed scan has an error and is distinguishable from not-found', () => {
    const r = buildDeviceResult({ device: 'mobile', serpData: null, serpError: 'x', scanned_at: new Date() }, 'site.com');
    assert.equal(r.scan_error, 'x');
    assert.equal(r.tracked_depth, null);
  });

  test('observedOrganicDepth is capped at 100', () => {
    assert.equal(RankingParserService.observedOrganicDepth(serp(organic(150, 'a.com'))), 100);
  });
});
