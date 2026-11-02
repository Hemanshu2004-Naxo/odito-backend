import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import mongoose from 'mongoose';

/**
 * My Competitors against a REAL MongoDB: indexes, uniqueness, capacity under concurrency, and the HTTP routes with the real auth and
 * project-ownership middleware. Nothing here is mocked.
 *
 * Needs COMPETITORS_TEST_MONGO_URI, a LOCAL throwaway server (for example `mongodb://127.0.0.1:27017/`). Without it every test is
 * skipped. It deliberately never reads MONGO_URI, and it refuses any host that is not localhost: the tests create and drop data.
 * Each run uses its own database (odito_competitors_test_<time>_<pid>) and drops it at the end.
 *
 * Run:  COMPETITORS_TEST_MONGO_URI=mongodb://127.0.0.1:27017/ JWT_SECRET=test node --test src/modules/competitors/tests/myCompetitors.db.test.js
 */

const URI = process.env.COMPETITORS_TEST_MONGO_URI;
// CI sets COMPETITORS_REQUIRE_DB_TESTS=1: there, a missing database is a FAILURE, never a quiet skip that looks like a pass.
if (!URI && process.env.COMPETITORS_REQUIRE_DB_TESTS === '1') {
  throw new Error('COMPETITORS_REQUIRE_DB_TESTS=1 but COMPETITORS_TEST_MONGO_URI is not set: the database tests would be skipped.');
}
const SKIP = URI ? false : 'set COMPETITORS_TEST_MONGO_URI to a local throwaway MongoDB to run the database tests';
// Only localhost is accepted, because these tests write and drop data. A CI system whose database service is not reachable as localhost
// (for example a service container called "mongo") must name that exact host in COMPETITORS_TEST_MONGO_APPROVED_HOST: an explicit, narrow
// opt-in for a throwaway service, never a pattern. A URI with credentials or several hosts is never accepted.
if (URI) {
  const host = /^mongodb:\/\/(\[[^\]]+\]|[^/@,?:]+)(?::\d+)?\//.exec(URI)?.[1];
  const approved = process.env.COMPETITORS_TEST_MONGO_APPROVED_HOST;
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(host);
  if (!host || !(local || (approved && host === approved))) {
    throw new Error('COMPETITORS_TEST_MONGO_URI must point at localhost (or exactly the host named in COMPETITORS_TEST_MONGO_APPROVED_HOST): these tests write and drop data.');
  }
}
process.env.JWT_SECRET ||= 'competitors-test-secret';

const DB_NAME = `odito_competitors_test_${Date.now()}_${process.pid}`;
const oid = () => new mongoose.Types.ObjectId();
const codeOf = (fn) => fn().then(() => null, (e) => e.code ?? e.message);

let ProjectCompetitor; let svc; let User; let SeoProject; let signAuthToken; let server; let base;
const MAX = 100;

async function ownerWithProject(mainUrl = 'https://www.own-site.com/') {
  const userId = oid(); const projectId = oid();
  await User.collection.insertOne({ _id: userId, firstName: 'T', lastName: 'U', email: `${userId}@example.test`, isActive: true, roleId: 2 });
  await SeoProject.collection.insertOne({ _id: projectId, user_id: userId, main_url: mainUrl, is_deleted: false });
  return { userId, projectId: String(projectId), token: signAuthToken({ _id: userId, roleId: 2 }) };
}

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe('My Competitors (real MongoDB)', { skip: SKIP }, () => {
  before(async () => {
    // autoIndex off: the service itself must make the indexes exist (it does, via ensureIndexes()).
    await mongoose.connect(URI, { dbName: DB_NAME, autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 5000 });
    ({ default: ProjectCompetitor } = await import('../model/ProjectCompetitor.js'));
    svc = await import('../service/myCompetitorsService.js');
    ({ default: User } = await import('../../user/model/User.js'));
    ({ default: SeoProject } = await import('../../app_user/model/SeoProject.js'));
    ({ signAuthToken } = await import('../../user/service/tokenService.js'));
    const { default: routes } = await import('../routes/myCompetitorsRoutes.js');
    const app = express();
    app.use(express.json());
    app.use('/api/projects', routes);
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}/api/projects`;
  });

  after(async () => {
    await new Promise((r) => (server ? server.close(r) : r()));
    // Only when the connection really opened: after a failed connect, dropDatabase() would wait on a buffered command and hang the job.
    if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  describe('indexes', () => {
    const entry = (over = {}) => ({ name: 'C', domain: 'c.com', address: null, place_id: null, source: 'manual', notes: null, ...over });

    test('a build that cannot succeed (existing data breaks uniqueness): writes answer 503 and write nothing, reads still work, and it recovers WITHOUT a restart once the data is fixed', async () => {
      svc.__resetIndexStateForTests({ retryMs: 50 });
      const pid = oid();
      const owner = await ownerWithProject('https://idx-owner.com');
      const projectId = new mongoose.Types.ObjectId(owner.projectId);
      // The collection exists with duplicate websites and NO indexes yet (autoIndex is off).
      await ProjectCompetitor.collection.insertMany([
        { project_id: projectId, slot: 0, name: 'A', domain: 'dup.com', source: 'manual' },
        { project_id: projectId, slot: 1, name: 'B', domain: 'dup.com', source: 'manual' },
      ]);
      assert.equal(await codeOf(() => svc.ensureIndexes()), 'COMPETITORS_UNAVAILABLE');
      assert.equal(svc.getIndexReadiness().ready, false);
      assert.match(svc.getIndexReadiness().lastFailure, /does not match|E11000|duplicate/i);

      // Through the real HTTP stack: writes are 503 with a clear code, nothing is saved, reads and deletes still work.
      const w = await call('POST', `/${owner.projectId}/my-competitors`, { token: owner.token, body: { name: 'New', domain: 'new-one.com' } });
      assert.deepEqual([w.status, w.body.code], [503, 'COMPETITORS_UNAVAILABLE']);
      assert.equal(await ProjectCompetitor.collection.countDocuments({ project_id: projectId, domain: 'new-one.com' }), 0, 'nothing was written');
      const r = await call('GET', `/${owner.projectId}/my-competitors`, { token: owner.token });
      assert.equal(r.status, 200);
      assert.equal(r.body.data.competitors.length, 2, 'reading is not blocked');
      assert.equal((await call('GET', `/${owner.projectId}/my-competitors`, { token: owner.token })).status, 200);

      // Fix the data. No restart: after the retry delay the next write rebuilds the indexes and succeeds.
      await ProjectCompetitor.collection.deleteMany({ project_id: projectId, name: 'B' });
      await new Promise((res) => setTimeout(res, 80));
      const ok = await call('POST', `/${owner.projectId}/my-competitors`, { token: owner.token, body: { name: 'New', domain: 'new-one.com' } });
      assert.equal(ok.status, 201);
      assert.equal(svc.getIndexReadiness().ready, true);
      await ProjectCompetitor.collection.deleteMany({ project_id: projectId });
      void pid;
    });

    test('while it keeps failing it is not retried on every request (cool-down), and a conflicting index name is refused', async () => {
      // Make the build impossible differently: an index with a required NAME but other options (MongoDB refuses to build over it).
      await ProjectCompetitor.collection.dropIndex('project_competitor_slot_unique');
      await ProjectCompetitor.collection.createIndex({ project_id: 1, slot: 1 }, { name: 'project_competitor_slot_unique' }); // not unique
      svc.__resetIndexStateForTests({ retryMs: 60_000 });
      let builds = 0; const original = ProjectCompetitor.createIndexes.bind(ProjectCompetitor);
      ProjectCompetitor.createIndexes = (...args) => { builds += 1; return original(...args); };
      try {
        for (let i = 0; i < 5; i += 1) assert.equal(await codeOf(() => svc.createCompetitor({ projectId: oid(), data: entry({ domain: `x${i}.com` }) })), 'COMPETITORS_UNAVAILABLE');
        assert.equal(builds, 1, 'five refused writes cost one build attempt, not five');
        assert.equal(svc.getIndexReadiness().ready, false);
      } finally { ProjectCompetitor.createIndexes = original; }
      // Fix it (in this throwaway database only): the correct index replaces the wrong one, and the feature recovers.
      await ProjectCompetitor.collection.dropIndex('project_competitor_slot_unique');
      svc.__resetIndexStateForTests({ retryMs: 0 });
      assert.equal(await svc.ensureIndexes(), true);
      assert.equal(svc.getIndexReadiness().ready, true);
    });

    test('the inspection script reports a healthy collection as clean, and names missing indexes and data that would block them', async () => {
      const { inspect } = await import('../scripts/inspectMyCompetitorIndexes.js');
      const db = mongoose.connection.db;
      const lines = []; const log = (l) => lines.push(l);
      assert.deepEqual(await inspect({ db, log }), [], lines.join('\n'));
      assert.ok(lines.some((l) => l.includes('project_competitor_slot_unique: ok')));

      // Broken state: no website index, duplicate websites present.
      const pid = oid();
      await ProjectCompetitor.collection.dropIndex('project_competitor_domain_unique');
      await ProjectCompetitor.collection.insertMany([
        { project_id: pid, slot: 0, name: 'A', domain: 'dup.com' }, { project_id: pid, slot: 1, name: 'B', domain: 'dup.com' }, { project_id: pid, name: 'No slot', domain: null },
      ]);
      lines.length = 0;
      const findings = await inspect({ db, log });
      assert.ok(findings.some((f) => /duplicate \(project, website\)/.test(f)), findings.join(' | '));
      assert.ok(findings.some((f) => /no slot/.test(f)), findings.join(' | '));
      assert.ok(lines.some((l) => l.includes('project_competitor_domain_unique: MISSING')));
      await ProjectCompetitor.collection.deleteMany({ project_id: pid });
      svc.__resetIndexStateForTests({ retryMs: 0 });
      assert.equal(await svc.ensureIndexes(), true, 'the index is rebuilt once the data is clean');
    });

    test('the four unique indexes exist with the intended keys and partial filters', async () => {
      const byName = Object.fromEntries((await ProjectCompetitor.collection.indexes()).map((i) => [i.name, i]));
      assert.deepEqual(byName.project_competitor_domain_unique.key, { project_id: 1, domain: 1 });
      assert.equal(byName.project_competitor_domain_unique.unique, true);
      assert.deepEqual(byName.project_competitor_domain_unique.partialFilterExpression, { domain: { $type: 'string' } });
      assert.deepEqual(byName.project_competitor_place_unique.key, { project_id: 1, place_id: 1 });
      assert.equal(byName.project_competitor_place_unique.unique, true);
      assert.deepEqual(byName.project_competitor_place_unique.partialFilterExpression, { place_id: { $type: 'string' } });
      assert.deepEqual(byName.project_competitor_branch_place_unique.key, { project_id: 1, 'branches.place_id': 1 });
      assert.equal(byName.project_competitor_branch_place_unique.unique, true);
      assert.deepEqual(byName.project_competitor_branch_place_unique.partialFilterExpression, { 'branches.place_id': { $type: 'string' } });
      assert.deepEqual(byName.project_competitor_slot_unique.key, { project_id: 1, slot: 1 });
      assert.equal(byName.project_competitor_slot_unique.unique, true);
      assert.deepEqual(byName.project_competitor_enrichment_queue.key, { 'enrichment.status': 1, 'enrichment.next_attempt_at': 1, 'enrichment.lease_until': 1 });
      console.log('INDEXES', JSON.stringify(Object.values(byName).map(({ name, key, unique, partialFilterExpression }) => ({ name, key, unique, partialFilterExpression }))));
    });

    test('the database itself enforces uniqueness even when the service is bypassed', async () => {
      const pid = oid(); const other = oid();
      const doc = (over) => ({ project_id: pid, slot: 0, name: 'N', domain: null, place_id: null, source: 'manual', ...over });
      await ProjectCompetitor.collection.insertOne(doc({ domain: 'x.com', place_id: 'P1' }));
      await ProjectCompetitor.collection.updateOne({ project_id: pid, slot: 0 }, { $set: { branches: [{ place_id: 'P1' }, { place_id: 'P1-B' }] } });
      for (const [label, over] of [['website', { slot: 1, domain: 'x.com' }], ['place id', { slot: 1, place_id: 'P1' }], ['branch place', { slot: 1, branches: [{ place_id: 'P1-B' }] }], ['slot', { slot: 0 }]]) {
        const err = await ProjectCompetitor.collection.insertOne(doc(over)).catch((e) => e);
        assert.equal(err.code, 11000, `duplicate ${label} must be rejected by the index`);
      }
      // The same values in ANOTHER project are fine.
      await ProjectCompetitor.collection.insertOne({ ...doc({ domain: 'x.com', place_id: 'P1' }), project_id: other });
      // Several entries with no website / no place id are fine (partial indexes skip null).
      await ProjectCompetitor.collection.insertMany([doc({ slot: 5 }), doc({ slot: 6 }), doc({ slot: 7 })]);
    });
  });

  describe('service: create / read / update / delete', () => {
    const data = (over = {}) => ({ name: 'Sunrise', domain: 'sunrise.com', address: null, place_id: null, source: 'manual', notes: null, ...over });

    test('create, read, update, delete round trip', async () => {
      const projectId = oid();
      const created = await svc.createCompetitor({ projectId, data: data({ address: '12 Main Rd', notes: 'rival' }) });
      assert.equal(created.name, 'Sunrise');
      assert.equal(created.domain, 'sunrise.com');
      assert.equal(created.source, 'manual');
      assert.ok(created.id && created.createdAt);
      assert.equal(created.slot, undefined, 'the slot is internal and not exposed');

      assert.deepEqual((await svc.listCompetitors(projectId)).map((c) => c.id), [created.id]);

      const updated = await svc.updateCompetitor({ projectId, id: created.id, patch: { name: 'Sunrise Vision', notes: null } });
      assert.equal(updated.name, 'Sunrise Vision');
      assert.equal(updated.notes, null);
      assert.equal(updated.domain, 'sunrise.com', 'fields not in the patch are untouched');

      await svc.deleteCompetitor({ projectId, id: created.id });
      assert.deepEqual(await svc.listCompetitors(projectId), []);
      await svc.deleteCompetitor({ projectId, id: created.id }); // deleting again succeeds
    });

    test('a duplicate website and a duplicate place id are COMPETITOR_EXISTS; the same website in another project is fine', async () => {
      const a = oid(); const b = oid();
      await svc.createCompetitor({ projectId: a, data: data({ place_id: 'ChIJ_1' }) });
      assert.equal(await codeOf(() => svc.createCompetitor({ projectId: a, data: data({ name: 'Other name' }) })), 'COMPETITOR_EXISTS');
      assert.equal(await codeOf(() => svc.createCompetitor({ projectId: a, data: data({ domain: 'different.com', place_id: 'ChIJ_1' }) })), 'COMPETITOR_EXISTS');
      assert.ok(await svc.createCompetitor({ projectId: b, data: data({ place_id: 'ChIJ_1' }) }), 'another project may hold the same website and place');
      assert.equal((await svc.listCompetitors(a)).length, 1);
    });

    test('a duplicate on update is COMPETITOR_EXISTS and leaves the entry unchanged', async () => {
      const projectId = oid();
      await svc.createCompetitor({ projectId, data: data({ domain: 'one.com' }) });
      const two = await svc.createCompetitor({ projectId, data: data({ name: 'Two', domain: 'two.com' }) });
      assert.equal(await codeOf(() => svc.updateCompetitor({ projectId, id: two.id, patch: { domain: 'one.com' } })), 'COMPETITOR_EXISTS');
      assert.equal((await svc.listCompetitors(projectId)).find((c) => c.id === two.id).domain, 'two.com');
    });

    test('missing optional fields are stored as null, never as empty strings, and any number of such entries is allowed', async () => {
      const projectId = oid();
      for (const name of ['No site 1', 'No site 2', 'No site 3']) await svc.createCompetitor({ projectId, data: { name, domain: null, address: null, place_id: null, source: 'manual', notes: null } });
      const raw = await ProjectCompetitor.collection.find({ project_id: projectId }).toArray();
      assert.equal(raw.length, 3);
      for (const d of raw) assert.deepEqual([d.domain, d.place_id, d.address, d.notes], [null, null, null, null]);
      const cleared = await svc.updateCompetitor({ projectId, id: String(raw[0]._id), patch: { domain: null } });
      assert.equal(cleared.domain, null);
    });

    test('updating a competitor that does not exist, or lives in another project, is COMPETITOR_NOT_FOUND', async () => {
      const a = oid(); const b = oid();
      const c = await svc.createCompetitor({ projectId: a, data: data() });
      assert.equal(await codeOf(() => svc.updateCompetitor({ projectId: b, id: c.id, patch: { name: 'hijack' } })), 'COMPETITOR_NOT_FOUND');
      assert.equal(await codeOf(() => svc.updateCompetitor({ projectId: a, id: oid(), patch: { name: 'x' } })), 'COMPETITOR_NOT_FOUND');
      assert.equal((await svc.listCompetitors(a))[0].name, 'Sunrise');
    });
  });

  describe('capacity (100 per project)', () => {
    const entry = (i) => ({ name: `C${i}`, domain: `c${i}.example.com`, address: null, place_id: null, source: 'manual', notes: null });
    const fill = async (projectId, n) => {
      await ProjectCompetitor.collection.insertMany(Array.from({ length: n }, (_, i) => ({ project_id: projectId, slot: i, ...entry(i) })));
    };

    test('the 101st entry is COMPETITOR_LIMIT_REACHED, distinct from a duplicate', async () => {
      const projectId = oid();
      await fill(projectId, MAX);
      assert.equal(await codeOf(() => svc.createCompetitor({ projectId, data: entry(1000) })), 'COMPETITOR_LIMIT_REACHED');
      assert.equal(await codeOf(() => svc.createCompetitor({ projectId, data: entry(3) })), 'COMPETITOR_LIMIT_REACHED', 'full wins over duplicate: nothing can be added');
      assert.equal(await ProjectCompetitor.countDocuments({ project_id: projectId }), MAX);
    });

    test('a failed insert holds no capacity; a delete frees its slot', async () => {
      const projectId = oid();
      await fill(projectId, MAX - 1);
      assert.equal(await codeOf(() => svc.createCompetitor({ projectId, data: entry(5) })), 'COMPETITOR_EXISTS'); // duplicate website, 1 slot left
      assert.ok(await codeOf(() => svc.createCompetitor({ projectId, data: { ...entry(2000), name: 'x'.repeat(500) } })), 'schema validation failure');
      const last = await svc.createCompetitor({ projectId, data: entry(2001) });
      assert.ok(last, 'the one remaining slot was still free after two failed attempts');
      assert.equal(await codeOf(() => svc.createCompetitor({ projectId, data: entry(2002) })), 'COMPETITOR_LIMIT_REACHED');
      await svc.deleteCompetitor({ projectId, id: last.id });
      assert.ok(await svc.createCompetitor({ projectId, data: entry(2003) }), 'a removed entry frees its slot');
      assert.equal(await ProjectCompetitor.countDocuments({ project_id: projectId }), MAX);
    });

    test('concurrent adds into the last slots never exceed the limit', async () => {
      const results = [];
      for (const [prefill, parallel] of [[MAX - 1, 30], [MAX - 5, 40], [MAX - 10, 60]]) {
        const projectId = oid();
        await fill(projectId, prefill);
        const outcomes = await Promise.all(Array.from({ length: parallel }, (_, i) => svc.createCompetitor({ projectId, data: entry(5000 + i) }).then(() => 'ok', (e) => e.code)));
        const count = (k) => outcomes.filter((o) => o === k).length;
        const total = await ProjectCompetitor.countDocuments({ project_id: projectId });
        const slots = await ProjectCompetitor.distinct('slot', { project_id: projectId });
        results.push({ free: MAX - prefill, parallel, ok: count('ok'), full: count('COMPETITOR_LIMIT_REACHED'), busy: count('COMPETITOR_BUSY'), other: parallel - count('ok') - count('COMPETITOR_LIMIT_REACHED') - count('COMPETITOR_BUSY'), total });
        assert.ok(total <= MAX, `never more than ${MAX} (got ${total})`);
        assert.equal(slots.length, total, 'every entry holds its own slot');
        assert.equal(total, prefill + count('ok'), 'every success is exactly one saved entry');
        assert.equal(count('ok') + count('COMPETITOR_LIMIT_REACHED') + count('COMPETITOR_BUSY'), parallel, 'no other kind of failure');
      }
      console.log('CONCURRENCY', JSON.stringify(results));
    });

    test('concurrent adds of the SAME website: exactly one wins, the rest are COMPETITOR_EXISTS', async () => {
      const projectId = oid();
      const outcomes = await Promise.all(Array.from({ length: 20 }, () => svc.createCompetitor({ projectId, data: entry(7) }).then(() => 'ok', (e) => e.code)));
      assert.equal(outcomes.filter((o) => o === 'ok').length, 1);
      assert.equal(outcomes.filter((o) => o === 'COMPETITOR_EXISTS').length, 19, JSON.stringify(outcomes));
      assert.equal(await ProjectCompetitor.countDocuments({ project_id: projectId }), 1);
    });
  });

  describe('routes: authentication, ownership and validation (real middleware)', () => {
    let a; let b;
    before(async () => { a = await ownerWithProject(); b = await ownerWithProject('https://other-owner.com'); });

    test('no token, a bad token, and an unknown user are rejected with 401', async () => {
      assert.equal((await call('GET', `/${a.projectId}/my-competitors`)).status, 401);
      assert.equal((await call('GET', `/${a.projectId}/my-competitors`, { token: 'not.a.jwt' })).status, 401);
      const ghost = signAuthToken({ _id: oid(), roleId: 2 });
      assert.equal((await call('POST', `/${a.projectId}/my-competitors`, { token: ghost, body: { name: 'X' } })).status, 401);
    });

    test('another user\'s project: every operation is 403 and changes nothing', async () => {
      const mine = await call('POST', `/${a.projectId}/my-competitors`, { token: a.token, body: { name: 'Mine', domain: 'mine.com' } });
      assert.equal(mine.status, 201);
      const id = mine.body.data.competitor.id;
      const p = `/${a.projectId}/my-competitors`;
      assert.equal((await call('GET', p, { token: b.token })).status, 403);
      assert.equal((await call('POST', p, { token: b.token, body: { name: 'Intruder' } })).status, 403);
      assert.equal((await call('PATCH', `${p}/${id}`, { token: b.token, body: { name: 'Hacked' } })).status, 403);
      assert.equal((await call('DELETE', `${p}/${id}`, { token: b.token })).status, 403);
      const list = (await call('GET', p, { token: a.token })).body.data.competitors;
      assert.deepEqual(list.map((c) => c.name), ['Mine']);
    });

    test('unknown, malformed and soft-deleted projects', async () => {
      assert.equal((await call('GET', `/${oid()}/my-competitors`, { token: a.token })).status, 404);
      assert.equal((await call('GET', '/not-an-id/my-competitors', { token: a.token })).status, 400);
      const gone = await ownerWithProject('https://gone.com');
      await SeoProject.collection.updateOne({ _id: new mongoose.Types.ObjectId(gone.projectId) }, { $set: { is_deleted: true } });
      assert.equal((await call('GET', `/${gone.projectId}/my-competitors`, { token: gone.token })).status, 404);
    });

    test('cross-project update and delete: an entry is only reachable through its own project', async () => {
      const second = await ownerWithProject('https://second.com');
      const owner = a; // own a second project under user a
      const p2 = oid();
      await SeoProject.collection.insertOne({ _id: p2, user_id: owner.userId, main_url: 'https://own-two.com', is_deleted: false });
      const made = (await call('POST', `/${owner.projectId}/my-competitors`, { token: owner.token, body: { name: 'Pinned', domain: 'pinned.com' } })).body.data.competitor;
      const patch = await call('PATCH', `/${p2}/my-competitors/${made.id}`, { token: owner.token, body: { name: 'Moved' } });
      assert.equal(patch.status, 404);
      assert.equal(patch.body.code, 'COMPETITOR_NOT_FOUND');
      await call('DELETE', `/${p2}/my-competitors/${made.id}`, { token: owner.token });
      const still = (await call('GET', `/${owner.projectId}/my-competitors`, { token: owner.token })).body.data.competitors.find((c) => c.id === made.id);
      assert.equal(still?.name, 'Pinned', 'untouched by the other project\'s PATCH and DELETE');
      assert.equal((await call('GET', `/${second.projectId}/my-competitors`, { token: second.token })).body.data.competitors.length, 0);
    });

    test('projectId, slot, source and _id in a body cannot redirect or alter protected fields', async () => {
      const created = await call('POST', `/${a.projectId}/my-competitors`, {
        token: a.token,
        body: { name: 'Sneaky', domain: 'sneaky.com', projectId: b.projectId, project_id: b.projectId, slot: 77, _id: String(oid()), createdAt: '2000-01-01' },
      });
      assert.equal(created.status, 201);
      const raw = await ProjectCompetitor.collection.findOne({ _id: new mongoose.Types.ObjectId(created.body.data.competitor.id) });
      assert.equal(String(raw.project_id), a.projectId, 'saved under the project in the URL');
      assert.notEqual(raw.slot, 77, 'the slot is assigned by the server');
      assert.ok(raw.createdAt > new Date('2020-01-01'));

      const id = created.body.data.competitor.id;
      const edited = await call('PATCH', `/${a.projectId}/my-competitors/${id}`, { token: a.token, body: { name: 'Renamed', project_id: b.projectId, slot: 3, source: 'local', createdAt: '2000-01-01' } });
      assert.equal(edited.status, 200);
      const after = await ProjectCompetitor.collection.findOne({ _id: new mongoose.Types.ObjectId(id) });
      assert.deepEqual([after.name, String(after.project_id), after.slot, after.source], ['Renamed', a.projectId, raw.slot, 'manual']);
      assert.equal((await call('PATCH', `/${a.projectId}/my-competitors/${id}`, { token: a.token, body: { source: 'local' } })).status, 400, 'a body with only protected fields is "nothing to change"');
    });

    test('invalid input is a 400 with a code; duplicates and a full list are 409 with different codes', async () => {
      const p = `/${a.projectId}/my-competitors`;
      for (const body of [{ name: 'X', source: 'import' }, { name: 'X', domain: 'localhost' }, { name: 'X', domain: '10.0.0.1' }, { name: 'X', domain: 'not a domain' }, {}, { name: 'X', placeId: 'bad id!' }]) {
        const r = await call('POST', p, { token: a.token, body });
        assert.equal(r.status, 400, JSON.stringify(body));
        assert.equal(r.body.success, false);
      }
      assert.equal((await call('PATCH', `${p}/not-an-id`, { token: a.token, body: { name: 'x' } })).status, 400);
      assert.equal((await call('POST', p, { token: a.token, body: { name: 'One', domain: 'dupe-route.com' } })).status, 201);
      const dup = await call('POST', p, { token: a.token, body: { name: 'Two', website: 'https://www.DUPE-route.com/x' } });
      assert.deepEqual([dup.status, dup.body.code], [409, 'COMPETITOR_EXISTS']);

      const f = await ownerWithProject('https://full.com');
      await ProjectCompetitor.collection.insertMany(Array.from({ length: MAX }, (_, i) => ({ project_id: new mongoose.Types.ObjectId(f.projectId), slot: i, name: `F${i}`, domain: `f${i}.com`, source: 'manual' })));
      const full = await call('POST', `/${f.projectId}/my-competitors`, { token: f.token, body: { name: 'Overflow', domain: 'overflow.com' } });
      assert.deepEqual([full.status, full.body.code], [409, 'COMPETITOR_LIMIT_REACHED']);
    });

    test('your own website is rejected on create and on update, however it is written', async () => {
      const p = `/${a.projectId}/my-competitors`;
      for (const domain of ['own-site.com', 'https://www.OWN-SITE.com/pricing', 'WWW.own-site.com']) {
        const r = await call('POST', p, { token: a.token, body: { name: 'Me', domain } });
        assert.deepEqual([r.status, r.body.code], [400, 'OWN_DOMAIN'], domain);
      }
      const ok = await call('POST', p, { token: a.token, body: { name: 'Someone', domain: 'someone-else.com' } });
      const r = await call('PATCH', `${p}/${ok.body.data.competitor.id}`, { token: a.token, body: { domain: 'own-site.com' } });
      assert.deepEqual([r.status, r.body.code], [400, 'OWN_DOMAIN']);
    });

    test('website normalization happens before it is saved', async () => {
      const r = await call('POST', `/${a.projectId}/my-competitors`, { token: a.token, body: { name: 'Norm', domain: '  HTTPS://www.Norm-Site.COM/a/b?x=1#y ' } });
      assert.equal(r.status, 201);
      const raw = await ProjectCompetitor.collection.findOne({ _id: new mongoose.Types.ObjectId(r.body.data.competitor.id) });
      assert.equal(raw.domain, 'norm-site.com');
    });
  });
});
