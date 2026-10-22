import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SeoProject from '../../app_user/model/SeoProject.js';
import SocialAccount from '../model/SocialAccount.js';
import SocialPublication from '../model/SocialPublication.js';
import SocialApprovalSettings from '../model/SocialApprovalSettings.js';
import adapters from '../service/platformAdapters/index.js';
import router from '../routes/socialPublishingRoutes.js';
import {
  createPublicationHandler, listPublicationsHandler, publishPublicationHandler, schedulePublicationHandler,
  submitContentHandler, approveContentHandler, requestContentChangesHandler, submitDesignHandler, approveDesignHandler,
  requestDesignChangesHandler, approvalSummaryHandler, getApprovalSettingsHandler, updateApprovalSettingsHandler,
} from './socialPublishingController.js';
import '../testSupport/stubPermalinkLookup.js';

/**
 * HTTP-layer coverage for the approval endpoints: response shape + status
 * codes via the module's existing error convention, the publish gate through
 * the real publish handler, and route wiring/ordering. The state machine itself
 * is covered exhaustively in service/approvalWorkflow.test.js.
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

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

describe('approval routes — wiring', () => {
  const routes = router.stack.filter((l) => l.route).map((l) => ({ path: l.route.path, methods: Object.keys(l.route.methods), handlers: l.route.stack.length }));
  const indexOf = (path, method) => routes.findIndex((r) => r.path === path && r.methods.includes(method));

  test('1: every approval action is a POST behind auth + validateProjectAccess (3 middleware layers)', () => {
    for (const suffix of ['content/submit', 'content/approve', 'content/request-changes', 'design/submit', 'design/approve', 'design/request-changes']) {
      const i = indexOf(`/:publicationId/${suffix}`, 'post');
      assert.ok(i >= 0, `${suffix} is routed`);
      assert.equal(routes[i].handlers, 3, `${suffix}: auth + validateProjectAccess + handler`);
    }
    for (const [path, method] of [['/approvals/summary', 'get'], ['/approval-settings', 'get'], ['/approval-settings', 'put']]) {
      const i = indexOf(path, method);
      assert.ok(i >= 0, `${method} ${path} is routed`);
      assert.equal(routes[i].handlers, 3);
    }
  });

  test('2: literal approval paths are declared before /:publicationId so they are never read as a publication id', () => {
    assert.ok(indexOf('/approval-settings', 'get') < indexOf('/:publicationId', 'get'));
    assert.ok(indexOf('/approval-settings', 'put') < indexOf('/:publicationId', 'get'));
    assert.ok(indexOf('/approvals/summary', 'get') < indexOf('/:publicationId', 'get'));
  });

  test('3: an unknown approval filter is rejected with 400', async () => {
    const res = mockRes();
    await listPublicationsHandler({ projectId: 'p', query: { approval: 'bogus' } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.details?.code, 'INVALID_APPROVAL_FILTER');
  });
});

describe('approval endpoints — real MongoDB', () => {
  let project, userId, account, pid, uid;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    userId = new mongoose.Types.ObjectId();
    uid = userId.toString();
    project = await SeoProject.create({
      user_id: userId, project_name: `Approval Ctrl Test ${Date.now()} ${Math.random().toString(36).slice(2, 8)}`, main_url: 'https://example.com',
      seo_scope: 'local', keywords: ['approval controller'],
    });
    pid = project._id.toString();
    account = await SocialAccount.create({
      user_id: userId, project_id: project._id, platform: 'facebook', platformAccountId: 'pg_appr_ctrl', platformAccountName: 'Approval Ctrl Page',
      accountType: 'page', pageId: 'pg_appr_ctrl', accessToken: 'real-token', status: 'active',
      scopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'],
    });
  });

  afterEach(async () => {
    if (!mongoAvailable) return;
    await SocialPublication.deleteMany({ project_id: project._id });
    await SocialAccount.deleteMany({ project_id: project._id });
    await SocialApprovalSettings.deleteMany({ project_id: project._id });
    await SeoProject.deleteOne({ _id: project._id });
  });

  const call = async (handler, { params = {}, body = {}, query = {}, projectId } = {}) => {
    const res = mockRes();
    await handler({ projectId: projectId || pid, userId: uid, params, body, query }, res);
    return res;
  };

  async function newDraft() {
    const res = await call(createPublicationHandler, { body: { platform: 'facebook', socialAccountId: account._id.toString(), content: 'Caption' } });
    assert.equal(res.statusCode, 201);
    return res.body.data.publication;
  }

  test('4: submit -> approve -> request-changes work end to end and return the updated publication', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const d = await newDraft();
    const submit = await call(submitContentHandler, { params: { publicationId: d.id } });
    assert.equal(submit.statusCode, 200);
    assert.equal(submit.body.data.publication.approval.state, 'content_review');

    const rc = await call(requestContentChangesHandler, { params: { publicationId: d.id }, body: { version: 1, reason: 'Shorter please' } });
    assert.equal(rc.statusCode, 200);
    assert.equal(rc.body.data.publication.approval.changesRequested.reason, 'Shorter please');

    const ok = await call(approveContentHandler, { params: { publicationId: d.id }, body: { version: 1 } });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.body.data.publication.approval.state, 'content_approved');

    const sd = await call(submitDesignHandler, { params: { publicationId: d.id } });
    assert.equal(sd.body.data.publication.approval.state, 'design_review');
    const drc = await call(requestDesignChangesHandler, { params: { publicationId: d.id }, body: { version: 1, reason: 'Wrong crop' } });
    assert.equal(drc.statusCode, 200);
    const da = await call(approveDesignHandler, { params: { publicationId: d.id }, body: { version: 1 } });
    assert.equal(da.body.data.publication.approval.stage, 'ready_to_schedule');
  });

  test('5: failures use the existing error convention with the right HTTP status and details.code', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const d = await newDraft();
    const invalid = await call(approveContentHandler, { params: { publicationId: d.id }, body: { version: 1 } });
    assert.equal(invalid.statusCode, 409);
    assert.equal(invalid.body.details.code, 'INVALID_APPROVAL_STATE');
    assert.equal(invalid.body.success, false);

    await call(submitContentHandler, { params: { publicationId: d.id } });
    assert.equal((await call(approveContentHandler, { params: { publicationId: d.id }, body: {} })).statusCode, 400);
    assert.equal((await call(requestContentChangesHandler, { params: { publicationId: d.id }, body: { version: 1 } })).body.details.code, 'REASON_REQUIRED');
    const stale = await call(approveContentHandler, { params: { publicationId: d.id }, body: { version: 7 } });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.body.details.code, 'VERSION_MISMATCH');
    const missing = await call(approveContentHandler, { params: { publicationId: new mongoose.Types.ObjectId().toString() }, body: { version: 1 } });
    assert.equal(missing.statusCode, 404);
  });

  test('6: a different project gets 404 for this project\'s publication (ownership)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const d = await newDraft();
    await call(submitContentHandler, { params: { publicationId: d.id } });
    const other = await call(approveContentHandler, { params: { publicationId: d.id }, body: { version: 1 }, projectId: new mongoose.Types.ObjectId().toString() });
    assert.equal(other.statusCode, 404);
    assert.equal((await SocialPublication.findById(d.id)).approvalState, 'content_review');
  });

  test('7: the publish endpoint returns 409 APPROVAL_REQUIRED for an unapproved post and never calls Meta', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const d = await newDraft();
    await call(submitContentHandler, { params: { publicationId: d.id } });
    const original = adapters.facebook.publish;
    let called = 0;
    adapters.facebook.publish = async () => { called += 1; return { success: true, externalPostId: 'x' }; };
    try {
      const res = await call(publishPublicationHandler, { params: { publicationId: d.id } });
      assert.equal(res.statusCode, 409);
      assert.equal(res.body.details.code, 'APPROVAL_REQUIRED');
      assert.equal(called, 0);

      const sched = await call(schedulePublicationHandler, { params: { publicationId: d.id }, body: { scheduledAt: new Date(Date.now() + 3600_000).toISOString() } });
      assert.equal(sched.statusCode, 409);
      assert.equal(sched.body.details.code, 'APPROVAL_REQUIRED');
    } finally {
      adapters.facebook.publish = original;
    }
  });

  test('8: summary and settings endpoints return real backend data; settings persist and drive routing', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const d = await newDraft();
    await call(submitContentHandler, { params: { publicationId: d.id } });
    const summary = await call(approvalSummaryHandler);
    assert.equal(summary.body.data.summary.contentReview, 1);
    assert.equal(summary.body.data.summary.designReview, 0);

    const defaults = await call(getApprovalSettingsHandler);
    assert.deepEqual([defaults.body.data.settings.contentApprovalRequired, defaults.body.data.settings.designApprovalRequired], [true, true]);

    const bad = await call(updateApprovalSettingsHandler, { body: { contentApprovalRequired: 'nope' } });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.body.details.code, 'INVALID_SETTINGS');

    const saved = await call(updateApprovalSettingsHandler, { body: { contentApprovalRequired: false } });
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.body.data.settings.contentApprovalRequired, false);

    const d2 = await newDraft();
    const submit2 = await call(submitContentHandler, { params: { publicationId: d2.id } });
    assert.equal(submit2.body.data.publication.approval.state, 'content_approved', 'the BACKEND setting routed the post past content review');
  });
});
