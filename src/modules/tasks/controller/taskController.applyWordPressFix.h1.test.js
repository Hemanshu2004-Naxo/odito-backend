import { describe, test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import { applyWordPressFix } from './taskController.js';
import wordPressSeoFixService from '../../external_integration/service/wordPressSeoFixService.js';
import Task from '../model/Task.js';
import { AuthUtil } from '../../../utils/AuthUtil.js';

/**
 * Request-shape rules for POST /tasks/:taskId/apply-wordpress for the page-content (H1) fix: the
 * client may send exactly one thing about the page — the fingerprint of the state it reviewed.
 * Content, post ids, field names and values in the body are never forwarded.
 */

const taskId = new mongoose.Types.ObjectId().toString();
const FINGERPRINT = 'c1ad5513295e2e05adcca70a41557391d2942e11c2492e0ceceba452bc7ac96e';

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
  mock.method(Task, 'findById', async () => ({ _id: taskId, projectId: 'p1', issueKey: 'h1_missing', pageUrl: 'https://naxonify.com/seo-reseller', status: 'task_created' }));
  mock.method(wordPressSeoFixService, 'applyFix', async (_task, input) => { applyCalls.push(input); throw new Error('stop after recording input'); });
});

describe('applyWordPressFix — page-content (H1) request shape', () => {
  for (const bad of ['short', 'Z'.repeat(64), 'c1ad'.repeat(17), 42, {}, ['a'.repeat(64)]]) {
    test(`expectedContentFingerprint = ${JSON.stringify(bad)} is a 400 before the task is loaded`, async () => {
      const res = fakeRes();
      await applyWordPressFix(req({ approved: true, expectedContentFingerprint: bad }), res);
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.code, 'EXPECTED_STATE_REQUIRED');
      assert.equal(Task.findById.mock.callCount(), 0);
    });
  }

  test('a valid fingerprint is forwarded; content / post id / value / meta key fields are dropped', async () => {
    const res = fakeRes();
    await applyWordPressFix(req({
      approved: true,
      expectedContentFingerprint: FINGERPRINT,
      content: '<h1>Attacker</h1>', post_content: 'x', postId: 1, value: 'Attacker', h1Text: 'Attacker', metaKey: 'k', php: '<?php ?>',
    }), res);

    assert.equal(applyCalls.length, 1);
    assert.equal(applyCalls[0].expectedContentFingerprint, FINGERPRINT);
    for (const forbidden of ['content', 'post_content', 'postId', 'value', 'h1Text', 'metaKey', 'php']) {
      assert.equal(forbidden in applyCalls[0], false, `${forbidden} must never be forwarded`);
    }
  });

  test('an omitted fingerprint is forwarded as undefined (the service refuses an H1 write without it)', async () => {
    await applyWordPressFix(req({ approved: true }), fakeRes());
    assert.equal(applyCalls[0].expectedContentFingerprint, undefined);
  });

  test('a stale-page CONFLICT from the service reaches the client as 409 with its reason', async () => {
    const { WordPressConnectionError } = await import('../../external_integration/service/wordPressService.js');
    wordPressSeoFixService.applyFix.mock.restore();
    mock.method(wordPressSeoFixService, 'applyFix', async () => {
      const e = new WordPressConnectionError('CONFLICT', 'This page changed on WordPress after you reviewed it.', 409);
      e.details = { field: 'h1', reason: 'stale_current_value' };
      throw e;
    });
    const res = fakeRes();
    await applyWordPressFix(req({ approved: true, expectedContentFingerprint: FINGERPRINT }), res);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'CONFLICT');
    assert.equal(res.body.details.reason, 'stale_current_value');
  });
});
