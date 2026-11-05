import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { conditionToMongo, conditionsToMongo, fromCanonical, toMongoSort } from '../datasets/mongoQuery.js';
import { KINDS, parseProviderDate } from '../datasets/definitions.js';
import { pickReference } from '../datasets/datasetHistory.js';
import { parseBacklink, parseRankedKeyword, parseReferringDomain } from '../../domain_overview/provider/domainOverviewProvider.js';

describe('mongoQuery: request values never become operators, fields or patterns', () => {
  test('text is escaped, so regex syntax and operator-looking strings are literal', () => {
    const f = conditionToMongo({ path: 'anchor', op: 'like', value: '%.*(a|b)$ne%' });
    assert.equal(f.anchor.$regex, '\\.\\*\\(a\\|b\\)\\$ne');
    assert.equal(f.anchor.$options, 'i');
  });

  test('an unsupported operator is refused', () => {
    assert.throws(() => conditionToMongo({ path: 'a', op: '$where', value: 'x' }), { field: 'filters' });
    assert.throws(() => conditionToMongo({ path: 'a', op: 'regex', value: 'x' }), { field: 'filters' });
  });

  test('fields come only from the whitelist; an unknown provider field is refused', () => {
    const map = KINDS.keywords.fieldMap;
    assert.throws(() => fromCanonical([['$where', '=', 'x']], map), { field: 'filters' });
    assert.throws(() => fromCanonical([['password', 'like', '%x%']], map), { field: 'filters' });
    assert.deepEqual(fromCanonical([['keyword_data.keyword', 'like', '%a%']], map), [{ path: 'normalizedKeyword', op: 'like', value: '%a%', kind: undefined }]);
  });

  test('an "or" group and "no anchor text" translate', () => {
    const map = KINDS.keywords.fieldMap;
    const group = fromCanonical([{ or: [['keyword_data.keyword', 'like', '%a%'], ['keyword_data.keyword', 'like', '%b%']] }], map);
    assert.equal(conditionsToMongo(group).$or.length, 2);
    assert.deepEqual(conditionToMongo({ path: 'anchor', op: '=', value: '' }), { anchor: { $in: [null, ''] } });
  });

  test('dates compare as dates; an impossible one is refused', () => {
    const f = conditionToMongo({ path: 'firstSeen', op: '>=', value: '2025-10-01', kind: 'date' });
    assert.equal(f.firstSeen.$gte.toISOString(), '2025-10-01T00:00:00.000Z');
    assert.throws(() => conditionToMongo({ path: 'firstSeen', op: '>=', value: '2025-13-40', kind: 'date' }), { field: 'filters' });
  });

  test('sorting: whitelisted fields only, with _id as the last key so pages are stable', () => {
    const sort = toMongoSort(['rank,desc', 'first_seen,asc'], KINDS.backlinks.orderMap);
    assert.deepEqual(Object.entries(sort), [['rank', -1], ['firstSeen', 1], ['_id', 1]]);
    assert.throws(() => toMongoSort(['password,asc'], KINDS.backlinks.orderMap), { field: 'order_by' });
    assert.throws(() => toMongoSort(['rank,sideways'], KINDS.backlinks.orderMap), { field: 'order_by' });
    assert.throws(() => toMongoSort(['__proto__,asc'], KINDS.backlinks.orderMap), { field: 'order_by' });
  });
});

describe('row mapping keeps what the provider sent and nothing else', () => {
  const ctx = { market: { location_name: 'India', language_name: 'English' }, status: 'live' };

  test('keywords: a value the provider did not send is null, never 0; the parsed row is stored untouched', () => {
    const row = parseRankedKeyword({ keyword_data: { keyword: 'Foo Bar' }, ranked_serp_element: { serp_item: { rank_group: 4 } } });
    const doc = KINDS.keywords.toDoc(row, ctx);
    assert.equal(doc.position, 4);
    for (const f of ['searchVolume', 'keywordDifficulty', 'cpc', 'trafficEstimate', 'previousPosition', 'searchIntent', 'rankingUrl']) assert.equal(doc[f], null, f);
    assert.equal(doc.normalizedKeyword, 'foo bar');
    assert.equal(doc.device, null);
    assert.deepEqual([doc.location, doc.language], ['India', 'English']);
    assert.notEqual(KINDS.keywords.naturalKey(row, ctx), KINDS.keywords.naturalKey({ ...row, url: 'https://x/other' }, ctx), 'the same keyword ranking with another URL is another record');
    assert.equal(KINDS.keywords.naturalKey(row, ctx), KINDS.keywords.naturalKey({ ...row, keyword: 'foo bar' }, ctx), 'case does not make a second keyword');
  });

  test('backlinks: unknown follow status / ranks / dates stay null; status is part of the natural key', () => {
    const row = parseBacklink({ url_from: 'https://a.com/x', url_to: 'https://b.com/', domain_from: 'a.com' });
    const doc = KINDS.backlinks.toDoc(row, ctx);
    assert.deepEqual([doc.isFollow, doc.rank, doc.domainRank, doc.firstSeen, doc.anchor], [null, null, null, null, null]);
    assert.notEqual(KINDS.backlinks.naturalKey(row, ctx), KINDS.backlinks.naturalKey(row, { ...ctx, status: 'lost' }));
    assert.notEqual(KINDS.backlinks.naturalKey(row, ctx), KINDS.backlinks.naturalKey({ ...row, anchor: 'other' }, ctx));
  });

  test('referring domains: follow / nofollow come from the page counts only when both are known; quality is kept as parsed', () => {
    const known = KINDS.referringDomains.toDoc(parseReferringDomain({ domain: 'a.com', rank: 10, referring_pages: 10, referring_pages_nofollow: 4, backlinks_spam_score: 2, backlinks: 12 }), ctx);
    assert.deepEqual([known.followCount, known.nofollowCount, known.domainRank, known.backlinksCount], [6, 4, 10, 12]);
    const unknown = KINDS.referringDomains.toDoc(parseReferringDomain({ domain: 'b.com', referring_pages: 10 }), ctx);
    assert.deepEqual([unknown.followCount, unknown.nofollowCount], [null, null]);
    assert.ok('quality' in unknown.qualityMetrics);
  });

  test('provider dates', () => {
    assert.equal(parseProviderDate('2020-11-26 10:11:12 +00:00').toISOString(), '2020-11-26T10:11:12.000Z');
    assert.equal(parseProviderDate(null), null);
    assert.equal(parseProviderDate('not a date'), null);
  });
});

describe('history reference scan', () => {
  const at = (days) => ({ scanId: `s${days}`, capturedAt: new Date(Date.UTC(2026, 10, 30) - days * 86_400_000) });
  test('previous / week / month pick the right earlier scan, or none', () => {
    const states = [at(0), at(2), at(8), at(40)];
    assert.equal(pickReference(states, 'previous').reference.scanId, 's2');
    assert.equal(pickReference(states, 'week').reference.scanId, 's8');
    assert.equal(pickReference(states, 'month').reference.scanId, 's40');
    assert.equal(pickReference([at(0), at(2)], 'week').reference, null);
    assert.deepEqual(pickReference([], 'previous'), { latest: null, reference: null });
    assert.equal(pickReference([at(0)], 'previous').reference, null);
  });
});
