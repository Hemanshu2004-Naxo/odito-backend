import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAnchorsQuery, parseOrderBy, parseStatus, parseLimit, buildVariant } from '../validator/anchorsQuery.js';
import { parseAnchorSettingsBody, normalizeTerm } from '../validator/anchorSettingsInput.js';
import { parseBacklinksListQuery } from '../validator/backlinksListQuery.js';
import { buildRequest, parseAnchor, parseAnchors, parseAnchorProfile, parseSectionResponse } from '../provider/domainOverviewProvider.js';
import { ANCHORS_QUERY, ANCHOR_PROFILE, ANCHOR_SETTINGS, SECTIONS } from '../config.js';
import { RAW_ANCHORS, RAW_PROFILE_HEAD } from './realAnchors.js';

const f = (...c) => JSON.stringify(c.length === 1 ? c[0] : c.flatMap((x, i) => (i ? ['and', x] : [x])));
const rejects = (fn, field) => assert.throws(fn, (e) => e.name === 'ValidationFailure' && (!field || e.field === field));

describe('anchors query: whitelists and canonical form', () => {
  test('no parameters = the default view: live, 50, offset 0, referring_domains desc, no filters', () => {
    const q = parseAnchorsQuery({});
    assert.deepEqual([q.status, q.limit, q.offset, q.orderBy, q.filters, q.isDefault], ['live', 50, 0, 'referring_domains,desc', [], true]);
  });

  test('status: live / lost / all only', () => {
    for (const s of ['live', 'lost', 'all']) assert.equal(parseStatus(s), s);
    rejects(() => parseStatus('new'), 'status');
    rejects(() => parseStatus(['live', 'lost']), 'status');
  });

  test('page size: 25 / 50 / 100 only', () => {
    for (const n of ['25', '50', '100']) assert.equal(parseLimit(n), Number(n));
    for (const n of ['1000', '10', '0', '-5', 'abc', '5.5']) rejects(() => parseLimit(n), 'limit');
  });

  test('order_by: one rule, a whitelisted field, asc or desc', () => {
    for (const field of ANCHORS_QUERY.orderFields) assert.equal(parseOrderBy(`${field},asc`), `${field},asc`);
    for (const bad of ['referring_pages,desc', 'backlinks', 'backlinks,up', 'backlinks,desc,extra', ',desc', ['backlinks,desc', 'rank,asc']]) rejects(() => parseOrderBy(bad), 'order_by');
  });

  test('offset + limit may not pass the provider window of 20,000', () => {
    assert.equal(parseAnchorsQuery({ limit: '100', offset: '19900' }).offset, 19900);
    rejects(() => parseAnchorsQuery({ limit: '100', offset: '19901' }), 'offset');
    rejects(() => parseAnchorsQuery({ offset: '20001' }), 'offset');
  });

  test('an exact anchor ("=") and the empty anchor ("") are accepted (a click on a bar of the chart), contains / not-contains stay patterns', () => {
    assert.deepEqual(parseAnchorsQuery({ filters: f(['anchor', '=', 'ASG Eye Hospital']) }).filters, [['anchor', '=', 'ASG Eye Hospital']]);
    assert.deepEqual(parseAnchorsQuery({ filters: f(['anchor', '=', '']) }).filters, [['anchor', '=', '']]);
    rejects(() => parseAnchorsQuery({ filters: f(['anchor', 'not_like', 'plain']) }), 'filters');
    rejects(() => parseAnchorsQuery({ filters: f(['anchor', '=', 5]) }), 'filters');
  });

  test('every filter of the page is accepted: contains / not contains / min referring domains / min backlinks / max spam / has broken / first seen', () => {
    const filters = f(['anchor', 'like', '%lasik%'], ['anchor', 'not_like', '%asg%'], ['referring_domains', '>=', 5], ['backlinks', '>=', 10], ['backlinks_spam_score', '<=', 30], ['broken_backlinks', '>', 0], ['first_seen', '>=', '2025-04-01']);
    const q = parseAnchorsQuery({ filters });
    assert.equal(q.filters.length, 7);
    assert.ok(q.filters.some((c) => c[0] === 'broken_backlinks' && c[1] === '>' && c[2] === 0));
  });

  test('filters outside the whitelist are refused: unknown fields, wrong operators, bad values, the individual-backlinks spam field', () => {
    for (const bad of [
      f(['referring_pages', '>=', 1]), f(['anchor', '<>', 'x']), f(['anchor', 'like', 'no-percent']), f(['anchor', 'like', '%a%b%']),
      f(['referring_domains', '<=', 5]), f(['referring_domains', '>=', -1]), f(['referring_domains', '>=', 1.5]), f(['referring_domains', '>=', '5']),
      f(['backlinks_spam_score', '<=', 101]), f(['backlink_spam_score', '<=', 30]), f(['broken_backlinks', '>', 1]), f(['broken_backlinks', '>=', 0]),
      f(['first_seen', '>=', '2025-13-40']), f(['first_seen', '>=', 'yesterday']), 'not json', '{}', '[]',
    ]) rejects(() => parseAnchorsQuery({ filters: bad }), 'filters');
  });

  test('at most 8 conditions; the 9th is refused with a message that says so', () => {
    const eight = Array.from({ length: 8 }, (_, i) => ['referring_domains', '>=', i + 1]);
    assert.equal(parseAnchorsQuery({ filters: f(...eight) }).filters.length, 8);
    assert.throws(() => parseAnchorsQuery({ filters: f(...eight, ['backlinks', '>=', 1]) }), /at most 8 filter conditions/);
  });

  test('the same question gives the same key (order and duplicates do not matter); a different one does not', () => {
    const a = parseAnchorsQuery({ filters: f(['backlinks', '>=', 2], ['referring_domains', '>=', 1]) });
    const b = parseAnchorsQuery({ filters: f(['referring_domains', '>=', 1], ['backlinks', '>=', 2]) });
    assert.equal(a.variant, b.variant);
    assert.notEqual(a.variant, parseAnchorsQuery({}).variant);
    assert.notEqual(parseAnchorsQuery({ status: 'lost' }).variant, parseAnchorsQuery({}).variant);
    assert.notEqual(parseAnchorsQuery({ offset: '50' }).variant, parseAnchorsQuery({}).variant);
    assert.notEqual(parseAnchorsQuery({ order_by: 'backlinks,desc' }).variant, parseAnchorsQuery({}).variant);
    assert.ok(parseAnchorsQuery({ filters: f(...Array.from({ length: 8 }, (_, i) => ['anchor', 'like', `%${'x'.repeat(90)}${i}%`])) }).variant.length <= 200);
  });

  test('internal_list_limit is part of the cache key: another value cannot be answered from this entry', () => {
    const args = { status: 'live', limit: 50, offset: 0, orderBy: 'referring_domains,desc', filters: [] };
    assert.match(buildVariant(args), new RegExp(`\\|i${ANCHORS_QUERY.internalListLimit}\\|`));
  });
});

describe('anchors: the request the provider receives', () => {
  const target = 'asgeyehospital.com';
  test('the default view', () => {
    assert.deepEqual(buildRequest('anchors', { target, market: {} }), {
      target, include_subdomains: true, backlinks_status_type: 'live', internal_list_limit: 10, limit: 50, order_by: ['referring_domains,desc'],
    });
  });

  test('status, page, sort and filters reach it as validated; one condition is flat, several are joined with "and"', () => {
    const one = buildRequest('anchors', { target, market: {}, query: parseAnchorsQuery({ status: 'all', limit: '25', offset: '50', order_by: 'backlinks,asc', filters: f(['broken_backlinks', '>', 0]) }) });
    assert.deepEqual([one.backlinks_status_type, one.limit, one.offset, one.order_by, one.filters], ['all', 25, 50, ['backlinks,asc'], ['broken_backlinks', '>', 0]]);
    const many = buildRequest('anchors', { target, market: {}, query: parseAnchorsQuery({ filters: f(['anchor', 'like', '%a%'], ['backlinks', '>=', 3]) }) });
    assert.deepEqual(many.filters, [['anchor', 'like', '%a%'], 'and', ['backlinks', '>=', 3]]);
    assert.equal('offset' in buildRequest('anchors', { target, market: {} }), false, 'no offset for page 1');
  });

  test('the profile is ONE fixed request: top 1,000 live anchors by referring domains, no filters, one breakdown entry', () => {
    assert.deepEqual(buildRequest('anchor-profile', { target, market: {}, query: { filters: [['anchor', 'like', '%x%']], limit: 5 } }), {
      target, include_subdomains: true, backlinks_status_type: 'live', internal_list_limit: 1, limit: 1000, order_by: ['referring_domains,desc'],
    });
    assert.deepEqual([ANCHOR_PROFILE.limit, ANCHOR_PROFILE.status], [1000, 'live']);
  });

  test('cache lifetimes: 24 hours for the table, 7 days for the profile, each under its own endpoint name', () => {
    assert.equal(SECTIONS.anchors.ttlMs, 24 * 3600 * 1000);
    assert.equal(SECTIONS['anchor-profile'].ttlMs, 7 * 24 * 3600 * 1000);
    assert.notEqual(SECTIONS.anchors.endpoint, SECTIONS['anchor-profile'].endpoint);
  });
});

describe('anchors: parsing REAL provider rows (asgeyehospital.com)', () => {
  const parsed = parseAnchors(RAW_ANCHORS);

  test('keeps the total and every row, with the counts as numbers', () => {
    assert.equal(parsed.totalCount, 1004);
    assert.equal(parsed.items.length, 10);
    const top = parsed.items[0];
    assert.deepEqual([top.referring_domains, top.backlinks, top.backlinks_spam_score, top.broken_backlinks], [2707, 2869, 54, 0]);
    assert.equal(top.first_seen, '2026-09-11 08:19:48 +00:00');
  });

  test('an image / textless link arrives with anchor null (not "" and not "null")', () => {
    const empty = parsed.items.find((x) => x.referring_domains === 140);
    assert.equal(empty.anchor, null);
    assert.equal(empty.backlinks, 932);
  });

  test('the breakdowns are { key: count } objects; "" (Unknown) is kept; an absent breakdown is null, not {}', () => {
    const top = parsed.items[0];
    assert.deepEqual(top.referring_links_countries, { '': 2869 });
    assert.deepEqual(top.referring_links_types, { anchor: 2869 });
    assert.equal(top.referring_links_attributes, null);
    assert.equal(top.referring_links_tld.shop, 490);
  });

  test('anchor text is not trimmed (an exact-match filter must find it again) and a blank one is null', () => {
    assert.equal(parseAnchor({ anchor: '  Lasik  ', backlinks: 1 }).anchor, '  Lasik  ');
    assert.equal(parseAnchor({ anchor: '   ', backlinks: 1 }).anchor, null);
    assert.equal(parseAnchor({ anchor: '', backlinks: 1 }).anchor, null);
    assert.equal(parseAnchor({ backlinks: 1 }).anchor, null);
  });

  test('missing or non-numeric counts are null, never 0', () => {
    const r = parseAnchor({ anchor: 'a', backlinks: '12', referring_domains: undefined, backlinks_spam_score: NaN, rank: 0 });
    assert.deepEqual([r.backlinks, r.referring_domains, r.backlinks_spam_score, r.rank], [null, null, null, 0]);
  });

  test('a filter that matches nothing (total_count null, items null) is 0 anchors, not "unknown"', () => {
    assert.deepEqual(parseAnchors({ total_count: null, items_count: 0, items: null }), { totalCount: 0, items: [] });
    assert.deepEqual(parseAnchors({ total_count: 0, items: [] }), { totalCount: 0, items: [] });
    assert.equal(parseAnchors(null).totalCount, null);
  });

  test('the profile keeps only what the distribution needs: no breakdowns, no referring pages', () => {
    const p = parseAnchorProfile(RAW_PROFILE_HEAD);
    assert.equal(p.items.length, 25);
    assert.deepEqual(Object.keys(p.items[0]).sort(), ['anchor', 'backlinks', 'backlinks_spam_score', 'broken_backlinks', 'first_seen', 'rank', 'referring_domains', 'referring_domains_nofollow']);
    assert.ok(JSON.stringify(p).length < JSON.stringify(parsed).length * 3);
  });

  test('status_code 20000 is checked at the top level AND on the task; anything else is an error', () => {
    const ok = { status_code: 20000, tasks: [{ status_code: 20000, cost: 0.024, result: [RAW_ANCHORS] }] };
    assert.equal(parseSectionResponse('anchors', ok, { target: 'x.com' }).payload.totalCount, 1004);
    assert.throws(() => parseSectionResponse('anchors', { ...ok, status_code: 40000 }, { target: 'x.com' }));
    assert.throws(() => parseSectionResponse('anchors', { ...ok, tasks: [{ ...ok.tasks[0], status_code: 40501 }] }, { target: 'x.com' }));
    assert.throws(() => parseSectionResponse('anchors', { ...ok, tasks: [{ ...ok.tasks[0], result: 'nope' }] }, { target: 'x.com' }));
  });
});

describe('the Backlinks list: exact anchor ("View these backlinks")', () => {
  test('accepts anchor = text and anchor = "" (links with no anchor text), still the contains pattern for like', () => {
    assert.deepEqual(parseBacklinksListQuery({ filters: f(['anchor', '=', 'Retina Eye Surgery']) }).filters, [['anchor', '=', 'Retina Eye Surgery']]);
    assert.deepEqual(parseBacklinksListQuery({ filters: f(['anchor', '=', '']) }).filters, [['anchor', '=', '']]);
    assert.deepEqual(parseBacklinksListQuery({ filters: f(['anchor', 'like', '%eye%']) }).filters, [['anchor', 'like', '%eye%']]);
  });

  test('refuses what is not text, too long text, control characters and other operators; "like" still needs %…%', () => {
    for (const bad of [f(['anchor', '=', 5]), f(['anchor', '=', null]), f(['anchor', '=', 'x'.repeat(1001)]), f(['anchor', '=', 'a\nb']), f(['anchor', '<>', 'x']), f(['anchor', 'like', 'plain'])]) {
      rejects(() => parseBacklinksListQuery({ filters: bad }), 'filters');
    }
    assert.equal(parseBacklinksListQuery({ filters: f(['anchor', '=', 'x'.repeat(1000)]) }).filters.length, 1);
  });

  test('the request carries it to the provider unchanged', () => {
    const req = buildRequest('backlinks-list', { target: 'a.com', market: {}, query: parseBacklinksListQuery({ filters: f(['anchor', '=', '']) }) });
    assert.deepEqual(req.filters, ['anchor', '=', '']);
  });
});

describe('anchor settings input', () => {
  test('terms are lowercased, trimmed, space-collapsed and de-duplicated; blanks are dropped', () => {
    assert.equal(normalizeTerm('  ASG   Eye  Hospital '), 'asg eye hospital');
    const r = parseAnchorSettingsBody({ brand_terms: ['ASG', ' asg ', 'ASG  Eye Hospital', '', '   '], target_keywords: ['Lasik Surgery', 'lasik   surgery'] });
    assert.deepEqual(r, { brandTerms: ['asg', 'asg eye hospital'], targetKeywords: ['lasik surgery'] });
  });

  test('both lists must be given (a save replaces both); an empty list is a valid choice', () => {
    assert.deepEqual(parseAnchorSettingsBody({ brand_terms: [], target_keywords: [] }), { brandTerms: [], targetKeywords: [] });
    for (const bad of [undefined, {}, { brand_terms: [] }, { target_keywords: [] }, { brand_terms: 'asg', target_keywords: [] }, { brand_terms: [], target_keywords: null }]) rejects(() => parseAnchorSettingsBody(bad));
  });

  test('entries must be short text without control characters; the lists have caps', () => {
    const ok = { target_keywords: [] };
    rejects(() => parseAnchorSettingsBody({ ...ok, brand_terms: [5] }), 'brand_terms');
    rejects(() => parseAnchorSettingsBody({ ...ok, brand_terms: [{ a: 1 }] }), 'brand_terms');
    rejects(() => parseAnchorSettingsBody({ ...ok, brand_terms: ['a\u0000b'] }), 'brand_terms');
    rejects(() => parseAnchorSettingsBody({ ...ok, brand_terms: ['x'.repeat(ANCHOR_SETTINGS.maxTermLength + 1)] }), 'brand_terms');
    assert.equal(parseAnchorSettingsBody({ ...ok, brand_terms: ['x'.repeat(ANCHOR_SETTINGS.maxTermLength)] }).brandTerms.length, 1);
    rejects(() => parseAnchorSettingsBody({ ...ok, brand_terms: Array.from({ length: ANCHOR_SETTINGS.maxBrandTerms + 1 }, (_, i) => `t${i}`) }), 'brand_terms');
    rejects(() => parseAnchorSettingsBody({ brand_terms: [], target_keywords: Array.from({ length: ANCHOR_SETTINGS.maxTargetKeywords + 1 }, (_, i) => `k${i}`) }), 'target_keywords');
    assert.equal(parseAnchorSettingsBody({ brand_terms: [], target_keywords: Array.from({ length: ANCHOR_SETTINGS.maxTargetKeywords }, (_, i) => `k${i}`) }).targetKeywords.length, 100);
  });

  test('the cap counts distinct terms (duplicates do not use it up)', () => {
    const dupes = Array.from({ length: 50 }, () => 'same');
    assert.deepEqual(parseAnchorSettingsBody({ brand_terms: dupes, target_keywords: [] }).brandTerms, ['same']);
  });
});
