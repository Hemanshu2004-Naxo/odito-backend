import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SeoProject from '../../app_user/model/SeoProject.js';
import User from '../../user/model/User.js';
import SocialAccount from '../model/SocialAccount.js';
import SocialPublication from '../model/SocialPublication.js';
import SocialApprovalSettings from '../model/SocialApprovalSettings.js';
import adapters from './platformAdapters/index.js';
import {
  createPublication, updatePublication, schedulePublication, publishNow, executeDuePublications, getPublication, listPublications,
  submitContentForApproval, approveContent, requestContentChanges, submitDesignForApproval, approveDesign, requestDesignChanges,
  getApprovalSummary, getApprovalSettings, updateApprovalSettings,
} from './socialPublishingService.js';
import '../testSupport/stubPermalinkLookup.js';

/**
 * Content approval workflow — real MongoDB, no mocking library (module
 * convention). The Facebook adapter is substituted ONLY to prove whether Meta
 * was or was not called; every state/version/guard assertion runs against the
 * real conditional updates.
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

async function withAdapter(publish, fn) {
  const originalPublish = adapters.facebook.publish;
  const originalReconcile = adapters.facebook.reconcile;
  const calls = [];
  adapters.facebook.publish = async (args) => { calls.push(args); return publish(args); };
  adapters.facebook.reconcile = async () => ({ status: 'unknown', reason: 'TEST_STUB' });
  try {
    return await fn(calls);
  } finally {
    adapters.facebook.publish = originalPublish;
    adapters.facebook.reconcile = originalReconcile;
  }
}

const OK = async () => ({ success: true, externalPostId: `ext_${Date.now()}_${Math.random().toString(16).slice(2)}` });
const future = () => new Date(Date.now() + 3600_000).toISOString();

describe('content approval workflow', () => {
  let project, userId, reviewerId, account, pid, mediaUrl;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    userId = new mongoose.Types.ObjectId();
    reviewerId = new mongoose.Types.ObjectId();
    project = await SeoProject.create({
      user_id: userId, project_name: `Approval Test ${Date.now()} ${Math.random().toString(36).slice(2, 8)}`, main_url: 'https://example.com', seo_scope: 'local', keywords: ['approval'],
    });
    pid = project._id.toString();
    account = await SocialAccount.create({
      user_id: userId, project_id: project._id, platform: 'facebook', platformAccountId: 'pg_appr', platformAccountName: 'Approval Page', accountType: 'page',
      pageId: 'pg_appr', accessToken: 'real-token', status: 'active', isActive: true,
      scopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'],
    });
    const { backend } = (await import('../../../config/env.js')).getServiceUrls();
    mediaUrl = (name) => `${backend}/storage/social_media/${pid}/${name}.jpg`;
  });

  afterEach(async () => {
    if (!mongoAvailable) return;
    await SocialPublication.deleteMany({ project_id: project._id });
    await SocialAccount.deleteMany({ project_id: project._id });
    await SocialApprovalSettings.deleteMany({ project_id: project._id });
    await SeoProject.deleteOne({ _id: project._id });
  });

  async function draft(fields = {}) {
    const r = await createPublication(pid, userId, { platform: 'facebook', socialAccountId: account._id.toString(), content: 'Hello world', ...fields });
    assert.equal(r.success, true, 'seed draft');
    return r.publication;
  }
  async function inContentReview(fields) {
    const d = await draft(fields);
    const r = await submitContentForApproval(pid, d.id, userId);
    assert.equal(r.success, true, 'seed submit');
    return r.publication;
  }
  async function inContentApproved(fields) {
    const p = await inContentReview(fields);
    const r = await approveContent(pid, p.id, reviewerId, p.approval.contentVersion);
    assert.equal(r.success, true, 'seed approve content');
    return r.publication;
  }
  async function inDesignReview(fields) {
    const p = await inContentApproved(fields);
    const r = await submitDesignForApproval(pid, p.id, userId);
    assert.equal(r.success, true, 'seed submit design');
    return r.publication;
  }
  async function fullyApproved(fields) {
    const p = await inDesignReview(fields);
    const r = await approveDesign(pid, p.id, reviewerId, p.approval.designVersion);
    assert.equal(r.success, true, 'seed approve design');
    return r.publication;
  }

  // ── happy path + request-changes ────────────────────────────────────────
  test('1: a draft submitted for review enters content_review, bound to version 1', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await inContentReview();
    assert.equal(p.approval.state, 'content_review');
    assert.equal(p.approval.stage, 'content_review');
    assert.equal(p.approval.contentVersion, 1);
    assert.equal(p.approval.submittedBy, userId.toString());
    assert.ok(p.approval.submittedAt);
    assert.equal(p.approval.publishable, false);
    assert.equal(p.status, 'draft');
  });

  test('2: approving content records approver/time/version and moves to content_approved (design still required)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await inContentApproved();
    assert.equal(p.approval.state, 'content_approved');
    assert.equal(p.approval.contentApprovedBy, reviewerId.toString());
    assert.equal(p.approval.contentApprovedVersion, 1);
    assert.ok(p.approval.contentApprovedAt);
    assert.equal(p.approval.publishable, false);
  });

  test('3: request-changes keeps the SAME review state and persists actor, time, reason and version', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await inContentReview();
    const r = await requestContentChanges(pid, p.id, reviewerId, { version: 1, reason: '  Tone is too casual  ' });
    assert.equal(r.success, true);
    assert.equal(r.publication.approval.state, 'content_review');
    assert.equal(r.publication.approval.needsChanges, true);
    assert.deepEqual(
      { stage: r.publication.approval.changesRequested.stage, by: r.publication.approval.changesRequested.by, reason: r.publication.approval.changesRequested.reason, forVersion: r.publication.approval.changesRequested.forVersion },
      { stage: 'content', by: reviewerId.toString(), reason: 'Tone is too casual', forVersion: 1 },
    );
    assert.ok(r.publication.approval.changesRequested.at);
  });

  test('4: request-changes requires a reason (and a version) and bounds the reason length', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await inContentReview();
    assert.equal((await requestContentChanges(pid, p.id, reviewerId, { version: 1, reason: '   ' })).error.code, 'REASON_REQUIRED');
    assert.equal((await requestContentChanges(pid, p.id, reviewerId, { version: 1 })).error.code, 'REASON_REQUIRED');
    assert.equal((await requestContentChanges(pid, p.id, reviewerId, { reason: 'x' })).error.code, 'VERSION_REQUIRED');
    assert.equal((await requestContentChanges(pid, p.id, reviewerId, { version: 1, reason: 'x'.repeat(2001) })).error.code, 'REASON_TOO_LONG');
    assert.equal((await approveContent(pid, p.id, reviewerId, undefined)).error.code, 'VERSION_REQUIRED');
    assert.equal((await getPublication(pid, p.id)).approval.changesRequested, null, 'nothing was persisted by the rejected calls');
  });

  test('5: the full chain reaches design_approved / ready_to_schedule, and design request-changes stays in design_review', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await inDesignReview();
    assert.equal(p.approval.state, 'design_review');
    assert.equal(p.approval.designSubmittedBy, userId.toString());

    const rc = await requestDesignChanges(pid, p.id, reviewerId, { version: 1, reason: 'Logo is cropped' });
    assert.equal(rc.success, true);
    assert.equal(rc.publication.approval.state, 'design_review');
    assert.equal(rc.publication.approval.changesRequested.stage, 'design');
    assert.equal(rc.publication.approval.needsChanges, true);

    const ok = await approveDesign(pid, p.id, reviewerId, 1);
    assert.equal(ok.success, true);
    assert.equal(ok.publication.approval.state, 'design_approved');
    assert.equal(ok.publication.approval.stage, 'ready_to_schedule');
    assert.equal(ok.publication.approval.publishable, true);
    assert.equal(ok.publication.approval.designApprovedBy, reviewerId.toString());
    assert.equal(ok.publication.approval.changesRequested, null, 'approval clears the answered change request');
  });

  // ── no skipped stages / invalid transitions ─────────────────────────────
  test('6: invalid transitions are rejected server-side with INVALID_APPROVAL_STATE and change nothing', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const unmanaged = await draft();
    const review = await inContentReview();
    const approvedContent = await inContentApproved();
    const designReview = await inDesignReview();

    const cases = [
      ['approve content on a draft that never entered the workflow', () => approveContent(pid, unmanaged.id, reviewerId, 1)],
      ['request content changes on an unmanaged draft', () => requestContentChanges(pid, unmanaged.id, reviewerId, { version: 1, reason: 'x' })],
      ['submit design from an unmanaged draft', () => submitDesignForApproval(pid, unmanaged.id, userId)],
      ['approve design straight from content_review (skips content approval + design submit)', () => approveDesign(pid, review.id, reviewerId, 1)],
      ['submit design from content_review (content not approved)', () => submitDesignForApproval(pid, review.id, userId)],
      ['submit content twice', () => submitContentForApproval(pid, review.id, userId)],
      ['approve design from content_approved (design never submitted)', () => approveDesign(pid, approvedContent.id, reviewerId, 1)],
      ['approve content again after it is approved', () => approveContent(pid, approvedContent.id, reviewerId, 1)],
      ['approve content while in design_review', () => approveContent(pid, designReview.id, reviewerId, 1)],
      ['request content changes while in design_review', () => requestContentChanges(pid, designReview.id, reviewerId, { version: 1, reason: 'x' })],
      ['submit content for a post already in design_review', () => submitContentForApproval(pid, designReview.id, userId)],
    ];
    for (const [label, run] of cases) {
      const r = await run();
      assert.equal(r.success, false, label);
      assert.equal(r.error.code, 'INVALID_APPROVAL_STATE', label);
    }
    assert.equal((await getPublication(pid, unmanaged.id)).approval.state, null);
    assert.equal((await getPublication(pid, review.id)).approval.state, 'content_review');
    assert.equal((await getPublication(pid, approvedContent.id)).approval.state, 'content_approved');
    assert.equal((await getPublication(pid, designReview.id)).approval.state, 'design_review');
  });

  test('7: approval cannot change once a post is published/failed/cancelled, and unknown ids are NOT_FOUND', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await inContentReview();
    await SocialPublication.updateOne({ _id: p.id }, { $set: { status: 'published' } });
    assert.equal((await approveContent(pid, p.id, reviewerId, 1)).error.code, 'INVALID_APPROVAL_STATE');
    assert.equal((await approveContent(pid, new mongoose.Types.ObjectId().toString(), reviewerId, 1)).error.code, 'NOT_FOUND');
    assert.equal((await approveContent(pid, 'not-an-id', reviewerId, 1)).error.code, 'NOT_FOUND');
  });

  // ── project ownership ───────────────────────────────────────────────────
  test('8: another project cannot read or act on this project\'s publication (reported as not found)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await inContentReview();
    const otherProject = new mongoose.Types.ObjectId().toString();
    for (const run of [
      () => approveContent(otherProject, p.id, reviewerId, 1),
      () => requestContentChanges(otherProject, p.id, reviewerId, { version: 1, reason: 'x' }),
      () => submitContentForApproval(otherProject, p.id, reviewerId),
      () => submitDesignForApproval(otherProject, p.id, reviewerId),
      () => approveDesign(otherProject, p.id, reviewerId, 1),
      () => requestDesignChanges(otherProject, p.id, reviewerId, { version: 1, reason: 'x' }),
    ]) {
      assert.equal((await run()).error.code, 'NOT_FOUND');
    }
    assert.equal((await getPublication(pid, p.id)).approval.state, 'content_review', 'untouched');
  });

  // ── settings drive stage routing (backend) ──────────────────────────────
  test('9: settings default to both stages required, and reading them creates nothing', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const s = await getApprovalSettings(pid);
    assert.equal(s.contentApprovalRequired, true);
    assert.equal(s.designApprovalRequired, true);
    assert.equal(await SocialApprovalSettings.countDocuments({ project_id: project._id }), 0);
  });

  test('10: content approval not required -> submit auto-approves content (approvedBy null) and waits for design', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    assert.equal((await updateApprovalSettings(pid, userId, { contentApprovalRequired: false })).success, true);
    const p = await inContentReview();
    assert.equal(p.approval.state, 'content_approved');
    assert.equal(p.approval.contentApprovedBy, null);
    assert.equal(p.approval.contentApprovedVersion, 1);
  });

  test('11: design approval not required -> approving content lands in design_approved', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await updateApprovalSettings(pid, userId, { designApprovalRequired: false });
    const p = await inContentApproved();
    assert.equal(p.approval.state, 'design_approved');
    assert.equal(p.approval.contentApprovedBy, reviewerId.toString());
    assert.equal(p.approval.designApprovedBy, null);
    assert.equal(p.approval.publishable, true);
  });

  test('12: neither stage required -> submit goes straight to design_approved', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await updateApprovalSettings(pid, userId, { contentApprovalRequired: false, designApprovalRequired: false });
    const p = await inContentReview();
    assert.equal(p.approval.state, 'design_approved');
    assert.equal(p.approval.stage, 'ready_to_schedule');
  });

  test('13: settings validation rejects non-boolean / empty input', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    assert.equal((await updateApprovalSettings(pid, userId, { contentApprovalRequired: 'yes' })).error.code, 'INVALID_SETTINGS');
    assert.equal((await updateApprovalSettings(pid, userId, {})).error.code, 'INVALID_SETTINGS');
    const r = await updateApprovalSettings(pid, userId, { designApprovalRequired: false });
    assert.deepEqual([r.settings.contentApprovalRequired, r.settings.designApprovalRequired], [true, false]);
  });

  // ── version safety ──────────────────────────────────────────────────────
  test('14: approving a stale version is refused with VERSION_MISMATCH', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await inContentReview();
    const edited = await updatePublication(pid, p.id, userId, { content: 'Reworded caption' });
    assert.equal(edited.publication.approval.contentVersion, 2);
    assert.equal(edited.publication.approval.state, 'content_review');
    const stale = await approveContent(pid, p.id, reviewerId, 1);
    assert.equal(stale.success, false);
    assert.equal(stale.error.code, 'VERSION_MISMATCH');
    assert.equal((await requestContentChanges(pid, p.id, reviewerId, { version: 1, reason: 'x' })).error.code, 'VERSION_MISMATCH');
    assert.equal((await approveContent(pid, p.id, reviewerId, 2)).success, true);
  });

  test('15: editing the content in review answers an earlier change request (needsChanges clears)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await inContentReview();
    await requestContentChanges(pid, p.id, reviewerId, { version: 1, reason: 'Fix the CTA' });
    const edited = await updatePublication(pid, p.id, userId, { content: 'New CTA included' });
    assert.equal(edited.publication.approval.needsChanges, false);
    assert.equal(edited.publication.approval.contentVersion, 2);
    assert.equal(edited.publication.approval.changesRequested.forVersion, 1, 'history of the request is kept');
  });

  test('16: editing APPROVED content invalidates the approval and sends the post back to content_review', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await fullyApproved();
    const edited = await updatePublication(pid, p.id, userId, { content: 'Sneaky change after approval' });
    assert.equal(edited.success, true);
    assert.equal(edited.publication.approval.state, 'content_review');
    assert.equal(edited.publication.approval.publishable, false);
    assert.equal(edited.publication.approval.contentApprovedAt, null);
    assert.equal(edited.publication.approval.contentApprovedBy, null);
    assert.equal(edited.publication.approval.designApprovedAt, null, 'design approval is invalidated too — it was approved against the old content');
    assert.equal(edited.publication.approval.contentVersion, 2);
  });

  test('17: editing the design (media) of a design_approved post invalidates ONLY the design approval', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await fullyApproved({ media: [{ url: mediaUrl('a'), type: 'image' }] });
    const edited = await updatePublication(pid, p.id, userId, { media: [{ url: mediaUrl('b'), type: 'image' }] });
    assert.equal(edited.publication.approval.state, 'design_review');
    assert.equal(edited.publication.approval.designVersion, 2);
    assert.equal(edited.publication.approval.contentVersion, 1);
    assert.equal(edited.publication.approval.contentApprovedBy, reviewerId.toString(), 'content approval survives a design-only change');
    assert.equal(edited.publication.approval.publishable, false);
    // and the stale design version can no longer be approved
    assert.equal((await approveDesign(pid, p.id, reviewerId, 1)).error.code, 'VERSION_MISMATCH');
    assert.equal((await approveDesign(pid, p.id, reviewerId, 2)).success, true);
  });

  test('18: an edit that changes nothing does not bump versions or invalidate approval', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await fullyApproved({ media: [{ url: mediaUrl('a'), type: 'image' }] });
    const same = await updatePublication(pid, p.id, userId, { content: p.content, media: [{ url: mediaUrl('a'), type: 'image' }] });
    assert.equal(same.publication.approval.state, 'design_approved');
    assert.equal(same.publication.approval.contentVersion, 1);
    assert.equal(same.publication.approval.designVersion, 1);
  });

  test('19: with a stage not required, an edit re-approves that stage automatically (no stuck state)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    // design not required, content required: edit sends content back to review
    await updateApprovalSettings(pid, userId, { designApprovalRequired: false });
    const p = await inContentApproved();
    assert.equal(p.approval.state, 'design_approved');
    const edited = await updatePublication(pid, p.id, userId, { content: 'edited' });
    assert.equal(edited.publication.approval.state, 'content_review', 'content approval IS required, so it is re-requested');
    // neither required: an edit is auto re-approved straight back to design_approved (new versions recorded)
    await updateApprovalSettings(pid, userId, { contentApprovalRequired: false });
    const q = await inContentReview({ content: 'second post' });
    assert.equal(q.approval.state, 'design_approved');
    const again = await updatePublication(pid, q.id, userId, { content: 'edited again' });
    assert.equal(again.publication.approval.state, 'design_approved');
    assert.equal(again.publication.approval.contentVersion, 2);
    assert.equal(again.publication.approval.contentApprovedVersion, 2, 'auto-approval is bound to the NEW version');
    assert.equal(again.publication.approval.contentApprovedBy, null);
  });

  test('20: editing an unmanaged (legacy) post is unchanged: no approval state appears', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const d = await draft();
    const edited = await updatePublication(pid, d.id, userId, { content: 'plain edit' });
    assert.equal(edited.publication.approval.managed, false);
    assert.equal(edited.publication.approval.state, null);
    assert.equal(edited.publication.approval.publishable, true);
  });

  // ── publishing protection ───────────────────────────────────────────────
  test('21: publishNow on a post in review returns APPROVAL_REQUIRED and NEVER calls Meta', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const inReview = await inContentReview();
    const contentOk = await inContentApproved();
    const designReview = await inDesignReview();
    await withAdapter(OK, async (calls) => {
      for (const p of [inReview, contentOk, designReview]) {
        const r = await publishNow(pid, p.id, userId);
        assert.equal(r.success, false);
        assert.equal(r.error.code, 'APPROVAL_REQUIRED');
        assert.equal((await getPublication(pid, p.id)).status, 'draft', 'row not claimed / not moved');
      }
      assert.equal(calls.length, 0, 'the Meta adapter was never called');
    });
  });

  test('22: a fully approved post publishes; an unmanaged post still publishes exactly as before', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const approved = await fullyApproved();
    const legacy = await draft();
    await withAdapter(OK, async (calls) => {
      assert.equal((await publishNow(pid, approved.id, userId)).success, true);
      assert.equal((await publishNow(pid, legacy.id, userId)).success, true);
      assert.equal(calls.length, 2);
    });
    assert.equal((await getPublication(pid, approved.id)).status, 'published');
  });

  test('23: the atomic claim itself enforces approval (approval invalidated after the pre-check cannot publish)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await fullyApproved();
    // Simulate the race: approval is revoked between the caller's read and the claim.
    const realFindOne = SocialPublication.findOne;
    let first = true;
    SocialPublication.findOne = function patched(...args) {
      const q = realFindOne.apply(this, args);
      if (first) {
        first = false; // the publishNow pre-check read: let it see "approved", then revoke
        const origLean = q.lean.bind(q);
        q.lean = async () => {
          const doc = await origLean();
          await SocialPublication.updateOne({ _id: p.id }, { $set: { approvalState: 'content_review' } });
          return doc;
        };
      }
      return q;
    };
    try {
      await withAdapter(OK, async (calls) => {
        const r = await publishNow(pid, p.id, userId);
        assert.equal(r.success, false);
        assert.equal(r.error.code, 'APPROVAL_REQUIRED');
        assert.equal(calls.length, 0);
      });
    } finally {
      SocialPublication.findOne = realFindOne;
    }
  });

  // ── scheduling integration ──────────────────────────────────────────────
  test('24: a post in review cannot be scheduled (schedule + PATCH scheduledAt); an approved one can', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const inReview = await inContentReview();
    const s1 = await schedulePublication(pid, inReview.id, userId, future());
    assert.equal(s1.success, false);
    assert.equal(s1.error.code, 'APPROVAL_REQUIRED');
    const s2 = await updatePublication(pid, inReview.id, userId, { scheduledAt: future() });
    assert.equal(s2.error.code, 'APPROVAL_REQUIRED');
    assert.equal((await getPublication(pid, inReview.id)).status, 'draft');

    const approved = await fullyApproved();
    const s3 = await schedulePublication(pid, approved.id, userId, future());
    assert.equal(s3.success, true);
    assert.equal(s3.publication.status, 'scheduled');
    assert.equal(s3.publication.approval.stage, 'scheduled');
  });

  test('25: one request that edits approved content AND schedules it is refused (it would end unapproved)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const approved = await fullyApproved();
    const r = await updatePublication(pid, approved.id, userId, { content: 'changed', scheduledAt: future() });
    assert.equal(r.success, false);
    assert.equal(r.error.code, 'APPROVAL_REQUIRED');
    const after = await getPublication(pid, approved.id);
    assert.equal(after.content, approved.content, 'nothing was written');
    assert.equal(after.approval.state, 'design_approved');
  });

  test('26: un-scheduling a managed post stays allowed regardless of approval state', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const approved = await fullyApproved();
    await schedulePublication(pid, approved.id, userId, future());
    await updatePublication(pid, approved.id, userId, { content: 'late edit' }); // -> content_review, and the schedule is removed with the approval
    const unscheduled = await updatePublication(pid, approved.id, userId, { scheduledAt: null });
    assert.equal(unscheduled.success, true);
    assert.equal(unscheduled.publication.status, 'draft');
  });

  test('27: SAFETY NET: a scheduled row whose approval is invalid (e.g. created before edits cleared schedules) is never published; the scheduler fails it APPROVAL_REQUIRED, not retryable until re-approved', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const approved = await fullyApproved();
    await schedulePublication(pid, approved.id, userId, future());
    const edited = await updatePublication(pid, approved.id, userId, { content: 'edited after scheduling' });
    // An edit now removes the schedule together with the approval (see socialScheduling.test.js)...
    assert.equal(edited.publication.status, 'draft');
    assert.equal(edited.publication.approval.state, 'content_review');
    // ...so the invalid row this safety net guards against has to be built directly (the shape older edits could leave behind).
    await SocialPublication.updateOne({ _id: approved.id }, { $set: { status: 'scheduled', scheduledAt: new Date(Date.now() - 60_000) } });

    await withAdapter(OK, async (calls) => {
      const run = await executeDuePublications({ projectId: pid });
      assert.equal(run.processed, 1);
      assert.equal(run.succeeded, 0);
      assert.equal(run.results[0].errorCode, 'APPROVAL_REQUIRED');
      assert.equal(calls.length, 0, 'Meta was not called');
    });

    const blocked = await getPublication(pid, approved.id);
    assert.equal(blocked.status, 'failed');
    assert.equal(blocked.failureCode, 'APPROVAL_REQUIRED');
    assert.equal(blocked.canRetry, false, 'cannot retry while still unapproved');
    assert.equal(blocked.attempts, 0, 'no publish attempt was counted');

    // Re-approve (content then design) -> retry becomes legitimate, and publishes.
    await SocialPublication.updateOne({ _id: approved.id }, { $set: { status: 'draft' } }); // review actions apply to pre-publication posts
    const c = await approveContent(pid, approved.id, reviewerId, blocked.approval.contentVersion);
    assert.equal(c.success, true);
    const sd = await submitDesignForApproval(pid, approved.id, userId);
    assert.equal(sd.success, true);
    assert.equal((await approveDesign(pid, approved.id, reviewerId, sd.publication.approval.designVersion)).success, true);
    await SocialPublication.updateOne({ _id: approved.id }, { $set: { status: 'failed' } });
    assert.equal((await getPublication(pid, approved.id)).canRetry, true);
    await withAdapter(OK, async (calls) => {
      assert.equal((await publishNow(pid, approved.id, userId)).success, true);
      assert.equal(calls.length, 1);
    });
  });

  test('28: scheduler still publishes an approved scheduled post and an unmanaged scheduled post', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const approved = await fullyApproved();
    await schedulePublication(pid, approved.id, userId, future());
    const legacy = await draft({ scheduledAt: future() });
    await SocialPublication.updateMany({ _id: { $in: [approved.id, legacy.id] } }, { $set: { scheduledAt: new Date(Date.now() - 60_000) } });
    await withAdapter(OK, async (calls) => {
      const run = await executeDuePublications({ projectId: pid });
      assert.equal(run.succeeded, 2);
      assert.equal(calls.length, 2);
    });
  });

  // ── concurrency ─────────────────────────────────────────────────────────
  test('29: two simultaneous content approvals — exactly one wins, the other is told why', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await inContentReview();
    const results = await Promise.all([
      approveContent(pid, p.id, reviewerId, 1),
      approveContent(pid, p.id, new mongoose.Types.ObjectId(), 1),
    ]);
    assert.equal(results.filter((r) => r.success).length, 1);
    const loser = results.find((r) => !r.success);
    assert.ok(['INVALID_APPROVAL_STATE', 'APPROVAL_CONFLICT'].includes(loser.error.code), loser.error.code);
    assert.equal((await getPublication(pid, p.id)).approval.state, 'content_approved');
  });

  test('30: approve vs request-changes racing — never both applied', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    for (let i = 0; i < 8; i += 1) {
      const p = await inContentReview();
      const [a, c] = await Promise.all([
        approveContent(pid, p.id, reviewerId, 1),
        requestContentChanges(pid, p.id, reviewerId, { version: 1, reason: 'race' }),
      ]);
      const final = await getPublication(pid, p.id);
      if (a.success) {
        assert.equal(final.approval.state, 'content_approved');
        // a change request that landed first is cleared by the approval; one that lost is rejected
        assert.equal(final.approval.changesRequested, null);
      } else {
        assert.equal(c.success, true);
        assert.equal(final.approval.state, 'content_review');
        assert.equal(final.approval.needsChanges, true);
      }
    }
  });

  test('31: an edit racing an approval cannot approve content that was just changed', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    for (let i = 0; i < 8; i += 1) {
      const p = await inContentReview();
      const [a, e] = await Promise.all([
        approveContent(pid, p.id, reviewerId, 1),
        updatePublication(pid, p.id, userId, { content: `edited ${i}` }),
      ]);
      assert.equal(e.success, true);
      const final = await getPublication(pid, p.id);
      assert.equal(final.approval.contentVersion, 2);
      // Either the approval landed on v1 and the edit then invalidated it, or the edit won and v1 was refused:
      // in BOTH cases the post must not be left approved for the old content.
      assert.equal(final.approval.state, 'content_review', `iteration ${i}: approve=${a.success ? 'won' : a.error.code}`);
      assert.equal(final.approval.publishable, false);
    }
  });

  // ── read model ──────────────────────────────────────────────────────────
  test('32: summary counts come from the database and only count pre-publication posts of this project', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await inContentReview();
    const second = await inContentReview();
    await requestContentChanges(pid, second.id, reviewerId, { version: 1, reason: 'again' });
    await inContentApproved();
    await inDesignReview();
    await fullyApproved();
    const published = await inContentReview();
    await SocialPublication.updateOne({ _id: published.id }, { $set: { status: 'published' } });

    const s = await getApprovalSummary(pid);
    assert.deepEqual(s, { contentReview: 2, designReview: 1, awaitingDesignSubmission: 1, readyToSchedule: 1, needsChanges: 1 });
    assert.deepEqual(await getApprovalSummary(new mongoose.Types.ObjectId().toString()), { contentReview: 0, designReview: 0, awaitingDesignSubmission: 0, readyToSchedule: 0, needsChanges: 0 });
  });

  test('33: list filters by approval state / managed, and attaches actor names', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const reviewer = await User.create({ firstName: 'Riya', lastName: 'Shah', email: `riya.${Date.now()}@example.com`, password: 'Password123!' }).catch(() => null);
    const actorId = reviewer ? reviewer._id : reviewerId;
    try {
      await draft();
      const a = await inContentReview();
      const b = await inContentReview();
      await approveContent(pid, b.id, actorId, 1);

      assert.equal((await listPublications(pid, { approval: 'managed' })).data.length, 2);
      assert.equal((await listPublications(pid, { approval: 'unmanaged' })).data.length, 1);
      const inReview = await listPublications(pid, { approval: 'content_review' });
      assert.deepEqual(inReview.data.map((p) => p.id), [a.id]);
      const approvedList = await listPublications(pid, { approval: 'content_approved' });
      assert.equal(approvedList.data.length, 1);
      if (reviewer) assert.equal(approvedList.data[0].approval.contentApprovedByName, 'Riya Shah');
      assert.equal(approvedList.data[0].approval.submittedByName, null, 'unknown actor -> null name, never a made-up one');
    } finally {
      if (reviewer) await User.deleteOne({ _id: reviewer._id });
    }
  });
});
