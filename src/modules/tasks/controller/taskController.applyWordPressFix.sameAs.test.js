import { describe, test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import { applyWordPressFix } from './taskController.js';
import wordPressSeoFixService from '../../external_integration/service/wordPressSeoFixService.js';
import Task from '../model/Task.js';
import { AuthUtil } from '../../../utils/AuthUtil.js';

/**
 * Request-shape rules for POST /tasks/:taskId/apply-wordpress with sameAs
 * profile fields. Content validation is wordPressSeoFixService's job (tested
 * there); this only pins what the controller accepts and forwards.
 */

const taskId = new mongoose.Types.ObjectId().toString();

function fakeRes() {
  const res = { statusCode: null, body: null, status(c) { res.statusCode = c; return res; }, json(b) { res.body = b; return res; } };
  return res;
}
const req = (body) => ({ params: { taskId }, body, user: { _id: 'u1' } });

let applyCalls;
beforeEach(() => {
  mock.restoreAll();
  applyCalls = [];
  mock.method(AuthUtil, 'validateProjectAccess', async () => true);
  mock.method(Task, 'findById', async () => ({ _id: taskId, projectId: 'p1', issueKey: 'sameas_array', pageUrl: 'https://x.com/', status: 'task_created' }));
  mock.method(wordPressSeoFixService, 'applyFix', async (_task, input) => { applyCalls.push(input); throw new Error('stop after recording input'); });
});

describe('applyWordPressFix — profile fields', () => {
  for (const [name, bad] of [
    ['additionalProfiles', 'https://www.linkedin.com/company/x'],
    ['additionalProfiles', [42]],
    ['additionalProfiles', { 0: 'https://x.com/a' }],
    ['removeProfiles', 'https://x.com/a'],
    ['expectedAdditionalProfiles', [null]],
  ]) {
    test(`${name} = ${JSON.stringify(bad)} is a 400 INVALID_PROFILES before the task is even loaded`, async () => {
      const res = fakeRes();
      await applyWordPressFix(req({ approved: true, [name]: bad }), res);
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.code, 'INVALID_PROFILES');
      assert.equal(Task.findById.mock.callCount(), 0);
    });
  }

  test('an oversized list is rejected', async () => {
    const res = fakeRes();
    await applyWordPressFix(req({ approved: true, additionalProfiles: Array.from({ length: 201 }, (_, i) => `https://e.com/${i}`) }), res);
    assert.equal(res.statusCode, 400);
  });

  test('forwards ONLY the three profile fields plus approved/expectedCurrentValue/expectedContentFingerprint — never any other body field', async () => {
    const res = fakeRes();
    await applyWordPressFix(req({
      approved: true,
      additionalProfiles: ['https://www.linkedin.com/company/x'],
      removeProfiles: ['https://www.youtube.com/@x'],
      expectedAdditionalProfiles: ['https://www.youtube.com/@x'],
      optionName: 'rank-math-options-titles', metaKey: 'rank_math_title', schema: { '@type': 'Organization' }, provider: 'yoast',
    }), res);

    assert.equal(applyCalls.length, 1);
    assert.deepEqual(Object.keys(applyCalls[0]).sort(), ['additionalProfiles', 'approved', 'expectedAdditionalProfiles', 'expectedContentFingerprint', 'expectedCurrentValue', 'removeProfiles']);
    assert.deepEqual(applyCalls[0].additionalProfiles, ['https://www.linkedin.com/company/x']);
  });

  test('omitted profile fields are forwarded as undefined (other issue types are unaffected)', async () => {
    const res = fakeRes();
    await applyWordPressFix(req({ approved: true, expectedCurrentValue: 'old' }), res);
    assert.equal(applyCalls[0].additionalProfiles, undefined);
    assert.equal(applyCalls[0].removeProfiles, undefined);
    assert.equal(applyCalls[0].expectedAdditionalProfiles, undefined);
    assert.equal(applyCalls[0].expectedCurrentValue, 'old');
  });

  test('a user without access to the project that owns the task is refused (403) before anything is applied', async () => {
    AuthUtil.validateProjectAccess.mock.mockImplementation(async () => { const e = new Error('no access'); e.type = 'ACCESS_DENIED'; throw e; });
    const res = fakeRes();
    await applyWordPressFix(req({ approved: true, additionalProfiles: ['https://www.linkedin.com/company/x'] }), res);
    assert.equal(res.statusCode, 403);
    assert.equal(applyCalls.length, 0);
  });
});
