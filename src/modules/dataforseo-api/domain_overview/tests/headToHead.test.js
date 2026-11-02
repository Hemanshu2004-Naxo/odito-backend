import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, parseHeadToHead, parseSectionResponse } from '../provider/domainOverviewProvider.js';
import { HEAD_TO_HEAD, SECTIONS } from '../config.js';

/**
 * The head-to-head (DataForSEO Labs domain_intersection). The fixture below has the shape of a REAL answer (checked live on 2026-11-02
 * for krishnaeyecentre.com vs kbhbhospital.com: total_count 1, cost 0.01212); only the long parts were trimmed.
 */

const REAL_SHAPED = {
  status_code: 20000,
  cost: 0.01212,
  tasks: [{
    status_code: 20000,
    cost: 0.01212,
    result: [{
      se_type: 'google', target1: 'krishnaeyecentre.com', target2: 'kbhbhospital.com', location_code: 2356, language_code: 'en', total_count: 1, items_count: 1,
      items: [{
        se_type: 'google',
        keyword_data: { se_type: 'google', keyword: 'bachooali hospital parel', keyword_info: { search_volume: 590, cpc: 0.6000000238418579, competition: 0.15000000596046448 } },
        first_domain_serp_element: { type: 'organic', rank_group: 15, rank_absolute: 17, domain: 'krishnaeyecentre.com', url: 'https://krishnaeyecentre.com/', etv: 5.844130039215088 },
        second_domain_serp_element: { type: 'organic', rank_group: 3, rank_absolute: 4, domain: 'kbhbhospital.com', url: 'https://kbhbhospital.com/', etv: 120.5 },
      }],
    }],
  }],
};

describe('head-to-head request', () => {
  const market = { location_name: 'India', language_name: 'English' };
  test('the project is target1, the competitor target2, in the project market, intersections on, organic only, most-searched first', () => {
    const body = buildRequest('head-to-head', { target: 'kbhbhospital.com', market, query: { projectDomain: 'krishnaeyecentre.com' } });
    assert.deepEqual(body, {
      target1: 'krishnaeyecentre.com', target2: 'kbhbhospital.com', location_name: 'India', language_name: 'English',
      intersections: true, item_types: ['organic'], limit: 100, order_by: ['keyword_data.keyword_info.search_volume,desc'],
    });
  });
  test('it is cached for a week (the provider updates weekly), under its own endpoint name', () => {
    assert.equal(SECTIONS['head-to-head'].endpoint, 'labs/domain_intersection');
    assert.equal(SECTIONS['head-to-head'].ttlMs, 7 * 24 * 60 * 60 * 1000);
    assert.equal(HEAD_TO_HEAD.keywordLimit, 100);
  });
  test('no device or search-engine parameter is invented: the endpoint documents none', () => {
    const body = buildRequest('head-to-head', { target: 'a.com', market, query: { projectDomain: 'b.com' } });
    for (const k of ['device', 'os', 'search_engine', 'se_type']) assert.ok(!(k in body), k);
  });
});

describe('parseHeadToHead', () => {
  test('a real-shaped answer: the provider total, and each side\'s position on every shared keyword', () => {
    const { payload, cost } = parseSectionResponse('head-to-head', REAL_SHAPED, { target: 'kbhbhospital.com' });
    assert.equal(cost, 0.01212);
    assert.equal(payload.sharedTotal, 1);
    assert.deepEqual(payload.keywords[0], {
      keyword: 'bachooali hospital parel', search_volume: 590, cpc: 0.6000000238418579, competition: 0.15000000596046448,
      project: { rank_group: 15, rank_absolute: 17, etv: 5.844130039215088, url: 'https://krishnaeyecentre.com/' },
      competitor: { rank_group: 3, rank_absolute: 4, etv: 120.5, url: 'https://kbhbhospital.com/' },
    });
  });
  test('the total is NOT the number of items returned (a long list is cut at the limit)', () => {
    const r = parseHeadToHead({ total_count: 45, items_count: 1, items: REAL_SHAPED.tasks[0].result[0].items });
    assert.deepEqual([r.sharedTotal, r.keywords.length], [45, 1]);
  });
  test('an empty answer (result: []) has NO total - it is never turned into a zero', () => {
    const { payload } = parseSectionResponse('head-to-head', { status_code: 20000, tasks: [{ status_code: 20000, result: [] }] }, { target: 'x.com' });
    assert.deepEqual(payload, { sharedTotal: null, keywords: [] });
  });
  test('a real zero (total_count 0, no items) stays a zero', () => {
    assert.deepEqual(parseHeadToHead({ total_count: 0, items_count: 0, items: null }), { sharedTotal: 0, keywords: [] });
  });
  test('rows without a keyword and non-numeric values are dropped / nulled, not guessed', () => {
    const r = parseHeadToHead({ total_count: 2, items: [{ keyword_data: {} }, { keyword_data: { keyword: 'k', keyword_info: { search_volume: '12' } }, first_domain_serp_element: null }] });
    assert.deepEqual(r.keywords, [{ keyword: 'k', search_volume: null, cpc: null, competition: null, project: null, competitor: null }]);
  });
});
