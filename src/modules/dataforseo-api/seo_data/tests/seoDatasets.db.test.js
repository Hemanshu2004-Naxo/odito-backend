import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import express from 'express';

dotenv.config();
delete process.env.SEO_DB_FIRST_READS;
process.env.DATAFORSEO_LOGIN = 'test-login';
process.env.DATAFORSEO_PASSWORD = 'test-password';

import User from '../../../user/model/User.js';
import SeoProject from '../../../app_user/model/SeoProject.js';
import { signAuthToken } from '../../../user/service/tokenService.js';
import DataForSeoCacheEntry from '../../shared/DataForSeoCacheEntry.js';
import { __resetInFlightForTests } from '../../shared/apiCache.js';
import SeoSnapshot from '../model/SeoSnapshot.js';
import SeoScanRun from '../model/SeoScanRun.js';
import SeoKeywordRanking from '../model/SeoKeywordRanking.js';
import SeoBacklink from '../model/SeoBacklink.js';
import SeoReferringDomain from '../model/SeoReferringDomain.js';
import domainOverviewRoutes from '../../domain_overview/routes/domainOverviewRoutes.js';
import seoScanRoutes from '../routes/seoScanRoutes.js';
import { __setTransportForTests } from '../../domain_overview/provider/domainOverviewProvider.js';
import { SECTION_NAMES } from '../../domain_overview/config.js';
import { persistRows } from '../datasets/datasetCollector.js';
import { envelope, rankedKeywordItem } from '../../domain_overview/tests/fixtures.js';
import { REAL_LIST_DEFAULT } from '../../domain_overview/tests/realBacklinksList.js';
import { RAW_RD_DEFAULT } from '../../domain_overview/tests/realReferringDomains.js';

/**
 * Phase 2: permanent row sets + MongoDB paging / sorting / filtering, through the REAL routers, the REAL provider parsers and a REAL
 * MongoDB. Only the provider transport is replaced - for EVERY section: an endpoint nobody stubbed throws and is counted, and after a
 * scan every read below must leave the call counter where it was.
 */

const MARK = `seo-datasets-${Date.now()}`;
let mongoAvailable = false;
let server; let baseUrl; let calls; let world; let seq = 0;
let userA; let userB; let tokenA; let tokenB; let projectA; let projectB; let domain;

// ── the provider's world: version 1 and version 2 of the same site ──
const KW_TOTAL = { 1: 2500, 2: 2495 };
const kwIndex = (v, i) => (v === 1 ? i : i + 10); // v2 lost the first 10 keywords and gained 5 at the end (n = 2500..2504)
const kwPosition = (n, v) => (n % 20) + 2 - (v === 2 && n >= 100 && n < 110 ? 1 : 0) + (v === 2 && n >= 200 && n < 205 ? 3 : 0);
const kwRaw = (n, v) => rankedKeywordItem({
  keyword_data: {
    keyword: `Keyword ${n}`,
    keyword_info: { search_volume: 100 + n, cpc: (n % 50) / 10 },
    keyword_properties: { keyword_difficulty: n % 100 },
    search_intent_info: { main_intent: n % 2 ? 'informational' : 'commercial' },
    serp_info: { serp_item_types: n % 3 ? ['organic'] : ['organic', 'featured_snippet'] },
  },
  ranked_serp_element: {
    last_updated_time: '2026-11-01 00:00:00 +00:00',
    serp_item: {
      type: 'organic', rank_group: kwPosition(n, v), rank_absolute: kwPosition(n, v), etv: 6000 - n, relative_url: `/page-${n % 7}/`, url: `https://www.${domain}/page-${n % 7}/`,
      rank_changes: { previous_rank_absolute: 9, is_new: n % 11 === 0, is_up: n % 5 === 0, is_down: n % 13 === 0 },
    },
  },
});
const BL_TOTAL = { live: 1500, lost: 40 };
const blRaw = (n, status) => ({
  ...REAL_LIST_DEFAULT.items[0],
  url_from: `https://src${n % 300}.example.org/post-${n}`, domain_from: `src${n % 300}.example.org`, url_to: `https://${domain}/t${n % 9}/`,
  anchor: n % 4 === 0 ? 'brand name' : `anchor ${n % 25}`, item_type: 'anchor', dofollow: n % 3 !== 0, rank: 1000 - (n % 700), domain_from_rank: n % 500, page_from_rank: n % 300,
  first_seen: `2025-${String((n % 12) + 1).padStart(2, '0')}-10 00:00:00 +00:00`, last_seen: '2026-10-30 00:00:00 +00:00', is_lost: status === 'lost', is_new: false, is_broken: false,
  domain_from_country: n % 2 ? 'IN' : 'US', backlink_spam_score: n % 60,
});
const RD_TOTAL = { live: 1200, lost: 30 };
const rdRaw = (n, status) => ({
  ...RAW_RD_DEFAULT.items[0], domain: `ref${n}.example.net`, rank: n % 600, backlinks: 1 + (n % 90), referring_pages: 1 + (n % 90), referring_pages_nofollow: n % 4 === 0 ? 1 + (n % 90) : 0,
  backlinks_spam_score: n % 70, first_seen: `2024-${String((n % 12) + 1).padStart(2, '0')}-05 00:00:00 +00:00`, lost_date: status === 'lost' ? '2026-09-01 00:00:00 +00:00' : null,
});

const STUBS = {
  'ranked-keywords': (body) => {
    const total = KW_TOTAL[world.version];
    // The second batch starts one row early (overlapping provider pages): the stored set must still hold each keyword once.
    const start = Math.max(0, (body.offset ?? 0) - (world.overlap && body.offset ? 1 : 0));
    const count = Math.max(0, Math.min(body.limit - (start < (body.offset ?? 0) ? 0 : 0), total - start));
    const items = Array.from({ length: count }, (_, i) => kwRaw(kwIndex(world.version, start + i), world.version));
    return envelope({ total_count: total, items_count: count, items: count ? items : null, metrics: { organic: { count: total, etv: 987654, pos_1: 11, pos_2_3: 22, pos_4_10: 33, is_new: 4, is_up: 5, is_down: 6 } } });
  },
  'backlinks-list': (body) => {
    const status = body.backlinks_status_type ?? 'live';
    const total = BL_TOTAL[status];
    const start = body.search_after_token ? Number(body.search_after_token.slice(1)) : (body.offset ?? 0);
    const count = Math.max(0, Math.min(body.limit, total - start));
    const items = Array.from({ length: count }, (_, i) => blRaw(start + i, status));
    return envelope({ total_count: total, items_count: count, items: count ? items : null, search_after_token: start + count < total ? `T${start + count}` : null });
  },
  'referring-domains': (body) => {
    const status = body.backlinks_status_type ?? 'live';
    if (world.failRd && (body.offset ?? 0) > 0) throw Object.assign(new Error('boom'), { code: 'ECONNRESET' });
    const total = RD_TOTAL[status];
    const start = body.offset ?? 0;
    const count = Math.max(0, Math.min(body.limit, total - start));
    const items = Array.from({ length: count }, (_, i) => rdRaw(start + i, status));
    return envelope({ total_count: total, items_count: count, items: count ? items : null });
  },
};

before(async () => {
  const transport = {};
  for (const section of SECTION_NAMES) {
    transport[section] = async (body) => {
      calls.push({ section, body });
      if (!STUBS[section]) throw new Error(`UNSTUBBED provider call: ${section}`);
      return STUBS[section](body);
    };
  }
  __setTransportForTests(transport);
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
  } catch { return; }
  await Promise.all([DataForSeoCacheEntry, SeoSnapshot, SeoScanRun, SeoKeywordRanking, SeoBacklink, SeoReferringDomain].map((m) => m.init()));
  const app = express();
  app.use(express.json());
  app.use('/api/projects', domainOverviewRoutes);
  app.use('/api/projects', seoScanRoutes);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/projects`;
});

after(async () => {
  __setTransportForTests(null);
  if (mongoAvailable) {
    const re = new RegExp(MARK);
    const ids = (await SeoProject.find({ project_name: re }).select('_id').lean()).map((p) => p._id);
    await Promise.all([SeoKeywordRanking, SeoBacklink, SeoReferringDomain, SeoSnapshot, SeoScanRun].map((m) => m.deleteMany({ projectId: { $in: ids } })));
    await DataForSeoCacheEntry.deleteMany({ target: re });
    await SeoProject.deleteMany({ project_name: re });
    await User.deleteMany({ email: re });
    await mongoose.connection.close();
  }
  if (server) await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => { calls = []; world = { version: 1, overlap: false, failRd: false }; __resetInFlightForTests(); });

async function call(path, { token = tokenA, method = 'GET', body } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json };
}
const section = (name, q = '', project = projectA, token = tokenA) => call(`/${project._id}/domain-overview/${name}${q}`, { token });
const ds = (path, q = '', project = projectA, token = tokenA) => call(`/${project._id}/seo-datasets${path}${q}`, { token });
const filt = (...conds) => `filters=${encodeURIComponent(JSON.stringify(conds.length === 1 ? conds[0] : conds.flatMap((c, i) => (i ? ['and', c] : [c]))))}`;
const ROW = 'ranked_serp_element.serp_item';

async function scan(body) {
  const res = await call(`/${projectA._id}/seo-scans`, { method: 'POST', body });
  assert.ok([202].includes(res.status), `scan start ${res.status} ${JSON.stringify(res.json)}`);
  for (let i = 0; i < 400; i += 1) {
    const s = (await call(`/${projectA._id}/seo-scans/latest`)).json.data.scan;
    if (s && !['pending', 'queued', 'running'].includes(s.status)) return s;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('scan did not finish');
}
/** Test setup standing in for "a day later": the provider cache entries (and their 60 s refresh floor) are gone, so a forced scan buys again. */
const ageCache = () => DataForSeoCacheEntry.deleteMany({ target: domain });
const ALL = ['keywords-dataset', 'backlinks-dataset-live', 'backlinks-dataset-lost', 'referring-domains-dataset-live', 'referring-domains-dataset-lost'];

describe('Phase 2: permanent datasets, database paging, history (real routers + MongoDB, stubbed provider)', () => {
  before(async () => {
    if (!mongoAvailable) return;
    seq += 1;
    domain = `${MARK}.example.com`;
    userA = await User.create({ firstName: 'Ann', lastName: 'Owner', email: `a-${MARK}@example.com`, password: 'Passw0rd!long', roleId: 5 });
    userB = await User.create({ firstName: 'Bob', lastName: 'Other', email: `b-${MARK}@example.com`, password: 'Passw0rd!long', roleId: 5 });
    tokenA = signAuthToken(userA); tokenB = signAuthToken(userB);
    projectA = await SeoProject.create({ user_id: userA._id, project_name: `${MARK}-A`, main_url: `https://www.${domain}/`, seo_scope: 'local', keywords: ['k'], country: 'IN', language: 'en' });
    // Another owner, the SAME domain: it shares provider cache entries but must never see project A's stored rows.
    projectB = await SeoProject.create({ user_id: userB._id, project_name: `${MARK}-B`, main_url: `https://${domain}`, seo_scope: 'local', keywords: ['k'], country: 'IN', language: 'en' });
  });

  test('before any scan: nothing stored, pages say so, and not one provider request is made', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    for (const name of ['ranked-keywords', 'backlinks-list', 'referring-domains']) {
      const r = await section(name);
      assert.equal(r.json.data.missing, true, name);
    }
    assert.equal((await ds('/keywords')).json.data.missing, true);
    assert.equal((await ds('')).json.data.datasets.every((d) => d.collected === false), true);
    assert.equal(calls.length, 0);
  });

  test('a scan collects the five datasets (overlapping provider pages stored once) and every read after it makes ZERO provider requests', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    world.overlap = true;
    const s = await scan({ scope: 'dataset', datasets: ALL });
    assert.equal(s.status, 'completed', JSON.stringify(s));
    assert.equal(s.providerRequestsCount, 9, '3 keyword batches + 2 backlink + 1 lost + 2 domain + 1 lost');
    assert.equal(await SeoKeywordRanking.countDocuments({ projectId: projectA._id }), 2500, 'each keyword once, although a batch overlapped');
    assert.equal(await SeoBacklink.countDocuments({ projectId: projectA._id, status: 'live' }), 1500);
    assert.equal(await SeoBacklink.countDocuments({ projectId: projectA._id, status: 'lost' }), 40);
    assert.equal(await SeoReferringDomain.countDocuments({ projectId: projectA._id, status: 'live' }), 1200);
    assert.equal(await SeoReferringDomain.countDocuments({ projectId: projectA._id, status: 'lost' }), 30);
    const statuses = (await ds('')).json.data.datasets;
    assert.deepEqual(statuses.map((d) => [d.kind, d.status, d.collected, d.rows, d.truncated]), [
      ['keywords', null, true, 2500, false], ['backlinks', 'live', true, 1500, false], ['backlinks', 'lost', true, 40, false],
      ['referringDomains', 'live', true, 1200, false], ['referringDomains', 'lost', true, 30, false],
    ]);
    const mark = calls.length;
    // a stored row is the parsed record the pages already consume
    const first = (await section('ranked-keywords', '?limit=25')).json.data;
    assert.equal(first.source, 'database');
    assert.deepEqual(Object.keys(first.result).sort(), ['items', 'metrics', 'totalCount']);
    assert.equal(first.result.items[0].keyword, 'Keyword 0');
    assert.equal(first.result.items[0].etv, 6000);
    assert.equal(first.result.totalCount, 2500);
    assert.equal(calls.length, mark);
  });

  test('H/Organic Keywords: paging, sorting, filtering and search are MongoDB queries (zero provider requests)', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const mark = calls.length;
    const page1 = (await section('ranked-keywords', '?limit=25&offset=0')).json.data.result;
    const page2 = (await section('ranked-keywords', '?limit=25&offset=25')).json.data.result;
    const names = [...page1.items, ...page2.items].map((i) => i.keyword);
    assert.equal(new Set(names).size, 50, 'no row repeats between pages');
    assert.equal(page2.items[0].keyword, 'Keyword 25');
    const last = (await section('ranked-keywords', '?limit=25&offset=2475')).json.data.result;
    assert.equal(last.items.length, 25);
    // sort by position ascending, ties in a stable order
    const byPos = (await section('ranked-keywords', `?limit=100&order_by=${encodeURIComponent(`${ROW}.rank_group,asc`)}`)).json.data.result;
    assert.ok(byPos.items.every((r, i, a) => i === 0 || a[i - 1].position <= r.position));
    // search + ranges + intent + url
    const search = (await section('ranked-keywords', `?limit=100&${filt(['keyword_data.keyword', 'like', '%keyword 12%'])}`)).json.data.result;
    assert.equal(search.totalCount, 111, 'Keyword 12, 120-129, 1200-1299');
    assert.equal(search.items.every((r) => r.keyword.toLowerCase().includes('keyword 12')), true);
    const range = (await section('ranked-keywords', `?limit=100&${filt([`${ROW}.rank_group`, '<=', 3], ['keyword_data.keyword_info.search_volume', '>=', 2000])}`)).json.data.result;
    const expected = [...Array(2500).keys()].filter((n) => (n % 20) + 2 <= 3 && 100 + n >= 2000).length;
    assert.equal(range.totalCount, expected);
    assert.ok(range.items.every((r) => r.position <= 3 && r.search_volume >= 2000));
    const intent = (await section('ranked-keywords', `?limit=25&${filt(['keyword_data.search_intent_info.main_intent', 'in', ['commercial']])}`)).json.data.result;
    assert.equal(intent.totalCount, 1250);
    const url = (await section('ranked-keywords', `?limit=25&${filt([`${ROW}.relative_url`, 'like', '%page-3%'])}`)).json.data.result;
    assert.equal(url.totalCount, [...Array(2500).keys()].filter((n) => n % 7 === 3).length);
    // the metrics follow the matching rows; unfiltered they are the provider's whole-domain totals
    assert.equal(range.metrics.count, expected);
    assert.equal((await section('ranked-keywords', '?limit=5')).json.data.result.metrics.etv, 987654);
    // nothing matches: an empty page, not an error, and no metrics
    const none = (await section('ranked-keywords', `?${filt(['keyword_data.keyword', 'like', '%zzzzqq%'])}`)).json.data.result;
    assert.deepEqual([none.totalCount, none.items.length, none.metrics], [0, 0, null]);
    assert.equal(calls.length, mark, 'not one provider request for all of that');
  });

  test('Backlinks: paging, search, follow/nofollow, source domain, target, dates, modes and tabs come from MongoDB', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const mark = calls.length;
    const idx = [...Array(1500).keys()];
    const def = (await section('backlinks-list')).json.data;
    assert.equal(def.source, 'database');
    assert.equal(def.result.totalCount, 1500);
    assert.equal(def.result.nextToken, null);
    assert.ok(def.result.items.every((r, i, a) => i === 0 || a[i - 1].rank >= r.rank), 'rank, highest first');
    const follow = (await section('backlinks-list', `?${filt(['dofollow', '=', true])}`)).json.data.result;
    assert.equal(follow.totalCount, idx.filter((n) => n % 3 !== 0).length);
    const nofollow = (await section('backlinks-list', `?${filt(['dofollow', '=', false])}`)).json.data.result;
    assert.equal(nofollow.totalCount, idx.filter((n) => n % 3 === 0).length);
    const anchor = (await section('backlinks-list', `?${filt(['anchor', 'like', '%brand%'])}`)).json.data.result;
    assert.equal(anchor.totalCount, idx.filter((n) => n % 4 === 0).length);
    const dom = (await section('backlinks-list', `?${filt(['domain_from', '=', 'src7.example.org'])}`)).json.data.result;
    assert.equal(dom.totalCount, idx.filter((n) => n % 300 === 7).length);
    const target = (await section('backlinks-list', `?${filt(['url_to', '=', `https://${domain}/t4/`])}`)).json.data.result;
    assert.equal(target.totalCount, idx.filter((n) => n % 9 === 4).length);
    const src = (await section('backlinks-list', `?${filt(['url_from', 'like', '%/post-99%'])}`)).json.data.result;
    assert.equal(src.totalCount, idx.filter((n) => String(n).startsWith('99')).length);
    const since = (await section('backlinks-list', `?${filt(['first_seen', '>=', '2025-10-01'])}`)).json.data.result;
    assert.equal(since.totalCount, idx.filter((n) => (n % 12) + 1 >= 10).length);
    const byDate = (await section('backlinks-list', `?order_by=first_seen,desc&order_by=rank,desc&limit=100`)).json.data.result;
    assert.ok(byDate.items.every((r, i, a) => i === 0 || a[i - 1].first_seen >= r.first_seen));
    const perDomain = (await section('backlinks-list', '?mode=one_per_domain&limit=25')).json.data.result;
    assert.equal(perDomain.totalCount, 300);
    assert.equal(new Set(perDomain.items.map((r) => r.domain_from)).size, perDomain.items.length);
    const lost = (await section('backlinks-list', '?status=lost')).json.data.result;
    assert.equal(lost.totalCount, 40);
    assert.equal(lost.items.every((r) => r.is_lost === true), true);
    // a provider continuation token is meaningless for stored rows: reported as not collected, never bought
    const withToken = await section('backlinks-list', '?token=T50');
    assert.equal(withToken.json.data.missing, true);
    assert.equal(calls.length, mark);
  });

  test('Referring domains: paging, domain search, rank, follow, sort and tabs come from MongoDB', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const mark = calls.length;
    const idx = [...Array(1200).keys()];
    const def = (await section('referring-domains')).json.data.result;
    assert.equal(def.totalCount, 1200);
    assert.ok(def.items.every((r, i, a) => i === 0 || a[i - 1].rank >= r.rank));
    assert.ok(def.items[0].quality, 'the quality computed at parse time is stored, not recomputed');
    const search = (await section('referring-domains', `?limit=100&${filt(['domain', 'like', '%ref12%'])}`)).json.data.result;
    assert.equal(search.totalCount, idx.filter((n) => `ref${n}.example.net`.includes('ref12')).length);
    const inList = (await section('referring-domains', `?${filt(['domain', 'in', ['ref5.example.net', 'ref6.example.net', 'nope.example.net']])}`)).json.data.result;
    assert.equal(inList.totalCount, 2);
    const rank = (await section('referring-domains', `?${filt(['rank', '>=', 500], ['backlinks_spam_score', '<=', 10])}`)).json.data.result;
    assert.equal(rank.totalCount, idx.filter((n) => n % 600 >= 500 && n % 70 <= 10).length);
    const byBacklinks = (await section('referring-domains', '?order_by=backlinks,asc&limit=100')).json.data.result;
    assert.ok(byBacklinks.items.every((r, i, a) => i === 0 || a[i - 1].backlinks <= r.backlinks));
    const dofollow = (await section('referring-domains', '?dofollow=1')).json.data.result;
    assert.equal(dofollow.totalCount, idx.filter((n) => !(n % 4 === 0)).length, 'domains that have at least one dofollow page');
    assert.equal((await section('referring-domains', '?status=lost')).json.data.result.totalCount, 30);
    assert.equal(calls.length, mark);
  });

  test('the dedicated /seo-datasets endpoints: search, ranges, location / device, country, dates, derived anchors and pages (zero provider requests)', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const mark = calls.length;
    const kw = (await ds('/keywords', '?q=KEYWORD 12&sort=position&dir=asc&limit=25&page=2')).json.data;
    assert.equal(kw.totalCount, 111);
    assert.equal(kw.page, 2);
    assert.equal(kw.items.length, 25);
    assert.equal((await ds('/keywords', '?location=India')).json.data.totalCount, 2500);
    assert.equal((await ds('/keywords', '?location=Elsewhere')).json.data.totalCount, 0);
    assert.equal((await ds('/keywords', '?device=desktop')).json.data.totalCount, 0, 'no device was recorded, none is claimed');
    assert.equal((await ds('/keywords', '?position_min=2&position_max=3&intent=informational')).json.data.totalCount, [...Array(2500).keys()].filter((n) => (n % 20) + 2 <= 3 && n % 2).length);
    const bl = (await ds('/backlinks', '?follow=false&anchor=brand&sort=first_seen&dir=desc')).json.data;
    assert.equal(bl.totalCount, [...Array(1500).keys()].filter((n) => n % 3 === 0 && n % 4 === 0).length);
    const rd = (await ds('/referring-domains', '?country=XX')).json.data;
    assert.equal(rd.totalCount, 0);
    assert.equal((await ds('/referring-domains', '?q=ref77&first_seen_from=2024-01-01&first_seen_to=2024-12-31')).json.data.totalCount > 0, true);
    // derived views: exact over the stored links
    const anchors = (await ds('/anchors', '?limit=25&sort=backlinks')).json.data;
    assert.equal(anchors.complete, true);
    const brand = (await ds('/anchors', '?limit=100')).json.data.items.find((a) => a.anchor === 'brand name');
    assert.equal(brand.backlinks, 375);
    assert.equal(brand.follow + brand.nofollow, 375);
    const pages = (await ds('/pages', '?limit=100')).json.data;
    assert.equal(pages.totalCount, 9);
    assert.equal(pages.items.reduce((n, p) => n + p.backlinks, 0), 1500);
    assert.equal(calls.length, mark);
  });

  test('inputs are whitelisted: unknown sorts / fields / operators / odd types are 400, and operator-looking text is only text', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const mark = calls.length;
    for (const [path, q] of [
      ['/keywords', '?sort=$where'], ['/keywords', '?dir=sideways'], ['/keywords', '?limit=999'], ['/keywords', '?position_min=abc'], ['/keywords', '?page=0'],
      ['/backlinks', '?status=all'], ['/backlinks', '?follow=maybe'], ['/backlinks', '?first_seen_from=2025-13-40'], ['/referring-domains', '?sort=password'], ['/changes', '?dataset=users'],
    ]) {
      const r = await ds(path, q);
      assert.equal(r.status, 400, `${path}${q}`);
    }
    const bad = await section('ranked-keywords', `?${filt(['$where', '=', 'x'])}`);
    assert.equal(bad.status, 400);
    const arrayInjection = await call(`/${projectA._id}/seo-datasets/keywords?q[$ne]=x`);
    assert.equal(arrayInjection.status, 400);
    const regexy = await ds('/keywords', '?q=.*');
    assert.equal(regexy.json.data.totalCount, 0, 'escaped: ".*" is literal text, not a pattern');
    assert.equal(calls.length, mark);
  });

  test('project isolation: the same domain under another owner sees none of these rows; an outsider is refused', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const mark = calls.length;
    const other = await section('ranked-keywords', '', projectB, tokenB);
    assert.equal(other.json.data.missing, true);
    assert.equal((await ds('/keywords', '', projectB, tokenB)).json.data.missing, true);
    assert.equal((await ds('/keywords', '', projectA, tokenB)).status, 403);
    assert.equal((await section('backlinks-list', '', projectA, tokenB)).status, 403);
    assert.equal((await ds('/keywords', '', projectA, null)).status, 401);
    assert.equal(calls.length, mark);
  });

  test('persisting a batch twice is idempotent (no duplicate, no overwrite)', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const scanId = new mongoose.Types.ObjectId();
    const rows = [blRaw(1, 'live'), blRaw(2, 'live')].map((r) => ({ domain_from: r.domain_from, url_from: r.url_from, url_to: r.url_to, anchor: r.anchor, item_type: r.item_type, rank: r.rank }));
    const common = { project: projectA, scanId, status: 'live', market: {}, domain, capturedAt: new Date() };
    assert.equal(await persistRows('backlinks', rows, common), 2);
    assert.equal(await persistRows('backlinks', rows, common), 0);
    assert.equal(await SeoBacklink.countDocuments({ projectId: projectA._id, scanId }), 2);
    const doc = await SeoBacklink.findOne({ projectId: projectA._id, scanId }).lean();
    assert.equal(doc.pageRank, null, 'an unavailable value is null, never 0');
    assert.equal(doc.isFollow, null);
    await SeoBacklink.deleteMany({ projectId: projectA._id, scanId });
  });

  test('a fresh dataset is not collected again by another scan (no new rows, no requests); force collects it', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const s = await scan({ scope: 'dataset', datasets: ['keywords-dataset'] });
    assert.equal(s.status, 'completed');
    assert.equal(s.providerRequestsCount, 0);
    assert.equal(calls.length, 0);
    assert.equal(await SeoKeywordRanking.countDocuments({ projectId: projectA._id }), 2500);
  });

  test('a forced scan inside the provider refresh floor buys nothing and does NOT create a new stored set or history point', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const before = await SeoKeywordRanking.countDocuments({ projectId: projectA._id });
    const s = await scan({ scope: 'dataset', datasets: ['keywords-dataset'], force: true });
    assert.equal(s.status, 'completed');
    assert.equal(s.providerRequestsCount, 0);
    assert.equal(calls.length, 0);
    assert.equal(await SeoKeywordRanking.countDocuments({ projectId: projectA._id }), before);
    assert.equal(await SeoSnapshot.countDocuments({ projectId: projectA._id, part: 'dataset:keywords' }), 1);
  });

  test('History: with ONE scan there is nothing to compare, and it says so', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    for (const dataset of ['keywords', 'backlinks', 'referring-domains']) {
      const r = (await ds('/changes', `?dataset=${dataset}`)).json.data;
      assert.equal(r.hasData, true);
      assert.equal(r.reference, null);
      assert.match(r.note, /nothing to compare/i);
      assert.equal(r.new, undefined, 'no invented zeros');
    }
  });

  test('History: a second scan stores a new set beside the first; new / lost / improved / declined come from the two stored sets, and best ranking from all of them', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    world.version = 2;
    await ageCache();
    const s = await scan({ scope: 'dataset', datasets: ['keywords-dataset'], force: true });
    assert.equal(s.status, 'completed');
    assert.equal(await SeoKeywordRanking.countDocuments({ projectId: projectA._id }), 2500 + 2495, 'the first scan\'s rows are preserved');
    const mark = calls.length;
    const r = (await ds('/changes', '?dataset=keywords&period=previous')).json.data;
    assert.equal(r.new.count, 5);
    assert.equal(r.lost.count, 10);
    assert.equal(r.improved.count, 10);
    assert.equal(r.declined.count, 5);
    assert.ok(r.improved.items.every((i) => i.position_change === 1));
    assert.equal(r.reference.rows, 2500);
    assert.equal(r.latest.rows, 2495);
    // the pages now read the newest set
    assert.equal((await section('ranked-keywords', '?limit=5')).json.data.result.items[0].keyword, 'Keyword 10');
    // a week back there is no earlier scan yet, because both were taken just now
    const week = (await ds('/changes', '?dataset=keywords&period=week')).json.data;
    assert.equal(week.reference, null);
    // age the first scan by 8 days (test setup, not a fabricated Odito record) and a week comparison finds it
    const states = await SeoSnapshot.find({ projectId: projectA._id, part: 'dataset:keywords' }).sort({ capturedAt: 1 });
    await SeoSnapshot.updateOne({ _id: states[0]._id }, { $set: { capturedAt: new Date(Date.now() - 8 * 86_400_000) } });
    const weekAgain = (await ds('/changes', '?dataset=keywords&period=week')).json.data;
    assert.equal(weekAgain.new.count, 5);
    assert.equal((await ds('/changes', '?dataset=keywords&period=month')).json.data.reference, null, 'no scan is a month old');
    const hist = (await ds('/keywords/history', '?keyword=Keyword 100')).json.data;
    assert.equal(hist.points.length, 2);
    assert.equal(hist.bestPosition, 1, 'position 2 in the first scan, 1 in the second: the best is kept');
    assert.equal(calls.length, mark);
  });

  test('Partial failure: one failing dataset leaves the others, the previous complete dataset keeps serving, and a retry runs only that dataset', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    world.failRd = true;
    await ageCache();
    const s = await scan({ scope: 'dataset', datasets: ['backlinks-dataset-live', 'referring-domains-dataset-live'], force: true });
    assert.equal(s.status, 'partially_completed');
    assert.deepEqual(s.datasets.map((d) => [d.id, d.status]), [['backlinks-dataset-live', 'completed'], ['referring-domains-dataset-live', 'failed']]);
    // the half-collected domain rows exist under the failed scan but nothing reads them: the earlier complete set still answers
    const rd = (await section('referring-domains')).json.data;
    assert.equal(rd.result.totalCount, 1200);
    assert.notEqual(rd.dataset.scanId, s.id);
    const bl = (await section('backlinks-list')).json.data;
    assert.equal(bl.dataset.scanId, s.id, 'the successful dataset of the same scan is already the latest');
    world.failRd = false; calls = [];
    const retry = await call(`/${projectA._id}/seo-scans`, { method: 'POST', body: { retryOf: s.id } });
    assert.equal(retry.status, 202);
    let latest;
    for (let i = 0; i < 200; i += 1) { latest = (await call(`/${projectA._id}/seo-scans/latest`)).json.data.scan; if (latest.status !== 'running') break; await new Promise((r) => setTimeout(r, 50)); }
    assert.equal(latest.status, 'completed');
    assert.deepEqual(latest.datasets.map((d) => d.id), ['referring-domains-dataset-live']);
    assert.ok(calls.every((c) => c.section === 'referring-domains'), 'the successful backlinks dataset is not requested again');
    assert.equal((await section('referring-domains')).json.data.dataset.scanId, latest.id);
  });

  test('a user\'s explicit refresh of one view is the newest stored answer and wins over an older collected set', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');
    const q = `?limit=25&${filt(['keyword_data.keyword', 'like', '%keyword 77%'])}`;
    const before = (await section('ranked-keywords', q)).json.data;
    assert.equal(before.source, 'database');
    const bought = await section('ranked-keywords', `${q}&refresh=1`);
    assert.equal(bought.status, 200);
    assert.ok(calls.length > 0, 'refresh is the explicit purchase');
    const mark = calls.length;
    const after = (await section('ranked-keywords', q)).json.data;
    assert.equal(after.source, undefined, 'the newer cache entry answers');
    assert.equal(calls.length, mark, 'and reading it buys nothing');
  });
});
