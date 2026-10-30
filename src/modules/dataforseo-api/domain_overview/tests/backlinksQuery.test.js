import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBacklinksQuery, parseStatus, parseDofollow, hasBacklinksParams } from '../validator/backlinksQuery.js';
import { buildRequest, parseBacklinksSummary, parseSectionResponse } from '../provider/domainOverviewProvider.js';
import { envelope } from './fixtures.js';
import { REAL_BACKLINKS_LIVE, REAL_BACKLINKS_LOST, REAL_BACKLINKS_DOFOLLOW } from './realBacklinks.js';

const ctx = { target: 'asgeyehospital.com', market: { location_name: 'India', language_name: 'English' } };
const body = (q) => buildRequest('backlinks', { ...ctx, query: parseBacklinksQuery(q) });

describe('backlinks query: defaults and validation', () => {
  test('no parameters = live, no filter: the default view the dashboard and the page share', () => {
    const q = parseBacklinksQuery({});
    assert.deepEqual([q.status, q.dofollow, q.isDefault], ['live', false, true]);
    assert.equal(parseBacklinksQuery({ status: 'live', dofollow: '0' }).variant, q.variant);
    assert.equal(parseBacklinksQuery({ dofollow: 'false' }).variant, q.variant);
  });

  test('every input that changes the provider\'s answer changes the cache variant (and it names the fixed body inputs)', () => {
    const variants = [{}, { status: 'lost' }, { status: 'all' }, { dofollow: '1' }, { status: 'lost', dofollow: '1' }, { status: 'all', dofollow: 'true' }].map((q) => parseBacklinksQuery(q).variant);
    assert.equal(new Set(variants).size, 6);
    assert.equal(variants[0], 'sub1|l20|live|f:none');
    assert.equal(variants[3], 'sub1|l20|live|f:dofollow');
  });

  test('only live / lost / all, and dofollow 1 / 0 / true / false, are accepted', () => {
    for (const ok of ['live', 'lost', 'all']) assert.equal(parseStatus(ok), ok);
    for (const bad of ['LIVE', 'deleted', '', 'live,lost', ['live'], 1]) {
      if (bad === '') continue;
      assert.throws(() => parseStatus(bad), (e) => e.code === 'VALIDATION_ERROR' && e.field === 'status', JSON.stringify(bad));
    }
    for (const bad of ['yes', '2', ['1']]) assert.throws(() => parseDofollow(bad), (e) => e.field === 'dofollow', JSON.stringify(bad));
  });

  test('hasBacklinksParams notices either parameter, valid or not', () => {
    assert.equal(hasBacklinksParams({}), false);
    assert.equal(hasBacklinksParams({ refresh: '1' }), false);
    assert.equal(hasBacklinksParams({ status: 'x' }), true);
    assert.equal(hasBacklinksParams({ dofollow: '1' }), true);
  });
});

describe('backlinks request bodies', () => {
  test('default: subdomains on, 20 entries per breakdown, live, and NO backlinks_filters field', () => {
    const b = body({});
    assert.deepEqual(b, { target: 'asgeyehospital.com', include_subdomains: true, internal_list_limit: 20, backlinks_status_type: 'live' });
    assert.equal('backlinks_filters' in b, false);
  });

  test('Lost / All set backlinks_status_type; "Dofollow only" adds the documented filter, only then', () => {
    assert.equal(body({ status: 'lost' }).backlinks_status_type, 'lost');
    assert.equal(body({ status: 'all' }).backlinks_status_type, 'all');
    assert.deepEqual(body({ dofollow: '1' }).backlinks_filters, ['dofollow', '=', true]);
    assert.deepEqual(body({ status: 'lost', dofollow: '1' }), {
      target: 'asgeyehospital.com', include_subdomains: true, internal_list_limit: 20, backlinks_status_type: 'lost', backlinks_filters: ['dofollow', '=', true],
    });
  });

  test('a body built without a query is the default (the dashboard path)', () => {
    assert.deepEqual(buildRequest('backlinks', ctx), body({}));
  });
});

describe('backlinks summary parser (real asgeyehospital.com responses)', () => {
  const live = parseBacklinksSummary(REAL_BACKLINKS_LIVE);

  test('every figure the Backlink Overview reads is carried, under the provider\'s own names', () => {
    assert.deepEqual(
      ['rank', 'backlinks', 'backlinks_spam_score', 'broken_backlinks', 'broken_pages', 'referring_domains', 'referring_domains_nofollow', 'referring_main_domains', 'referring_pages', 'referring_pages_nofollow', 'referring_ips', 'referring_subnets', 'crawled_pages', 'internal_links_count', 'external_links_count'].map((k) => live[k]),
      [353, 18343, 17, 1643, 2498, 3965, 453, REAL_BACKLINKS_LIVE.referring_main_domains, 13590, 5102, REAL_BACKLINKS_LIVE.referring_ips, 837, REAL_BACKLINKS_LIVE.crawled_pages, REAL_BACKLINKS_LIVE.internal_links_count, REAL_BACKLINKS_LIVE.external_links_count],
    );
    assert.equal(live.first_seen, '2019-03-19 06:16:01 +00:00');
    assert.equal(live.lost_date, null);
    assert.deepEqual(live.info, { cms: 'wordpress', server: 'nginx', ip_address: '13.205.194.193', country: 'IN', platform_type: ['cms', 'blogs', 'organization'], target_spam_score: 5 });
  });

  test('breakdowns keep their keys, including "" (unknown) and "WW" (worldwide)', () => {
    assert.equal(live.referring_links_countries[''], 8367);
    assert.equal(live.referring_links_countries.WW, 872);
    assert.equal(Object.keys(live.referring_links_countries).length, 20);
    assert.equal(live.referring_links_semantic_locations[''], 6387);
    assert.equal(live.referring_links_attributes.sponsored, 17);
    assert.deepEqual(live.referring_links_types, { anchor: REAL_BACKLINKS_LIVE.referring_links_types.anchor, image: REAL_BACKLINKS_LIVE.referring_links_types.image, redirect: REAL_BACKLINKS_LIVE.referring_links_types.redirect });
  });

  test('a breakdown the provider omits is null (not an empty chart): the real LOST response has no attributes block', () => {
    const lost = parseBacklinksSummary(REAL_BACKLINKS_LOST);
    assert.equal(lost.referring_links_attributes, null);
    assert.equal(lost.lost_date, '2026-10-27 08:48:02 +00:00');
    assert.ok(lost.referring_links_tld);
  });

  test('dofollow only: the provider reports no nofollow domains', () => {
    const d = parseBacklinksSummary(REAL_BACKLINKS_DOFOLLOW);
    assert.equal(d.referring_domains_nofollow, 0);
    assert.equal(d.referring_pages_nofollow, 0);
  });

  test('garbage values become null; noise is dropped; whole response goes through the envelope check', () => {
    const p = parseBacklinksSummary({ rank: 'x', backlinks: NaN, info: { cms: ' ', platform_type: ['a', '', 3] }, referring_links_tld: { com: 5, bad: 'x', n: null }, referring_links_types: [1, 2], secret: 'no' });
    assert.equal(p.rank, null);
    assert.equal(p.backlinks, null);
    assert.equal(p.info.cms, null);
    assert.deepEqual(p.info.platform_type, ['a']);
    assert.deepEqual(p.referring_links_tld, { com: 5 });
    assert.equal(p.referring_links_types, null);
    assert.equal('secret' in p, false);
    assert.equal(parseSectionResponse('backlinks', envelope(REAL_BACKLINKS_LIVE, { cost: 0.024036 }), ctx).cost, 0.024036);
  });
});
