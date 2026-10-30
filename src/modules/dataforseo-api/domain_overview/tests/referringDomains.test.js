import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDomainQuality, dofollowPercent, isSitewide, topKey } from '../provider/referringDomainMetrics.js';
import { parseReferringDomainsQuery, parseDofollow, parseLimit, parseOrderBy, parseStatus, buildVariant } from '../validator/referringDomainsQuery.js';
import { parseDomainListChange } from '../validator/domainListInput.js';
import { buildRequest, parseCountResult, parseReferringDomain, parseReferringDomains } from '../provider/domainOverviewProvider.js';
import { ProviderBudgetExceeded, takeProviderCalls, __resetProviderBudgetForTests } from '../service/providerBudget.js';
import { RD_CSV_COLUMNS, RD_CSV_HEADER, referringDomainCsvLine } from '../csv/referringDomainsCsv.js';
import { DOMAIN_LISTS, DOMAIN_QUALITY, RANK_BUCKETS, REFERRING_DOMAINS_QUERY, SECTIONS } from '../config.js';
import { RAW_RD_DEFAULT, RAW_RD_COUNT_BUCKET, RAW_RD_LOST, RAW_RD_SPAMMY } from './realReferringDomains.js';

const f = (...c) => JSON.stringify(c.length === 1 ? c[0] : c.flatMap((x, i) => (i ? ['and', x] : [x])));
const rejects = (fn, field) => assert.throws(fn, (e) => e.name === 'ValidationFailure' && (!field || e.field === field));
const q = (rank, spamScore, backlinks = 10, dofollowPct = 100) => classifyDomainQuality({ rank, spamScore, backlinks, dofollowPct });

describe('classifyDomainQuality: the tiers and every boundary', () => {
  test('High: rank >= 300 and spam <= 10', () => {
    assert.equal(q(300, 10), 'high');
    assert.equal(q(1000, 0), 'high');
    assert.equal(q(299, 0), 'medium');
    assert.equal(q(300, 11), 'medium');
  });
  test('Medium: rank >= 150 and spam <= 30', () => {
    assert.equal(q(150, 30), 'medium');
    assert.equal(q(299, 30), 'medium');
    assert.equal(q(149, 0), 'low');
    assert.equal(q(150, 31), 'toxic');
  });
  test('Toxic: spam above 30, whatever the rank', () => {
    assert.equal(q(900, 31), 'toxic');
    assert.equal(q(0, 31), 'toxic');
    assert.equal(q(300, 100), 'toxic');
    assert.equal(q(300, 30), 'medium');
  });
  test('Toxic: rank < 50 and backlinks >= 100 and dofollow share < 10% — all three, strictly', () => {
    assert.equal(q(49, 5, 100, 9.9), 'toxic');
    assert.equal(q(50, 5, 100, 9.9), 'low', 'rank 50 is not below 50');
    assert.equal(q(49, 5, 99, 9.9), 'low', '99 backlinks is under the limit');
    assert.equal(q(49, 5, 100, 10), 'low', '10% is not below 10%');
    assert.equal(q(49, 5, 100, 0), 'toxic');
  });
  test('Low is everything else with a known rank and spam score', () => {
    assert.equal(q(0, 0), 'low');
    assert.equal(q(100, 20), 'low');
    assert.equal(q(149, 30), 'low');
  });
  test('missing data: spam above 30 is still toxic; otherwise it is not guessed (null)', () => {
    assert.equal(classifyDomainQuality({ rank: null, spamScore: 80, backlinks: null, dofollowPct: null }), 'toxic');
    assert.equal(classifyDomainQuality({ rank: null, spamScore: 5, backlinks: 5, dofollowPct: 50 }), null);
    assert.equal(classifyDomainQuality({ rank: 400, spamScore: null, backlinks: 5, dofollowPct: 50 }), null);
    assert.equal(classifyDomainQuality({ rank: 20, spamScore: 5, backlinks: 500, dofollowPct: null }), 'low', 'the low-rank rule needs the dofollow share: without it, no toxic claim');
    assert.equal(classifyDomainQuality({}), null);
  });
  test('the thresholds come from ONE config object', () => {
    assert.deepEqual(DOMAIN_QUALITY.high, { minRank: 300, maxSpam: 10 });
    assert.deepEqual(DOMAIN_QUALITY.medium, { minRank: 150, maxSpam: 30 });
    assert.equal(DOMAIN_QUALITY.toxic.spamAbove, 30);
    assert.equal(classifyDomainQuality({ rank: 100, spamScore: 5, backlinks: 1, dofollowPct: 100 }, { ...DOMAIN_QUALITY, medium: { minRank: 100, maxSpam: 30 } }), 'medium');
  });
});

describe('derived values', () => {
  test('dofollow share = (pages - nofollow pages) / pages', () => {
    assert.equal(dofollowPercent(100, 25), 75);
    assert.equal(dofollowPercent(10, 0), 100);
    assert.equal(dofollowPercent(10, 10), 0);
    assert.equal(dofollowPercent(10, 50), 0, 'held in range');
    assert.equal(dofollowPercent(0, 0), null);
    assert.equal(dofollowPercent(null, 1), null);
    assert.equal(dofollowPercent(10, null), null);
  });
  test('sitewide: 50+ referring pages, OR footer links are 80% of them', () => {
    assert.equal(isSitewide(50, {}), true);
    assert.equal(isSitewide(49, {}), false);
    assert.equal(isSitewide(10, { footer: 8 }), true);
    assert.equal(isSitewide(10, { footer: 7 }), false);
    assert.equal(isSitewide(49, { footer: 40 }), true);
    assert.equal(isSitewide(49, { footer: 39 }), false);
    assert.equal(isSitewide(0, { footer: 0 }), false);
    assert.equal(isSitewide(null, { footer: 5 }), null);
    assert.equal(isSitewide(10, null), false);
  });
  test('the top key of a breakdown: highest count, ties to the smaller key, "" is a real key, none = null', () => {
    assert.equal(topKey({ IN: 880, '': 178, WW: 3 }), 'IN');
    assert.equal(topKey({ b: 5, a: 5 }), 'a');
    assert.equal(topKey({ '': 9, IN: 1 }), '');
    assert.equal(topKey({}), null);
    assert.equal(topKey(null), null);
    assert.equal(topKey({ a: 'x' }), null);
  });
});

describe('the referring-domains query: whitelists and canonical form', () => {
  test('no parameters = the default view: live, not dofollow-only, 50, offset 0, rank desc, no filters', () => {
    const r = parseReferringDomainsQuery({});
    assert.deepEqual([r.status, r.dofollow, r.limit, r.offset, r.orderBy, r.filters, r.isDefault], ['live', false, 50, 0, 'rank,desc', [], true]);
  });
  test('status: live / lost; page size 25 / 50 / 100 / 1000', () => {
    assert.equal(parseStatus('lost'), 'lost');
    rejects(() => parseStatus('all'), 'status');
    for (const n of ['25', '50', '100', '1000']) assert.equal(parseLimit(n), Number(n));
    for (const n of ['10', '0', '-1', 'abc']) rejects(() => parseLimit(n), 'limit');
  });
  test('every sort field of the brief is accepted; others are not', () => {
    for (const field of ['rank', 'backlinks', 'referring_pages', 'backlinks_spam_score', 'broken_backlinks', 'first_seen']) assert.equal(parseOrderBy(`${field},desc`), `${field},desc`);
    for (const bad of ['domain,asc', 'referring_domains,desc', 'rank', 'rank,up', ['rank,asc', 'backlinks,desc']]) rejects(() => parseOrderBy(bad), 'order_by');
  });
  test('dofollow: 1 / true; the default is off; anything else is refused', () => {
    assert.equal(parseDofollow('1'), true);
    assert.equal(parseDofollow('true'), true);
    assert.equal(parseDofollow(undefined), false);
    assert.equal(parseDofollow('0'), false);
    rejects(() => parseDofollow('yes'), 'dofollow');
  });
  test('dofollow-only is a DIFFERENT purchase: it is part of the cache key', () => {
    assert.notEqual(parseReferringDomainsQuery({ dofollow: '1' }).variant, parseReferringDomainsQuery({}).variant);
    assert.equal(parseReferringDomainsQuery({ dofollow: '0' }).variant, parseReferringDomainsQuery({}).variant);
  });
  test('offset + limit may not pass 20,000', () => {
    assert.equal(parseReferringDomainsQuery({ limit: '100', offset: '19900' }).offset, 19900);
    rejects(() => parseReferringDomainsQuery({ limit: '100', offset: '19901' }), 'offset');
  });
  test('every filter of the brief is accepted', () => {
    const filters = f(['domain', 'like', '%news%'], ['domain', 'not_like', '%spam%'], ['rank', '>=', 100], ['rank', '<=', 500], ['backlinks_spam_score', '<=', 30], ['backlinks', '>=', 5], ['broken_backlinks', '>', 0], ['first_seen', '>=', '2025-04-01']);
    assert.equal(parseReferringDomainsQuery({ filters }).filters.length, 8);
  });
  test('the New tab (first_seen) and the Toxic tab (spam > 30) are filters too', () => {
    assert.deepEqual(parseReferringDomainsQuery({ filters: f(['first_seen', '>=', '2026-09-28']) }).filters, [['first_seen', '>=', '2026-09-28']]);
    assert.deepEqual(parseReferringDomainsQuery({ filters: f(['backlinks_spam_score', '>', 30]) }).filters, [['backlinks_spam_score', '>', 30]]);
  });
  test('the Disavowed tab: domain "in" a list, lowercase, sorted, de-duplicated, at most 100', () => {
    const r = parseReferringDomainsQuery({ filters: f(['domain', 'in', ['b.com', 'a.com', 'b.com']]) });
    assert.deepEqual(r.filters, [['domain', 'in', ['a.com', 'b.com']]]);
    const hundred = Array.from({ length: 100 }, (_, i) => `d${i}.com`);
    assert.equal(parseReferringDomainsQuery({ filters: f(['domain', 'in', hundred]) }).filters[0][2].length, 100);
    rejects(() => parseReferringDomainsQuery({ filters: f(['domain', 'in', [...hundred, 'extra.com']]) }), 'filters');
    for (const bad of [[], 'a.com', ['A.com'], ['not a domain'], ['a.com/path'], [5], ['http://a.com'], ['a']]) rejects(() => parseReferringDomainsQuery({ filters: f(['domain', 'in', bad]) }), 'filters');
  });
  test('the same domains in another order are the same cache entry', () => {
    const a = parseReferringDomainsQuery({ filters: f(['domain', 'in', ['b.com', 'a.com']]) });
    const b = parseReferringDomainsQuery({ filters: f(['domain', 'in', ['a.com', 'b.com']]) });
    assert.equal(a.variant, b.variant);
  });
  test('filters outside the whitelist are refused', () => {
    for (const bad of [
      f(['domain', '=', 'a.com']), f(['rank', '<', 5]), f(['rank', '>=', 1001]), f(['rank', '>=', -1]), f(['rank', '>=', 1.5]), f(['backlinks_spam_score', '>=', 5]),
      f(['backlink_spam_score', '<=', 5]), f(['broken_backlinks', '>', 3]), f(['first_seen', '>=', '2025-13-40']), f(['referring_pages', '>=', 1]), f(['domain', 'like', 'plain']), 'zzz',
    ]) rejects(() => parseReferringDomainsQuery({ filters: bad }), 'filters');
  });
  test('at most 8 conditions: a tab\'s own filter counts, the 9th is refused with a message that says so', () => {
    const eight = Array.from({ length: 8 }, (_, i) => ['backlinks', '>=', i + 1]);
    assert.equal(parseReferringDomainsQuery({ filters: f(...eight) }).filters.length, 8);
    assert.throws(() => parseReferringDomainsQuery({ filters: f(...eight, ['rank', '>=', 1]) }), /at most 8 filter conditions/);
  });
  test('internal_list_limit is part of the key', () => {
    assert.match(buildVariant({ status: 'live', dofollow: false, limit: 50, offset: 0, orderBy: 'rank,desc', filters: [] }), new RegExp(`\\|i${REFERRING_DOMAINS_QUERY.internalListLimit}\\|`));
  });
});

describe('the request the provider receives', () => {
  const target = 'asgeyehospital.com';
  test('the default view', () => {
    assert.deepEqual(buildRequest('referring-domains', { target, market: {} }), {
      target, include_subdomains: true, backlinks_status_type: 'live', internal_list_limit: 10, limit: 50, order_by: ['rank,desc'],
    });
  });
  test('"Dofollow links only" is backlinks_filters — never one of the filters, and absent when off', () => {
    const on = buildRequest('referring-domains', { target, market: {}, query: parseReferringDomainsQuery({ dofollow: '1', filters: f(['rank', '>=', 100]) }) });
    assert.deepEqual(on.backlinks_filters, ['dofollow', '=', true]);
    assert.deepEqual(on.filters, ['rank', '>=', 100]);
    assert.equal('backlinks_filters' in buildRequest('referring-domains', { target, market: {}, query: parseReferringDomainsQuery({ dofollow: '0' }) }), false);
  });
  test('status, page, sort and several filters (joined with "and")', () => {
    const r = buildRequest('referring-domains', { target, market: {}, query: parseReferringDomainsQuery({ status: 'lost', limit: '25', offset: '50', order_by: 'first_seen,asc', filters: f(['rank', '>=', 1], ['backlinks', '>=', 2]) }) });
    assert.deepEqual([r.backlinks_status_type, r.limit, r.offset, r.order_by, r.filters], ['lost', 25, 50, ['first_seen,asc'], [['backlinks', '>=', 2], 'and', ['rank', '>=', 1]]]);
  });
  test('the Disavowed tab asks for its slice with domain "in"', () => {
    const r = buildRequest('referring-domains', { target, market: {}, query: parseReferringDomainsQuery({ filters: f(['domain', 'in', ['b.com', 'a.com']]) }) });
    assert.deepEqual(r.filters, ['domain', 'in', ['a.com', 'b.com']]);
  });
  test('the rank buckets: ONE count-only request per bucket — live, limit 1, only the rank range, no backlinks_filters', () => {
    const bodies = buildRequest('rd-rank-buckets', { target });
    assert.equal(bodies.length, 5);
    assert.deepEqual(bodies.map((b) => b.filters), [
      [['rank', '>=', 0], 'and', ['rank', '<=', 99]], [['rank', '>=', 100], 'and', ['rank', '<=', 199]], [['rank', '>=', 200], 'and', ['rank', '<=', 299]],
      [['rank', '>=', 300], 'and', ['rank', '<=', 499]], ['rank', '>=', 500],
    ]);
    for (const b of bodies) {
      assert.equal(b.limit, 1);
      assert.equal(b.backlinks_status_type, 'live');
      assert.equal('backlinks_filters' in b, false);
      assert.equal(b.target, target);
    }
    assert.deepEqual(RANK_BUCKETS.map((b) => b.key), ['0-99', '100-199', '200-299', '300-499', '500+']);
  });
  test('the toxic count: ONE request — live, limit 1, spam above 30, nothing else', () => {
    const b = buildRequest('rd-toxic-count', { target });
    assert.deepEqual(b.filters, ['backlinks_spam_score', '>', 30]);
    assert.equal(b.limit, 1);
    assert.equal(b.backlinks_status_type, 'live');
    assert.equal('backlinks_filters' in b, false);
  });
  test('cache lifetimes: 24 hours for the table, 7 days for the two count cards, each under its own name', () => {
    assert.equal(SECTIONS['referring-domains'].ttlMs, 24 * 3600 * 1000);
    assert.equal(SECTIONS['rd-rank-buckets'].ttlMs, 7 * 24 * 3600 * 1000);
    assert.equal(SECTIONS['rd-toxic-count'].ttlMs, 7 * 24 * 3600 * 1000);
    assert.equal(new Set([SECTIONS['referring-domains'].endpoint, SECTIONS['rd-rank-buckets'].endpoint, SECTIONS['rd-toxic-count'].endpoint]).size, 3);
  });
});

describe('parsing REAL provider rows (asgeyehospital.com)', () => {
  const parsed = parseReferringDomains(RAW_RD_DEFAULT);
  const by = (d) => parsed.items.find((x) => x.domain === d);

  test('the total and every row, with the counts as numbers', () => {
    assert.equal(parsed.totalCount, 3958);
    assert.equal(parsed.items.length, 10);
    assert.deepEqual([by('vasaneye.com').rank, by('vasaneye.com').backlinks, by('vasaneye.com').referring_pages, by('vasaneye.com').backlinks_spam_score], [258, 761, 761, 0]);
  });
  test('quality is on every row, decided by the server', () => {
    assert.equal(by('vasaneye.com').quality, 'medium');
    assert.equal(parseReferringDomains(RAW_RD_SPAMMY).items.find((x) => x.domain === 'digitalpool.com').quality, 'toxic');
    for (const r of parsed.items) assert.ok(['high', 'medium', 'low', 'toxic'].includes(r.quality), r.domain);
  });
  test('the derived values: dofollow share, sitewide, top country, main placement', () => {
    const v = by('vasaneye.com');
    assert.deepEqual([v.dofollow_pct, v.is_sitewide, v.top_country, v.main_placement], [100, true, 'IN', 'footer']);
    const n = by('net-pals.com'); // 87 referring pages, 58 of them with a nofollow link
    assert.equal(n.referring_pages, 87);
    assert.equal(n.referring_pages_nofollow, 58);
    assert.ok(Math.abs(n.dofollow_pct - ((87 - 58) / 87) * 100) < 1e-9);
    assert.equal(by('whatson.plus').is_sitewide, by('whatson.plus').referring_pages >= 50);
  });
  test('the breakdowns are { key: count } objects; "" is kept; an absent one is null', () => {
    assert.deepEqual(by('vasaneye.com').referring_links_semantic_locations, { footer: 761 });
    assert.equal(by('vasaneye.com').referring_links_attributes, null);
    assert.deepEqual(by('vasaneye.com').referring_links_countries, { IN: 761 });
  });
  test('the lost list carries lost dates', () => {
    const lost = parseReferringDomains(RAW_RD_LOST);
    assert.equal(lost.totalCount, 321);
    assert.ok(lost.items.every((r) => typeof r.lost_date === 'string' && r.lost_date.length > 8));
  });
  test('the domain is lowercase and trimmed; a row without one is dropped', () => {
    assert.equal(parseReferringDomain({ domain: '  Example.COM ', rank: 1 }).domain, 'example.com');
    assert.equal(parseReferringDomain({ rank: 1 }), null);
    assert.equal(parseReferringDomain({ domain: '   ' }), null);
    assert.equal(parseReferringDomains({ total_count: 1, items: [{ rank: 5 }, { domain: 'a.com' }] }).items.length, 1);
  });
  test('missing or non-numeric counts are null, never 0, and a row with no data has no quality', () => {
    const r = parseReferringDomain({ domain: 'a.com', backlinks: '12', rank: NaN });
    assert.deepEqual([r.backlinks, r.rank, r.backlinks_spam_score, r.dofollow_pct, r.quality, r.is_sitewide, r.top_country, r.main_placement], [null, null, null, null, null, null, null, null]);
  });
  test('a filter that matches nothing (total_count null, items null) is 0 domains, not "unknown"', () => {
    assert.deepEqual(parseReferringDomains({ total_count: null, items_count: 0, items: null }), { totalCount: 0, items: [] });
    assert.equal(parseReferringDomains(null).totalCount, null);
  });
  test('count-only answers: total_count, 0 when nothing matched, null when the provider said nothing', () => {
    assert.equal(parseCountResult(RAW_RD_COUNT_BUCKET), 118);
    assert.equal(parseCountResult({ total_count: null, items: null }), 0);
    assert.equal(parseCountResult(null), null);
  });
});

describe('domain list changes (disavowed / reviewed)', () => {
  test('every domain goes through the shared normalizer, and is de-duplicated BEFORE anything is written', () => {
    const c = parseDomainListChange({ disavowed: { add: ['  HTTPS://www.Spam.com/path?x=1 ', 'spam.com', 'Other.org'] } });
    assert.deepEqual(c.disavowed.add, ['spam.com', 'other.org']);
    assert.deepEqual(c.reviewed, { add: [], remove: [] });
  });
  test('an invalid domain rejects the WHOLE change, whichever list or direction', () => {
    for (const bad of ['', '   ', 'localhost', '127.0.0.1', 'single-label', 'a b.com', 'ftp://a.com', 'javascript:alert(1)', 'a..com', '-a.com', 42, null, ['a.com'], { d: 1 }]) {
      rejects(() => parseDomainListChange({ disavowed: { add: ['ok.com', bad] } }), 'disavowed.add');
      rejects(() => parseDomainListChange({ reviewed: { add: [bad] } }), 'reviewed.add');
      rejects(() => parseDomainListChange({ disavowed: { remove: [bad] } }), 'disavowed.remove');
    }
  });
  test('the project\'s own domain can be neither disavowed nor reviewed', () => {
    rejects(() => parseDomainListChange({ disavowed: { add: ['www.Mine.com'] } }, 'mine.com'), 'disavowed.add');
    rejects(() => parseDomainListChange({ reviewed: { add: ['mine.com'] } }, 'mine.com'), 'reviewed.add');
    assert.doesNotThrow(() => parseDomainListChange({ disavowed: { remove: ['mine.com'] } }, 'mine.com'));
  });
  test('a change needs something in it, and the right shape', () => {
    for (const bad of [undefined, null, [], 'x', {}, { disavowed: {} }, { disavowed: { add: [] } }, { disavowed: [] }, { disavowed: 'a.com' }, { disavowed: { add: 'a.com' } }]) rejects(() => parseDomainListChange(bad));
  });
  test('contradictions are refused: disavowed and OK at once, added and removed at once', () => {
    assert.throws(() => parseDomainListChange({ disavowed: { add: ['a.com'] }, reviewed: { add: ['a.com'] } }), /cannot be disavowed and marked as OK/);
    assert.throws(() => parseDomainListChange({ disavowed: { add: ['a.com'], remove: ['a.com'] } }), /added and removed at the same time/);
  });
  test('one change is limited to 1,000 domains', () => {
    const many = Array.from({ length: DOMAIN_LISTS.maxPerChange + 1 }, (_, i) => `d${i}.com`);
    rejects(() => parseDomainListChange({ disavowed: { add: many } }), 'disavowed.add');
    assert.equal(parseDomainListChange({ disavowed: { add: many.slice(1) } }).disavowed.add.length, DOMAIN_LISTS.maxPerChange);
  });
});

describe('the budget of real provider calls (for the two count cards)', () => {
  const budget = { bucket: 't', windowMs: 1000, maxProviderCalls: 5 };
  test('calls up to the budget are fine; one more is refused and reserves nothing', () => {
    __resetProviderBudgetForTests();
    takeProviderCalls('u1', 5, budget, 0);
    assert.throws(() => takeProviderCalls('u1', 1, budget, 10), ProviderBudgetExceeded);
    __resetProviderBudgetForTests();
    takeProviderCalls('u1', 3, budget, 0);
    assert.throws(() => takeProviderCalls('u1', 3, budget, 10), ProviderBudgetExceeded);
    takeProviderCalls('u1', 2, budget, 20); // the refused 3 reserved nothing
  });
  test('the window slides: old calls stop counting', () => {
    __resetProviderBudgetForTests();
    takeProviderCalls('u1', 5, budget, 0);
    takeProviderCalls('u1', 5, budget, 1001);
  });
  test('each user and each bucket has its own budget', () => {
    __resetProviderBudgetForTests();
    takeProviderCalls('u1', 5, budget, 0);
    takeProviderCalls('u2', 5, budget, 0);
    takeProviderCalls('u1', 5, { ...budget, bucket: 'other' }, 0);
  });
});

describe('the CSV columns', () => {
  const ctx = { disavowed: new Set(['spam.com']) };
  test('the columns of the brief, in order', () => {
    assert.deepEqual(RD_CSV_HEADER, ['Domain', 'Quality', 'Rank', 'Backlinks', 'Referring pages', 'Dofollow %', 'Spam score', 'Placement', 'Top country', 'Broken backlinks', 'First seen', 'Lost date', 'Disavowed']);
    assert.equal(RD_CSV_COLUMNS.length, RD_CSV_HEADER.length);
  });
  test('a real row: quality label, one-decimal dofollow share, placement, country and the disavowed flag', () => {
    const row = parseReferringDomains(RAW_RD_DEFAULT).items[0];
    assert.equal(referringDomainCsvLine(row, ctx), `vasaneye.com,Medium,258,761,761,100,0,footer,IN,761,${row.first_seen},,no\r\n`);
    assert.match(referringDomainCsvLine({ ...row, domain: 'spam.com' }, ctx), /^spam\.com,.*,yes\r\n$/);
  });
  test('a missing value is an empty cell, never 0; an unknown country or placement is empty', () => {
    assert.equal(referringDomainCsvLine({ domain: 'a.com', quality: null, top_country: '', main_placement: '' }, ctx), 'a.com,,,,,,,,,,,,no\r\n');
  });
  test('a domain that looks like a formula is neutralised', () => {
    assert.match(referringDomainCsvLine({ domain: '=cmd|x' }, ctx), /^'=cmd\|x,/);
  });
});
