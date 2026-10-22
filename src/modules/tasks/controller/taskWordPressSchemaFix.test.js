import { describe, test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import { applyWordPressFix } from './taskController.js';
import { previewWordPressFix, reverifyWordPressFix, rollbackWordPressFix } from './taskWordPressSchemaFix.js';
import wordPressSeoFixService from '../../external_integration/service/wordPressSeoFixService.js';
import organizationFixService from '../../external_integration/schemaFix/organizationFixService.js';
import { WordPressConnectionError } from '../../external_integration/service/wordPressService.js';
import Task from '../model/Task.js';
import { AuthUtil } from '../../../utils/AuthUtil.js';

/**
 * HTTP-layer rules for the typed Organization fix: project ownership is proven BEFORE anything is read or written,
 * only the approval flag and the previewed plan's fingerprint are taken from the client, and every other issue type keeps
 * its existing apply path untouched.
 */

const taskId = new mongoose.Types.ObjectId().toString();
const res = () => { const r = { statusCode: null, body: null, status(c) { r.statusCode = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
const req = (body = {}, extra = {}) => ({ params: { taskId }, body, user: { _id: 'u1' }, ...extra });

let calls;
let taskDoc;
beforeEach(() => {
  mock.restoreAll();
  calls = { preview: 0, apply: [], reverify: 0, rollback: [], legacy: 0 };
  taskDoc = { _id: taskId, projectId: 'p1', issueKey: 'organization_schema', pageUrl: 'https://x.com/', status: 'task_created' };
  mock.method(AuthUtil, 'validateProjectAccess', async () => true);
  mock.method(Task, 'findById', async () => taskDoc);
  mock.method(organizationFixService, 'getOrganizationFixPreview', async () => { calls.preview += 1; return { fixType: 'organization_schema' }; });
  mock.method(organizationFixService, 'applyOrganizationFix', async (_t, input) => { calls.apply.push(input); return { task: taskDoc, fix: { status: 'applied' }, alreadyApplied: false, immediateVerification: 'success' }; });
  mock.method(organizationFixService, 'reverifyOrganizationFix', async () => { calls.reverify += 1; return { fix: {} }; });
  mock.method(organizationFixService, 'rollbackOrganizationFix', async (_t, input) => { calls.rollback.push(input); return { fix: {}, message: 'ok' }; });
  mock.method(wordPressSeoFixService, 'applyFix', async () => { calls.legacy += 1; return { task: taskDoc, field: 'title', provider: 'rank_math', alreadyApplied: false, immediateVerification: 'success' }; });
});

describe('ownership and shape come first', () => {
  const denied = () => AuthUtil.validateProjectAccess.mock.mockImplementation(async () => { const e = new Error('no access'); e.type = 'ACCESS_DENIED'; throw e; });

  test('a user without access to the task\'s project is refused (403) on preview, apply, reverify and rollback — no service is called', async () => {
    denied();
    for (const [name, run] of [
      ['preview', () => previewWordPressFix(req(), res())],
      ['reverify', () => reverifyWordPressFix(req(), res())],
      ['rollback', () => rollbackWordPressFix(req(), res())],
    ]) {
      const r = res();
      const fn = { preview: previewWordPressFix, reverify: reverifyWordPressFix, rollback: rollbackWordPressFix }[name];
      await fn(req(), r);
      assert.equal(r.statusCode, 403, name);
      assert.ok(run);
    }
    const r = res();
    await applyWordPressFix(req({ approved: true, expectedPlanFingerprint: 'a'.repeat(64) }), r);
    assert.equal(r.statusCode, 403);
    assert.equal(calls.preview + calls.apply.length + calls.reverify + calls.rollback.length + calls.legacy, 0);
  });

  test('an unknown task is 404 and a malformed id is 400 (no database access for the latter)', async () => {
    Task.findById.mock.mockImplementation(async () => null);
    const r1 = res(); await previewWordPressFix(req(), r1); assert.equal(r1.statusCode, 404);
    const r2 = res(); await previewWordPressFix({ params: { taskId: 'not-an-id' }, body: {}, user: { _id: 'u1' } }, r2); assert.equal(r2.statusCode, 400);
  });

  test('a soft-deleted task is not found', async () => {
    taskDoc.isDeleted = true;
    const r = res(); await rollbackWordPressFix(req(), r);
    assert.equal(r.statusCode, 404);
    assert.equal(calls.rollback.length, 0);
  });

  test('an issue type without a typed schema fix is 422 on the typed routes', async () => {
    taskDoc.issueKey = 'title_missing';
    const r = res(); await previewWordPressFix(req(), r);
    assert.equal(r.statusCode, 422);
    assert.equal(calls.preview, 0);
  });
});

describe('the apply branch', () => {
  test('an Organization task goes through the typed fix and forwards ONLY approved + the plan fingerprint (+ the actor) — never a field, value, meta key or option name', async () => {
    const r = res();
    await applyWordPressFix(req({
      approved: true, expectedPlanFingerprint: 'a'.repeat(64),
      field: 'logo', value: 'https://evil.example/x.png', optionName: 'rank-math-options-titles', provider: 'yoast', changes: [{ field: 'url', after: 'https://evil.example/' }],
    }), r);
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.data.field, 'organization_schema');
    assert.equal(r.body.data.fix.status, 'applied');
    assert.equal(calls.legacy, 0, 'the single-value path is not used');
    assert.deepEqual(Object.keys(calls.apply[0]).sort(), ['actorId', 'approved', 'expectedPlanFingerprint']);
    assert.equal(calls.apply[0].actorId, 'u1');
  });

  test('typed errors are relayed with their code, status and details (conflict, unsupported, permission)', async () => {
    organizationFixService.applyOrganizationFix.mock.mockImplementation(async () => {
      const e = new WordPressConnectionError('CONFLICT', 'stale', 409); e.details = { reason: 'preview_stale', currentFingerprint: 'f'.repeat(64) }; throw e;
    });
    const r = res();
    await applyWordPressFix(req({ approved: true, expectedPlanFingerprint: 'a'.repeat(64) }), r);
    assert.equal(r.statusCode, 409);
    assert.equal(r.body.code, 'CONFLICT');
    assert.equal(r.body.details.reason, 'preview_stale');

    organizationFixService.applyOrganizationFix.mock.mockImplementation(async () => { throw new Error('boom: secret-token'); });
    const r2 = res();
    await applyWordPressFix(req({ approved: true, expectedPlanFingerprint: 'a'.repeat(64) }), r2);
    assert.equal(r2.statusCode, 500);
    assert.doesNotMatch(JSON.stringify(r2.body), /secret-token/, 'an unexpected error never leaks its message');
  });

  test('every other issue type still uses the existing apply path, unchanged', async () => {
    taskDoc.issueKey = 'title_missing';
    const r = res();
    await applyWordPressFix(req({ approved: true, expectedCurrentValue: 'old' }), r);
    assert.equal(r.statusCode, 200);
    assert.equal(calls.legacy, 1);
    assert.equal(calls.apply.length, 0);
  });
});

describe('preview / reverify / rollback pass the actor and return the service result', () => {
  test('success shapes', async () => {
    const p = res(); await previewWordPressFix(req(), p);
    assert.deepEqual(p.body, { success: true, data: { fixType: 'organization_schema' } });
    const v = res(); await reverifyWordPressFix(req(), v);
    assert.equal(v.statusCode, 200);
    const b = res(); await rollbackWordPressFix(req(), b);
    assert.equal(b.statusCode, 200);
    assert.deepEqual(calls.rollback, [{ actorId: 'u1' }]);
  });
});
