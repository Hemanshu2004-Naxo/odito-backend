import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCompetitorsQuery, parseLimit, parseOffset, parseOrderBy, parseExcludeTopDomains, parseMaxRankGroup, hasCompetitorsParams, withExcludedList,
} from '../validator/competitorsQuery.js';
import { normalizeDomainInput } from '../../shared/targetDomain.js';
import { hashList } from '../validator/filterConditions.js';

describe('normalizeDomainInput: one clean form for every domain the user types', () => {
  test('lowercase, no protocol, no www, no path / query / hash / port / trailing slash or dot', () => {
    for (const [input, clean] of [
      ['https://www.Example.com/path/', 'example.com'],
      ['  HTTP://WWW.EXAMPLE.COM  ', 'example.com'],
      ['example.com/', 'example.com'],
      ['www.example.com', 'example.com'],
      ['example.com.', 'example.com'],
      ['https://blog.example.co.uk:8443/a/b?x=1#top', 'blog.example.co.uk'],
      ['Example.COM?utm=1', 'example.com'],
      ['bücher.de', 'xn--bcher-kva.de'],
    ]) assert.equal(normalizeDomainInput(input), clean, input);
  });

  test('anything that is not a public domain name is rejected (null)', () => {
    for (const bad of [
      '', '   ', 'localhost', 'foo.localhost', 'printer.local', 'db.internal', '127.0.0.1', '10.0.0.5', 'http://[::1]/', 'single', 'a..com', '-a.com', 'a-.com',
      'a b.com', 'ftp://example.com', 'javascript:alert(1)', 'user:pw@example.com', 'https://user@example.com', 'example.123', `${'a'.repeat(64)}.com`,
      null, undefined, 42, ['example.com'], {},
    ]) assert.equal(normalizeDomainInput(bad), null, String(bad));
  });
});

describe('competitors query: defaults and canonical form', () => {
  test('no parameters = the default view the dashboard card and the page share', () => {
    const q = parseCompetitorsQuery({});
    assert.deepEqual([q.limit, q.offset, q.orderBy, q.filters, q.excludeTopDomains, q.maxRankGroup, q.isDefault], [50, 0, 'intersections,desc', [], true, 100, true]);
    assert.equal(parseCompetitorsQuery({ limit: '50', offset: '0', order_by: 'intersections,desc', exclude_top_domains: '1', max_rank_group: '100' }).variant, q.variant);
    assert.equal(parseCompetitorsQuery({ exclude_top_domains: 'true' }).variant, q.variant);
  });

  test('every input that changes the provider\'s answer changes the cache variant', () => {
    const base = parseCompetitorsQuery({}).variant;
    const variants = [
      { limit: '25' }, { offset: '50' }, { order_by: 'avg_position,asc' }, { order_by: 'intersections,asc' }, { exclude_top_domains: '0' }, { max_rank_group: '10' },
      { filters: JSON.stringify(['intersections', '>=', 5]) },
    ].map((p) => parseCompetitorsQuery(p).variant);
    assert.equal(new Set([base, ...variants]).size, variants.length + 1);
    for (const v of variants) assert.ok(v.length < 120, v);
  });

  test('the same filters in any order are one question', () => {
    const a = JSON.stringify([['intersections', '>=', 5], 'and', ['avg_position', '<=', 30]]);
    const b = JSON.stringify([['avg_position', '<=', 30], 'and', ['intersections', '>=', 5]]);
    assert.equal(parseCompetitorsQuery({ filters: a }).variant, parseCompetitorsQuery({ filters: b }).variant);
  });

  test('the project exclude list is part of the key, in any order or case, and an empty list is its own state', () => {
    const v = parseCompetitorsQuery({}).variant;
    assert.equal(withExcludedList(v, ['b.com', 'A.com']), withExcludedList(v, ['a.com', 'b.com', 'b.com']));
    assert.notEqual(withExcludedList(v, ['a.com']), withExcludedList(v, ['a.com', 'b.com']));
    assert.notEqual(withExcludedList(v, []), withExcludedList(v, ['a.com']));
    assert.equal(hashList([]), 'none');
    assert.ok(withExcludedList(v, Array.from({ length: 1000 }, (_, i) => `d${i}.com`)).length < 200, 'fits the cache variant column');
  });
});

describe('competitors query: everything is validated before a billed call', () => {
  const bad = (fn, field) => assert.throws(fn, (e) => e.code === 'VALIDATION_ERROR' && e.field === field);

  test('limit / offset', () => {
    for (const ok of ['25', '50', '100']) assert.equal(parseLimit(ok), Number(ok));
    for (const no of ['5', '10', '1000', '0', '-1', '50.5', 'abc', '', ['50'], 50]) if (no !== '') bad(() => parseLimit(no), 'limit');
    assert.equal(parseOffset(undefined), 0);
    assert.equal(parseOffset('9999'), 9999);
    for (const no of ['10000', '-1', '1.5', 'x']) bad(() => parseOffset(no), 'offset');
  });

  test('order_by: only the three fields the provider sorts by (live-checked)', () => {
    for (const ok of ['intersections,desc', 'intersections,asc', 'avg_position,asc', 'competitor_metrics.organic.etv,desc']) assert.equal(parseOrderBy(ok), ok);
    for (const no of ['relevance,desc', 'full_domain_metrics.organic.etv,desc', 'full_domain_metrics.organic.count,desc', 'metrics.organic.etv,desc', 'intersections', 'intersections,up', 'intersections,desc,asc', 'password,asc']) {
      bad(() => parseOrderBy(no), 'order_by');
    }
  });

  test('toggles', () => {
    assert.equal(parseExcludeTopDomains(undefined), true);
    for (const [raw, v] of [['1', true], ['true', true], ['0', false], ['false', false]]) assert.equal(parseExcludeTopDomains(raw), v);
    bad(() => parseExcludeTopDomains('yes'), 'exclude_top_domains');
    assert.equal(parseMaxRankGroup(undefined), 100);
    assert.equal(parseMaxRankGroup('10'), 10);
    for (const no of ['1', '20', '50', '101', 'ten']) bad(() => parseMaxRankGroup(no), 'max_rank_group');
  });

  test('filters: only intersections and avg_position, ranges enforced, at most 8 conditions', () => {
    const f = (c) => JSON.stringify(c);
    assert.deepEqual(parseCompetitorsQuery({ filters: f(['intersections', '>=', 10]) }).filters, [['intersections', '>=', 10]]);
    for (const no of [
      ['full_domain_metrics.organic.count', '>=', 1], ['full_domain_metrics.organic.etv', '>=', 1], ['domain', 'like', '%a%'], ['intersections', '=', 5],
      ['intersections', '>=', -1], ['intersections', '>=', 1.5], ['intersections', '>=', '5'], ['avg_position', '<=', 0], ['avg_position', '<=', 101], ['intersections', '>='],
    ]) bad(() => parseCompetitorsQuery({ filters: f(no) }), 'filters');
    const nine = Array.from({ length: 9 }, (_, i) => ['intersections', '>=', i]).flatMap((c, i) => (i ? ['and', c] : [c]));
    assert.throws(() => parseCompetitorsQuery({ filters: f(nine) }), /at most 8/);
    bad(() => parseCompetitorsQuery({ filters: '[' }), 'filters');
    bad(() => parseCompetitorsQuery({ filters: f([['intersections', '>=', 1], 'or', ['intersections', '<=', 9]]) }), 'filters');
  });

  test('hasCompetitorsParams notices any parameter, even an invalid one', () => {
    assert.equal(hasCompetitorsParams({}), false);
    for (const k of ['limit', 'offset', 'order_by', 'filters', 'exclude_top_domains', 'max_rank_group']) assert.equal(hasCompetitorsParams({ [k]: 'x' }), true, k);
    assert.equal(hasCompetitorsParams({ refresh: '1' }), false);
  });
});
