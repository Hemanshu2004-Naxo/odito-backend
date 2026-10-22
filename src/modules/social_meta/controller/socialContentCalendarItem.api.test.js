import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import 'dotenv/config';
import mongoose from 'mongoose';
import express from 'express';
import apiRoutes from '../../../routes/index.js';
import calendarRouter from '../routes/socialContentCalendarRoutes.js';
import User from '../../user/model/User.js';
import SeoProject from '../../app_user/model/SeoProject.js';
import SocialAccount from '../model/SocialAccount.js';
import SocialAIStrategy from '../model/SocialAIStrategy.js';
import SocialBusinessProfile from '../model/SocialBusinessProfile.js';
import SocialContentCalendar from '../model/SocialContentCalendar.js';
import SocialContentCalendarItem from '../model/SocialContentCalendarItem.js';
import SocialContentGeneration from '../model/SocialContentGeneration.js';
import SocialPublication from '../model/SocialPublication.js';
import { signAuthToken } from '../../user/service/tokenService.js';
import { updateProfile } from '../service/socialBusinessProfileService.js';
import { startGeneration as startStrategy, setProviderOverride as setStrategyProvider, resetProviderOverride as resetStrategyProvider } from '../service/aiStrategy/socialAIStrategyService.js';
import { startCalendarGeneration, setCalendarProviderOverride, resetCalendarProviderOverride } from '../service/calendar/socialContentCalendarService.js';
import { setContentProviderOverride, resetContentProviderOverride } from '../service/aiContent/socialContentGenerationService.js';
import { CONTENT_RATE_LIMIT } from '../service/aiContent/contentConfig.js';
import { validRawStrategy, mockProvider, mockCalendarProvider, validRawCalendarItem, mockContentProvider, validRawPost } from '../testSupport/aiStrategyFixtures.js';

/**
 * The per-item Content Calendar API end to end: a real Express app mounting the real /api router (real JWT auth, real
 * validateProjectAccess), real MongoDB, the AI providers scripted. Every case is a no-op pass when MongoDB is unreachable.
 */

let server; let base; let mongoAvailable = false;
let owner; let stranger; let projectA; let projectB; let tokenA; let tokenB; let calendar;
const accounts = [];
const extraUsers = [];
const extraProjects = [];
const addDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

before(async () => {
  process.env.SOCIAL_AI_CALENDAR_ITEM_RATE_LIMIT_ENABLED = 'false'; // flow tests make many calls as one user; the limiter has its own test (the switch is read per request)
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
  } catch { mongoAvailable = false; }
  const app = express();
  app.use(express.json());
  app.use('/api', apiRoutes);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  if (!mongoAvailable) return;
  const mkUser = (tag) => User.create({ firstName: 'Item', lastName: tag, email: `calendar-item-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`, password: 'password123', roleId: 5, isActive: true, isEmailVerified: true });
  owner = await mkUser('A'); stranger = await mkUser('B');
  const mkProject = (u, tag) => SeoProject.create({ user_id: u._id, project_name: `Item API ${tag} ${Date.now()} ${Math.random().toString(36).slice(2, 7)}`, main_url: 'https://example.com', seo_scope: 'local', keywords: ['k'], description: 'Family dental practice', industry: 'Dentist' });
  projectA = await mkProject(owner, 'A'); projectB = await mkProject(stranger, 'B');
  tokenA = signAuthToken(owner); tokenB = signAuthToken(stranger);
  for (const [p, u] of [[projectA, owner], [projectB, stranger]]) {
    await updateProfile(String(p._id), u._id, { audience: { primary: 'Families' }, goals: ['Bookings'] });
    const pageId = `pg_${Math.random().toString(36).slice(2, 8)}`;
    accounts.push(await SocialAccount.create({ user_id: u._id, project_id: p._id, platform: 'facebook', platformAccountId: pageId, platformAccountName: 'Page', accountType: 'page', pageId, accessToken: 'FB-SECRET-TOKEN', status: 'active', isActive: true }));
  }
  // Project A (Facebook only) gets a real strategy and calendar
  setStrategyProvider(mockProvider({ behavior: () => validRawStrategy() }));
  await startStrategy(String(projectA._id), owner._id, { background: false });
  resetStrategyProvider();
  setCalendarProviderOverride(mockCalendarProvider());
  await startCalendarGeneration(String(projectA._id), owner._id, { startDate: addDays(1), endDate: addDays(14), postsPerWeek: 4, platforms: ['facebook'], distributionMode: 'balanced' }, { background: false });
  resetCalendarProviderOverride();
  calendar = await SocialContentCalendar.findOne({ project_id: projectA._id, status: 'ready' }).lean();
});

after(async () => {
  delete process.env.SOCIAL_AI_CALENDAR_ITEM_RATE_LIMIT_ENABLED;
  server?.close();
  resetCalendarProviderOverride(); resetContentProviderOverride();
  if (!mongoAvailable) return;
  const ids = [projectA?._id, projectB?._id, ...extraProjects.map((p) => p._id)].filter(Boolean);
  await Promise.all([
    SocialContentCalendarItem.deleteMany({ project_id: { $in: ids } }), SocialContentCalendar.deleteMany({ project_id: { $in: ids } }), SocialAIStrategy.deleteMany({ project_id: { $in: ids } }),
    SocialContentGeneration.deleteMany({ project_id: { $in: ids } }), SocialBusinessProfile.deleteMany({ project_id: { $in: ids } }), SocialPublication.deleteMany({ project_id: { $in: ids } }),
    SocialAccount.deleteMany({ _id: { $in: accounts.map((a) => a._id) } }),
  ]);
  await SeoProject.deleteMany({ _id: { $in: ids } });
  await User.deleteMany({ _id: { $in: [owner?._id, stranger?._id, ...extraUsers.map((u) => u._id)].filter(Boolean) } });
  await mongoose.connection.close();
});

async function call(method, path, { token = tokenA, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(base + path, { method, headers, body: payload });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json };
}
const pidA = () => String(projectA._id);
const CAL = '/api/social/content-calendar';
const q = (pid) => `projectId=${encodeURIComponent(pid)}`;
const firstItem = async () => SocialContentCalendarItem.findOne({ calendar_id: calendar._id }).sort({ contentDate: 1, order: 1 }).lean();
const waitFor = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error('waitFor timed out');
};

describe('Content Calendar item API — wiring', () => {
  test('1: the item routes exist with the right layers; the two AI routes also have the rate limiter (and the generic calendar routes are unchanged)', () => {
    const routes = calendarRouter.stack.filter((l) => l.route).map((l) => ({ id: `${Object.keys(l.route.methods)[0]} ${l.route.path}`, layers: l.route.stack.length }));
    assert.deepEqual(routes.map((r) => r.id).sort(), [
      'get /', 'get /options', 'get /items/:itemId', 'get /status', 'patch /items/:itemId', 'get /history', 'get /history/:calendarId', 'post /cancel', 'post /generate', 'post /preview', 'post /restore', 'post /resume', 'post /items', 'post /items/:itemId/approve',
      'post /items/:itemId/generate-content', 'post /items/:itemId/regenerate', 'post /items/:itemId/revoke-approval',
    ].sort());
    const layers = (id) => routes.find((r) => r.id === id).layers;
    // auth + project access + rate limiter + handler (the same shape as POST /generate)
    assert.equal(layers('post /items/:itemId/regenerate'), 4);
    assert.equal(layers('post /items/:itemId/generate-content'), 4);
    for (const id of ['patch /items/:itemId', 'post /items', 'post /items/:itemId/approve', 'get /options', 'get /items/:itemId']) assert.equal(layers(id), 3, id);
    assert.ok(!routes.some((r) => r.id.includes(':id') || r.id.includes(':projectId')), 'a path param called id/projectId would be read as the project by the access middleware');
    assert.ok(!routes.some((r) => r.id.startsWith('delete')), 'there is no delete');
  });

  test('2: no JWT -> 401 on every item route', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const item = await firstItem();
    const id = String(item._id);
    for (const [method, path, body] of [
      ['GET', `${CAL}/options?${q(pidA())}`], ['GET', `${CAL}/items/${id}?${q(pidA())}`], ['PATCH', `${CAL}/items/${id}`, { projectId: pidA(), expectedRevision: 0, topic: 'x' }],
      ['POST', `${CAL}/items`, { projectId: pidA() }], ['POST', `${CAL}/items/${id}/approve`, { projectId: pidA(), expectedRevision: 0 }], ['POST', `${CAL}/items/${id}/revoke-approval`, { projectId: pidA(), expectedRevision: 0 }],
      ['POST', `${CAL}/items/${id}/regenerate`, { projectId: pidA(), expectedRevision: 0 }], ['POST', `${CAL}/items/${id}/generate-content`, { projectId: pidA(), platform: 'facebook' }],
    ]) assert.equal((await call(method, path, { token: null, body })).status, 401, `${method} ${path}`);
  });

  test('3: another user cannot read, edit, approve, regenerate or generate for this project - 403/404 before any handler, and nothing changes', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const item = await firstItem();
    const id = String(item._id);
    setCalendarProviderOverride(mockCalendarProvider()); setContentProviderOverride(mockContentProvider());
    for (const [method, path, body] of [
      ['GET', `${CAL}/options?${q(pidA())}`], ['GET', `${CAL}/items/${id}?${q(pidA())}`], ['PATCH', `${CAL}/items/${id}`, { projectId: pidA(), expectedRevision: 0, topic: 'hijacked' }],
      ['POST', `${CAL}/items`, { projectId: pidA(), date: addDays(3) }], ['POST', `${CAL}/items/${id}/approve`, { projectId: pidA(), expectedRevision: 0 }],
      ['POST', `${CAL}/items/${id}/regenerate`, { projectId: pidA(), expectedRevision: 0 }], ['POST', `${CAL}/items/${id}/generate-content`, { projectId: pidA(), platform: 'facebook' }],
    ]) {
      const res = await call(method, path, { token: tokenB, body });
      assert.ok([403, 404].includes(res.status), `${method} ${path} -> ${res.status}`);
    }
    const same = await firstItem();
    assert.equal(same.topic, item.topic);
    assert.equal(same.revision, item.revision);
    assert.equal(await SocialPublication.countDocuments({ project_id: projectA._id }), 0);
  });

  test('4: the stranger\'s OWN project does not expose this project\'s item either (the item id is only ever used inside the caller\'s project)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const item = await firstItem();
    const own = String(projectB._id);
    const get = await call('GET', `${CAL}/items/${item._id}?${q(own)}`, { token: tokenB });
    assert.equal(get.status, 404);
    assert.equal(get.body.details.code, 'NOT_FOUND');
    const patch = await call('PATCH', `${CAL}/items/${item._id}`, { token: tokenB, body: { projectId: own, expectedRevision: 0, topic: 'cross-project write' } });
    assert.equal(patch.status, 404);
    assert.equal((await firstItem()).topic, item.topic);
  });
});

describe('Content Calendar item API — editing flow', () => {
  test('5: options + one item read with the real catalog / strategy data', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const options = await call('GET', `${CAL}/options?${q(pidA())}`);
    assert.equal(options.status, 200);
    assert.deepEqual(options.body.data.pillars.map((p) => p.name), ['Dental tips', 'Meet the team', 'Offers']);
    assert.deepEqual(options.body.data.platforms, [{ platform: 'facebook', connected: true, inStrategy: true }, { platform: 'instagram', connected: false, inStrategy: true }]);
    assert.equal(JSON.stringify(options.body).includes('SECRET'), false);
    const item = await firstItem();
    const one = await call('GET', `${CAL}/items/${item._id}?${q(pidA())}`);
    assert.equal(one.status, 200);
    assert.equal(one.body.data.item.id, String(item._id));
    assert.equal(one.body.data.item.revision, 0);
  });

  test('6: PATCH saves atomically and returns the new item; the routing projectId in the body is not treated as a field', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const item = await firstItem();
    const res = await call('PATCH', `${CAL}/items/${item._id}`, { body: { projectId: pidA(), expectedRevision: 0, topic: 'Edited over HTTP', caption: 'A caption', hashtags: ['dental', '#care'], primaryCta: 'Learn more' } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const api = res.body.data.item;
    assert.equal(api.topic, 'Edited over HTTP');
    assert.deepEqual(api.hashtags, ['#dental', '#care']);
    assert.equal(api.revision, 1);
    assert.equal(api.status, 'edited');
    assert.deepEqual(res.body.data.changed.sort(), ['caption', 'hashtags', 'primaryCta', 'topic']);
    const list = await call('GET', `${CAL}?${q(pidA())}`);
    const inList = list.body.data.items.find((i) => i.id === String(item._id));
    assert.equal(inList.topic, 'Edited over HTTP');
    assert.equal(inList.caption, 'A caption');
  });

  test('7: error mapping: stale revision 409 (with the current item), unknown field 400, validation 422, bad id 404, locked 409', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const item = await firstItem();
    const id = String(item._id);
    const patch = (fields, rev = item.revision) => call('PATCH', `${CAL}/items/${id}`, { body: { projectId: pidA(), expectedRevision: rev, ...fields } });
    const stale = await patch({ topic: 'stale write' }, item.revision - 1 < 0 ? 99 : item.revision - 1);
    assert.equal(stale.status, 409);
    assert.equal(stale.body.details.code, 'ITEM_CONFLICT');
    assert.equal(stale.body.details.item.id, id);
    const unknown = await patch({ status: 'plan_approved' });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.details.code, 'UNKNOWN_FIELD');
    assert.equal((await patch({ topic: '' })).status, 400);
    assert.equal((await patch({ primaryKpi: 'bookings' })).status, 422);
    assert.equal((await patch({ platforms: ['facebook', 'instagram'] })).status, 422, 'Instagram is not connected on this project');
    assert.equal((await patch({ platforms: ['facebook', 'instagram'] })).body.details.code, 'PLATFORM_NOT_CONNECTED');
    assert.equal((await patch({ date: addDays(90) })).status, 422);
    assert.equal((await patch({ contentPillar: 'Not a pillar' })).status, 400);
    assert.equal((await call('PATCH', `${CAL}/items/not-an-id`, { body: { projectId: pidA(), expectedRevision: 0, topic: 'x' } })).status, 404);
    assert.equal((await call('PATCH', `${CAL}/items/${id}`, { body: [] })).status, 400, 'a body that is not an object (no projectId either)');
    assert.equal((await firstItem()).topic, 'Edited over HTTP', 'nothing changed through any of those');
  });

  test('8: approve the plan -> 200 plan_approved; the AI routes then follow: content only after approval, 202 with the existing generator, draft linked back', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const item = await firstItem();
    const id = String(item._id);
    const before = await call('POST', `${CAL}/items/${id}/generate-content`, { body: { projectId: pidA(), platform: 'facebook' } });
    assert.equal(before.status, 409);
    assert.equal(before.body.details.code, 'PLAN_NOT_APPROVED');

    const approve = await call('POST', `${CAL}/items/${id}/approve`, { body: { projectId: pidA(), expectedRevision: item.revision } });
    assert.equal(approve.status, 200, JSON.stringify(approve.body));
    assert.equal(approve.body.data.item.status, 'plan_approved');
    assert.equal(await SocialPublication.countDocuments({ project_id: projectA._id }), 0, 'approving the plan creates no publication');

    setContentProviderOverride(mockContentProvider({ behavior: ({ user }) => validRawPost({ platform: 'facebook', contentPillar: /content_pillar: (.*)/.exec(user)[1].trim() }) }));
    const started = await call('POST', `${CAL}/items/${id}/generate-content`, { body: { projectId: pidA(), platform: 'facebook', mode: 'ai' } });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    assert.equal(started.body.data.status, 'generating');
    assert.equal(started.body.data.generation.calendarItemId, id);
    const linked = await waitFor(async () => { const d = await SocialContentCalendarItem.findById(id).lean(); return d.publicationIds.length ? d : null; });
    assert.equal(linked.status, 'content_generated');
    const status = await call('GET', `/api/social/ai-content/status?${q(pidA())}`);
    assert.equal(status.body.data.status, 'ready');
    assert.equal(status.body.data.generation.calendarItemId, id);
    const list = await call('GET', `${CAL}?${q(pidA())}`);
    const api = list.body.data.items.find((i) => i.id === id);
    assert.equal(api.publications[0].platform, 'facebook');
    assert.equal(api.status, 'content_generated');

    const again = await call('POST', `${CAL}/items/${id}/generate-content`, { body: { projectId: pidA(), platform: 'facebook', mode: 'ai' } });
    assert.equal(again.status, 409);
    assert.equal(again.body.details.code, 'ALREADY_GENERATED');
  });

  test('8b: generate-content in plan mode answers 201 with the draft built from the reviewed caption (no AI), needs the revision, and a stranger gets nothing', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const provider = mockContentProvider({ behavior: () => { throw new Error('the AI must not be called in plan mode'); } });
    setContentProviderOverride(provider);
    const item = await SocialContentCalendarItem.findOne({ project_id: projectA._id, status: { $in: ['planned', 'edited'] } }).sort({ contentDate: 1 }).lean();
    const id = String(item._id);
    const edit = await call('PATCH', `${CAL}/items/${id}`, { body: { projectId: pidA(), expectedRevision: item.revision, caption: 'The exact words the owner reviewed.', hashtags: ['#Reviewed'] } });
    assert.equal(edit.status, 200, JSON.stringify(edit.body));
    const approve = await call('POST', `${CAL}/items/${id}/approve`, { body: { projectId: pidA(), expectedRevision: edit.body.data.item.revision } });
    assert.equal(approve.status, 200, JSON.stringify(approve.body));
    const rev = approve.body.data.item.revision;

    assert.equal((await call('POST', `${CAL}/items/${id}/generate-content`, { body: { projectId: pidA(), platform: 'facebook', mode: 'plan' } })).status, 400, 'the revision is required');
    const stranger = await call('POST', `${CAL}/items/${id}/generate-content`, { token: tokenB, body: { projectId: pidA(), platform: 'facebook', mode: 'plan', expectedRevision: rev } });
    assert.ok([403, 404].includes(stranger.status), String(stranger.status));
    assert.equal(await SocialPublication.countDocuments({ project_id: projectA._id }), 1, 'only the draft of test 8 exists so far');

    const res = await call('POST', `${CAL}/items/${id}/generate-content`, { body: { projectId: pidA(), platform: 'facebook', mode: 'plan', expectedRevision: rev } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.mode, 'plan');
    assert.equal(res.body.data.publication.content, 'The exact words the owner reviewed.\n\n#Reviewed');
    assert.equal(res.body.data.publication.generation.source, 'calendar_plan');
    assert.equal(res.body.data.publication.status, 'draft');
    assert.equal(res.body.data.item.status, 'content_generated');
    assert.equal(provider.calls.length, 0);
    const json = JSON.stringify(res.body);
    for (const leak of ['FB-SECRET-TOKEN', 'accessToken', 'profileSnapshotHash']) assert.equal(json.includes(leak), false, leak);

    const again = await call('POST', `${CAL}/items/${id}/generate-content`, { body: { projectId: pidA(), platform: 'facebook', mode: 'plan', expectedRevision: res.body.data.item.revision } });
    assert.equal(again.status, 409);
    assert.equal(again.body.details.code, 'ALREADY_GENERATED');
  });

  test('9: POST /items adds a manual item (201) that appears in the calendar; bad input is refused', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const body = { projectId: pidA(), date: addDays(6), platforms: ['facebook'], format: 'text_post', contentPillar: 'Offers', objective: 'awareness', primaryKpi: 'reach', topic: 'A manual post over HTTP' };
    const res = await call('POST', `${CAL}/items`, { body });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.item.isManual, true);
    const list = await call('GET', `${CAL}?${q(pidA())}`);
    assert.ok(list.body.data.items.some((i) => i.topic === 'A manual post over HTTP'));
    assert.equal((await call('POST', `${CAL}/items`, { body: { ...body, topic: '' } })).status, 400);
    assert.equal((await call('POST', `${CAL}/items`, { body: { ...body, platforms: ['instagram'] } })).status, 422);
    assert.equal((await call('POST', `${CAL}/items`, { body: { ...body, project_id: String(projectB._id) } })).status, 400, 'a project id in the body is an unknown field, never a target');
  });

  test('10: regeneration over HTTP: edited fields are protected (409 with the list), AI failure maps to a safe error', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const list = await call('GET', `${CAL}?${q(pidA())}`);
    const target = list.body.data.items.find((i) => i.topic === 'A manual post over HTTP');
    await call('PATCH', `${CAL}/items/${target.id}`, { body: { projectId: pidA(), expectedRevision: target.revision, topic: 'Hand-written topic' } });
    const edited = (await call('GET', `${CAL}/items/${target.id}?${q(pidA())}`)).body.data.item;
    setCalendarProviderOverride(mockCalendarProvider({ behavior: ({ slots }) => ({ items: slots.map((s) => validRawCalendarItem(s, { topic: 'AI topic', hookRef: 1 })) }) }));
    const refused = await call('POST', `${CAL}/items/${target.id}/regenerate`, { body: { projectId: pidA(), expectedRevision: edited.revision } });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.details.code, 'EDITED_FIELDS');
    assert.deepEqual(refused.body.details.editedFields, ['topic']);
    const allowed = await call('POST', `${CAL}/items/${target.id}/regenerate`, { body: { projectId: pidA(), expectedRevision: edited.revision, overwriteEdited: true, fields: ['topic'] } });
    assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
    assert.equal(allowed.body.data.item.topic, 'AI topic');
    setCalendarProviderOverride(mockCalendarProvider({ available: false }));
    const down = await call('POST', `${CAL}/items/${target.id}/regenerate`, { body: { projectId: pidA(), expectedRevision: allowed.body.data.item.revision } });
    assert.equal(down.status, 503);
    assert.equal(JSON.stringify(down.body).includes('SECRET'), false);
  });

  test('10b: regenerating an approved plan over HTTP states the approval outcome (withdrawn, re-approval needed), and the old revision can never bring the approval back', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const list = await call('GET', `${CAL}?${q(pidA())}`);
    const target = list.body.data.items.filter((i) => i.status === 'planned' && i.topic !== 'A manual post over HTTP').pop();
    assert.ok(target, 'a planned item to work with');
    const approve = await call('POST', `${CAL}/items/${target.id}/approve`, { body: { projectId: pidA(), expectedRevision: target.revision } });
    assert.equal(approve.status, 200, JSON.stringify(approve.body));
    assert.equal(approve.body.data.item.status, 'plan_approved');
    const approved = approve.body.data.item;

    setCalendarProviderOverride(mockCalendarProvider({ behavior: ({ slots }) => ({ items: slots.map((s) => validRawCalendarItem(s, { caption: 'A brand new caption from the AI over HTTP.' })) }) }));
    const regen = await call('POST', `${CAL}/items/${target.id}/regenerate`, { body: { projectId: pidA(), expectedRevision: approved.revision, fields: ['caption'] } });
    assert.equal(regen.status, 200, JSON.stringify(regen.body));
    const { data } = regen.body;
    assert.deepEqual([data.approvalStatus, data.approvalRevoked, data.requiresReapproval, data.contentLinked], ['not_approved', true, true, false]);
    assert.equal(data.item.status, 'planned');
    assert.equal(data.item.caption, 'A brand new caption from the AI over HTTP.');

    const replay = await call('POST', `${CAL}/items/${target.id}/approve`, { body: { projectId: pidA(), expectedRevision: approved.revision } });
    assert.equal(replay.status, 409);
    assert.equal(replay.body.details.code, 'ITEM_CONFLICT');
    assert.equal(replay.body.details.item.status, 'planned', 'the conflict shows the current, not-approved item');
  });

  test('11: the two AI routes are rate limited per user (429 + Retry-After + RATE_LIMITED), the edit routes are not', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    process.env.SOCIAL_AI_CALENDAR_ITEM_RATE_LIMIT_ENABLED = 'true';
    try {
      const user = await User.create({ firstName: 'Lim', lastName: 'It', email: `calendar-limit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`, password: 'password123', roleId: 5, isActive: true, isEmailVerified: true });
      extraUsers.push(user);
      const project = await SeoProject.create({ user_id: user._id, project_name: `Limit ${Date.now()}`, main_url: 'https://example.com', seo_scope: 'local', keywords: ['k'], description: 'x', industry: 'y' });
      extraProjects.push(project);
      const token = signAuthToken(user);
      const fake = String(new mongoose.Types.ObjectId());
      const statuses = [];
      for (let i = 0; i < CONTENT_RATE_LIMIT.max + 2; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        statuses.push((await call('POST', `${CAL}/items/${fake}/regenerate`, { token, body: { projectId: String(project._id), expectedRevision: 0 } })).status);
      }
      assert.ok(statuses.slice(0, CONTENT_RATE_LIMIT.max).every((s) => s === 404), 'within budget the call reaches the handler');
      assert.equal(statuses.at(-1), 429);
      const limited = await call('POST', `${CAL}/items/${fake}/generate-content`, { token, body: { projectId: String(project._id), platform: 'facebook' } });
      assert.equal(limited.status, 429, 'the budget is shared by both AI item routes');
      assert.equal(limited.body.details.code, 'RATE_LIMITED');
      assert.equal((await call('PATCH', `${CAL}/items/${fake}`, { token, body: { projectId: String(project._id), expectedRevision: 0, topic: 'x' } })).status, 404, 'plain edits are not limited');
    } finally {
      process.env.SOCIAL_AI_CALENDAR_ITEM_RATE_LIMIT_ENABLED = 'false';
    }
  });
});
