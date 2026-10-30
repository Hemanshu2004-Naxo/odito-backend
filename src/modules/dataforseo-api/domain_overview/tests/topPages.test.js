import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTrafficByUrl, FLAG_IDS, FLAG_LABELS, getPageFlags, getStatusGroup, normalizePageUrl, suggestFix } from '../provider/pageMetrics.js';
import { parseDomainPagesQuery, parseLimit, parseOrderBy, buildVariant } from '../validator/domainPagesQuery.js';
import { parseBacklinksListQuery } from '../validator/backlinksListQuery.js';
import { buildRequest, parseDomainPage, parseDomainPages, parseSectionResponse } from '../provider/domainOverviewProvider.js';
import { joinTraffic } from '../service/topPagesService.js';
import { TP_CSV_COLUMNS, TP_CSV_HEADER, topPageCsvLine } from '../csv/topPagesCsv.js';
import { DOMAIN_PAGES_BASE_FILTER, DOMAIN_PAGES_QUERY, PAGE_FLAGS, SECTIONS } from '../config.js';
import { RAW_PAGES_DEFAULT, RAW_PAGES_ERRORS, RAW_PAGES_OK, RAW_PAGES_REDIRECTS } from './realPages.js';

const f = (...c) => JSON.stringify(c.length === 1 ? c[0] : c.flatMap((x, i) => (i ? ['and', x] : [x])));
const rejects = (fn, field) => assert.throws(fn, (e) => e.name === 'ValidationFailure' && (!field || e.field === field));

describe('normalizePageUrl: one page, however it was found', () => {
  test('the examples of the brief', () => {
    assert.equal(normalizePageUrl('https://www.asgeyehospital.com/'), 'asgeyehospital.com');
    assert.equal(normalizePageUrl('http://asgeyehospital.com/patna/'), 'asgeyehospital.com/patna');
  });
  test('the homepage found as www / non-www / http / https / with or without the slash is ONE page', () => {
    const variants = ['https://www.asgeyehospital.com/', 'https://asgeyehospital.com/', 'http://asgeyehospital.com/', 'http://www.asgeyehospital.com/', 'https://asgeyehospital.com', 'HTTPS://WWW.ASGEYEHOSPITAL.COM/'];
    assert.deepEqual(new Set(variants.map(normalizePageUrl)), new Set(['asgeyehospital.com']));
  });
  test('every trailing-slash variant of a path is one page, several slashes too', () => {
    assert.equal(normalizePageUrl('https://x.com/a/b/'), 'x.com/a/b');
    assert.equal(normalizePageUrl('https://x.com/a/b'), 'x.com/a/b');
    assert.equal(normalizePageUrl('https://x.com/a/b///'), 'x.com/a/b');
  });
  test('the host is lowercased; the path keeps its case (paths are case-sensitive)', () => {
    assert.equal(normalizePageUrl('https://WWW.Example.COM/Blog/Post'), 'example.com/Blog/Post');
  });
  test('the query is kept (even after a trailing slash); a fragment is dropped', () => {
    assert.equal(normalizePageUrl('https://x.com/a/?page=2'), 'x.com/a?page=2');
    assert.equal(normalizePageUrl('https://x.com/?s=eye#top'), 'x.com?s=eye');
    assert.equal(normalizePageUrl('https://x.com/a#section'), 'x.com/a');
  });
  test('a different path or subdomain is a DIFFERENT page (only "www." is removed)', () => {
    assert.notEqual(normalizePageUrl('https://x.com/a'), normalizePageUrl('https://x.com/b'));
    assert.equal(normalizePageUrl('https://blog.x.com/a'), 'blog.x.com/a');
    assert.equal(normalizePageUrl('https://wwwx.com/a'), 'wwwx.com/a');
  });
  test('a URL without a protocol and a port are handled; anything that is not a URL is null', () => {
    assert.equal(normalizePageUrl('www.x.com/a/'), 'x.com/a');
    assert.equal(normalizePageUrl('https://x.com:8443/a/'), 'x.com:8443/a');
    for (const bad of [null, undefined, '', '   ', 42, {}, ['a'], 'https://', 'http:///path']) assert.equal(normalizePageUrl(bad), null, String(bad));
  });
});

describe('getStatusGroup', () => {
  test('2xx ok, 3xx redirect, 4xx / 5xx error — and every boundary', () => {
    for (const [code, group] of [[200, 'ok'], [204, 'ok'], [299, 'ok'], [300, 'redirect'], [301, 'redirect'], [308, 'redirect'], [399, 'redirect'],
      [400, 'error'], [401, 'error'], [404, 'error'], [410, 'error'], [429, 'error'], [499, 'error'], [500, 'error'], [503, 'error'], [599, 'error']]) {
      assert.equal(getStatusGroup(code), group, String(code));
    }
  });
  test('403 is "blocked": an error with its own label', () => {
    assert.equal(getStatusGroup(403), 'blocked');
    assert.equal(getStatusGroup(402), 'error');
    assert.equal(getStatusGroup(404), 'error');
  });
  test('0, null, undefined, 1xx, 600+, text and fractions are "unknown"', () => {
    for (const bad of [0, null, undefined, 100, 199, 600, 999, -1, '404', '200', NaN, 200.5, {}, []]) assert.equal(getStatusGroup(bad), 'unknown', String(bad));
  });
});

describe('suggestFix', () => {
  test('404 and 410: redirect; 403: firewall; 5xx: hosting; anything else: look at it', () => {
    assert.equal(suggestFix(404), 'Add a 301 redirect to a relevant live page');
    assert.equal(suggestFix(410), 'Add a 301 redirect to a relevant live page');
    assert.equal(suggestFix(403), 'Server/CDN is blocking access — check firewall or bot protection');
    for (const c of [500, 502, 503, 599]) assert.equal(suggestFix(c), 'Server error — check hosting');
    for (const c of [200, 301, 400, 401, 429, 600, null, undefined, 0, '404']) assert.equal(suggestFix(c), 'Check this URL');
  });
});

describe('getPageFlags: every threshold at its boundary', () => {
  const page = (o) => ({ statusGroup: 'ok', backlinks: 10, referringDomains: 10, traffic: 100, ...o });
  test('wasted_links: an error or blocked page with at least 1 backlink', () => {
    assert.deepEqual(getPageFlags(page({ statusGroup: 'error', backlinks: 1 })), ['wasted_links']);
    assert.deepEqual(getPageFlags(page({ statusGroup: 'blocked', backlinks: 852 })), ['wasted_links']);
    assert.deepEqual(getPageFlags(page({ statusGroup: 'error', backlinks: 0 })), []);
    assert.deepEqual(getPageFlags(page({ statusGroup: 'error', backlinks: null })), []);
    for (const g of ['ok', 'redirect', 'unknown']) assert.ok(!getPageFlags(page({ statusGroup: g, backlinks: 50 })).includes('wasted_links'), g);
  });
  test('redirected_links: a redirect with 10 or more referring domains (9 is not enough)', () => {
    assert.deepEqual(getPageFlags(page({ statusGroup: 'redirect', referringDomains: 10 })), ['redirected_links']);
    assert.deepEqual(getPageFlags(page({ statusGroup: 'redirect', referringDomains: 9 })), []);
    assert.deepEqual(getPageFlags(page({ statusGroup: 'redirect', referringDomains: null })), []);
    assert.ok(!getPageFlags(page({ statusGroup: 'ok', referringDomains: 500, traffic: 5 })).includes('redirected_links'));
  });
  test('links_no_traffic: an OK page with 20 or more referring domains and NO traffic', () => {
    assert.deepEqual(getPageFlags(page({ referringDomains: 20, traffic: 0 })), ['links_no_traffic']);
    assert.deepEqual(getPageFlags(page({ referringDomains: 19, traffic: 0 })), []);
    assert.deepEqual(getPageFlags(page({ referringDomains: 20, traffic: 0.01 })), []);
    assert.deepEqual(getPageFlags(page({ referringDomains: 20, traffic: 1 })), []);
    assert.deepEqual(getPageFlags(page({ statusGroup: 'redirect', referringDomains: 20, traffic: 0 })), ['redirected_links']);
  });
  test('traffic_few_links: an OK page with 500 or more traffic and fewer than 5 referring domains', () => {
    assert.deepEqual(getPageFlags(page({ traffic: 500, referringDomains: 4 })), ['traffic_few_links']);
    assert.deepEqual(getPageFlags(page({ traffic: 499, referringDomains: 4 })), []);
    assert.deepEqual(getPageFlags(page({ traffic: 500, referringDomains: 5 })), []);
    assert.deepEqual(getPageFlags(page({ traffic: 9000, referringDomains: 0 })), ['traffic_few_links']);
    assert.deepEqual(getPageFlags(page({ statusGroup: 'error', traffic: 900, referringDomains: 1, backlinks: 0 })), []);
  });
  test('a page whose traffic is UNKNOWN (the join failed) never gets a traffic-based flag — a missing figure is not a zero', () => {
    assert.deepEqual(getPageFlags(page({ referringDomains: 500, traffic: null })), []);
    assert.deepEqual(getPageFlags(page({ referringDomains: 1, traffic: null })), []);
    assert.deepEqual(getPageFlags(page({ statusGroup: 'error', backlinks: 5, traffic: null })), ['wasted_links']);
    assert.deepEqual(getPageFlags(page({ statusGroup: 'redirect', referringDomains: 50, traffic: null })), ['redirected_links']);
  });
  test('the thresholds come from ONE config object and can be changed', () => {
    assert.deepEqual(PAGE_FLAGS, { wastedLinks: { minBacklinks: 1 }, redirected: { minReferringDomains: 10 }, noTraffic: { minReferringDomains: 20 }, fewLinks: { minTraffic: 500, belowReferringDomains: 5 } });
    assert.deepEqual(getPageFlags(page({ statusGroup: 'redirect', referringDomains: 3 }), { ...PAGE_FLAGS, redirected: { minReferringDomains: 3 } }), ['redirected_links']);
  });
  test('only known flag ids are ever returned, each with a CSV label', () => {
    for (const id of FLAG_IDS) assert.ok(FLAG_LABELS[id], id);
    assert.deepEqual(FLAG_IDS, ['wasted_links', 'redirected_links', 'links_no_traffic', 'traffic_few_links']);
  });
});

describe('buildTrafficByUrl: the traffic per page from ranked keywords', () => {
  test('sums traffic and counts keywords per NORMALISED url (www / http / slash variants are one page)', () => {
    const byUrl = buildTrafficByUrl([
      { url: 'https://www.asgeyehospital.com/lasik/', etv: 100.5 },
      { url: 'https://asgeyehospital.com/lasik', etv: 49.5 },
      { url: 'http://www.asgeyehospital.com/lasik/', etv: 10 },
      { url: 'https://www.asgeyehospital.com/', etv: 7 },
    ], 'asgeyehospital.com');
    assert.deepEqual(byUrl, { 'asgeyehospital.com/lasik': { traffic: 160, keywords: 3 }, 'asgeyehospital.com': { traffic: 7, keywords: 1 } });
  });
  test('a keyword with no usable URL is skipped; a relative url is built on the target; a missing etv counts as 0 traffic but 1 keyword', () => {
    const byUrl = buildTrafficByUrl([{ url: null, relative_url: null, etv: 5 }, { relative_url: '/a/', etv: 3 }, { url: 'https://x.com/b', etv: null }, null, {}], 'x.com');
    assert.deepEqual(byUrl, { 'x.com/a': { traffic: 3, keywords: 1 }, 'x.com/b': { traffic: 0, keywords: 1 } });
  });
  test('floating-point noise is rounded away', () => {
    assert.equal(buildTrafficByUrl([{ url: 'https://x.com/', etv: 0.1 }, { url: 'https://x.com/', etv: 0.2 }], 'x.com')['x.com'].traffic, 0.3);
  });
  test('no keywords, no traffic', () => {
    assert.deepEqual(buildTrafficByUrl([], 'x.com'), {});
    assert.deepEqual(buildTrafficByUrl(undefined, 'x.com'), {});
  });
});

describe('the domain-pages query: whitelists, and every path confirmed by the live check of 2026-10-28', () => {
  test('no parameters = the default view: 50, offset 0, referring domains desc, no filters', () => {
    const q = parseDomainPagesQuery({});
    assert.deepEqual([q.limit, q.offset, q.orderBy, q.filters, q.isDefault], [50, 0, 'page_summary.referring_domains,desc', [], true]);
  });
  test('SORT — each confirmed path is accepted, in both directions', () => {
    for (const field of ['page_summary.referring_domains', 'page_summary.backlinks', 'page_summary.rank', 'page_summary.broken_backlinks', 'page_summary.first_seen']) {
      for (const dir of ['asc', 'desc']) assert.equal(parseOrderBy(`${field},${dir}`), `${field},${dir}`, `${field},${dir}`);
    }
    assert.deepEqual([...DOMAIN_PAGES_QUERY.orderFields], ['page_summary.referring_domains', 'page_summary.backlinks', 'page_summary.rank', 'page_summary.broken_backlinks', 'page_summary.first_seen']);
  });
  test('SORT — anything else is refused', () => {
    for (const bad of ['page,asc', 'status_code,desc', 'meta.title,asc', 'page_summary.backlinks_spam_score,desc', 'backlinks,desc', 'page_summary.rank', 'page_summary.rank,up', ['page_summary.rank,asc', 'page_summary.backlinks,desc']]) {
      rejects(() => parseOrderBy(bad), 'order_by');
    }
  });
  test('FILTER "page" — like and not_like, as %text%', () => {
    assert.deepEqual(parseDomainPagesQuery({ filters: f(['page', 'like', '%patna%']) }).filters, [['page', 'like', '%patna%']]);
    assert.deepEqual(parseDomainPagesQuery({ filters: f(['page', 'not_like', '%/blog/%']) }).filters, [['page', 'not_like', '%/blog/%']]);
    rejects(() => parseDomainPagesQuery({ filters: f(['page', 'like', 'plain']) }), 'filters');
    rejects(() => parseDomainPagesQuery({ filters: f(['page', '=', 'https://x.com/']) }), 'filters');
  });
  test('FILTER "status_code" — >= and < (the tabs: errors >= 400; redirects >= 300 and < 400; OK >= 200 and < 300)', () => {
    assert.deepEqual(parseDomainPagesQuery({ filters: f(['status_code', '>=', 400]) }).filters, [['status_code', '>=', 400]]);
    assert.equal(parseDomainPagesQuery({ filters: f(['status_code', '>=', 300], ['status_code', '<', 400]) }).filters.length, 2);
    assert.equal(parseDomainPagesQuery({ filters: f(['status_code', '>=', 200], ['status_code', '<', 300]) }).filters.length, 2);
    for (const bad of [f(['status_code', '=', 404]), f(['status_code', '>=', 1000]), f(['status_code', '>=', -1]), f(['status_code', '>=', 4.5]), f(['status_code', '>=', '404'])]) rejects(() => parseDomainPagesQuery({ filters: bad }), 'filters');
  });
  test('FILTER "page_summary.referring_domains" >=, "page_summary.backlinks" >=, "page_summary.broken_backlinks" > 0, "page_summary.first_seen" >= a date', () => {
    const q = parseDomainPagesQuery({ filters: f(['page_summary.referring_domains', '>=', 5], ['page_summary.backlinks', '>=', 10], ['page_summary.broken_backlinks', '>', 0], ['page_summary.first_seen', '>=', '2025-04-01']) });
    assert.equal(q.filters.length, 4);
    for (const bad of [
      f(['page_summary.referring_domains', '<=', 5]), f(['page_summary.referring_domains', '>=', -1]), f(['page_summary.backlinks', '>', 5]), f(['page_summary.broken_backlinks', '>', 1]),
      f(['page_summary.broken_backlinks', '>=', 0]), f(['page_summary.first_seen', '>=', '2025-13-40']), f(['page_summary.first_seen', '>=', 'yesterday']),
    ]) rejects(() => parseDomainPagesQuery({ filters: bad }), 'filters');
  });
  test('paths that were confirmed live but that the page deliberately does not expose are refused (rank and title filters, spam)', () => {
    for (const bad of [f(['page_summary.rank', '>=', 100]), f(['meta.title', 'like', '%eye%']), f(['page_summary.backlinks_spam_score', '<=', 30]), f(['domain', 'like', '%x%'])]) {
      rejects(() => parseDomainPagesQuery({ filters: bad }), 'filters');
    }
  });
  test('page size 25 / 50 / 100 / 1000; offset + limit may not pass 20,000; no status or other sections\' parameters', () => {
    for (const n of ['25', '50', '100', '1000']) assert.equal(parseLimit(n), Number(n));
    for (const n of ['10', '0', '-1', 'abc']) rejects(() => parseLimit(n), 'limit');
    assert.equal(parseDomainPagesQuery({ limit: '100', offset: '19900' }).offset, 19900);
    rejects(() => parseDomainPagesQuery({ limit: '100', offset: '19901' }), 'offset');
  });
  test('at most 8 conditions; the 9th is refused with a message that says so', () => {
    const eight = Array.from({ length: 8 }, (_, i) => ['page_summary.backlinks', '>=', i + 1]);
    assert.equal(parseDomainPagesQuery({ filters: f(...eight) }).filters.length, 8);
    assert.throws(() => parseDomainPagesQuery({ filters: f(...eight, ['status_code', '>=', 400]) }), /at most 8 filter conditions/);
  });
  test('the same question gives the same cache key; a different one does not; internal_list_limit is part of it', () => {
    const a = parseDomainPagesQuery({ filters: f(['status_code', '>=', 400], ['page_summary.backlinks', '>=', 1]) });
    const b = parseDomainPagesQuery({ filters: f(['page_summary.backlinks', '>=', 1], ['status_code', '>=', 400]) });
    assert.equal(a.variant, b.variant);
    assert.notEqual(a.variant, parseDomainPagesQuery({}).variant);
    assert.notEqual(parseDomainPagesQuery({ offset: '50' }).variant, parseDomainPagesQuery({}).variant);
    assert.match(buildVariant({ limit: 50, offset: 0, orderBy: 'page_summary.rank,desc', filters: [] }), new RegExp(`\\|i${DOMAIN_PAGES_QUERY.internalListLimit}\\|`));
    assert.ok(parseDomainPagesQuery({ filters: f(...Array.from({ length: 8 }, (_, i) => ['page', 'like', `%${'x'.repeat(90)}${i}%`])) }).variant.length <= 200);
  });
});

describe('the request the provider receives', () => {
  const target = 'asgeyehospital.com';
  test('the default view: live only, internal_list_limit 10, no market', () => {
    assert.deepEqual(buildRequest('domain-pages', { target }), {
      target, include_subdomains: true, backlinks_status_type: 'live', internal_list_limit: 10, limit: 50, order_by: ['page_summary.referring_domains,desc'],
    });
  });
  test('page, sort and filters reach it as validated; one condition is flat, several are joined with "and"', () => {
    const r = buildRequest('domain-pages', { target, query: parseDomainPagesQuery({ limit: '25', offset: '50', order_by: 'page_summary.backlinks,desc', filters: f(['status_code', '>=', 400], ['page_summary.backlinks', '>=', 1]) }) });
    assert.deepEqual([r.limit, r.offset, r.order_by], [25, 50, ['page_summary.backlinks,desc']]);
    assert.deepEqual(r.filters, [['page_summary.backlinks', '>=', 1], 'and', ['status_code', '>=', 400]]);
  });
  test('the headline counts: THREE count-only requests, each with the base condition backlinks >= 1', () => {
    const bodies = buildRequest('tp-counts', { target });
    assert.deepEqual(bodies.map((b) => b.filters), [
      ['page_summary.backlinks', '>=', 1],
      [['status_code', '>=', 400], 'and', ['page_summary.backlinks', '>=', 1]],
      [['status_code', '>=', 300], 'and', ['status_code', '<', 400], 'and', ['page_summary.backlinks', '>=', 1]],
    ]);
    for (const b of bodies) assert.deepEqual([b.limit, b.backlinks_status_type, b.target], [1, 'live', target]);
    assert.deepEqual(DOMAIN_PAGES_BASE_FILTER, ['page_summary.backlinks', '>=', 1]);
  });
  test('"Fix first": the 5 error pages with the most backlinks', () => {
    const b = buildRequest('tp-fix-first', { target });
    assert.deepEqual([b.limit, b.order_by, b.filters, b.backlinks_status_type], [5, ['page_summary.backlinks,desc'], [['status_code', '>=', 400], 'and', ['page_summary.backlinks', '>=', 1]], 'live']);
  });
  test('cache lifetimes: 24 hours for the table, 7 days for the counts, the fix-first list and the traffic', () => {
    assert.equal(SECTIONS['domain-pages'].ttlMs, 24 * 3600 * 1000);
    for (const s of ['tp-counts', 'tp-fix-first', 'top-pages-traffic']) assert.equal(SECTIONS[s].ttlMs, 7 * 24 * 3600 * 1000, s);
    assert.equal(new Set(['domain-pages', 'tp-counts', 'tp-fix-first', 'top-pages-traffic'].map((s) => SECTIONS[s].endpoint)).size, 4);
  });
});

describe('the Backlinks list takes an EXACT target URL ("View backlinks" from Top Pages)', () => {
  test('url_to = a URL is accepted (like is still a pattern); other operators and non-text are refused', () => {
    assert.deepEqual(parseBacklinksListQuery({ filters: f(['url_to', '=', 'https://www.asgeyehospital.com/']) }).filters, [['url_to', '=', 'https://www.asgeyehospital.com/']]);
    assert.deepEqual(parseBacklinksListQuery({ filters: f(['url_to', 'like', '%patna%']) }).filters, [['url_to', 'like', '%patna%']]);
    for (const bad of [f(['url_to', '<>', 'x']), f(['url_to', '=', 5]), f(['url_to', 'like', 'plain']), f(['url_to', '=', 'x'.repeat(2001)])]) rejects(() => parseBacklinksListQuery({ filters: bad }), 'filters');
  });
});

describe('parsing REAL provider rows (asgeyehospital.com)', () => {
  const errors = parseDomainPages(RAW_PAGES_ERRORS);
  const ok = parseDomainPages(RAW_PAGES_OK);
  const all = parseDomainPages(RAW_PAGES_DEFAULT);
  const by = (set, url) => set.items.find((x) => x.url === url);

  test('the totals and every row', () => {
    assert.deepEqual([errors.totalCount, errors.items.length, ok.totalCount, all.totalCount], [2501, 5, 3624, 6762]);
  });
  test('the www homepage is "blocked" (403) with its backlinks and a firewall fix; /patna/ is an error (404) with a redirect fix', () => {
    const www = by(errors, 'https://www.asgeyehospital.com/');
    assert.deepEqual([www.status_code, www.status_group, www.backlinks, www.referring_domains, www.suggested_fix], [403, 'blocked', 852, 34, 'Server/CDN is blocking access — check firewall or bot protection']);
    const patna = by(errors, 'https://asgeyehospital.com/patna/');
    assert.deepEqual([patna.status_code, patna.status_group, patna.backlinks, patna.referring_domains, patna.suggested_fix], [404, 'error', 209, 3, 'Add a 301 redirect to a relevant live page']);
  });
  test('the homepage variants share ONE normalised URL', () => {
    assert.equal(by(errors, 'https://www.asgeyehospital.com/').normalized_url, 'asgeyehospital.com');
    assert.equal(by(all, 'https://asgeyehospital.com/').normalized_url, 'asgeyehospital.com');
    assert.equal(by(all, 'http://asgeyehospital.com/').normalized_url, 'asgeyehospital.com');
    assert.equal(by(errors, 'https://asgeyehospital.com/patna/').normalized_url, 'asgeyehospital.com/patna');
  });
  test('a redirect keeps its target, has no suggested fix and no meta ("—" in the page)', () => {
    const home = by(all, 'https://asgeyehospital.com/');
    assert.deepEqual([home.status_code, home.status_group, home.location, home.suggested_fix], [301, 'redirect', 'https://www.asgeyehospital.com/', null]);
    assert.deepEqual([home.title, home.canonical, home.h1, home.language, home.technologies], [null, null, [], null, []]);
    assert.equal(home.words_count, 0);
  });
  test('the dofollow share is by REFERRING DOMAINS: (rd − rd nofollow) ÷ rd', () => {
    const home = by(all, 'https://asgeyehospital.com/');
    assert.ok(Math.abs(home.dofollow_pct - ((3223 - 155) / 3223) * 100) < 1e-9);
  });
  test('an OK page keeps its on-page info: title, h1, language, technologies as a flat list, counts, server and crawl time; no fix', () => {
    const p = by(ok, 'https://asgeyehospital.com/specialities/refractive-surgeries/');
    assert.equal(p.status_group, 'ok');
    assert.equal(p.title, 'Refractive Surgery in India | LASIK, PRK, ICL & Vision Correction | ASG Eye Hospital');
    assert.deepEqual([p.h1, p.language, p.technologies, p.server, p.media_type], [['Experience Visual Freedom'], 'en', ['wordpress', 'nginx'], 'nginx', 'text/html']);
    assert.deepEqual([p.words_count, p.internal_links_count, p.external_links_count, p.images_count, p.page_spam_score], [2085, 145, 6, 57, 0]);
    assert.equal(p.fetch_time, '2026-08-10 01:32:49 +00:00');
    assert.equal(p.suggested_fix, null);
    assert.equal(p.canonical, null);
  });
  test('canonical_differs: null with no canonical; false when it is the same page in another spelling (www / http / slash); true when it names another page', () => {
    const c = (canonical) => parseDomainPage({ page: 'https://asgeyehospital.com/lasik/', status_code: 200, meta: { canonical } }).canonical_differs;
    assert.equal(c(null), null);
    assert.equal(c('https://asgeyehospital.com/lasik/'), false);
    assert.equal(c('https://www.asgeyehospital.com/lasik'), false);
    assert.equal(c('http://ASGEYEHOSPITAL.com/lasik/'), false);
    assert.equal(c('https://asgeyehospital.com/lasik-surgery/'), true);
    assert.equal(c('https://asgeyehospital.com/lasik/?utm=x'), true);
  });
  test('the breakdowns of the link profile are { key: count } objects', () => {
    const p = by(ok, 'https://asgeyehospital.com/specialities/refractive-surgeries/');
    for (const k of ['referring_links_semantic_locations', 'referring_links_countries', 'referring_links_platform_types', 'referring_links_types']) assert.equal(typeof p[k], 'object', k);
  });
  test('the redirects list: every row is in the redirect group; the fix is only for error and blocked rows', () => {
    for (const r of parseDomainPages(RAW_PAGES_REDIRECTS).items) assert.deepEqual([r.status_group, r.suggested_fix], ['redirect', null]);
    for (const r of errors.items) assert.ok(['error', 'blocked'].includes(r.status_group) && r.suggested_fix, r.url);
  });
  test('missing or non-numeric values are null, never 0; a row without a URL is dropped; a status of 0 or null is "unknown"', () => {
    const r = parseDomainPage({ page: 'https://x.com/a', status_code: 0, page_summary: { backlinks: '12', referring_domains: NaN } });
    assert.deepEqual([r.backlinks, r.referring_domains, r.rank, r.status_group, r.dofollow_pct, r.suggested_fix, r.title, r.technologies], [null, null, null, 'unknown', null, null, null, []]);
    assert.equal(parseDomainPage({ status_code: 200 }), null);
    assert.equal(parseDomainPage({ page: '   ' }), null);
    const bare = parseDomainPage({ page: 'https://x.com/', status_code: null });
    assert.equal(bare.status_group, 'unknown');
    assert.equal(bare.status_code, null);
  });
  test('technologies may be an object of names, arrays of names or a list; only a short list of names is kept', () => {
    assert.deepEqual(parseDomainPage({ page: 'https://x.com/', meta: { technologies: { cms: 'wordpress', libs: ['jquery', 'react'], dup: 'wordpress' } } }).technologies, ['wordpress', 'jquery', 'react']);
    assert.deepEqual(parseDomainPage({ page: 'https://x.com/', meta: { technologies: ['a', 'b'] } }).technologies, ['a', 'b']);
    assert.deepEqual(parseDomainPage({ page: 'https://x.com/', meta: { technologies: 'nope' } }).technologies, []);
    assert.equal(parseDomainPage({ page: 'https://x.com/', meta: { technologies: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, `t${i}`])) } }).technologies.length, 15);
  });
  test('a long title is clipped; h1 is kept to three short strings', () => {
    const r = parseDomainPage({ page: 'https://x.com/', meta: { title: 'T'.repeat(500), h1: ['a', 'b', 'c', 'd', 'e'.repeat(300)] } });
    assert.ok(r.title.length <= 300);
    assert.deepEqual(r.h1, ['a', 'b', 'c']);
  });
  test('a filter that matches nothing is 0 pages, not "unknown"', () => {
    assert.deepEqual(parseDomainPages({ total_count: null, items_count: 0, items: null }), { totalCount: 0, items: [] });
    assert.equal(parseDomainPages(null).totalCount, null);
  });
  test('status_code 20000 is checked at the top level AND on the task', () => {
    const okResp = { status_code: 20000, tasks: [{ status_code: 20000, cost: 0.024, result: [RAW_PAGES_ERRORS] }] };
    assert.equal(parseSectionResponse('domain-pages', okResp, { target: 'x.com' }).payload.totalCount, 2501);
    assert.throws(() => parseSectionResponse('domain-pages', { ...okResp, status_code: 40000 }, { target: 'x.com' }));
    assert.throws(() => parseSectionResponse('domain-pages', { ...okResp, tasks: [{ ...okResp.tasks[0], status_code: 40501 }] }, { target: 'x.com' }));
  });
});

describe('joinTraffic: the traffic joined when a response is built', () => {
  const row = parseDomainPage({ page: 'https://www.asgeyehospital.com/specialities/lasik/', status_code: 200, page_summary: { backlinks: 90, referring_domains: 25 } });
  const traffic = (byUrl) => ({ status: 'ok', byUrl, meta: {} });
  test('a match gives its traffic and keyword count (any URL variant of the page)', () => {
    const j = joinTraffic(row, traffic({ 'asgeyehospital.com/specialities/lasik': { traffic: 640, keywords: 12 } }));
    assert.deepEqual([j.traffic, j.keywords, j.flags], [640, 12, []]);
  });
  test('NO match is 0 (the keywords read do not rank the page) — and that is what raises "strong links but no rankings"', () => {
    const j = joinTraffic(row, traffic({}));
    assert.deepEqual([j.traffic, j.keywords, j.flags], [0, 0, ['links_no_traffic']]);
  });
  test('a failed join is null, not 0, and raises no traffic-based flag', () => {
    const j = joinTraffic(row, { status: 'failed', code: 'X' });
    assert.deepEqual([j.traffic, j.keywords, j.flags], [null, null, []]);
  });
  test('the cached row is not changed by the join', () => {
    const before = JSON.stringify(row);
    joinTraffic(row, traffic({}));
    assert.equal(JSON.stringify(row), before);
  });
});

describe('the CSV columns', () => {
  test('the columns of the brief, in order', () => {
    assert.deepEqual(TP_CSV_HEADER, ['URL', 'Normalised URL', 'Status', 'Redirect target', 'Title', 'Referring domains', 'Backlinks', 'Broken backlinks', 'Dofollow %', 'Rank', 'Est. traffic', 'Keywords', 'Flags', 'Suggested fix', 'First seen', 'Last crawled']);
    assert.equal(TP_CSV_COLUMNS.length, TP_CSV_HEADER.length);
  });
  test('a real error page, joined: status, fix, flags as words', () => {
    const www = joinTraffic(parseDomainPages(RAW_PAGES_ERRORS).items[0], { status: 'ok', byUrl: {}, meta: {} });
    assert.equal(topPageCsvLine(www), `https://www.asgeyehospital.com/,asgeyehospital.com,403,,,34,852,${www.broken_backlinks},${Math.round(www.dofollow_pct * 10) / 10},${www.rank},0,0,Links point to a broken page,Server/CDN is blocking access — check firewall or bot protection,${www.first_seen},${www.fetch_time}\r\n`);
  });
  test('a page whose traffic could not be joined has EMPTY traffic cells, never 0', () => {
    const line = topPageCsvLine(joinTraffic(parseDomainPage({ page: 'https://x.com/a', status_code: 200 }), { status: 'failed' }));
    assert.equal(line.split(',').slice(10, 12).join(','), ',');
  });
  test('a title that looks like a formula is neutralised; commas and quotes are escaped', () => {
    assert.match(topPageCsvLine({ url: 'https://x.com/', title: '=HYPERLINK("x")' }), /,"'=HYPERLINK\(""x""\)",/);
    assert.match(topPageCsvLine({ url: 'https://x.com/', title: 'a, b' }), /,"a, b",/);
  });
});
