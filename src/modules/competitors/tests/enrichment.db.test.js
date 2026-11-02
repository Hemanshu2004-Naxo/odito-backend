import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import mongoose from 'mongoose';

/**
 * My Competitors enrichment, identity merging and the refresh API against a REAL MongoDB (same rules as myCompetitors.db.test.js: a local
 * throwaway server in COMPETITORS_TEST_MONGO_URI, never MONGO_URI, its own database dropped at the end). The provider is a fake FUNCTION
 * (no network, no money); every state change it causes is read back from the database.
 */

const URI = process.env.COMPETITORS_TEST_MONGO_URI;
if (!URI && process.env.COMPETITORS_REQUIRE_DB_TESTS === '1') throw new Error('COMPETITORS_REQUIRE_DB_TESTS=1 but COMPETITORS_TEST_MONGO_URI is not set: the database tests would be skipped.');
const SKIP = URI ? false : 'set COMPETITORS_TEST_MONGO_URI to a local throwaway MongoDB to run the database tests';
if (URI) {
  const host = /^mongodb:\/\/(\[[^\]]+\]|[^/@,?:]+)(?::\d+)?\//.exec(URI)?.[1];
  const approved = process.env.COMPETITORS_TEST_MONGO_APPROVED_HOST;
  if (!host || !(['127.0.0.1', 'localhost', '[::1]'].includes(host) || (approved && host === approved))) {
    throw new Error('COMPETITORS_TEST_MONGO_URI must point at localhost (or exactly the host named in COMPETITORS_TEST_MONGO_APPROVED_HOST): these tests write and drop data.');
  }
}
process.env.JWT_SECRET ||= 'competitors-test-secret';

const DB_NAME = `odito_competitors_enrich_test_${Date.now()}_${process.pid}`;
const oid = () => new mongoose.Types.ObjectId();
const codeOf = (fn) => fn().then(() => null, (e) => e.code ?? e.message);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ProjectCompetitor; let Usage; let svc; let store; let enrich; let sweeper; let metrics; let User; let SeoProject; let signAuthToken; let DataForSeoApiError; let server; let base;

const entry = (over = {}) => ({ name: 'Rival', domain: 'rival.com', address: null, place_id: null, source: 'manual', notes: null, ...over });
const RANK = { organic: { etv: 900, count: 120, pos_1: 5, pos_2_3: 10, pos_4_10: 30 }, paid: null };
const LINKS = { backlinks: 800, referring_domains: 90, rank: 300, first_seen: '2019-02-02' };

/** A fake provider. `fail` maps a section name to an error code; `payloads` overrides what a section returns. */
function fakeProvider({ fail = {}, payloads = {}, cached = false, hook = null } = {}) {
  const calls = [];
  const fn = async ({ domain, section, market, onProviderCall }) => {
    calls.push({ domain, section, market });
    if (hook) await hook({ domain, section });
    if (!cached) await onProviderCall?.();
    if (fail[section]) throw new DataForSeoApiError(fail[section]);
    const payload = section in payloads ? payloads[section] : section === 'rank-overview' ? RANK : LINKS;
    return { payload, fetchedAt: new Date(), cached, cost: cached ? null : 0.01 };
  };
  fn.calls = calls;
  return fn;
}

/** A fake head-to-head (domain_intersection): records every call. cached by default, so it never touches the project daily budget. */
function fakeH2H({ total = 3, keywords = null, fail = null, cached = true } = {}) {
  const calls = [];
  const kws = keywords ?? [
    { keyword: 'eye hospital parel', search_volume: 590, cpc: 0.6, competition: 0.15, project: { rank_group: 15, rank_absolute: 17, etv: 5.8, url: 'https://own-site.com/' }, competitor: { rank_group: 9, rank_absolute: 11, etv: 40, url: 'https://rival.com/x' } },
    { keyword: 'lasik mumbai', search_volume: 320, cpc: 1.2, competition: 0.4, project: { rank_group: 4, rank_absolute: 5, etv: 20, url: null }, competitor: { rank_group: 22, rank_absolute: 25, etv: 0.3, url: null } },
  ];
  const fn = async ({ projectDomain, domain, market, onProviderCall }) => {
    calls.push({ projectDomain, domain, market });
    if (!cached) await onProviderCall?.();
    if (fail) throw new DataForSeoApiError(fail);
    return { payload: { sharedTotal: total, keywords: total === null ? [] : kws.slice(0, total) }, fetchedAt: new Date(), cached, cost: cached ? null : 0.012 };
  };
  fn.calls = calls;
  return fn;
}

const cfg = (over = {}) => ({
  enabled: true, sweepEnabled: true, sweepCron: '* * * * *', leaseMs: 60_000, concurrency: 2, maxPerSweep: 4, maxAttempts: 3,
  backoffBaseMs: 1000, backoffMaxMs: 60_000, projectDailyProviderCalls: 60, refreshCooldownMs: 24 * 3600_000, staleAfterMs: 14 * 86400_000, ...over,
});

async function ownerWithProject(mainUrl = 'https://www.own-site.com/') {
  const userId = oid(); const projectId = oid();
  await User.collection.insertOne({ _id: userId, firstName: 'T', lastName: 'U', email: `${userId}@example.test`, isActive: true, roleId: 2 });
  await SeoProject.collection.insertOne({ _id: projectId, user_id: userId, main_url: mainUrl, country: 'IN', language: 'en', is_deleted: false });
  return { userId, projectId, projectIdStr: String(projectId), token: signAuthToken({ _id: userId, roleId: 2 }) };
}
async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
}
const raw = (id) => ProjectCompetitor.collection.findOne({ _id: new mongoose.Types.ObjectId(String(id)) });
/** Claims one specific project's due competitor and enriches it, as a sweeper would. */
async function claimAndRun(projectId, deps, { owner = 'worker-1', at = new Date(Date.now() + 50) } = {}) {
  const claim = await store.claimNext({ owner, now: at, leaseMs: 60_000, projectId });
  assert.ok(claim, 'something was due');
  // The head-to-head is ALWAYS a fake here: a test can never reach the real provider (and so can never spend credits).
  return { claim, result: await enrich.enrichClaimed(claim, owner, { config: cfg(), now: () => new Date(), getHeadToHead: fakeH2H(), ...deps }) };
}

describe('My Competitors enrichment, identity and refresh (real MongoDB)', { skip: SKIP }, () => {
  before(async () => {
    await mongoose.connect(URI, { dbName: DB_NAME, autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 5000 });
    ({ default: ProjectCompetitor } = await import('../model/ProjectCompetitor.js'));
    ({ default: Usage } = await import('../model/CompetitorEnrichmentUsage.js'));
    svc = await import('../service/myCompetitorsService.js');
    store = await import('../service/enrichmentStore.js');
    enrich = await import('../service/enrichmentService.js');
    sweeper = await import('../workers/enrichmentScheduler.js');
    metrics = await import('../service/enrichmentMetrics.js');
    ({ default: User } = await import('../../user/model/User.js'));
    ({ default: SeoProject } = await import('../../app_user/model/SeoProject.js'));
    ({ signAuthToken } = await import('../../user/service/tokenService.js'));
    ({ DataForSeoApiError } = await import('../../dataforseo-api/shared/providerErrors.js'));
    await Usage.createIndexes();
    svc.__resetIndexStateForTests({ retryMs: 0 });
    await svc.ensureIndexes();
    const { default: routes } = await import('../routes/myCompetitorsRoutes.js');
    const app = express(); app.use(express.json()); app.use('/api/projects', routes);
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}/api/projects`;
  });
  after(async () => {
    await new Promise((r) => (server ? server.close(r) : r()));
    if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  beforeEach(async () => { await ProjectCompetitor.collection.deleteMany({}); await Usage.collection.deleteMany({}); });

  describe('saving queues enrichment (and never calls a provider)', () => {
    test('a website is saved as pending and due now; a name-only competitor is no_website; provenance records the source', async () => {
      const projectId = oid();
      const withSite = await svc.createCompetitor({ projectId, data: entry(), userId: oid() });
      assert.equal(withSite.enrichment.status, 'pending');
      assert.deepEqual(withSite.provenance.map((p) => p.kind), ['manual']);
      const doc = await raw(withSite.id);
      assert.equal(doc.enrichment.status, 'pending');
      assert.ok(doc.enrichment.requested_at && doc.enrichment.next_attempt_at);
      assert.equal(doc.enrichment.attempts, 0);
      const nameOnly = await svc.createCompetitor({ projectId, data: entry({ name: 'No Site', domain: null }) });
      assert.equal(nameOnly.enrichment.status, 'no_website');
      assert.equal(nameOnly.enrichment.metrics.organicTraffic, null);
    });

    test('a record from Local Competitors keeps its place as the primary branch, with its coordinates and a 30-day clock', async () => {
      const projectId = oid();
      const c = await svc.createCompetitor({ projectId, data: entry({ source: 'local', place_id: 'ChIJ_A', address: '1 Main Rd Nashik' }), coords: { lat: 20.01, lng: 73.78 } });
      assert.equal(c.branches.length, 1);
      assert.deepEqual([c.branches[0].placeId, c.branches[0].lat, c.branches[0].lng], ['ChIJ_A', 20.01, 73.78]);
      await ProjectCompetitor.collection.updateOne({ _id: new mongoose.Types.ObjectId(c.id) }, { $set: { 'branches.0.coords_fetched_at': new Date(Date.now() - 31 * 86400_000) } });
      const old = await svc.getCompetitor({ projectId, id: c.id });
      assert.deepEqual([old.branches[0].lat, old.branches[0].lng], [null, null], 'coordinates older than 30 days are not used');
      assert.equal(old.branches[0].placeId, 'ChIJ_A', 'the place id is kept');
    });

    test('changing the website drops the old numbers and re-queues; clearing it marks no_website; other edits leave enrichment alone', async () => {
      const { projectId } = await ownerWithProject();
      const c = await svc.createCompetitor({ projectId, data: entry() });
      await claimAndRun(projectId, { getSection: fakeProvider() });
      assert.equal((await raw(c.id)).enrichment.status, 'enriched');

      await svc.updateCompetitor({ projectId, id: c.id, patch: { notes: 'a note' } });
      assert.equal((await raw(c.id)).enrichment.status, 'enriched', 'a note does not touch enrichment');

      const changed = await svc.updateCompetitor({ projectId, id: c.id, patch: { domain: 'other-rival.com' } });
      assert.equal(changed.enrichment.status, 'pending');
      const doc = await raw(c.id);
      assert.equal(doc.enrichment.sections, undefined, 'numbers about the old website are gone');
      assert.equal(changed.enrichment.metrics.organicTraffic, null);

      const cleared = await svc.updateCompetitor({ projectId, id: c.id, patch: { domain: null } });
      assert.equal(cleared.enrichment.status, 'no_website');
    });
  });

  describe('the queue: atomic claims and leases', () => {
    test('30 simultaneous claimers over 6 due competitors: each competitor is claimed exactly once', async () => {
      const projectId = oid();
      for (let i = 0; i < 6; i += 1) await svc.createCompetitor({ projectId, data: entry({ name: `R${i}`, domain: `r${i}.com` }) });
      const claims = await Promise.all(Array.from({ length: 30 }, (_, i) => store.claimNext({ owner: `w${i}`, now: new Date(Date.now() + 50), leaseMs: 60_000, projectId })));
      const got = claims.filter(Boolean);
      assert.equal(got.length, 6);
      assert.equal(new Set(got.map((c) => String(c._id))).size, 6, 'no competitor was handed to two workers');
      for (const c of got) assert.equal(c.enrichment.attempts, 1);
    });

    test('not-yet-due and validly leased competitors are not claimed; an expired lease is taken over', async () => {
      const projectId = oid();
      const c = await svc.createCompetitor({ projectId, data: entry() });
      const id = new mongoose.Types.ObjectId(c.id);
      await ProjectCompetitor.collection.updateOne({ _id: id }, { $set: { 'enrichment.next_attempt_at': new Date(Date.now() + 3600_000) } });
      assert.equal(await store.claimNext({ owner: 'a', now: new Date(), leaseMs: 60_000, projectId }), null, 'next attempt is in the future');
      await ProjectCompetitor.collection.updateOne({ _id: id }, { $set: { 'enrichment.next_attempt_at': new Date(Date.now() - 1000) } });
      const first = await store.claimNext({ owner: 'a', now: new Date(), leaseMs: 60_000, projectId });
      assert.equal(first.enrichment.lease_owner, 'a');
      assert.equal(await store.claimNext({ owner: 'b', now: new Date(), leaseMs: 60_000, projectId }), null, 'a valid lease is respected');
      const later = await store.claimNext({ owner: 'b', now: new Date(Date.now() + 120_000), leaseMs: 60_000, projectId });
      assert.equal(later.enrichment.lease_owner, 'b', 'the crashed worker was replaced after its lease expired');
      assert.equal(later.enrichment.attempts, 2);
    });

    test('a worker that lost its lease can neither save a section nor finish the run', async () => {
      const projectId = oid();
      const c = await svc.createCompetitor({ projectId, data: entry() });
      const id = new mongoose.Types.ObjectId(c.id);
      const mine = await store.claimNext({ owner: 'old', now: new Date(Date.now() + 10), leaseMs: 1000, projectId });
      assert.ok(mine);
      const taken = await store.claimNext({ owner: 'new', now: new Date(Date.now() + 5000), leaseMs: 60_000, projectId });
      assert.equal(taken.enrichment.lease_owner, 'new');
      assert.equal(await store.saveSection({ id, owner: 'old', key: 'rank', section: { status: 'ok', data: { organic_traffic: 1 }, fetched_at: new Date() }, now: new Date(Date.now() + 5100) }), false);
      assert.equal(await store.finishRun({ id, owner: 'old', status: 'enriched' }), false);
      const doc = await raw(c.id);
      assert.equal(doc.enrichment.status, 'processing');
      assert.equal(doc.enrichment.lease_owner, 'new');
      assert.equal(doc.enrichment.sections?.rank, undefined, 'the stale worker wrote nothing');
    });

    test('a refresh cannot interleave with a running fetch, but is allowed once the lease has expired', async () => {
      const projectId = oid();
      const c = await svc.createCompetitor({ projectId, data: entry() });
      const id = new mongoose.Types.ObjectId(c.id);
      await store.claimNext({ owner: 'a', now: new Date(Date.now() + 10), leaseMs: 60_000, projectId });
      assert.equal(await store.queueEnrichment({ id, projectId }), null);
      await ProjectCompetitor.collection.updateOne({ _id: id }, { $set: { 'enrichment.lease_until': new Date(Date.now() - 1000) } });
      assert.equal((await store.queueEnrichment({ id, projectId })).enrichment.status, 'pending');
    });
  });

  describe('the per-project daily provider budget', () => {
    test('20 simultaneous reservations against a cap of 5: exactly 5 succeed, the rest are refused, and another project is unaffected', async () => {
      const a = oid(); const b = oid();
      const results = await Promise.all(Array.from({ length: 20 }, () => store.reserveProviderCall(a, 5).then(() => 'ok', (e) => e.name)));
      assert.equal(results.filter((r) => r === 'ok').length, 5);
      assert.equal(results.filter((r) => r === 'ProviderBudgetExceeded').length, 15, JSON.stringify(results));
      assert.equal(await store.providerCallsToday(a), 5);
      await store.reserveProviderCall(b, 5);
      assert.equal(await store.providerCallsToday(b), 1);
    });
  });

  describe('enrichClaimed (fake provider, real database)', () => {
    test('success: all three sections saved, status enriched, the market recorded, the shared count and keywords stored', async () => {
      const { projectId } = await ownerWithProject();
      const c = await svc.createCompetitor({ projectId, data: entry() });
      const provider = fakeProvider();
      const { result } = await claimAndRun(projectId, { getSection: provider });
      assert.equal(result.outcome, 'enriched');
      assert.deepEqual(provider.calls.map((x) => x.section).sort(), ['backlinks', 'rank-overview']);
      assert.equal(provider.calls[0].domain, 'rival.com');
      assert.deepEqual([provider.calls[0].market.location_name, provider.calls[0].market.language_name], ['India', 'English']);
      const doc = await raw(c.id);
      const e = doc.enrichment;
      assert.equal(e.status, 'enriched');
      assert.equal(e.lease_owner, null);
      assert.ok(e.finished_at && e.last_success_at);
      assert.deepEqual(e.market, { location: 'India', language: 'English' });
      assert.equal(e.sections.rank.status, 'ok');
      assert.equal(e.sections.rank.data.organic_traffic, 900);
      assert.equal(e.sections.backlinks.data.referring_domains, 90);
      assert.equal(e.sections.shared.status, 'ok');
      assert.equal(e.sections.shared.data.shared_keywords, 3);
      assert.equal(e.sections.shared.data.keywords.length, 2);
      assert.ok(e.sections.shared.fetched_at);
      const full = await svc.getCompetitor({ projectId, id: c.id });
      assert.equal(full.enrichment.metrics.sharedKeywords, 3);
      assert.equal(full.enrichment.metrics.top10, 45);
      assert.equal(full.sharedKeywordList.total, 3);
      assert.equal(full.sharedKeywordList.keywords[0].keyword, 'eye hospital parel');
      assert.deepEqual(full.sharedKeywordList.keywords[0].project, { position: 15, url: 'https://own-site.com/', traffic: 5.8 });
      assert.deepEqual(full.sharedKeywordList.market, { location: 'India', language: 'English' });
    });

    test('the comparison is the PROJECT (own-site.com) against THIS competitor, in the project market', async () => {
      const { projectId } = await ownerWithProject();
      await svc.createCompetitor({ projectId, data: entry() });
      const h2h = fakeH2H();
      await claimAndRun(projectId, { getSection: fakeProvider(), getHeadToHead: h2h });
      assert.equal(h2h.calls.length, 1);
      assert.deepEqual([h2h.calls[0].projectDomain, h2h.calls[0].domain], ['own-site.com', 'rival.com']);
      assert.deepEqual([h2h.calls[0].market.location_name, h2h.calls[0].market.language_name], ['India', 'English']);
    });

    test('no answer for the comparison is no data, never zero, and the competitor is only partial', async () => {
      const { projectId } = await ownerWithProject();
      const c = await svc.createCompetitor({ projectId, data: entry() });
      const { result } = await claimAndRun(projectId, { getSection: fakeProvider(), getHeadToHead: fakeH2H({ total: null }) });
      assert.equal(result.outcome, 'partial');
      const dto = (await svc.getCompetitor({ projectId, id: c.id })).enrichment;
      assert.equal(dto.sections.shared.status, 'no_data');
      assert.equal(dto.metrics.sharedKeywords, null);
      assert.equal(dto.status, 'partial');
    });

    test('0 shared keywords for a competitor the provider knows is a real zero; for an unknown competitor it is no data', async () => {
      const a = await ownerWithProject();
      const ca = await svc.createCompetitor({ projectId: a.projectId, data: entry() });
      await claimAndRun(a.projectId, { getSection: fakeProvider(), getHeadToHead: fakeH2H({ total: 0 }) });
      const known = (await svc.getCompetitor({ projectId: a.projectId, id: ca.id })).enrichment;
      assert.deepEqual([known.sections.shared.status, known.metrics.sharedKeywords, known.status], ['ok', 0, 'enriched']);
      const b = await ownerWithProject();
      const cb = await svc.createCompetitor({ projectId: b.projectId, data: entry() });
      await claimAndRun(b.projectId, { getSection: fakeProvider({ payloads: { 'rank-overview': { organic: null, paid: null } } }), getHeadToHead: fakeH2H({ total: 0 }) });
      const unknown = (await svc.getCompetitor({ projectId: b.projectId, id: cb.id })).enrichment;
      assert.deepEqual([unknown.sections.shared.status, unknown.metrics.sharedKeywords], ['no_data', null]);
    });

    test('a provider failure on the comparison keeps the other sections, is retried, and finally leaves the competitor partial with a failed shared section', async () => {
      const { projectId } = await ownerWithProject();
      const c = await svc.createCompetitor({ projectId, data: entry() });
      const failing = fakeH2H({ fail: 'PROVIDER_TIMEOUT' });
      const outcomes = [];
      for (let i = 0; i < 3; i += 1) outcomes.push((await claimAndRun(projectId, { getSection: fakeProvider(), getHeadToHead: failing, config: cfg({ maxAttempts: 3, backoffBaseMs: 0 }) }, { at: new Date(Date.now() + (i + 1) * 60_000) })).result.outcome);
      assert.deepEqual(outcomes, ['retry', 'retry', 'partial']);
      const dto = (await svc.getCompetitor({ projectId, id: c.id })).enrichment;
      assert.equal(dto.sections.shared.status, 'failed');
      assert.equal(dto.metrics.sharedKeywords, null);
      assert.equal(dto.metrics.organicTraffic, 900);
      assert.equal(dto.status, 'partial');
    });

    test('an older competitor finished without the comparison is queued again and ONLY the comparison is fetched', async () => {
      const { projectId } = await ownerWithProject();
      const c = await svc.createCompetitor({ projectId, data: entry() });
      await claimAndRun(projectId, { getSection: fakeProvider(), getHeadToHead: fakeH2H() });
      await ProjectCompetitor.collection.updateOne({ _id: new mongoose.Types.ObjectId(c.id) }, { $set: { 'enrichment.sections.shared': { status: 'not_configured', data: null, error_code: 'HEAD_TO_HEAD_ENDPOINT_NOT_CONFIGURED' } } });
      assert.equal((await svc.getCompetitor({ projectId, id: c.id })).enrichment.status, 'partial');
      assert.equal(await store.requeueMissingShared({ projectId }), 1);
      assert.equal(await store.requeueMissingShared({ projectId }), 0);
      const provider = fakeProvider(); const h2h = fakeH2H({ total: 7, keywords: [] });
      const { result } = await claimAndRun(projectId, { getSection: provider, getHeadToHead: h2h });
      assert.equal(result.outcome, 'enriched');
      assert.equal(provider.calls.length, 0);
      assert.equal(h2h.calls.length, 1);
      assert.equal((await svc.getCompetitor({ projectId, id: c.id })).enrichment.metrics.sharedKeywords, 7);
    });

    test('a domain the provider knows nothing about is no_data with null metrics (never zeros), status no_data', async () => {
      const { projectId } = await ownerWithProject();
      const c = await svc.createCompetitor({ projectId, data: entry() });
      await claimAndRun(projectId, { getSection: fakeProvider({ payloads: { 'rank-overview': { organic: null, paid: null }, backlinks: { backlinks: 0, referring_domains: 0, rank: 0, first_seen: null } } }), getHeadToHead: fakeH2H({ total: 0 }) });
      const dto = (await svc.getCompetitor({ projectId, id: c.id })).enrichment;
      assert.equal(dto.status, 'no_data');
      assert.deepEqual([dto.sections.rank.status, dto.sections.backlinks.status, dto.sections.shared.status], ['no_data', 'no_data', 'no_data']);
      for (const v of Object.values(dto.metrics)) assert.equal(v, null);
    });

    test('one section failing keeps the other, schedules a retry with backoff, and the retry only re-fetches the failed section', async () => {
      const { projectId } = await ownerWithProject();
      const c = await svc.createCompetitor({ projectId, data: entry() });
      const first = fakeProvider({ fail: { backlinks: 'PROVIDER_TIMEOUT' } });
      const { result } = await claimAndRun(projectId, { getSection: first });
      assert.equal(result.outcome, 'retry');
      let doc = await raw(c.id);
      assert.equal(doc.enrichment.status, 'pending');
      assert.equal(doc.enrichment.attempts, 1);
      assert.equal(doc.enrichment.sections.rank.status, 'ok', 'the successful section was saved and kept');
      assert.equal(doc.enrichment.sections.backlinks.status, 'failed');
      assert.equal(doc.enrichment.sections.backlinks.error_code, 'PROVIDER_TIMEOUT');
      assert.equal(doc.enrichment.last_error_code, 'PROVIDER_TIMEOUT');
      assert.ok(doc.enrichment.next_attempt_at > new Date(), 'backoff pushed the next attempt into the future');
      assert.equal(await store.claimNext({ owner: 'x', now: new Date(), leaseMs: 1000, projectId }), null, 'not due yet');

      const second = fakeProvider();
      const { result: r2 } = await claimAndRun(projectId, { getSection: second }, { at: new Date(Date.now() + 10 * 60_000) });
      assert.equal(r2.outcome, 'enriched');
      assert.deepEqual(second.calls.map((x) => x.section), ['backlinks'], 'rank was fresh from this request cycle: not bought again');
      doc = await raw(c.id);
      assert.equal(doc.enrichment.attempts, 2);
      assert.equal(doc.enrichment.sections.backlinks.status, 'ok');
    });

    test('when the attempts are used up the failure is final: failed if nothing succeeded', async () => {
      const { projectId } = await ownerWithProject();
      const c = await svc.createCompetitor({ projectId, data: entry() });
      const failing = fakeProvider({ fail: { 'rank-overview': 'PROVIDER_UNAVAILABLE', backlinks: 'PROVIDER_UNAVAILABLE' } });
      const outcomes = [];
      const failingH2H = fakeH2H({ fail: 'PROVIDER_UNAVAILABLE' });
      for (let i = 0; i < 3; i += 1) outcomes.push((await claimAndRun(projectId, { getSection: failing, getHeadToHead: failingH2H, config: cfg({ maxAttempts: 3, backoffBaseMs: 0 }) }, { at: new Date(Date.now() + 1000 * (i + 1)) })).result.outcome);
      assert.deepEqual(outcomes, ['retry', 'retry', 'failed']);
      const doc = await raw(c.id);
      assert.equal(doc.enrichment.status, 'failed');
      assert.equal(doc.enrichment.attempts, 3);
      assert.equal(await store.claimNext({ owner: 'x', now: new Date(Date.now() + 3600_000), leaseMs: 1000, projectId }), null, 'a final failure is not picked up again');
    });

    test('a failure that waiting cannot fix is final at once', async () => {
      const { projectId } = await ownerWithProject();
      const c = await svc.createCompetitor({ projectId, data: entry() });
      const { result } = await claimAndRun(projectId, { getSection: fakeProvider({ fail: { backlinks: 'PROVIDER_REQUEST_REJECTED' } }) });
      assert.equal(result.outcome, 'partial');
      assert.equal((await raw(c.id)).enrichment.attempts, 1);
    });

    test('the daily budget stops the run before the call is bought, waits an hour, and gives the attempt back', async () => {
      const { projectId } = await ownerWithProject();
      const c = await svc.createCompetitor({ projectId, data: entry() });
      const provider = fakeProvider();
      const { result } = await claimAndRun(projectId, { getSection: provider, config: cfg({ projectDailyProviderCalls: 1 }) });
      assert.equal(result.outcome, 'budget');
      const doc = await raw(c.id);
      assert.equal(doc.enrichment.status, 'pending');
      assert.equal(doc.enrichment.attempts, 0, 'a budget wait is not a failed attempt');
      assert.equal(doc.enrichment.last_error_code, 'PROJECT_BUDGET_EXCEEDED');
      assert.equal(doc.enrichment.sections.rank.status, 'ok', 'what was bought before the limit is kept');
      assert.equal(doc.enrichment.sections.backlinks, undefined);
      assert.ok(doc.enrichment.next_attempt_at.getTime() > Date.now() + 50 * 60_000);
      assert.equal(provider.calls.length, 2, 'the second call was attempted but cancelled before it was bought');
      assert.equal(await store.providerCallsToday(projectId), 1);
    });

    test('a cache hit costs no budget (the reservation only happens when a real call is bought)', async () => {
      const { projectId } = await ownerWithProject();
      await svc.createCompetitor({ projectId, data: entry() });
      await claimAndRun(projectId, { getSection: fakeProvider({ cached: true }), config: cfg({ projectDailyProviderCalls: 1 }) });
      assert.equal(await store.providerCallsToday(projectId), 0);
    });

    test('a competitor can never be compared with the project itself', async () => {
      const { projectId } = await ownerWithProject('https://own-site.com');
      const c = await svc.createCompetitor({ projectId, data: entry({ domain: 'own-site.com' }) }); // bypasses the route's own-domain check on purpose
      const provider = fakeProvider();
      const { result } = await claimAndRun(projectId, { getSection: provider });
      assert.equal(result.outcome, 'own_domain');
      assert.equal(provider.calls.length, 0, 'no provider call for the project\'s own site');
      assert.equal((await raw(c.id)).enrichment.last_error_code, 'OWN_DOMAIN');
    });

    test('a worker that loses its lease in the middle stops, and the new owner\'s state is not overwritten', async () => {
      const { projectId } = await ownerWithProject();
      const c = await svc.createCompetitor({ projectId, data: entry() });
      const id = new mongoose.Types.ObjectId(c.id);
      const hook = async ({ section }) => {
        if (section === 'backlinks') await ProjectCompetitor.collection.updateOne({ _id: id }, { $set: { 'enrichment.lease_owner': 'someone-else' } });
      };
      const { result } = await claimAndRun(projectId, { getSection: fakeProvider({ hook }) });
      assert.equal(result.outcome, 'lease_lost');
      const doc = await raw(c.id);
      assert.equal(doc.enrichment.lease_owner, 'someone-else');
      assert.equal(doc.enrichment.status, 'processing');
      assert.equal(doc.enrichment.sections.backlinks, undefined, 'the stale write was refused');
    });

    test('a deleted project fails the run safely', async () => {
      const { projectId } = await ownerWithProject();
      await SeoProject.collection.updateOne({ _id: projectId }, { $set: { is_deleted: true } });
      const c = await svc.createCompetitor({ projectId, data: entry() });
      const { result } = await claimAndRun(projectId, { getSection: fakeProvider() });
      assert.equal(result.outcome, 'project_unavailable');
      assert.equal((await raw(c.id)).enrichment.status, 'failed');
    });
  });

  describe('the sweeper', () => {
    test('the kill switch stops everything; a sweep starts at most maxPerSweep and runs at most `concurrency` at once', async () => {
      const projectId = oid();
      for (let i = 0; i < 8; i += 1) await svc.createCompetitor({ projectId, data: entry({ name: `S${i}`, domain: `s${i}.com` }) });
      const off = await sweeper.runOnce({ config: cfg({ enabled: false }), claim: () => assert.fail('must not claim'), enrich: () => assert.fail('must not enrich') });
      assert.deepEqual(off, { claimed: 0, outcomes: {} });

      let running = 0; let peak = 0;
      const enrichSlow = async () => { running += 1; peak = Math.max(peak, running); await sleep(40); running -= 1; return { outcome: 'enriched' }; };
      const claim = (a) => store.claimNext({ ...a, projectId });
      const sum = await sweeper.runOnce({ config: cfg({ concurrency: 2, maxPerSweep: 5 }), now: () => new Date(Date.now() + 50), claim, enrich: enrichSlow });
      assert.equal(sum.claimed, 5, 'maxPerSweep bounds a sweep');
      assert.ok(peak <= 2 && peak >= 1, `at most 2 at once, saw ${peak}`);
    });

    test('crash recovery: a competitor left `processing` by a dead worker is re-claimed and finished by the next sweep', async () => {
      const { projectId } = await ownerWithProject();
      const c = await svc.createCompetitor({ projectId, data: entry() });
      await store.claimNext({ owner: 'dead-worker', now: new Date(Date.now() + 10), leaseMs: 1000, projectId }); // ...and then it crashes
      assert.equal((await raw(c.id)).enrichment.status, 'processing');
      const provider = fakeProvider();
      const sum = await sweeper.runOnce({
        config: cfg(), now: () => new Date(Date.now() + 10_000), // the dead worker's lease has long expired
        claim: (a) => store.claimNext({ ...a, projectId }),
        enrich: (claim, owner) => enrich.enrichClaimed(claim, owner, { getSection: provider, getHeadToHead: fakeH2H(), config: cfg() }),
      });
      assert.equal(sum.claimed, 1);
      const doc = await raw(c.id);
      assert.equal(doc.enrichment.status, 'enriched');
      assert.equal(doc.enrichment.attempts, 2);
    });

    test('two sweepers at once never enrich the same competitor twice', async () => {
      const { projectId } = await ownerWithProject();
      for (let i = 0; i < 4; i += 1) await svc.createCompetitor({ projectId, data: entry({ name: `D${i}`, domain: `d${i}.com` }) });
      const provider = fakeProvider();
      const run = (owner) => sweeper.runOnce({
        config: cfg({ maxPerSweep: 10, concurrency: 3 }), owner, now: () => new Date(Date.now() + 50),
        claim: (a) => store.claimNext({ ...a, projectId }),
        enrich: (claim, o) => enrich.enrichClaimed(claim, o, { getSection: provider, getHeadToHead: fakeH2H(), config: cfg() }),
      });
      const [a, b] = await Promise.all([run('sweeper-a'), run('sweeper-b')]);
      assert.equal(a.claimed + b.claimed, 4);
      assert.equal(provider.calls.filter((x) => x.section === 'rank-overview').length, 4, 'exactly one rank call per competitor');
    });
  });

  describe('manual refresh', () => {
    test('rules: no website, already queued, running, cool-down, and the cases where it is allowed', async () => {
      const projectId = oid();
      const nameOnly = await svc.createCompetitor({ projectId, data: entry({ name: 'No site', domain: null }) });
      assert.equal(await codeOf(() => svc.refreshEnrichment({ projectId, id: nameOnly.id })), 'NO_WEBSITE');

      const c = await svc.createCompetitor({ projectId, data: entry() });
      const queued = await svc.refreshEnrichment({ projectId, id: c.id });
      assert.equal(queued.enrichment.status, 'pending', 'an already queued competitor is returned as is');

      await store.claimNext({ owner: 'w', now: new Date(Date.now() + 10), leaseMs: 60_000, projectId });
      assert.equal(await codeOf(() => svc.refreshEnrichment({ projectId, id: c.id })), 'ENRICHMENT_IN_PROGRESS');

      const id = new mongoose.Types.ObjectId(c.id);
      await ProjectCompetitor.collection.updateOne({ _id: id }, { $set: { 'enrichment.status': 'enriched', 'enrichment.lease_owner': null, 'enrichment.lease_until': null, 'enrichment.finished_at': new Date(), 'enrichment.last_success_at': new Date() } });
      const err = await svc.refreshEnrichment({ projectId, id: c.id }).catch((e) => e);
      assert.equal(err.code, 'REFRESH_COOLDOWN');
      assert.ok(err.retryAfterSeconds > 80_000, 'about a day is left');

      await ProjectCompetitor.collection.updateOne({ _id: id }, { $set: { 'enrichment.finished_at': new Date(Date.now() - 2 * 86400_000) } });
      assert.equal((await svc.refreshEnrichment({ projectId, id: c.id })).enrichment.status, 'pending', 'after the cool-down');

      await ProjectCompetitor.collection.updateOne({ _id: id }, { $set: { 'enrichment.status': 'failed', 'enrichment.finished_at': new Date(), 'enrichment.last_success_at': null } });
      assert.equal((await svc.refreshEnrichment({ projectId, id: c.id })).enrichment.status, 'pending', 'a failed run may be retried at once');
    });

    test('a record saved before enrichment existed is not_started, is never fetched on its own, and can be queued by the user', async () => {
      const projectId = oid();
      await ProjectCompetitor.collection.insertOne({ project_id: projectId, slot: 0, name: 'Old', domain: 'old-rival.com', source: 'manual', createdAt: new Date(), updatedAt: new Date() });
      const [listed] = await svc.listCompetitors(projectId);
      assert.equal(listed.enrichment.status, 'not_started');
      assert.equal(await store.claimNext({ owner: 'w', now: new Date(Date.now() + 1000), leaseMs: 1000, projectId }), null, 'nothing queues it automatically');
      assert.equal((await svc.refreshEnrichment({ projectId, id: listed.id })).enrichment.status, 'pending');
    });
  });

  describe('identity: one record per business, however it was found', () => {
    const local = (over = {}) => ({ name: 'City Eye Hospital', domain: 'cityeye.in', address: '1 Main Rd Nashik', place_id: 'PLACE_1', lat: 20.0, lng: 73.78, source: 'local', ...over });

    test('the same place added again from another source is merged: one record, both sources in its provenance', async () => {
      const projectId = oid();
      const a = await svc.addDiscovered({ projectId, candidate: local() });
      assert.equal(a.created, true);
      const b = await svc.addDiscovered({ projectId, candidate: local({ source: 'seo', lat: undefined, lng: undefined }) });
      assert.equal(b.created, false);
      assert.equal(b.competitor.id, a.competitor.id);
      assert.deepEqual(b.competitor.provenance.map((p) => p.kind).sort(), ['local', 'seo']);
      assert.equal(await ProjectCompetitor.countDocuments({ project_id: projectId }), 1);
      assert.equal(b.competitor.source, 'local', 'the original source is preserved');
    });

    test('the same website found as an SEO domain matches an existing manual record, keeping its notes', async () => {
      const projectId = oid();
      const manual = await svc.createCompetitor({ projectId, data: entry({ name: 'My name for them', domain: 'cityeye.in', notes: 'the big one' }) });
      const r = await svc.addDiscovered({ projectId, candidate: { name: 'City Eye Hospital', domain: 'cityeye.in', source: 'seo' } });
      assert.equal(r.created, false);
      assert.equal(r.competitor.id, manual.id);
      assert.equal(r.competitor.name, 'My name for them');
      assert.equal(r.competitor.notes, 'the big one');
      assert.deepEqual(r.competitor.provenance.map((p) => p.kind).sort(), ['manual', 'seo']);
    });

    test('another physical place with the SAME website becomes a branch of the same record, not a second record', async () => {
      const projectId = oid();
      const a = await svc.addDiscovered({ projectId, candidate: local() });
      const b = await svc.addDiscovered({ projectId, candidate: local({ place_id: 'PLACE_2', address: '9 College Rd Nashik', lat: 20.02, lng: 73.8 }) });
      assert.equal(b.created, false);
      assert.equal(b.competitor.id, a.competitor.id);
      assert.deepEqual(b.competitor.branches.map((x) => x.placeId), ['PLACE_1', 'PLACE_2']);
      assert.equal(await ProjectCompetitor.countDocuments({ project_id: projectId }), 1);
    });

    test('two different places with the same NAME and no shared website stay two records (never merged on a name)', async () => {
      const projectId = oid();
      await svc.addDiscovered({ projectId, candidate: local({ domain: null, place_id: 'P_A', address: '1 Main Rd Nashik' }) });
      await svc.addDiscovered({ projectId, candidate: local({ domain: null, place_id: 'P_B', address: '9 College Rd Nashik' }) });
      assert.equal(await ProjectCompetitor.countDocuments({ project_id: projectId }), 2);
    });

    test('a record with no place and no website matches only an exact name + specific address', async () => {
      const projectId = oid();
      const a = await svc.addDiscovered({ projectId, candidate: { name: 'Corner Clinic', address: '12 Main Rd Nashik', source: 'manual' } });
      const same = await svc.addDiscovered({ projectId, candidate: { name: 'CORNER  clinic', address: '12, main rd, nashik', source: 'seo' } });
      assert.equal(same.created, false);
      assert.equal(same.competitor.id, a.competitor.id);
      const other = await svc.addDiscovered({ projectId, candidate: { name: 'Corner Clinic', address: '77 Park St Pune', source: 'manual' } });
      assert.equal(other.created, true);
    });

    test('a website learnt later fills a missing one and queues enrichment', async () => {
      const projectId = oid();
      const a = await svc.addDiscovered({ projectId, candidate: local({ domain: null }) });
      assert.equal(a.competitor.enrichment.status, 'no_website');
      const b = await svc.addDiscovered({ projectId, candidate: local({ domain: 'cityeye.in', source: 'seo' }) });
      assert.equal(b.created, false);
      assert.equal(b.competitor.domain, 'cityeye.in');
      assert.equal(b.competitor.enrichment.status, 'pending');
    });

    test('12 simultaneous adds of the same business create exactly one record', async () => {
      const projectId = oid();
      const results = await Promise.all(Array.from({ length: 12 }, () => svc.addDiscovered({ projectId, candidate: local() })));
      assert.equal(results.filter((r) => r.created).length, 1);
      assert.equal(await ProjectCompetitor.countDocuments({ project_id: projectId }), 1);
      assert.equal(new Set(results.map((r) => r.competitor.id)).size, 1);
    });

    test('a place already attached to a record cannot be attached to another one (the database refuses it)', async () => {
      const projectId = oid();
      await svc.addDiscovered({ projectId, candidate: local({ domain: 'one.in', place_id: 'SHARED_PLACE' }) });
      const two = await svc.addDiscovered({ projectId, candidate: local({ domain: 'two.in', place_id: 'PLACE_X', name: 'Two' }) });
      const err = await ProjectCompetitor.collection.updateOne({ _id: new mongoose.Types.ObjectId(two.competitor.id) }, { $push: { branches: { place_id: 'SHARED_PLACE' } } }).catch((e) => e);
      assert.equal(err.code, 11000);
    });

    test('the project\'s own website is never added, and other projects keep their own records', async () => {
      const a = oid(); const b = oid();
      assert.equal(await codeOf(() => svc.addDiscovered({ projectId: a, projectDomain: 'own.com', candidate: local({ domain: 'own.com' }) })), 'OWN_DOMAIN');
      const first = await svc.addDiscovered({ projectId: a, candidate: local() });
      const second = await svc.addDiscovered({ projectId: b, candidate: local() });
      assert.equal(first.created && second.created, true);
      assert.notEqual(first.competitor.id, second.competitor.id);
    });
  });

  describe('API: details and refresh', () => {
    test('details return one competitor (no provider call); refresh answers 202 then 409/429 by the rules; other users and projects are refused', async () => {
      const a = await ownerWithProject('https://own-a.com'); const b = await ownerWithProject('https://own-b.com');
      const made = await call('POST', `/${a.projectIdStr}/my-competitors`, { token: a.token, body: { name: 'Rival', domain: 'rival.com' } });
      assert.equal(made.status, 201);
      const id = made.body.data.competitor.id;
      assert.equal(made.body.data.competitor.enrichment.status, 'pending');
      assert.equal(made.body.data.competitor.provenance[0].kind, 'manual');

      const one = await call('GET', `/${a.projectIdStr}/my-competitors/${id}`, { token: a.token });
      assert.equal(one.status, 200);
      assert.equal(one.body.data.competitor.id, id);
      assert.equal(one.body.data.competitor.enrichment.metrics.organicTraffic, null);

      const again = await call('POST', `/${a.projectIdStr}/my-competitors/${id}/refresh`, { token: a.token });
      assert.equal(again.status, 202, 'already queued: returned as is');

      assert.equal((await call('GET', `/${a.projectIdStr}/my-competitors/${id}`, { token: b.token })).status, 403);
      assert.equal((await call('POST', `/${a.projectIdStr}/my-competitors/${id}/refresh`, { token: b.token })).status, 403);
      assert.equal((await call('GET', `/${b.projectIdStr}/my-competitors/${id}`, { token: b.token })).status, 404, 'a competitor is only reachable through its own project');
      assert.equal((await call('POST', `/${b.projectIdStr}/my-competitors/${id}/refresh`, { token: b.token })).status, 404);
      assert.equal((await call('GET', `/${a.projectIdStr}/my-competitors/${id}`)).status, 401);
      assert.equal((await call('GET', `/${a.projectIdStr}/my-competitors/not-an-id`, { token: a.token })).status, 400);

      await ProjectCompetitor.collection.updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: { 'enrichment.status': 'enriched', 'enrichment.finished_at': new Date(), 'enrichment.last_success_at': new Date() } });
      const cool = await call('POST', `/${a.projectIdStr}/my-competitors/${id}/refresh`, { token: a.token });
      assert.equal(cool.status, 429);
      assert.equal(cool.body.code, 'REFRESH_COOLDOWN');
      assert.ok(Number(cool.headers.get('retry-after')) > 0);

      const nameOnly = await call('POST', `/${a.projectIdStr}/my-competitors`, { token: a.token, body: { name: 'No site' } });
      const nr = await call('POST', `/${a.projectIdStr}/my-competitors/${nameOnly.body.data.competitor.id}/refresh`, { token: a.token });
      assert.deepEqual([nr.status, nr.body.code], [400, 'NO_WEBSITE']);
    });

    test('adding a discovered business merges the same business instead of duplicating it (201 created, 200 merged), per project', async () => {
      const a = await ownerWithProject('https://own-d.com'); const b = await ownerWithProject('https://own-e.com');
      const p = `/${a.projectIdStr}/my-competitors/discovered`;
      assert.equal((await call('POST', p, { body: { source: 'seo', domain: 'rival-d.com' } })).status, 401);
      assert.equal((await call('POST', p, { token: b.token, body: { source: 'seo', domain: 'rival-d.com' } })).status, 403);

      const seo = await call('POST', p, { token: a.token, body: { source: 'seo', domain: 'https://www.Rival-D.com/about', name: 'Rival D' } });
      assert.deepEqual([seo.status, seo.body.data.created, seo.body.data.competitor.source], [201, true, 'seo']);
      assert.equal(seo.body.data.competitor.enrichment.status, 'pending');

      const local = await call('POST', p, { token: a.token, body: { source: 'local', name: 'Rival D (Nashik)', domain: 'rival-d.com', placeId: 'PLACE_D1', address: '1 Main Rd Nashik', lat: 20.0, lng: 73.78 } });
      assert.deepEqual([local.status, local.body.data.created], [200, false]);
      assert.equal(local.body.data.competitor.id, seo.body.data.competitor.id);
      assert.deepEqual(local.body.data.competitor.provenance.map((x) => x.kind).sort(), ['local', 'seo']);
      assert.equal(local.body.data.competitor.branches[0].placeId, 'PLACE_D1');

      const branch = await call('POST', p, { token: a.token, body: { source: 'local', name: 'Rival D (Pune)', domain: 'rival-d.com', placeId: 'PLACE_D2', address: '9 FC Rd Pune' } });
      assert.deepEqual([branch.status, branch.body.data.competitor.branches.map((x) => x.placeId)], [200, ['PLACE_D1', 'PLACE_D2']]);
      assert.equal(await ProjectCompetitor.countDocuments({ project_id: a.projectId }), 1);

      assert.equal((await call('POST', p, { token: a.token, body: { source: 'seo', domain: 'own-d.com' } })).body.code, 'OWN_DOMAIN');
      assert.equal((await call('POST', p, { token: a.token, body: { source: 'manual', domain: 'x.com' } })).status, 400);
      assert.equal((await call('POST', p, { token: a.token, body: { source: 'local', name: 'No place' } })).status, 400);
      const other = await call('POST', `/${b.projectIdStr}/my-competitors/discovered`, { token: b.token, body: { source: 'seo', domain: 'rival-d.com' } });
      assert.deepEqual([other.status, other.body.data.created], [201, true], 'another project keeps its own record of the same site');
    });

    test('the place of a competitor cannot be changed through PATCH, and an edit of the website re-queues', async () => {
      const a = await ownerWithProject('https://own-c.com');
      const made = await call('POST', `/${a.projectIdStr}/my-competitors`, { token: a.token, body: { name: 'Rival', domain: 'rival-c.com', placeId: 'PLACE_C' } });
      const id = made.body.data.competitor.id;
      assert.equal(made.body.data.competitor.branches[0].placeId, 'PLACE_C');
      const bad = await call('PATCH', `/${a.projectIdStr}/my-competitors/${id}`, { token: a.token, body: { placeId: 'OTHER' } });
      assert.equal(bad.status, 400, 'a body with only the place id is "nothing to change"');
      const edited = await call('PATCH', `/${a.projectIdStr}/my-competitors/${id}`, { token: a.token, body: { name: 'Rival 2', placeId: 'OTHER', domain: 'rival-c2.com' } });
      assert.equal(edited.status, 200);
      const doc = await raw(id);
      assert.equal(doc.place_id, 'PLACE_C', 'the place was not changed');
      assert.equal(edited.body.data.competitor.enrichment.status, 'pending');
    });
  });
});
