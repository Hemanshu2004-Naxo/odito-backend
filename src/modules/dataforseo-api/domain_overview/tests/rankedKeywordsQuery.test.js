import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLimit, parseOffset, parseOrderBy, parseFilters, toProviderFilters, buildVariant, parseRankedKeywordsQuery, hasRankedKeywordsParams,
} from '../validator/rankedKeywordsQuery.js';
import { ValidationFailure } from '../../shared/targetDomain.js';
import { RANKED_KEYWORDS_QUERY as Q } from '../config.js';

const ROW = 'ranked_serp_element.serp_item';
const KW = 'keyword_data.keyword';
const VOL = 'keyword_data.keyword_info.search_volume';
const rejects = (fn, field) => assert.throws(fn, (e) => e instanceof ValidationFailure && (!field || e.field === field));
const f = (v) => JSON.stringify(v);

describe('limit / offset / order_by', () => {
  test('absent values are the dashboard defaults', () => {
    assert.equal(parseLimit(undefined), 5);
    assert.equal(parseOffset(undefined), 0);
    assert.equal(parseOrderBy(undefined), `${ROW}.etv,desc`);
  });

  test('limit is limited to the sizes the product uses: 5, 25, 50, 100 and the 1,000 export', () => {
    for (const n of [5, 25, 50, 100, 1000]) assert.equal(parseLimit(String(n)), n);
    for (const bad of ['0', '7', '1001', '-1', '50.5', '5e1', 'abc', '99999', ['25', '50']]) rejects(() => parseLimit(bad), 'limit');
  });

  test('offset is a whole number from 0 to the provider cap', () => {
    assert.equal(parseOffset('0'), 0);
    assert.equal(parseOffset('9999'), 9999);
    for (const bad of ['-1', '10000', '1.5', 'x', ['0', '1']]) rejects(() => parseOffset(bad), 'offset');
  });

  test('order_by accepts only a whitelisted field and direction', () => {
    for (const field of Q.orderFields) for (const dir of ['asc', 'desc']) assert.equal(parseOrderBy(`${field},${dir}`), `${field},${dir}`);
    for (const bad of [`${ROW}.etv`, `${ROW}.etv,up`, 'keyword_data.keyword_info.monthly_searches,asc', `${ROW}.etv,desc,extra`, 'constructor,asc', ['a,asc', 'b,asc']]) {
      rejects(() => parseOrderBy(bad), 'order_by');
    }
  });
});

describe('filters', () => {
  test('absent / empty-string filters mean no filter', () => {
    assert.deepEqual(parseFilters(undefined), []);
    assert.deepEqual(parseFilters(''), []);
  });

  test('a single flat condition and the "and"-joined form both parse; the result is canonical', () => {
    assert.deepEqual(parseFilters(f([KW, 'like', '%eye%'])), [[KW, 'like', '%eye%']]);
    assert.deepEqual(parseFilters(f([[KW, 'like', '%eye%']])), [[KW, 'like', '%eye%']]);
    const a = parseFilters(f([[VOL, '>=', 100], 'and', [KW, 'like', '%eye%'], 'and', [VOL, '<=', 900]]));
    const b = parseFilters(f([[KW, 'like', '%eye%'], 'and', [VOL, '<=', 900], 'and', [VOL, '>=', 100]]));
    assert.deepEqual(a, b, 'the order the browser listed its conditions in does not matter');
    assert.equal(buildVariant({ limit: 25, offset: 0, orderBy: 'x,asc', filters: a }), buildVariant({ limit: 25, offset: 0, orderBy: 'x,asc', filters: b }));
  });

  test('duplicates collapse; intent lists are sorted and de-duplicated', () => {
    assert.equal(parseFilters(f([[KW, 'like', '%eye%'], 'and', [KW, 'like', '%eye%']])).length, 1);
    assert.deepEqual(parseFilters(f(['keyword_data.search_intent_info.main_intent', 'in', ['transactional', 'commercial', 'commercial']])),
      [['keyword_data.search_intent_info.main_intent', 'in', ['commercial', 'transactional']]]);
  });

  test('keyword patterns are lowercased (the provider\'s like is case-sensitive and keywords are lowercase); URL patterns are left as typed', () => {
    assert.deepEqual(parseFilters(f([KW, 'like', '%LASIK Cost%'])), [[KW, 'like', '%lasik cost%']]);
    assert.deepEqual(parseFilters(f([KW, 'not_like', '%Near ME%'])), [[KW, 'not_like', '%near me%']]);
    assert.deepEqual(parseFilters(f([`${ROW}.relative_url`, 'like', '%/Blog/%'])), [[`${ROW}.relative_url`, 'like', '%/Blog/%']]);
    assert.equal(
      parseRankedKeywordsQuery({ filters: f([KW, 'like', '%Eye%']) }).variant,
      parseRankedKeywordsQuery({ filters: f([KW, 'like', '%eye%']) }).variant,
      'Eye and eye are one cache entry',
    );
  });

  test('every supported filter the page builds is accepted', () => {
    const ok = [
      [`${ROW}.rank_group`, '<=', 3], [`${ROW}.rank_group`, '>=', 11], [VOL, '>=', 0], ['keyword_data.keyword_properties.keyword_difficulty', '<=', 100],
      [`${ROW}.rank_changes.is_new`, '=', true], [`${ROW}.rank_changes.is_up`, '=', true], [`${ROW}.rank_changes.is_down`, '=', true],
      [`${ROW}.relative_url`, 'like', '%/blog/%'], [KW, 'not_like', '%cost%'],
    ];
    for (const c of ok) assert.deepEqual(parseFilters(f(c)), [c], f(c));
  });

  test('the 8-condition limit: 8 pass, 9 fail with a message that says how many', () => {
    const cond = (n) => [VOL, '>=', n];
    const eight = Array.from({ length: 8 }, (_, i) => cond(i + 1)).flatMap((c, i) => (i ? ['and', c] : [c]));
    assert.equal(parseFilters(f(eight)).length, 8);
    const nine = [...eight, 'and', cond(9)];
    assert.throws(() => parseFilters(f(nine)), (e) => e instanceof ValidationFailure && e.field === 'filters' && /at most 8/.test(e.message) && /got 9/.test(e.message));
  });

  test('anything outside the whitelist is rejected before it can reach the provider', () => {
    const bad = [
      '{not json', 'null', '[]', '{}', '"x"', f(['keyword_data.keyword']), f([KW, 'like']), f([KW, 'regex', '%a%']), f(['secret.field', '=', 1]),
      f(['__proto__', '=', 1]), f(['constructor', '=', 1]),
      f([VOL, 'like', '%1%']), f([KW, 'like', 'eye']), f([KW, 'like', '%e%y%']), f([KW, 'like', '%%']), f([KW, 'like', '% eye %']), f([KW, 'like', '%a\nb%']),
      f([KW, 'like', `%${'x'.repeat(101)}%`]), f([KW, 'like', 5]),
      f([VOL, '>=', '100']), f([VOL, '>=', -1]), f([VOL, '>=', 1.5]), f([VOL, '>=', null]), f([`${ROW}.rank_group`, '<=', 101]), f([`${ROW}.rank_group`, '>=', 0]),
      f(['keyword_data.keyword_properties.keyword_difficulty', '<=', 101]),
      f([`${ROW}.rank_changes.is_new`, '=', false]), f([`${ROW}.rank_changes.is_up`, '=', 'true']),
      f(['keyword_data.search_intent_info.main_intent', 'in', []]), f(['keyword_data.search_intent_info.main_intent', 'in', ['spammy']]),
      f(['keyword_data.search_intent_info.main_intent', 'in', 'commercial']),
      f([[KW, 'like', '%a%'], 'or', [KW, 'like', '%b%']]), f([[KW, 'like', '%a%'], 'and']), f([[KW, 'like', '%a%'], [KW, 'like', '%b%']]),
      f([[[KW, 'like', '%a%']]]), f('x'.repeat(5000)),
    ];
    for (const raw of bad) rejects(() => parseFilters(raw), 'filters');
    rejects(() => parseFilters([f([KW, 'like', '%a%']), f([KW, 'like', '%b%'])]), 'filters'); // ?filters=..&filters=..
  });

  test('toProviderFilters: none -> null, one -> the flat triple, several -> joined with "and"', () => {
    assert.equal(toProviderFilters([]), null);
    assert.deepEqual(toProviderFilters([[KW, 'like', '%a%']]), [KW, 'like', '%a%']);
    assert.deepEqual(toProviderFilters([['a', '=', 1], ['b', '=', 2], ['c', '=', 3]]), [['a', '=', 1], 'and', ['b', '=', 2], 'and', ['c', '=', 3]]);
  });
});

describe('parseRankedKeywordsQuery', () => {
  test('no parameters is the dashboard call; it shares its cache variant with the same query written out in full', () => {
    const d = parseRankedKeywordsQuery({});
    assert.equal(d.isDefault, true);
    const explicit = parseRankedKeywordsQuery({ limit: '5', offset: '0', order_by: `${ROW}.etv,desc` });
    assert.equal(explicit.isDefault, true);
    assert.equal(explicit.variant, d.variant);
  });

  test('every input that changes the provider answer changes the cache variant; inputs that do not, do not', () => {
    const base = { limit: '50', offset: '0', order_by: `${ROW}.etv,desc`, filters: f([KW, 'like', '%eye%']) };
    const variants = new Set([
      parseRankedKeywordsQuery(base).variant,
      parseRankedKeywordsQuery({ ...base, limit: '100' }).variant,
      parseRankedKeywordsQuery({ ...base, offset: '50' }).variant,
      parseRankedKeywordsQuery({ ...base, order_by: `${ROW}.etv,asc` }).variant,
      parseRankedKeywordsQuery({ ...base, filters: f([KW, 'like', '%lasik%']) }).variant,
      parseRankedKeywordsQuery({ ...base, filters: undefined }).variant,
    ]);
    assert.equal(variants.size, 6);
    assert.equal(parseRankedKeywordsQuery(base).isDefault, false);
    for (const v of variants) assert.ok(v.length <= 200, 'fits the cache model variant column');
  });

  test('hasRankedKeywordsParams notices any paging / sorting / filtering parameter, even an invalid one', () => {
    assert.equal(hasRankedKeywordsParams({}), false);
    assert.equal(hasRankedKeywordsParams({ refresh: '1', months: '12' }), false);
    for (const k of ['limit', 'offset', 'order_by', 'filters']) assert.equal(hasRankedKeywordsParams({ [k]: 'x' }), true, k);
  });
});

describe('"or" groups of keyword like-conditions (the Domain Overview\'s Brand keywords)', () => {
  const like = (t) => [KW, 'like', `%${t}%`];
  const group = (...terms) => terms.flatMap((t, i) => (i === 0 ? [like(t)] : ['or', like(t)]));
  const parse = (filters) => parseFilters(JSON.stringify(filters));

  test('a group is canonicalised: members lower-cased, sorted and de-duplicated, so any spelling or order is ONE cache key', () => {
    const a = parse([group('Eye', 'asg', 'ASG')]);
    const b = parse([group('asg', 'eye')]);
    assert.deepEqual(a, [{ or: [like('asg'), like('eye')] }]);
    assert.deepEqual(a, b);
    assert.equal(buildVariant({ limit: 5, offset: 0, orderBy: Q.defaultOrderBy, filters: a }), buildVariant({ limit: 5, offset: 0, orderBy: Q.defaultOrderBy, filters: b }));
  });

  test('a group of two identical terms collapses to the plain condition', () => {
    assert.deepEqual(parse([group('asg', 'ASG')]), [like('asg')]);
  });

  test('a group beside other conditions: all canonical, order-insensitive', () => {
    const rank = [`${ROW}.rank_group`, '<=', 10];
    assert.deepEqual(parse([group('asg', 'eye'), 'and', rank]), parse([rank, 'and', group('eye', 'asg')]));
  });

  test('the provider form: a lone group is [c1, "or", c2]; beside others it is "and"-joined; Non-brand is plain "and"', () => {
    assert.deepEqual(toProviderFilters(parse([group('asg', 'eye')])), [like('asg'), 'or', like('eye')]);
    const rank = [`${ROW}.rank_group`, '<=', 10];
    const wire = toProviderFilters(parse([group('asg', 'eye'), 'and', rank]));
    assert.equal(wire.length, 3);
    assert.equal(wire[1], 'and');
    assert.ok(wire.some((c) => Array.isArray(c) && c[1] === 'or' || (Array.isArray(c) && Array.isArray(c[0]))));
    assert.deepEqual(toProviderFilters(parse([[KW, 'not_like', '%a1%'], 'and', [KW, 'not_like', '%b2%']])), [[KW, 'not_like', '%a1%'], 'and', [KW, 'not_like', '%b2%']]);
  });

  test('limits: 2 to 6 members, only keyword like, "or" only inside a group, and every member counts toward the 8 conditions', () => {
    rejects(() => parse([[like('a1')]]), 'filters'); // one member
    rejects(() => parse([group('a1', 'b2', 'c3', 'd4', 'e5', 'f6', 'g7')]), 'filters'); // seven
    rejects(() => parse([[[KW, 'not_like', '%a%'], 'or', [KW, 'not_like', '%b%']]]), 'filters');
    rejects(() => parse([[[`${ROW}.rank_group`, '<=', 3], 'or', [`${ROW}.rank_group`, '<=', 5]]]), 'filters');
    rejects(() => parse([[like('a1'), 'and', like('b2')]]), 'filters'); // wrong joiner inside a group
    rejects(() => parse([like('a1'), 'or', like('b2')]), 'filters'); // "or" outside a group
    rejects(() => parse([group('a1', 'b2', 'c3', 'd4', 'e5', 'f6'), 'and', like('g7'), 'and', like('h8'), 'and', like('i9')]), 'filters'); // 6 + 3 = 9
    assert.equal(parse([group('a1', 'b2', 'c3', 'd4', 'e5', 'f6'), 'and', like('g7'), 'and', like('h8')]).length, 3); // 6 + 2 = 8
  });
});
