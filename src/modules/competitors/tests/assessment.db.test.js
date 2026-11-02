import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import mongoose from 'mongoose';

/**
 * Business-relevance assessments against a REAL MongoDB (local throwaway server in COMPETITORS_TEST_MONGO_URI, never MONGO_URI; own
 * database, dropped at the end). The website fetch is a fake FUNCTION (no network); the queue, the facts cache, the overrides and the
 * routes run for real.
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

const DB_NAME = `odito_competitors_assess_test_${Date.now()}_${process.pid}`;
const oid = () => new mongoose.Types.ObjectId();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let Assessment; let Profile; let store; let service; let worker; let classifier; let myService; let User; let SeoProject; let signAuthToken; let server; let base;

const hospitalHtml = ({ city = 'Nashik', country = 'IN', title = 'ASG Eye Hospital - Cataract and LASIK' } = {}) => `<html><head><title>${title}</title>
  <script type="application/ld+json">${JSON.stringify({ '@type': 'Hospital', name: 'ASG', telephone: '1', address: { addressLocality: city, addressRegion: 'Maharashtra', addressCountry: country } })}</script></head>
  <body><h1>Eye hospital</h1><p>cataract surgery lasik retina book appointment ${'x '.repeat(80)}</p></body></html>`;

/** A fake website fetcher: domain -> facts. Counts every request. */
function fakeFetcher(map) {
  const calls = [];
  const fn = async (domain) => { calls.push(domain); const f = map[domain]; return typeof f === 'function' ? f() : f ?? { fetched: false, version: 1, error: 'NETWORK' }; };
  fn.calls = calls;
  return fn;
}
const readFacts = async (domain, now) => (await Profile.findOne({ domain, expires_at: { $gt: now } }).lean())?.facts ?? null;
const writeFacts = async (domain, facts, now) => Profile.updateOne({ domain }, { $set: { facts, fetched_at: now, expires_at: new Date(now.getTime() + (facts.fetched ? 30 * 864e5 : 6 * 3600e3)) } }, { upsert: true });

async function ownerWithProject(over = {}) {
  const userId = oid(); const projectId = oid();
  await User.collection.insertOne({ _id: userId, firstName: 'T', lastName: 'U', email: `${userId}@example.test`, isActive: true, roleId: 2 });
  await SeoProject.collection.insertOne({
    _id: projectId, user_id: userId, main_url: 'https://www.krishnaeyecentre.com/', country: 'IN', language: 'en', is_deleted: false,
    industry: 'healthcare', sub_industry: 'eye hospital', seo_scope: 'local', target_city: 'Nashik', target_state: 'Maharashtra',
    visibility_profile: { services: ['cataract surgery', 'LASIK'] }, ...over,
  });
  return { userId, projectId, projectIdStr: String(projectId), token: signAuthToken({ _id: userId, roleId: 2 }) };
}
async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const dbDoc = (projectId, domain) => Assessment.collection.findOne({ project_id: new mongoose.Types.ObjectId(String(projectId)), domain });
/** Claims one project's due assessment and runs it with the fake fetcher. */
async function claimAndAssess(projectId, fetcher, extra = {}) {
  const claim = await store.claimNextAssessment({ owner: 'w1', now: new Date(Date.now() + 50), leaseMs: 60_000, projectId });
  assert.ok(claim, 'an assessment was due');
  return service.assessClaimed(claim, 'w1', { fetchFacts: fetcher, readFacts, writeFacts, ...extra });
}

describe('Competitor relevance assessments (real MongoDB)', { skip: SKIP }, () => {
  before(async () => {
    await mongoose.connect(URI, { dbName: DB_NAME, autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 5000 });
    ({ default: Assessment } = await import('../model/CompetitorAssessment.js'));
    ({ default: Profile } = await import('../model/CompetitorDomainProfile.js'));
    store = await import('../service/assessmentStore.js');
    service = await import('../service/assessmentService.js');
    worker = await import('../workers/assessmentWorker.js');
    classifier = await import('../service/relevanceClassifier.js');
    myService = await import('../service/myCompetitorsService.js');
    ({ default: User } = await import('../../user/model/User.js'));
    ({ default: SeoProject } = await import('../../app_user/model/SeoProject.js'));
    ({ signAuthToken } = await import('../../user/service/tokenService.js'));
    const { extractSiteFacts } = await import('../service/siteFacts.js');
    globalThis.__extract = extractSiteFacts;
    myService.__resetIndexStateForTests({ retryMs: 0 });
    await myService.ensureIndexes();
    const { default: routes } = await import('../routes/assessmentRoutes.js');
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
  beforeEach(async () => { await Assessment.collection.deleteMany({}); await Profile.collection.deleteMany({}); store.__resetAssessmentGateForTests(); });

  describe('the unique index and the queue', () => {
    test('the unique (project, domain) index exists, and without it nothing is queued', async () => {
      await store.ensureAssessmentIndexes();
      const idx = (await Assessment.collection.indexes()).find((i) => i.name === 'project_competitor_assessment_unique');
      assert.deepEqual([idx.key, idx.unique], [{ project_id: 1, domain: 1 }, true]);
      const err = await Assessment.collection.insertMany([{ project_id: oid(), domain: 'a.com' }, { project_id: new mongoose.Types.ObjectId('000000000000000000000001'), domain: 'z.com' }]).then(() => null, (e) => e);
      assert.equal(err, null);
      const p = oid();
      await Assessment.collection.insertOne({ project_id: p, domain: 'dup.com' });
      assert.equal((await Assessment.collection.insertOne({ project_id: p, domain: 'dup.com' }).catch((e) => e)).code, 11000);
    });

    test('20 simultaneous requests for the same domain make exactly one record', async () => {
      const projectId = oid();
      await Promise.all(Array.from({ length: 20 }, () => store.requestAssessments({ projectId, domains: ['rival.com'] })));
      assert.equal(await Assessment.countDocuments({ project_id: projectId }), 1);
    });

    test('missing domains are queued; fresh ones are left alone; stale ones, and `force`, are queued again; queued ones are not queued twice', async () => {
      const projectId = oid();
      const first = await store.requestAssessments({ projectId, domains: ['a.com', 'b.com'] });
      assert.deepEqual(first.map((d) => d.status).sort(), ['pending', 'pending']);
      // finish a.com as fresh
      await Assessment.collection.updateOne({ project_id: projectId, domain: 'a.com' }, { $set: { status: 'done', auto: { class: 'direct_competitor', confidence: 0.9, level: 'high', reasons: [], rules_version: classifier.RULES_VERSION, registry_version: (await import('../config/domainRegistry.js')).REGISTRY_VERSION, fetch_failed: false, assessed_at: new Date() } } });
      const again = await store.requestAssessments({ projectId, domains: ['a.com', 'b.com', 'c.com'] });
      const by = Object.fromEntries(again.map((d) => [d.domain, d.status]));
      assert.deepEqual(by, { 'a.com': 'done', 'b.com': 'pending', 'c.com': 'pending' });
      const forced = await store.requestAssessments({ projectId, domains: ['a.com'], force: true });
      assert.equal(forced[0].status, 'pending');
      assert.equal(forced[0].auto.class, 'direct_competitor', 'the previous result stays visible while it is redone');
    });

    test('30 simultaneous claimers over 5 due assessments: each is claimed once', async () => {
      const projectId = oid();
      await store.requestAssessments({ projectId, domains: ['a.com', 'b.com', 'c.com', 'd.com', 'e.com'] });
      const got = (await Promise.all(Array.from({ length: 30 }, (_, i) => store.claimNextAssessment({ owner: `w${i}`, now: new Date(Date.now() + 50), leaseMs: 60_000, projectId })))).filter(Boolean);
      assert.equal(got.length, 5);
      assert.equal(new Set(got.map((g) => String(g._id))).size, 5);
    });

    test('a worker that lost its lease writes nothing; a crashed worker\'s assessment is taken over after its lease expires', async () => {
      const projectId = oid();
      await store.requestAssessments({ projectId, domains: ['a.com'] });
      const mine = await store.claimNextAssessment({ owner: 'old', now: new Date(Date.now() + 10), leaseMs: 1000, projectId });
      const taken = await store.claimNextAssessment({ owner: 'new', now: new Date(Date.now() + 5000), leaseMs: 60_000, projectId });
      assert.equal(taken.lease_owner, 'new');
      assert.equal(await store.saveAutoResult({ id: mine._id, owner: 'old', auto: { class: 'not_relevant', confidence: 0.5, level: 'low', reasons: [], rules_version: 'x', registry_version: 'x', assessed_at: new Date() }, now: new Date() }), false);
      assert.equal((await dbDoc(projectId, 'a.com')).auto, undefined);
    });
  });

  describe('assessClaimed', () => {
    test('a registry site is classified WITHOUT any request to it, with its explanation', async () => {
      const { projectId } = await ownerWithProject();
      await store.requestAssessments({ projectId, domains: ['practo.com'] });
      const fetcher = fakeFetcher({});
      const r = await claimAndAssess(projectId, fetcher);
      assert.equal(r.outcome, 'informational_directory');
      assert.equal(fetcher.calls.length, 0);
      const doc = await dbDoc(projectId, 'practo.com');
      assert.equal(doc.status, 'done');
      assert.equal(doc.auto.signals.registryKind, 'directory');
      assert.ok(doc.auto.reasons.some((x) => x.code === 'registry'));
      assert.equal(doc.auto.rules_version, classifier.RULES_VERSION);
    });

    test('a hospital in the project\'s city is a direct competitor; the stored facts are small and safe', async () => {
      const { projectId } = await ownerWithProject();
      await store.requestAssessments({ projectId, domains: ['asgeyehospital.com'] });
      const r = await claimAndAssess(projectId, fakeFetcher({ 'asgeyehospital.com': () => globalThis.__extract(hospitalHtml()) }));
      assert.equal(r.outcome, 'direct_competitor');
      const doc = await dbDoc(projectId, 'asgeyehospital.com');
      assert.equal(doc.auto.signals.geo, 'same_city');
      assert.deepEqual(Object.keys(doc.auto.facts).sort(), ['country', 'fetched', 'locality', 'schemaTypes', 'title']);
      assert.ok(!('textSample' in doc.auto.facts), 'no page text is stored with the assessment');
    });

    test('the same site read for two projects is fetched ONCE (the facts are shared); each project is judged on its own profile', async () => {
      const a = await ownerWithProject();
      const b = await ownerWithProject({ target_city: 'Pune', target_state: 'Maharashtra', seo_scope: 'local' });
      const fetcher = fakeFetcher({ 'asgeyehospital.com': () => globalThis.__extract(hospitalHtml()) });
      await store.requestAssessments({ projectId: a.projectId, domains: ['asgeyehospital.com'] });
      await store.requestAssessments({ projectId: b.projectId, domains: ['asgeyehospital.com'] });
      const ra = await claimAndAssess(a.projectId, fetcher);
      const rb = await claimAndAssess(b.projectId, fetcher);
      assert.equal(fetcher.calls.length, 1, 'the second project reused the cached facts');
      assert.equal(ra.outcome, 'direct_competitor');
      assert.equal(rb.outcome, 'indirect_competitor', 'the same hospital is in another city for the Pune project');
    });

    test('a site that cannot be read is needs_review, marked so it is retried soon, and its failure is cached only briefly', async () => {
      const { projectId } = await ownerWithProject();
      await store.requestAssessments({ projectId, domains: ['down.example'] });
      const r = await claimAndAssess(projectId, fakeFetcher({}));
      assert.equal(r.outcome, 'needs_review');
      const doc = await dbDoc(projectId, 'down.example');
      assert.equal(doc.auto.fetch_failed, true);
      assert.equal(doc.status, 'done');
      const cached = await Profile.collection.findOne({ domain: 'down.example' });
      assert.ok(cached.expires_at.getTime() - Date.now() < 7 * 3600e3, 'a failure is remembered for hours, not a month');
    });

    test('"check this site again" reads the website itself, even when an earlier (failed) read is cached; an ordinary re-check reuses the cache', async () => {
      const { projectId } = await ownerWithProject();
      const failing = fakeFetcher({});
      await store.requestAssessments({ projectId, domains: ['asgeyehospital.com'] });
      assert.equal((await claimAndAssess(projectId, failing)).outcome, 'needs_review');
      assert.equal(failing.calls.length, 1);
      assert.equal((await dbDoc(projectId, 'asgeyehospital.com')).auto.fetch_failed, true);

      // The site is fine now. An ordinary re-check (the assessment is stale) trusts the cached failure for a few hours:
      const fixed = fakeFetcher({ 'asgeyehospital.com': () => globalThis.__extract(hospitalHtml()) });
      await Assessment.collection.updateOne({ project_id: projectId, domain: 'asgeyehospital.com' }, { $set: { 'auto.assessed_at': new Date(Date.now() - 7 * 3600e3) } }); // past the 6 h retry
      await store.requestAssessments({ projectId, domains: ['asgeyehospital.com'] });
      assert.equal((await claimAndAssess(projectId, fixed)).outcome, 'needs_review', 'the cached failure was reused');
      assert.equal(fixed.calls.length, 0);

      // The user presses "Check this site again": the website is read for real.
      await store.requestAssessments({ projectId, domains: ['asgeyehospital.com'], force: true });
      assert.equal((await dbDoc(projectId, 'asgeyehospital.com')).force_refetch, true);
      assert.equal((await claimAndAssess(projectId, fixed)).outcome, 'direct_competitor');
      assert.equal(fixed.calls.length, 1);
      const doc = await dbDoc(projectId, 'asgeyehospital.com');
      assert.equal(doc.force_refetch, false, 'the flag is spent');
      assert.equal(doc.auto.fetch_failed, false);
    });

    test('the project\'s own domain is never assessed; a deleted project fails safely; an unexpected error is retried then given up', async () => {
      const { projectId } = await ownerWithProject();
      await store.requestAssessments({ projectId, domains: ['krishnaeyecentre.com'] }); // as if it slipped through
      assert.equal((await claimAndAssess(projectId, fakeFetcher({}))).outcome, 'own_domain');
      assert.equal((await dbDoc(projectId, 'krishnaeyecentre.com')).status, 'failed');

      const gone = await ownerWithProject();
      await SeoProject.collection.updateOne({ _id: gone.projectId }, { $set: { is_deleted: true } });
      await store.requestAssessments({ projectId: gone.projectId, domains: ['a.com'] });
      assert.equal((await claimAndAssess(gone.projectId, fakeFetcher({}))).outcome, 'project_unavailable');

      const p = await ownerWithProject();
      await store.requestAssessments({ projectId: p.projectId, domains: ['boom.example'] });
      const exploding = async () => { throw new Error('mongodb://user:secret@host exploded'); };
      assert.equal((await claimAndAssess(p.projectId, exploding)).outcome, 'error');
      const doc = await dbDoc(p.projectId, 'boom.example');
      assert.equal(doc.status, 'pending', 'retried later');
      assert.equal(doc.last_error_code, 'ASSESSMENT_ERROR');
      assert.ok(!JSON.stringify(doc).includes('secret'), 'the error message is never stored');
    });
  });

  describe('the user\'s decision', () => {
    test('an override always wins, and automatic reassessment NEVER overwrites it', async () => {
      const { projectId, userId } = await ownerWithProject();
      await store.requestAssessments({ projectId, domains: ['practo.com'] });
      await claimAndAssess(projectId, fakeFetcher({}));
      const set = await store.setOverride({ projectId, domain: 'practo.com', cls: 'indirect_competitor', note: 'they do book eye surgeries', userId });
      let dto = store.toAssessmentDto(set);
      assert.deepEqual([dto.class, dto.autoClass, dto.overridden], ['indirect_competitor', 'informational_directory', true]);
      assert.equal(String(set.override.user_id), String(userId), 'who decided is recorded');
      assert.ok(set.override.at instanceof Date);

      // reassess (forced) and run: the automatic result is rewritten, the decision is not
      await store.requestAssessments({ projectId, domains: ['practo.com'], force: true });
      await claimAndAssess(projectId, fakeFetcher({}));
      const after2 = await dbDoc(projectId, 'practo.com');
      assert.equal(after2.override.class, 'indirect_competitor');
      assert.equal(after2.override.note, 'they do book eye surgeries');
      assert.equal(after2.auto.class, 'informational_directory');
      dto = store.toAssessmentDto(after2);
      assert.equal(dto.class, 'indirect_competitor');

      const cleared = await store.clearOverride({ projectId, domain: 'practo.com' });
      assert.equal(store.toAssessmentDto(cleared).class, 'informational_directory', 'without a decision the automatic class applies again');
    });

    test('a decision about a never-assessed domain is kept, and is not lost when the domain is queued later', async () => {
      const { projectId, userId } = await ownerWithProject();
      await store.setOverride({ projectId, domain: 'never.example', cls: 'not_relevant', userId });
      await store.requestAssessments({ projectId, domains: ['never.example'] });
      await claimAndAssess(projectId, fakeFetcher({ 'never.example': () => globalThis.__extract(hospitalHtml()) }));
      const doc = await dbDoc(projectId, 'never.example');
      assert.equal(doc.override.class, 'not_relevant');
      assert.equal(doc.auto.class, 'direct_competitor');
    });

    test('an invalid class or a missing user is refused', async () => {
      const { projectId, userId } = await ownerWithProject();
      await assert.rejects(store.setOverride({ projectId, domain: 'a.com', cls: 'best_friend', userId }), (e) => e.field === 'class');
      await assert.rejects(store.setOverride({ projectId, domain: 'a.com', cls: 'not_relevant', userId: null }), (e) => e.field === 'user');
    });
  });

  describe('saving a competitor queues its assessment', () => {
    test('a competitor with a website gets an assessment queued; one without does not; changing the website queues the new one', async () => {
      const { projectId } = await ownerWithProject();
      const c = await myService.createCompetitor({ projectId, data: { name: 'ASG', domain: 'asgeyehospital.com', address: null, place_id: null, source: 'manual', notes: null } });
      assert.equal((await dbDoc(projectId, 'asgeyehospital.com')).status, 'pending');
      await myService.createCompetitor({ projectId, data: { name: 'No site', domain: null, address: null, place_id: null, source: 'manual', notes: null } });
      assert.equal(await Assessment.countDocuments({ project_id: projectId }), 1);
      await myService.updateCompetitor({ projectId, id: c.id, patch: { domain: 'other-hospital.in' } });
      assert.equal((await dbDoc(projectId, 'other-hospital.in')).status, 'pending');
    });
  });

  describe('the sweeper', () => {
    test('the kill switch stops it, and a sweep is bounded', async () => {
      const projectId = oid();
      await store.requestAssessments({ projectId, domains: Array.from({ length: 10 }, (_, i) => `d${i}.example`) });
      assert.deepEqual(await worker.runAssessmentsOnce({ config: { enabled: false }, claim: () => assert.fail('no') }), { claimed: 0, outcomes: {} });
      let running = 0; let peak = 0;
      const assess = async () => { running += 1; peak = Math.max(peak, running); await sleep(30); running -= 1; return { outcome: 'done' }; };
      const sum = await worker.runAssessmentsOnce({ config: { enabled: true, leaseMs: 60_000 }, now: () => new Date(Date.now() + 50), claim: (a) => store.claimNextAssessment({ ...a, projectId }), assess, perSweep: 6, concurrency: 2 });
      assert.equal(sum.claimed, 6);
      assert.ok(peak <= 2, `peak ${peak}`);
    });
  });

  describe('API', () => {
    test('request / list / override / clear: ownership, validation, own domain, and the decision records who made it', async () => {
      const a = await ownerWithProject(); const b = await ownerWithProject();
      const p = `/${a.projectIdStr}/competitor-assessments`;
      assert.equal((await call('GET', `${p}?domains=a.com`)).status, 401);
      assert.equal((await call('POST', `${p}/request`, { token: b.token, body: { domains: ['a.com'] } })).status, 403);
      assert.equal((await call('PUT', `${p}/override`, { token: b.token, body: { domain: 'a.com', class: 'not_relevant' } })).status, 403);

      const req = await call('POST', `${p}/request`, { token: a.token, body: { domains: ['https://www.Practo.com/doctors', 'krishnaeyecentre.com', 'not a domain', 'practo.com', 'asgeyehospital.com'] } });
      assert.equal(req.status, 200);
      assert.deepEqual(req.body.data.assessments.map((x) => x.domain).sort(), ['asgeyehospital.com', 'practo.com']);
      assert.deepEqual(req.body.data.skippedOwn, ['krishnaeyecentre.com']);
      assert.deepEqual(req.body.data.invalid, ['not a domain']);
      assert.ok(req.body.data.assessments.every((x) => x.status === 'pending' && x.class === null));

      assert.equal((await call('POST', `${p}/request`, { token: a.token, body: { domains: [] } })).status, 400);
      assert.equal((await call('POST', `${p}/request`, { token: a.token, body: { domains: Array.from({ length: 51 }, (_, i) => `d${i}.com`) } })).status, 400);
      assert.equal((await call('POST', `${p}/request`, { token: a.token, body: { domains: ['localhost', '10.0.0.1'] } })).status, 400, 'internal addresses are refused before anything is fetched');

      const list = await call('GET', `${p}?domains=practo.com,asgeyehospital.com`, { token: a.token });
      assert.equal(list.body.data.assessments.length, 2);
      assert.equal((await call('GET', `${p}?domains=practo.com`, { token: b.token })).status, 403);

      const bad = await call('PUT', `${p}/override`, { token: a.token, body: { domain: 'practo.com', class: 'best_friend' } });
      assert.deepEqual([bad.status, bad.body.field], [400, 'class']);
      assert.equal((await call('PUT', `${p}/override`, { token: a.token, body: { domain: 'krishnaeyecentre.com', class: 'direct_competitor' } })).status, 400, 'your own site cannot be classified');
      const done = await call('PUT', `${p}/override`, { token: a.token, body: { domain: 'WWW.practo.com', class: 'indirect_competitor', note: '  they do surgeries  ' } });
      assert.equal(done.status, 200);
      assert.deepEqual([done.body.data.assessment.class, done.body.data.assessment.overridden, done.body.data.assessment.override.note], ['indirect_competitor', true, 'they do surgeries']);
      const raw = await dbDoc(a.projectId, 'practo.com');
      assert.equal(String(raw.override.user_id), String(a.userId));
      // the other user's project is untouched
      assert.equal(await Assessment.countDocuments({ project_id: b.projectId }), 0);

      const cleared = await call('DELETE', `${p}/override?domain=practo.com`, { token: a.token });
      assert.equal(cleared.body.data.assessment.overridden, false);
      assert.equal((await call('DELETE', `${p}/override?domain=krishnaeyecentre.com`, { token: a.token })).status, 400);
    });

    test('the routes never expose internal fields (lease owner, ids of workers, user id of the decision)', async () => {
      const a = await ownerWithProject();
      await call('POST', `/${a.projectIdStr}/competitor-assessments/request`, { token: a.token, body: { domains: ['practo.com'] } });
      await call('PUT', `/${a.projectIdStr}/competitor-assessments/override`, { token: a.token, body: { domain: 'practo.com', class: 'not_relevant' } });
      const r = await call('GET', `/${a.projectIdStr}/competitor-assessments?domains=practo.com`, { token: a.token });
      const text = JSON.stringify(r.body);
      for (const secret of ['lease_owner', 'lease_until', 'user_id', String(a.userId), 'project_id']) assert.ok(!text.includes(secret), `${secret} must not be exposed`);
    });
  });
});
