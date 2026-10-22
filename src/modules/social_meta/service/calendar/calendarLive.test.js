import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SeoProject from '../../../app_user/model/SeoProject.js';
import SocialAccount from '../../model/SocialAccount.js';
import SocialAIStrategy from '../../model/SocialAIStrategy.js';
import SocialBusinessProfile from '../../model/SocialBusinessProfile.js';
import SocialProduct from '../../model/SocialProduct.js';
import SocialPublication from '../../model/SocialPublication.js';
import SocialContentCalendar from '../../model/SocialContentCalendar.js';
import SocialContentCalendarItem from '../../model/SocialContentCalendarItem.js';
import { updateProfile } from '../socialBusinessProfileService.js';
import productService from '../socialProductService.js';
import { startGeneration as startStrategy, setProviderOverride as setStrategyProvider, resetProviderOverride as resetStrategyProvider } from '../aiStrategy/socialAIStrategyService.js';
import {
  startCalendarGeneration, runCalendarGeneration, getCalendarState, getCalendarGenerationStatus, recoverStaleCalendarGenerations, planSlots, seedForCalendar,
  setCalendarProviderOverride, resetCalendarProviderOverride, CALENDAR_FAILURE_MESSAGES,
} from './socialContentCalendarService.js';
import { validateSlotPlan, splitWeeks, parseDate, periodEndDate, previewCalendarPlan } from './calendarPlanner.js';
import { CALENDAR_BATCH_SIZE, CALENDAR_LEASE_MS } from './calendarConfig.js';
import { validRawStrategy, mockProvider, mockCalendarProvider, validRawCalendarItem } from '../../testSupport/aiStrategyFixtures.js';

/**
 * Real MongoDB, scripted AI providers. The strategy is generated through the real strategy service (so its snapshot,
 * hash and version are real); the calendar is then planned from it. Proves the calendar is pinned to its strategy,
 * built from the server's own structure, unique per project at any moment, versioned rather than overwritten, and
 * that nothing is published, written as a caption or leaked.
 */

let mongoAvailable = false;
before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
    await Promise.all([SocialContentCalendar.init(), SocialContentCalendarItem.init(), SocialAIStrategy.init(), SocialProduct.init()]);
  } catch { mongoAvailable = false; }
});
after(async () => {
  resetCalendarProviderOverride();
  resetStrategyProvider();
  if (mongoAvailable) await mongoose.connection.close();
});

const clone = (o) => JSON.parse(JSON.stringify(o));
const addDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const waitFor = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error('waitFor timed out');
};

describe('Content Calendar generation (real MongoDB, scripted providers)', () => {
  let userId; let project; let pid; let created; let realFetch; let fetchCalls;
  const track = (d) => { created.push(d); return d; };

  const request = (over = {}) => ({ startDate: addDays(1), endDate: addDays(7), postsPerWeek: 3, platforms: ['facebook', 'instagram'], distributionMode: 'balanced', ...over });
  const generate = (provider, over = {}, id = pid, uid = userId) => {
    setCalendarProviderOverride(provider);
    return startCalendarGeneration(id, uid, request(over), { background: false });
  };
  const items = (calendarId) => SocialContentCalendarItem.find({ calendar_id: calendarId }).sort({ order: 1 }).lean();
  const current = async (id = pid) => (await getCalendarState(id));

  async function seedAccounts(projectId = project._id, owner = userId, { facebook = true, instagram = true } = {}) {
    const pageId = `pg_${Math.random().toString(36).slice(2, 8)}`;
    if (facebook) track(await SocialAccount.create({ user_id: owner, project_id: projectId, platform: 'facebook', platformAccountId: pageId, platformAccountName: 'Page', accountType: 'page', pageId, accessToken: 'FB-SECRET-TOKEN', status: 'active', isActive: true }));
    if (instagram) track(await SocialAccount.create({ user_id: owner, project_id: projectId, platform: 'instagram', platformAccountId: `ig_${pageId}`, platformAccountName: 'IG', accountType: 'business', pageId, accessToken: 'IG-SECRET-TOKEN', status: 'active' }));
  }

  /** A real, ready strategy made by the real strategy service (profile + a scripted strategy). */
  async function seedStrategy(id = pid, uid = userId, strategyOverrides = {}) {
    setStrategyProvider(mockProvider({ behavior: () => validRawStrategy(strategyOverrides) }));
    const r = await startStrategy(id, uid, { background: false });
    resetStrategyProvider();
    assert.equal(r.generation.status, 'ready', JSON.stringify(r));
    return SocialAIStrategy.findOne({ project_id: id, status: 'ready' }).sort({ version: -1 }).lean();
  }

  beforeEach(async () => {
    if (!mongoAvailable) return;
    created = [];
    userId = new mongoose.Types.ObjectId();
    project = track(await SeoProject.create({ user_id: userId, project_name: `Calendar ${Date.now()} ${Math.random().toString(36).slice(2, 8)}`, main_url: 'https://example.com', seo_scope: 'local', keywords: ['k'], description: 'Family dental practice', industry: 'Dentist' }));
    pid = project._id.toString();
    await updateProfile(pid, userId, { audience: { primary: 'Young families' }, goals: ['More bookings'], toneOfVoice: { primary: 'Warm' }, prohibitedPhrases: ['cheapest'] });
    await seedAccounts();
    fetchCalls = [];
    realFetch = globalThis.fetch;
    globalThis.fetch = async (...a) => { fetchCalls.push(String(a[0])); throw new Error('network is not available in this test'); };
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    resetCalendarProviderOverride();
    resetStrategyProvider();
    if (!mongoAvailable) return;
    const ids = created.map((d) => d.project_id || d._id);
    await Promise.all([
      SocialContentCalendarItem.deleteMany({ project_id: { $in: ids } }), SocialContentCalendar.deleteMany({ project_id: { $in: ids } }),
      SocialAIStrategy.deleteMany({ project_id: { $in: ids } }), SocialBusinessProfile.deleteMany({ project_id: { $in: ids } }),
      SocialProduct.deleteMany({ project_id: { $in: ids } }), SocialPublication.deleteMany({ project_id: { $in: ids } }),
      SocialAccount.deleteMany({ _id: { $in: created.map((d) => d._id) } }),
    ]);
    await SeoProject.deleteMany({ _id: { $in: created.map((d) => d._id) } });
  });

  // ── prerequisites ────────────────────────────────────────────────────────
  test('1: no strategy -> NO_STRATEGY, and nothing is created or called', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const provider = mockCalendarProvider();
    const r = await generate(provider);
    assert.equal(r.success, false);
    assert.equal(r.error.code, 'NO_STRATEGY');
    assert.equal(await SocialContentCalendar.countDocuments({ project_id: project._id }), 0);
    assert.equal(provider.calls.length, 0);
  });

  test('2: the request is validated before anything happens (posts per week, platforms, dates, mode, unknown fields)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy();
    const provider = mockCalendarProvider();
    for (const [over, code] of [
      [{ postsPerWeek: 0 }, 'INVALID_POSTS_PER_WEEK'], [{ postsPerWeek: 9 }, 'INVALID_POSTS_PER_WEEK'], [{ postsPerWeek: '3' }, 'INVALID_POSTS_PER_WEEK'],
      [{ platforms: [] }, 'INVALID_PLATFORMS'], [{ platforms: ['tiktok'] }, 'INVALID_PLATFORMS'],
      [{ startDate: '2020-01-01', endDate: '2020-01-31' }, 'DATE_IN_PAST'], [{ startDate: addDays(5), endDate: addDays(2) }, 'INVALID_DATE_RANGE'], [{ startDate: 'soon' }, 'INVALID_DATE'],
      [{ startDate: addDays(1), endDate: addDays(200) }, 'INVALID_DATE_RANGE'], [{ distributionMode: 'chaos' }, 'INVALID_DISTRIBUTION'],
      [{ months: 0 }, 'INVALID_DURATION'], [{ months: 7 }, 'INVALID_DURATION'], [{ months: '3' }, 'INVALID_DURATION'], [{ months: 2.5 }, 'INVALID_DURATION'],
      [{ startDate: addDays(1), months: 2, endDate: addDays(20) }, 'INVALID_DATE_RANGE'],
      [{ strategy: { contentPillars: [] } }, 'UNKNOWN_FIELD'], [{ strategyId: String(new mongoose.Types.ObjectId()) }, 'UNKNOWN_FIELD'],
    ]) {
      setCalendarProviderOverride(provider);
      const r = await startCalendarGeneration(pid, userId, { ...request(), ...over }, { background: false });
      assert.equal(r.error?.code, code, JSON.stringify(over));
    }
    assert.equal(provider.calls.length, 0);
    assert.equal(await SocialContentCalendar.countDocuments({ project_id: project._id }), 0);
  });

  test('3: a platform that is not connected is rejected (decided from the database), and so is one the strategy does not cover', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialAccount.updateMany({ project_id: project._id, platform: 'instagram' }, { $set: { status: 'revoked', isActive: false } });
    await seedStrategy();
    const provider = mockCalendarProvider();
    let r = await generate(provider, { platforms: ['facebook', 'instagram'] });
    assert.equal(r.error.code, 'PLATFORM_NOT_CONNECTED');
    assert.deepEqual(r.error.platforms, ['instagram']);
    assert.match(r.error.message, /Instagram account/);
    assert.equal((await generate(provider, { platforms: ['facebook'] })).success, true, 'the connected platform alone is fine');

    // a strategy that does not cover Instagram
    await SocialAccount.updateMany({ project_id: project._id, platform: 'instagram' }, { $set: { status: 'active', isActive: true } });
    await SocialContentCalendar.deleteMany({ project_id: project._id });
    await SocialAIStrategy.deleteMany({ project_id: project._id });
    await seedStrategy(pid, userId, { platformStrategy: [validRawStrategy().platformStrategy[0]] });
    r = await generate(provider, { platforms: ['facebook', 'instagram'] });
    assert.equal(r.error.code, 'PLATFORM_NOT_IN_STRATEGY');
  });

  test('4: a business that can no longer be described is refused (INSUFFICIENT_PROFILE)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy();
    await SeoProject.updateOne({ _id: project._id }, { $set: { description: '', industry: '' } });
    const r = await generate(mockCalendarProvider());
    assert.equal(r.error.code, 'INSUFFICIENT_PROFILE');
    assert.equal(await SocialContentCalendar.countDocuments({ project_id: project._id }), 0);
  });

  test('5: AI not configured -> AI_UNAVAILABLE before anything is claimed', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy();
    const r = await generate(mockCalendarProvider({ available: false }));
    assert.equal(r.error.code, 'AI_UNAVAILABLE');
    assert.equal(await SocialContentCalendar.countDocuments({ project_id: project._id }), 0);
  });

  // ── a real calendar ──────────────────────────────────────────────────────
  test('6: generates a calendar of planned items pinned to the strategy version and profile hash, from exactly the slots the server fixed', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const strategy = await seedStrategy();
    const provider = mockCalendarProvider();
    const r = await generate(provider, { startDate: addDays(1), endDate: addDays(30), postsPerWeek: 4 });
    assert.equal(r.generation.status, 'ready', JSON.stringify(r));

    const state = await current();
    assert.equal(state.status, 'ready');
    assert.equal(state.calendar.version, 1);
    assert.deepEqual(state.calendar.strategy, { id: String(strategy._id), version: strategy.version });
    const cal = await SocialContentCalendar.findById(state.calendar.id).lean();
    assert.equal(cal.strategy.profileSnapshotHash, strategy.profileSnapshot.hash, 'pinned to the exact profile snapshot');

    const expected = planSlots(cal.config, strategy.strategy, seedForCalendar(cal)).slots;
    assert.equal(state.items.length, expected.length);
    assert.ok(state.items.length >= 16 && state.items.length <= 18, `${state.items.length} items for 4 a week over 30 days`);
    assert.deepEqual(state.items.map((i) => i.date), expected.map((s) => s.date), 'the server chose the dates');
    assert.deepEqual(state.items.map((i) => i.contentPillar), expected.map((s) => s.pillar), 'the server chose the pillars');
    assert.ok(state.items.every((i) => i.status === 'planned' && i.strategyVersion === strategy.version && i.publicationIds.length === 0));
    assert.equal(provider.calls.length, Math.ceil(expected.length / CALENDAR_BATCH_SIZE), 'planned in batches, not one giant prompt');
    assert.ok(provider.calls.every((c) => c.slots.length <= CALENDAR_BATCH_SIZE));
    assert.equal(state.calendar.plan.totalItems, expected.length);
  });

  test('7: items are PLANNING metadata only — no caption, no design, no media — and nothing is published, scheduled or sent anywhere', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy();
    await generate(mockCalendarProvider());
    const docs = await SocialContentCalendarItem.find({ project_id: project._id }).lean();
    assert.ok(docs.length > 0);
    for (const key of ['content', 'media', 'imageUrl', 'designUrl', 'scheduledAt']) assert.equal(key in docs[0], false, key);
    // every post arrives fully written by the plan (nothing left blank), and untouched by any person
    for (const doc of docs) {
      assert.ok(doc.caption.length > 20, 'a real caption');
      assert.doesNotMatch(doc.caption, /#\w/, 'no hashtags inside the caption');
      assert.ok(doc.hashtags.length > 0 && doc.hashtags.every((t) => /^#\S+$/.test(t)), 'hashtags');
      assert.equal(doc.platformContent.length, doc.platforms.length > 1 ? doc.platforms.length : 0, 'an adapted version per platform only when the post targets both');
      assert.deepEqual(doc.editedFields, []);
      assert.equal(doc.isManual, false);
    }
    assert.equal(await SocialPublication.countDocuments({ project_id: project._id }), 0, 'no publication was created');
    assert.deepEqual(fetchCalls, [], 'no network call of any kind');
  });

  test('8: the pillar mix over the period follows the strategy percentages, is documented on the calendar, and matches the items', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy();
    await generate(mockCalendarProvider(), { startDate: addDays(1), endDate: addDays(30), postsPerWeek: 5 });
    const state = await current();
    const dist = state.calendar.plan.pillarDistribution;
    assert.deepEqual(dist.map((d) => [d.pillar, d.targetPercent]), [['Dental tips', 50], ['Meet the team', 30], ['Offers', 20]]);
    assert.equal(dist.reduce((s, d) => s + d.plannedCount, 0), state.items.length);
    for (const d of dist) {
      assert.equal(d.plannedCount, state.items.filter((i) => i.contentPillar === d.pillar).length, `${d.pillar} documented count is real`);
      assert.ok(Math.abs(d.plannedPercent - d.targetPercent) <= (100 / state.items.length) + 0.1, `${d.pillar} within one post of its target`);
    }
  });

  test('9: frequency is TOTAL posts: 3 a week with two platforms is 3 items a week, each on ONE platform in balanced mode — never 6', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy();
    await generate(mockCalendarProvider(), { startDate: addDays(1), endDate: addDays(7), postsPerWeek: 3, platforms: ['facebook', 'instagram'], distributionMode: 'balanced' });
    const state = await current();
    assert.equal(state.items.length, 3);
    assert.ok(state.items.every((i) => i.platforms.length === 1));
    assert.deepEqual(state.calendar.plan.platformCounts.facebook + state.calendar.plan.platformCounts.instagram, 3);
    assert.deepEqual(new Set(state.items.map((i) => i.platforms[0])), new Set(['facebook', 'instagram']));
  });

  test('10: ai_optimized lets the model put an item on both platforms — still ONE item, counted once', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy();
    const provider = mockCalendarProvider({ behavior: ({ slots }) => ({ items: slots.map((s) => validRawCalendarItem(s, { platforms: s.index === 0 ? ['facebook', 'instagram'] : ['instagram'] })) }) });
    await generate(provider, { postsPerWeek: 3, distributionMode: 'ai_optimized' });
    const state = await current();
    assert.equal(state.items.length, 3);
    assert.deepEqual(state.items[0].platforms, ['facebook', 'instagram']);
    assert.deepEqual(state.calendar.plan.platformCounts, { facebook: 1, instagram: 3 });
  });

  test('11: a single selected platform plans only for it', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy();
    await generate(mockCalendarProvider(), { platforms: ['instagram'] });
    assert.ok((await current()).items.every((i) => i.platforms.length === 1 && i.platforms[0] === 'instagram'));
  });

  // ── validation inside the run ────────────────────────────────────────────
  test('12: a bad first answer gets exactly ONE repair with Odito\'s own messages; the repaired plan is saved', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy();
    const provider = mockCalendarProvider({
      behavior: ({ slots, callNumber }) => ({ items: slots.map((s) => validRawCalendarItem(s, callNumber === 1 ? { primaryKpi: 'happiness' } : {})) }),
    });
    const r = await generate(provider, { postsPerWeek: 2 });
    assert.equal(r.generation.status, 'ready');
    assert.equal(provider.calls.length, 2);
    assert.match(provider.calls[1].user, /<previous_attempt_feedback>[\s\S]*primaryKpi: must be one of/);
    assert.ok((await current()).items.every((i) => i.objective === 'engagement'));
  });

  test('13: output that stays invalid fails the attempt with a safe message, saves NO items, and stops after the one repair', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy();
    const provider = mockCalendarProvider({ behavior: () => 'not json at all' });
    const r = await generate(provider, { postsPerWeek: 2 });
    assert.equal(r.generation.status, 'failed');
    assert.equal(r.generation.failure.code, 'AI_BAD_OUTPUT');
    assert.equal(r.generation.failure.message, CALENDAR_FAILURE_MESSAGES.AI_BAD_OUTPUT);
    assert.equal(provider.calls.length, 2, 'initial + one repair');
    assert.equal(await SocialContentCalendarItem.countDocuments({ project_id: project._id }), 0, 'no partial or placeholder items');
    const state = await current();
    assert.equal(state.status, 'failed');
    assert.equal(state.calendar, null);
    assert.equal(JSON.stringify(state).includes('not json at all'), false);
  });

  test("14: a failure in a LATER batch keeps the earlier, validated batches: the calendar is PARTIAL (not ready, not discarded) and says how far it got", async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy();
    const provider = mockCalendarProvider({ behavior: ({ slots, callNumber }) => (callNumber >= 2 ? { items: [] } : { items: slots.map((s) => validRawCalendarItem(s)) }) });
    const r = await generate(provider, { startDate: addDays(1), endDate: addDays(30), postsPerWeek: 5 });
    assert.ok(provider.calls.length >= 3, 'the second batch (and its repair) ran');
    assert.equal(r.generation.status, 'partial');
    assert.equal(r.generation.canResume, true);
    assert.equal(r.generation.failure.code, 'AI_BAD_OUTPUT', 'a permanent (validation) failure is not retried automatically');
    assert.equal(provider.calls.length, 3, 'batch 1, batch 2 and its single repair - nothing more');
    const saved = await SocialContentCalendarItem.countDocuments({ project_id: project._id });
    assert.equal(saved, CALENDAR_BATCH_SIZE, 'the first batch is kept');
    assert.equal(r.generation.progress.plannedPosts, CALENDAR_BATCH_SIZE);
    assert.ok(r.generation.progress.totalPosts > saved);
    // honest: it is not presented as a finished calendar
    const state = await current();
    assert.equal(state.status, 'partial');
    assert.equal(state.calendar, null, 'no READY calendar exists');
    assert.equal(state.partial.items.length, CALENDAR_BATCH_SIZE);
    assert.equal(state.partial.calendar.status, 'partial');
  });

  test("15: a transient provider error (busy) is retried automatically later and never leaks the provider's own text; a permanent one stops", async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy();
    const boom = mockCalendarProvider({ behavior: () => { const e = new Error('upstream said: sk-secret-key leaked'); e.code = 'CLAUDE_RATE_LIMITED'; throw e; } });
    const r = await generate(boom, { postsPerWeek: 2 });
    assert.equal(r.generation.status, 'generating', 'waiting to retry, not failed');
    assert.equal(r.generation.retry.code, 'AI_BUSY');
    assert.ok(new Date(r.generation.retry.at) > new Date(), 'it says when it will try again');
    assert.equal(JSON.stringify(r).includes('sk-secret'), false);
    assert.equal(JSON.stringify(await SocialContentCalendar.find({ project_id: project._id }).lean()).includes('sk-secret'), false);

    await SocialContentCalendar.deleteMany({ project_id: project._id });
    const down = mockCalendarProvider({ behavior: () => { const e = new Error('invalid x-api-key sk-secret-key'); e.code = 'CLAUDE_AUTH'; throw e; } });
    const r2 = await generate(down, { postsPerWeek: 2 });
    assert.equal(r2.generation.status, 'failed');
    assert.equal(r2.generation.failure.code, 'AI_UNAVAILABLE');
    assert.equal(down.calls.length, 1, 'a permanent failure is not retried');
    assert.equal(JSON.stringify(r2).includes('sk-secret'), false);
  });

  test('16: honesty rules are enforced inside the run: a "trending" claim, an invented price and a banned phrase each trigger the repair', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy();
    for (const [field, bad, pattern] of [['angle', 'Everyone is talking about this', /trending or viral/], ['contentBrief', 'Mention our £5 deal', /figures or addresses/], ['captionDirection', 'Stress that we are the cheapest', /prohibited phrase/]]) {
      await SocialContentCalendar.deleteMany({ project_id: project._id });
      const provider = mockCalendarProvider({ behavior: ({ slots, callNumber }) => ({ items: slots.map((s) => validRawCalendarItem(s, callNumber === 1 ? { [field]: bad } : {})) }) });
      const r = await generate(provider, { postsPerWeek: 1 });
      assert.equal(r.generation.status, 'ready', field);
      assert.match(provider.calls[1].user, pattern, field);
      assert.equal(JSON.stringify((await current()).items).includes(bad), false, `${field}: the bad text was not saved`);
    }
  });

  // ── services and products ────────────────────────────────────────────────
  test('17: PRODUCT business: items reference real active products, carry the product name and the product-image asset; nothing is invented', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await updateProfile(pid, userId, { businessModel: 'product' });
    const a = (await productService.createProduct(pid, userId, { name: 'Premium Face Serum', price: 999, currency: 'INR', description: 'Vitamin C serum' })).product;
    const b = (await productService.createProduct(pid, userId, { name: 'Night Cream' })).product;
    await seedStrategy();
    const ids = [a.id, b.id];
    const provider = mockCalendarProvider({ behavior: ({ slots }) => ({ items: slots.map((s) => validRawCalendarItem(s, { productId: ids[s.index % 2], contentBrief: 'Feature the serum at ₹999' })) }) });
    const r = await generate(provider, { postsPerWeek: 4, startDate: addDays(1), endDate: addDays(7) });
    assert.equal(r.generation.status, 'ready', JSON.stringify(r));
    const state = await current();
    assert.ok(state.items.every((i) => ids.includes(i.productId) && i.productName && i.serviceId === null));
    assert.deepEqual(state.items.map((i) => i.productName), state.items.map((_, k) => (k % 2 === 0 ? 'Premium Face Serum' : 'Night Cream')));
    assert.ok(state.items.every((i) => i.requiredAssets.includes('product_image') && i.requiresReview));
    assert.match(provider.calls[0].user, new RegExp(`product_1: id ${a.id} \\| Premium Face Serum`));
    assert.match(provider.calls[0].user, /price: ₹999/);
  });

  test('18: an invented product id is refused (and repaired), and a product the business has since DELETED can no longer be referenced', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await updateProfile(pid, userId, { businessModel: 'product' });
    const a = (await productService.createProduct(pid, userId, { name: 'Serum' })).product;
    const b = (await productService.createProduct(pid, userId, { name: 'Cream' })).product;
    await seedStrategy();
    const fake = String(new mongoose.Types.ObjectId());
    const bogus = mockCalendarProvider({ behavior: ({ slots, callNumber }) => ({ items: slots.map((s) => validRawCalendarItem(s, { productId: callNumber === 1 ? fake : a.id })) }) });
    await generate(bogus, { postsPerWeek: 1 });
    assert.match(bogus.calls[1].user, /not one of the supplied products/);
    assert.equal((await current()).items[0].productId, a.id);

    await productService.deleteProduct(pid, b.id);
    await SocialContentCalendar.deleteMany({ project_id: project._id });
    const stale = mockCalendarProvider({ behavior: ({ slots }) => ({ items: slots.map((s) => validRawCalendarItem(s, { productId: b.id })) }) });
    const r = await generate(stale, { postsPerWeek: 1 });
    assert.equal(r.generation.status, 'failed', 'the deleted product is not in the planner\'s catalog, so the reference is invalid');
    assert.doesNotMatch(stale.calls[0].user, new RegExp(b.id));
  });

  test('19: SERVICE business: items reference the business\'s services; a product reference is refused', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await updateProfile(pid, userId, { businessModel: 'service', services: [{ name: 'Teeth Whitening', benefits: ['Brighter smile'] }, { name: 'Check-up' }] });
    const svcs = (await SocialBusinessProfile.findOne({ project_id: project._id }).lean()).services.map((s) => String(s._id));
    await seedStrategy();
    const ok = mockCalendarProvider({ behavior: ({ slots }) => ({ items: slots.map((s) => validRawCalendarItem(s, { serviceId: svcs[s.index % 2] })) }) });
    const r = await generate(ok, { postsPerWeek: 3, startDate: addDays(1), endDate: addDays(7) });
    assert.equal(r.generation.status, 'ready', JSON.stringify(r));
    const state = await current();
    assert.deepEqual(state.items.map((i) => i.serviceName), ['Teeth Whitening', 'Check-up', 'Teeth Whitening']);
    assert.ok(state.items.every((i) => i.productId === null));

    await SocialContentCalendar.deleteMany({ project_id: project._id });
    const wrong = mockCalendarProvider({ behavior: ({ slots }) => ({ items: slots.map((s) => validRawCalendarItem(s, { productId: String(new mongoose.Types.ObjectId()) })) }) });
    assert.equal((await generate(wrong, { postsPerWeek: 1 })).generation.status, 'failed');
  });

  test('20: the same service on consecutive posts is cleared (brand-level content instead) and the calendar says so', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await updateProfile(pid, userId, { businessModel: 'service', services: [{ name: 'Whitening' }, { name: 'Check-up' }] });
    const svcs = (await SocialBusinessProfile.findOne({ project_id: project._id }).lean()).services.map((s) => String(s._id));
    await seedStrategy();
    const provider = mockCalendarProvider({ behavior: ({ slots }) => ({ items: slots.map((s) => validRawCalendarItem(s, { serviceId: svcs[0] })) }) });
    await generate(provider, { postsPerWeek: 3, startDate: addDays(1), endDate: addDays(7) });
    const state = await current();
    assert.deepEqual(state.items.map((i) => i.serviceId), [svcs[0], null, svcs[0]]);
    assert.equal(state.calendar.plan.warnings.filter((w) => /repeated on consecutive posts/.test(w)).length, 1);
  });

  test('21: items for regulated businesses (here a dentist) and any item with a service / product are flagged for review, with a note', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy();
    await generate(mockCalendarProvider(), { postsPerWeek: 2 });
    const state = await current();
    assert.ok(state.items.every((i) => i.requiresReview && i.approvalNotes.length > 0));
  });

  // ── concurrency, stale runs, lost locks ─────────────────────────────────
  test('22: clicking Generate several times at once runs ONE generation (database-enforced), and everyone follows it', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy();
    let open; const gate = new Promise((r) => { open = r; });
    const provider = mockCalendarProvider({ gate });
    setCalendarProviderOverride(provider);
    const results = await Promise.all(Array.from({ length: 5 }, () => startCalendarGeneration(pid, userId, request({ postsPerWeek: 2 }))));
    assert.equal(results.filter((r) => r.success && r.started).length, 1, 'exactly one started');
    assert.equal(results.filter((r) => r.success && r.alreadyRunning).length, 4, 'the rest follow it');
    assert.equal(await SocialContentCalendar.countDocuments({ project_id: project._id, status: 'generating' }), 1);
    assert.equal(await SocialContentCalendar.countDocuments({ project_id: project._id }), 1);
    assert.equal((await getCalendarGenerationStatus(pid)).status, 'generating');
    open();
    await waitFor(async () => (await getCalendarGenerationStatus(pid)).status === 'ready');
    assert.equal(await SocialContentCalendar.countDocuments({ project_id: project._id }), 1, 'still one calendar');
    assert.equal(provider.calls.length, 1, 'one planning call, not five');
  });

  test('23: a generation from before leases whose process is gone is finished as interrupted (nothing was saved), and the project can generate again', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const strategy = await seedStrategy();
    const old = new Date(Date.now() - CALENDAR_LEASE_MS - 60_000);
    await SocialContentCalendar.create({
      project_id: project._id, version: 1, status: 'generating', config: request(), strategy: { id: strategy._id, version: strategy.version, profileSnapshotHash: 'h' },
      generation: { startedAt: old, lockedBy: 'dead-process' }, // no lease: written by the code that predates it
    });
    const status = await getCalendarGenerationStatus(pid);
    assert.equal(status.status, 'failed');
    assert.equal(status.generation.failure.code, 'GENERATION_INTERRUPTED');
    const r = await generate(mockCalendarProvider(), { postsPerWeek: 2 });
    assert.equal(r.generation.status, 'ready');
    assert.equal(r.generation.version, 2);
  });

  test('24: a generation whose lease is still alive is NOT taken over (only an expired one is)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const strategy = await seedStrategy();
    await SocialContentCalendar.create({ project_id: project._id, version: 1, status: 'generating', config: request(), strategy: { id: strategy._id, version: strategy.version }, generation: { startedAt: new Date(), lockedBy: 'alive', lease: { expiresAt: new Date(Date.now() + 60_000) }, runAttempts: 1 } });
    assert.equal(await recoverStaleCalendarGenerations(pid), 0);
    assert.equal((await getCalendarGenerationStatus(pid)).status, 'generating');
    assert.equal((await SocialContentCalendar.findOne({ project_id: project._id }).lean()).generation.lockedBy, 'alive');
  });

  test('25: a run that lost its lock (recovered as interrupted while still working) publishes NOTHING', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy();
    let open; const gate = new Promise((r) => { open = r; });
    setCalendarProviderOverride(mockCalendarProvider({ gate }));
    const started = await startCalendarGeneration(pid, userId, request({ postsPerWeek: 2 }));
    assert.equal(started.started, true);
    await SocialContentCalendar.updateOne({ project_id: project._id, status: 'generating' }, { $set: { status: 'failed', 'generation.lockedBy': 'someone-else' } });
    open();
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(await SocialContentCalendarItem.countDocuments({ project_id: project._id }), 0, 'the superseded run left no items');
    assert.equal((await SocialContentCalendar.findOne({ project_id: project._id }).lean()).status, 'failed');
  });

  // ── versioning, regeneration, staleness ─────────────────────────────────
  test('26: regenerating makes a NEW version; the previous one is archived with its items intact and is no longer current', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy();
    await generate(mockCalendarProvider(), { postsPerWeek: 2 });
    const first = (await current()).calendar;
    const firstItems = await items(first.id);
    await generate(mockCalendarProvider({ behavior: ({ slots }) => ({ items: slots.map((s) => validRawCalendarItem(s, { topic: `Second calendar topic ${s.index}` })) }) }), { postsPerWeek: 3 });

    const state = await current();
    assert.equal(state.calendar.version, 2);
    assert.equal(state.items.length, 3);
    assert.ok(state.items.every((i) => i.topic.startsWith('Second calendar topic')));
    const archived = await SocialContentCalendar.findById(first.id).lean();
    assert.equal(archived.status, 'archived');
    assert.deepEqual((await items(first.id)).map((i) => i.topic), firstItems.map((i) => i.topic), 'the old calendar is preserved for audit');
    assert.equal(await SocialContentCalendar.countDocuments({ project_id: project._id, status: 'ready' }), 1, 'exactly one current calendar');
  });

  test('27: a FAILED regeneration leaves the last good calendar current and untouched', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy();
    await generate(mockCalendarProvider(), { postsPerWeek: 2 });
    const before = await current();
    const r = await generate(mockCalendarProvider({ behavior: () => ({ items: [] }) }), { postsPerWeek: 3 });
    assert.equal(r.generation.status, 'failed');
    const after = await current();
    assert.equal(after.status, 'failed', 'the failed attempt is reported');
    assert.equal(after.calendar.id, before.calendar.id, 'but the good calendar is still the current one');
    assert.deepEqual(after.items.map((i) => i.id), before.items.map((i) => i.id));
    assert.equal(after.generation.failure.code, 'AI_BAD_OUTPUT');
  });

  test('28: when the strategy or the profile changes, the calendar is NOT mutated — it is reported as planned from an older strategy', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const s1 = await seedStrategy();
    await generate(mockCalendarProvider(), { postsPerWeek: 2 });
    const before = await current();
    assert.deepEqual(before.stale, { strategyChanged: false, currentStrategyVersion: s1.version, profileChanged: false });

    await updateProfile(pid, userId, { goals: ['More bookings', 'More reviews'] });
    const afterProfile = await current();
    assert.equal(afterProfile.stale.profileChanged, true);
    assert.equal(afterProfile.stale.strategyChanged, false);
    assert.deepEqual(afterProfile.items.map((i) => i.id), before.items.map((i) => i.id), 'items untouched');

    const s2 = await seedStrategy();
    const afterStrategy = await current();
    assert.equal(afterStrategy.stale.strategyChanged, true);
    assert.equal(afterStrategy.stale.currentStrategyVersion, s2.version);
    assert.equal(afterStrategy.calendar.strategy.version, s1.version, 'still says Strategy v1');
    assert.ok(afterStrategy.items.every((i) => i.strategyVersion === s1.version));
    assert.equal(await SocialContentCalendar.countDocuments({ project_id: project._id }), 1, 'nothing was regenerated automatically');
  });

  test('29: a new calendar is pinned to the strategy that was current when it was planned', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy();
    const s2 = await seedStrategy();
    await generate(mockCalendarProvider(), { postsPerWeek: 2 });
    const state = await current();
    assert.equal(state.calendar.strategy.version, s2.version);
    assert.equal(state.stale.strategyChanged, false);
  });

  test('30: history is pruned beyond the limit, but a version that owns a real publication is never removed', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { CALENDAR_HISTORY_LIMIT } = await import('./calendarConfig.js');
    const strategy = await seedStrategy();
    const mkCal = (version, status) => SocialContentCalendar.create({ project_id: project._id, version, status, config: request(), strategy: { id: strategy._id, version: strategy.version } });
    const mkItem = (cal, extra = {}) => SocialContentCalendarItem.create({
      project_id: project._id, calendar_id: cal._id, strategyId: strategy._id, strategyVersion: strategy.version, order: 0, contentDate: addDays(1), dayOfWeek: 'monday', platforms: ['facebook'], format: 'static_post',
      contentPillar: 'p', contentType: 'educational', objective: 'engagement', primaryKpi: 'saves', topic: 'old topic', ...extra,
    });
    const total = CALENDAR_HISTORY_LIMIT + 3;
    const linkedVersion = 1;
    for (let v = 1; v <= total; v += 1) {
      const cal = await mkCal(v, 'archived');
      await mkItem(cal, v === linkedVersion ? { publicationIds: [new mongoose.Types.ObjectId()] } : {});
    }
    await generate(mockCalendarProvider(), { postsPerWeek: 2 }); // makes version total+1 ready and prunes
    const versions = (await SocialContentCalendar.find({ project_id: project._id }).select('version').lean()).map((c) => c.version);
    assert.ok(versions.includes(linkedVersion), 'the oldest version survives because one of its items became a real post');
    assert.ok(!versions.includes(2), 'an old version with no linked posts is pruned');
    assert.equal(await SocialContentCalendarItem.countDocuments({ project_id: project._id, topic: 'old topic' }), versions.filter((v) => v <= total).length, 'pruned versions take their items with them');
  });

  // ── isolation and safety ────────────────────────────────────────────────
  test('31: calendars are project-scoped: another project never sees, shares or disturbs them', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy();
    await generate(mockCalendarProvider(), { postsPerWeek: 2 });
    const other = track(await SeoProject.create({ user_id: userId, project_name: `Calendar Other ${Date.now()}`, main_url: 'https://other.example', seo_scope: 'local', keywords: ['k'], description: 'Bakery', industry: 'Bakery' }));
    await updateProfile(String(other._id), userId, { audience: { primary: 'Locals' }, goals: ['Sales'] });
    await seedAccounts(other._id, userId);
    const otherState = await getCalendarState(String(other._id));
    assert.equal(otherState.status, 'none');
    assert.deepEqual(otherState.items, []);
    assert.equal(otherState.strategy.available, false, 'it cannot plan from the first project\'s strategy');
    const refused = await generate(mockCalendarProvider(), {}, String(other._id));
    assert.equal(refused.error.code, 'NO_STRATEGY');
    assert.equal((await current()).items.length, 2, 'the first project is untouched');
    assert.equal(await getCalendarState(String(new mongoose.Types.ObjectId())), null, 'an unknown project reads as null');
  });

  test('32: nothing secret reaches the stored calendar, the read model or the prompts (no account tokens, no keys)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy();
    const provider = mockCalendarProvider();
    await generate(provider, { postsPerWeek: 3 });
    const dump = JSON.stringify([await current(), await SocialContentCalendar.find({ project_id: project._id }).lean(), await SocialContentCalendarItem.find({ project_id: project._id }).lean(), provider.calls.map((c) => c.user + c.system)]);
    for (const secret of ['FB-SECRET-TOKEN', 'IG-SECRET-TOKEN', 'accessToken', 'refresh_token', 'access_token', 'storageKey', 'sk-']) assert.equal(dump.includes(secret), false, secret);
  });

  test('33: the calendar state tells the UI what it needs: connected platforms, strategy recommendations, limits', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialAccount.updateMany({ project_id: project._id, platform: 'instagram' }, { $set: { status: 'revoked', isActive: false } });
    const none = await current();
    assert.equal(none.status, 'none');
    assert.equal(none.strategy.available, false);
    const s = await seedStrategy();
    const state = await current();
    assert.deepEqual(state.connectedPlatforms, { facebook: true, instagram: false });
    assert.deepEqual(state.strategy, { available: true, id: String(s._id), version: s.version, platforms: ['facebook', 'instagram'], hasHooks: true, planning: null, recommended: { postsPerWeek: 4, range: { min: 3, max: 5 }, days: ['tuesday', 'thursday', 'saturday'] } });
    assert.deepEqual(state.limits, { minDays: 7, maxDays: 184, minMonths: 1, maxMonths: 6, maxPostsPerWeek: 7, maxPosts: 200 });
  });

  // ── months: 1-6 month calendars ────────────────────────────────────────────
  const monthly = (months, postsPerWeek, over = {}) => ({ startDate: addDays(1), months, endDate: undefined, postsPerWeek, ...over });

  test("M1: a 3-month calendar at 3 a week: the end date is derived, the count is the server's exact quota, dates are the planner's (never the model's), and it persists", async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const strategy = await seedStrategy();
    const provider = mockCalendarProvider();
    const input = monthly(3, 3);
    const r = await generate(provider, input);
    assert.equal(r.generation.status, 'ready', JSON.stringify(r));

    const state = await current();
    const { calendar } = state;
    assert.equal(calendar.config.months, 3);
    assert.equal(calendar.config.endDate, periodEndDate(input.startDate, 3), 'derived from the start date and the months');
    const expected = previewCalendarPlan({ ...request(input), platforms: ['facebook', 'instagram'] }, { today: input.startDate });
    assert.equal(expected.error, undefined);
    assert.equal(calendar.plan.totalItems, expected.value.totalPosts, 'exactly the previewed count');
    assert.equal(state.items.length, expected.value.totalPosts);
    assert.ok(state.items.length >= 36 && state.items.length <= 40, `about 3 x 13 weeks (${state.items.length})`);

    // the dates are the deterministic plan of the stored calendar, not whatever the model said
    const doc = await SocialContentCalendar.findById(calendar.id).lean();
    const planned = planSlots(doc.config, strategy.strategy, seedForCalendar(doc)).slots.map((slot) => slot.date);
    assert.deepEqual(state.items.map((i) => i.date), planned);
    assert.equal(new Set(planned).size, planned.length, 'no date twice');
    assert.ok(planned.every((d) => d >= doc.config.startDate && d <= doc.config.endDate));
    assert.deepEqual(validateSlotPlan(planned.map((date, index) => ({ index, date })), { startDate: doc.config.startDate, endDate: doc.config.endDate, postsPerWeek: 3 }), []);

    // one AI call per batch, every item pinned to the strategy it came from
    assert.equal(provider.calls.length, Math.ceil(expected.value.totalPosts / CALENDAR_BATCH_SIZE));
    assert.ok(state.items.every((i) => i.strategyVersion === strategy.version));
    assert.equal(await SocialContentCalendarItem.countDocuments({ calendar_id: calendar.id }), expected.value.totalPosts, 'persisted');
    assert.equal(fetchCalls.length, 0, 'no real network');
  });

  test('M2: 7 a week for 6 months is a long but valid calendar: one post a day, inside the safety limit', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy();
    const provider = mockCalendarProvider();
    const r = await generate(provider, monthly(6, 7, { platforms: ['facebook'] }));
    assert.equal(r.generation.status, 'ready', JSON.stringify(r));
    const { calendar, items: list } = await current();
    const days = Math.round((parseDate(calendar.config.endDate) - parseDate(calendar.config.startDate)) / 86400000) + 1;
    assert.equal(list.length, days, 'every day of the period');
    assert.ok(list.length >= 181 && list.length <= 184);
    assert.equal(new Set(list.map((i) => i.date)).size, list.length);
  });

  test('M3: a legacy {startDate, endDate} request still produces a calendar (months stays null)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy();
    const r = await generate(mockCalendarProvider(), { endDate: addDays(14) });
    assert.equal(r.generation.status, 'ready', JSON.stringify(r));
    assert.equal((await current()).calendar.config.months, null);
  });

  test('R1: an EXPIRED connection is reported as expired (fix: Reconnect), never as "not connected"; generation names it and nothing runs', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy();
    const provider = mockCalendarProvider();
    assert.deepEqual((await current()).platformStates, { facebook: 'connected', instagram: 'connected' });
    // the Page token dies: Odito marks the Page and its Instagram account expired together (metaTokenService.markAccountExpired)
    await SocialAccount.updateMany({ project_id: project._id }, { $set: { status: 'expired', statusReason: 'META_TOKEN_INVALID' } });
    const state = await current();
    assert.deepEqual(state.platformStates, { facebook: 'expired', instagram: 'expired' });
    assert.deepEqual(state.connectedPlatforms, { facebook: false, instagram: false });
    const r = await generate(provider, { platforms: ['facebook', 'instagram'] });
    assert.equal(r.error.code, 'PLATFORM_RECONNECT_REQUIRED');
    assert.deepEqual(r.error.platforms, ['facebook', 'instagram']);
    assert.match(r.error.message, /expired or was revoked in Meta\. Reconnect them/);
    assert.equal(provider.calls.length, 0);
    assert.equal(await SocialContentCalendar.countDocuments({ project_id: project._id }), 0);
    // a project that never connected anything still says "connect"
    await SocialAccount.deleteMany({ project_id: project._id });
    assert.deepEqual((await current()).platformStates, { facebook: 'none', instagram: 'none' });
    assert.equal((await generate(provider, { platforms: ['facebook'] })).error.code, 'PLATFORM_NOT_CONNECTED');
  });

  test('R2: only the Instagram connection expired: Facebook stays usable and only Instagram asks for a reconnect', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy();
    await SocialAccount.updateMany({ project_id: project._id, platform: 'instagram' }, { $set: { status: 'expired' } });
    assert.deepEqual((await current()).platformStates, { facebook: 'connected', instagram: 'expired' });
    const r = await generate(mockCalendarProvider(), { platforms: ['facebook', 'instagram'] });
    assert.equal(r.error.code, 'PLATFORM_RECONNECT_REQUIRED');
    assert.deepEqual(r.error.platforms, ['instagram']);
    assert.equal((await generate(mockCalendarProvider(), { platforms: ['facebook'], postsPerWeek: 2 })).generation.status, 'ready');
  });

  test('34: weekdays vary from week to week (not a recurring scheduler), every week has the requested count, nothing is outside the range, and a regeneration gets a different valid plan', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy();
    const range = { postsPerWeek: 3, startDate: addDays(1), endDate: addDays(30) };
    await generate(mockCalendarProvider(), range);
    const first = (await current()).items;
    const asSlots = (list) => list.map((i, index) => ({ index, date: i.date, dayOfWeek: i.dayOfWeek }));
    assert.deepEqual(validateSlotPlan(asSlots(first), range), [], 'passes the same quality check the planner runs');
    assert.ok(first.every((i) => i.date >= range.startDate && i.date <= range.endDate), 'never outside the requested range');

    const weekdayCombos = new Set();
    for (const week of splitWeeks(parseDate(range.startDate), parseDate(range.endDate))) {
      if (week.valid.length === 7) weekdayCombos.add(first.filter((i) => { const ms = parseDate(i.date); return ms >= week.start && ms < week.start + 7 * 86400000; }).map((i) => i.dayOfWeek).join(','));
    }
    assert.ok(weekdayCombos.size >= 2, `the whole weeks do not all use the same weekdays: ${[...weekdayCombos].join(' | ')}`);

    await generate(mockCalendarProvider(), range);
    const state = await current();
    assert.equal(state.calendar.version, 2);
    assert.notDeepEqual(state.items.map((i) => i.date), first.map((i) => i.date), 'a new version is planned with a new seed');
    assert.deepEqual(validateSlotPlan(asSlots(state.items), range), []);
  });

  test('37: a post for BOTH platforms is stored with its own adapted copy per platform; a one-platform post has none; nothing is left blank', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy();
    const both = ['facebook', 'instagram'];
    const provider = mockCalendarProvider({ behavior: ({ slots }) => ({ items: slots.map((s) => validRawCalendarItem(s, s.index % 2 === 0 ? { platforms: both } : { platforms: ['instagram'] })) }) });
    const r = await generate(provider, { postsPerWeek: 4, startDate: addDays(1), endDate: addDays(7), distributionMode: 'ai_optimized' });
    assert.equal(r.generation.status, 'ready', JSON.stringify(r));
    const state = await current();
    assert.ok(state.items.length >= 2);
    for (const item of state.items) {
      assert.ok(item.caption.length > 20, 'a real caption');
      assert.ok(item.hashtags.length > 0);
      assert.ok(item.primaryCta && item.engagementPrompt && item.hook && item.creativeDirection && item.contentBrief && item.captionDirection, 'no planning field is left blank');
      if (item.platforms.length > 1) {
        assert.deepEqual(item.platformContent.map((p) => p.platform), both);
        for (const pc of item.platformContent) { assert.ok(pc.caption && pc.primaryCta && pc.hashtags.length); }
        assert.notEqual(item.platformContent[0].caption, item.platformContent[1].caption, 'each platform has its own wording');
      } else assert.deepEqual(item.platformContent, []);
      assert.deepEqual(item.editedFields, [], 'written by the plan, not by a person');
    }
    assert.match(provider.calls[0].user, /<hashtag_guidance>/);
  });

  test('38: a product post starts with the product\'s own primary image selected (a reference, not a copy); a product without images selects none', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await updateProfile(pid, userId, { businessModel: 'product' });
    const a = (await productService.createProduct(pid, userId, { name: 'Premium Face Serum' })).product;
    const b = (await productService.createProduct(pid, userId, { name: 'Night Cream' })).product;
    const primary = new mongoose.Types.ObjectId(); const second = new mongoose.Types.ObjectId();
    const image = (mediaId, n, isPrimary) => ({ mediaId, url: `https://media.odito-test.example/${n}.png`, storageKey: `${pid}/${n}.png`, mimeType: 'image/png', isPrimary });
    await SocialProduct.updateOne({ _id: a.id }, { $push: { images: { $each: [image(second, 'two', false), image(primary, 'one', true)] } } });
    await seedStrategy();
    const ids = [a.id, b.id];
    const provider = mockCalendarProvider({ behavior: ({ slots }) => ({ items: slots.map((s) => validRawCalendarItem(s, { productId: ids[s.index % 2] })) }) });
    const r = await generate(provider, { postsPerWeek: 4, startDate: addDays(1), endDate: addDays(7) });
    assert.equal(r.generation.status, 'ready', JSON.stringify(r));
    const state = await current();
    for (const item of state.items) {
      if (item.productId === a.id) assert.deepEqual(item.selectedMediaIds, [String(primary)]);
      else assert.deepEqual(item.selectedMediaIds, []);
    }
    assert.ok(state.items.some((i) => i.productId === a.id) && state.items.some((i) => i.productId === b.id));
  });

  test('39: a batch with a missing caption or hashtags is refused with a specific message and repaired once; if it stays wrong the calendar fails and nothing is saved', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy();
    const repaired = mockCalendarProvider({ behavior: ({ slots, callNumber }) => ({ items: slots.map((s) => validRawCalendarItem(s, callNumber === 1 ? { caption: '', hashtags: [] } : {})) }) });
    const r = await generate(repaired, { postsPerWeek: 3 });
    assert.equal(r.generation.status, 'ready', JSON.stringify(r));
    assert.match(repaired.calls[1].user, /must not be empty: write the complete caption/);
    assert.match(repaired.calls[1].user, /needs hashtags/);
    assert.ok((await current()).items.every((i) => i.caption && i.hashtags.length));

    await SocialContentCalendar.deleteMany({ project_id: project._id });
    await SocialContentCalendarItem.deleteMany({ project_id: project._id });
    const stubborn = mockCalendarProvider({ behavior: ({ slots }) => ({ items: slots.map((s) => validRawCalendarItem(s, { caption: '' })) }) });
    const failed = await generate(stubborn, { postsPerWeek: 3 });
    assert.equal(failed.generation.status, 'failed');
    assert.equal(failed.generation.failure.code, 'AI_BAD_OUTPUT');
    assert.equal(await SocialContentCalendarItem.countDocuments({ project_id: project._id }), 0, 'no half-written calendar');
  });

  test('40: a calendar is planned in small batches so every post can carry its full copy (each prompt asks for at most CALENDAR_BATCH_SIZE slots)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    assert.ok(CALENDAR_BATCH_SIZE <= 5, 'batches are small enough for the written copy to fit the output budget');
    await seedStrategy();
    const provider = mockCalendarProvider();
    const r = await generate(provider, { postsPerWeek: 7, startDate: addDays(1), endDate: addDays(14) });
    assert.equal(r.generation.status, 'ready', JSON.stringify(r));
    const total = (await current()).items.length;
    assert.equal(provider.calls.length, Math.ceil(total / CALENDAR_BATCH_SIZE));
    assert.ok(provider.calls.every((c) => c.slots.length <= CALENDAR_BATCH_SIZE));
  });

  test('35: runCalendarGeneration with a claim that does not exist is a harmless no-op', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    assert.equal(await runCalendarGeneration(new mongoose.Types.ObjectId(), 'nobody'), null);
  });

  test('36: calendar generation does not change the strategy, the profile or the approval / publishing data', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const strategy = await seedStrategy();
    const profileBefore = JSON.stringify(await SocialBusinessProfile.findOne({ project_id: project._id }).lean());
    await generate(mockCalendarProvider(), { postsPerWeek: 3 });
    assert.deepEqual(clone(await SocialAIStrategy.findById(strategy._id).lean()), clone(strategy), 'the strategy document is byte-for-byte the same');
    assert.equal(JSON.stringify(await SocialBusinessProfile.findOne({ project_id: project._id }).lean()), profileBefore);
    assert.equal(await SocialPublication.countDocuments({ project_id: project._id }), 0);
  });
});
