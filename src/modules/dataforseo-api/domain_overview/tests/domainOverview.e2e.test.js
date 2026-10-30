import { describe, test, before, after, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import express from 'express';

dotenv.config();
// The real DataForSEO transport is replaced in before(); these placeholders only satisfy the credentials check.
const REAL_LOGIN = process.env.DATAFORSEO_LOGIN;
const REAL_PASSWORD = process.env.DATAFORSEO_PASSWORD;
process.env.DATAFORSEO_LOGIN = 'test-login';
process.env.DATAFORSEO_PASSWORD = 'test-password';

import User from '../../../user/model/User.js';
import SeoProject from '../../../app_user/model/SeoProject.js';
import { signAuthToken } from '../../../user/service/tokenService.js';
import DataForSeoCacheEntry from '../../shared/DataForSeoCacheEntry.js';
import { __resetInFlightForTests, MIN_REFRESH_INTERVAL_MS } from '../../shared/apiCache.js';
import domainOverviewRoutes from '../routes/domainOverviewRoutes.js';
import { __setTransportForTests } from '../provider/domainOverviewProvider.js';
import { SECTION_NAMES, REFRESH_LIMIT, RANKED_KEYWORDS_QUERY_LIMIT, COMPETITORS_QUERY_LIMIT, BULK_TRAFFIC_LIMIT, BACKLINKS_QUERY_LIMIT, BACKLINKS_LIST_LIMIT, BACKLINKS_EXPORT, REFERRING_DOMAINS_EXPORT, TOP_PAGES_EXPORT } from '../config.js';
import { REAL_BACKLINKS_LOST, REAL_BACKLINKS_DOFOLLOW } from './realBacklinks.js';
import { REAL_LIST_DEFAULT } from './realBacklinksList.js';
import { RAW_ANCHORS } from './realAnchors.js';
import { RAW_RD_DEFAULT } from './realReferringDomains.js';
import { RAW_PAGES_DEFAULT, RAW_PAGES_ERRORS, RAW_PAGES_REDIRECTS, RAW_PAGES_OK } from './realPages.js';
import { __resetProviderBudgetForTests } from '../service/providerBudget.js';
import { windowStartDay } from '../../shared/dates.js';
import {
  envelope, rankOverviewResult, historyResult, historyItem, rankedKeywordsResult, competitorsResult, competitorItem, backlinksResult,
  bulkTrafficItem, bulkTrafficResult,
} from './fixtures.js';

const MARK = `dom-overview-e2e-${Date.now()}`;
const DOMAIN = `${MARK}.example.com`;

let mongoAvailable = false;
let server;
let baseUrl;
let userA; let userB; let tokenA; let tokenB; let projectA; let projectB;
let calls; // every request the stubbed provider received: { section, body }
const listState = { total: 2500 };
const anchorState = { total: 1004 };
const rdState = { total: 3958 };
const pageState = { total: 518 };
/** Set by a test to say what Organic Keywords answers (the traffic join reads it); null = the suite's usual stub. */
const kwState = { make: null };
let failures; // section -> envelope to answer with instead of the normal one

const normal = {
  'rank-overview': () => envelope(rankOverviewResult()),
  // One entry per month from date_to back to date_from, newest first, like the provider.
  'history': (body) => {
    const [fy, fm] = body.date_from.split('-').map(Number);
    const [ty, tm] = body.date_to.split('-').map(Number);
    const items = [];
    for (let i = ty * 12 + tm - 1; i >= fy * 12 + fm - 1; i -= 1) items.push(historyItem(Math.floor(i / 12), (i % 12) + 1, 1000 + i, 100 + (i % 50)));
    return envelope(historyResult(items), { cost: 0.0104 * items.length });
  },
  'ranked-keywords': (body) => (kwState.make ? kwState.make(body) : envelope(rankedKeywordsResult())),
  // Like the real API, the first row is the requested site itself.
  'competitors': (body) => envelope(competitorsResult([competitorItem(body.target), competitorItem('youtube.com'), competitorItem('rival.com')])),
  'backlinks': () => envelope(backlinksResult()),
  // Individual backlinks: `listState.total` links; an offset or a "T<n>" token says where a page starts; each page hands out the next token.
  'backlinks-list': (body) => {
    const start = body.search_after_token ? Number(body.search_after_token.slice(1)) : (body.offset ?? 0);
    const count = Math.max(0, Math.min(body.limit, listState.total - start));
    const items = Array.from({ length: count }, (_, i) => ({ ...REAL_LIST_DEFAULT.items[0], url_from: `https://src${start + i}.example.com/p`, domain_from: `src${start + i}.example.com`, rank: 1000 - ((start + i) % 1000) }));
    return envelope({ total_count: listState.total, items_count: count, items: count ? items : null, search_after_token: start + count < listState.total ? `T${start + count}` : null });
  },
  // Anchors: `anchorState.total` anchors, the real rows cycled; the profile asks for 1,000 and gets them.
  'anchors': (body) => {
    const start = body.offset ?? 0;
    const count = Math.max(0, Math.min(body.limit, anchorState.total - start));
    const items = Array.from({ length: count }, (_, i) => ({ ...RAW_ANCHORS.items[(start + i) % RAW_ANCHORS.items.length], anchor: `anchor ${start + i}` }));
    return envelope({ total_count: anchorState.total, items_count: count, items: count ? items : null });
  },
  // Referring domains: `rdState.total` domains (the real rows cycled, renamed past the first 10); a domain "in" filter answers just those.
  'referring-domains': (body) => {
    const inList = Array.isArray(body.filters) && body.filters[0] === 'domain' && body.filters[1] === 'in' ? body.filters[2] : null;
    const start = body.offset ?? 0;
    const real = RAW_RD_DEFAULT.items;
    const at = (n) => (n < real.length ? real[n] : { ...real[n % real.length], domain: `d${n}.example.com` });
    if (inList) {
      const found = inList.map((d) => real.find((r) => r.domain === d)).filter(Boolean);
      return envelope({ total_count: found.length, items_count: found.length, items: found.length ? found : null });
    }
    const count = Math.max(0, Math.min(body.limit, rdState.total - start));
    const items = Array.from({ length: count }, (_, i) => at(start + i));
    return envelope({ total_count: rdState.total, items_count: count, items: count ? items : null });
  },
  // One count-only call per rank bucket (the lower bound of the range decides the answer); the toxic card is a count too.
  'rd-rank-buckets': (body) => {
    const min = Array.isArray(body.filters[0]) ? body.filters[0][2] : body.filters[2];
    const total = { 0: 2000, 100: 118, 200: 40, 300: 8, 500: 1 }[min];
    return envelope({ total_count: total, items_count: 1, items: [RAW_RD_DEFAULT.items[0]] });
  },
  'rd-toxic-count': () => envelope({ total_count: 3002, items_count: 1, items: [RAW_RD_DEFAULT.items[0]] }),
  // The Domain Overview's last-30-days tiles: two count-only calls (live + first_seen, lost + lost_date).
  'rd-last-30': (body) => envelope({ total_count: body.backlinks_status_type === 'lost' ? 12 : 41, items_count: 1, items: [RAW_RD_DEFAULT.items[0]] }),
  // Top pages: the real rows; a status filter picks the tab's set (errors / redirects / OK), anything else is the default set cycled to the
  // size asked. `pageState.total` is what the unfiltered view reports.
  'domain-pages': (body) => {
    const conds = Array.isArray(body.filters) && typeof body.filters[0] === 'string' ? [body.filters] : (body.filters ?? []).filter((c) => c !== 'and');
    const min = conds.find((c) => c[0] === 'status_code' && c[1] === '>=')?.[2];
    const max = conds.find((c) => c[0] === 'status_code' && c[1] === '<')?.[2];
    const set = min >= 400 ? RAW_PAGES_ERRORS : min >= 300 && max <= 400 ? RAW_PAGES_REDIRECTS : min >= 200 ? RAW_PAGES_OK : null;
    if (set) return envelope({ total_count: set.total_count, items_count: set.items.length, items: set.items.slice(0, body.limit) });
    const start = body.offset ?? 0;
    const real = RAW_PAGES_DEFAULT.items;
    const count = Math.max(0, Math.min(body.limit, pageState.total - start));
    const items = Array.from({ length: count }, (_, i) => { const n = start + i; return n < real.length ? real[n] : { ...real[n % real.length], page: `https://asgeyehospital.com/page-${n}/` }; });
    return envelope({ total_count: pageState.total, items_count: count, items: count ? items : null });
  },
  'tp-counts': (body) => {
    const conds = Array.isArray(body.filters) && typeof body.filters[0] === 'string' ? [body.filters] : (body.filters ?? []).filter((c) => c !== 'and');
    const min = conds.find((c) => c[0] === 'status_code' && c[1] === '>=')?.[2];
    const total = min >= 400 ? 138 : min >= 300 ? 312 : 518;
    return envelope({ total_count: total, items_count: 1, items: [RAW_PAGES_DEFAULT.items[0]] });
  },
  'tp-fix-first': (body) => envelope({ total_count: 138, items_count: 5, items: RAW_PAGES_ERRORS.items.slice(0, body.limit) }),
  // The profile is the same endpoint with a fixed body.
  'anchor-profile': (body) => normal.anchors(body),
  // The provider answers in a different order from the request (here: reversed).
  'bulk-traffic': (body) => envelope(bulkTrafficResult([...body.targets].reverse().map((t) => bulkTrafficItem(t)))),
};

before(async () => {
  const transport = {};
  for (const section of SECTION_NAMES) {
    transport[section] = async (body) => {
      calls.push({ section, body });
      const failure = failures[section];
      if (failure instanceof Error) throw failure;
      return failure || normal[section](body);
    };
  }
  __setTransportForTests(transport);
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
  } catch {
    mongoAvailable = false;
    return;
  }
  await DataForSeoCacheEntry.init();
  const app = express();
  app.use(express.json());
  app.use('/api/projects', domainOverviewRoutes);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/projects`;
});

after(async () => {
  __setTransportForTests(null);
  process.env.DATAFORSEO_LOGIN = REAL_LOGIN;
  process.env.DATAFORSEO_PASSWORD = REAL_PASSWORD;
  if (mongoAvailable) {
    await DataForSeoCacheEntry.deleteMany({ target: new RegExp(MARK) });
    await SeoProject.deleteMany({ project_name: new RegExp(MARK) });
    await User.deleteMany({ email: new RegExp(MARK) });
    await mongoose.connection.close();
  }
  if (server) await new Promise((resolve) => server.close(resolve));
});

let seq = 0;
// Fresh domain/users/projects per test: the cache is keyed by domain and the rate limiters by user, so tests must not share either.
let domain;
beforeEach(async () => {
  calls = [];
  failures = {};
  __resetInFlightForTests();
  if (!mongoAvailable) return;
  seq += 1;
  domain = `s${seq}-${DOMAIN}`;
  userA = await User.create({ firstName: 'Ann', lastName: 'Owner', email: `a${seq}-${MARK}@example.com`, password: 'Passw0rd!long', roleId: 5 });
  userB = await User.create({ firstName: 'Bob', lastName: 'Other', email: `b${seq}-${MARK}@example.com`, password: 'Passw0rd!long', roleId: 5 });
  tokenA = signAuthToken(userA);
  tokenB = signAuthToken(userB);
  projectA = await SeoProject.create({ user_id: userA._id, project_name: `${MARK}-A${seq}`, main_url: `https://www.${domain}/clinic/`, seo_scope: 'local', keywords: ['k'], country: 'IN', language: 'en' });
  projectB = await SeoProject.create({ user_id: userB._id, project_name: `${MARK}-B${seq}`, main_url: `https://${domain}`, seo_scope: 'local', keywords: ['k'] });
});

afterEach(() => { mock.restoreAll(); });

async function call(path, { token, headers, method = 'GET', body } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json, headers: res.headers };
}
const url = (project, section, query = '') => `/${project._id}/domain-overview/${section}${query}`;

describe('Domain Overview API (real router + live Mongo cache, stubbed provider)', () => {
  test('rejects unauthenticated requests with 401 and spends nothing', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    assert.equal((await call(url(projectA, 'history'))).status, 401);
    assert.equal(calls.length, 0);
  });

  test('another user cannot read a project they do not own (403), and invalid input is rejected before any provider call', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    assert.equal((await call(url(projectA, 'history'), { token: tokenB })).status, 403);
    assert.equal((await call('/not-an-object-id/domain-overview/history', { token: tokenA })).status, 400);
    for (const bad of ['overview', 'HISTORY', '..%2Fx']) {
      const res = await call(url(projectA, bad), { token: tokenA });
      assert.equal(res.status, 400, bad);
      assert.equal(res.json.code, 'UNKNOWN_SECTION');
    }
    const badRefresh = await call(url(projectA, 'history', '?refresh=yes'), { token: tokenA });
    assert.equal(badRefresh.status, 400);
    assert.equal(badRefresh.json.field, 'refresh');
    assert.equal(calls.length, 0);
  });

  test('a section is fetched once with the project-derived target and market, returned slim, and never cached by the browser', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const res = await call(url(projectA, 'rank-overview'), { token: tokenA });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body, { target: domain, location_name: 'India', language_name: 'English' }, 'www stripped; market from the project');
    const d = res.json.data;
    assert.deepEqual([d.section, d.target, d.cached, d.refreshThrottled, d.ttlSeconds], ['rank-overview', domain, false, false, 86400]);
    assert.deepEqual(d.market, { location: 'India', language: 'English' });
    assert.ok(!Number.isNaN(Date.parse(d.fetchedAt)));
    assert.equal(d.result.organic.etv, 100412.4);
    assert.equal(JSON.stringify(d).includes('test-password'), false);
  });

  test('the second request is served from the MongoDB cache with the original fetch time', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const first = await call(url(projectA, 'backlinks'), { token: tokenA });
    const second = await call(url(projectA, 'backlinks'), { token: tokenA });
    assert.equal(calls.length, 1);
    assert.equal(second.json.data.cached, true);
    assert.equal(second.json.data.fetchedAt, first.json.data.fetchedAt);
    assert.deepEqual(second.json.data.result, first.json.data.result);
    const row = await DataForSeoCacheEntry.findOne({ target: domain, endpoint: 'backlinks/summary/v2' }).lean();
    assert.equal(row.cost, 0.0136);
    assert.equal(row.expiresAt.getTime() - row.fetchedAt.getTime(), 24 * 3600 * 1000);
  });

  test('all five dashboard sections load in parallel, each with its own body; history is cached for 7 days', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const FIVE = SECTION_NAMES.filter((s) => !['bulk-traffic', 'backlinks-list', 'anchors', 'anchor-profile', 'referring-domains', 'rd-rank-buckets', 'rd-toxic-count', 'rd-last-30', 'domain-pages', 'tp-counts', 'tp-fix-first', 'top-pages-traffic'].includes(s));
    const results = await Promise.all(FIVE.map((s) => call(url(projectA, s), { token: tokenA })));
    assert.deepEqual(results.map((r) => r.status), [200, 200, 200, 200, 200]);
    assert.equal(calls.length, 5);
    const body = (s) => calls.find((c) => c.section === s).body;
    assert.match(body('history').date_from, /^\d{4}-\d{2}-01$/);
    assert.match(body('history').date_to, /^\d{4}-\d{2}-01$/);
    assert.deepEqual(body('ranked-keywords').order_by, ['ranked_serp_element.serp_item.etv,desc']);
    // The dashboard card asks for the Competitors page's default view: 50 rows, most shared keywords first, big sites hidden by the provider.
    assert.deepEqual(body('competitors'), {
      target: domain, location_name: 'India', language_name: 'English', limit: 50, order_by: ['intersections,desc'], exclude_top_domains: true, max_rank_group: 100,
    });
    assert.deepEqual(body('backlinks'), { target: domain, include_subdomains: true, internal_list_limit: 20, backlinks_status_type: 'live' });
    assert.equal(results[FIVE.indexOf('history')].json.data.ttlSeconds, 7 * 86400);
    // The site itself is taken out of the rows and handed back separately; the provider (not us) decides which sites are too big.
    const comp = results[FIVE.indexOf('competitors')].json.data.result;
    assert.deepEqual(comp.items.map((i) => i.domain), ['youtube.com', 'rival.com']);
    assert.equal(comp.self.domain, domain);
  });

  test('the market follows the project (country / language), not the request', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    await SeoProject.updateOne({ _id: projectA._id }, { $set: { country: 'GB', language: 'hi' } });
    const res = await call(url(projectA, 'history', '?location_name=Mars&target=evil.com'), { token: tokenA });
    assert.equal(res.status, 200);
    assert.equal(calls[0].body.target, domain);
    assert.equal(calls[0].body.location_name, 'United Kingdom');
    assert.equal(calls[0].body.language_name, 'Hindi');
  });

  test('refresh inside the minimum interval is answered from the cache; after it, the provider is called again', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    await call(url(projectA, 'history'), { token: tokenA });
    const throttled = await call(url(projectA, 'history', '?refresh=1'), { token: tokenA });
    assert.equal(calls.length, 1, 'a second purchase of the same data was prevented');
    assert.deepEqual([throttled.json.data.cached, throttled.json.data.refreshThrottled], [true, true]);

    await DataForSeoCacheEntry.updateOne({ target: domain, endpoint: 'labs/historical_rank_overview/v2' }, { $set: { fetchedAt: new Date(Date.now() - MIN_REFRESH_INTERVAL_MS - 5000) } });
    const refreshed = await call(url(projectA, 'history', '?refresh=true'), { token: tokenA });
    assert.equal(calls.length, 2);
    assert.deepEqual([refreshed.json.data.cached, refreshed.json.data.refreshThrottled], [false, false]);
    assert.ok(Date.now() - Date.parse(refreshed.json.data.fetchedAt) < 10_000, 'fetchedAt is the new fetch time');
  });

  test('an expired entry is fetched again', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    await call(url(projectA, 'competitors'), { token: tokenA });
    await DataForSeoCacheEntry.updateOne({ target: domain, endpoint: 'labs/competitors_domain/v2' }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await call(url(projectA, 'competitors'), { token: tokenA });
    assert.equal(calls.length, 2);
    assert.equal(res.json.data.cached, false);
  });

  test('?months=24 is its own one-time purchase: the 12-month entry is untouched, and each window is cached under its own key', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const twelve = await call(url(projectA, 'history'), { token: tokenA });
    assert.equal(twelve.json.data.range.months, 12);
    assert.equal(twelve.json.data.result.items.length, 13);
    assert.equal(calls.length, 1);

    const tw = await call(url(projectA, 'history', '?months=24'), { token: tokenA });
    assert.equal(tw.status, 200);
    assert.equal(tw.json.data.range.months, 24);
    assert.equal(tw.json.data.result.items.length, 25);
    assert.equal(tw.json.data.cached, false);
    assert.equal(calls.length, 2);
    const [from12, from24] = [calls[0].body.date_from, calls[1].body.date_from];
    assert.equal(calls[0].body.date_to, calls[1].body.date_to, 'both windows end at the current month');
    assert.equal(Number(from12.slice(0, 4)) - Number(from24.slice(0, 4)), 1, 'the 24-month window starts exactly a year before the 12-month one');
    assert.equal(tw.json.data.result.items[0].etv > 0 && 'pos_1' in tw.json.data.result.items[0], true, 'the full metrics are served');

    // Everything is cached now: repeating either window, in any order, spends nothing.
    for (const q of ['?months=24', '', '?months=12', '?months=24']) {
      const again = await call(url(projectA, 'history', q), { token: tokenA });
      assert.equal(again.json.data.cached, true, q || '(default)');
    }
    assert.equal(calls.length, 2, 'no further provider call');
    const rows = await DataForSeoCacheEntry.find({ target: domain, endpoint: 'labs/historical_rank_overview/v2' }).lean();
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0].variant, rows[1].variant);
    assert.match(rows[0].variant, /^\d{4}-\d{2}-01\.\.\d{4}-\d{2}-01$/);
  });

  test('?months=12 explicitly is the same entry as the default (the Domain Overview and Traffic History share it)', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    await call(url(projectA, 'history'), { token: tokenA });
    const explicit = await call(url(projectA, 'history', '?months=12'), { token: tokenA });
    assert.equal(explicit.json.data.cached, true);
    assert.equal(calls.length, 1);
  });

  test('months is validated and belongs to the history only; a bad value never reaches the provider', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    for (const bad of ['7', '36', '0', 'abc', '24.5']) {
      const res = await call(url(projectA, 'history', `?months=${bad}`), { token: tokenA });
      assert.equal(res.status, 400, bad);
      assert.equal(res.json.field, 'months');
    }
    const other = await call(url(projectA, 'rank-overview', '?months=12'), { token: tokenA });
    assert.equal(other.status, 400);
    assert.equal(other.json.field, 'months');
    assert.equal(calls.length, 0);
  });

  test('one failing section fails alone: the others still load, and the failure is not cached', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    failures['rank-overview'] = envelope(null, { taskStatus: 40501, taskMessage: "Invalid Field: 'location_name'. token=SECRET" });
    const [bad, good] = await Promise.all([call(url(projectA, 'rank-overview'), { token: tokenA }), call(url(projectA, 'backlinks'), { token: tokenA })]);
    assert.equal(bad.status, 502);
    assert.equal(bad.json.code, 'PROVIDER_REQUEST_REJECTED');
    assert.equal(bad.json.success, false);
    assert.equal(JSON.stringify(bad.json).includes('SECRET'), false, 'the provider message never reaches the browser');
    assert.equal(good.status, 200);

    failures = {};
    const retry = await call(url(projectA, 'rank-overview'), { token: tokenA });
    assert.equal(retry.status, 200);
    assert.equal(calls.filter((c) => c.section === 'rank-overview').length, 2, 'Retry reaches the provider; nothing was cached from the failure');
  });

  test('provider outages map to codes: timeout 504, rate limit 429, HTTP 200 with a failed top-level status 502', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    failures.history = Object.assign(new Error('timeout of 60000ms exceeded'), { code: 'ECONNABORTED' });
    assert.deepEqual([(await call(url(projectA, 'history'), { token: tokenA })).status], [504]);
    failures.competitors = Object.assign(new Error('Request failed'), { response: { status: 429 } });
    assert.equal((await call(url(projectA, 'competitors'), { token: tokenA })).status, 429);
    failures.backlinks = envelope(backlinksResult(), { status: 40100 });
    const res = await call(url(projectA, 'backlinks'), { token: tokenA });
    assert.equal(res.status, 502);
    assert.equal(res.json.code, 'PROVIDER_AUTH_FAILED');
    assert.equal(await DataForSeoCacheEntry.countDocuments({ target: domain }), 0);
  });

  test('a domain DataForSEO knows nothing about is a successful, empty result', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    failures['rank-overview'] = envelope({ total_count: 0, items_count: 0, items: null });
    const res = await call(url(projectA, 'rank-overview'), { token: tokenA });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.data.result, { organic: null, paid: null });
  });

  test('missing credentials: 503, no provider call, nothing cached', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const login = process.env.DATAFORSEO_LOGIN;
    delete process.env.DATAFORSEO_LOGIN;
    try {
      const res = await call(url(projectA, 'history'), { token: tokenA });
      assert.equal(res.status, 503);
      assert.equal(res.json.code, 'DATAFORSEO_NOT_CONFIGURED');
    } finally {
      process.env.DATAFORSEO_LOGIN = login;
    }
    assert.equal(calls.length, 0);
    assert.equal(await DataForSeoCacheEntry.countDocuments({ target: domain }), 0);
  });

  test('a project whose URL has no public domain gets 422 and no provider call', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    await SeoProject.updateOne({ _id: projectA._id }, { $set: { main_url: 'http://localhost:3000' } });
    const res = await call(url(projectA, 'history'), { token: tokenA });
    assert.equal(res.status, 422);
    assert.equal(res.json.code, 'INVALID_TARGET');
    assert.equal(calls.length, 0);
  });

  test('two projects on the same domain and market share one purchase', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    await SeoProject.updateOne({ _id: projectB._id }, { $set: { country: 'IN', language: 'en' } });
    await call(url(projectA, 'backlinks'), { token: tokenA });
    const other = await call(url(projectB, 'backlinks'), { token: tokenB });
    assert.equal(other.status, 200);
    assert.equal(other.json.data.cached, true);
    assert.equal(calls.length, 1);
  });

  test('cache-skipping requests are rate limited per user; ordinary reads are not', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    await call(url(projectA, 'backlinks'), { token: tokenA });
    let last;
    for (let i = 0; i < REFRESH_LIMIT.max + 1; i += 1) last = await call(url(projectA, 'backlinks', '?refresh=1'), { token: tokenA });
    assert.equal(last.status, 429);
    assert.equal(last.json.code, 'RATE_LIMITED');
    assert.equal((await call(url(projectA, 'backlinks'), { token: tokenA })).status, 200, 'a plain cached read still works');
    assert.equal(calls.length, 1, 'every refresh was throttled to the one cached purchase');
  });
});

describe('Ranked keywords: paging, sorting and filtering through the same route and cache', () => {
  const KW = 'keyword_data.keyword';
  const q = (o) => `?${new URLSearchParams(o).toString()}`;
  const filtersJson = (c) => JSON.stringify(c);

  test('the dashboard call (no parameters) and the same query written out share ONE purchase and one cache entry', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const plain = await call(url(projectA, 'ranked-keywords'), { token: tokenA });
    const explicit = await call(url(projectA, 'ranked-keywords', q({ limit: '5', offset: '0', order_by: 'ranked_serp_element.serp_item.etv,desc' })), { token: tokenA });
    assert.equal(plain.status, 200);
    assert.equal(explicit.json.data.cached, true);
    assert.equal(calls.length, 1);
    assert.deepEqual(Object.keys(calls[0].body), ['target', 'location_name', 'language_name', 'limit', 'order_by'], 'the dashboard body is exactly as before');
    assert.equal(calls[0].body.limit, 5);
    assert.equal(await DataForSeoCacheEntry.countDocuments({ target: domain, endpoint: 'labs/ranked_keywords/v2' }), 1);
  });

  test('a page / sort / filter query is sent to the provider as validated, cached per query, and each distinct query is its own purchase', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const base = { limit: '50', offset: '50', order_by: 'keyword_data.keyword_info.search_volume,desc', filters: filtersJson([[KW, 'like', '%eye%'], 'and', ['keyword_data.keyword_info.search_volume', '>=', 100]]) };
    const first = await call(url(projectA, 'ranked-keywords', q(base)), { token: tokenA });
    assert.equal(first.status, 200);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body, {
      target: domain, location_name: 'India', language_name: 'English', limit: 50, offset: 50, order_by: ['keyword_data.keyword_info.search_volume,desc'],
      // canonical order (conditions sorted by their serialised form), joined with "and"
      filters: [[KW, 'like', '%eye%'], 'and', ['keyword_data.keyword_info.search_volume', '>=', 100]],
    });
    assert.deepEqual(first.json.data.query, { limit: 50, offset: 50, order_by: 'keyword_data.keyword_info.search_volume,desc' });
    assert.equal(first.json.data.result.totalCount, 802);

    // the same question, conditions listed the other way round -> cache hit
    const reordered = await call(url(projectA, 'ranked-keywords', q({ ...base, filters: filtersJson([['keyword_data.keyword_info.search_volume', '>=', 100], 'and', [KW, 'like', '%eye%']]) })), { token: tokenA });
    assert.equal(reordered.json.data.cached, true);
    assert.equal(calls.length, 1);

    // another page, another sort, another filter: three more purchases
    await call(url(projectA, 'ranked-keywords', q({ ...base, offset: '100' })), { token: tokenA });
    await call(url(projectA, 'ranked-keywords', q({ ...base, order_by: 'keyword_data.keyword_info.search_volume,asc' })), { token: tokenA });
    await call(url(projectA, 'ranked-keywords', q({ ...base, filters: filtersJson([KW, 'like', '%lasik%']) })), { token: tokenA });
    assert.equal(calls.length, 4);
    assert.equal(await DataForSeoCacheEntry.countDocuments({ target: domain, endpoint: 'labs/ranked_keywords/v2' }), 4);
  });

  test('a single filter is sent as the flat triple the provider documents', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    await call(url(projectA, 'ranked-keywords', q({ limit: '25', filters: filtersJson([KW, 'not_like', '%cost%']) })), { token: tokenA });
    assert.deepEqual(calls[0].body.filters, [KW, 'not_like', '%cost%']);
  });

  test('invalid or unsupported parameters are a 400 before any provider call; they are refused on every other section', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const bad = [
      [{ limit: '7' }, 'limit'], [{ limit: '5000' }, 'limit'], [{ offset: '-5' }, 'offset'], [{ order_by: 'password,asc' }, 'order_by'],
      [{ filters: '[' }, 'filters'], [{ filters: filtersJson(['secret', '=', 1]) }, 'filters'],
      [{ filters: filtersJson(Array.from({ length: 9 }, (_, i) => ['keyword_data.keyword_info.search_volume', '>=', i]).flatMap((c, i) => (i ? ['and', c] : [c]))) }, 'filters'],
    ];
    for (const [params, field] of bad) {
      const res = await call(url(projectA, 'ranked-keywords', q(params)), { token: tokenA });
      assert.equal(res.status, 400, JSON.stringify(params));
      assert.equal(res.json.field, field);
    }
    const nine = await call(url(projectA, 'ranked-keywords', q(bad[6][0])), { token: tokenA });
    assert.match(nine.json.message, /at most 8/);
    for (const section of ['history', 'rank-overview', 'backlinks', 'bulk-traffic']) {
      const res = await call(url(projectA, section, '?limit=25'), { token: tokenA });
      assert.equal(res.status, 400, section);
      assert.equal(res.json.field, 'query');
    }
    // The competitors toggles and the Compare targets belong to their own sections only.
    for (const [section, params] of [['ranked-keywords', '?max_rank_group=10'], ['history', '?exclude_top_domains=0'], ['competitors', '?targets=a.com']]) {
      const res = await call(url(projectA, section, params), { token: tokenA });
      assert.equal(res.status, 400, `${section} ${params}`);
      assert.equal(res.json.field, 'query');
    }
    assert.equal(calls.length, 0, 'nothing was bought');
  });

  test('a zero-match filter is a successful empty page, not an error, and is cached', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    failures['ranked-keywords'] = envelope({ total_count: 0, items_count: 0, items: null });
    const params = q({ limit: '50', filters: filtersJson([KW, 'like', '%zzzz%']) });
    const res = await call(url(projectA, 'ranked-keywords', params), { token: tokenA });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.data.result, { totalCount: 0, metrics: null, items: [] });
    assert.equal((await call(url(projectA, 'ranked-keywords', params), { token: tokenA })).json.data.cached, true);
  });

  test('paged / sorted / filtered requests have their own per-user limit; the dashboard call is not counted by it', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    let last;
    for (let i = 0; i < RANKED_KEYWORDS_QUERY_LIMIT.max + 1; i += 1) last = await call(url(projectA, 'ranked-keywords', '?limit=7'), { token: tokenA });
    assert.equal(last.status, 429);
    assert.equal(last.json.code, 'RATE_LIMITED');
    assert.equal((await call(url(projectA, 'ranked-keywords'), { token: tokenA })).status, 200, 'the dashboard card still loads');
    assert.equal((await call(url(projectA, 'backlinks'), { token: tokenA })).status, 200);
  });
});

describe('Competitors: one route and cache for the dashboard card and the page; the exclude list lives on the project', () => {
  const q = (o) => `?${new URLSearchParams(o).toString()}`;
  const settings = (project) => `/${project._id}/competitor-settings`;
  const DEFAULT_BODY = () => ({
    target: domain, location_name: 'India', language_name: 'English', limit: 50, order_by: ['intersections,desc'], exclude_top_domains: true, max_rank_group: 100,
  });

  test('the dashboard call (no parameters) and the default view written out share ONE purchase and one cache entry', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const plain = await call(url(projectA, 'competitors'), { token: tokenA });
    const explicit = await call(url(projectA, 'competitors', q({ limit: '50', offset: '0', order_by: 'intersections,desc', exclude_top_domains: '1', max_rank_group: '100' })), { token: tokenA });
    assert.equal(plain.status, 200);
    assert.equal(explicit.json.data.cached, true);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body, DEFAULT_BODY());
    assert.equal(await DataForSeoCacheEntry.countDocuments({ target: domain, endpoint: 'labs/competitors_domain/v2' }), 1);
    assert.deepEqual(plain.json.data.query, { limit: 50, offset: 0, order_by: 'intersections,desc', exclude_top_domains: true, max_rank_group: 100, excluded_count: 0 });
  });

  test('page, sort, filter and both toggles reach the provider as validated; each distinct combination is its own cached purchase', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const params = q({
      limit: '25', offset: '25', order_by: 'competitor_metrics.organic.etv,desc', exclude_top_domains: '0', max_rank_group: '10',
      filters: JSON.stringify([['intersections', '>=', 200], 'and', ['avg_position', '<=', 40]]),
    });
    const res = await call(url(projectA, 'competitors', params), { token: tokenA });
    assert.equal(res.status, 200);
    assert.deepEqual(calls[0].body, {
      target: domain, location_name: 'India', language_name: 'English', limit: 25, offset: 25, order_by: ['competitor_metrics.organic.etv,desc'],
      filters: [['avg_position', '<=', 40], 'and', ['intersections', '>=', 200]], exclude_top_domains: false, max_rank_group: 10,
    });
    assert.equal((await call(url(projectA, 'competitors', params), { token: tokenA })).json.data.cached, true);
    await call(url(projectA, 'competitors', q({ max_rank_group: '10' })), { token: tokenA });
    await call(url(projectA, 'competitors', q({ exclude_top_domains: '0' })), { token: tokenA });
    assert.equal(calls.length, 3);
    assert.equal(await DataForSeoCacheEntry.countDocuments({ target: domain, endpoint: 'labs/competitors_domain/v2' }), 3);
  });

  test('invalid or unsupported parameters are a 400 before any provider call', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const bad = [
      [{ limit: '7' }, 'limit'], [{ limit: '1000' }, 'limit'], [{ offset: '-5' }, 'offset'],
      [{ order_by: 'relevance,desc' }, 'order_by'], [{ order_by: 'full_domain_metrics.organic.etv,desc' }, 'order_by'], [{ order_by: 'intersections,sideways' }, 'order_by'],
      [{ exclude_top_domains: 'maybe' }, 'exclude_top_domains'], [{ max_rank_group: '50' }, 'max_rank_group'],
      [{ filters: '[' }, 'filters'], [{ filters: JSON.stringify(['full_domain_metrics.organic.count', '>=', 5]) }, 'filters'],
      [{ filters: JSON.stringify(['intersections', '>=', -1]) }, 'filters'], [{ filters: JSON.stringify(['intersections', 'like', '%a%']) }, 'filters'],
      [{ filters: JSON.stringify(Array.from({ length: 9 }, (_, i) => ['intersections', '>=', i]).flatMap((c, i) => (i ? ['and', c] : [c]))) }, 'filters'],
    ];
    for (const [params, field] of bad) {
      const res = await call(url(projectA, 'competitors', q(params)), { token: tokenA });
      assert.equal(res.status, 400, JSON.stringify(params));
      assert.equal(res.json.field, field, JSON.stringify(params));
    }
    assert.equal(calls.length, 0, 'nothing was bought');
  });

  test('the exclude list is read from the PROJECT: it is sent as exclude_domains, never accepted from the request, and part of the cache key', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    await call(url(projectA, 'competitors'), { token: tokenA });
    assert.equal('exclude_domains' in calls[0].body, false);

    const added = await call(settings(projectA) + '/excluded', { token: tokenA, method: 'POST', body: { domains: ['https://www.Practo.com/doctors', 'justdial.com'] } });
    assert.equal(added.status, 200);
    assert.deepEqual(added.json.data.excluded, ['practo.com', 'justdial.com']);

    // A browser cannot smuggle its own list in.
    const res = await call(url(projectA, 'competitors', '?exclude_domains=evil.com'), { token: tokenA });
    assert.equal(res.status, 200);
    assert.equal(calls.length, 2, 'a changed list is a new question: a new purchase');
    assert.deepEqual(calls[1].body.exclude_domains, ['practo.com', 'justdial.com']);
    assert.equal(res.json.data.query.excluded_count, 2);

    // The same list again is a cache hit; the same list in another order too.
    await call(url(projectA, 'competitors'), { token: tokenA });
    assert.equal(calls.length, 2);

    // Removing the exclusions goes back to the first question, which is still cached.
    await call(settings(projectA) + '/excluded/practo.com', { token: tokenA, method: 'DELETE' });
    await call(settings(projectA) + '/excluded/justdial.com', { token: tokenA, method: 'DELETE' });
    const back = await call(url(projectA, 'competitors'), { token: tokenA });
    assert.equal(back.json.data.cached, true);
    assert.equal(calls.length, 2);
  });

  test('another project has its own exclude list; competitors requests are limited per user, the default view is not counted', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    await call(settings(projectA) + '/excluded', { token: tokenA, method: 'POST', body: { domain: 'practo.com' } });
    await call(url(projectB, 'competitors'), { token: tokenB });
    assert.equal('exclude_domains' in calls[0].body, false, "project B does not inherit project A's list");
    let last;
    for (let i = 0; i < COMPETITORS_QUERY_LIMIT.max + 1; i += 1) last = await call(url(projectA, 'competitors', '?limit=25'), { token: tokenA });
    assert.equal(last.status, 429);
    assert.equal((await call(url(projectA, 'competitors'), { token: tokenA })).status, 200, 'the dashboard card still loads');
  });

  test('provider failures are code-only errors and are not cached', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    failures.competitors = Object.assign(new Error('Request failed'), { response: { status: 429 } });
    const res = await call(url(projectA, 'competitors'), { token: tokenA });
    assert.equal(res.status, 429);
    delete failures.competitors;
    assert.equal((await call(url(projectA, 'competitors'), { token: tokenA })).json.data.cached, false);
  });

  test('a filter that matches nothing is an empty page (total 0), not an error', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    failures.competitors = envelope({ total_count: null, items_count: 0, items: null });
    const res = await call(url(projectA, 'competitors', q({ filters: JSON.stringify(['intersections', '>=', 999999]) })), { token: tokenA });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.data.result, { totalCount: 0, self: null, items: [] });
  });
});

describe('Competitor settings: tracked + excluded lists saved on the project', () => {
  const settings = (project) => `/${project._id}/competitor-settings`;
  const post = (project, list, body, token = tokenA) => call(`${settings(project)}/${list}`, { token, method: 'POST', body });
  const del = (project, list, domain, token = tokenA) => call(`${settings(project)}/${list}/${domain}`, { token, method: 'DELETE' });

  test('starts empty and reports the caps; requires login and ownership', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const res = await call(settings(projectA), { token: tokenA });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.data, { tracked: [], excluded: [], limits: { tracked: 10, excluded: 1000 } });
    assert.equal((await call(settings(projectA))).status, 401);
    assert.equal((await call(settings(projectA), { token: tokenB })).status, 403);
    assert.equal((await post(projectA, 'tracked', { domain: 'a.com' }, tokenB)).status, 403);
    assert.equal((await del(projectA, 'tracked', 'a.com', tokenB)).status, 403);
  });

  test('tracking: input is cleaned, duplicates are ignored, deleting is idempotent, and the lists are saved on the project', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const a = await post(projectA, 'tracked', { domain: '  HTTPS://www.Dragarwal.com/path/?x=1 ' });
    assert.deepEqual(a.json.data.tracked, ['dragarwal.com']);
    await post(projectA, 'tracked', { domain: 'dragarwal.com' });
    const b = await post(projectA, 'tracked', { domain: 'centreforsight.net' });
    assert.deepEqual(b.json.data.tracked, ['dragarwal.com', 'centreforsight.net']);
    assert.deepEqual((await call(settings(projectA), { token: tokenA })).json.data.tracked, ['dragarwal.com', 'centreforsight.net']);
    assert.deepEqual((await call(settings(projectB), { token: tokenB })).json.data.tracked, [], 'per project');

    assert.deepEqual((await del(projectA, 'tracked', 'DRAGARWAL.com')).json.data.tracked, ['centreforsight.net']);
    assert.equal((await del(projectA, 'tracked', 'never-added.com')).status, 200);

    // select:false — a project read does not carry the lists (they would otherwise travel with every project list).
    const plain = await SeoProject.findById(projectA._id).lean();
    assert.equal(plain.tracked_competitors, undefined);
    const withLists = await SeoProject.findById(projectA._id).select('+tracked_competitors').lean();
    assert.deepEqual(withLists.tracked_competitors, ['centreforsight.net']);
  });

  test('invalid domains are rejected with a 400 and nothing is saved', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    for (const bad of ['', '   ', 'localhost', '127.0.0.1', 'http://[::1]/', 'single-label', 'ftp://a.com', 'javascript:alert(1)', 'a b.com', 'user:pw@a.com', 'a..com', '-a.com', 42, null, ['a.com'], { d: 1 }]) {
      const res = await post(projectA, 'tracked', { domain: bad });
      assert.equal(res.status, 400, JSON.stringify(bad));
      assert.equal(res.json.field, 'domain');
    }
    assert.equal((await post(projectA, 'excluded', {})).status, 400);
    assert.equal((await post(projectA, 'excluded', { domains: [] })).status, 400);
    assert.equal((await post(projectA, 'excluded', { domains: ['ok.com', 'not a domain'] })).status, 400);
    assert.equal((await call(settings(projectA), { token: tokenA })).json.data.excluded.length, 0, 'the valid one was not half-saved');
    assert.equal((await del(projectA, 'tracked', 'not%20valid')).status, 400);
  });

  test('the project\'s own domain can be neither tracked nor excluded', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    for (const list of ['tracked', 'excluded']) {
      const res = await post(projectA, list, { domain: `https://www.${domain}/x` });
      assert.equal(res.status, 400, list);
      assert.equal(res.json.code, 'OWN_DOMAIN');
    }
  });

  test('at most 10 can be tracked (409 after that, re-adding one already there is fine) — also with 14 requests at once', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const results = await Promise.all(Array.from({ length: 14 }, (_, i) => post(projectA, 'tracked', { domain: `rival${i}.com` })));
    assert.equal(results.filter((r) => r.status === 200).length, 10);
    const refused = results.filter((r) => r.status === 409);
    assert.equal(refused.length, 4);
    assert.equal(refused[0].json.code, 'TRACKED_LIMIT_REACHED');
    const saved = (await call(settings(projectA), { token: tokenA })).json.data.tracked;
    assert.equal(saved.length, 10);
    assert.equal(new Set(saved).size, 10, 'no duplicates');
    assert.equal((await post(projectA, 'tracked', { domain: saved[0] })).status, 200);
    assert.equal((await post(projectA, 'tracked', { domain: 'one-too-many.com' })).status, 409);
    assert.equal((await del(projectA, 'tracked', saved[0])).json.data.tracked.length, 9);
    assert.equal((await post(projectA, 'tracked', { domain: 'one-too-many.com' })).status, 200);
  });

  test('at most 1,000 can be excluded; adding many at once is all-or-nothing', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const many = (from, n) => Array.from({ length: n }, (_, i) => `site${from + i}.com`);
    assert.equal((await post(projectA, 'excluded', { domains: many(0, 998) })).json.data.excluded.length, 998);
    const refused = await post(projectA, 'excluded', { domains: many(998, 3) });
    assert.equal(refused.status, 409);
    assert.equal(refused.json.code, 'EXCLUDED_LIMIT_REACHED');
    assert.equal((await call(settings(projectA), { token: tokenA })).json.data.excluded.length, 998, 'none of the three was added');
    assert.equal((await post(projectA, 'excluded', { domains: many(998, 2) })).json.data.excluded.length, 1000);
    assert.equal((await post(projectA, 'excluded', { domains: many(0, 5) })).status, 200, 'domains already listed are fine even when full');
    assert.equal((await post(projectA, 'excluded', { domains: ['site-1001.com'] })).status, 409);
    assert.equal((await post(projectA, 'excluded', { domains: many(0, 1001) })).status, 400, 'more than 1,000 in one request is refused outright');
  });

  test('saving changes is rate limited per user', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    let last;
    for (let i = 0; i < 201; i += 1) last = await del(projectA, 'tracked', 'x.com');
    assert.equal(last.status, 429);
  });
});

describe('Bulk traffic (Compare section): same route, its own cache and limit', () => {
  const q = (o) => `?${new URLSearchParams(o).toString()}`;

  test('the project is always the first target; the browser only names the competitors', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const res = await call(url(projectA, 'bulk-traffic', q({ targets: 'https://www.Dragarwal.com/, centreforsight.net' })), { token: tokenA });
    assert.equal(res.status, 200);
    assert.deepEqual(calls[0].body, {
      targets: [domain, 'centreforsight.net', 'dragarwal.com'], location_name: 'India', language_name: 'English',
      item_types: ['organic', 'paid', 'featured_snippet', 'local_pack'],
    });
    assert.deepEqual(res.json.data.query.targets, [domain, 'centreforsight.net', 'dragarwal.com']);
    // The provider answered in reverse order; every target is present for the browser to match by name.
    assert.deepEqual(res.json.data.result.items.map((i) => i.target).sort(), [domain, 'centreforsight.net', 'dragarwal.com'].sort());
    assert.deepEqual(res.json.data.result.items[0].local_pack, { etv: 32993.009464502335, count: 130 });
  });

  test('cached per SET of targets (24 h, any order, any spelling); a different set is a new purchase', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    await call(url(projectA, 'bulk-traffic', q({ targets: 'b.com,a.com' })), { token: tokenA });
    const again = await call(url(projectA, 'bulk-traffic', q({ targets: 'WWW.A.com, https://b.com/x' })), { token: tokenA });
    assert.equal(again.json.data.cached, true);
    assert.equal(again.json.data.ttlSeconds, 86400);
    assert.equal(calls.length, 1);
    await call(url(projectA, 'bulk-traffic', q({ targets: 'a.com,c.com' })), { token: tokenA });
    assert.equal(calls.length, 2);
    assert.equal(await DataForSeoCacheEntry.countDocuments({ target: domain, endpoint: 'labs/bulk_traffic_estimation' }), 2);
  });

  test('missing, invalid or too many targets are a 400 before any provider call', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    for (const params of ['', q({ targets: '' }), q({ targets: 'localhost' }), q({ targets: domain }), q({ targets: Array.from({ length: 11 }, (_, i) => `d${i}.com`).join(',') })]) {
      const res = await call(url(projectA, 'bulk-traffic', params), { token: tokenA });
      assert.equal(res.status, 400, params);
      assert.equal(res.json.field, 'targets', params);
    }
    assert.equal(calls.length, 0);
  });

  test('comparisons are limited per user', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    let last;
    for (let i = 0; i < BULK_TRAFFIC_LIMIT.max + 1; i += 1) last = await call(url(projectA, 'bulk-traffic', q({ targets: 'a.com' })), { token: tokenA });
    assert.equal(last.status, 429);
  });
});

describe('Backlinks: one route and cache for the dashboard cards and the Backlink Overview page', () => {
  const q = (o) => `?${new URLSearchParams(o).toString()}`;
  const rows = () => DataForSeoCacheEntry.countDocuments({ target: domain, endpoint: 'backlinks/summary/v2' });

  test('the dashboard call (no parameters) and the default view written out share ONE purchase and one cache entry', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    await call(url(projectA, 'backlinks'), { token: tokenA });
    const explicit = await call(url(projectA, 'backlinks', q({ status: 'live', dofollow: '0' })), { token: tokenA });
    assert.equal(explicit.json.data.cached, true);
    assert.equal(calls.length, 1);
    assert.equal(await rows(), 1);
    assert.deepEqual(explicit.json.data.query, { status: 'live', dofollow: false });
  });

  test('Lost / All / Dofollow only each reach the provider as documented, and each is bought ONCE then served from cache', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    failures.backlinks = envelope(REAL_BACKLINKS_LOST);
    const lost = await call(url(projectA, 'backlinks', q({ status: 'lost' })), { token: tokenA });
    assert.equal(calls[0].body.backlinks_status_type, 'lost');
    assert.equal('backlinks_filters' in calls[0].body, false);
    assert.equal(lost.json.data.result.lost_date, '2026-10-27 08:48:02 +00:00');
    assert.equal(lost.json.data.result.referring_links_attributes, null);
    failures.backlinks = envelope(REAL_BACKLINKS_DOFOLLOW);
    await call(url(projectA, 'backlinks', q({ dofollow: '1' })), { token: tokenA });
    assert.deepEqual(calls[1].body.backlinks_filters, ['dofollow', '=', true]);
    assert.equal(calls[1].body.backlinks_status_type, 'live');
    await call(url(projectA, 'backlinks', q({ status: 'all' })), { token: tokenA });
    assert.equal(calls.length, 3);
    // second time round: nothing is bought
    for (const params of [{ status: 'lost' }, { dofollow: '1' }, { status: 'all' }, {}]) {
      const r = await call(url(projectA, 'backlinks', q(params)), { token: tokenA });
      assert.equal(r.status, 200);
    }
    assert.equal(calls.length, 4, 'only the default view was new');
    assert.equal(await rows(), 4);
  });

  test('invalid values are a 400 before any provider call; the parameters are refused on every other section', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    for (const [params, field] of [[{ status: 'deleted' }, 'status'], [{ status: 'LIVE' }, 'status'], [{ dofollow: 'yes' }, 'dofollow']]) {
      const res = await call(url(projectA, 'backlinks', q(params)), { token: tokenA });
      assert.equal(res.status, 400, JSON.stringify(params));
      assert.equal(res.json.field, field);
    }
    for (const section of ['history', 'rank-overview', 'competitors', 'ranked-keywords']) {
      const res = await call(url(projectA, section, '?status=lost'), { token: tokenA });
      assert.equal(res.status, 400, section);
      assert.equal(res.json.field, 'query');
    }
    assert.equal(calls.length, 0, 'nothing was bought');
  });

  test('Lost / All / Dofollow requests have their own per-user limit; the default view is not counted', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    let last;
    for (let i = 0; i < BACKLINKS_QUERY_LIMIT.max + 1; i += 1) last = await call(url(projectA, 'backlinks', '?status=lost'), { token: tokenA });
    assert.equal(last.status, 429);
    assert.equal((await call(url(projectA, 'backlinks'), { token: tokenA })).status, 200, 'the dashboard cards still load');
  });
});

const qsOf = (pairs) => '?' + pairs.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

/** The same stubbed transport the suite installs in before(): every section recorded in `calls`, answered by `normal` or `failures`. */
function restoreTransport() {
  const transport = {};
  for (const section of SECTION_NAMES) {
    transport[section] = async (body) => {
      calls.push({ section, body });
      const failure = failures[section];
      if (failure instanceof Error) throw failure;
      return failure || normal[section](body);
    };
  }
  __setTransportForTests(transport);
}

describe('Backlinks list: one route and cache for the Backlinks page', () => {
  const list = (project, params = '', token = tokenA) => call(url(project, 'backlinks-list', params), { token });
  const listRows = () => DataForSeoCacheEntry.countDocuments({ target: domain, endpoint: 'backlinks/backlinks' });
  beforeEach(() => { listState.total = 2500; });

  test('the default view is one purchase; the same view written out and a repeat are cache hits; it echoes what was asked', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const first = await list(projectA);
    assert.equal(first.status, 200);
    assert.deepEqual(calls[0].body, { target: domain, include_subdomains: true, backlinks_status_type: 'live', mode: 'as_is', limit: 50, order_by: ['rank,desc'] });
    assert.equal(first.json.data.result.totalCount, 2500);
    assert.equal(first.json.data.result.items.length, 50);
    assert.equal(first.json.data.result.nextToken, 'T50');
    const again = await list(projectA, qsOf([['status', 'live'], ['mode', 'as_is'], ['limit', '50'], ['offset', '0'], ['order_by', 'rank,desc']]));
    assert.equal(again.json.data.cached, true);
    assert.equal(calls.length, 1);
    assert.equal(await listRows(), 1);
    assert.deepEqual(first.json.data.query, { status: 'live', mode: 'as_is', limit: 50, offset: 0, order_by: ['rank,desc'] });
  });

  test('tabs, group-by, sort, filters and a page offset reach the provider as validated; each distinct query is its own cached purchase', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    await list(projectA, qsOf([['status', 'lost']]));
    await list(projectA, qsOf([['filters', JSON.stringify(['is_new', '=', true])]]));
    await list(projectA, qsOf([['filters', JSON.stringify(['is_broken', '=', true])], ['order_by', 'domain_from_rank,desc']]));
    await list(projectA, qsOf([['mode', 'one_per_domain'], ['limit', '25'], ['offset', '50'], ['order_by', 'domain_from_rank,desc'], ['order_by', 'first_seen,asc']]));
    assert.equal(calls[0].body.backlinks_status_type, 'lost');
    assert.deepEqual(calls[1].body.filters, ['is_new', '=', true]);
    assert.deepEqual([calls[2].body.filters, calls[2].body.order_by], [['is_broken', '=', true], ['domain_from_rank,desc']]);
    assert.deepEqual([calls[3].body.mode, calls[3].body.limit, calls[3].body.offset, calls[3].body.order_by], ['one_per_domain', 25, 50, ['domain_from_rank,desc', 'first_seen,asc']]);
    await list(projectA, qsOf([['status', 'lost']])); // a second look at a tab it already loaded
    assert.equal(calls.length, 4);
    assert.equal(await listRows(), 4);
  });

  test('past 20,000 rows the page is fetched with the previous response token (and no offset), every other parameter identical', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    listState.total = 30000;
    const params = [['limit', '100'], ['order_by', 'rank,desc'], ['filters', JSON.stringify(['dofollow', '=', true])]];
    const last = await list(projectA, qsOf([...params, ['offset', '19900']]));
    assert.equal(last.status, 200);
    assert.equal(calls[0].body.offset, 19900);
    const token = last.json.data.result.nextToken;
    assert.equal(token, 'T20000');
    assert.equal((await list(projectA, qsOf([...params, ['offset', '20000']]))).status, 400, 'an offset past the window is refused');
    const more = await list(projectA, qsOf([...params, ['token', token]]));
    assert.equal(more.status, 200);
    assert.deepEqual([calls[1].body.search_after_token, 'offset' in calls[1].body, calls[1].body.limit, calls[1].body.filters, calls[1].body.order_by], ['T20000', false, 100, ['dofollow', '=', true], ['rank,desc']]);
    assert.equal(more.json.data.result.items[0].domain_from, 'src20000.example.com');
    assert.equal((await list(projectA, qsOf([...params, ['token', token], ['offset', '100']]))).status, 400, 'offset + token together is refused');
  });

  test('a filter that matches nothing is a successful empty page (total 0)', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    listState.total = 0;
    const res = await list(projectA);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.data.result, { totalCount: 0, nextToken: null, items: [] });
  });

  test('invalid values are a 400 before any provider call; parameters meant for other sections are refused, and the other way round', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const nine = Array.from({ length: 9 }, (_, i) => ['domain_from_rank', '>=', i + 1]).flatMap((c, i) => (i ? ['and', c] : [c]));
    for (const [pairs, field] of [
      [[['status', 'all']], 'status'], [[['mode', 'x']], 'mode'], [[['limit', '7']], 'limit'], [[['order_by', 'password,asc']], 'order_by'],
      [[['order_by', 'rank,desc'], ['order_by', 'first_seen,asc'], ['order_by', 'last_seen,asc'], ['order_by', 'page_from_rank,asc']], 'order_by'],
      [[['filters', JSON.stringify(['secret', '=', 1])]], 'filters'], [[['filters', JSON.stringify(nine)]], 'filters'], [[['limit', '50'], ['offset', '19951']], 'offset'],
    ]) {
      const res = await list(projectA, qsOf(pairs));
      assert.equal(res.status, 400, JSON.stringify(pairs));
      assert.equal(res.json.field, field, JSON.stringify(pairs));
    }
    assert.match((await list(projectA, qsOf([['filters', JSON.stringify(nine)]]))).json.message, /at most 8/);
    for (const [section, params] of [['history', '?mode=one_per_domain'], ['competitors', '?token=abc'], ['ranked-keywords', '?status=lost'], ['backlinks', '?mode=as_is']]) {
      const res = await call(url(projectA, section, params), { token: tokenA });
      assert.equal(res.status, 400, section);
      assert.equal(res.json.field, 'query');
    }
    assert.equal((await list(projectA, '?dofollow=1')).status, 400, 'the summary parameter does not apply to the list');
    assert.equal(calls.length, 0, 'nothing was bought');
  });

  test('login and ownership are required; a second user of the same public domain shares the cache entry; list requests have their own per-user limit', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    assert.equal((await call(url(projectA, 'backlinks-list'))).status, 401);
    assert.equal((await list(projectA, '', tokenB)).status, 403);
    await list(projectA);
    assert.equal((await list(projectB, '', tokenB)).json.data.cached, true, 'the same domain: the same entry, nothing bought twice');
    assert.equal(calls.length, 1);
    let last;
    for (let i = 0; i < BACKLINKS_LIST_LIMIT.max + 1; i += 1) last = await list(projectA);
    assert.equal(last.status, 429);
  });

  test('a provider failure is a code-only error and is not cached', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    failures['backlinks-list'] = Object.assign(new Error('Request failed'), { response: { status: 429 } });
    assert.equal((await list(projectA)).status, 429);
    delete failures['backlinks-list'];
    assert.equal((await list(projectA)).json.data.cached, false);
  });
});

describe('Backlinks export: streamed from the server, batch by batch', () => {
  const exportPath = (project, params = '') => `/${project._id}/backlinks-export${params}`;
  const get = async (project, params = '', token = tokenA) => {
    const res = await fetch(`${baseUrl}${exportPath(project, params)}`, { headers: { Authorization: `Bearer ${token}` } });
    // The BOM is kept (res.text() would strip it): Excel needs it to read the file as UTF-8.
    const text = await res.arrayBuffer().then((b) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(b)).catch(() => null);
    return { res, text };
  };
  beforeEach(() => { listState.total = 2500; });
  afterEach(() => { restoreTransport(); });

  test('2,500 matching links: three batches of 1,000 following each token, one CSV with the documented header and every row once', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const { res, text } = await get(projectA);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/csv/);
    assert.equal(res.headers.get('x-export-rows'), '2500');
    assert.equal(res.headers.get('x-export-batches'), '3');
    assert.match(res.headers.get('access-control-expose-headers'), /X-Export-Rows/);
    assert.ok(text.startsWith('﻿Source URL,Source title,Source domain,Domain rank,Page rank,Anchor,Item type,Target URL,Target status,Redirect target,Dofollow,Attributes,Placement,Spam score,Country,First seen,Last seen,New,Lost,Broken'));
    const lines = text.slice(1).trimEnd().split('\r\n');
    assert.equal(lines.length, 2501);
    assert.equal(new Set(lines.slice(1).map((l) => l.split(',')[0])).size, 2500, 'no row twice');
    assert.deepEqual(calls.map((c) => [c.body.limit, c.body.offset ?? null, c.body.search_after_token ?? null]), [[1000, null, null], [1000, null, 'T1000'], [1000, null, 'T2000']]);
  });

  test('the same tab / group / sort / filters as the page; the agreed row count caps it; exporting again is served from the cache', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const params = qsOf([['status', 'lost'], ['mode', 'one_per_domain'], ['order_by', 'first_seen,asc'], ['filters', JSON.stringify(['dofollow', '=', true])], ['max_rows', '1500']]);
    const first = await get(projectA, params);
    assert.equal(first.res.headers.get('x-export-rows'), '1500');
    assert.equal(first.text.slice(1).trimEnd().split('\r\n').length, 1501);
    assert.deepEqual([calls[0].body.backlinks_status_type, calls[0].body.mode, calls[0].body.order_by, calls[0].body.filters], ['lost', 'one_per_domain', ['first_seen,asc'], ['dofollow', '=', true]]);
    assert.equal(calls.length, 2, 'two batches for 1,500 rows');
    const second = await get(projectA, params);
    assert.equal(second.text, first.text);
    assert.equal(calls.length, 2, 'nothing was bought the second time');
  });

  test('never more than the cap, however many links match', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    listState.total = 50000;
    const { res, text } = await get(projectA);
    assert.equal(BACKLINKS_EXPORT.maxRows, 10000);
    assert.equal(res.headers.get('x-export-rows'), '10000');
    assert.equal(text.slice(1).trimEnd().split('\r\n').length, 10001);
    assert.equal(calls.length, 10, 'ten batches and no more');
    const huge = await get(projectA, qsOf([['max_rows', '999999']]));
    assert.equal(huge.res.headers.get('x-export-rows'), '10000');
  });

  test('nothing matches: a valid CSV with just the header', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    listState.total = 0;
    const { res, text } = await get(projectA);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-export-rows'), '0');
    assert.equal(text.slice(1).trimEnd().split('\r\n').length, 1);
  });

  test('cancelling stops the buying: the browser drops the request and no further batch is fetched', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    listState.total = 10000;
    __setTransportForTests({ 'backlinks-list': async (body) => { calls.push({ section: 'backlinks-list', body }); await new Promise((r) => setTimeout(r, 120)); return normal['backlinks-list'](body); } });
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}${exportPath(projectA)}`, { headers: { Authorization: `Bearer ${tokenA}` }, signal: controller.signal });
    const reader = res.body.getReader();
    await reader.read(); // the file has started: batch 1 is in
    controller.abort();
    await new Promise((r) => setTimeout(r, 700));
    const seen = calls.length;
    assert.ok(seen < 10, `stopped early (${seen} of 10 batches)`);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(calls.length, seen, 'and stays stopped');
  });

  test('a failure after the file has started drops the connection (no truncated file that looks complete); a failure before it is a normal error', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    let n = 0;
    __setTransportForTests({ 'backlinks-list': async (body) => { n += 1; if (n === 2) throw Object.assign(new Error('boom'), { response: { status: 502 } }); return normal['backlinks-list'](body); } });
    const mid = await get(projectA);
    assert.equal(mid.text, null, 'the body never completed');
    restoreTransport();
    __resetInFlightForTests();
    failures['backlinks-list'] = Object.assign(new Error('Request failed'), { response: { status: 429 } });
    const early = await get(projectA, qsOf([['status', 'lost']]));
    assert.equal(early.res.status, 429);
    assert.equal(JSON.parse(early.text).code, 'PROVIDER_RATE_LIMITED');
  });

  test('the export is not a back door: no limit / offset / token, valid status and filters only, a sane row count', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    for (const pairs of [[['limit', '5']], [['offset', '5']], [['token', 'abc']], [['status', 'all']], [['filters', JSON.stringify(['secret', '=', 1])]]]) {
      assert.equal((await get(projectA, qsOf(pairs))).res.status, 400, JSON.stringify(pairs));
    }
    assert.equal(calls.length, 0, 'nothing was bought');
  });

  test('login and ownership are required, bad row counts are refused, and the export has its own small per-user limit (invalid requests count too)', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    assert.equal((await fetch(`${baseUrl}${exportPath(projectA)}`)).status, 401);
    assert.equal((await get(projectA, '', tokenB)).res.status, 403);
    assert.equal((await get(projectA, qsOf([['max_rows', '0']]))).res.status, 400);
    assert.equal((await get(projectA, qsOf([['max_rows', 'x']]))).res.status, 400);
    assert.equal(calls.length, 0);
    let last;
    for (let i = 0; i < 6; i += 1) last = await get(projectA, qsOf([['max_rows', '1']]));
    assert.equal(last.res.status, 429);
  });
});

describe('Anchors: one route and cache for the Anchors page; the profile is one fixed 7-day purchase', () => {
  const anchors = (project, params = '', token = tokenA) => call(url(project, 'anchors', params), { token });
  const profile = (project, params = '', token = tokenA) => call(url(project, 'anchor-profile', params), { token });
  const rows = (endpoint) => DataForSeoCacheEntry.countDocuments({ target: domain, endpoint });
  beforeEach(() => { anchorState.total = 1004; });

  test('the default view is one purchase; the same view written out is a cache hit; it echoes what was asked and has no market', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const first = await anchors(projectA);
    assert.equal(first.status, 200);
    assert.deepEqual(calls[0].body, { target: domain, include_subdomains: true, backlinks_status_type: 'live', internal_list_limit: 10, limit: 50, order_by: ['referring_domains,desc'] });
    assert.equal(first.json.data.result.totalCount, 1004);
    assert.equal(first.json.data.result.items.length, 50);
    assert.deepEqual(first.json.data.query, { status: 'live', limit: 50, offset: 0, order_by: 'referring_domains,desc', internal_list_limit: 10 });
    assert.equal(first.json.data.ttlSeconds, 24 * 3600);
    const again = await anchors(projectA, qsOf([['status', 'live'], ['limit', '50'], ['offset', '0'], ['order_by', 'referring_domains,desc']]));
    assert.equal(again.json.data.cached, true);
    assert.equal(calls.length, 1);
    assert.equal(await rows('backlinks/anchors'), 1);
    // The provider's answer is about the domain, not a market: another user's project on the same domain shares it, even with another country.
    await SeoProject.updateOne({ _id: projectB._id }, { $set: { country: 'GB', language: 'hi' } });
    assert.equal((await anchors(projectB, '', tokenB)).json.data.cached, true);
    assert.equal(calls.length, 1);
  });

  test('status, page, sort and filters reach the provider as validated; each distinct query is its own cached purchase', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    await anchors(projectA, qsOf([['status', 'lost']]));
    await anchors(projectA, qsOf([['status', 'all'], ['limit', '25'], ['offset', '25'], ['order_by', 'backlinks,asc']]));
    await anchors(projectA, qsOf([['filters', JSON.stringify([['anchor', 'like', '%lasik%'], 'and', ['broken_backlinks', '>', 0]])]]));
    assert.equal(calls[0].body.backlinks_status_type, 'lost');
    assert.deepEqual([calls[1].body.backlinks_status_type, calls[1].body.limit, calls[1].body.offset, calls[1].body.order_by], ['all', 25, 25, ['backlinks,asc']]);
    assert.deepEqual(calls[2].body.filters, [['anchor', 'like', '%lasik%'], 'and', ['broken_backlinks', '>', 0]]);
    await anchors(projectA, qsOf([['status', 'lost']]));
    assert.equal(calls.length, 3);
    assert.equal(await rows('backlinks/anchors'), 3);
  });

  test('the profile is the fixed top-1,000 request, cached for 7 days under its own name; parameters are refused', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    anchorState.total = 1004;
    const res = await profile(projectA);
    assert.equal(res.status, 200);
    assert.deepEqual(calls[0].body, { target: domain, include_subdomains: true, backlinks_status_type: 'live', internal_list_limit: 1, limit: 1000, order_by: ['referring_domains,desc'] });
    assert.equal(res.json.data.ttlSeconds, 7 * 24 * 3600);
    assert.equal(res.json.data.result.items.length, 1000);
    assert.equal(res.json.data.result.totalCount, 1004);
    assert.equal('referring_links_countries' in res.json.data.result.items[0], false, 'no breakdowns are cached');
    assert.equal((await profile(projectA)).json.data.cached, true);
    assert.equal(calls.length, 1);
    assert.equal(await rows('backlinks/anchors/profile'), 1);
    assert.equal(await rows('backlinks/anchors'), 0, 'the table and the profile never share an entry');
    for (const params of ['?limit=5', '?status=all', '?order_by=backlinks,asc', `?filters=${encodeURIComponent('["backlinks",">=",1]')}`]) {
      assert.equal((await profile(projectA, params)).status, 400, params);
    }
    assert.equal(calls.length, 1);
  });

  test('refresh is held back inside the one-minute floor', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    await anchors(projectA);
    const early = await anchors(projectA, '?refresh=1');
    assert.equal(early.json.data.refreshThrottled, true);
    assert.equal(calls.length, 1);
  });

  test('invalid values are a 400 before any provider call, and other sections\' parameters are refused', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    for (const params of [
      '?status=new', '?limit=1000', '?limit=10', '?offset=-1', '?offset=19951&limit=50', '?order_by=referring_pages,desc', '?order_by=backlinks',
      `?filters=${encodeURIComponent('["anchor","<>","x"]')}`, `?filters=${encodeURIComponent('["first_seen",">=","2025-13-40"]')}`, '?filters=zzz',
      '?mode=one_per_domain', '?token=abc', '?targets=a.com', '?dofollow=1', '?months=6',
    ]) assert.equal((await anchors(projectA, params)).status, 400, params);
    const nine = Array.from({ length: 9 }, (_, i) => ['referring_domains', '>=', i + 1]).flatMap((c, i) => (i ? ['and', c] : [c]));
    const tooMany = await anchors(projectA, qsOf([['filters', JSON.stringify(nine)]]));
    assert.equal(tooMany.status, 400);
    assert.match(tooMany.json.message, /at most 8 filter conditions/);
    assert.equal(calls.length, 0, 'nothing was bought');
  });

  test('anchors parameters on the other sections are refused too', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    for (const section of ['backlinks', 'rank-overview', 'history']) {
      assert.equal((await call(url(projectA, section, '?order_by=backlinks,desc'), { token: tokenA })).status, 400, section);
    }
    assert.equal(calls.length, 0);
  });

  test('login and ownership are required', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    assert.equal((await call(url(projectA, 'anchors'))).status, 401);
    assert.equal((await anchors(projectA, '', tokenB)).status, 403);
    assert.equal((await profile(projectA, '', tokenB)).status, 403);
    assert.equal(calls.length, 0);
  });

  test('a domain with no anchors is a successful empty page (total 0)', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    anchorState.total = 0;
    const res = await anchors(projectA);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.data.result, { totalCount: 0, items: [] });
  });

  test('a provider failure is a plain error and is not cached', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    failures.anchors = Object.assign(new Error('Request failed'), { response: { status: 429 } });
    const bad = await anchors(projectA);
    assert.equal(bad.status, 429);
    assert.equal(bad.json.code, 'PROVIDER_RATE_LIMITED');
    assert.equal(await rows('backlinks/anchors'), 0);
  });

  test('the Backlinks list takes an exact anchor, and an empty one', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const list = (filters) => call(url(projectA, 'backlinks-list', qsOf([['filters', JSON.stringify(filters)]])), { token: tokenA });
    assert.equal((await list(['anchor', '=', 'ASG Eye Hospital'])).status, 200);
    assert.equal((await list(['anchor', '=', ''])).status, 200);
    assert.deepEqual(calls.map((c) => c.body.filters), [['anchor', '=', 'ASG Eye Hospital'], ['anchor', '=', '']]);
    assert.equal((await list(['anchor', '<>', 'x'])).status, 400);
  });
});

describe('Anchor settings: brand terms + target keywords saved on the project', () => {
  const path = (project) => `/${project._id}/anchor-settings`;
  const put = (project, body, token = tokenA) => call(path(project), { token, method: 'PUT', body });

  test('a project that never saved says so; login and ownership are required', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const res = await call(path(projectA), { token: tokenA });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.data, { saved: false, brand_terms: [], target_keywords: [], saved_at: null, limits: { brand_terms: 20, target_keywords: 100, term_length: 80 } });
    assert.equal((await call(path(projectA))).status, 401);
    assert.equal((await call(path(projectA), { token: tokenB })).status, 403);
    assert.equal((await put(projectA, { brand_terms: ['x'], target_keywords: [] }, tokenB)).status, 403);
  });

  test('saving cleans the terms, replaces both lists, is per project, and can save empty lists', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const saved = await put(projectA, { brand_terms: ['  ASG ', 'asg   Eye Hospital', 'asg'], target_keywords: ['Lasik Surgery', 'cataract surgery cost'] });
    assert.equal(saved.status, 200);
    assert.deepEqual([saved.json.data.saved, saved.json.data.brand_terms, saved.json.data.target_keywords], [true, ['asg', 'asg eye hospital'], ['lasik surgery', 'cataract surgery cost']]);
    assert.match(saved.json.data.saved_at, /^\d{4}-\d{2}-\d{2}T/);
    const read = await call(path(projectA), { token: tokenA });
    assert.deepEqual(read.json.data.brand_terms, ['asg', 'asg eye hospital']);
    assert.equal((await call(path(projectB), { token: tokenB })).json.data.saved, false, 'per project');
    const replaced = await put(projectA, { brand_terms: ['only'], target_keywords: [] });
    assert.deepEqual([replaced.json.data.brand_terms, replaced.json.data.target_keywords, replaced.json.data.saved], [['only'], [], true]);
    const cleared = await put(projectA, { brand_terms: [], target_keywords: [] });
    assert.deepEqual([cleared.json.data.brand_terms, cleared.json.data.saved], [[], true], 'emptying the lists is a choice, not "never saved"');
  });

  test('select:false: a project read does not carry the settings', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    await put(projectA, { brand_terms: ['asg'], target_keywords: ['lasik'] });
    const plain = await SeoProject.findById(projectA._id).lean();
    assert.deepEqual([plain.anchor_brand_terms, plain.anchor_target_keywords, plain.anchor_settings_saved_at], [undefined, undefined, undefined]);
    const withThem = await SeoProject.findById(projectA._id).select('+anchor_brand_terms +anchor_target_keywords').lean();
    assert.deepEqual([withThem.anchor_brand_terms, withThem.anchor_target_keywords], [['asg'], ['lasik']]);
  });

  test('invalid bodies are a 400 and nothing is half-saved', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    await put(projectA, { brand_terms: ['keep'], target_keywords: ['keep too'] });
    for (const body of [{}, { brand_terms: ['a'] }, { brand_terms: 'a', target_keywords: [] }, { brand_terms: [1], target_keywords: [] }, { brand_terms: ['x'.repeat(81)], target_keywords: [] },
      { brand_terms: Array.from({ length: 21 }, (_, i) => `t${i}`), target_keywords: [] }, { brand_terms: [], target_keywords: Array.from({ length: 101 }, (_, i) => `k${i}`) }, { brand_terms: ['ok'], target_keywords: [null] }]) {
      assert.equal((await put(projectA, body)).status, 400, JSON.stringify(body).slice(0, 60));
    }
    const read = (await call(path(projectA), { token: tokenA })).json.data;
    assert.deepEqual([read.brand_terms, read.target_keywords], [['keep'], ['keep too']]);
  });
});

describe('Referring domains: one route and cache for the page; two profile-level count cards', () => {
  const rd = (project, params = '', token = tokenA) => call(url(project, 'referring-domains', params), { token });
  const buckets = (project, params = '', token = tokenA) => call(url(project, 'rd-rank-buckets', params), { token });
  const toxic = (project, params = '', token = tokenA) => call(url(project, 'rd-toxic-count', params), { token });
  const rows = (endpoint) => DataForSeoCacheEntry.countDocuments({ target: domain, endpoint });
  beforeEach(() => { rdState.total = 3958; __resetProviderBudgetForTests(); });

  test('the default view is one purchase; the same view written out is a cache hit; it echoes what was asked and has no market', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const first = await rd(projectA);
    assert.equal(first.status, 200);
    assert.deepEqual(calls[0].body, { target: domain, include_subdomains: true, backlinks_status_type: 'live', internal_list_limit: 10, limit: 50, order_by: ['rank,desc'] });
    assert.equal(first.json.data.result.totalCount, 3958);
    assert.equal(first.json.data.result.items.length, 50);
    assert.deepEqual(first.json.data.query, { status: 'live', dofollow: false, limit: 50, offset: 0, order_by: 'rank,desc', internal_list_limit: 10 });
    assert.equal(first.json.data.ttlSeconds, 24 * 3600);
    const again = await rd(projectA, qsOf([['status', 'live'], ['dofollow', '0'], ['limit', '50'], ['offset', '0'], ['order_by', 'rank,desc']]));
    assert.equal(again.json.data.cached, true);
    assert.equal(calls.length, 1);
    assert.equal(await rows('backlinks/referring_domains'), 1);
    // The answer is about the domain, not a market: another user's project on the same domain, in another country, shares it.
    await SeoProject.updateOne({ _id: projectB._id }, { $set: { country: 'GB', language: 'hi' } });
    assert.equal((await rd(projectB, '', tokenB)).json.data.cached, true);
    assert.equal(calls.length, 1);
  });

  test('every row carries the quality the SERVER decided, and the derived values', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const { items } = (await rd(projectA)).json.data.result;
    const v = items[0];
    assert.equal(v.domain, 'vasaneye.com');
    assert.deepEqual([v.quality, v.is_sitewide, v.top_country, v.main_placement, v.dofollow_pct], ['medium', true, 'IN', 'footer', 100]);
    for (const r of items) assert.ok(['high', 'medium', 'low', 'toxic'].includes(r.quality), r.domain);
  });

  test('status, dofollow-only, page, sort and filters reach the provider as validated; "dofollow" is backlinks_filters, never a filter, and a different purchase', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    await rd(projectA, qsOf([['status', 'lost']]));
    await rd(projectA, qsOf([['dofollow', '1']]));
    await rd(projectA, qsOf([['limit', '25'], ['offset', '25'], ['order_by', 'referring_pages,asc'], ['filters', JSON.stringify([['rank', '>=', 100], 'and', ['broken_backlinks', '>', 0]])]]));
    assert.equal(calls[0].body.backlinks_status_type, 'lost');
    assert.deepEqual(calls[1].body.backlinks_filters, ['dofollow', '=', true]);
    assert.equal('filters' in calls[1].body, false);
    assert.deepEqual([calls[2].body.limit, calls[2].body.offset, calls[2].body.order_by], [25, 25, ['referring_pages,asc']]);
    assert.deepEqual(calls[2].body.filters, [['broken_backlinks', '>', 0], 'and', ['rank', '>=', 100]]);
    assert.equal('backlinks_filters' in calls[2].body, false);
    await rd(projectA, qsOf([['status', 'lost']]));
    assert.equal(calls.length, 3);
    assert.equal(await rows('backlinks/referring_domains'), 3);
  });

  test('the Disavowed tab: its slice is one request with domain "in" (any order is one cache entry)', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const f1 = JSON.stringify(['domain', 'in', ['b.com', 'a.com']]);
    const f2 = JSON.stringify(['domain', 'in', ['a.com', 'b.com']]);
    const res = await rd(projectA, qsOf([['filters', f1]]));
    assert.equal(res.status, 200);
    assert.deepEqual(calls[0].body.filters, ['domain', 'in', ['a.com', 'b.com']]);
    assert.equal((await rd(projectA, qsOf([['filters', f2]]))).json.data.cached, true);
    assert.equal(calls.length, 1);
  });

  test('invalid values are a 400 before any provider call, and other sections\' parameters are refused', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    for (const params of [
      '?status=all', '?dofollow=yes', '?limit=10', '?offset=19951&limit=50', '?order_by=domain,asc', '?order_by=rank', '?filters=zzz',
      `?filters=${encodeURIComponent('["domain","=","a.com"]')}`, `?filters=${encodeURIComponent('["rank",">=",5000]')}`, `?filters=${encodeURIComponent('["domain","in",["NOT A DOMAIN"]]')}`,
      '?mode=one_per_domain', '?token=abc', '?targets=a.com', '?months=6',
    ]) assert.equal((await rd(projectA, params)).status, 400, params);
    const nine = Array.from({ length: 9 }, (_, i) => ['backlinks', '>=', i + 1]).flatMap((c, i) => (i ? ['and', c] : [c]));
    const tooMany = await rd(projectA, qsOf([['filters', JSON.stringify(nine)]]));
    assert.equal(tooMany.status, 400);
    assert.match(tooMany.json.message, /at most 8 filter conditions/);
    assert.equal(calls.length, 0, 'nothing was bought');
  });

  test('login and ownership are required', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    for (const section of ['referring-domains', 'rd-rank-buckets', 'rd-toxic-count']) {
      assert.equal((await call(url(projectA, section))).status, 401, section);
      assert.equal((await call(url(projectA, section), { token: tokenB })).status, 403, section);
    }
    assert.equal(calls.length, 0);
  });

  test('a domain with no referring domains is a successful empty page', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    rdState.total = 0;
    const res = await rd(projectA);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.data.result, { totalCount: 0, items: [] });
  });

  test('a provider failure is a plain error and is not cached', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    failures['referring-domains'] = Object.assign(new Error('Request failed'), { response: { status: 429 } });
    const bad = await rd(projectA);
    assert.equal(bad.status, 429);
    assert.equal(bad.json.code, 'PROVIDER_RATE_LIMITED');
    assert.equal(await rows('backlinks/referring_domains'), 0);
  });

  test('RANK BUCKETS: five count-only calls (live, limit 1, one rank range each), cached together for 7 days', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const res = await buckets(projectA);
    assert.equal(res.status, 200);
    assert.equal(calls.length, 5);
    assert.deepEqual(calls.map((c) => c.body.filters), [
      [['rank', '>=', 0], 'and', ['rank', '<=', 99]], [['rank', '>=', 100], 'and', ['rank', '<=', 199]], [['rank', '>=', 200], 'and', ['rank', '<=', 299]],
      [['rank', '>=', 300], 'and', ['rank', '<=', 499]], ['rank', '>=', 500],
    ]);
    for (const c of calls) assert.deepEqual([c.body.limit, c.body.backlinks_status_type, 'backlinks_filters' in c.body], [1, 'live', false]);
    assert.deepEqual(res.json.data.result.buckets.map((b) => [b.key, b.count]), [['0-99', 2000], ['100-199', 118], ['200-299', 40], ['300-499', 8], ['500+', 1]]);
    assert.equal(res.json.data.ttlSeconds, 7 * 24 * 3600);
    assert.equal((await buckets(projectA)).json.data.cached, true);
    assert.equal(calls.length, 5, 'the repeat bought nothing');
    assert.equal(await rows('backlinks/referring_domains/rank-buckets'), 1);
    assert.equal(await rows('backlinks/referring_domains'), 0, 'never shares the table\'s entries');
  });

  test('RANK BUCKETS are PROFILE-LEVEL: no parameter can change them (the Dofollow toggle and the table filters are refused, not applied)', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    for (const params of ['?dofollow=1', '?status=lost', `?filters=${encodeURIComponent('["rank",">=",5]')}`, '?limit=5', '?order_by=rank,asc']) {
      assert.equal((await buckets(projectA, params)).status, 400, params);
      assert.equal((await toxic(projectA, params)).status, 400, params);
    }
    assert.equal(calls.length, 0);
  });

  test('RANK BUCKETS: one failing call fails the card (a distribution with a missing bar would be a wrong picture) and nothing is cached', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    let n = 0;
    failures['rd-rank-buckets'] = undefined;
    __setTransportForTests({ 'rd-rank-buckets': async (body) => { calls.push({ section: 'rd-rank-buckets', body }); n += 1; if (n === 3) throw Object.assign(new Error('x'), { response: { status: 500 } }); return normal['rd-rank-buckets'](body); } });
    try {
      const res = await buckets(projectA);
      assert.equal(res.status, 502);
      assert.equal(await rows('backlinks/referring_domains/rank-buckets'), 0);
    } finally {
      restoreTransport();
    }
  });

  test('TOXIC COUNT: one count-only call (live, limit 1, spam above 30), cached 7 days', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const res = await toxic(projectA);
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body.filters, ['backlinks_spam_score', '>', 30]);
    assert.deepEqual([calls[0].body.limit, calls[0].body.backlinks_status_type, 'backlinks_filters' in calls[0].body], [1, 'live', false]);
    assert.deepEqual(res.json.data.result, { count: 3002, spamAbove: 30 });
    assert.equal(res.json.data.ttlSeconds, 7 * 24 * 3600);
    assert.equal((await toxic(projectA)).json.data.cached, true);
    assert.equal(calls.length, 1);
  });

  test('the count cards: CACHE HITS never use the user\'s budget of real provider calls', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    await buckets(projectA);
    await toxic(projectA);
    for (let i = 0; i < 30; i += 1) {
      assert.equal((await buckets(projectA)).status, 200, `bucket hit ${i}`);
      assert.equal((await toxic(projectA)).status, 200, `toxic hit ${i}`);
    }
    assert.equal(calls.length, 6);
    // ...so the budget (20 real calls) is still untouched: three more domains' worth of buckets still fit (15 + the 6 above = 21 would not).
    for (let i = 0; i < 2; i += 1) {
      await SeoProject.updateOne({ _id: projectA._id }, { $set: { main_url: `https://fresh${i}.${domain}` } });
      assert.equal((await buckets(projectA)).status, 200);
    }
  });

  test('the count cards: only REAL provider calls count — the budget runs out, then a refused request buys nothing, and cached cards still answer', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const results = [];
    for (let i = 0; i < 4; i += 1) {
      await SeoProject.updateOne({ _id: projectA._id }, { $set: { main_url: `https://budget${i}.${domain}` } });
      results.push((await buckets(projectA)).status); // 5 real calls each: 20 in all
    }
    assert.deepEqual(results, [200, 200, 200, 200]);
    assert.equal(calls.length, 20);
    await SeoProject.updateOne({ _id: projectA._id }, { $set: { main_url: `https://budget4.${domain}` } });
    const over = await buckets(projectA);
    assert.equal(over.status, 429);
    assert.equal(over.json.code, 'RATE_LIMITED');
    assert.equal(calls.length, 20, 'a refused request bought nothing');
    assert.equal((await toxic(projectA)).status, 429, 'a toxic count is a real call too');
    // A card that is already cached is free even with the budget gone.
    await SeoProject.updateOne({ _id: projectA._id }, { $set: { main_url: `https://budget0.${domain}` } });
    const hit = await buckets(projectA);
    assert.equal(hit.status, 200);
    assert.equal(hit.json.data.cached, true);
    // Another user has a budget of their own.
    assert.equal((await buckets(projectB, '', tokenB)).status, 200);
  });
});

describe('Referring domain lists: disavowed + reviewed, saved on the project', () => {
  const path = (project) => `/${project._id}/referring-domain-settings`;
  const patch = (project, body, token = tokenA) => call(path(project), { token, method: 'PATCH', body });
  const get = (project, token = tokenA) => call(path(project), { token });
  beforeEach(() => { rdState.total = 3958; __resetProviderBudgetForTests(); });

  test('starts empty and says what the limits are; login and ownership are required', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const res = await get(projectA);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.data, { disavowed: [], reviewed: [], limits: { perList: 10000, perChange: 1000 } });
    assert.equal((await call(path(projectA))).status, 401);
    assert.equal((await get(projectA, tokenB)).status, 403);
    assert.equal((await patch(projectA, { disavowed: { add: ['spam.com'] } }, tokenB)).status, 403);
    assert.equal((await call(path(projectA), { method: 'PATCH', body: { disavowed: { add: ['spam.com'] } } })).status, 401);
  });

  test('disavowing (one or many) cleans and de-duplicates the domains, keeps the order added, and is per project', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const one = await patch(projectA, { disavowed: { add: [' HTTPS://www.Spam.com/path?x=1 '] } });
    assert.deepEqual(one.json.data.disavowed, ['spam.com']);
    const many = await patch(projectA, { disavowed: { add: ['Other.org', 'spam.com', 'other.org', 'third.net'] } });
    assert.deepEqual(many.json.data.disavowed, ['spam.com', 'other.org', 'third.net']);
    assert.deepEqual((await get(projectA)).json.data.disavowed, ['spam.com', 'other.org', 'third.net']);
    assert.deepEqual((await get(projectB, tokenB)).json.data.disavowed, [], 'per project');
  });

  test('marking OK, removing, and the two lists never sharing a domain', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    await patch(projectA, { disavowed: { add: ['a.com', 'b.com'] } });
    const ok = await patch(projectA, { reviewed: { add: ['b.com', 'c.com'] } });
    assert.deepEqual([ok.json.data.disavowed, ok.json.data.reviewed], [['a.com'], ['b.com', 'c.com']], 'marking b.com OK took it out of the disavow list');
    const back = await patch(projectA, { disavowed: { add: ['c.com'] } });
    assert.deepEqual([back.json.data.disavowed, back.json.data.reviewed], [['a.com', 'c.com'], ['b.com']], 'disavowing c.com took it out of the reviewed list');
    const removed = await patch(projectA, { disavowed: { remove: ['a.com', 'never-added.com'] }, reviewed: { remove: ['b.com'] } });
    assert.deepEqual([removed.json.data.disavowed, removed.json.data.reviewed], [['c.com'], []]);
    assert.equal((await patch(projectA, { disavowed: { remove: ['c.com'] } })).status, 200);
  });

  test('an invalid domain is a 400 and NOTHING of the change is saved; so are contradictions and the project\'s own domain', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    await patch(projectA, { disavowed: { add: ['keep.com'] } });
    for (const body of [
      { disavowed: { add: ['ok.com', 'not a domain'] } }, { reviewed: { add: ['localhost'] } }, { disavowed: { add: [42] } }, { disavowed: { add: 'a.com' } },
      {}, { disavowed: {} }, { disavowed: { add: ['a.com'] }, reviewed: { add: ['a.com'] } }, { disavowed: { add: ['a.com'], remove: ['a.com'] } },
      { disavowed: { add: [domain] } }, { reviewed: { add: [`www.${domain}`] } },
      { disavowed: { add: Array.from({ length: 1001 }, (_, i) => `d${i}.com`) } },
    ]) {
      const res = await patch(projectA, body);
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
    }
    assert.deepEqual((await get(projectA)).json.data, { disavowed: ['keep.com'], reviewed: [], limits: { perList: 10000, perChange: 1000 } });
  });

  test('a list is capped at 10,000: past it the change is refused (409) and nothing is half-applied', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    await SeoProject.updateOne({ _id: projectA._id }, { $set: { disavowed_domains: Array.from({ length: 9999 }, (_, i) => `full${i}.com`) } });
    const over = await patch(projectA, { disavowed: { add: ['one.com', 'two.com'] } });
    assert.equal(over.status, 409);
    assert.equal(over.json.code, 'LIST_LIMIT_REACHED');
    assert.equal((await get(projectA)).json.data.disavowed.length, 9999);
    assert.equal((await patch(projectA, { disavowed: { add: ['one.com'] } })).status, 200);
    assert.equal((await get(projectA)).json.data.disavowed.length, 10000);
    assert.equal((await patch(projectA, { disavowed: { add: ['one.com'] } })).status, 200, 'adding what is already there is fine at the cap');
  });

  test('two changes at once cannot duplicate a domain', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    await Promise.all(Array.from({ length: 6 }, () => patch(projectA, { disavowed: { add: ['same.com', 'other.com'] } })));
    assert.deepEqual([...(await get(projectA)).json.data.disavowed].sort(), ['other.com', 'same.com']);
  });

  test('select:false — a bare project read never carries the lists, but EVERY path that needs them gets them (a missing .select() fails here)', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    await patch(projectA, { disavowed: { add: ['spam.com'] }, reviewed: { add: ['fine.com'] } });
    const plain = await SeoProject.findById(projectA._id).lean();
    assert.deepEqual([plain.disavowed_domains, plain.reviewed_domains], [undefined, undefined]);
    const explicit = await SeoProject.findById(projectA._id).select('+disavowed_domains +reviewed_domains').lean();
    assert.deepEqual([explicit.disavowed_domains, explicit.reviewed_domains], [['spam.com'], ['fine.com']]);
    // the settings endpoint
    assert.deepEqual(((await get(projectA)).json.data), { disavowed: ['spam.com'], reviewed: ['fine.com'], limits: { perList: 10000, perChange: 1000 } });
    // the change itself works on the stored lists (a read without the select would see empty lists and lose the old entries)
    const next = await patch(projectA, { disavowed: { add: ['more.com'] } });
    assert.deepEqual(next.json.data.disavowed, ['spam.com', 'more.com']);
    assert.deepEqual(next.json.data.reviewed, ['fine.com']);
  });

  test('disavowing and marking OK buy NOTHING from the data provider', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    await patch(projectA, { disavowed: { add: ['spam.com', 'x.com'] } });
    await patch(projectA, { reviewed: { add: ['y.com'] } });
    await patch(projectA, { disavowed: { remove: ['x.com'] } });
    await get(projectA);
    assert.equal(calls.length, 0);
  });
});

describe('Referring domains export: streamed from the server, batch by batch', () => {
  const exportPath = (project) => `/${project._id}/referring-domains-export`;
  const get = async (project, params = '', token = tokenA) => {
    const res = await fetch(`${baseUrl}${exportPath(project)}${params}`, { headers: { Authorization: `Bearer ${token}` } });
    const text = res.headers.get('content-type')?.includes('csv') ? new TextDecoder('utf-8', { ignoreBOM: true }).decode(await res.arrayBuffer()) : await res.text();
    return { res, text };
  };
  const records = (text) => { let inQ = false; let n = 0; for (const ch of text) { if (ch === '"') inQ = !inQ; else if (ch === '\n' && !inQ) n += 1; } return n; };
  beforeEach(() => { rdState.total = 2500; __resetProviderBudgetForTests(); });

  test('the whole view: batches of 1,000 by offset, one header, every row, the headers say how many', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const { res, text } = await get(projectA, qsOf([['order_by', 'backlinks,desc'], ['dofollow', '1']]));
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/csv/);
    assert.equal(res.headers.get('x-export-rows'), '2500');
    assert.equal(res.headers.get('x-export-batches'), '3');
    assert.equal(text.charCodeAt(0), 0xfeff, 'a BOM so Excel reads UTF-8');
    assert.equal(records(text), 2501);
    assert.equal(text.split('\r\n')[0], '﻿Domain,Quality,Rank,Backlinks,Referring pages,Dofollow %,Spam score,Placement,Top country,Broken backlinks,First seen,Lost date,Disavowed');
    assert.deepEqual(calls.map((c) => [c.body.limit, c.body.offset ?? 0]), [[1000, 0], [1000, 1000], [1000, 2000]]);
    assert.ok(calls.every((c) => c.body.order_by[0] === 'backlinks,desc' && c.body.backlinks_filters?.[0] === 'dofollow'));
  });

  test('the cap: never more than 10,000 rows, and never more than the user agreed to', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    rdState.total = 50000;
    const capped = await get(projectA);
    assert.equal(capped.res.headers.get('x-export-rows'), String(REFERRING_DOMAINS_EXPORT.maxRows));
    assert.equal(records(capped.text), 10001);
    assert.equal(calls.length, 10);
    calls.length = 0;
    const some = await get(projectA, qsOf([['max_rows', '1500']]));
    assert.equal(some.res.headers.get('x-export-rows'), '1500');
    assert.equal(records(some.text), 1501);
    assert.ok(calls.length <= 2);
    const huge = await get(projectA, qsOf([['max_rows', '999999']]));
    assert.equal(huge.res.headers.get('x-export-rows'), String(REFERRING_DOMAINS_EXPORT.maxRows));
  });

  test('the Disavowed column comes from the project\'s saved list (read with an explicit select — it is select:false)', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    await call(`/${projectA._id}/referring-domain-settings`, { token: tokenA, method: 'PATCH', body: { disavowed: { add: ['vasaneye.com', 'net-pals.com'] } } });
    const { text } = await get(projectA);
    const lines = text.split('\r\n');
    assert.match(lines.find((l) => l.startsWith('vasaneye.com,')), /,yes$/);
    assert.match(lines.find((l) => l.startsWith('net-pals.com,')), /,yes$/);
    assert.match(lines.find((l) => l.startsWith('usama.dev,')), /,no$/);
    assert.equal(lines.filter((l) => l.endsWith(',yes')).length, 2);
  });

  test('a provider failure on the first batch is an ordinary JSON error, before the file starts', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    failures['referring-domains'] = Object.assign(new Error('Request failed'), { response: { status: 429 } });
    const { res, text } = await get(projectA);
    assert.equal(res.status, 429);
    assert.equal(JSON.parse(text).code, 'PROVIDER_RATE_LIMITED');
  });

  test('a failure AFTER the file has started drops the connection: a partial file is never taken for a complete one', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    __setTransportForTests({ 'referring-domains': async (body) => { calls.push({ section: 'referring-domains', body }); if ((body.offset ?? 0) >= 1000) throw Object.assign(new Error('boom'), { response: { status: 500 } }); return normal['referring-domains'](body); } });
    try {
      await assert.rejects(async () => { const res = await fetch(`${baseUrl}${exportPath(projectA)}`, { headers: { Authorization: `Bearer ${tokenA}` } }); await res.arrayBuffer(); });
    } finally {
      restoreTransport();
    }
  });

  test('the export is not a back door: no limit / offset / token, valid status and filters only, a sane row count', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    for (const pairs of [[['limit', '5']], [['offset', '5']], [['token', 'abc']], [['status', 'all']], [['filters', JSON.stringify(['secret', '=', 1])]], [['max_rows', '0']]]) {
      assert.equal((await get(projectA, qsOf(pairs))).res.status, 400, JSON.stringify(pairs));
    }
    assert.equal(calls.length, 0, 'nothing was bought');
  });

  test('login and ownership are required, and the export has its own small per-user limit', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    assert.equal((await fetch(`${baseUrl}${exportPath(projectA)}`)).status, 401);
    assert.equal((await get(projectA, '', tokenB)).res.status, 403);
    assert.equal((await get(projectA, qsOf([['max_rows', 'x']]))).res.status, 400);
    let last;
    for (let i = 0; i < 6; i += 1) last = await get(projectA, qsOf([['max_rows', '1']])); // 1 + 6 requests: the limit is 6 per window, invalid ones count
    assert.equal(last.res.status, 429);
  });
});

describe('Top pages: one route and cache for the page, the traffic joined from Organic Keywords, three profile-level pieces', () => {
  const pages = (project, params = '', token = tokenA) => call(url(project, 'domain-pages', params), { token });
  const counts = (project, params = '', token = tokenA) => call(url(project, 'tp-counts', params), { token });
  const fixFirst = (project, params = '', token = tokenA) => call(url(project, 'tp-fix-first', params), { token });
  const traffic = (project, params = '', token = tokenA) => call(url(project, 'top-pages-traffic', params), { token });
  const rows = (endpoint) => DataForSeoCacheEntry.countDocuments({ target: domain, endpoint });
  const sectionCalls = (s) => calls.filter((c) => c.section === s);
  const kw = (pageUrl, etv, keyword = 'a keyword') => ({ keyword_data: { keyword, keyword_info: { search_volume: 100 } }, ranked_serp_element: { serp_item: { url: pageUrl, relative_url: new URL(pageUrl).pathname, etv, rank_group: 3, rank_absolute: 3, type: 'organic' } } });
  const BASE = ['page_summary.backlinks', '>=', 1];
  const withKeywords = (items, total = items.length) => { kwState.make = () => envelope(rankedKeywordsResult(items, total)); };
  beforeEach(() => { pageState.total = 518; kwState.make = null; __resetProviderBudgetForTests(); });

  test('the default view is one purchase; the same view written out is a cache hit; it echoes what was asked and has no market', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const first = await pages(projectA);
    assert.equal(first.status, 200);
    const body = sectionCalls('domain-pages')[0].body;
    assert.deepEqual(body, { target: domain, include_subdomains: true, backlinks_status_type: 'live', internal_list_limit: 10, limit: 50, order_by: ['page_summary.referring_domains,desc'] });
    assert.equal(first.json.data.result.totalCount, 518);
    assert.deepEqual(first.json.data.query, { status: 'live', limit: 50, offset: 0, order_by: 'page_summary.referring_domains,desc', internal_list_limit: 10 });
    assert.equal(first.json.data.ttlSeconds, 24 * 3600);
    const again = await pages(projectA, qsOf([['limit', '50'], ['offset', '0'], ['order_by', 'page_summary.referring_domains,desc']]));
    assert.equal(again.json.data.cached, true);
    assert.equal(sectionCalls('domain-pages').length, 1);
    await SeoProject.updateOne({ _id: projectB._id }, { $set: { country: 'GB', language: 'hi' } });
    assert.equal((await pages(projectB, '', tokenB)).json.data.cached, true, 'the answer is about the domain, not a market');
    assert.equal(sectionCalls('domain-pages').length, 1);
  });

  test('every row carries what the server computed: normalised URL, status group, dofollow share by referring domains, the fix for errors', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const { items } = (await pages(projectA, qsOf([['filters', JSON.stringify([['status_code', '>=', 400], 'and', BASE])]]))).json.data.result;
    const www = items.find((i) => i.url === 'https://www.asgeyehospital.com/');
    assert.deepEqual([www.status_code, www.status_group, www.normalized_url, www.suggested_fix], [403, 'blocked', 'asgeyehospital.com', 'Server/CDN is blocking access — check firewall or bot protection']);
    const patna = items.find((i) => i.url === 'https://asgeyehospital.com/patna/');
    assert.deepEqual([patna.status_group, patna.suggested_fix, patna.backlinks, patna.referring_domains], ['error', 'Add a 301 redirect to a relevant live page', 209, 3]);
    assert.ok(Math.abs(patna.dofollow_pct - (1 / 3) * 100) < 1e-9, 'one of its three referring domains is dofollow');
  });

  test('the cached entry holds the page as the provider described it — NO traffic and no flags (those are joined per response)', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    withKeywords([kw('https://www.asgeyehospital.com/specialities/lasik-surgery/', 640)]);
    await pages(projectA);
    const entry = await DataForSeoCacheEntry.findOne({ target: domain, endpoint: 'backlinks/domain_pages' }).lean();
    const first = (entry.payload ?? entry.data ?? entry.result).items[0];
    assert.equal(first.status_group !== undefined, true);
    assert.equal('traffic' in first, false);
    assert.equal('flags' in first, false);
  });

  test('THE JOIN: traffic is summed per NORMALISED url (www / http / slash variants are one page); a page with no match has 0; flags follow', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    withKeywords([
      kw('https://www.asgeyehospital.com/specialities/lasik-surgery/', 400, 'lasik surgery'),
      kw('https://asgeyehospital.com/specialities/lasik-surgery', 240.5, 'lasik cost'),
      kw('https://www.asgeyehospital.com/', 12, 'asg eye hospital'),
    ]);
    const res = await pages(projectA);
    const items = res.json.data.result.items;
    const lasik = items.find((i) => i.url === 'https://asgeyehospital.com/specialities/lasik-surgery/');
    assert.deepEqual([lasik.traffic, lasik.keywords], [640.5, 2]);
    const home = items.find((i) => i.url === 'https://asgeyehospital.com/');
    assert.deepEqual([home.traffic, home.keywords], [12, 1]);
    const none = items.find((i) => i.url === 'https://asgeyehospital.com/specialities/cataract-surgery/');
    assert.deepEqual([none.traffic, none.keywords], [0, 0]);
    assert.deepEqual(none.flags, ['redirected_links'], 'a redirect with 156 referring domains');
    assert.deepEqual(res.json.data.traffic, { status: 'ok', rows: 3, keywordsTotal: 3, truncated: false });
  });

  test('the traffic join asks Organic Keywords ONCE (limit 1,000, most traffic first) and keeps it 7 days: a second page of the table buys nothing more', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    withKeywords([kw('https://www.asgeyehospital.com/', 5)], 4200);
    const first = await pages(projectA);
    const ranked = sectionCalls('ranked-keywords');
    assert.equal(ranked.length, 1);
    assert.deepEqual([ranked[0].body.limit, ranked[0].body.order_by], [1000, ['ranked_serp_element.serp_item.etv,desc']]);
    assert.deepEqual(first.json.data.traffic, { status: 'ok', rows: 1, keywordsTotal: 4200, truncated: true });
    await pages(projectA, qsOf([['offset', '50'], ['order_by', 'page_summary.backlinks,desc']]));
    assert.equal(sectionCalls('ranked-keywords').length, 1);
    assert.equal(await rows('backlinks/domain_pages/traffic'), 1);
    const section = await traffic(projectA);
    assert.equal(section.json.data.ttlSeconds, 7 * 24 * 3600);
    assert.equal(section.json.data.cached, true);
  });

  test('the traffic join SHARES the Organic Keywords cache entry: a project that already has it buys nothing', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const ask = await call(url(projectA, 'ranked-keywords', qsOf([['limit', '1000'], ['order_by', 'ranked_serp_element.serp_item.etv,desc']])), { token: tokenA });
    assert.equal(ask.status, 200);
    assert.equal(sectionCalls('ranked-keywords').length, 1);
    await pages(projectA);
    assert.equal(sectionCalls('ranked-keywords').length, 1, 'the join read the cached Organic Keywords answer');
  });

  test('TRAFFIC FALLBACK: when the join fails the table still loads, traffic and keywords are null (not 0), traffic-based flags are off, and the response says so', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    kwState.make = () => { throw Object.assign(new Error('Request failed'), { response: { status: 500 } }); };
    const res = await pages(projectA);
    assert.equal(res.status, 200);
    assert.equal(res.json.data.traffic.status, 'failed');
    assert.match(res.json.data.traffic.code, /PROVIDER/);
    for (const i of res.json.data.result.items) assert.deepEqual([i.traffic, i.keywords], [null, null]);
    assert.ok(res.json.data.result.items.every((i) => !i.flags.includes('links_no_traffic') && !i.flags.includes('traffic_few_links')));
    assert.ok(res.json.data.result.items.some((i) => i.flags.includes('redirected_links')), 'flags that need no traffic still work');
    assert.equal(await rows('backlinks/domain_pages/traffic'), 0, 'a failure is never cached');
  });

  test('...and the NEXT request retries the join (the table comes from the cache, so only the traffic is bought) and heals the same rows', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    kwState.make = () => { throw Object.assign(new Error('Request failed'), { response: { status: 500 } }); };
    await pages(projectA);
    withKeywords([kw('https://www.asgeyehospital.com/', 33)]);
    const healed = await pages(projectA);
    assert.equal(healed.json.data.cached, true, 'the table was not bought again');
    assert.equal(sectionCalls('domain-pages').length, 1);
    assert.equal(healed.json.data.traffic.status, 'ok');
    assert.equal(healed.json.data.result.items.find((i) => i.url === 'https://asgeyehospital.com/').traffic, 33);
  });

  test('the Errors tab: filters reach the provider as validated (status >= 400 with the base condition), and the page is cached by them', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const filters = JSON.stringify([['status_code', '>=', 400], 'and', BASE]);
    const res = await pages(projectA, qsOf([['order_by', 'page_summary.backlinks,desc'], ['filters', filters]]));
    const body = sectionCalls('domain-pages')[0].body;
    assert.deepEqual(body.filters, [['page_summary.backlinks', '>=', 1], 'and', ['status_code', '>=', 400]]);
    assert.deepEqual(body.order_by, ['page_summary.backlinks,desc']);
    assert.equal(res.json.data.result.totalCount, 2501);
    await pages(projectA, qsOf([['order_by', 'page_summary.backlinks,desc'], ['filters', filters]]));
    assert.equal(sectionCalls('domain-pages').length, 1);
    assert.equal(await rows('backlinks/domain_pages'), 1);
  });

  test('invalid values are a 400 before any provider call; other sections\' parameters are refused; profile pieces take no parameters at all', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    for (const params of [
      '?status=live', '?limit=10', '?offset=19951&limit=50', '?order_by=meta.title,asc', '?order_by=page_summary.rank', '?filters=zzz',
      `?filters=${encodeURIComponent('["domain","like","%x%"]')}`, `?filters=${encodeURIComponent('["status_code",">=",1000]')}`, '?mode=one_per_domain', '?dofollow=1', '?token=abc',
    ]) assert.equal((await pages(projectA, params)).status, 400, params);
    const nine = Array.from({ length: 9 }, (_, i) => ['page_summary.backlinks', '>=', i + 1]).flatMap((c, i) => (i ? ['and', c] : [c]));
    const tooMany = await pages(projectA, qsOf([['filters', JSON.stringify(nine)]]));
    assert.equal(tooMany.status, 400);
    assert.match(tooMany.json.message, /at most 8 filter conditions/);
    for (const params of ['?limit=5', '?filters=%5B%5D', '?order_by=page_summary.rank,asc', '?status=lost']) {
      for (const fn of [counts, fixFirst, traffic]) assert.equal((await fn(projectA, params)).status, 400, params);
    }
    assert.equal(calls.length, 0, 'nothing was bought');
  });

  test('login and ownership are required', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    for (const section of ['domain-pages', 'tp-counts', 'tp-fix-first', 'top-pages-traffic']) {
      assert.equal((await call(url(projectA, section))).status, 401, section);
      assert.equal((await call(url(projectA, section), { token: tokenB })).status, 403, section);
    }
    assert.equal(calls.length, 0);
  });

  test('a domain with no pages with backlinks is a successful empty page', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    pageState.total = 0;
    const res = await pages(projectA);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.data.result, { totalCount: 0, items: [] });
  });

  test('a provider failure on the table is a plain error and is not cached', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    failures['domain-pages'] = Object.assign(new Error('Request failed'), { response: { status: 429 } });
    const bad = await pages(projectA);
    assert.equal(bad.status, 429);
    assert.equal(bad.json.code, 'PROVIDER_RATE_LIMITED');
    assert.equal(await rows('backlinks/domain_pages'), 0);
  });

  test('HEADLINE COUNTS: three count-only calls (live, limit 1, the base condition), cached together for 7 days', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const res = await counts(projectA);
    assert.equal(res.status, 200);
    assert.equal(sectionCalls('tp-counts').length, 3);
    assert.deepEqual(sectionCalls('tp-counts').map((c) => c.body.filters), [
      BASE, [['status_code', '>=', 400], 'and', BASE], [['status_code', '>=', 300], 'and', ['status_code', '<', 400], 'and', BASE],
    ]);
    for (const c of sectionCalls('tp-counts')) assert.deepEqual([c.body.limit, c.body.backlinks_status_type], [1, 'live']);
    assert.deepEqual(res.json.data.result, { pages: 518, errors: 138, redirects: 312 });
    assert.equal(res.json.data.ttlSeconds, 7 * 24 * 3600);
    assert.equal((await counts(projectA)).json.data.cached, true);
    assert.equal(sectionCalls('tp-counts').length, 3);
    assert.equal(await rows('backlinks/domain_pages/counts'), 1);
    assert.equal(await rows('backlinks/domain_pages'), 0, 'never shares the table\'s entries');
  });

  test('HEADLINE COUNTS: one failing call fails the card (a made-up zero would be wrong) and nothing is cached', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    let n = 0;
    __setTransportForTests({ 'tp-counts': async (body) => { calls.push({ section: 'tp-counts', body }); n += 1; if (n === 2) throw Object.assign(new Error('x'), { response: { status: 500 } }); return normal['tp-counts'](body); } });
    try {
      assert.equal((await counts(projectA)).status, 502);
      assert.equal(await rows('backlinks/domain_pages/counts'), 0);
    } finally { restoreTransport(); }
  });

  test('"FIX FIRST": one call for the 5 error pages with the most backlinks, joined with their fix and the wasted-links flag; cached 7 days', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const res = await fixFirst(projectA);
    assert.equal(res.status, 200);
    assert.equal(sectionCalls('tp-fix-first').length, 1);
    const body = sectionCalls('tp-fix-first')[0].body;
    assert.deepEqual([body.limit, body.order_by, body.filters, body.backlinks_status_type], [5, ['page_summary.backlinks,desc'], [['status_code', '>=', 400], 'and', BASE], 'live']);
    const { items } = res.json.data.result;
    assert.equal(items.length, 5);
    assert.deepEqual(items[0].flags, ['wasted_links']);
    assert.ok(items.every((i) => i.suggested_fix));
    assert.equal(sectionCalls('ranked-keywords').length, 0, 'it needs no traffic');
    assert.equal(res.json.data.ttlSeconds, 7 * 24 * 3600);
    assert.equal((await fixFirst(projectA)).json.data.cached, true);
    assert.equal(sectionCalls('tp-fix-first').length, 1);
  });

  test('the profile pieces use the budget of REAL provider calls only: cache hits are free, a spent budget refuses new purchases but still answers from the cache', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    await counts(projectA);
    await fixFirst(projectA);
    for (let i = 0; i < 30; i += 1) {
      assert.equal((await counts(projectA)).status, 200, `counts hit ${i}`);
      assert.equal((await fixFirst(projectA)).status, 200, `fix hit ${i}`);
    }
    assert.equal(calls.length, 4, '3 counts + 1 fix-first, nothing more');
    const statuses = [];
    for (let i = 0; i < 6; i += 1) {
      await SeoProject.updateOne({ _id: projectA._id }, { $set: { main_url: `https://budget${i}.${domain}` } });
      statuses.push((await counts(projectA)).status); // 3 real calls each
    }
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429], 'budget 20: 4 already used + 5 x 3 = 19 fit, the sixth would be 22');
    await SeoProject.updateOne({ _id: projectA._id }, { $set: { main_url: `https://budget6.${domain}` } });
    const over = await counts(projectA);
    assert.equal(over.status, 429);
    assert.equal(over.json.code, 'RATE_LIMITED');
    await SeoProject.updateOne({ _id: projectA._id }, { $set: { main_url: `https://budget0.${domain}` } });
    assert.equal((await counts(projectA)).json.data.cached, true);
    assert.equal((await counts(projectB, '', tokenB)).status, 200, 'another user has a budget of their own');
  });
});

describe('Top pages export: streamed from the server, batch by batch, with the same traffic join', () => {
  const exportPath = (project) => `/${project._id}/top-pages-export`;
  const get = async (project, params = '', token = tokenA) => {
    const res = await fetch(`${baseUrl}${exportPath(project)}${params}`, { headers: { Authorization: `Bearer ${token}` } });
    const text = res.headers.get('content-type')?.includes('csv') ? new TextDecoder('utf-8', { ignoreBOM: true }).decode(await res.arrayBuffer()) : await res.text();
    return { res, text };
  };
  const records = (text) => { let inQ = false; let n = 0; for (const ch of text) { if (ch === '"') inQ = !inQ; else if (ch === '\n' && !inQ) n += 1; } return n; };
  const sectionCalls = (s) => calls.filter((c) => c.section === s);
  beforeEach(() => { pageState.total = 2500; kwState.make = null; __resetProviderBudgetForTests(); });

  test('the whole view: batches of 1,000 by offset, one header, every row; the traffic is loaded ONCE for the whole file', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    kwState.make = () => envelope(rankedKeywordsResult([{ keyword_data: { keyword: 'k' }, ranked_serp_element: { serp_item: { url: 'https://www.asgeyehospital.com/', relative_url: '/', etv: 77, rank_group: 1 } } }], 1));
    const { res, text } = await get(projectA, qsOf([['order_by', 'page_summary.backlinks,desc']]));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-export-rows'), '2500');
    assert.equal(res.headers.get('x-export-batches'), '3');
    assert.equal(text.charCodeAt(0), 0xfeff);
    assert.equal(records(text), 2501);
    assert.equal(text.split('\r\n')[0], '﻿URL,Normalised URL,Status,Redirect target,Title,Referring domains,Backlinks,Broken backlinks,Dofollow %,Rank,Est. traffic,Keywords,Flags,Suggested fix,First seen,Last crawled');
    assert.deepEqual(sectionCalls('domain-pages').map((c) => [c.body.limit, c.body.offset ?? 0]), [[1000, 0], [1000, 1000], [1000, 2000]]);
    assert.equal(sectionCalls('ranked-keywords').length, 1);
    const home = text.split('\r\n').find((l) => l.startsWith('https://asgeyehospital.com/,'));
    assert.match(home, /^https:\/\/asgeyehospital\.com\/,asgeyehospital\.com,301,https:\/\/www\.asgeyehospital\.com\/,,3223,4689,0,95\.2,246,77,1,/);
  });

  test('when the traffic join fails the file still downloads, with EMPTY traffic cells (never 0)', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    kwState.make = () => { throw Object.assign(new Error('Request failed'), { response: { status: 500 } }); };
    const { res, text } = await get(projectA, qsOf([['max_rows', '20']]));
    assert.equal(res.status, 200);
    const cells = text.split('\r\n')[1].split(',');
    assert.deepEqual([cells[10], cells[11]], ['', '']);
  });

  test('the cap: never more than 10,000 rows, and never more than the user agreed to', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    pageState.total = 50000;
    const capped = await get(projectA);
    assert.equal(capped.res.headers.get('x-export-rows'), String(TOP_PAGES_EXPORT.maxRows));
    assert.equal(records(capped.text), 10001);
    calls.length = 0;
    const some = await get(projectA, qsOf([['max_rows', '1500']]));
    assert.equal(some.res.headers.get('x-export-rows'), '1500');
    assert.equal(records(some.text), 1501);
    assert.ok(sectionCalls('domain-pages').length <= 2);
  });

  test('a provider failure on the first batch is an ordinary JSON error, before the file starts', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    failures['domain-pages'] = Object.assign(new Error('Request failed'), { response: { status: 429 } });
    const { res, text } = await get(projectA);
    assert.equal(res.status, 429);
    assert.equal(JSON.parse(text).code, 'PROVIDER_RATE_LIMITED');
  });

  test('a failure AFTER the file has started drops the connection: a partial file is never taken for a complete one', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    __setTransportForTests({ 'domain-pages': async (body) => { calls.push({ section: 'domain-pages', body }); if ((body.offset ?? 0) >= 1000) throw Object.assign(new Error('boom'), { response: { status: 500 } }); return normal['domain-pages'](body); } });
    try {
      await assert.rejects(async () => { const res = await fetch(`${baseUrl}${exportPath(projectA)}`, { headers: { Authorization: `Bearer ${tokenA}` } }); await res.arrayBuffer(); });
    } finally { restoreTransport(); }
  });

  test('the export is not a back door: no limit / offset / token / status, valid filters only, a sane row count', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    for (const pairs of [[['limit', '5']], [['offset', '5']], [['token', 'abc']], [['status', 'lost']], [['filters', JSON.stringify(['secret', '=', 1])]], [['max_rows', '0']]]) {
      assert.equal((await get(projectA, qsOf(pairs))).res.status, 400, JSON.stringify(pairs));
    }
    assert.equal(calls.length, 0, 'nothing was bought');
  });

  test('login and ownership are required, and the export has its own small per-user limit', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    assert.equal((await fetch(`${baseUrl}${exportPath(projectA)}`)).status, 401);
    assert.equal((await get(projectA, '', tokenB)).res.status, 403);
    assert.equal((await get(projectA, qsOf([['max_rows', 'x']]))).res.status, 400);
    let last;
    for (let i = 0; i < 6; i += 1) last = await get(projectA, qsOf([['max_rows', '1']]));
    assert.equal(last.res.status, 429);
  });
});

describe('Domain Overview hub: peek-only sections, the last-30-days tiles and the Brand keyword group', () => {
  const q = (o) => `?${new URLSearchParams(o).toString()}`;
  const last30 = (project, token = tokenA) => call(url(project, 'rd-last-30'), { token });
  const peek = (project, section, params = {}, token = tokenA) => call(url(project, section, q({ peek: '1', ...params })), { token });
  const KEYWORD = 'keyword_data.keyword';
  const bodyFilters = () => calls.find((c) => c.section === 'ranked-keywords').body.filters;
  beforeEach(() => { __resetProviderBudgetForTests(); });

  test('rd-last-30 is two count-only calls (new: live + first_seen, lost: lost + lost_date) from a Monday, cached for 7 days', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const since = windowStartDay(Date.now(), 30);
    assert.equal(new Date(`${since}T00:00:00Z`).getUTCDay(), 1);
    const first = await last30(projectA);
    assert.equal(first.status, 200);
    assert.deepEqual(first.json.data.result, { since, days: 30, new: 41, lost: 12 });
    assert.equal(calls.length, 2);
    const byStatus = Object.fromEntries(calls.map((c) => [c.body.backlinks_status_type, c.body]));
    assert.deepEqual(byStatus.live.filters, ['first_seen', '>=', since]);
    assert.deepEqual(byStatus.lost.filters, ['lost_date', '>=', since]);
    for (const body of Object.values(byStatus)) assert.deepEqual([body.limit, body.internal_list_limit, body.target], [1, 1, domain]);
    assert.equal(first.json.data.ttlSeconds, 7 * 86400);
    assert.equal((await last30(projectA)).json.data.cached, true);
    assert.equal(calls.length, 2);
    assert.equal(await DataForSeoCacheEntry.countDocuments({ target: domain, endpoint: 'backlinks/referring_domains/last-30' }), 1);
  });

  test('rd-last-30 is domain-level: another user\'s project in another country shares it', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    await last30(projectA);
    await SeoProject.updateOne({ _id: projectB._id }, { $set: { country: 'GB', language: 'hi' } });
    assert.equal((await last30(projectB, tokenB)).json.data.cached, true);
    assert.equal(calls.length, 2);
  });

  test('rd-last-30 failing: an error status, nothing cached', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    failures['rd-last-30'] = Object.assign(new Error('Request failed'), { response: { status: 500 } });
    const res = await last30(projectA);
    assert.ok([502, 504].includes(res.status), String(res.status));
    assert.equal(await DataForSeoCacheEntry.countDocuments({ target: domain, endpoint: 'backlinks/referring_domains/last-30' }), 0);
  });

  test('rd-last-30 uses the real-call budget: only purchases count, a cache hit is free', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    for (let i = 0; i < 12; i += 1) assert.equal((await last30(projectA)).status, 200); // 1 purchase (2 calls) + 11 hits
    assert.equal(calls.length, 2);
  });

  test('peek on the anchor profile: a miss is result:null and NEVER calls the provider or stores anything; after the Anchors page cached it, the peek returns it', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const miss = await peek(projectA, 'anchor-profile');
    assert.equal(miss.status, 200);
    assert.deepEqual([miss.json.data.result, miss.json.data.cached, miss.json.data.peek, miss.json.data.fetchedAt], [null, false, true, null]);
    assert.equal(calls.length, 0);
    assert.equal(await DataForSeoCacheEntry.countDocuments({ target: domain }), 0);
    await call(url(projectA, 'anchor-profile'), { token: tokenA });
    assert.equal(calls.length, 1);
    const hit = await peek(projectA, 'anchor-profile');
    assert.equal(hit.json.data.cached, true);
    assert.equal(hit.json.data.peek, true);
    assert.ok(hit.json.data.result.items.length > 0);
    assert.equal(calls.length, 1);
  });

  test('peek on bulk-traffic is keyed by the same set of targets as the Compare section', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    assert.equal((await peek(projectA, 'bulk-traffic', { targets: 'a.com,b.com' })).json.data.result, null);
    await call(url(projectA, 'bulk-traffic', q({ targets: 'b.com,a.com' })), { token: tokenA });
    const hit = await peek(projectA, 'bulk-traffic', { targets: 'WWW.a.com, b.com' });
    assert.equal(hit.json.data.cached, true);
    assert.equal((await peek(projectA, 'bulk-traffic', { targets: 'a.com,c.com' })).json.data.result, null);
    assert.equal(calls.length, 1);
  });

  test('peek is refused for every other section, and with refresh: 400, no provider call', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    for (const section of ['rank-overview', 'history', 'ranked-keywords', 'backlinks', 'rd-toxic-count', 'rd-last-30', 'domain-pages', 'tp-counts', 'tp-fix-first', 'top-pages-traffic']) {
      const res = await peek(projectA, section);
      assert.equal(res.status, 400, section);
      assert.equal(res.json.field, 'peek', section);
    }
    assert.equal((await peek(projectA, 'anchor-profile', { refresh: '1' })).status, 400);
    assert.equal((await call(url(projectA, 'anchor-profile', q({ peek: 'yes' })), { token: tokenA })).status, 400);
    assert.equal(calls.length, 0);
  });

  test('peek needs no provider credentials and is project-scoped', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const login = process.env.DATAFORSEO_LOGIN;
    delete process.env.DATAFORSEO_LOGIN;
    try {
      assert.equal((await peek(projectA, 'anchor-profile')).status, 200);
    } finally {
      process.env.DATAFORSEO_LOGIN = login;
    }
    assert.equal((await peek(projectA, 'anchor-profile', {}, tokenB)).status, 403);
  });

  test('Brand keywords: an "or" group of keyword like-conditions reaches the provider as [c1, "or", c2]; the Non-brand variant is plain "and" not_likes', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const brand = [[KEYWORD, 'like', '%asg%'], 'or', [KEYWORD, 'like', '%eye%']];
    const res = await call(url(projectA, 'ranked-keywords', q({ filters: JSON.stringify([brand]) })), { token: tokenA });
    assert.equal(res.status, 200);
    assert.deepEqual(bodyFilters(), [[KEYWORD, 'like', '%asg%'], 'or', [KEYWORD, 'like', '%eye%']]);
    calls = [];
    await call(url(projectA, 'ranked-keywords', q({ filters: JSON.stringify([[KEYWORD, 'not_like', '%asg%'], 'and', [KEYWORD, 'not_like', '%eye%']]) })), { token: tokenA });
    assert.deepEqual(bodyFilters(), [[KEYWORD, 'not_like', '%asg%'], 'and', [KEYWORD, 'not_like', '%eye%']]);
  });

  test('a group beside other conditions is "and"-joined; group order and spelling are one cache entry', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const a = [[[KEYWORD, 'like', '%asg%'], 'or', [KEYWORD, 'like', '%eye%']], 'and', ['ranked_serp_element.serp_item.rank_group', '<=', 10]];
    const b = [['ranked_serp_element.serp_item.rank_group', '<=', 10], 'and', [[KEYWORD, 'like', '%EYE%'], 'or', [KEYWORD, 'like', '%asg%']]];
    await call(url(projectA, 'ranked-keywords', q({ filters: JSON.stringify(a) })), { token: tokenA });
    assert.equal(bodyFilters().length, 3);
    assert.equal(bodyFilters()[1], 'and');
    const again = await call(url(projectA, 'ranked-keywords', q({ filters: JSON.stringify(b) })), { token: tokenA });
    assert.equal(again.json.data.cached, true);
    assert.equal(calls.length, 1);
  });

  test('group rules: at least two members, at most six, only keyword "like", members count toward the 8-condition limit; nothing reaches the provider', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const like = (n) => [KEYWORD, 'like', `%t${n}%`];
    const orOf = (n) => Array.from({ length: n }, (_, i) => like(i)).flatMap((c, i) => (i === 0 ? [c] : ['or', c]));
    const bad = {
      oneMember: [[like(1)]],
      sevenMembers: [orOf(7)],
      notLike: [[[KEYWORD, 'not_like', '%a%'], 'or', [KEYWORD, 'not_like', '%b%']]],
      otherField: [[['ranked_serp_element.serp_item.rank_group', '<=', 3], 'or', ['ranked_serp_element.serp_item.rank_group', '<=', 5]]],
      mixedJoin: [[like(1), 'and', like(2)]],
      tooManyLeaves: [orOf(6), 'and', like(8), 'and', like(9), 'and', like(10)],
    };
    for (const [name, filters] of Object.entries(bad)) {
      const res = await call(url(projectA, 'ranked-keywords', q({ filters: JSON.stringify(filters) })), { token: tokenA });
      assert.equal(res.status, 400, name);
    }
    assert.equal(calls.length, 0);
    const sixAndTwo = await call(url(projectA, 'ranked-keywords', q({ filters: JSON.stringify([orOf(6), 'and', like(8), 'and', like(9)]) })), { token: tokenA });
    assert.equal(sixAndTwo.status, 200); // 6 + 1 + 1 = 8 conditions
    assert.equal(calls.length, 1);
  });

  test('other sections still refuse "or": the competitors list does not take a group', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const res = await call(url(projectA, 'competitors', q({ filters: JSON.stringify([[['intersections', '>=', 5], 'or', ['intersections', '>=', 9]]]) })), { token: tokenA });
    assert.equal(res.status, 400);
    assert.equal(calls.length, 0);
  });
});
