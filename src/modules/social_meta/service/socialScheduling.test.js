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
import router from '../routes/socialPublishingRoutes.js';
import { validateProjectAccess } from '../../../middleware/auth.middleware.js';
import auth from '../../user/middleware/auth.js';
import { schedulePublicationHandler, cancelPublicationHandler } from '../controller/socialPublishingController.js';
import {
  createPublication, submitContentForApproval, approveContent, submitDesignForApproval, approveDesign, requestContentChanges,
  schedulePublication, updatePublication, cancelPublication, executeDuePublications,
} from './socialPublishingService.js';
import '../testSupport/stubPermalinkLookup.js';
import { storedTestMediaUrl, removeStoredTestMedia } from '../testSupport/storedMedia.js';

/**
 * Scheduling a design-approved post - the EXISTING schedulePublication + the EXISTING scheduler, real MongoDB,
 * Meta adapters replaced by counters (so any Meta call is visible). Scheduling must never call Meta; execution
 * is the scheduler's job and must stay claim-safe.
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
const mockRes = () => ({
  statusCode: 200, body: null,
  status(code) { this.statusCode = code; return this; },
  json(payload) { this.body = payload; return this; },
});

describe('scheduling design-approved posts (real MongoDB, Meta adapters counted)', () => {
  let userId, reviewerId, project, pid, fb, ig, created, mediaUrl, metaCalls, publishImpl, captured, realConsole;
  const original = {};
  const track = (d) => { created.push(d); return d; };

  before(() => { for (const p of ['facebook', 'instagram']) for (const m of ['publish', 'remove', 'reconcile']) original[`${p}.${m}`] = adapters[p][m]; });

  beforeEach(async () => {
    if (!mongoAvailable) return;
    created = [];
    userId = new mongoose.Types.ObjectId();
    reviewerId = new mongoose.Types.ObjectId();
    project = track(await SeoProject.create({ user_id: userId, project_name: `Sched ${Date.now()} ${Math.random().toString(36).slice(2, 8)}`, main_url: 'https://example.com', seo_scope: 'local', keywords: ['k'] }));
    pid = project._id.toString();
    const scopes = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'];
    fb = await SocialAccount.create({ user_id: userId, project_id: project._id, platform: 'facebook', platformAccountId: 'pgs', platformAccountName: 'Page', accountType: 'page', pageId: 'pgs', accessToken: 'FB-SECRET-TOKEN', status: 'active', isActive: true, scopes });
    ig = await SocialAccount.create({ user_id: userId, project_id: project._id, platform: 'instagram', platformAccountId: 'igs', platformAccountName: 'IG', accountType: 'business', pageId: 'pgs', accessToken: 'IG-SECRET-TOKEN', status: 'active', scopes });
    mediaUrl = () => storedTestMediaUrl(pid);
    metaCalls = [];
    publishImpl = async () => ({ success: true, externalPostId: `ext_${Math.random().toString(16).slice(2)}` });
    for (const p of ['facebook', 'instagram']) {
      adapters[p].publish = async (args) => { metaCalls.push(`${p}.publish`); return publishImpl(args); };
      adapters[p].remove = async () => { metaCalls.push(`${p}.remove`); return { success: false }; };
      adapters[p].reconcile = async () => { metaCalls.push(`${p}.reconcile`); return { status: 'unknown', reason: 'TEST_STUB' }; };
    }
    captured = [];
    realConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
    for (const k of Object.keys(realConsole)) console[k] = (...a) => { captured.push(a.map(String).join(' ')); };
  });

  afterEach(async () => {
    if (realConsole) for (const k of Object.keys(realConsole)) console[k] = realConsole[k];
    for (const key of Object.keys(original)) { const [p, m] = key.split('.'); adapters[p][m] = original[key]; }
    if (!mongoAvailable) return;
    const ids = created.map((d) => d._id);
    await Promise.all([SocialPublication.deleteMany({ project_id: { $in: ids } }), SocialApprovalSettings.deleteMany({ project_id: { $in: ids } }), SocialAccount.deleteMany({ project_id: { $in: ids } })]);
    await SeoProject.deleteMany({ _id: { $in: ids } });
    for (const id of ids) removeStoredTestMedia(id);
  });

  /** A post taken through the REAL workflow to `upTo`. */
  async function post({ platform = 'facebook', upTo = 'design_approved', media = [], content = 'Brushing for two minutes protects your smile' } = {}) {
    const account = platform === 'facebook' ? fb : ig;
    const r = await createPublication(pid, userId, { platform, socialAccountId: account._id.toString(), content, media });
    assert.equal(r.success, true, JSON.stringify(r));
    let pub = r.publication;
    const steps = ['draft', 'content_review', 'content_approved', 'design_review', 'design_approved'];
    const target = steps.indexOf(upTo);
    if (target >= 1) assert.equal((await submitContentForApproval(pid, pub.id, userId)).success, true);
    if (target >= 2) assert.equal((await approveContent(pid, pub.id, reviewerId, 1)).success, true);
    if (target >= 3) assert.equal((await submitDesignForApproval(pid, pub.id, userId)).success, true);
    if (target >= 4) assert.equal((await approveDesign(pid, pub.id, reviewerId, 1)).success, true);
    pub = (await SocialPublication.findById(pub.id).lean());
    return { id: String(pub._id), row: pub };
  }
  const row = (id) => SocialPublication.findById(id).lean();
  const sched = (id, at = future(), tz = 'Asia/Kolkata', p = pid, u = userId) => schedulePublication(p, id, u, at, tz);

  // ── AUTHORIZATION ─────────────────────────────────────────────────────────
  test('1: the schedule route sits behind auth + project access, and only the controller handles it', () => {
    const layer = router.stack.find((l) => l.route?.path === '/:publicationId/schedule' && l.route.methods.post);
    assert.ok(layer);
    assert.deepEqual(layer.route.stack.map((s) => s.handle), [auth, layer.route.stack[1].handle, schedulePublicationHandler]);
    assert.equal(layer.route.stack[1].handle.name, validateProjectAccess().name);
    const cancel = router.stack.find((l) => l.route?.path === '/:publicationId/cancel');
    assert.equal(cancel.route.stack.at(-1).handle, cancelPublicationHandler);
    assert.equal(router.stack.filter((l) => l.route && /schedule/.test(l.route.path)).length, 1, 'ONE schedule endpoint - no second scheduling route');
  });

  test('2: an authorised project schedules its design-approved post: status scheduled, UTC instant stored, approval untouched', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await post();
    assert.equal(p.row.approvalState, 'design_approved');
    const at = future();
    const r = await sched(p.id, at);
    assert.equal(r.success, true, JSON.stringify(r));
    const after = await row(p.id);
    assert.equal(after.status, 'scheduled');
    assert.equal(after.scheduledAt.toISOString(), new Date(at).toISOString());
    assert.equal(after.timezone, 'Asia/Kolkata');
    assert.equal(after.approvalState, 'design_approved');
    assert.equal(after.contentVersion, p.row.contentVersion);
    assert.equal(after.designVersion, p.row.designVersion);
    assert.equal(r.publication.status, 'scheduled');
    assert.equal(r.publication.approval.stage, 'scheduled');
  });

  test('3: another project\'s publication is the same safe NOT_FOUND as an unknown one; it is never modified', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await post();
    const other = track(await SeoProject.create({ user_id: new mongoose.Types.ObjectId(), project_name: `Sched other ${Date.now()}`, main_url: 'https://example.org', seo_scope: 'local', keywords: ['k'] }));
    const foreign = await sched(p.id, future(), 'UTC', other._id.toString());
    const unknown = await sched(new mongoose.Types.ObjectId().toString(), future(), 'UTC');
    assert.equal(foreign.error.code, 'NOT_FOUND');
    assert.deepEqual(foreign.error, unknown.error);
    assert.equal((await row(p.id)).status, 'draft');
    assert.equal((await sched('not-an-id')).error.code, 'NOT_FOUND');
  });

  test('4: validateProjectAccess() blocks a stranger on the schedule route before any handler runs', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const mw = validateProjectAccess();
    const res = mockRes();
    let nextCalled = false;
    await mw({ user: { id: String(new mongoose.Types.ObjectId()) }, query: {}, params: { publicationId: 'x' }, body: { projectId: pid, scheduledAt: future() }, path: '/x/schedule', method: 'POST' }, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.ok([403, 404].includes(res.statusCode));
  });

  // ── APPROVAL GATE ─────────────────────────────────────────────────────────
  for (const [state, code] of [['draft', null], ['content_review', 'APPROVAL_REQUIRED'], ['content_approved', 'APPROVAL_REQUIRED'], ['design_review', 'APPROVAL_REQUIRED']]) {
    test(`5: a post in ${state} cannot be scheduled when approvals are required${state === 'draft' ? ' unless it is outside the workflow' : ''}`, async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const p = await post({ upTo: state });
      const r = await sched(p.id);
      if (state === 'draft') {
        assert.equal(r.success, true, 'a post NOT in the approval workflow keeps its existing behaviour (legacy/direct posts)');
        return;
      }
      assert.equal(r.success, false);
      assert.equal(r.error.code, code);
      const after = await row(p.id);
      assert.equal(after.status, 'draft');
      assert.equal(after.scheduledAt ?? null, null);
      assert.equal(after.approvalState, state);
    });
  }

  test('6: the approval gate follows the project settings: with design approval off, approved content is schedulable once it has media', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialApprovalSettings.create({ project_id: project._id, contentApprovalRequired: true, designApprovalRequired: false });
    const p = await post({ upTo: 'content_approved' });
    assert.equal((await row(p.id)).approvalState, 'design_approved');
    assert.equal((await sched(p.id)).success, true);
  });

  test('7: approval cannot be bypassed through the PATCH route either (scheduledAt in an edit)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await post({ upTo: 'design_review' });
    const r = await updatePublication(pid, p.id, userId, { scheduledAt: future(), timezone: 'UTC' });
    assert.equal(r.success, false);
    assert.equal(r.error.code, 'APPROVAL_REQUIRED');
    assert.equal((await row(p.id)).status, 'draft');
    const ok = await post();
    assert.equal((await updatePublication(pid, ok.id, userId, { scheduledAt: future(), timezone: 'UTC' })).success, true);
    assert.equal((await row(ok.id)).status, 'scheduled');
  });

  test('8: a rejected-then-corrected post: "request changes" keeps it unschedulable until re-approved', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await post({ upTo: 'content_review' });
    await requestContentChanges(pid, p.id, reviewerId, { version: 1, reason: 'Rewrite the opening' });
    assert.equal((await sched(p.id)).error.code, 'APPROVAL_REQUIRED');
  });

  // ── MEDIA ─────────────────────────────────────────────────────────────────
  test('9: Instagram without media is refused MEDIA_REQUIRED even when fully approved (design approval off) - nothing is scheduled', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialApprovalSettings.create({ project_id: project._id, contentApprovalRequired: true, designApprovalRequired: false });
    const p = await post({ platform: 'instagram', upTo: 'content_approved' });
    assert.equal((await row(p.id)).approvalState, 'design_approved');
    const r = await sched(p.id);
    assert.equal(r.success, false);
    assert.equal(r.error.code, 'MEDIA_REQUIRED');
    assert.match(r.error.message, /Instagram posts need an image or video/);
    const after = await row(p.id);
    assert.equal(after.status, 'draft');
    assert.equal(after.scheduledAt ?? null, null);
  });

  test('10: Instagram with an approved design (media) schedules', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await post({ platform: 'instagram', media: [{ url: mediaUrl('a'), type: 'image' }] });
    assert.equal((await sched(p.id)).success, true);
    assert.equal((await row(p.id)).status, 'scheduled');
  });

  test('11: Facebook follows its adapter: text-only is fine, one image is fine, more than one is refused', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    assert.equal((await sched((await post()).id)).success, true);
    assert.equal((await sched((await post({ media: [{ url: mediaUrl('b'), type: 'image' }] })).id)).success, true);
    const two = await post({ media: [{ url: mediaUrl('c'), type: 'image' }, { url: mediaUrl('d'), type: 'image' }] });
    assert.equal((await sched(two.id)).error.code, 'MEDIA_NOT_SUPPORTED');
  });

  test('12: the media rule also applies to scheduling through an edit (PATCH), judged on the media AFTER the edit', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialApprovalSettings.create({ project_id: project._id, contentApprovalRequired: false, designApprovalRequired: false });
    const p = await post({ platform: 'instagram', upTo: 'content_review' });
    assert.equal((await updatePublication(pid, p.id, userId, { scheduledAt: future(), timezone: 'UTC' })).error.code, 'MEDIA_REQUIRED');
    const r = await updatePublication(pid, p.id, userId, { media: [{ url: mediaUrl('e'), type: 'image' }], scheduledAt: future(), timezone: 'UTC' });
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal((await row(p.id)).status, 'scheduled');
  });

  // ── ACCOUNT HEALTH ────────────────────────────────────────────────────────
  test('13: an expired or disconnected account is refused (reconnect required / not connected); no Meta call is made to find out', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await post();
    await SocialAccount.updateOne({ _id: fb._id }, { $set: { status: 'expired' } });
    const expired = await sched(p.id);
    assert.equal(expired.error.code, 'ACCOUNT_RECONNECT_REQUIRED');
    assert.equal(expired.error.requiresReconnect, true);
    await SocialAccount.updateOne({ _id: fb._id }, { $set: { status: 'disconnected' } });
    assert.equal((await sched(p.id)).error.code, 'ACCOUNT_NOT_CONNECTED');
    assert.equal((await row(p.id)).status, 'draft');
    assert.deepEqual(metaCalls, []);
  });

  // ── DATE / TIME ───────────────────────────────────────────────────────────
  test('14: future accepted; past, now, naive (no offset), garbage, non-strings and impossible dates are rejected', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await post();
    const bad = [
      [new Date(Date.now() - 1000).toISOString(), 'SCHEDULE_IN_PAST'], [new Date(Date.now() - 30 * 24 * HOUR).toISOString(), 'SCHEDULE_IN_PAST'],
      ['2031-01-01T10:00:00', 'INVALID_SCHEDULE'], ['2031-01-01', 'INVALID_SCHEDULE'], ['tomorrow', 'INVALID_SCHEDULE'], ['', 'INVALID_SCHEDULE'],
      [null, 'INVALID_SCHEDULE'], [undefined, 'INVALID_SCHEDULE'], [1_900_000_000_000, 'INVALID_SCHEDULE'], [{}, 'INVALID_SCHEDULE'], [['2031-01-01T10:00:00Z'], 'INVALID_SCHEDULE'],
      ['2031-02-30T10:00:00Z', 'INVALID_SCHEDULE'], ['2031-13-01T10:00:00Z', 'INVALID_SCHEDULE'],
    ];
    for (const [at, code] of bad) {
      const r = await schedulePublication(pid, p.id, userId, at, 'UTC');
      assert.equal(r.success, false, String(at));
      assert.equal(r.error.code, code, String(at));
    }
    assert.equal((await row(p.id)).status, 'draft');
    assert.equal((await sched(p.id, future(2 * HOUR), 'UTC')).success, true);
  });

  test('15: timezone must be a real IANA zone when given; it is informational and never changes the stored instant', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await post();
    for (const tz of ['Mars/Olympus', 'GMT+5', 'x'.repeat(200), 5, {}, 'India']) assert.equal((await sched(p.id, future(), tz)).error.code, 'INVALID_TIMEZONE', String(tz));
    const at = '2031-07-04T14:30:00.000Z';
    const a = await sched(p.id, at, 'Pacific/Auckland');
    assert.equal(a.success, true);
    assert.equal((await row(p.id)).scheduledAt.toISOString(), at);
    const b = await sched(p.id, at, 'America/New_York');
    assert.equal((await row(p.id)).scheduledAt.toISOString(), at, 'same instant whatever zone the user displayed it in');
    assert.equal(b.publication.timezone, 'America/New_York');
    assert.equal((await sched(p.id, at, null)).success, true);
    assert.equal((await row(p.id)).timezone ?? null, null);
  });

  test('16: DST: the same wall-clock hour on either side of a spring-forward is a different, correctly offset UTC instant', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await post();
    // New York: 2031-03-08 is EST (-05:00), 2031-03-09 is EDT (-04:00) after the 2031-03-09 02:00 spring-forward
    const before = await sched(p.id, '2031-03-08T09:00:00-05:00', 'America/New_York');
    assert.equal((await row(p.id)).scheduledAt.toISOString(), '2031-03-08T14:00:00.000Z');
    const afterDst = await sched(p.id, '2031-03-10T09:00:00-04:00', 'America/New_York');
    assert.equal((await row(p.id)).scheduledAt.toISOString(), '2031-03-10T13:00:00.000Z');
    assert.equal(before.success && afterDst.success, true);
    // an offset-aware string is an absolute instant: +05:30 and Z spellings of one instant store identically
    await sched(p.id, '2031-06-01T18:00:00+05:30', 'Asia/Kolkata');
    const a = (await row(p.id)).scheduledAt.toISOString();
    await sched(p.id, '2031-06-01T12:30:00.000Z', 'Asia/Kolkata');
    assert.equal((await row(p.id)).scheduledAt.toISOString(), a);
  });

  // ── STATE ─────────────────────────────────────────────────────────────────
  test('17: published, publishing, failed-terminal and cancelled posts cannot be scheduled', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    for (const status of ['published', 'publishing', 'failed', 'cancelled']) {
      const p = await post();
      await SocialPublication.updateOne({ _id: p.id }, { $set: { status } });
      const r = await sched(p.id);
      assert.equal(r.success, false, status);
      assert.equal(r.error.code, 'NOT_EDITABLE', status);
      assert.equal((await row(p.id)).status, status);
    }
    assert.deepEqual(metaCalls, []);
  });

  test('18: scheduling an already-scheduled post is the existing reschedule: same row, new time, logged as rescheduled', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await post();
    await sched(p.id, future(24 * HOUR));
    const later = future(72 * HOUR);
    const r = await sched(p.id, later);
    assert.equal(r.success, true);
    assert.equal((await row(p.id)).scheduledAt.toISOString(), new Date(later).toISOString());
    assert.equal(await SocialPublication.countDocuments({ project_id: project._id }), 1);
    const logs = captured.join('\n');
    assert.ok(logs.includes('publication_scheduled'));
    assert.ok(logs.includes('publication_rescheduled'));
  });

  test('19: a rescheduled post cannot dodge approval: once approval is withdrawn, rescheduling is refused too', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await post();
    await sched(p.id);
    await updatePublication(pid, p.id, userId, { content: 'Edited caption after scheduling' });
    assert.equal((await row(p.id)).approvalState, 'content_review');
    const r = await sched(p.id, future(96 * HOUR));
    assert.equal(r.success, false);
    assert.equal(r.error.code, 'APPROVAL_REQUIRED');
  });

  // ── CONCURRENCY / IDEMPOTENCY ─────────────────────────────────────────────
  test('20: six simultaneous identical requests (double click / retries / two tabs) -> all succeed on ONE row; one document, one schedule', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await post();
    const at = future();
    const results = await Promise.all(Array.from({ length: 6 }, () => sched(p.id, at)));
    assert.equal(results.every((r) => r.success), true);
    assert.equal(await SocialPublication.countDocuments({ project_id: project._id }), 1);
    const after = await row(p.id);
    assert.equal(after.status, 'scheduled');
    assert.equal(after.scheduledAt.toISOString(), new Date(at).toISOString());
    assert.deepEqual(metaCalls, []);
  });

  test('21: two tabs with DIFFERENT times: exactly one final time (a real, complete one) - never a mix, never a duplicate', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await post();
    const [a, b] = [future(24 * HOUR), future(48 * HOUR)];
    await Promise.all([sched(p.id, a, 'UTC'), sched(p.id, b, 'Asia/Kolkata')]);
    const after = await row(p.id);
    const pair = [[new Date(a).toISOString(), 'UTC'], [new Date(b).toISOString(), 'Asia/Kolkata']];
    assert.ok(pair.some(([iso, tz]) => after.scheduledAt.toISOString() === iso && after.timezone === tz), 'time and timezone come from the same request');
    assert.equal(await SocialPublication.countDocuments({ project_id: project._id }), 1);
  });

  test('22: scheduling racing a content edit: the post can NEVER end up scheduled while its approval is withdrawn', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    for (let i = 0; i < 6; i += 1) {
      const p = await post();
      await Promise.all([sched(p.id), updatePublication(pid, p.id, userId, { content: `Changed caption ${i}` })]);
      const after = await row(p.id);
      assert.equal(after.approvalState, 'content_review', 'the edit always withdraws approval');
      if (after.status === 'scheduled') assert.equal(after.contentVersion, 2, 'if it got scheduled first, the edit then invalidated it (version moved on)');
      else assert.equal(after.status, 'draft');
    }
  });

  test('23: scheduling racing "request changes"/re-review ends consistent: scheduled only if it was still design_approved at the write', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await post();
    await Promise.all([sched(p.id), updatePublication(pid, p.id, userId, { media: [{ url: mediaUrl('z'), type: 'image' }] })]);
    const after = await row(p.id);
    if (after.status === 'scheduled') assert.ok(after.approvalState !== 'design_approved' || after.designVersion === 1);
    assert.equal(await SocialPublication.countDocuments({ project_id: project._id }), 1);
  });

  // The conditional write must hold even when something changes AFTER schedulePublication has read the post and passed its
  // checks. These tests change the post at exactly that moment (the account lookup inside the readiness check is the window).
  async function duringReadiness(change, fn) {
    const realFindById = SocialAccount.findById;
    let fired = false;
    SocialAccount.findById = function patched(...args) {
      const result = realFindById.apply(this, args);
      if (fired) return result;
      fired = true;
      return Promise.resolve(change()).then(() => result);
    };
    try { return await fn(); } finally { SocialAccount.findById = realFindById; }
  }

  test('23b: approval withdrawn in the window between the checks and the write -> NOT scheduled (the write itself is conditional on approval)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await post();
    const r = await duringReadiness(() => SocialPublication.updateOne({ _id: p.id }, { $set: { approvalState: 'content_review' } }), () => sched(p.id));
    assert.equal(r.success, false);
    assert.equal(r.error.code, 'APPROVAL_REQUIRED');
    const after = await row(p.id);
    assert.equal(after.status, 'draft');
    assert.equal(after.scheduledAt ?? null, null);
  });

  test('23f: a post OUTSIDE the workflow that is submitted for review in the window is NOT scheduled as if it were unmanaged', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await post({ upTo: 'draft' });
    assert.equal((await row(p.id)).approvalState ?? null, null);
    const r = await duringReadiness(() => SocialPublication.updateOne({ _id: p.id }, { $set: { approvalState: 'content_review' } }), () => sched(p.id));
    assert.equal(r.success, false);
    assert.equal(r.error.code, 'APPROVAL_REQUIRED');
    assert.equal((await row(p.id)).status, 'draft');
  });

  test('23c: content edited in the window (version bumped, state unchanged) -> NOT scheduled: the write is pinned to the version that was checked', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await post();
    const r = await duringReadiness(() => SocialPublication.updateOne({ _id: p.id }, { $inc: { contentVersion: 1 } }), () => sched(p.id));
    assert.equal(r.success, false);
    assert.equal(r.error.code, 'APPROVAL_CONFLICT');
    assert.equal((await row(p.id)).status, 'draft');
  });

  test('23d: design replaced in the window (designVersion bumped) -> NOT scheduled', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await post();
    const r = await duringReadiness(() => SocialPublication.updateOne({ _id: p.id }, { $inc: { designVersion: 1 } }), () => sched(p.id));
    assert.equal(r.success, false);
    assert.equal(r.error.code, 'APPROVAL_CONFLICT');
    assert.equal((await row(p.id)).status, 'draft');
  });

  test('23e: post cancelled / published in the window -> the schedule write cannot resurrect it', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    for (const status of ['cancelled', 'publishing', 'published']) {
      const p = await post();
      const r = await duringReadiness(() => SocialPublication.updateOne({ _id: p.id }, { $set: { status } }), () => sched(p.id));
      assert.equal(r.success, false, status);
      assert.equal(r.error.code, 'NOT_EDITABLE', status);
      assert.equal((await row(p.id)).status, status, status);
      assert.equal((await row(p.id)).scheduledAt ?? null, null);
    }
  });

  // ── VERSIONING ────────────────────────────────────────────────────────────
  test('24: editing the caption of a SCHEDULED post bumps contentVersion and withdraws BOTH approvals (existing edit rule) - the old approval no longer applies', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await post();
    await sched(p.id);
    const r = await updatePublication(pid, p.id, userId, { content: 'A different caption' });
    assert.equal(r.success, true);
    const after = await row(p.id);
    assert.equal(after.contentVersion, 2);
    assert.equal(after.approvalState, 'content_review');
    assert.equal(after.contentApprovedVersion ?? null, null);
    assert.equal(after.designApprovedVersion ?? null, null);
    assert.equal(r.publication.approval.publishable, false);
    assert.equal(r.publication.status, 'draft', 'the schedule went with the approval');
    assert.equal(r.scheduleCleared, true);
  });

  test('25: replacing the design of a scheduled post bumps designVersion and sends it back to design review (content approval stays)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await post();
    await sched(p.id);
    await updatePublication(pid, p.id, userId, { media: [{ url: mediaUrl('new'), type: 'image' }] });
    const after = await row(p.id);
    assert.equal(after.designVersion, 2);
    assert.equal(after.approvalState, 'design_review');
    assert.equal(after.contentApprovedVersion, 1);
  });

  test('26: SAFETY NET: a scheduled row with invalid approval (legacy shape) is refused by the scheduler: APPROVAL_REQUIRED, zero Meta calls', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await post();
    await sched(p.id);
    await updatePublication(pid, p.id, userId, { content: 'Edited after scheduling' });
    assert.equal((await row(p.id)).status, 'draft', 'the edit already removed the schedule');
    await SocialPublication.updateOne({ _id: p.id }, { $set: { status: 'scheduled', scheduledAt: new Date(Date.now() - 60_000) } });
    const run = await executeDuePublications({ projectId: pid });
    assert.equal(run.processed, 1);
    assert.deepEqual(metaCalls, [], 'an unapproved version never reaches Meta');
    const after = await row(p.id);
    assert.equal(after.status, 'failed');
    assert.equal(after.failureCode, 'APPROVAL_REQUIRED');
  });

  // ── SECURITY (HTTP handler) ───────────────────────────────────────────────
  test('27: the handler reads ONLY scheduledAt + timezone: forged project, status, approval, versions, account and platform are ignored', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await post({ upTo: 'content_approved' });
    const other = track(await SeoProject.create({ user_id: userId, project_name: `Sched forged ${Date.now()}`, main_url: 'https://example.org', seo_scope: 'local', keywords: ['k'] }));
    const res = mockRes();
    await schedulePublicationHandler({
      projectId: pid, userId: String(userId), params: { publicationId: p.id },
      body: { scheduledAt: future(), timezone: 'UTC', projectId: String(other._id), status: 'scheduled', approvalState: 'design_approved', contentVersion: 9, designVersion: 9, socialAccountId: String(ig._id), platform: 'instagram', accessToken: 'FORGED' },
    }, res);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.details.code, 'APPROVAL_REQUIRED');
    const after = await row(p.id);
    assert.equal(after.status, 'draft');
    assert.equal(after.approvalState, 'content_approved');
    assert.equal(after.contentVersion, 1);
    assert.equal(after.platform, 'facebook');
    assert.equal(String(after.social_account_id), String(fb._id));
    assert.equal(JSON.stringify(res.body).includes('FORGED'), false);
  });

  test('28: forged fields cannot change a legitimate schedule either (status/approval/versions/account stay server-owned)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await post();
    const res = mockRes();
    await schedulePublicationHandler({
      projectId: pid, userId: String(userId), params: { publicationId: p.id },
      body: { scheduledAt: future(), timezone: 'UTC', status: 'published', approvalState: null, contentVersion: 99, designVersion: 99, socialAccountId: String(ig._id), platform: 'instagram', externalPostId: 'x' },
    }, res);
    assert.equal(res.statusCode, 200);
    const after = await row(p.id);
    assert.equal(after.status, 'scheduled');
    assert.equal(after.approvalState, 'design_approved');
    assert.equal(after.contentVersion, 1);
    assert.equal(after.designVersion, 1);
    assert.equal(after.platform, 'facebook');
    assert.equal(after.externalPostId ?? null, null);
  });

  test('29: handler error shapes: missing scheduledAt 400, past 400, reconnect 409 - no stack, token or internals', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await post();
    const call = async (body) => { const res = mockRes(); await schedulePublicationHandler({ projectId: pid, userId: String(userId), params: { publicationId: p.id }, body }, res); return res; };
    assert.equal((await call({})).statusCode, 400);
    assert.equal((await call({ scheduledAt: new Date(Date.now() - 5000).toISOString() })).body.details.code, 'SCHEDULE_IN_PAST');
    assert.equal((await call({ scheduledAt: future(), timezone: 'Nope/Zone' })).body.details.code, 'INVALID_TIMEZONE');
    await SocialAccount.updateOne({ _id: fb._id }, { $set: { status: 'expired' } });
    const expired = await call({ scheduledAt: future() });
    assert.equal(expired.statusCode, 409);
    const text = JSON.stringify(expired.body);
    for (const leak of ['FB-SECRET-TOKEN', 'accessToken', 'stack', 'at async']) assert.equal(text.includes(leak), false, leak);
    const nf = mockRes();
    await schedulePublicationHandler({ projectId: pid, userId: String(userId), params: { publicationId: new mongoose.Types.ObjectId().toString() }, body: { scheduledAt: future() } }, nf);
    assert.equal(nf.statusCode, 404);
  });

  // ── META SEPARATION / OBSERVABILITY ───────────────────────────────────────
  test('30: scheduling makes ZERO Meta calls, on every outcome (accepted, rejected, rescheduled, cancelled)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const ok = await post();
    const blocked = await post({ upTo: 'content_review' });
    await sched(ok.id); await sched(ok.id, future(72 * HOUR)); await sched(blocked.id); await sched(ok.id, 'bad');
    await cancelPublication(pid, ok.id, userId);
    assert.deepEqual(metaCalls, []);
    assert.equal((await row(ok.id)).status, 'cancelled');
  });

  test('31: structured events carry safe identifiers only - no caption, token, prompt or credential', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await post({ content: 'UNIQUE-CAPTION-MARKER do not log me' });
    await sched(p.id);
    await sched(p.id, 'garbage');
    const blocked = await post({ upTo: 'content_review' });
    await sched(blocked.id);
    await cancelPublication(pid, p.id, userId);
    const logs = captured.join('\n');
    for (const e of ['publication_schedule_requested', 'publication_scheduled', 'publication_schedule_rejected', 'publication_cancelled']) assert.ok(logs.includes(e), e);
    assert.match(logs, new RegExp(`"publicationId":"${p.id}"`));
    assert.match(logs, /"contentVersion":1/);
    assert.match(logs, /"designVersion":1/);
    for (const secret of ['UNIQUE-CAPTION-MARKER', 'FB-SECRET-TOKEN', 'IG-SECRET-TOKEN', 'accessToken']) assert.equal(logs.includes(secret), false, secret);
  });

  // ── CANCEL ────────────────────────────────────────────────────────────────
  test('32: cancel works on scheduled posts through the existing path, and never touches a published one', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await post();
    await sched(p.id);
    assert.equal((await cancelPublication(pid, p.id, userId)).success, true);
    assert.equal((await row(p.id)).status, 'cancelled');
    const done = await post();
    await SocialPublication.updateOne({ _id: done.id }, { $set: { status: 'published', externalPostId: 'ext_1' } });
    const r = await cancelPublication(pid, done.id, userId);
    assert.equal(r.error.code, 'NOT_CANCELLABLE');
    assert.equal((await row(done.id)).status, 'published');
  });

  // ── EXISTING SCHEDULER ────────────────────────────────────────────────────
  test('33: a scheduled post is picked up by the EXISTING scheduler when due and published through the adapter exactly once', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await post();
    await sched(p.id);
    assert.deepEqual(metaCalls, [], 'nothing before the scheduler runs');
    await executeDuePublications({ projectId: pid }); // not due yet
    assert.deepEqual(metaCalls, []);
    await SocialPublication.updateOne({ _id: p.id }, { $set: { scheduledAt: new Date(Date.now() - 60_000) } });
    const run = await executeDuePublications({ projectId: pid });
    assert.equal(run.succeeded, 1);
    assert.deepEqual(metaCalls, ['facebook.publish']);
    const after = await row(p.id);
    assert.equal(after.status, 'published');
    assert.ok(after.externalPostId);
    assert.equal(after.approvalState, 'design_approved');
  });

  test('34: two scheduler workers running at once cannot publish the same post twice (atomic claim)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const p = await post();
    await sched(p.id);
    await SocialPublication.updateOne({ _id: p.id }, { $set: { scheduledAt: new Date(Date.now() - 60_000) } });
    publishImpl = async () => { await new Promise((r) => setTimeout(r, 80)); return { success: true, externalPostId: 'ext_once' }; };
    const runs = await Promise.all(Array.from({ length: 4 }, () => executeDuePublications({ projectId: pid })));
    assert.equal(metaCalls.filter((c) => c === 'facebook.publish').length, 1);
    assert.equal(runs.reduce((n, r) => n + r.succeeded, 0), 1);
    assert.equal((await row(p.id)).status, 'published');
    assert.equal(await SocialPublication.countDocuments({ project_id: project._id, externalPostId: 'ext_once' }), 1);
  });

  test('35: a post scheduled for the future is untouched by the scheduler, and a too-late post is failed (not published)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const soon = await post();
    await sched(soon.id, future(6 * HOUR));
    const late = await post();
    await sched(late.id);
    await SocialPublication.updateOne({ _id: late.id }, { $set: { scheduledAt: new Date(Date.now() - 5 * HOUR) } });
    await executeDuePublications({ projectId: pid });
    assert.equal((await row(soon.id)).status, 'scheduled');
    assert.equal((await row(late.id)).status, 'failed');
    assert.deepEqual(metaCalls, []);
  });
});
