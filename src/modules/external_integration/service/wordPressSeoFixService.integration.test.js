import { describe, test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import wordPressSeoFixService from './wordPressSeoFixService.js';
import wordPressService, { WordPressConnectionError } from './wordPressService.js';
import oditoSeoBridgeService from './oditoSeoBridgeService.js';
import Task from '../../tasks/model/Task.js';
import Recommendation from '../../recommendations/model/Recommendation.js';

/**
 * Production-readiness audit — integration tests for the Apply-via-WordPress
 * flow. Live Mongo (same auto-skip-if-unreachable pattern as
 * TaskVerificationService.test.js/chainingEngine.p3-006-events.test.js),
 * but the WordPress HTTP boundary is fully mocked (wordPressService.wpRequest
 * and getHydratedConnectionOrThrow) — never a live WordPress server, per the
 * audit's explicit instruction.
 *
 * Odito SEO Bridge integration: every test in the first describe block below
 * explicitly mocks the Bridge as NOT installed (mockBridgeNotInstalled()) —
 * they predate the Bridge and exist specifically to cover the LEGACY
 * direct-adapter path, which wordPressSeoFixService.validateFix() still
 * falls back to whenever the Bridge isn't present. The Bridge's OWN code
 * path (useBridge: true) is covered by the second describe block, further
 * down, which mocks oditoSeoBridgeService directly instead of wpRequest —
 * this file never makes a real HTTP call to a Bridge plugin; that is
 * covered separately by real, live-WordPress manual verification (see the
 * Phase 5 report), not by this mocked suite.
 */

let mongoAvailable = false;

before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
  } catch {
    mongoAvailable = false;
  }
});

after(async () => {
  if (mongoAvailable) await mongoose.connection.close();
});

function fakeConnection(overrides = {}) {
  return {
    project_id: overrides.projectId,
    detected_seo_provider: 'none',
    site_url: 'https://example.com',
    username: 'admin',
    application_password: 'not-a-real-password',
    status: 'connected',
    ...overrides,
  };
}

async function createRecommendation({ projectId, ruleId, optimizedValue }) {
  return Recommendation.create({
    projectId,
    fingerprint: `fp-${ruleId}-${new mongoose.Types.ObjectId()}`,
    recommendationHash: `hash-${new mongoose.Types.ObjectId()}`,
    ruleId,
    category: 'on_page',
    sections: {
      whyThisMatters: 'test',
      recommendedFix: 'test',
      implementationExample: { type: 'text', content: 'test' },
      contentRewrite: { optimized: optimizedValue },
    },
  });
}

/**
 * Mocks wordPressService.wpRequest with a small scripted responder for the
 * GET (getSeoData) and PUT (write) calls each adapter makes, per the
 * `script` callback (method, path, data) => {status, data} | throws.
 *
 * resolvePostIdFromUrl() is mocked SEPARATELY (see mockResolvePostId below)
 * rather than handled inside this same wpRequest mock — resolvePostIdFromUrl
 * calls its OWN module-local `wpRequest` function directly (not through
 * `wordPressService.wpRequest`), so mocking the exported wpRequest property
 * does not intercept that internal call; only resolvePostIdFromUrl's own
 * exported entry point can be mocked from outside the module.
 */
function mockWpRequest(script) {
  return mock.method(wordPressService, 'wpRequest', async (connection, { method, path, data }) => script(method, path, data));
}

/** Always resolves any pageUrl to postId 42 / postType 'posts' — the real slug/link resolution logic is covered separately at the unit level (wordPressService is not otherwise re-tested here). */
function mockResolvePostId() {
  return mock.method(wordPressService, 'resolvePostIdFromUrl', async () => ({ postId: 42, postType: 'posts' }));
}

/**
 * Mocked at the oditoSeoBridgeService level (not via wordPressService.wpRequest)
 * so every test below it stays a pure legacy-path test, regardless of what
 * its own mockWpRequest script happens to return for a GET — decoupling
 * "does this test exercise the legacy adapter" from "does the Bridge status
 * check's mocked response happen to look like it wasn't installed."
 */
function mockBridgeNotInstalled() {
  return mock.method(oditoSeoBridgeService, 'getBridgeStatus', async () => ({
    installed: false, provider: 'none', providers: [], bridgeVersion: null,
  }));
}

describe('wordPressSeoFixService.applyFix() — integration (live Mongo, mocked WordPress HTTP)', () => {
  let projectId;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    projectId = new mongoose.Types.ObjectId();
    await Task.deleteMany({ projectId });
    await Recommendation.deleteMany({ projectId });
    mock.restoreAll();
    mockResolvePostId();
    mockBridgeNotInstalled();
  });

  test('happy path: write succeeds, immediate verification succeeds, task transitions to implemented with wordpress_auto origin + externalWrite recorded', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const rec = await createRecommendation({ projectId, ruleId: 'title_missing', optimizedValue: 'New SEO Title' });
    const task = await Task.create({
      projectId, issueKey: 'title_missing', pageUrl: 'https://example.com/my-post',
      status: 'task_created', recommendationId: rec._id,
    });

    mock.method(wordPressService, 'getHydratedConnectionOrThrow', async () => fakeConnection({ projectId }));
    let currentTitle = 'Old Title';
    const writeCalls = [];
    mockWpRequest((method, path, data) => {
      if (method === 'GET') return { status: 200, data: { id: 42, link: 'https://example.com/my-post', title: { raw: currentTitle, rendered: currentTitle } } };
      if (method === 'PUT') {
        writeCalls.push(data);
        currentTitle = data.title;
        return { status: 200, data: {} };
      }
      throw new Error(`unexpected ${method} ${path}`);
    });

    const result = await wordPressSeoFixService.applyFix(task, { expectedCurrentValue: 'Old Title', approved: true });

    assert.equal(writeCalls.length, 1);
    assert.equal(result.alreadyApplied, false);
    assert.equal(result.immediateVerification, 'success');
    assert.equal(result.field, 'title');

    const saved = await Task.findById(task._id);
    assert.equal(saved.status, 'implemented');
    const latest = saved.fixHistory[saved.fixHistory.length - 1];
    assert.equal(latest.origin, 'wordpress_auto');
    assert.equal(latest.fixApplied.externalWrite.system, 'wordpress');
    assert.equal(latest.fixApplied.externalWrite.field, 'title');
    assert.equal(latest.fixApplied.externalWrite.wordpressPostId, 42);
  });

  test('idempotency: live value already equals desired value — no WordPress write occurs, task still transitions, immediate verification succeeds', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const rec = await createRecommendation({ projectId, ruleId: 'title_missing', optimizedValue: 'Already Correct Title' });
    const task = await Task.create({
      projectId, issueKey: 'title_missing', pageUrl: 'https://example.com/my-post',
      status: 'task_created', recommendationId: rec._id,
    });

    mock.method(wordPressService, 'getHydratedConnectionOrThrow', async () => fakeConnection({ projectId }));
    let putCalled = false;
    mockWpRequest((method) => {
      if (method === 'GET') return { status: 200, data: { id: 42, link: 'https://example.com/my-post', title: { raw: 'Already Correct Title', rendered: 'Already Correct Title' } } };
      if (method === 'PUT') { putCalled = true; return { status: 200, data: {} }; }
    });

    const result = await wordPressSeoFixService.applyFix(task, { approved: true });

    assert.equal(putCalled, false, 'no WordPress write should occur when the live value already matches');
    assert.equal(result.alreadyApplied, true);
    assert.equal(result.immediateVerification, 'success');

    const saved = await Task.findById(task._id);
    assert.equal(saved.status, 'implemented');
    const latest = saved.fixHistory[saved.fixHistory.length - 1];
    assert.equal(latest.fixApplied.externalWrite.wordpressPostId, null);
    assert.equal(latest.fixApplied.externalWrite.httpStatus, null);
  });

  test('expected-current conflict: stale expectedCurrentValue is refused with 409 CONFLICT, no write attempted, task untouched', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const rec = await createRecommendation({ projectId, ruleId: 'title_missing', optimizedValue: 'New Title' });
    const task = await Task.create({
      projectId, issueKey: 'title_missing', pageUrl: 'https://example.com/my-post',
      status: 'task_created', recommendationId: rec._id,
    });

    mock.method(wordPressService, 'getHydratedConnectionOrThrow', async () => fakeConnection({ projectId }));
    let putCalled = false;
    mockWpRequest((method) => {
      if (method === 'GET') return { status: 200, data: { id: 42, link: 'https://example.com/my-post', title: { raw: 'Actually Different Live Title', rendered: 'x' } } };
      if (method === 'PUT') { putCalled = true; return { status: 200, data: {} }; }
    });

    await assert.rejects(
      () => wordPressSeoFixService.applyFix(task, { expectedCurrentValue: 'What The User Was Shown', approved: true }),
      (err) => {
        assert.ok(err instanceof WordPressConnectionError);
        assert.equal(err.code, 'CONFLICT');
        assert.equal(err.statusCode, 409);
        assert.equal(err.details.actualCurrentValue, 'Actually Different Live Title');
        return true;
      }
    );
    assert.equal(putCalled, false, 'a conflicting read must never proceed to a write');

    const saved = await Task.findById(task._id);
    assert.equal(saved.status, 'task_created', 'task must remain untouched after a conflict');
  });

  test('WordPress write failure: adapter write throws — reported as WRITE_FAILED, task untouched', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const rec = await createRecommendation({ projectId, ruleId: 'title_missing', optimizedValue: 'New Title' });
    const task = await Task.create({
      projectId, issueKey: 'title_missing', pageUrl: 'https://example.com/my-post',
      status: 'task_created', recommendationId: rec._id,
    });

    mock.method(wordPressService, 'getHydratedConnectionOrThrow', async () => fakeConnection({ projectId }));
    mockWpRequest((method) => {
      if (method === 'GET') return { status: 200, data: { id: 42, link: 'https://example.com/my-post', title: { raw: 'Old Title', rendered: 'Old Title' } } };
      if (method === 'PUT') throw new Error('simulated network failure');
    });

    await assert.rejects(
      () => wordPressSeoFixService.applyFix(task, { approved: true }),
      (err) => {
        assert.ok(err instanceof WordPressConnectionError);
        assert.equal(err.code, 'WRITE_FAILED');
        return true;
      }
    );

    const saved = await Task.findById(task._id);
    assert.equal(saved.status, 'task_created', 'task must remain untouched after a write failure');
  });

  test('immediate verification failure: write succeeds but the post-write re-read does not match — reported as failed, task STILL transitions to implemented (never verified_fixed)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const rec = await createRecommendation({ projectId, ruleId: 'title_missing', optimizedValue: 'New Title' });
    const task = await Task.create({
      projectId, issueKey: 'title_missing', pageUrl: 'https://example.com/my-post',
      status: 'task_created', recommendationId: rec._id,
    });

    mock.method(wordPressService, 'getHydratedConnectionOrThrow', async () => fakeConnection({ projectId, detected_seo_provider: 'aioseo' }));
    // Simulates provider drift (e.g. AIOSEO was uninstalled after connect):
    // the write appears to succeed (WordPress silently ignores the unknown
    // aioseo_meta_data field), but the re-read never reflects it.
    mockWpRequest((method) => {
      if (method === 'GET') return { status: 200, data: { id: 42, link: 'https://example.com/my-post', aioseo_meta_data: undefined } };
      if (method === 'PUT') return { status: 200, data: {} };
    });

    const result = await wordPressSeoFixService.applyFix(task, { approved: true });

    assert.equal(result.immediateVerification, 'failed');
    const saved = await Task.findById(task._id);
    // Never lie about verification — 'implemented' (pending the real
    // recrawl), never 'verified_fixed', regardless of immediate outcome.
    assert.equal(saved.status, 'implemented');
  });

  test('provider conflict ("multiple" SEO plugins): refused with 409 PLUGIN_NOT_SUPPORTED, never silently resolved to one provider', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const rec = await createRecommendation({ projectId, ruleId: 'title_missing', optimizedValue: 'New Title' });
    const task = await Task.create({
      projectId, issueKey: 'title_missing', pageUrl: 'https://example.com/my-post',
      status: 'task_created', recommendationId: rec._id,
    });

    mock.method(wordPressService, 'getHydratedConnectionOrThrow', async () => fakeConnection({ projectId, detected_seo_provider: 'multiple' }));

    await assert.rejects(
      () => wordPressSeoFixService.validateFix(task),
      (err) => {
        assert.ok(err instanceof WordPressConnectionError);
        assert.equal(err.code, 'PLUGIN_NOT_SUPPORTED');
        assert.equal(err.statusCode, 409);
        return true;
      }
    );
  });

  test('unsupported capability (Rank Math, no bridge): title write refused with FIELD_NOT_WRITABLE, before any live read', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const rec = await createRecommendation({ projectId, ruleId: 'title_missing', optimizedValue: 'New Title' });
    const task = await Task.create({
      projectId, issueKey: 'title_missing', pageUrl: 'https://example.com/my-post',
      status: 'task_created', recommendationId: rec._id,
    });

    mock.method(wordPressService, 'getHydratedConnectionOrThrow', async () => fakeConnection({ projectId, detected_seo_provider: 'rank_math' }));
    mockWpRequest(() => { throw new Error('should never be called — capability check must reject first'); });

    await assert.rejects(
      () => wordPressSeoFixService.validateFix(task),
      (err) => {
        assert.ok(err instanceof WordPressConnectionError);
        assert.equal(err.code, 'FIELD_NOT_WRITABLE');
        return true;
      }
    );
    assert.equal(wordPressService.wpRequest.mock.callCount(), 0, 'capability rejection must happen before any live WordPress call');
  });

  test('provider mismatch (recommendation belongs to a different project): refused before any WordPress call', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const otherProjectId = new mongoose.Types.ObjectId();
    const foreignRec = await createRecommendation({ projectId: otherProjectId, ruleId: 'title_missing', optimizedValue: 'Exfiltrated Content' });
    const task = await Task.create({
      projectId, issueKey: 'title_missing', pageUrl: 'https://example.com/my-post',
      status: 'task_created', recommendationId: foreignRec._id,
    });

    mock.method(wordPressService, 'getHydratedConnectionOrThrow', async () => fakeConnection({ projectId }));
    mockWpRequest(() => { throw new Error('should never be called — cross-project recommendation must be rejected first'); });

    await assert.rejects(
      () => wordPressSeoFixService.applyFix(task, { approved: true }),
      (err) => {
        assert.ok(err instanceof WordPressConnectionError);
        assert.equal(err.code, 'RECOMMENDATION_REQUIRED');
        return true;
      }
    );
    assert.equal(wordPressService.wpRequest.mock.callCount(), 0);
  });

  test('duplicate apply attempt: a second apply on an already-implemented task is rejected by the state machine, not silently re-applied', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const rec = await createRecommendation({ projectId, ruleId: 'title_missing', optimizedValue: 'New Title' });
    const task = await Task.create({
      projectId, issueKey: 'title_missing', pageUrl: 'https://example.com/my-post',
      status: 'task_created', recommendationId: rec._id,
    });

    mock.method(wordPressService, 'getHydratedConnectionOrThrow', async () => fakeConnection({ projectId }));
    let putCount = 0;
    mockWpRequest((method) => {
      if (method === 'GET') return { status: 200, data: { id: 42, link: 'https://example.com/my-post', title: { raw: 'Old Title', rendered: 'Old Title' } } };
      if (method === 'PUT') { putCount += 1; return { status: 200, data: {} }; }
    });

    await wordPressSeoFixService.applyFix(task, { approved: true });
    assert.equal(putCount, 1);

    const reloaded = await Task.findById(task._id);
    await assert.rejects(
      () => wordPressSeoFixService.applyFix(reloaded, { approved: true }),
      (err) => {
        assert.ok(err instanceof WordPressConnectionError);
        assert.equal(err.code, 'CONFLICT');
        return true;
      }
    );
    assert.equal(putCount, 1, 'the second, rejected attempt must never reach a WordPress write');
  });

  test('Task VersionError after a successful WordPress write: reported honestly as CONFLICT, WordPress write is NOT rolled back', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const rec = await createRecommendation({ projectId, ruleId: 'title_missing', optimizedValue: 'New Title' });
    const task = await Task.create({
      projectId, issueKey: 'title_missing', pageUrl: 'https://example.com/my-post',
      status: 'task_created', recommendationId: rec._id,
    });

    mock.method(wordPressService, 'getHydratedConnectionOrThrow', async () => fakeConnection({ projectId }));
    let putCount = 0;
    mockWpRequest((method) => {
      if (method === 'GET') return { status: 200, data: { id: 42, link: 'https://example.com/my-post', title: { raw: 'Old Title', rendered: 'Old Title' } } };
      if (method === 'PUT') { putCount += 1; return { status: 200, data: {} }; }
    });

    // Two independent in-memory copies of the SAME task document, exactly
    // like two concurrent HTTP requests each calling Task.findById() —
    // real Mongoose optimistic concurrency (Task.js's optimisticConcurrency)
    // decides the winner/loser, no artificial VersionError injection.
    const copyA = await Task.findById(task._id);
    const copyB = await Task.findById(task._id);

    const results = await Promise.allSettled([
      wordPressSeoFixService.applyFix(copyA, { approved: true }),
      wordPressSeoFixService.applyFix(copyB, { approved: true }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'exactly one concurrent apply should win the Task save race');
    assert.equal(rejected.length, 1, 'exactly one concurrent apply should lose the race');
    assert.equal(rejected[0].reason.code, 'CONFLICT');
    assert.equal(rejected[0].reason.details.wordpressWriteSucceeded, true);
    // Both requests' WordPress writes DID go through (WordPress has no
    // transaction to roll back into) — this is expected, documented
    // behavior, not something to "fix" by faking a rollback.
    assert.equal(putCount, 2);

    const saved = await Task.findById(task._id);
    assert.equal(saved.status, 'implemented');
  });
});

/**
 * Odito SEO Bridge — write-layer selection inside wordPressSeoFixService.
 * These tests mock oditoSeoBridgeService directly (getBridgeStatus/
 * getBridgeCapabilities/readSeoData/writeSeoField) rather than
 * wordPressService.wpRequest — the goal here is "does validateFix()/
 * applyFix() correctly PREFER the Bridge and route through it," not
 * re-proving the Bridge's own HTTP mechanics (oditoSeoBridgeService's own
 * behavior against a real WordPress site is covered by the manual
 * real-environment validation in the Phase 5 report, and its response
 * shaping/error classification would be covered by a dedicated
 * oditoSeoBridgeService.test.js).
 */
describe('wordPressSeoFixService — Odito SEO Bridge write-layer selection', () => {
  let projectId;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    projectId = new mongoose.Types.ObjectId();
    await Task.deleteMany({ projectId });
    await Recommendation.deleteMany({ projectId });
    mock.restoreAll();
  });

  test('Bridge installed with a single supported provider: write and read both go through the Bridge, never the legacy adapter', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const rec = await createRecommendation({ projectId, ruleId: 'title_missing', optimizedValue: 'Bridge-Written Title' });
    const task = await Task.create({
      projectId, issueKey: 'title_missing', pageUrl: 'https://example.com/my-post',
      status: 'task_created', recommendationId: rec._id,
    });

    mock.method(wordPressService, 'getHydratedConnectionOrThrow', async () => fakeConnection({ projectId, detected_seo_provider: 'rank_math' }));
    mock.method(wordPressService, 'resolvePostIdFromUrl', async () => ({ postId: 42, postType: 'posts' }));
    mock.method(oditoSeoBridgeService, 'getBridgeStatus', async () => ({
      installed: true, provider: 'rank_math', providers: ['rank_math'], bridgeVersion: '1.0.0',
    }));
    mock.method(oditoSeoBridgeService, 'getBridgeCapabilities', async () => ({
      installed: true, provider: 'rank_math', providers: ['rank_math'],
      fields: { title: { read: true, write: true }, meta_description: { read: true, write: true }, canonical: { read: true, write: true } },
    }));

    let currentTitle = 'Old Rank Math Title';
    const writeCalls = [];
    mock.method(oditoSeoBridgeService, 'readSeoData', async (connection, postId) => {
      assert.equal(postId, 42);
      return { provider: 'rank_math', fields: { title: currentTitle, meta_description: null, canonical: null } };
    });
    mock.method(oditoSeoBridgeService, 'writeSeoField', async (connection, postId, field, value) => {
      writeCalls.push({ postId, field, value });
      currentTitle = value;
      return { provider: 'rank_math', field, value };
    });
    // The Bridge path must never fall through to a raw wpRequest call for
    // the actual SEO read/write — only the legacy adapter path does that.
    mockWpRequest(() => { throw new Error('legacy wpRequest must not be called on the Bridge path'); });

    const result = await wordPressSeoFixService.applyFix(task, { expectedCurrentValue: 'Old Rank Math Title', approved: true });

    assert.equal(writeCalls.length, 1);
    assert.deepEqual(writeCalls[0], { postId: 42, field: 'title', value: 'Bridge-Written Title' });
    assert.equal(result.alreadyApplied, false);
    assert.equal(result.immediateVerification, 'success');
    assert.equal(result.provider, 'rank_math');

    const saved = await Task.findById(task._id);
    assert.equal(saved.status, 'implemented');
    const latest = saved.fixHistory[saved.fixHistory.length - 1];
    assert.equal(latest.origin, 'wordpress_auto');
    assert.equal(latest.fixApplied.externalWrite.provider, 'rank_math');
    assert.equal(latest.fixApplied.externalWrite.wordpressPostId, 42);
  });

  test('Bridge installed but ambiguous ("multiple" active SEO plugins): refused with 409 PLUGIN_NOT_SUPPORTED before any read/write', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const rec = await createRecommendation({ projectId, ruleId: 'title_missing', optimizedValue: 'New Title' });
    const task = await Task.create({
      projectId, issueKey: 'title_missing', pageUrl: 'https://example.com/my-post',
      status: 'task_created', recommendationId: rec._id,
    });

    mock.method(wordPressService, 'getHydratedConnectionOrThrow', async () => fakeConnection({ projectId, detected_seo_provider: 'rank_math' }));
    mock.method(oditoSeoBridgeService, 'getBridgeStatus', async () => ({
      installed: true, provider: 'multiple', providers: ['rank_math', 'yoast'], bridgeVersion: '1.0.0',
    }));
    const capabilitiesCall = mock.method(oditoSeoBridgeService, 'getBridgeCapabilities', async () => {
      throw new Error('capabilities must never be fetched once the Bridge itself reports ambiguity');
    });

    await assert.rejects(
      () => wordPressSeoFixService.validateFix(task),
      (err) => {
        assert.ok(err instanceof WordPressConnectionError);
        assert.equal(err.code, 'PLUGIN_NOT_SUPPORTED');
        assert.equal(err.statusCode, 409);
        return true;
      }
    );
    assert.equal(capabilitiesCall.mock.callCount(), 0);
  });

  test('Bridge installed but reports the field as not writable (e.g. SEOPress canonical): refused with FIELD_NOT_WRITABLE before any live read', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const rec = await createRecommendation({ projectId, ruleId: 'canonical_missing', optimizedValue: 'https://example.com/canonical' });
    const task = await Task.create({
      projectId, issueKey: 'canonical_missing', pageUrl: 'https://example.com/my-post',
      status: 'task_created', recommendationId: rec._id,
    });

    mock.method(wordPressService, 'getHydratedConnectionOrThrow', async () => fakeConnection({ projectId, detected_seo_provider: 'seopress' }));
    mock.method(oditoSeoBridgeService, 'getBridgeStatus', async () => ({
      installed: true, provider: 'seopress', providers: ['seopress'], bridgeVersion: '1.0.0',
    }));
    mock.method(oditoSeoBridgeService, 'getBridgeCapabilities', async () => ({
      installed: true, provider: 'seopress', providers: ['seopress'],
      fields: { title: { read: true, write: true }, meta_description: { read: true, write: true }, canonical: { read: false, write: false } },
    }));
    const readCall = mock.method(oditoSeoBridgeService, 'readSeoData', async () => {
      throw new Error('must never read live data once the field capability check has already failed');
    });

    await assert.rejects(
      () => wordPressSeoFixService.validateFix(task),
      (err) => {
        assert.ok(err instanceof WordPressConnectionError);
        assert.equal(err.code, 'FIELD_NOT_WRITABLE');
        return true;
      }
    );
    assert.equal(readCall.mock.callCount(), 0);
  });

  test('Bridge installed but reports no supported provider active ("none"): falls back to the legacy adapter path', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const rec = await createRecommendation({ projectId, ruleId: 'title_missing', optimizedValue: 'New Title' });
    const task = await Task.create({
      projectId, issueKey: 'title_missing', pageUrl: 'https://example.com/my-post',
      status: 'task_created', recommendationId: rec._id,
    });

    // Bridge is installed (e.g. activated ahead of an SEO plugin) but has
    // nothing supported to report yet — connection-level detection also
    // says 'none', so the legacy WordPressCoreAdapter (title-writable via
    // core REST) is the correct fallback, exactly as if the Bridge were
    // absent entirely.
    mock.method(wordPressService, 'getHydratedConnectionOrThrow', async () => fakeConnection({ projectId, detected_seo_provider: 'none' }));
    mock.method(oditoSeoBridgeService, 'getBridgeStatus', async () => ({
      installed: true, provider: 'none', providers: [], bridgeVersion: '1.0.0',
    }));
    mock.method(wordPressService, 'resolvePostIdFromUrl', async () => ({ postId: 42, postType: 'posts' }));
    let putCalled = false;
    mockWpRequest((method) => {
      if (method === 'GET') return { status: 200, data: { id: 42, link: 'https://example.com/my-post', title: { raw: 'Old Title', rendered: 'Old Title' } } };
      if (method === 'PUT') { putCalled = true; return { status: 200, data: {} }; }
    });

    const result = await wordPressSeoFixService.applyFix(task, { approved: true });

    assert.equal(putCalled, true, 'the legacy WordPressCoreAdapter should have been used');
    assert.equal(result.provider, 'none');
  });
});
