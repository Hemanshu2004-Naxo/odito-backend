import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SeoProject from '../../app_user/model/SeoProject.js';
import SocialAccount from '../model/SocialAccount.js';
import SocialPublication from '../model/SocialPublication.js';
import SocialApprovalSettings from '../model/SocialApprovalSettings.js';
import adapters from './platformAdapters/index.js';
import { updatePublicationHandler } from '../controller/socialPublishingController.js';
import {
  createPublication, submitContentForApproval, approveContent, submitDesignForApproval, approveDesign,
  schedulePublication, updatePublication, cancelPublication, executeDuePublications,
} from './socialPublishingService.js';
import '../testSupport/stubPermalinkLookup.js';
import { storedTestMediaUrl, removeStoredTestMedia } from '../testSupport/storedMedia.js';

/**
 * Editing a SCHEDULED post. The schedule described an approved version; an edit that withdraws the approval must take the
 * schedule with it in the same atomic write - the row is never "scheduled + unapproved", the scheduler cannot select it,
 * and the post can be approved and scheduled again through the normal flow.
 */

let mongoAvailable = false;
before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
  } catch { mongoAvailable = false; }
});
after(async () => { if (mongoAvailable) await mongoose.connection.close(); });

const HOUR = 3_600_000;
const future = (ms = 48 * HOUR) => new Date(Date.now() + ms).toISOString();
const mockRes = () => ({ statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; return this; } });

describe('editing a scheduled post (real MongoDB, Meta adapters counted)', () => {
  let userId, reviewerId, project, pid, fb, created, mediaUrl, metaCalls, captured, realConsole;
  const original = {};
  const track = (d) => { created.push(d); return d; };

  before(() => { for (const m of ['publish', 'remove', 'reconcile']) original[m] = adapters.facebook[m]; });

  beforeEach(async () => {
    if (!mongoAvailable) return;
    created = [];
    userId = new mongoose.Types.ObjectId();
    reviewerId = new mongoose.Types.ObjectId();
    project = track(await SeoProject.create({ user_id: userId, project_name: `SchedEdit ${Date.now()} ${Math.random().toString(36).slice(2, 8)}`, main_url: 'https://example.com', seo_scope: 'local', keywords: ['k'] }));
    pid = project._id.toString();
    fb = await SocialAccount.create({ user_id: userId, project_id: project._id, platform: 'facebook', platformAccountId: 'pge', platformAccountName: 'Page', accountType: 'page', pageId: 'pge', accessToken: 'FB-SECRET-TOKEN', status: 'active', isActive: true, scopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'] });
    mediaUrl = () => storedTestMediaUrl(pid);
    metaCalls = [];
    adapters.facebook.publish = async () => { metaCalls.push('facebook.publish'); return { success: true, externalPostId: `ext_${Math.random().toString(16).slice(2)}` }; };
    adapters.facebook.remove = async () => { metaCalls.push('facebook.remove'); return { success: false }; };
    adapters.facebook.reconcile = async () => ({ status: 'unknown', reason: 'TEST_STUB' });
    captured = [];
    realConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
    for (const k of Object.keys(realConsole)) console[k] = (...a) => { captured.push(a.map(String).join(' ')); };
  });

  afterEach(async () => {
    if (realConsole) for (const k of Object.keys(realConsole)) console[k] = realConsole[k];
    for (const m of Object.keys(original)) adapters.facebook[m] = original[m];
    if (!mongoAvailable) return;
    const ids = created.map((d) => d._id);
    await Promise.all([SocialPublication.deleteMany({ project_id: { $in: ids } }), SocialApprovalSettings.deleteMany({ project_id: { $in: ids } }), SocialAccount.deleteMany({ project_id: { $in: ids } })]);
    await SeoProject.deleteMany({ _id: { $in: ids } });
    for (const id of ids) removeStoredTestMedia(id);
  });

  /** A fully approved post with a design, SCHEDULED, via the real workflow. */
  async function scheduledPost({ upTo = 'scheduled', media = [{ url: null, type: 'image' }], content = 'Brushing for two minutes protects your smile' } = {}) {
    const m = media.map((x) => ({ ...x, url: x.url || mediaUrl('design') }));
    const r = await createPublication(pid, userId, { platform: 'facebook', socialAccountId: fb._id.toString(), content, media: m });
    assert.equal(r.success, true, JSON.stringify(r));
    const id = r.publication.id;
    await submitContentForApproval(pid, id, userId);
    // walk whatever stages the project's settings left open (an off stage is auto-approved by the workflow itself)
    if ((await row(id)).approvalState === 'content_review') assert.equal((await approveContent(pid, id, reviewerId, 1)).success, true);
    if ((await row(id)).approvalState === 'content_approved') assert.equal((await submitDesignForApproval(pid, id, userId)).success, true);
    if ((await row(id)).approvalState === 'design_review') assert.equal((await approveDesign(pid, id, reviewerId, 1)).success, true);
    assert.equal((await row(id)).approvalState, 'design_approved');
    if (upTo === 'scheduled') assert.equal((await schedulePublication(pid, id, userId, future(), 'Asia/Kolkata')).success, true);
    return id;
  }
  const row = (id) => SocialPublication.findById(id).lean();
  const edit = (id, changes, p = pid, u = userId) => updatePublication(p, id, u, changes);

  // ── caption edits ─────────────────────────────────────────────────────────
  test('1: editing the caption of a scheduled post removes the schedule in the same write: draft, scheduledAt/timezone/retry state cleared, approval withdrawn, versions moved', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const id = await scheduledPost();
    const before = await row(id);
    assert.equal(before.status, 'scheduled');
    await SocialPublication.updateOne({ _id: id }, { $set: { attempts: 2, lastError: 'earlier hiccup', lastErrorCode: 'X', nextRetryAt: new Date(Date.now() + HOUR) } });

    const r = await edit(id, { content: 'A different caption' });
    assert.equal(r.success, true);
    assert.equal(r.scheduleCleared, true);
    const after = await row(id);
    assert.equal(after.status, 'draft');
    assert.equal(after.scheduledAt ?? null, null);
    assert.equal(after.timezone ?? null, null);
    assert.equal(after.attempts, 0);
    assert.equal(after.nextRetryAt ?? null, null);
    assert.equal(after.lastError ?? null, null);
    assert.equal(after.approvalState, 'content_review');
    assert.equal(after.contentVersion, before.contentVersion + 1);
    assert.equal(after.designVersion, before.designVersion, 'the design itself did not change');
    assert.equal(after.contentApprovedVersion ?? null, null);
    assert.equal(after.designApprovedVersion ?? null, null, 'a new caption invalidates the design approval too (existing rule)');
    assert.equal(after.content, 'A different caption');
    assert.equal(r.publication.status, 'draft');
    assert.equal(r.publication.scheduledAt ?? null, null);
    assert.equal(r.publication.approval.stage, 'content_review');
    assert.equal(r.publication.approval.publishable, false);
  });

  test('2: the edited post is never "scheduled + unapproved": the scheduler cannot select it and makes no Meta call - even long past the old time', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const id = await scheduledPost();
    await edit(id, { content: 'Changed' });
    const run = await executeDuePublications({ projectId: pid, now: new Date(Date.now() + 30 * 24 * HOUR) });
    assert.equal(run.processed, 0);
    assert.deepEqual(metaCalls, []);
    assert.equal(await SocialPublication.countDocuments({ project_id: project._id, status: 'scheduled' }), 0);
    assert.equal((await row(id)).status, 'draft');
  });

  test('3: no-op edits (same caption / same media) change nothing and keep the schedule', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const id = await scheduledPost();
    const before = await row(id);
    const r = await edit(id, { content: before.content, media: before.media.map((m) => ({ url: m.url, type: m.type })) });
    assert.equal(r.success, true);
    assert.equal(r.scheduleCleared, false);
    const after = await row(id);
    assert.equal(after.status, 'scheduled');
    assert.equal(after.scheduledAt.toISOString(), before.scheduledAt.toISOString());
    assert.equal(after.contentVersion, before.contentVersion);
    assert.equal(after.approvalState, 'design_approved');
  });

  // ── design-only edits ─────────────────────────────────────────────────────
  test('4: replacing ONLY the design of a scheduled post: design approval withdrawn, content approval kept, schedule removed, designVersion +1', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const id = await scheduledPost();
    const before = await row(id);
    const replacement = mediaUrl();
    const r = await edit(id, { media: [{ url: replacement, type: 'image' }] });
    assert.equal(r.success, true);
    assert.equal(r.scheduleCleared, true);
    const after = await row(id);
    assert.equal(after.status, 'draft');
    assert.equal(after.scheduledAt ?? null, null);
    assert.equal(after.approvalState, 'design_review');
    assert.equal(after.designVersion, before.designVersion + 1);
    assert.equal(after.contentVersion, before.contentVersion, 'the caption did not change');
    assert.equal(after.contentApprovedVersion, before.contentApprovedVersion, 'content approval stays valid');
    assert.equal(after.designApprovedVersion ?? null, null);
    assert.equal(after.media[0].url, replacement);
  });

  test('5: removing the design of a scheduled post is also a design change (schedule removed)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const id = await scheduledPost();
    const r = await edit(id, { media: [] });
    assert.equal(r.scheduleCleared, true);
    assert.equal((await row(id)).approvalState, 'design_review');
    assert.equal((await row(id)).status, 'draft');
  });

  test('6: caption + design changed together: one write, both versions move, schedule removed once', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const id = await scheduledPost();
    const before = await row(id);
    const r = await edit(id, { content: 'New words', media: [{ url: mediaUrl('both'), type: 'image' }] });
    assert.equal(r.scheduleCleared, true);
    const after = await row(id);
    assert.equal([after.contentVersion, after.designVersion].join(), [before.contentVersion + 1, before.designVersion + 1].join());
    assert.equal(after.approvalState, 'content_review');
    assert.equal(after.status, 'draft');
  });

  // ── project approval settings decide whether anything is invalidated ─────
  test('7: content approval OFF, design approval ON: a caption edit auto-re-approves the content but the design still needs approval -> schedule removed (content_approved)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialApprovalSettings.create({ project_id: project._id, contentApprovalRequired: false, designApprovalRequired: true });
    const id = await scheduledPost();
    const r = await edit(id, { content: 'Edited under auto content approval' });
    assert.equal(r.scheduleCleared, true);
    const after = await row(id);
    assert.equal(after.approvalState, 'content_approved');
    assert.equal(after.status, 'draft');
    assert.equal(after.scheduledAt ?? null, null);
  });

  test('8: BOTH approvals off: an edit leaves the post fully approved, so there is nothing to invalidate - it stays scheduled on its time', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialApprovalSettings.create({ project_id: project._id, contentApprovalRequired: false, designApprovalRequired: false });
    const id = await scheduledPost();
    const before = await row(id);
    assert.equal(before.status, 'scheduled');
    const r = await edit(id, { content: 'Edited, still fully approved' });
    assert.equal(r.scheduleCleared, false);
    const after = await row(id);
    assert.equal(after.status, 'scheduled');
    assert.equal(after.scheduledAt.toISOString(), before.scheduledAt.toISOString());
    assert.equal(after.approvalState, 'design_approved');
    assert.equal(after.contentVersion, before.contentVersion + 1);
  });

  test('9: design approval OFF: a design-only edit is auto-approved and the schedule is kept', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialApprovalSettings.create({ project_id: project._id, contentApprovalRequired: true, designApprovalRequired: false });
    const id = await scheduledPost();
    const r = await edit(id, { media: [{ url: mediaUrl('auto'), type: 'image' }] });
    assert.equal(r.scheduleCleared, false);
    const after = await row(id);
    assert.equal(after.status, 'scheduled');
    assert.equal(after.approvalState, 'design_approved');
    assert.equal(after.designApprovedVersion, after.designVersion);
  });

  test('10: a post OUTSIDE the approval workflow keeps its schedule when edited (legacy behaviour untouched)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const r = await createPublication(pid, userId, { platform: 'facebook', socialAccountId: fb._id.toString(), content: 'Legacy', scheduledAt: future(), timezone: 'UTC' });
    const out = await edit(r.publication.id, { content: 'Legacy edited' });
    assert.equal(out.scheduleCleared, false);
    const after = await row(r.publication.id);
    assert.equal(after.status, 'scheduled');
    assert.equal(after.approvalState ?? null, null);
  });

  test('11: a DRAFT in the workflow is unaffected (nothing to unschedule); explicit unschedule (scheduledAt:null) still just returns a scheduled post to draft', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const draft = await scheduledPost({ upTo: 'design_approved' });
    const r = await edit(draft, { content: 'Draft edit' });
    assert.equal(r.scheduleCleared, false);
    assert.equal((await row(draft)).status, 'draft');
    const id = await scheduledPost();
    const un = await edit(id, { scheduledAt: null });
    assert.equal(un.success, true);
    assert.equal(un.scheduleCleared, false);
    assert.equal((await row(id)).status, 'draft');
    assert.equal((await row(id)).approvalState, 'design_approved', 'unscheduling is not an approval change');
  });

  test('12: editing and rescheduling in ONE request is still refused when the edit withdraws approval - nothing is written', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const id = await scheduledPost();
    const before = await row(id);
    const r = await edit(id, { content: 'Sneaky edit', scheduledAt: future(72 * HOUR), timezone: 'UTC' });
    assert.equal(r.success, false);
    assert.equal(r.error.code, 'APPROVAL_REQUIRED');
    const after = await row(id);
    assert.equal(after.content, before.content);
    assert.equal(after.status, 'scheduled');
    assert.equal(after.scheduledAt.toISOString(), before.scheduledAt.toISOString());
  });

  // ── atomicity / races ─────────────────────────────────────────────────────
  test('13: the scheduler claims the post in the window between the edit\'s read and its write -> the edit is refused NOT_EDITABLE and the publishing row is untouched', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const id = await scheduledPost();
    const realFindOne = SocialApprovalSettings.findOne;
    let fired = false;
    SocialApprovalSettings.findOne = function patched(...args) {
      const result = realFindOne.apply(this, args);
      if (fired) return result;
      fired = true;
      // what the scheduler's claim does, at exactly that moment
      return { lean: () => SocialPublication.updateOne({ _id: id }, { $set: { status: 'publishing', lockedBy: 'worker-x', publishingStartedAt: new Date() }, $inc: { attempts: 1 } }).then(() => result.lean()) };
    };
    let r;
    try { r = await edit(id, { content: 'Too late' }); } finally { SocialApprovalSettings.findOne = realFindOne; }
    assert.equal(r.success, false);
    assert.equal(r.error.code, 'NOT_EDITABLE');
    const after = await row(id);
    assert.equal(after.status, 'publishing');
    assert.notEqual(after.content, 'Too late');
    assert.equal(after.approvalState, 'design_approved');
  });

  test('14: the post is rescheduled by someone else in the window -> the edit does not apply a stale status; it re-reads and ends consistent (never scheduled + unapproved)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const id = await scheduledPost();
    const realFindOne = SocialApprovalSettings.findOne;
    let fired = false;
    SocialApprovalSettings.findOne = function patched(...args) {
      const result = realFindOne.apply(this, args);
      if (fired) return result;
      fired = true;
      return { lean: () => SocialPublication.updateOne({ _id: id }, { $set: { status: 'draft', scheduledAt: null } }).then(() => result.lean()) };
    };
    try { await edit(id, { content: 'Concurrent' }); } finally { SocialApprovalSettings.findOne = realFindOne; }
    const after = await row(id);
    assert.equal(after.content, 'Concurrent');
    assert.equal(after.approvalState, 'content_review');
    assert.equal(after.status, 'draft');
    assert.equal(after.scheduledAt ?? null, null);
  });

  test('14b: a DRAFT is scheduled by someone else between the edit read and its write -> the edit re-reads and clears that new schedule; the post is NEVER left scheduled + unapproved', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const id = await scheduledPost({ upTo: 'design_approved' }); // approved draft, not scheduled
    const realFindOne = SocialApprovalSettings.findOne;
    let fired = false;
    SocialApprovalSettings.findOne = function patched(...args) {
      const result = realFindOne.apply(this, args);
      if (fired) return result;
      fired = true;
      // another tab schedules it in exactly that window (approval and versions untouched)
      return { lean: () => SocialPublication.updateOne({ _id: id }, { $set: { status: 'scheduled', scheduledAt: new Date(Date.now() + 48 * HOUR), timezone: 'UTC' } }).then(() => result.lean()) };
    };
    let r;
    try { r = await edit(id, { content: 'Edited while another tab scheduled it' }); } finally { SocialApprovalSettings.findOne = realFindOne; }
    assert.equal(r.success, true);
    const after = await row(id);
    assert.equal(after.content, 'Edited while another tab scheduled it');
    assert.equal(after.approvalState, 'content_review');
    assert.equal(after.status, 'draft', 'the schedule that appeared in the window was cleared with the approval');
    assert.equal(after.scheduledAt ?? null, null);
    assert.equal(r.scheduleCleared, true);
    assert.equal(await SocialPublication.countDocuments({ project_id: project._id, status: 'scheduled', approvalState: { $ne: 'design_approved' } }), 0);
  });

  test('15: edit racing the real scheduler on a DUE post: exactly one wins - either it published (edit refused) or it was edited first (never published). Never both, never twice.', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    for (let i = 0; i < 8; i += 1) {
      metaCalls.length = 0;
      const id = await scheduledPost();
      await SocialPublication.updateOne({ _id: id }, { $set: { scheduledAt: new Date(Date.now() - 60_000) } });
      const [run, r] = await Promise.all([executeDuePublications({ projectId: pid }), edit(id, { content: `Racing edit ${i}` })]);
      const after = await row(id);
      assert.ok(metaCalls.length <= 1, 'at most one publish');
      if (r.success) {
        assert.equal(metaCalls.length, 0, 'the edit won, so the OLD approved text was never sent');
        assert.equal(after.status, 'draft');
        assert.equal(after.content, `Racing edit ${i}`);
        assert.equal(run.succeeded, 0);
      } else {
        assert.equal(r.error.code, 'NOT_EDITABLE');
        assert.equal(metaCalls.length, 1);
        assert.ok(['publishing', 'published'].includes(after.status));
        assert.notEqual(after.content, `Racing edit ${i}`);
      }
    }
  });

  // ── authorization ─────────────────────────────────────────────────────────
  test('16: another project cannot edit this post (safe NOT_FOUND) and nothing changes', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const id = await scheduledPost();
    const other = track(await SeoProject.create({ user_id: new mongoose.Types.ObjectId(), project_name: `SchedEdit other ${Date.now()}`, main_url: 'https://example.org', seo_scope: 'local', keywords: ['k'] }));
    const r = await edit(id, { content: 'Hijack' }, other._id.toString());
    assert.equal(r.error.code, 'NOT_FOUND');
    const after = await row(id);
    assert.equal(after.status, 'scheduled');
    assert.equal(after.content, 'Brushing for two minutes protects your smile');
  });

  test('17: the HTTP handler reads only content / media / scheduledAt / timezone: forged project, status, approval, versions and account are ignored; the response says the schedule was cleared', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const id = await scheduledPost();
    const res = mockRes();
    await updatePublicationHandler({
      projectId: pid, userId: String(userId), params: { publicationId: id },
      body: { content: 'Edited via HTTP', status: 'scheduled', approvalState: 'design_approved', contentVersion: 1, designVersion: 1, projectId: 'other', socialAccountId: 'x', platform: 'instagram', scheduledAt: undefined, externalPostId: 'forged' },
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.scheduleCleared, true);
    assert.equal(res.body.data.publication.status, 'draft');
    const after = await row(id);
    assert.equal(after.status, 'draft');
    assert.equal(after.approvalState, 'content_review');
    assert.equal(after.contentVersion, 2);
    assert.equal(after.platform, 'facebook');
    assert.equal(after.externalPostId ?? null, null);
  });

  // ── terminal states ───────────────────────────────────────────────────────
  test('18: published, publishing and cancelled posts cannot be edited into a "scheduled" or any other state', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    for (const status of ['published', 'publishing', 'cancelled', 'failed']) {
      const id = await scheduledPost();
      await SocialPublication.updateOne({ _id: id }, { $set: { status } });
      const r = await edit(id, { content: 'Nope' });
      assert.equal(r.success, false, status);
      assert.equal(r.error.code, 'NOT_EDITABLE', status);
      assert.equal((await row(id)).status, status);
    }
    assert.deepEqual(metaCalls, []);
  });

  test('19: cancelling a scheduled post still works the existing way, and an edited (now draft) post can be cancelled too', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const id = await scheduledPost();
    assert.equal((await cancelPublication(pid, id, userId)).success, true);
    assert.equal((await row(id)).status, 'cancelled');
    const id2 = await scheduledPost();
    await edit(id2, { content: 'edited' });
    assert.equal((await cancelPublication(pid, id2, userId)).success, true);
  });

  // ── the way back ──────────────────────────────────────────────────────────
  test('20: after an edit, the normal flow works again: approve content -> design -> schedule -> scheduled (new version, new time) -> the scheduler publishes THAT version once', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const id = await scheduledPost();
    await edit(id, { content: 'Final wording after the edit' });
    assert.equal((await schedulePublication(pid, id, userId, future())).error.code, 'APPROVAL_REQUIRED', 'cannot be scheduled while unapproved');

    const afterEdit = await row(id);
    assert.equal((await approveContent(pid, id, reviewerId, afterEdit.contentVersion)).success, true);
    assert.equal((await submitDesignForApproval(pid, id, userId)).success, true);
    assert.equal((await approveDesign(pid, id, reviewerId, afterEdit.designVersion)).success, true);
    const when = future(72 * HOUR);
    const s = await schedulePublication(pid, id, userId, when, 'UTC');
    assert.equal(s.success, true);
    const scheduled = await row(id);
    assert.equal(scheduled.status, 'scheduled');
    assert.equal(scheduled.scheduledAt.toISOString(), new Date(when).toISOString());
    assert.equal(scheduled.contentVersion, 2);
    assert.equal(scheduled.approvalState, 'design_approved');
    assert.deepEqual(metaCalls, []);

    await SocialPublication.updateOne({ _id: id }, { $set: { scheduledAt: new Date(Date.now() - 60_000) } });
    const run = await executeDuePublications({ projectId: pid });
    assert.equal(run.succeeded, 1);
    assert.deepEqual(metaCalls, ['facebook.publish']);
    const done = await row(id);
    assert.equal(done.status, 'published');
    assert.ok(done.externalPostId);
    assert.ok(done.publishedAt instanceof Date);
    assert.equal(done.content, 'Final wording after the edit');
  });

  // ── observability / secrets ───────────────────────────────────────────────
  test('21: the invalidation is logged with safe identifiers only', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const id = await scheduledPost();
    await edit(id, { content: 'UNIQUE-EDIT-MARKER should never be logged' });
    const logs = captured.join('\n');
    assert.ok(logs.includes('publication_schedule_invalidated'));
    assert.match(logs, new RegExp(`"publicationId":"${id}"`));
    assert.match(logs, /"previousScheduledAt":"20/);
    for (const secret of ['UNIQUE-EDIT-MARKER', 'FB-SECRET-TOKEN', 'accessToken']) assert.equal(logs.includes(secret), false, secret);
  });
});
