import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SeoProject from '../../../app_user/model/SeoProject.js';
import SocialAccount from '../../model/SocialAccount.js';
import SocialAIStrategy from '../../model/SocialAIStrategy.js';
import SocialBusinessProfile from '../../model/SocialBusinessProfile.js';
import SocialContentCalendar from '../../model/SocialContentCalendar.js';
import SocialContentCalendarItem from '../../model/SocialContentCalendarItem.js';
import { updateProfile } from '../socialBusinessProfileService.js';
import { startGeneration as startStrategy, setProviderOverride as setStrategyProvider, resetProviderOverride as resetStrategyProvider } from '../aiStrategy/socialAIStrategyService.js';
import {
  startCalendarGeneration, getCalendarState, listVersions, getVersion, restoreVersion, setCalendarProviderOverride, resetCalendarProviderOverride,
} from './socialContentCalendarService.js';
import { updateItem, approveItem } from './socialContentCalendarItemService.js';
import { validRawStrategy, mockProvider, mockCalendarProvider, validRawCalendarBatch } from '../../testSupport/aiStrategyFixtures.js';

/**
 * Calendar history: regenerating archives the previous version WITH everything the person did to it, and the history is reachable - listed,
 * readable, restorable whole. Real MongoDB, scripted AI.
 */

let mongoAvailable = false;
before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
    await Promise.all([SocialContentCalendar.init(), SocialContentCalendarItem.init(), SocialAIStrategy.init()]);
  } catch { mongoAvailable = false; }
});
after(async () => {
  resetCalendarProviderOverride();
  resetStrategyProvider();
  if (mongoAvailable) await mongoose.connection.close();
});

const addDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('calendar history (real MongoDB, scripted providers)', () => {
  let userId; let project; let pid; let created; let gates;
  const track = (d) => { created.push(d); return d; };
  const request = (over = {}) => ({ startDate: addDays(1), months: 1, endDate: undefined, postsPerWeek: 2, platforms: ['facebook'], distributionMode: 'balanced', ...over });
  const generate = async (over = {}, provider = mockCalendarProvider()) => {
    setCalendarProviderOverride(provider);
    const r = await startCalendarGeneration(pid, userId, request(over), { background: false });
    assert.equal(r.generation.status, 'ready', JSON.stringify(r));
    return SocialContentCalendar.findById(r.generation.id).lean();
  };
  const items = (calendarId) => SocialContentCalendarItem.find({ calendar_id: calendarId }).sort({ slot: 1 }).lean();

  async function seedStrategy() {
    setStrategyProvider(mockProvider({ behavior: () => validRawStrategy() }));
    const r = await startStrategy(pid, userId, { background: false });
    resetStrategyProvider();
    assert.equal(r.generation.status, 'ready', JSON.stringify(r));
  }

  beforeEach(async () => {
    if (!mongoAvailable) return;
    created = []; gates = [];
    userId = new mongoose.Types.ObjectId();
    project = track(await SeoProject.create({ user_id: userId, project_name: `History ${Date.now()} ${Math.random().toString(36).slice(2, 8)}`, main_url: 'https://example.com', seo_scope: 'local', keywords: ['k'], description: 'Family dental practice', industry: 'Dentist' }));
    pid = project._id.toString();
    await updateProfile(pid, userId, { audience: { primary: 'Young families' }, goals: ['More bookings'], toneOfVoice: { primary: 'Warm' } });
    track(await SocialAccount.create({ user_id: userId, project_id: project._id, platform: 'facebook', platformAccountId: `pg_${pid}`, platformAccountName: 'Page', accountType: 'page', pageId: `pg_${pid}`, accessToken: 'FB-SECRET-TOKEN', status: 'active', isActive: true }));
    await seedStrategy();
  });

  afterEach(async () => {
    for (const g of gates) g.resolve();
    await sleep(60);
    resetCalendarProviderOverride();
    if (!mongoAvailable) return;
    const ids = created.map((d) => d.project_id || d._id);
    await Promise.all([
      SocialContentCalendarItem.deleteMany({ project_id: { $in: ids } }), SocialContentCalendar.deleteMany({ project_id: { $in: ids } }),
      SocialAIStrategy.deleteMany({ project_id: { $in: ids } }), SocialBusinessProfile.deleteMany({ project_id: { $in: ids } }),
      SocialAccount.deleteMany({ _id: { $in: created.map((d) => d._id) } }),
    ]);
    await SeoProject.deleteMany({ _id: { $in: created.map((d) => d._id) } });
  });

  /** Version 1 with one EDITED and APPROVED post, then version 2 regenerated over it. */
  async function twoVersions() {
    const v1 = await generate();
    const first = (await items(v1._id))[0];
    const e = await updateItem(pid, userId, String(first._id), { expectedRevision: first.revision, caption: 'My own words for version one.', topic: 'My own topic' });
    assert.equal(e.success, true, JSON.stringify(e.error));
    const a = await approveItem(pid, userId, String(first._id), { expectedRevision: e.item.revision });
    assert.equal(a.success, true, JSON.stringify(a.error));
    const v2 = await generate({ postsPerWeek: 3 });
    return { v1, v2, editedId: String(first._id) };
  }

  test('H1: the history lists every version with how much of it was edited, approved or turned into posts - and says which one is current', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { v1, v2 } = await twoVersions();
    const { versions, currentVersion } = await listVersions(pid);
    assert.equal(currentVersion, 2);
    assert.deepEqual(versions.map((v) => [v.version, v.status, v.isCurrent]), [[2, 'ready', true], [1, 'archived', false]]);
    const old = versions.find((v) => v.version === 1);
    assert.equal(old.counts.edited, 1);
    assert.equal(old.counts.approvedPlans, 1);
    assert.equal(old.counts.withPosts, 0);
    assert.equal(old.counts.total, (await items(v1._id)).length);
    assert.equal(versions[0].counts.edited, 0);
    assert.equal(versions[0].counts.total, (await items(v2._id)).length);
    assert.equal(old.config.postsPerWeek, 2);
    assert.equal(versions[0].config.postsPerWeek, 3);
    assert.equal(old.strategy.version, 1);
    assert.ok(!JSON.stringify(versions).includes('FB-SECRET'), 'no secret');
  });

  test('H2: an archived version can be OPENED: its posts are there exactly as left (edits included), read-only', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { v1, editedId } = await twoVersions();
    const r = await getVersion(pid, String(v1._id));
    assert.equal(r.success, true);
    assert.equal(r.version.status, 'archived');
    const edited = r.items.find((i) => i.id === editedId);
    assert.equal(edited.caption, 'My own words for version one.');
    assert.equal(edited.topic, 'My own topic');
    assert.ok(r.items.every((i) => i.locked === true), 'history is read-only');
    // and it can really not be edited
    const raw = await SocialContentCalendarItem.findById(editedId).lean();
    assert.equal((await updateItem(pid, userId, editedId, { expectedRevision: raw.revision, topic: 'x' })).error.code, 'CALENDAR_ARCHIVED');
  });

  test('H3: RESTORE brings a version back whole - its edits and approvals - and moves the current one into history; nothing is lost either way', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { v1, v2, editedId } = await twoVersions();
    const v2Items = (await items(v2._id)).map((i) => [String(i._id), i.topic]);
    const r = await restoreVersion(pid, String(v1._id));
    assert.deepEqual([r.success, r.restoredVersion, r.replacedVersion], [true, 1, 2]);

    const state = await getCalendarState(pid);
    assert.equal(state.calendar.version, 1, 'version 1 is the current calendar again');
    const back = state.items.find((i) => i.id === editedId);
    assert.equal(back.caption, 'My own words for version one.', 'the edit survived');
    assert.equal(back.status, 'plan_approved', 'the approval survived');
    assert.deepEqual((await SocialContentCalendar.find({ project_id: project._id }).sort({ version: 1 }).lean()).map((c) => [c.version, c.status]), [[1, 'ready'], [2, 'archived']]);
    assert.deepEqual((await items(v2._id)).map((i) => [String(i._id), i.topic]), v2Items, 'version 2 is untouched, in history');

    // the restored version is editable again; the one moved to history is not
    const raw = await SocialContentCalendarItem.findById(editedId).lean();
    assert.equal((await updateItem(pid, userId, editedId, { expectedRevision: raw.revision, hook: 'A new hook after the restore' })).success, true);
    const old = (await items(v2._id))[0];
    assert.equal((await updateItem(pid, userId, String(old._id), { expectedRevision: old.revision, topic: 'x' })).error.code, 'CALENDAR_ARCHIVED');

    // and it can be restored back
    assert.equal((await restoreVersion(pid, String(v2._id))).restoredVersion, 2);
    assert.equal((await getCalendarState(pid)).calendar.version, 2);
  });

  test('H4: restore refuses what it must: the current version, a calendar that is not history, another project\'s calendar, a bad id, and a missing strategy', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { v1, v2 } = await twoVersions();
    assert.equal((await restoreVersion(pid, String(v2._id))).error.code, 'ALREADY_CURRENT');
    assert.equal((await restoreVersion(pid, 'not-an-id')).error.code, 'NOT_FOUND');
    assert.equal((await restoreVersion(pid, String(new mongoose.Types.ObjectId()))).error.code, 'NOT_FOUND');
    await SocialContentCalendar.updateOne({ _id: v1._id }, { $set: { status: 'failed' } });
    assert.equal((await restoreVersion(pid, String(v1._id))).error.code, 'NOT_FOUND', 'a failed attempt is not a version');
    await SocialContentCalendar.updateOne({ _id: v1._id }, { $set: { status: 'archived' } });

    // another project: it can neither see nor restore this project's versions
    const other = track(await SeoProject.create({ user_id: userId, project_name: `Other ${Date.now()}`, main_url: 'https://example.org', seo_scope: 'local', keywords: ['k'] }));
    assert.equal((await restoreVersion(String(other._id), String(v1._id))).error.code, 'NOT_FOUND');
    assert.equal((await getVersion(String(other._id), String(v1._id))).error.code, 'NOT_FOUND');
    assert.deepEqual((await listVersions(String(other._id))).versions, []);
    assert.equal((await SocialContentCalendar.findById(v1._id).lean()).status, 'archived', 'nothing changed');

    await SocialAIStrategy.deleteMany({ project_id: project._id });
    assert.equal((await restoreVersion(pid, String(v1._id))).error.code, 'NO_STRATEGY');
  });

  test('H5: restore is refused while a generation is running or unfinished (it would compete with the version just restored)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { v1 } = await twoVersions();
    let release; const gate = new Promise((r) => { release = r; }); gates.push({ resolve: release });
    setCalendarProviderOverride(mockCalendarProvider({ gate }));
    await startCalendarGeneration(pid, userId, request({ postsPerWeek: 4 }));
    assert.equal((await restoreVersion(pid, String(v1._id))).error.code, 'GENERATION_IN_PROGRESS');
    release();
    for (let i = 0; i < 100 && (await SocialContentCalendar.countDocuments({ project_id: project._id, status: 'generating' })); i += 1) await sleep(20);
    assert.equal((await restoreVersion(pid, String(v1._id))).success, true, 'fine once it has finished');
  });

  test('H6: restores racing each other always leave EXACTLY ONE current calendar, every post intact', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { v1, v2 } = await twoVersions();
    const v3 = await generate({ postsPerWeek: 4 });
    const before = (await SocialContentCalendarItem.countDocuments({ project_id: project._id }));
    for (let round = 0; round < 4; round += 1) {
      const results = await Promise.all([restoreVersion(pid, String(v1._id)), restoreVersion(pid, String(v2._id)), restoreVersion(pid, String(v1._id))]);
      assert.ok(results.some((r) => r.success), JSON.stringify(results.map((r) => r.error?.code)));
      assert.ok(results.every((r) => r.success || ['CONFLICT', 'ALREADY_CURRENT', 'NOT_FOUND'].includes(r.error.code)));
      const ready = await SocialContentCalendar.find({ project_id: project._id, status: 'ready' }).lean();
      assert.equal(ready.length, 1, `round ${round}: exactly one ready calendar`);
      assert.equal((await getCalendarState(pid)).calendar.id, String(ready[0]._id));
      assert.equal(await SocialContentCalendarItem.countDocuments({ project_id: project._id }), before, 'no post lost or duplicated');
      await restoreVersion(pid, String(v3._id)); // reset for the next round (may be ALREADY_CURRENT)
    }
  });

  test('H7: an edit racing a regeneration is never lost: before the new version is ready it lands in the version being replaced; after, it is refused as history - and either way it is in the history', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const v1 = await generate();
    const first = (await items(v1._id))[0];
    let release; const gate = new Promise((r) => { release = r; }); gates.push({ resolve: release });
    setCalendarProviderOverride(mockCalendarProvider({ gate }));
    await startCalendarGeneration(pid, userId, request({ postsPerWeek: 3 }));
    // while version 2 is still being made, version 1 is the current calendar and can be edited
    const during = await updateItem(pid, userId, String(first._id), { expectedRevision: first.revision, caption: 'Edited while the new calendar was being made.' });
    assert.equal(during.success, true, JSON.stringify(during.error));
    release();
    for (let i = 0; i < 100 && (await SocialContentCalendar.countDocuments({ project_id: project._id, status: 'generating' })); i += 1) await sleep(20);
    // now version 1 is history: a late edit is refused with the reason, and the earlier edit is in the history
    const late = await updateItem(pid, userId, String(first._id), { expectedRevision: during.item.revision, caption: 'Too late' });
    assert.equal(late.error.code, 'CALENDAR_ARCHIVED');
    const opened = await getVersion(pid, String(v1._id));
    assert.equal(opened.items.find((i) => i.id === String(first._id)).caption, 'Edited while the new calendar was being made.');
    assert.equal((await listVersions(pid)).versions.find((v) => v.version === 1).counts.edited, 1);
  });

  test('H8: after a restore the "strategy changed" notice describes the restored version honestly, and a failed attempt from before is not shown against it', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { v1 } = await twoVersions();
    setCalendarProviderOverride(mockCalendarProvider({ behavior: () => { const e = new Error('x'); e.code = 'CLAUDE_AUTH'; throw e; } }));
    const failed = await startCalendarGeneration(pid, userId, request(), { background: false });
    assert.equal(failed.generation.status, 'failed');
    assert.equal((await getCalendarState(pid)).status, 'failed');
    await seedStrategy(); // a newer strategy exists now
    assert.equal((await restoreVersion(pid, String(v1._id))).success, true);
    const state = await getCalendarState(pid);
    assert.equal(state.status, 'ready', 'the old failed attempt is not reported against the restored calendar');
    assert.equal(state.generation, null);
    assert.equal(state.stale.strategyChanged, true);
    assert.equal(state.calendar.strategy.version, 1, 'the restored calendar keeps its own strategy pin');
  });
});
