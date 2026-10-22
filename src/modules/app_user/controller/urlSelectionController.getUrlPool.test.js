import { describe, test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import Job from '../../jobs/model/Job.js';
import SeoProject from '../model/SeoProject.js';
import { AuthUtil } from '../../../utils/AuthUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import { validateProjectAccess } from '../../../middleware/auth.middleware.js';
import seoProjectRoutes from '../routes/seoProjectRoutes.js';
import { getUrlPool } from './urlSelectionController.js';

// GET /projects/:id/url-pool — URL Selection page data source.
//
// Regression: the page showed "0 of 0 discovered URLs" although URL_QUALIFICATION
// had completed with 162 discovered / 161 qualified URLs. The pool lives in
// seo_audit_url_pool (written by the Python worker); the job's
// result_data.canonicalUrls is only a CANONICAL_CAP (50) sized subset. When the
// pool was invisible to the backend (worker and backend on different Mongo
// databases) the endpoint returned a *successful* empty pool. These tests pin:
// the supplied job's real shape, that a missing pool is a loud error (not
// "0 of 0"), and the genuinely-empty / pending / missing-job / unauthorized cases.
//
// No live Mongo: Job and mongoose.connection.db are stubbed.

const PROJECT_ID = new mongoose.Types.ObjectId('6ac9d2e803457bf67cba696f');
const RUN_ID = new mongoose.Types.ObjectId('6ac9d2ea03457bf67cba697f');
const JOB_ID = new mongoose.Types.ObjectId('6ac9d30d03457bf67cba6a29');

const HOST = 'https://krishnaeyecentre.com';
const url = (i) => `${HOST}/page-${i}`;

// The supplied URL_QUALIFICATION result_data.
const SUPPLIED_RESULT_DATA = {
  discoveredUrls: 162, candidateUrls: 162, qualifiedUrls: 161,
  lowPriorityUrls: 1, rejectedUrls: 0, canonicalCount: 50,
  canonicalUrls: Array.from({ length: 50 }, (_, i) => url(i)),
};

const makeJob = (over = {}) => ({
  _id: JOB_ID, project_id: PROJECT_ID, run_id: RUN_ID,
  jobType: 'URL_QUALIFICATION', status: 'completed',
  result_data: SUPPLIED_RESULT_DATA, ...over,
});

// 161 qualified + 1 low-priority (unqualified) — the pool the Python worker wrote.
const suppliedPool = () => Array.from({ length: 162 }, (_, i) => ({
  project_id: PROJECT_ID, job_id: JOB_ID, url: url(i),
  qualified: i !== 161, low_priority: i === 161, status_code: i === 161 ? 404 : 200,
  probed_at: new Date(1000 + i), probe_phase: 'initial',
}));

const makeProject = (over = {}) => ({
  _id: PROJECT_ID, crawl_status: 'awaiting_url_selection',
  current_run_id: RUN_ID, url_selection_limit: null, ...over,
});

const makeRes = () => {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};

// Job.findOne(...).lean() and .sort().select().lean() both resolve to `doc`.
const chain = (doc) => {
  const q = { lean: async () => doc, sort: () => q, select: () => q };
  return q;
};

function stubDb({ pool = [], links = [], projectCount, stringCount = 0 } = {}) {
  const calls = [];
  const collections = {
    seo_audit_url_pool: {
      find: (q) => { calls.push(['pool.find', q]); return { sort: () => ({ toArray: async () => pool }) }; },
      countDocuments: async (q) => {
        calls.push(['pool.count', q]);
        return typeof q.job_id === 'string' ? stringCount : (projectCount ?? pool.length);
      },
    },
    seo_internal_links: {
      find: () => ({ toArray: async () => links }),
    },
  };
  Object.defineProperty(mongoose.connection, 'db', {
    configurable: true, get: () => ({ collection: (n) => collections[n] }),
  });
  return calls;
}

afterEach(() => {
  mock.restoreAll();
  delete mongoose.connection.db; // drop the own-property stub; prototype getter returns
});

const logs = () => {
  const errors = []; const warns = [];
  mock.method(LoggerUtil, 'error', (msg, err, ctx) => errors.push({ msg, err, ctx }));
  mock.method(LoggerUtil, 'warn', (msg, ctx) => warns.push({ msg, ctx }));
  return { errors, warns };
};

describe('getUrlPool', () => {
  test('supplied job: all 162 pool URLs returned; 161 qualified; canonical 50 reported but is NOT the pool size', async () => {
    logs();
    mock.method(Job, 'findOne', () => chain(makeJob()));
    stubDb({ pool: suppliedPool() });

    const res = makeRes();
    await getUrlPool({ project: makeProject(), params: { id: PROJECT_ID.toString() }, query: {} }, res);

    assert.equal(res.statusCode, 200);
    const d = res.body.data;
    assert.equal(d.total_discovered, 162);
    assert.equal(d.total_qualified, 161);
    assert.equal(d.urls.length, 162);
    assert.equal(d.urls.filter((u) => u.qualified).length, 161);
    assert.equal(d.qualification_summary.canonical_count, 50);
    assert.equal(d.qualification_summary.qualified, 161);
    assert.equal(d.qualification_summary.discovered, 162);
    assert.ok(d.total_qualified > d.qualification_summary.canonical_count);
  });

  test('queries the pool by the right project ObjectId and the URL_QUALIFICATION job _id', async () => {
    logs();
    mock.method(Job, 'findOne', () => chain(makeJob()));
    const calls = stubDb({ pool: suppliedPool() });

    await getUrlPool({ project: makeProject(), params: {}, query: {} }, makeRes());

    const [, q] = calls.find(([k]) => k === 'pool.find');
    assert.ok(q.project_id instanceof mongoose.Types.ObjectId);
    assert.equal(q.project_id.toString(), PROJECT_ID.toString());
    assert.ok(q.job_id instanceof mongoose.Types.ObjectId);
    assert.equal(q.job_id.toString(), JOB_ID.toString());
  });

  test('pool invisible although the job reported 162 URLs -> 503 URL_POOL_UNAVAILABLE (never a successful 0 of 0) + diagnostics', async () => {
    const { errors } = logs();
    mock.method(Job, 'findOne', () => chain(makeJob()));
    stubDb({ pool: [], projectCount: 0 });

    const res = makeRes();
    await getUrlPool({ project: makeProject(), params: { id: PROJECT_ID.toString() }, query: {} }, res);

    assert.equal(res.statusCode, 503);
    assert.equal(res.body.success, false);
    assert.equal(res.body.details.code, 'URL_POOL_UNAVAILABLE');
    assert.equal(errors.length, 1);
    const ctx = errors[0].ctx;
    assert.equal(ctx.jobId, JOB_ID.toString());
    assert.equal(ctx.reported.discoveredUrls, 162);
    assert.deepEqual(ctx.poolCounts, { byProjectAndJobId: 0, byProjectOnly: 0, byJobIdAsString: 0 });
    assert.match(ctx.hint, /same database name/);
    // diagnostics must not leak URLs/secrets
    assert.doesNotMatch(JSON.stringify(ctx), /krishnaeyecentre|:\/\/|@/i);
  });

  test('pool docs exist under another job_id -> still 503, hint points at job_id mismatch', async () => {
    const { errors } = logs();
    mock.method(Job, 'findOne', () => chain(makeJob()));
    // find() (project+job) empty, but project-only count is non-zero
    const calls = stubDb({ pool: [], projectCount: 162 });

    const res = makeRes();
    await getUrlPool({ project: makeProject(), params: {}, query: {} }, res);

    assert.equal(res.statusCode, 503);
    assert.equal(errors[0].ctx.poolCounts.byProjectOnly, 162);
    assert.match(errors[0].ctx.hint, /different job_id/);
    assert.ok(calls.length >= 2);
  });

  test('genuinely empty qualification (job discovered 0) -> 200 with zeros', async () => {
    const { errors } = logs();
    mock.method(Job, 'findOne', () => chain(makeJob({
      result_data: { discoveredUrls: 0, candidateUrls: 0, qualifiedUrls: 0, lowPriorityUrls: 0, rejectedUrls: 0, canonicalCount: 0, canonicalUrls: [] },
    })));
    stubDb({ pool: [] });

    const res = makeRes();
    await getUrlPool({ project: makeProject(), params: {}, query: {} }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.total_discovered, 0);
    assert.equal(res.body.data.total_qualified, 0);
    assert.deepEqual(res.body.data.urls, []);
    assert.equal(errors.length, 0);
  });

  test('no URL_QUALIFICATION job at all -> 409 job_status none', async () => {
    const { warns } = logs();
    mock.method(Job, 'findOne', () => chain(null));
    stubDb();

    const res = makeRes();
    await getUrlPool({ project: makeProject(), params: {}, query: {} }, res);

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.details.job_status, 'none');
    assert.equal(warns[0].ctx.latestJobStatus, 'none');
  });

  test('pending/running qualification job -> 409 carrying the job status', async () => {
    logs();
    let n = 0;
    // 1st lookup (status:'completed') finds nothing; 2nd (latest, any status) finds the running job.
    mock.method(Job, 'findOne', () => chain(n++ === 0 ? null : { _id: JOB_ID, status: 'running' }));
    stubDb();

    const res = makeRes();
    await getUrlPool({ project: makeProject(), params: {}, query: {} }, res);

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.details.job_status, 'running');
  });

  test('project not parked at awaiting_url_selection -> 409 without touching Job/pool', async () => {
    const find = mock.method(Job, 'findOne', () => chain(makeJob()));
    stubDb();

    const res = makeRes();
    await getUrlPool({ project: makeProject({ crawl_status: 'running' }), params: {}, query: {} }, res);

    assert.equal(res.statusCode, 409);
    assert.equal(find.mock.callCount(), 0);
  });

  test('qualified_only filter does not change total counts', async () => {
    logs();
    mock.method(Job, 'findOne', () => chain(makeJob()));
    stubDb({ pool: suppliedPool() });

    const res = makeRes();
    await getUrlPool({ project: makeProject(), params: {}, query: { qualified_only: 'true' } }, res);

    assert.equal(res.body.data.urls.length, 161);
    assert.equal(res.body.data.total_discovered, 162);
    assert.equal(res.body.data.total_qualified, 161);
  });
});

describe('url-pool authorization', () => {
  test('route is guarded by validateProjectAccess before getUrlPool', () => {
    const layer = seoProjectRoutes.stack.find((l) => l.route?.path === '/projects/:id/url-pool' && l.route.methods.get);
    assert.ok(layer, 'url-pool GET route registered');
    const handlers = layer.route.stack.map((s) => s.handle);
    assert.equal(handlers.length, 2);
    assert.equal(handlers[1], getUrlPool);
    assert.notEqual(handlers[0], getUrlPool); // middleware first
  });

  test("another user's project -> 403 from the middleware; controller never runs", async () => {
    mock.method(LoggerUtil, 'security', () => {});
    mock.method(AuthUtil, 'validateProjectAccess', async () => {
      const e = new Error('Access denied'); e.type = 'ACCESS_DENIED'; e.statusCode = 403; throw e;
    });
    const find = mock.method(Job, 'findOne', () => chain(makeJob()));

    const res = makeRes();
    res.accessDenied = undefined;
    let nextCalled = false;
    await validateProjectAccess()({ user: { id: 'intruder' }, params: { id: PROJECT_ID.toString() }, body: {}, query: {} }, res, () => { nextCalled = true; });

    assert.equal(res.statusCode, 403);
    assert.equal(nextCalled, false);
    assert.equal(find.mock.callCount(), 0);
  });
});

// Keep SeoProject referenced so import side effects (model registration) are explicit.
void SeoProject;
