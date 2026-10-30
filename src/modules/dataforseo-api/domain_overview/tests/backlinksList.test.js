import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBacklinksListQuery, parseOrderBy, parseOffset, parseToken, parseStatus, parseMode } from '../validator/backlinksListQuery.js';
import { buildRequest, parseBacklink, parseBacklinksList, parseSectionResponse } from '../provider/domainOverviewProvider.js';
import { BACKLINK_CSV_HEADER, backlinkCsvLine, csvCell } from '../csv/backlinksCsv.js';
import { envelope } from './fixtures.js';
import { REAL_LIST_BROKEN, REAL_LIST_DEFAULT, REAL_LIST_LOST, REAL_LIST_TOKEN_PAGE } from './realBacklinksList.js';

const ctx = { target: 'asgeyehospital.com', market: {} };
const body = (q) => buildRequest('backlinks-list', { ...ctx, query: parseBacklinksListQuery(q) });
const f = (c) => JSON.stringify(c);
const and = (...cs) => f(cs.flatMap((c, i) => (i ? ['and', c] : [c])));
const bad = (fn, field) => assert.throws(fn, (e) => e.code === 'VALIDATION_ERROR' && (field === undefined || e.field === field));

describe('backlinks list query: defaults and canonical form', () => {
  test('no parameters = live, as_is, 50 per page from the first, rank desc, no filters', () => {
    const q = parseBacklinksListQuery({});
    assert.deepEqual([q.status, q.mode, q.limit, q.offset, q.token, q.orderBy, q.filters, q.isDefault], ['live', 'as_is', 50, 0, null, ['rank,desc'], [], true]);
  });

  test('every input that changes the answer changes the cache variant; equal questions share one', () => {
    const variants = [
      {}, { status: 'lost' }, { mode: 'one_per_domain' }, { mode: 'one_per_anchor' }, { limit: '25' }, { offset: '50' }, { token: 'abc' },
      { order_by: 'first_seen,asc' }, { order_by: ['first_seen,asc', 'last_seen,desc'] }, { filters: f(['is_new', '=', true]) },
    ].map((p) => parseBacklinksListQuery(p).variant);
    assert.equal(new Set(variants).size, variants.length);
    for (const v of variants) assert.ok(v.length < 120, v);
    assert.equal(parseBacklinksListQuery({ status: 'live', mode: 'as_is', limit: '50', offset: '0', order_by: 'rank,desc' }).variant, variants[0]);
    const a = and(['is_new', '=', true], ['dofollow', '=', true]);
    const b = and(['dofollow', '=', true], ['is_new', '=', true]);
    assert.equal(parseBacklinksListQuery({ filters: a }).variant, parseBacklinksListQuery({ filters: b }).variant, 'filter order does not matter');
  });

  test('status / mode / limit are whitelisted', () => {
    for (const ok of ['live', 'lost']) assert.equal(parseStatus(ok), ok);
    for (const no of ['all', 'LIVE', 'deleted']) bad(() => parseStatus(no), 'status');
    for (const ok of ['as_is', 'one_per_domain', 'one_per_anchor']) assert.equal(parseMode(ok), ok);
    bad(() => parseMode('one_per_page'), 'mode');
    for (const ok of ['25', '50', '100', '1000']) assert.equal(parseBacklinksListQuery({ limit: ok }).limit, Number(ok));
    for (const no of ['10', '500', '5000', '-1', 'abc']) bad(() => parseBacklinksListQuery({ limit: no }), 'limit');
  });
});

describe('backlinks list query: sorting', () => {
  test('up to 3 rules, each a sortable field once, in the order given', () => {
    assert.deepEqual(parseOrderBy('domain_from_rank,desc'), ['domain_from_rank,desc']);
    assert.deepEqual(parseOrderBy(['domain_from_rank,desc', 'first_seen,asc', 'backlink_spam_score,asc']), ['domain_from_rank,desc', 'first_seen,asc', 'backlink_spam_score,asc']);
    for (const field of ['rank', 'domain_from_rank', 'page_from_rank', 'backlink_spam_score', 'first_seen', 'last_seen']) assert.deepEqual(parseOrderBy(`${field},asc`), [`${field},asc`]);
  });

  test('a 4th rule, a repeated field, an unknown field or direction are refused before any billed call', () => {
    bad(() => parseOrderBy(['rank,desc', 'first_seen,asc', 'last_seen,asc', 'page_from_rank,asc']), 'order_by');
    bad(() => parseOrderBy(['rank,desc', 'rank,asc']), 'order_by');
    for (const no of ['password,asc', 'rank', 'rank,sideways', 'rank,desc,asc', 'url_from,asc']) bad(() => parseOrderBy(no), 'order_by');
  });
});

describe('backlinks list query: filters (same grammar as the other sections, at most 8 conditions)', () => {
  test('every filter the page offers is accepted, in canonical form', () => {
    const all = [
      ['url_from', 'like', '%news%'], ['anchor', 'like', '%eye%'], ['url_to', 'like', '%/hospital/%'], ['dofollow', '=', false],
      ['item_type', 'in', ['image', 'anchor']], ['semantic_location', 'in', ['footer', 'article']], ['domain_from_rank', '>=', 20],
      ['backlink_spam_score', '<=', 30],
    ];
    const q = parseBacklinksListQuery({ filters: and(...all) });
    assert.equal(q.filters.length, 8);
    assert.deepEqual(q.filters.find((c) => c[0] === 'item_type'), ['item_type', 'in', ['anchor', 'image']], 'value lists are sorted');
    const more = [
      ['domain_from_country', 'in', ['US', 'IN']], ['first_seen', '>=', '2024-01-31'], ['backlink_spam_score', '<', 30], ['domain_from', '=', 'example.com'],
      ['is_new', '=', true], ['is_broken', '=', true],
    ];
    for (const c of more) assert.equal(parseBacklinksListQuery({ filters: f(c) }).filters.length, 1, JSON.stringify(c));
    assert.deepEqual(parseBacklinksListQuery({ filters: f(more[0]) }).filters[0], ['domain_from_country', 'in', ['IN', 'US']]);
  });

  test('the 9th condition is refused ("at most 8"), counting whatever the tab sent as its own', () => {
    const nine = Array.from({ length: 9 }, (_, i) => ['domain_from_rank', '>=', i + 1]);
    assert.throws(() => parseBacklinksListQuery({ filters: and(...nine) }), /at most 8/);
    const eight = [['is_broken', '=', true], ['dofollow', '=', true], ['domain_from_rank', '>=', 5], ['backlink_spam_score', '<=', 30], ['backlink_spam_score', '<', 30],
      ['url_from', 'like', '%a.com%'], ['anchor', 'like', '%x%'], ['url_to', 'like', '%/y%']];
    assert.equal(parseBacklinksListQuery({ filters: and(...eight) }).filters.length, 8);
  });

  test('anything outside the whitelist or out of range is a 400', () => {
    for (const no of [
      ['password', '=', 1], ['url_from', '=', 'x'], ['url_from', 'like', 'no-percent'], ['dofollow', '=', 'yes'], ['dofollow', '=', null],
      ['item_type', 'in', []], ['item_type', 'in', ['A B']], ['item_type', 'in', 'anchor'], ['domain_from_country', 'in', ['india']], ['domain_from_country', 'in', ['us']],
      ['domain_from_rank', '>=', -1], ['domain_from_rank', '>=', 1001], ['domain_from_rank', '<=', 5], ['backlink_spam_score', '>=', 5], ['backlink_spam_score', '<', 101],
      ['first_seen', '>=', '2024-02-31'], ['first_seen', '>=', '01/02/2024'], ['first_seen', '>=', 20240101], ['domain_from', '=', 'Not A Domain'], ['domain_from', '=', 'https://a.com/'],
      ['is_new', '=', false], ['is_broken', '=', 'true'],
    ]) bad(() => parseBacklinksListQuery({ filters: f(no) }), 'filters');
    bad(() => parseBacklinksListQuery({ filters: '[' }), 'filters');
  });
});

describe('backlinks list query: offset window and search_after_token', () => {
  test('offset works while offset + limit <= 20,000', () => {
    assert.equal(parseBacklinksListQuery({ limit: '50', offset: '19950' }).offset, 19950);
    assert.equal(parseBacklinksListQuery({ limit: '100', offset: '19900' }).offset, 19900);
    bad(() => parseBacklinksListQuery({ limit: '50', offset: '19951' }), 'offset');
    bad(() => parseBacklinksListQuery({ limit: '25', offset: '20000' }), 'offset');
    bad(() => parseOffset('20001'), 'offset');
  });

  test('beyond that the previous response\'s token continues the listing; offset and token are never sent together', () => {
    const t = parseBacklinksListQuery({ limit: '50', token: 'eyJhIjoxfQ==' });
    assert.equal(t.token, 'eyJhIjoxfQ==');
    assert.equal(t.offset, 0);
    assert.equal(t.isDefault, false);
    bad(() => parseBacklinksListQuery({ limit: '50', offset: '100', token: 'abc' }), 'token');
    assert.equal(parseToken(undefined), null);
  });

  test('a real token (up to ~1,500 characters of base64) is accepted; junk is not', () => {
    const real = 'A'.repeat(1480);
    assert.equal(parseToken(real), real);
    for (const no of ['has space', 'semi;colon', '<script>', 'a'.repeat(4001), ['a', 'b']]) bad(() => parseToken(no), 'token');
  });
});

describe('backlinks list request body', () => {
  test('default: live, as_is, 50, rank desc; no offset at 0, no filters, no token', () => {
    assert.deepEqual(body({}), { target: 'asgeyehospital.com', include_subdomains: true, backlinks_status_type: 'live', mode: 'as_is', limit: 50, order_by: ['rank,desc'] });
  });

  test('every choice reaches the provider: status, mode, limit, offset, up to 3 sort rules, filters "and"-joined', () => {
    const b = body({
      status: 'lost', mode: 'one_per_domain', limit: '25', offset: '75', order_by: ['domain_from_rank,desc', 'first_seen,asc'],
      filters: and(['dofollow', '=', true], ['domain_from_rank', '>=', 20]),
    });
    assert.deepEqual(b, {
      target: 'asgeyehospital.com', include_subdomains: true, backlinks_status_type: 'lost', mode: 'one_per_domain', limit: 25, offset: 75,
      order_by: ['domain_from_rank,desc', 'first_seen,asc'], filters: [['dofollow', '=', true], 'and', ['domain_from_rank', '>=', 20]],
    });
    assert.deepEqual(body({ filters: f(['is_new', '=', true]) }).filters, ['is_new', '=', true], 'one condition is the flat triple');
  });

  test('the tabs: New and Broken are live + their own filter; Lost is status lost with none', () => {
    assert.deepEqual(body({ filters: f(['is_new', '=', true]) }), { ...body({}), filters: ['is_new', '=', true] });
    assert.equal(body({ filters: f(['is_broken', '=', true]), order_by: 'domain_from_rank,desc' }).backlinks_status_type, 'live');
    const lost = body({ status: 'lost' });
    assert.equal(lost.backlinks_status_type, 'lost');
    assert.equal('filters' in lost, false);
  });

  test('a token REPLACES the offset (never both), with everything else identical', () => {
    const b = body({ limit: '100', token: 'abc123', order_by: 'rank,desc' });
    assert.equal(b.search_after_token, 'abc123');
    assert.equal('offset' in b, false);
    assert.equal(b.limit, 100);
  });
});

describe('backlinks list parser (real asgeyehospital.com rows)', () => {
  const page = parseBacklinksList(REAL_LIST_DEFAULT);

  test('totals and the next token', () => {
    assert.equal(page.totalCount, 13591);
    assert.equal(page.items.length, 12);
    assert.ok(page.nextToken && page.nextToken.length > 100);
    assert.equal(parseBacklinksList(REAL_LIST_TOKEN_PAGE).items.length, 5);
  });

  test('the first real row, field by field (paths are the provider\'s)', () => {
    const b = page.items[0];
    assert.equal(b.domain_from, 'articlescad.com');
    assert.equal(b.page_from_title, 'Retina Eye Surgery: An Overview');
    assert.equal(b.url_to, 'https://asgeyehospital.com/specialities/retina-diseases/');
    assert.equal(b.url_to_status_code, 301);
    assert.equal(b.url_to_redirect_target, 'https://www.asgeyehospital.com/specialities/retina-diseases/');
    assert.deepEqual([b.rank, b.page_from_rank, b.domain_from_rank, b.backlink_spam_score], [211, 238, 542, 10]);
    assert.deepEqual([b.dofollow, b.attributes, b.item_type, b.semantic_location, b.anchor, b.text_pre], [true, ['noopener', 'noreferrer'], 'anchor', null, 'Retina Eye Surgery', null]);
    assert.deepEqual([b.first_seen, b.prev_seen, b.last_seen], ['2026-05-05 12:25:31 +00:00', '2026-05-05 12:25:31 +00:00', '2026-05-14 13:52:03 +00:00']);
    assert.deepEqual([b.is_new, b.is_lost, b.is_broken, b.original, b.is_indirect_link, b.links_count], [false, false, false, false, false, 1]);
    assert.deepEqual([b.domain_from_country, b.domain_from_platform_type, b.domain_from_ip, b.page_from_external_links, b.page_from_internal_links], ['US', ['unknown'], '212.132.102.82', 1, 8]);
  });

  test('noise the page never reads is dropped (ranked_keywords_info, page_from_size, group_count…)', () => {
    for (const noise of ['ranked_keywords_info', 'page_from_size', 'group_count', 'type', 'domain_to', 'url_from_https']) assert.equal(noise in page.items[0], false, noise);
  });

  test('lost and broken rows carry their flags', () => {
    assert.ok(parseBacklinksList(REAL_LIST_LOST).items.every((b) => b.is_lost === true || b.is_lost === false));
    const broken = parseBacklinksList(REAL_LIST_BROKEN);
    assert.equal(broken.totalCount, 1601);
    assert.ok(broken.items.every((b) => b.is_broken === true));
    assert.ok(broken.items.every((b) => Number.isInteger(b.url_to_status_code)));
  });

  test('missing values are null, never 0 or ""; junk is dropped; text around the link is clipped', () => {
    const b = parseBacklink({ url_from: 'https://a.com/x', rank: 'x', domain_from_rank: NaN, anchor: '  ', dofollow: 'yes', attributes: ['a', '', 5], text_pre: 'y'.repeat(400), indirect_link_path: [{ url: 'https://z.com/' }, 7, 'https://q.com/'] });
    assert.deepEqual([b.rank, b.domain_from_rank, b.anchor, b.dofollow, b.attributes], [null, null, null, null, ['a']]);
    assert.equal(b.text_pre.length, 300);
    assert.deepEqual(b.indirect_link_path, ['https://z.com/', 'https://q.com/']);
    assert.equal(parseBacklink({ anchor: 'orphan' }), null, 'a row with no source at all is not a link');
  });

  test('no result / nothing matched: 0 links (not unknown); no token is null', () => {
    assert.deepEqual(parseBacklinksList({ total_count: null, items: null }), { totalCount: 0, nextToken: null, items: [] });
    assert.deepEqual(parseBacklinksList(null), { totalCount: null, nextToken: null, items: [] });
    assert.equal(parseBacklinksList({ total_count: 3, items: [], search_after_token: '' }).nextToken, null);
  });

  test('it goes through the 20000 / 20000 envelope check like every section', () => {
    assert.equal(parseSectionResponse('backlinks-list', envelope(REAL_LIST_DEFAULT, { cost: 0.0258 }), ctx).cost, 0.0258);
    assert.throws(() => parseSectionResponse('backlinks-list', envelope(REAL_LIST_DEFAULT, { taskStatus: 40501 }), ctx));
  });
});

describe('backlinks CSV (server-side export)', () => {
  test('the header is the documented column list', () => {
    assert.deepEqual(BACKLINK_CSV_HEADER, [
      'Source URL', 'Source title', 'Source domain', 'Domain rank', 'Page rank', 'Anchor', 'Item type', 'Target URL', 'Target status', 'Redirect target', 'Dofollow',
      'Attributes', 'Placement', 'Spam score', 'Country', 'First seen', 'Last seen', 'New', 'Lost', 'Broken',
    ]);
  });

  test('a real row: values in the right columns, yes/no flags, empty cells for nulls', () => {
    const line = backlinkCsvLine(parseBacklinksList(REAL_LIST_DEFAULT).items[0]);
    assert.ok(line.endsWith('\r\n'));
    assert.equal(line.trimEnd(), 'https://articlescad.com/15-amazing-facts-about-sash-window-maintenance-that-youve-never-heard-of-16477.html,Retina Eye Surgery: An Overview,articlescad.com,542,238,Retina Eye Surgery,anchor,https://asgeyehospital.com/specialities/retina-diseases/,301,https://www.asgeyehospital.com/specialities/retina-diseases/,yes,noopener; noreferrer,,10,US,2026-05-05 12:25:31 +00:00,2026-05-14 13:52:03 +00:00,no,no,no');
  });

  test('cells with commas / quotes / new lines are quoted; formula starters are neutralised', () => {
    assert.equal(csvCell('a,b'), '"a,b"');
    assert.equal(csvCell('say "hi"'), '"say ""hi"""');
    assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
    assert.equal(csvCell('+1'), "'+1");
    assert.equal(csvCell(null), '');
    assert.equal(csvCell(0), '0');
    assert.equal(csvCell(NaN), '');
  });
});
