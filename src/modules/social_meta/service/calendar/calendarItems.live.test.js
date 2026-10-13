import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import 'dotenv/config';
import mongoose from 'mongoose';

import SeoProject from '../../../app_user/model/SeoProject.js';
import SocialAccount from '../../model/SocialAccount.js';
import SocialAIStrategy from '../../model/SocialAIStrategy.js';
import SocialBusinessProfile from '../../model/SocialBusinessProfile.js';
import SocialContentCalendar from '../../model/SocialContentCalendar.js';
import SocialContentCalendarItem from '../../model/SocialContentCalendarItem.js';
import SocialContentGeneration from '../../model/SocialContentGeneration.js';
import SocialProduct from '../../model/SocialProduct.js';
import SocialPublication from '../../model/SocialPublication.js';
import { updateProfile, findProfile } from '../socialBusinessProfileService.js';
import productService from '../socialProductService.js';
import { startGeneration as startStrategy, setProviderOverride as setStrategyProvider, resetProviderOverride as resetStrategyProvider } from '../aiStrategy/socialAIStrategyService.js';
import { startCalendarGeneration, getCalendarState, setCalendarProviderOverride, resetCalendarProviderOverride } from './socialContentCalendarService.js';
import { setContentProviderOverride, resetContentProviderOverride } from '../aiContent/socialContentGenerationService.js';
import {
  getItemOptions, getItem, updateItem, createItem, approveItem, revokeItemApproval, regenerateItem, generateItemContent,
} from './socialContentCalendarItemService.js';
import {
  validRawStrategy, mockProvider, mockCalendarProvider, validRawCalendarItem, mockContentProvider, validRawPost,
} from '../../testSupport/aiStrategyFixtures.js';

/**
 * Real MongoDB, scripted AI providers: editing, approving, regenerating and generating content from ONE calendar item.
 * Proves edits are validated against the real connections / catalog / strategy, atomic and conflict-safe, scoped to the
 * project, that plan approval never touches a publication, that AI never overwrites a person's edits silently, and that
 * "generate content" goes through the existing generator and links the real draft back to the item.
 */

let mongoAvailable = false;
before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
    await Promise.all([SocialContentCalendar.init(), SocialContentCalendarItem.init(), SocialAIStrategy.init(), SocialProduct.init(), SocialContentGeneration.init()]);
  } catch { mongoAvailable = false; }
});
after(async () => {
  resetCalendarProviderOverride(); resetStrategyProvider(); resetContentProviderOverride();
  if (mongoAvailable) await mongoose.connection.close();
});

const addDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const waitFor = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error('waitFor timed out');
};

describe('Content Calendar item workspace (real MongoDB, scripted providers)', () => {
  let userId; let project; let pid; let created; let realFetch; let fetchCalls; let calendar;
  const track = (d) => { created.push(d); return d; };

  async function seedAccounts(projectId = project._id, owner = userId, { facebook = true, instagram = true } = {}) {
    const pageId = `pg_${Math.random().toString(36).slice(2, 8)}`;
    if (facebook) track(await SocialAccount.create({ user_id: owner, project_id: projectId, platform: 'facebook', platformAccountId: pageId, platformAccountName: 'Page', accountType: 'page', pageId, accessToken: 'FB-SECRET-TOKEN', status: 'active', isActive: true }));
    if (instagram) track(await SocialAccount.create({ user_id: owner, project_id: projectId, platform: 'instagram', platformAccountId: `ig_${pageId}`, platformAccountName: 'IG', accountType: 'business', pageId, accessToken: 'IG-SECRET-TOKEN', status: 'active' }));
  }
  async function seedStrategy(id = pid, uid = userId) {
    setStrategyProvider(mockProvider({ behavior: () => validRawStrategy() }));
    const r = await startStrategy(id, uid, { background: false });
    resetStrategyProvider();
    assert.equal(r.generation.status, 'ready', JSON.stringify(r));
    return SocialAIStrategy.findOne({ project_id: id, status: 'ready' }).sort({ version: -1 }).lean();
  }
  /** A real calendar: Facebook-only items over 14 days (Instagram is connected, so it can be added). */
  async function seedCalendar(over = {}, provider = mockCalendarProvider()) {
    setCalendarProviderOverride(provider);
    const r = await startCalendarGeneration(pid, userId, { startDate: addDays(1), endDate: addDays(14), postsPerWeek: 4, platforms: ['facebook'], distributionMode: 'balanced', ...over }, { background: false });
    assert.equal(r.generation.status, 'ready', JSON.stringify(r));
    calendar = await SocialContentCalendar.findOne({ project_id: project._id, status: 'ready' }).sort({ version: -1 }).lean();
    return calendar;
  }
  const items = () => SocialContentCalendarItem.find({ calendar_id: calendar._id }).sort({ contentDate: 1, order: 1 }).lean();
  const first = async () => (await items())[0];
  const edit = async (item, fields, uid = userId, id = pid) => updateItem(id, uid, String(item._id), { expectedRevision: item.revision ?? 0, ...fields });
  const reload = (item) => SocialContentCalendarItem.findById(item._id).lean();
  const ok = (r) => { assert.equal(r.success, true, JSON.stringify(r.error)); return r; };

  beforeEach(async () => {
    if (!mongoAvailable) return;
    created = [];
    userId = new mongoose.Types.ObjectId();
    project = track(await SeoProject.create({ user_id: userId, project_name: `Items ${Date.now()} ${Math.random().toString(36).slice(2, 8)}`, main_url: 'https://example.com', seo_scope: 'local', keywords: ['k'], description: 'Family dental practice', industry: 'Dentist' }));
    pid = project._id.toString();
    await updateProfile(pid, userId, { audience: { primary: 'Young families' }, goals: ['More bookings'], toneOfVoice: { primary: 'Warm' } });
    await seedAccounts();
    fetchCalls = [];
    realFetch = globalThis.fetch;
    globalThis.fetch = async (...a) => { fetchCalls.push(String(a[0])); throw new Error('network is not available in this test'); };
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    resetCalendarProviderOverride(); resetStrategyProvider(); resetContentProviderOverride();
    if (!mongoAvailable) return;
    const ids = created.map((d) => d.project_id || d._id);
    await Promise.all([
      SocialContentCalendarItem.deleteMany({ project_id: { $in: ids } }), SocialContentCalendar.deleteMany({ project_id: { $in: ids } }), SocialContentGeneration.deleteMany({ project_id: { $in: ids } }),
      SocialAIStrategy.deleteMany({ project_id: { $in: ids } }), SocialBusinessProfile.deleteMany({ project_id: { $in: ids } }),
      SocialProduct.deleteMany({ project_id: { $in: ids } }), SocialPublication.deleteMany({ project_id: { $in: ids } }),
      SocialAccount.deleteMany({ _id: { $in: created.map((d) => d._id) } }),
    ]);
    await SeoProject.deleteMany({ _id: { $in: created.map((d) => d._id) } });
  });

  // ── reading ──────────────────────────────────────────────────────────────
  test('1: the API item carries every editor field, its revision, a derived content id and one status', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy(); await seedCalendar();
    const doc = await first();
    const { item } = ok(await getItem(pid, String(doc._id)));
    for (const key of ['id', 'contentId', 'revision', 'date', 'dayOfWeek', 'platforms', 'format', 'contentPillar', 'objective', 'primaryKpi', 'targetAudience', 'topic', 'angle', 'hook', 'caption', 'hashtags', 'platformContent', 'selectedMediaIds', 'primaryCta', 'engagementPrompt', 'creativeDirection', 'contentBrief', 'onCreativeText', 'captionDirection', 'requiredAssets', 'approvalNotes', 'footerDisclaimer', 'requiresReview', 'status', 'effectiveStatus', 'locked', 'editedFields', 'publications', 'strategyVersion', 'isManual']) assert.ok(key in item, key);
    assert.match(item.contentId, /^[A-Z]{3}-P\d{2}$/);
    assert.equal(item.revision, 0);
    assert.equal(item.effectiveStatus, 'planned');
    assert.equal(item.locked, false);
    assert.deepEqual(item.publications, []);
    assert.equal('project_id' in item || 'strategyId' in item || 'calendar_id' in item, false, 'no internal ids leak');
  });

  test('2: an item of another project (or a malformed id) is NOT_FOUND - never readable, never editable', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy(); await seedCalendar();
    const doc = await first();
    const otherUser = new mongoose.Types.ObjectId();
    const other = track(await SeoProject.create({ user_id: otherUser, project_name: `Other ${Date.now()}`, main_url: 'https://example.org', seo_scope: 'local', keywords: ['k'], description: 'x', industry: 'y' }));
    const oid = String(other._id);
    assert.equal((await getItem(oid, String(doc._id))).error.code, 'NOT_FOUND');
    assert.equal((await updateItem(oid, otherUser, String(doc._id), { expectedRevision: 0, topic: 'hijack' })).error.code, 'NOT_FOUND');
    assert.equal((await approveItem(oid, otherUser, String(doc._id), { expectedRevision: 0 })).error.code, 'NOT_FOUND');
    assert.equal((await regenerateItem(oid, otherUser, String(doc._id), { expectedRevision: 0 })).error.code, 'NOT_FOUND');
    assert.equal((await generateItemContent(oid, otherUser, String(doc._id), { platform: 'facebook' })).error.code, 'NOT_FOUND');
    for (const bad of ['nope', '123', String(new mongoose.Types.ObjectId())]) assert.equal((await getItem(pid, bad)).error.code, 'NOT_FOUND', bad);
    assert.equal((await reload(doc)).topic, doc.topic, 'untouched');
  });

  test('3: the editor options are the REAL strategy pillars / hooks, the live catalog with product images, formats per platform and connection state', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await updateProfile(pid, userId, { businessModel: 'product' });
    const p = (await productService.createProduct(pid, userId, { name: 'Whitening kit' })).product;
    const mediaId = new mongoose.Types.ObjectId();
    await SocialProduct.updateOne({ _id: p.id }, { $push: { images: { mediaId, url: 'https://media.odito-test.example/a.png', storageKey: `${pid}/a.png`, mimeType: 'image/png', isPrimary: true } } });
    const foreign = track(await SeoProject.create({ user_id: userId, project_name: `Foreign ${Date.now()}`, main_url: 'https://example.net', seo_scope: 'local', keywords: ['k'], description: 'x', industry: 'y' }));
    await productService.createProduct(String(foreign._id), userId, { name: 'Someone else product' });
    await seedStrategy(); await seedCalendar();
    await SocialAccount.updateMany({ project_id: project._id, platform: 'instagram' }, { $set: { status: 'revoked' } });
    const o = ok(await getItemOptions(pid));
    assert.deepEqual(o.pillars.map((x) => x.name), ['Dental tips', 'Meet the team', 'Offers']);
    assert.equal(o.hooks.length, 6);
    assert.deepEqual(o.hooks[0], { index: 0, hook: 'Most people brush too hard. Here is the fix.', category: 'educational' });
    assert.deepEqual(o.objectives.find((x) => x.value === 'awareness').kpis, ['reach', 'views']);
    assert.ok(o.formats.facebook.includes('text_post') && !o.formats.instagram.includes('text_post'));
    assert.deepEqual(o.platforms, [{ platform: 'facebook', connected: true, inStrategy: true }, { platform: 'instagram', connected: false, inStrategy: true }]);
    assert.deepEqual(o.products.map((x) => x.name), ['Whitening kit'], 'only this project\'s catalog');
    assert.deepEqual(o.products[0].images.map((i) => i.url), ['https://media.odito-test.example/a.png']);
    assert.equal(o.businessModel, 'product');
    assert.equal(o.limits.caption.instagram, 2200);
    assert.equal(JSON.stringify(o).includes('SECRET'), false);
  });

  test('4: options need a calendar (NO_CALENDAR) - nothing is made up', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    assert.equal((await getItemOptions(pid)).error.code, 'NO_CALENDAR');
    assert.equal((await createItem(pid, userId, { date: addDays(2) })).error.code, 'NO_CALENDAR');
  });

  // ── editing ──────────────────────────────────────────────────────────────
  test('5: a save is atomic: every changed field lands, the revision moves on, the item becomes "edited" and the edited fields are remembered', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy(); await seedCalendar();
    const doc = await first();
    const r = ok(await edit(doc, { topic: 'Why flossing matters', caption: 'Floss daily.\n\nHere is why.', hashtags: ['dental', '#Floss'], primaryCta: 'Learn more', hook: 'A brand new hook', angle: '' }));
    assert.deepEqual(r.changed.sort(), ['angle', 'caption', 'hashtags', 'hook', 'primaryCta', 'topic']);
    const saved = await reload(doc);
    assert.equal(saved.topic, 'Why flossing matters');
    assert.equal(saved.caption, 'Floss daily.\n\nHere is why.');
    assert.deepEqual(saved.hashtags, ['#dental', '#Floss']);
    assert.equal(saved.revision, 1);
    assert.equal(saved.status, 'edited');
    assert.deepEqual([...saved.editedFields].sort(), ['angle', 'caption', 'hashtags', 'hook', 'primaryCta', 'topic']);
    assert.equal(String(saved.updatedBy), String(userId));
    assert.equal(saved.hookRef, null, 'a hook the person wrote is not a strategy hook');
    assert.equal(r.item.effectiveStatus, 'edited');
  });

  test('6: an edit that changes nothing writes nothing (no revision bump, no status change)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy(); await seedCalendar();
    const doc = await first();
    const r = ok(await edit(doc, { topic: doc.topic, platforms: doc.platforms }));
    assert.deepEqual(r.changed, []);
    const same = await reload(doc);
    assert.equal(same.revision, 0);
    assert.equal(same.status, 'planned');
  });

  test('7: a stale revision is refused with the CURRENT item and nothing is written', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy(); await seedCalendar();
    const doc = await first();
    ok(await edit(doc, { topic: 'First writer' }));
    const stale = await edit(doc, { topic: 'Second writer (stale)' });
    assert.equal(stale.success, false);
    assert.equal(stale.error.code, 'ITEM_CONFLICT');
    assert.equal(stale.error.item.topic, 'First writer');
    assert.equal(stale.error.item.revision, 1);
    assert.equal((await reload(doc)).topic, 'First writer');
    assert.equal((await updateItem(pid, userId, String(doc._id), { topic: 'no revision' })).error.code, 'INVALID_FIELD');
    assert.equal((await updateItem(pid, userId, String(doc._id), { expectedRevision: -1, topic: 'x' })).error.code, 'INVALID_FIELD');
    assert.equal((await updateItem(pid, userId, String(doc._id), { expectedRevision: '0', topic: 'x' })).error.code, 'INVALID_FIELD');
  });

  test('8: two saves racing from the same revision: exactly ONE wins, the other gets a conflict (never a silent overwrite)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy(); await seedCalendar();
    const doc = await first();
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => edit(doc, { topic: `Racer ${i}` })));
    assert.equal(results.filter((r) => r.success).length, 1);
    assert.equal(results.filter((r) => r.error?.code === 'ITEM_CONFLICT').length, 5);
    const saved = await reload(doc);
    assert.equal(saved.revision, 1);
    assert.ok(/^Racer \d$/.test(saved.topic));
  });

  test('9: validation failures name the field, write nothing and keep the revision', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy(); await seedCalendar();
    const doc = await first();
    for (const [fields, code, field] of [
      [{ status: 'plan_approved' }, 'UNKNOWN_FIELD', 'status'], [{ publicationIds: [] }, 'UNKNOWN_FIELD', 'publicationIds'], [{ strategyId: String(new mongoose.Types.ObjectId()) }, 'UNKNOWN_FIELD', 'strategyId'],
      [{ topic: '' }, 'INVALID_FIELD', 'topic'], [{ contentPillar: 'Invented pillar' }, 'INVALID_FIELD', 'contentPillar'], [{ primaryKpi: 'bookings' }, 'KPI_MISMATCH', 'primaryKpi'],
      [{ primaryCta: 'Buy now' }, 'CTA_MISMATCH', 'primaryCta'], [{ hashtags: ['not valid'] }, 'INVALID_FIELD', 'hashtags'],
    ]) {
      const r = await edit(doc, fields);
      assert.equal(r.success, false, JSON.stringify(fields));
      assert.equal(r.error.code, code, JSON.stringify(fields));
      assert.equal(r.error.field, field);
    }
    const same = await reload(doc);
    assert.equal(same.revision, 0);
    assert.equal(same.topic, doc.topic);
  });

  // ── platforms ────────────────────────────────────────────────────────────
  test('10: Facebook-only -> Facebook + Instagram works when Instagram is connected, and the plan summary follows', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy(); await seedCalendar();
    const before = (await SocialContentCalendar.findById(calendar._id).lean()).plan.platformCounts;
    assert.equal(before.instagram, undefined);
    const doc = await first();
    assert.deepEqual(doc.platforms, ['facebook']);
    const r = ok(await edit(doc, { platforms: ['facebook', 'instagram'] }));
    assert.deepEqual(r.item.platforms, ['facebook', 'instagram']);
    const after = (await SocialContentCalendar.findById(calendar._id).lean()).plan.platformCounts;
    assert.equal(after.instagram, 1);
    assert.equal(after.facebook, before.facebook);
    const state = await getCalendarState(pid);
    assert.equal(state.calendar.plan.platformCounts.instagram, 1);
    assert.deepEqual(state.items.find((i) => i.id === String(doc._id)).platforms, ['facebook', 'instagram']);
  });

  test('11: Instagram that is NOT connected cannot be added - a clear refusal, the item is unchanged', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy(); await seedCalendar();
    await SocialAccount.updateMany({ project_id: project._id, platform: 'instagram' }, { $set: { status: 'revoked', isActive: false } });
    const doc = await first();
    const r = await edit(doc, { platforms: ['facebook', 'instagram'] });
    assert.equal(r.error.code, 'PLATFORM_NOT_CONNECTED');
    assert.match(r.error.message, /Connect your Instagram account/);
    assert.deepEqual((await reload(doc)).platforms, ['facebook']);
  });

  test('12: a text-only post cannot target Instagram, and an Instagram item cannot become one', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy(); await seedCalendar();
    const doc = await first();
    ok(await edit(doc, { format: 'text_post' }));
    const a = await edit({ ...doc, revision: 1 }, { platforms: ['facebook', 'instagram'] });
    assert.equal(a.error.code, 'FORMAT_NOT_SUPPORTED');
    ok(await edit({ ...doc, revision: 1 }, { format: 'carousel', platforms: ['facebook', 'instagram'] }));
    const b = await edit({ ...doc, revision: 2 }, { format: 'text_post' });
    assert.equal(b.error.code, 'FORMAT_NOT_SUPPORTED');
  });

  test('13: platform-specific copy is stored per platform and removed when its platform is removed', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy(); await seedCalendar();
    const doc = await first();
    ok(await edit(doc, { platforms: ['facebook', 'instagram'], caption: 'Shared', platformContent: [{ platform: 'instagram', caption: 'Short IG caption', primaryCta: 'Save this', hashtags: ['ig', 'dental'] }, { platform: 'facebook', caption: 'Longer Facebook caption', primaryCta: 'Learn more', hashtags: [] }] }));
    let saved = await reload(doc);
    assert.deepEqual(saved.platformContent.map((p) => [p.platform, p.caption, p.primaryCta, p.hashtags]), [['instagram', 'Short IG caption', 'Save this', ['#ig', '#dental']], ['facebook', 'Longer Facebook caption', 'Learn more', []]]);
    ok(await edit({ ...doc, revision: 1 }, { platforms: ['facebook'] }));
    saved = await reload(doc);
    assert.deepEqual(saved.platformContent.map((p) => p.platform), ['facebook']);
  });

  // ── catalog ──────────────────────────────────────────────────────────────
  test('14: a service is chosen from the real catalog, its name is copied by the server, and a foreign id is refused', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await updateProfile(pid, userId, { businessModel: 'service', services: [{ name: 'Teeth Whitening' }, { name: 'Check-up' }] });
    const services = (await findProfile(pid)).services;
    await seedStrategy(); await seedCalendar();
    const doc = await first();
    const r = ok(await edit(doc, { serviceId: String(services[0]._id) }));
    assert.equal(r.item.serviceName, 'Teeth Whitening');
    assert.equal(r.item.serviceId, String(services[0]._id));
    assert.equal((await edit({ ...doc, revision: 1 }, { serviceId: String(new mongoose.Types.ObjectId()) })).error.code, 'INVALID_FIELD');
    assert.equal((await edit({ ...doc, revision: 1 }, { productId: String(new mongoose.Types.ObjectId()) })).error.code, 'INVALID_FIELD');
    const cleared = ok(await edit({ ...doc, revision: 1 }, { serviceId: null }));
    assert.equal(cleared.item.serviceId, null);
    assert.equal(cleared.item.serviceName, null);
  });

  test('15: a service removed from the catalog can no longer be chosen', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await updateProfile(pid, userId, { businessModel: 'service', services: [{ name: 'Whitening' }, { name: 'Check-up' }] });
    const services = (await findProfile(pid)).services;
    await seedStrategy(); await seedCalendar();
    await SocialBusinessProfile.updateOne({ project_id: project._id, 'services._id': services[0]._id }, { $set: { 'services.$.status': 'archived' } });
    const doc = await first();
    assert.equal((await edit(doc, { serviceId: String(services[0]._id) })).error.code, 'INVALID_FIELD');
    ok(await edit(doc, { serviceId: String(services[1]._id) }));
  });

  test('16: a product business: product + its own images only; another product\'s image, another project\'s product and a service are refused', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await updateProfile(pid, userId, { businessModel: 'product' });
    const a = (await productService.createProduct(pid, userId, { name: 'Serum' })).product;
    const b = (await productService.createProduct(pid, userId, { name: 'Cream' })).product;
    const imgA = new mongoose.Types.ObjectId(); const imgB = new mongoose.Types.ObjectId();
    const image = (mediaId, n) => ({ mediaId, url: `https://media.odito-test.example/${n}.png`, storageKey: `${pid}/${n}.png`, mimeType: 'image/png', isPrimary: true });
    await SocialProduct.updateOne({ _id: a.id }, { $push: { images: image(imgA, 'a') } });
    await SocialProduct.updateOne({ _id: b.id }, { $push: { images: image(imgB, 'b') } });
    const foreign = track(await SeoProject.create({ user_id: userId, project_name: `Foreign ${Date.now()}`, main_url: 'https://example.net', seo_scope: 'local', keywords: ['k'], description: 'x', industry: 'y' }));
    const fp = (await productService.createProduct(String(foreign._id), userId, { name: 'Not mine' })).product;
    await seedStrategy(); await seedCalendar();
    const doc = await first();

    const r = ok(await edit(doc, { productId: a.id, selectedMediaIds: [String(imgA)] }));
    assert.equal(r.item.productName, 'Serum');
    assert.deepEqual(r.item.selectedMediaIds, [String(imgA)]);
    assert.equal((await edit({ ...doc, revision: 1 }, { selectedMediaIds: [String(imgB)] })).error.code, 'INVALID_FIELD', 'an image of another product');
    assert.equal((await edit({ ...doc, revision: 1 }, { productId: fp.id })).error.code, 'INVALID_FIELD', 'another project\'s product');
    assert.equal((await edit({ ...doc, revision: 1 }, { serviceId: String(new mongoose.Types.ObjectId()) })).error.code, 'INVALID_FIELD', 'a product business has no services');
    const switched = ok(await edit({ ...doc, revision: 1 }, { productId: b.id }));
    assert.deepEqual(switched.item.selectedMediaIds, [], 'images belong to the product they came from');
  });

  // ── date, pillar, objective ──────────────────────────────────────────────
  test('17: moving the planned date re-sorts the plan, derives the weekday, stays inside the calendar and is never a schedule', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy(); await seedCalendar();
    const doc = await first();
    const target = addDays(13);
    const r = ok(await edit(doc, { date: target }));
    assert.equal(r.item.date, target);
    assert.equal(r.item.dayOfWeek, ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][new Date(`${target}T00:00:00Z`).getUTCDay()]);
    const state = await getCalendarState(pid);
    const dates = state.items.map((i) => i.date);
    assert.deepEqual(dates, [...dates].sort(), 'the plan is returned in date order');
    assert.equal(dates.at(-1) >= target, true);
    assert.equal((await edit({ ...doc, revision: 1 }, { date: addDays(40) })).error.code, 'DATE_OUT_OF_RANGE');
    assert.equal((await edit({ ...doc, revision: 1 }, { date: '2020-01-01' })).error.code, 'DATE_OUT_OF_RANGE');
    assert.equal((await edit({ ...doc, revision: 1 }, { date: 'tomorrow' })).error.code, 'INVALID_FIELD');
    assert.equal(await SocialPublication.countDocuments({ project_id: project._id }), 0, 'no publication, no schedule');
  });

  test('18: changing the pillar updates the calendar\'s pillar mix (planned vs target)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy(); await seedCalendar();
    const doc = await first();
    const mix = async () => Object.fromEntries((await SocialContentCalendar.findById(calendar._id).lean()).plan.pillarDistribution.map((d) => [d.pillar, d.plannedCount]));
    const before = await mix();
    const target = doc.contentPillar === 'Offers' ? 'Dental tips' : 'Offers';
    ok(await edit(doc, { contentPillar: target }));
    const after = await mix();
    assert.equal(after[target], before[target] + 1);
    assert.equal(after[doc.contentPillar], before[doc.contentPillar] - 1);
    assert.equal(Object.values(after).reduce((s, n) => s + n, 0), (await items()).length);
  });

  test('19: objective and KPI move together (a KPI that does not measure the objective is refused)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy(); await seedCalendar();
    const doc = await first();
    ok(await edit(doc, { objective: 'awareness', primaryKpi: 'reach' }));
    assert.equal((await edit({ ...doc, revision: 1 }, { objective: 'lead_generation' })).error.code, 'KPI_MISMATCH');
    ok(await edit({ ...doc, revision: 1 }, { objective: 'lead_generation', primaryKpi: 'dms', primaryCta: 'Book a check-up' }));
  });

  // ── version safety ───────────────────────────────────────────────────────
  test('20: an edit never changes the strategy / profile pin or the calendar\'s generated provenance', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const strategy = await seedStrategy(); await seedCalendar();
    const doc = await first();
    ok(await edit(doc, { topic: 'Edited topic', platforms: ['facebook', 'instagram'], date: addDays(12) }));
    const saved = await reload(doc);
    assert.equal(String(saved.strategyId), String(strategy._id));
    assert.equal(saved.strategyVersion, strategy.version);
    assert.equal(saved.profileSnapshotHash, strategy.profileSnapshot.hash);
    const cal = await SocialContentCalendar.findById(calendar._id).lean();
    assert.equal(String(cal.strategy.id), String(strategy._id));
    assert.equal(cal.version, calendar.version);
    assert.equal((await SocialAIStrategy.findById(strategy._id).lean()).version, strategy.version);
  });

  test('21: items of a replaced calendar version are read-only history', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy(); await seedCalendar();
    const old = await first();
    await seedCalendar({}, mockCalendarProvider({ behavior: ({ slots }) => ({ items: slots.map((s) => validRawCalendarItem(s, { topic: `Second calendar ${s.index}` })) }) }));
    assert.equal(calendar.version, 2);
    const r = await edit(old, { topic: 'Editing history' });
    assert.equal(r.error.code, 'CALENDAR_ARCHIVED');
    assert.equal((await approveItem(pid, userId, String(old._id), { expectedRevision: 0 })).error.code, 'CALENDAR_ARCHIVED');
    assert.equal((await getItem(pid, String(old._id))).success, true, 'it can still be read');
    assert.equal((await reload(old)).topic, old.topic);
  });

  // ── plan approval ────────────────────────────────────────────────────────
  test('22: approving the PLAN sets the planning status only - no publication is created, approved, scheduled or touched', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy(); await seedCalendar();
    const doc = await first();
    const r = ok(await approveItem(pid, userId, String(doc._id), { expectedRevision: 0 }));
    assert.equal(r.item.status, 'plan_approved');
    assert.equal(r.item.effectiveStatus, 'plan_approved');
    assert.ok(r.item.planApprovedAt);
    const saved = await reload(doc);
    assert.equal(String(saved.planApprovedBy), String(userId));
    assert.equal(saved.revision, 1);
    assert.deepEqual(saved.publicationIds, []);
    assert.equal(await SocialPublication.countDocuments({ project_id: project._id }), 0);
    assert.equal(await SocialContentGeneration.countDocuments({ project_id: project._id }), 0);
    assert.deepEqual(fetchCalls, [], 'nothing was sent anywhere');
  });

  test('23: approval is idempotent; a stale revision conflicts; a broken plan cannot be approved', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy(); await seedCalendar();
    const [a, b] = await items();
    ok(await approveItem(pid, userId, String(a._id), { expectedRevision: 0 }));
    const again = ok(await approveItem(pid, userId, String(a._id), { expectedRevision: 1 }));
    assert.equal(again.alreadyApproved, true);
    assert.equal((await reload(a)).revision, 1);
    assert.equal((await approveItem(pid, userId, String(b._id), { expectedRevision: 5 })).error.code, 'ITEM_CONFLICT');
    assert.equal((await approveItem(pid, userId, String(b._id), {})).error.code, 'INVALID_FIELD');
    await SocialContentCalendarItem.updateOne({ _id: b._id }, { $set: { primaryKpi: 'purchases' } }); // corrupt: does not measure the objective
    assert.equal((await approveItem(pid, userId, String(b._id), { expectedRevision: 0 })).error.code, 'KPI_MISMATCH');
    assert.equal((await reload(b)).status, 'planned');
  });

  test('24: editing an approved plan reopens it (the approval is withdrawn); the approval can also be taken back', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy(); await seedCalendar();
    const [a, b] = await items();
    ok(await approveItem(pid, userId, String(a._id), { expectedRevision: 0 }));
    const r = ok(await updateItem(pid, userId, String(a._id), { expectedRevision: 1, topic: 'Changed after approval' }));
    assert.equal(r.approvalRevoked, true);
    const saved = await reload(a);
    assert.equal(saved.status, 'edited');
    assert.equal(saved.planApprovedAt, null);

    ok(await approveItem(pid, userId, String(b._id), { expectedRevision: 0 }));
    const back = ok(await revokeItemApproval(pid, userId, String(b._id), { expectedRevision: 1 }));
    assert.equal(back.item.status, 'planned');
    assert.equal((await revokeItemApproval(pid, userId, String(b._id), { expectedRevision: 2 })).error.code, 'NOT_APPROVED');
  });

  // ── regeneration with AI ─────────────────────────────────────────────────
  const regenProvider = (over = {}) => mockCalendarProvider({ behavior: ({ slots }) => ({ items: slots.map((s) => validRawCalendarItem(s, { topic: 'A freshly planned topic', angle: 'A fresh angle', hook: '', hookRef: 2, creativeDirection: 'Fresh visuals', primaryCta: 'Learn more', ...over })) }) });

  test('25: regeneration re-plans ONE item: only the chosen fields change, everything else (caption, platforms, date, service) is untouched, and it is a single-slot call', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy(); await seedCalendar();
    const doc = await first();
    ok(await edit(doc, { caption: 'My own caption' }));
    const provider = regenProvider();
    setCalendarProviderOverride(provider);
    const r = ok(await regenerateItem(pid, userId, String(doc._id), { expectedRevision: 1, fields: ['topic', 'hook', 'angle'] }));
    assert.deepEqual(r.regenerated.sort(), ['angle', 'hook', 'topic']);
    const saved = await reload(doc);
    assert.equal(saved.topic, 'A freshly planned topic');
    assert.equal(saved.angle, 'A fresh angle');
    assert.equal(saved.hook, 'What really happens at a first check-up?', 'the strategy hook 2, verbatim');
    assert.equal(saved.hookRef, 2);
    assert.equal(saved.caption, 'My own caption');
    assert.equal(saved.creativeDirection, doc.creativeDirection, 'not selected, not changed');
    assert.equal(saved.contentDate, doc.contentDate);
    assert.deepEqual(saved.platforms, doc.platforms);
    assert.equal(saved.contentPillar, doc.contentPillar);
    assert.equal(saved.revision, 2);
    assert.equal(provider.calls.length, 1);
    assert.equal(provider.calls[0].slots.length, 1);
    assert.match(provider.calls[0].user, /<regenerate_this_post>/);
    assert.match(provider.calls[0].user, /fields_to_rewrite: topic \| hook \| angle/);
  });

  test('26: a person\'s edits are PROTECTED: regenerating them needs explicit confirmation, and nothing is called without it', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy(); await seedCalendar();
    const doc = await first();
    ok(await edit(doc, { topic: 'My careful topic', primaryCta: 'Learn more' }));
    const provider = regenProvider();
    setCalendarProviderOverride(provider);
    const refused = await regenerateItem(pid, userId, String(doc._id), { expectedRevision: 1 });
    assert.equal(refused.error.code, 'EDITED_FIELDS');
    assert.deepEqual(refused.error.editedFields.sort(), ['primaryCta', 'topic']);
    assert.equal(provider.calls.length, 0, 'the AI was not even asked');
    assert.equal((await reload(doc)).topic, 'My careful topic');
    // fields the person did NOT edit are fine without confirmation
    ok(await regenerateItem(pid, userId, String(doc._id), { expectedRevision: 1, fields: ['hook', 'contentBrief'] }));
    assert.equal((await reload(doc)).topic, 'My careful topic');
    // with confirmation the edited fields are replaced and no longer count as edited
    const confirmed = ok(await regenerateItem(pid, userId, String(doc._id), { expectedRevision: 2, overwriteEdited: true }));
    assert.ok(confirmed.regenerated.includes('topic'));
    const saved = await reload(doc);
    assert.equal(saved.topic, 'A freshly planned topic');
    assert.deepEqual(saved.editedFields, []);
    assert.equal(saved.status, 'planned');
  });

  test('27: if the item is edited while the AI is working, the regeneration is discarded (conflict) and the edit survives', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy(); await seedCalendar();
    const doc = await first();
    let release;
    const gate = new Promise((r) => { release = r; });
    setCalendarProviderOverride(mockCalendarProvider({ gate, behavior: ({ slots }) => ({ items: slots.map((s) => validRawCalendarItem(s, { topic: 'Late AI topic' })) }) }));
    const pending = regenerateItem(pid, userId, String(doc._id), { expectedRevision: 0, fields: ['topic'] });
    await new Promise((r) => setTimeout(r, 50));
    ok(await edit(doc, { caption: 'Edited while the AI worked' }));
    release();
    const r = await pending;
    assert.equal(r.error.code, 'ITEM_CONFLICT');
    const saved = await reload(doc);
    assert.equal(saved.caption, 'Edited while the AI worked');
    assert.equal(saved.topic, doc.topic, 'the late AI result was not applied');
  });

  test('28: regeneration refuses bad input and AI failures leave the item untouched', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy(); await seedCalendar();
    const doc = await first();
    setCalendarProviderOverride(regenProvider());
    for (const body of [{ expectedRevision: 0, fields: ['footerDisclaimer'] }, { expectedRevision: 0, fields: [] }, { expectedRevision: 0, fields: 'topic' }, { expectedRevision: 0, fields: ['topic', 'topic'] }, { expectedRevision: 0, overwriteEdited: 'yes' }, {}]) {
      assert.equal((await regenerateItem(pid, userId, String(doc._id), body)).error.code, 'INVALID_FIELD', JSON.stringify(body));
    }
    setCalendarProviderOverride(mockCalendarProvider({ behavior: () => ({ items: [] }) }));
    const bad = await regenerateItem(pid, userId, String(doc._id), { expectedRevision: 0 });
    assert.equal(bad.error.code, 'AI_BAD_OUTPUT');
    setCalendarProviderOverride(mockCalendarProvider({ available: false }));
    assert.equal((await regenerateItem(pid, userId, String(doc._id), { expectedRevision: 0 })).error.code, 'AI_UNAVAILABLE');
    const same = await reload(doc);
    assert.equal(same.revision, 0);
    assert.equal(same.topic, doc.topic);
  });

  test('29: the AI cannot sneak a prohibited phrase or a duplicate topic into a regenerated item', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await updateProfile(pid, userId, { prohibitedPhrases: ['cheapest'] });
    await seedStrategy(); await seedCalendar();
    const [a, b] = await items();
    const dupe = mockCalendarProvider({ behavior: ({ slots }) => ({ items: slots.map((s) => validRawCalendarItem(s, { topic: b.topic })) }) });
    setCalendarProviderOverride(dupe);
    assert.equal((await regenerateItem(pid, userId, String(a._id), { expectedRevision: 0 })).error.code, 'AI_BAD_OUTPUT');
    assert.equal(dupe.calls.length, 2, 'one repair attempt, then it gives up');
    setCalendarProviderOverride(mockCalendarProvider({ behavior: ({ slots }) => ({ items: slots.map((s) => validRawCalendarItem(s, { topic: 'The cheapest check-up' })) }) }));
    assert.equal((await regenerateItem(pid, userId, String(a._id), { expectedRevision: 0 })).error.code, 'AI_BAD_OUTPUT');
    assert.equal((await reload(a)).topic, a.topic);
  });

  test('29b: regenerating the CAPTION rewrites the shared caption and each platform\'s version; HASHTAGS are separate; the plan\'s other fields stay', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy(); await seedCalendar();
    const doc = await first();
    ok(await edit(doc, { platforms: ['facebook', 'instagram'] }));
    const before = await reload(doc);
    assert.ok(before.caption.length > 0 && before.hashtags.length > 0, 'the calendar wrote them');
    const provider = regenProvider({ caption: 'A brand new shared caption for this post.', hashtags: ['#NewTag', '#AnotherTag'] });
    setCalendarProviderOverride(provider);
    const r = ok(await regenerateItem(pid, userId, String(doc._id), { expectedRevision: 1, fields: ['caption'] }));
    assert.deepEqual(r.regenerated, ['caption']);
    let saved = await reload(doc);
    assert.equal(saved.caption, 'A brand new shared caption for this post.');
    assert.deepEqual(saved.hashtags, before.hashtags, 'hashtags were not selected');
    assert.deepEqual(saved.platformContent.map((p) => p.platform), ['facebook', 'instagram']);
    assert.ok(saved.platformContent.every((p) => p.caption.startsWith('A short ') && p.primaryCta === 'Save this'), 'each platform got a freshly written version');
    assert.deepEqual(saved.platformContent.map((p) => p.hashtags), [[], []], 'per-platform hashtags were not selected, so they are untouched');
    assert.equal(saved.topic, before.topic);
    assert.match(provider.calls[0].user, /fields_to_rewrite: caption/);

    ok(await regenerateItem(pid, userId, String(doc._id), { expectedRevision: 2, fields: ['hashtags'] }));
    saved = await reload(doc);
    assert.deepEqual(saved.hashtags, ['#NewTag', '#AnotherTag']);
    assert.deepEqual(saved.platformContent.map((p) => p.hashtags), [['#DentalCare'], ['#DentalCare']]);
    assert.equal(saved.caption, 'A brand new shared caption for this post.', 'the caption was not selected');
  });

  test('29c: a person\'s caption, hashtags or platform copy is protected from a rewrite until they confirm', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy(); await seedCalendar();
    const doc = await first();
    ok(await edit(doc, { platforms: ['facebook', 'instagram'] }));
    ok(await edit({ ...doc, revision: 1 }, { platformContent: [{ platform: 'instagram', caption: 'My own Instagram caption', hashtags: ['mine'] }] }));
    const provider = regenProvider();
    setCalendarProviderOverride(provider);
    for (const fields of [['caption'], ['hashtags']]) {
      const refused = await regenerateItem(pid, userId, String(doc._id), { expectedRevision: 2, fields });
      assert.equal(refused.error.code, 'EDITED_FIELDS', fields.join());
      assert.deepEqual(refused.error.editedFields, fields);
    }
    assert.equal(provider.calls.length, 0);
    ok(await regenerateItem(pid, userId, String(doc._id), { expectedRevision: 2, fields: ['caption'], overwriteEdited: true }));
    const saved = await reload(doc);
    assert.ok(saved.platformContent.every((p) => p.caption.startsWith('A short ')), 'the confirmed rewrite replaced the hand-written Instagram caption');
    assert.ok(!saved.editedFields.includes('platformContent') && !saved.editedFields.includes('caption'));
  });

  // ── generate content (hand-off to the existing generator) ────────────────
  const contentProvider = () => mockContentProvider({ behavior: ({ user }) => validRawPost({ platform: /platform: (\w+)/.exec(user)[1], contentPillar: /content_pillar: (.*)/.exec(user)[1].trim() }) });

  test('30: content can only be generated from an APPROVED plan', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy(); await seedCalendar();
    const doc = await first();
    const provider = contentProvider();
    setContentProviderOverride(provider);
    const r = await generateItemContent(pid, userId, String(doc._id), { platform: 'facebook', mode: 'ai' });
    assert.equal(r.error.code, 'PLAN_NOT_APPROVED');
    assert.equal(provider.calls.length, 0);
    assert.equal((await generateItemContent(pid, userId, String(doc._id), { platform: 'tiktok' })).error.code, 'INVALID_FIELD');
    assert.equal((await generateItemContent(pid, userId, String(doc._id), { platform: 'instagram', mode: 'ai' })).error.code, 'INVALID_FIELD', 'the item is not planned for Instagram');
  });

  test('31: generating content uses the EXISTING generator with the plan as input, creates a real draft publication and links it back to the item', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy(); await seedCalendar();
    const doc = await first();
    ok(await edit(doc, { topic: 'A very specific planned topic', caption: 'Draft caption from the plan', hashtags: ['dental'] }));
    ok(await approveItem(pid, userId, String(doc._id), { expectedRevision: 1 }));
    const provider = contentProvider();
    setContentProviderOverride(provider);
    const started = await generateItemContent(pid, userId, String(doc._id), { platform: 'facebook', mode: 'ai' });
    assert.equal(started.success, true, JSON.stringify(started.error));
    assert.equal(started.started, true);
    assert.equal(started.generation.calendarItemId, String(doc._id));

    const linked = await waitFor(async () => { const d = await reload(doc); return d.publicationIds.length ? d : null; });
    const pub = await SocialPublication.findById(linked.publicationIds[0]).lean();
    assert.equal(String(pub.project_id), pid);
    assert.equal(pub.platform, 'facebook');
    assert.equal(pub.status, 'draft', 'a draft: nothing is scheduled or published');
    assert.equal(pub.scheduledAt, null);
    assert.equal(String(pub.generation.calendarItemId), String(doc._id));
    assert.equal(String(pub.generation.strategyId), String(doc.strategyId));
    assert.equal(linked.status, 'content_generated');
    assert.equal(provider.calls.length, 1);
    assert.match(provider.calls[0].user, /<content_plan>/);
    assert.match(provider.calls[0].user, /topic: A very specific planned topic/);
    assert.match(provider.calls[0].user, /draft_caption_by_the_business: Draft caption from the plan/);
    assert.deepEqual(fetchCalls, [], 'no network call: nothing was sent to Meta');

    const state = await getCalendarState(pid);
    const api = state.items.find((i) => i.id === String(doc._id));
    assert.equal(api.publications.length, 1);
    assert.equal(api.publications[0].platform, 'facebook');
    assert.ok(api.publications[0].content.length > 0, 'the real caption of the draft is shown');
    assert.notEqual(api.effectiveStatus, 'plan_approved', 'the status now comes from the publication');
  });

  test('32: one draft per platform: the same platform cannot be generated twice, a second platform can; the plan is no longer approvable or revocable', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy(); await seedCalendar();
    const doc = await first();
    ok(await edit(doc, { platforms: ['facebook', 'instagram'] }));
    ok(await approveItem(pid, userId, String(doc._id), { expectedRevision: 1 }));
    setContentProviderOverride(contentProvider());
    assert.equal((await generateItemContent(pid, userId, String(doc._id), { platform: 'facebook', mode: 'ai' })).success, true);
    await waitFor(async () => (await reload(doc)).publicationIds.length === 1);
    await waitFor(async () => !(await SocialContentGeneration.exists({ project_id: project._id, status: 'generating' })));
    assert.equal((await generateItemContent(pid, userId, String(doc._id), { platform: 'facebook', mode: 'ai' })).error.code, 'ALREADY_GENERATED');
    assert.equal((await generateItemContent(pid, userId, String(doc._id), { platform: 'instagram', mode: 'ai' })).success, true);
    await waitFor(async () => (await reload(doc)).publicationIds.length === 2);
    const pubs = await SocialPublication.find({ _id: { $in: (await reload(doc)).publicationIds } }).lean();
    assert.deepEqual(pubs.map((p) => p.platform).sort(), ['facebook', 'instagram']);
    const latest = await reload(doc);
    assert.equal((await revokeItemApproval(pid, userId, String(doc._id), { expectedRevision: latest.revision })).error.code, 'NOT_APPROVED');
    assert.equal((await edit(latest, { platforms: ['instagram'] })).error.code, 'PLATFORM_HAS_PUBLICATION');
  });

  // ── the caption source of truth: the reviewed plan caption becomes the draft, verbatim ──
  const approvedItem = async (fields = {}) => {
    const doc = await first();
    ok(await edit(doc, { caption: 'Brushing twice a day keeps your smile strong.\n\nBook a check-up with us this month.', hashtags: ['#DentalCare', '#HealthySmile'], ...fields }));
    const edited = await reload(doc);
    ok(await approveItem(pid, userId, String(doc._id), { expectedRevision: edited.revision }));
    return reload(doc);
  };
  const create = (doc, over = {}) => generateItemContent(pid, userId, String(doc._id), { platform: 'facebook', expectedRevision: doc.revision, ...over });

  test("S1: the editor options carry the strategy's suggested posting windows (text, never parsed into a schedule) and the account's time zone; the plan item itself still has only a date", async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy(); await seedCalendar();
    const none = await getItemOptions(pid, { userId });
    assert.equal(none.scheduling.timezone, null, 'no time zone known: none is invented');
    assert.ok(Array.isArray(none.scheduling.timeWindows) && none.scheduling.timeWindows.length > 0, "the strategy's own windows");
    const User = (await import('../../../user/model/User.js')).default;
    await User.collection.insertOne({ _id: userId, email: `tz-${userId}@example.com`, timezone: 'Asia/Kolkata' });
    try {
      assert.equal((await getItemOptions(pid, { userId })).scheduling.timezone, 'Asia/Kolkata');
    } finally { await User.collection.deleteOne({ _id: userId }); }
    const doc = await first();
    assert.match(doc.contentDate, /^\d{4}-\d{2}-\d{2}$/, 'a plan item is a calendar DATE: no time of day, so nothing can be published by planning');
    assert.equal('scheduledAt' in doc, false);
    assert.equal(await SocialPublication.countDocuments({ project_id: project._id }), 0);
  });

  test('P1: the draft IS the reviewed caption, word for word, with its hashtags - no AI call, nothing rewritten - and it records which plan revision it came from', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy(); await seedCalendar();
    const provider = contentProvider();
    setContentProviderOverride(provider);
    const doc = await approvedItem();
    const r = await create(doc);
    assert.equal(r.success, true, JSON.stringify(r.error));
    assert.equal(r.mode, 'plan');

    assert.equal(provider.calls.length, 0, 'no AI call: the person\'s words are not rewritten');
    const pub = await SocialPublication.findById(r.publication.id).lean();
    assert.equal(pub.content, 'Brushing twice a day keeps your smile strong.\n\nBook a check-up with us this month.\n\n#DentalCare #HealthySmile', 'verbatim, hashtags appended once');
    assert.equal(pub.status, 'draft', 'nothing is scheduled or published');
    assert.equal(pub.scheduledAt, null);
    assert.equal(pub.generation.source, 'calendar_plan');
    assert.equal(pub.generation.type, 'calendar_item');
    assert.equal(pub.generation.planRevision, doc.revision, 'traceable to the approved plan revision');
    assert.ok(pub.generation.planApprovedAt);
    assert.equal(String(pub.generation.calendarItemId), String(doc._id));
    assert.ok(pub.approvalState, 'it entered the existing content approval workflow');

    const linked = await reload(doc);
    assert.deepEqual(linked.publicationIds.map(String), [String(pub._id)]);
    assert.equal(linked.status, 'content_generated');
    assert.equal(linked.caption, doc.caption, 'the plan itself is untouched');
    assert.equal(r.publication.generation.source, 'calendar_plan', 'the API tells the UI where the text came from');
    assert.deepEqual(fetchCalls, [], 'nothing was sent anywhere');
  });

  test('P2: with a caption in the plan the default is to USE it; with none the default is AI writing; each choice can be asked for explicitly', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy(); await seedCalendar();
    const provider = contentProvider();
    setContentProviderOverride(provider);
    // no caption in the plan -> the only thing that can write it is AI
    const bare = await approvedItem({ caption: '', hashtags: [] });
    const refused = await create(bare, { mode: 'plan' });
    assert.equal(refused.error.code, 'NO_PLAN_CAPTION');
    assert.equal(await SocialPublication.countDocuments({ project_id: project._id }), 0);
    assert.equal((await reload(bare)).revision, bare.revision, 'a refusal changes nothing');
    const byDefault = await create(bare);
    assert.equal(byDefault.success, true, JSON.stringify(byDefault.error));
    assert.equal(byDefault.started, true, 'no caption to use: the AI path started');
    await waitFor(async () => (await reload(bare)).publicationIds.length === 1);
    assert.equal(provider.calls.length, 1);
    assert.equal((await reload(bare)).caption, '', 'the plan\'s own caption is not filled in behind the person\'s back');
    assert.equal((await SocialPublication.findOne({ project_id: project._id }).lean()).generation.source, 'ai');
    assert.equal((await generateItemContent(pid, userId, String(bare._id), { platform: 'facebook', mode: 'sideways', expectedRevision: 0 })).error.code, 'INVALID_FIELD');
  });

  test('P3: asking for AI explicitly leaves the reviewed caption in the plan exactly as it was; the AI text is a separate draft that goes through approval', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy(); await seedCalendar();
    setContentProviderOverride(contentProvider());
    const doc = await approvedItem();
    const r = await generateItemContent(pid, userId, String(doc._id), { platform: 'facebook', mode: 'ai' });
    assert.equal(r.success, true, JSON.stringify(r.error));
    await waitFor(async () => (await reload(doc)).publicationIds.length === 1);
    const after = await reload(doc);
    assert.equal(after.caption, doc.caption, 'the plan caption is unchanged');
    assert.deepEqual(after.hashtags, doc.hashtags);
    const pub = await SocialPublication.findOne({ project_id: project._id }).lean();
    assert.equal(pub.generation.source, 'ai');
    assert.notEqual(pub.content, doc.caption);
  });

  test('P4: each platform gets ITS OWN reviewed copy (platform-specific caption and hashtags), falling back to the shared one', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy(); await seedCalendar();
    const doc = await first();
    ok(await edit(doc, { platforms: ['facebook', 'instagram'], caption: 'Shared caption for everyone.', hashtags: ['#Shared'], platformContent: [{ platform: 'instagram', caption: 'Short Instagram caption.', primaryCta: 'Save this', hashtags: ['#Insta', '#Only'] }] }));
    const edited = await reload(doc);
    ok(await approveItem(pid, userId, String(doc._id), { expectedRevision: edited.revision }));
    const fb = await create(await reload(doc), { platform: 'facebook' });
    assert.equal(fb.success, true, JSON.stringify(fb.error));
    const ig = await create(await reload(doc), { platform: 'instagram' });
    assert.equal(ig.success, true, JSON.stringify(ig.error));
    const pubs = await SocialPublication.find({ project_id: project._id }).lean();
    assert.equal(pubs.find((p) => p.platform === 'facebook').content, 'Shared caption for everyone.\n\n#Shared');
    assert.equal(pubs.find((p) => p.platform === 'instagram').content, 'Short Instagram caption.\n\n#Insta #Only');
  });

  test('P5: a caption that does not fit the platform, has too many hashtags or uses a prohibited phrase is REFUSED with the reason - never cut, never published (a backstop for text that changed after approval)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await updateProfile(pid, userId, { prohibitedPhrases: ['cheapest'] });
    await seedStrategy(); await seedCalendar();
    setContentProviderOverride(contentProvider());
    const cases = [
      [{ caption: 'x'.repeat(2300), platforms: ['facebook', 'instagram'] }, 'CAPTION_TOO_LONG', { platform: 'instagram' }],
      [{ caption: 'Fine caption', hashtags: Array.from({ length: 11 }, (_, i) => `#tag${i}`) }, 'TOO_MANY_HASHTAGS', { platform: 'facebook' }],
      [{ caption: 'We are the Cheapest dentist in town.' }, 'PROHIBITED_PHRASE', { platform: 'facebook' }],
    ];
    for (const [fields, code, over] of cases) {
      await SocialContentCalendarItem.updateMany({ calendar_id: calendar._id }, { $set: { status: 'planned', editedFields: [], publicationIds: [] } });
      const doc = await approvedItem();
      // the stored plan changes underneath the approval (legacy data, a direct edit): the draft step re-checks the text itself
      await SocialContentCalendarItem.updateOne({ _id: doc._id }, { $set: fields });
      const approved = await reload(doc);
      const r = await create(approved, over);
      assert.equal(r.error?.code, code, JSON.stringify(r));
      assert.equal(await SocialPublication.countDocuments({ project_id: project._id }), 0, `${code}: no draft`);
      assert.equal((await reload(doc)).revision, approved.revision, `${code}: the item is untouched`);
    }
  });

  test('P6: it needs the revision the person saw: missing -> refused; stale -> a conflict that creates nothing; two clicks at once -> exactly ONE draft', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy(); await seedCalendar();
    setContentProviderOverride(contentProvider());
    const doc = await approvedItem();
    assert.equal((await generateItemContent(pid, userId, String(doc._id), { platform: 'facebook' })).error.field, 'expectedRevision');
    assert.equal((await create(doc, { expectedRevision: doc.revision - 1 })).error.code, 'ITEM_CONFLICT');
    assert.equal(await SocialPublication.countDocuments({ project_id: project._id }), 0);

    const results = await Promise.all([create(doc), create(doc), create(doc)]);
    assert.equal(results.filter((r) => r.success).length, 1, JSON.stringify(results.map((r) => r.error?.code)));
    assert.ok(results.filter((r) => !r.success).every((r) => ['ITEM_CONFLICT', 'ALREADY_GENERATED'].includes(r.error.code)));
    assert.equal(await SocialPublication.countDocuments({ project_id: project._id }), 1, 'one draft, not three');
  });

  test('P7: once the draft exists it is the source of truth: editing the plan caption afterwards does not touch the draft (and the draft carries the revision it came from)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy(); await seedCalendar();
    const doc = await approvedItem();
    const r = await create(doc);
    assert.equal(r.success, true, JSON.stringify(r.error));
    const linked = await reload(doc);
    ok(await edit(linked, { caption: 'A later edit of the plan caption.' }));
    const pub = await SocialPublication.findById(r.publication.id).lean();
    assert.match(pub.content, /^Brushing twice a day/);
    assert.equal(pub.generation.planRevision, doc.revision);
    assert.notEqual((await reload(doc)).caption, pub.content);
  });

  test('P8: an unapproved plan, a changed strategy and a disconnected platform each refuse before anything is created', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy(); await seedCalendar();
    const doc0 = await first();
    assert.equal((await create(doc0)).error.code, 'PLAN_NOT_APPROVED');
    const doc = await approvedItem();
    await SocialAccount.updateMany({ project_id: project._id, platform: 'facebook' }, { $set: { status: 'revoked' } });
    assert.equal((await create(doc)).error.code, 'PLATFORM_NOT_CONNECTED');
    await SocialAccount.updateMany({ project_id: project._id, platform: 'facebook' }, { $set: { status: 'active' } });
    await seedStrategy();
    assert.equal((await create(doc)).error.code, 'STRATEGY_CHANGED');
    assert.equal(await SocialPublication.countDocuments({ project_id: project._id }), 0);
  });

  test('33: if the strategy changed since the calendar was made, content is NOT generated from the old plan', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy(); await seedCalendar();
    const doc = await first();
    ok(await approveItem(pid, userId, String(doc._id), { expectedRevision: 0 }));
    await seedStrategy();
    const provider = contentProvider();
    setContentProviderOverride(provider);
    const r = await generateItemContent(pid, userId, String(doc._id), { platform: 'facebook', mode: 'ai' });
    assert.equal(r.error.code, 'STRATEGY_CHANGED');
    assert.equal(provider.calls.length, 0);
    assert.equal(await SocialPublication.countDocuments({ project_id: project._id }), 0);
    const state = await getCalendarState(pid);
    assert.equal(state.stale.strategyChanged, true, 'the calendar still reports it is out of date');
    assert.equal(state.items.find((i) => i.id === String(doc._id)).topic, doc.topic, 'and was not changed behind the user\'s back');
  });

  test('34: a failed generation does not link anything or change the item; a generation for a deleted item is dropped', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy(); await seedCalendar();
    const doc = await first();
    ok(await approveItem(pid, userId, String(doc._id), { expectedRevision: 0 }));
    setContentProviderOverride(mockContentProvider({ behavior: () => ({ nonsense: true }) }));
    assert.equal((await generateItemContent(pid, userId, String(doc._id), { platform: 'facebook', mode: 'ai' })).success, true);
    await waitFor(async () => SocialContentGeneration.exists({ project_id: project._id, status: 'failed' }));
    const same = await reload(doc);
    assert.deepEqual(same.publicationIds, []);
    assert.equal(same.status, 'plan_approved');
    assert.equal(await SocialPublication.countDocuments({ project_id: project._id }), 0);
    const failed = await SocialContentGeneration.findOne({ project_id: project._id }).lean();
    assert.equal(String(failed.calendar_item_id), String(doc._id));
  });

  test('35: once a linked publication is scheduled / published the plan is LOCKED; the status follows the publication', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy(); await seedCalendar();
    const doc = await first();
    ok(await approveItem(pid, userId, String(doc._id), { expectedRevision: 0 }));
    setContentProviderOverride(contentProvider());
    await generateItemContent(pid, userId, String(doc._id), { platform: 'facebook', mode: 'ai' });
    const linked = await waitFor(async () => { const d = await reload(doc); return d.publicationIds.length ? d : null; });
    await SocialPublication.updateOne({ _id: linked.publicationIds[0] }, { $set: { status: 'published', publishedAt: new Date() } });
    const state = await getCalendarState(pid);
    const api = state.items.find((i) => i.id === String(doc._id));
    assert.equal(api.effectiveStatus, 'published');
    assert.equal(api.locked, true);
    assert.equal((await edit(linked, { topic: 'Too late' })).error.code, 'ITEM_LOCKED');
    assert.equal((await regenerateItem(pid, userId, String(doc._id), { expectedRevision: linked.revision })).error.code, 'ITEM_LOCKED');
    assert.equal((await reload(doc)).topic, doc.topic);
  });

  // ── manual items ─────────────────────────────────────────────────────────
  const manual = (over = {}) => ({ date: addDays(5), platforms: ['facebook'], format: 'static_post', contentPillar: 'Offers', objective: 'awareness', primaryKpi: 'reach', topic: 'A post I planned myself', primaryCta: 'Learn more', ...over });

  test('36: a manual item is the SAME model: pinned to the calendar\'s strategy, planned, appended, counted in the plan summary', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const strategy = await seedStrategy(); await seedCalendar();
    const before = await items();
    const r = ok(await createItem(pid, userId, manual({ caption: 'My caption', hashtags: ['offer'], hook: 'A hook of my own' })));
    assert.equal(r.item.isManual, true);
    assert.equal(r.item.status, 'planned');
    assert.equal(r.item.revision, 0);
    assert.equal(r.item.caption, 'My caption');
    const saved = await SocialContentCalendarItem.findById(r.item.id).lean();
    assert.equal(String(saved.calendar_id), String(calendar._id));
    assert.equal(String(saved.strategyId), String(strategy._id));
    assert.equal(saved.strategyVersion, strategy.version);
    assert.equal(saved.profileSnapshotHash, strategy.profileSnapshot.hash);
    assert.equal(saved.order, Math.max(...before.map((i) => i.order)) + 1);
    assert.ok(['informational', 'educational', 'soft_sell', 'behind_the_scenes'].includes(saved.contentType), 'a content-mix type of the strategy');
    const plan = (await SocialContentCalendar.findById(calendar._id).lean()).plan;
    assert.equal(plan.totalItems, before.length + 1);
    // and it goes through the same approval / generation path
    ok(await approveItem(pid, userId, r.item.id, { expectedRevision: 0 }));
  });

  test('37: a manual item obeys the same rules (pillar, platform, date range, KPI) and cannot set state or provenance', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy(); await seedCalendar();
    await SocialAccount.updateMany({ project_id: project._id, platform: 'instagram' }, { $set: { status: 'revoked' } });
    const before = await SocialContentCalendarItem.countDocuments({ calendar_id: calendar._id });
    for (const [over, code] of [
      [{ contentPillar: 'Made up' }, 'INVALID_FIELD'], [{ platforms: ['instagram'] }, 'PLATFORM_NOT_CONNECTED'], [{ date: addDays(60) }, 'DATE_OUT_OF_RANGE'], [{ date: '2020-01-01' }, 'DATE_OUT_OF_RANGE'],
      [{ primaryKpi: 'bookings' }, 'KPI_MISMATCH'], [{ topic: '' }, 'INVALID_FIELD'], [{ status: 'plan_approved' }, 'UNKNOWN_FIELD'], [{ strategyId: 'x' }, 'UNKNOWN_FIELD'], [{ contentType: 'hard_sell' }, 'INVALID_FIELD'],
    ]) {
      assert.equal((await createItem(pid, userId, manual(over))).error?.code, code, JSON.stringify(over));
    }
    const { topic: _t, ...noTopic } = manual();
    assert.equal((await createItem(pid, userId, noTopic)).error.code, 'INVALID_FIELD');
    assert.equal(await SocialContentCalendarItem.countDocuments({ calendar_id: calendar._id }), before);
  });

  test('38: nothing in editing, approving or regenerating published, scheduled or sent anything (no network, no publication)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy(); await seedCalendar();
    const doc = await first();
    ok(await edit(doc, { platforms: ['facebook', 'instagram'], topic: 'x y z' }));
    ok(await approveItem(pid, userId, String(doc._id), { expectedRevision: 1 }));
    ok(await revokeItemApproval(pid, userId, String(doc._id), { expectedRevision: 2 }));
    setCalendarProviderOverride(regenProvider());
    ok(await regenerateItem(pid, userId, String(doc._id), { expectedRevision: 3, overwriteEdited: true }));
    assert.equal(await SocialPublication.countDocuments({ project_id: project._id }), 0);
    assert.deepEqual(fetchCalls, []);
  });
  // ── approval + regeneration (Phase 4): the response says what happened to the approval, and approval can never be restored by a stale request ──

  test('R1: regenerating an APPROVED plan whose caption was never edited replaces it, WITHDRAWS the approval and says so - the replacement must be approved again before any post can be made from it', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy(); await seedCalendar();
    const doc = await first();
    ok(await approveItem(pid, userId, String(doc._id), { expectedRevision: doc.revision ?? 0 }));
    const approved = await reload(doc);
    assert.deepEqual([approved.status, approved.editedFields], ['plan_approved', []], 'approved exactly as generated: the caption was never edited');

    setCalendarProviderOverride(regenProvider({ caption: 'A different caption written by the AI for this plan.' }));
    const r = ok(await regenerateItem(pid, userId, String(doc._id), { expectedRevision: approved.revision, fields: ['caption'] }));
    assert.deepEqual([r.approvalStatus, r.approvalRevoked, r.requiresReapproval, r.contentLinked, r.unchanged], ['not_approved', true, true, false, undefined]);
    const saved = await reload(doc);
    assert.notEqual(saved.caption, approved.caption, 'the caption really was replaced');
    assert.deepEqual([saved.status, saved.planApprovedAt, saved.planApprovedBy], ['planned', null, null]);

    // nothing can be made from the replacement until a person approves it
    setContentProviderOverride(contentProvider());
    assert.equal((await create(saved)).error.code, 'PLAN_NOT_APPROVED');
    assert.equal(await SocialPublication.countDocuments({ project_id: project._id }), 0);
    // the approval given to the OLD plan cannot be replayed onto the new one
    assert.equal((await approveItem(pid, userId, String(doc._id), { expectedRevision: approved.revision })).error.code, 'ITEM_CONFLICT');
    assert.equal((await reload(doc)).status, 'planned');
    // approving the NEW revision is the only way back
    ok(await approveItem(pid, userId, String(doc._id), { expectedRevision: saved.revision }));
    assert.equal((await reload(doc)).status, 'plan_approved');
  });

  test('R2: when the AI lands on EXACTLY the stored words, nothing is written - the revision, the edit markers and the approval stay, and the response says "unchanged"', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy(); await seedCalendar();
    const doc = await first();
    ok(await approveItem(pid, userId, String(doc._id), { expectedRevision: doc.revision ?? 0 }));
    const approved = await reload(doc);
    setCalendarProviderOverride(mockCalendarProvider({ behavior: ({ slots }) => ({ items: slots.map((s) => validRawCalendarItem(s, { topic: approved.topic })) }) }));
    const r = ok(await regenerateItem(pid, userId, String(doc._id), { expectedRevision: approved.revision, fields: ['topic'] }));
    assert.deepEqual([r.unchanged, r.regenerated, r.approvalStatus, r.approvalRevoked, r.requiresReapproval], [true, [], 'approved', false, false]);
    const saved = await reload(doc);
    assert.deepEqual([saved.status, saved.revision], ['plan_approved', approved.revision], 'no revision bump');
    assert.equal(saved.planApprovedAt.getTime(), approved.planApprovedAt.getTime(), 'the approval itself is untouched');
    assert.equal(saved.updatedAt.getTime(), approved.updatedAt.getTime(), 'nothing was written at all');
    // a different result for the same request is a real change and does withdraw it (the control case)
    setCalendarProviderOverride(regenProvider());
    const changed = ok(await regenerateItem(pid, userId, String(doc._id), { expectedRevision: approved.revision, fields: ['topic'] }));
    assert.deepEqual([changed.unchanged, changed.approvalRevoked, changed.approvalStatus], [undefined, true, 'not_approved']);
  });

  test('R3: a stale revision cannot regenerate (or re-approve) anything: the AI is not even asked and the approval is exactly as it was', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy(); await seedCalendar();
    const doc = await first();
    ok(await approveItem(pid, userId, String(doc._id), { expectedRevision: doc.revision ?? 0 }));
    const approved = await reload(doc);
    const provider = regenProvider();
    setCalendarProviderOverride(provider);
    const stale = await regenerateItem(pid, userId, String(doc._id), { expectedRevision: approved.revision - 1, fields: ['caption'] });
    assert.equal(stale.error.code, 'ITEM_CONFLICT');
    assert.equal(stale.error.item.status, 'plan_approved', 'the conflict hands back the CURRENT item');
    assert.equal(provider.calls.length, 0);
    assert.equal((await regenerateItem(pid, userId, String(doc._id), { fields: ['caption'] })).error.code, 'INVALID_FIELD', 'no revision at all is refused too');
    const saved = await reload(doc);
    assert.deepEqual([saved.status, saved.revision, saved.caption], ['plan_approved', approved.revision, approved.caption]);
  });

  test('R4: edited by someone else while the AI works on an APPROVED plan: the regeneration is discarded, their edit survives, and the approval state is the one THEIR edit produced', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy(); await seedCalendar();
    const doc = await first();
    ok(await approveItem(pid, userId, String(doc._id), { expectedRevision: doc.revision ?? 0 }));
    const approved = await reload(doc);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    setCalendarProviderOverride(mockCalendarProvider({ gate, behavior: ({ slots }) => ({ items: slots.map((s) => validRawCalendarItem(s, { caption: 'Late AI caption that must never land' })) }) }));
    const pending = regenerateItem(pid, userId, String(doc._id), { expectedRevision: approved.revision, fields: ['caption'] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    ok(await updateItem(pid, userId, String(doc._id), { expectedRevision: approved.revision, topic: 'Edited while the AI worked' }));
    release();
    const r = await pending;
    assert.equal(r.error.code, 'ITEM_CONFLICT');
    const saved = await reload(doc);
    assert.equal(saved.topic, 'Edited while the AI worked');
    assert.equal(saved.caption, approved.caption, 'the late AI caption was not applied');
    assert.equal(saved.status, 'edited', 'the edit reopened the plan; the discarded regeneration did not change that');
    assert.equal(saved.planApprovedAt, null);
  });

  test('R5: approved by someone else while the AI works: the regeneration is discarded, so the approval stays attached to the content that was actually approved', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy(); await seedCalendar();
    const doc = await first();
    const before = await reload(doc);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    setCalendarProviderOverride(mockCalendarProvider({ gate, behavior: ({ slots }) => ({ items: slots.map((s) => validRawCalendarItem(s, { caption: 'Late AI caption that was never reviewed' })) }) }));
    const pending = regenerateItem(pid, userId, String(doc._id), { expectedRevision: before.revision ?? 0, fields: ['caption'] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    ok(await approveItem(pid, userId, String(doc._id), { expectedRevision: before.revision ?? 0 }));
    release();
    assert.equal((await pending).error.code, 'ITEM_CONFLICT');
    const saved = await reload(doc);
    assert.equal(saved.status, 'plan_approved');
    assert.equal(saved.caption, before.caption, 'the approved caption is the one the person reviewed, not the late one');
  });

  test('R6: when an unchanged AI answer arrives after the item changed, it is a conflict - never a quiet "unchanged" that would keep a stale approval', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy(); await seedCalendar();
    const doc = await first();
    ok(await approveItem(pid, userId, String(doc._id), { expectedRevision: doc.revision ?? 0 }));
    const approved = await reload(doc);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    setCalendarProviderOverride(mockCalendarProvider({ gate, behavior: ({ slots }) => ({ items: slots.map((s) => validRawCalendarItem(s, { topic: approved.topic })) }) }));
    const pending = regenerateItem(pid, userId, String(doc._id), { expectedRevision: approved.revision, fields: ['topic'] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    ok(await updateItem(pid, userId, String(doc._id), { expectedRevision: approved.revision, caption: 'Edited while the AI worked' }));
    release();
    const r = await pending;
    assert.equal(r.error?.code, 'ITEM_CONFLICT', JSON.stringify(r));
    assert.equal((await reload(doc)).status, 'edited');
  });

  test('R7: once a post exists for the plan its approval is NOT withdrawn by a regeneration, the post keeps its own reviewed caption, and the response says both', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy(); await seedCalendar();
    setContentProviderOverride(contentProvider());
    const doc = await approvedItem();
    const made = await create(doc);
    assert.equal(made.success, true, JSON.stringify(made.error));
    const draftBefore = await SocialPublication.findById(made.publication.id).lean();
    const linked = await reload(doc);
    setCalendarProviderOverride(regenProvider());
    const r = ok(await regenerateItem(pid, userId, String(doc._id), { expectedRevision: linked.revision, fields: ['caption'], overwriteEdited: true }));
    assert.deepEqual([r.approvalStatus, r.approvalRevoked, r.requiresReapproval, r.contentLinked], ['approved', false, false, true]);
    assert.ok(r.warnings.some((w) => /already created from this plan/.test(w)));
    const draftAfter = await SocialPublication.findById(made.publication.id).lean();
    assert.equal(draftAfter.content, draftBefore.content, 'the reviewed post text is untouched');
    assert.equal(draftAfter.status, 'draft');
    assert.equal((await reload(doc)).status, 'content_generated');
  });

  test('R8: a person\'s own edit reports its approval outcome with the same fields (so every client reads one shape)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await seedStrategy(); await seedCalendar();
    const doc = await first();
    ok(await approveItem(pid, userId, String(doc._id), { expectedRevision: doc.revision ?? 0 }));
    const approved = await reload(doc);
    const r = ok(await updateItem(pid, userId, String(doc._id), { expectedRevision: approved.revision, topic: 'Reworded topic' }));
    assert.deepEqual([r.approvalStatus, r.approvalRevoked, r.requiresReapproval, r.contentLinked], ['not_approved', true, true, false]);
    const plain = ok(await updateItem(pid, userId, String(doc._id), { expectedRevision: r.item.revision, angle: 'A new angle' }));
    assert.deepEqual([plain.approvalStatus, plain.approvalRevoked], ['not_approved', false], 'already open: nothing further to withdraw');
  });
});
