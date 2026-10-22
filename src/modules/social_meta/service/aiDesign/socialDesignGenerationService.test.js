import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import sharp from 'sharp';
import { promises as fsp } from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SeoProject from '../../../app_user/model/SeoProject.js';
import SocialAccount from '../../model/SocialAccount.js';
import SocialAIStrategy from '../../model/SocialAIStrategy.js';
import SocialDesignGeneration from '../../model/SocialDesignGeneration.js';
import SocialContentCalendarItem from '../../model/SocialContentCalendarItem.js';
import SocialProduct from '../../model/SocialProduct.js';
import SocialBusinessProfile from '../../model/SocialBusinessProfile.js';
import SocialPublication from '../../model/SocialPublication.js';
import SocialApprovalSettings from '../../model/SocialApprovalSettings.js';
import adapters from '../platformAdapters/index.js';
import mediaStorageService from '../media/mediaStorageService.js';
import {
  createPublication, submitContentForApproval, approveContent, approveDesign, updatePublication, requestDesignChanges,
} from '../socialPublishingService.js';
import {
  startDesignGeneration, runDesignGeneration, getDesignGenerationStatus, recoverStaleDesignGenerations,
  setDesignProviderOverride, resetDesignProviderOverride, DESIGN_FAILURE_MESSAGES,
} from './socialDesignGenerationService.js';
import { DESIGN_STALE_MS } from './designConfig.js';
import { setDesignComposerOverride } from './designProducer.js';
import { PROVIDER_ERROR } from '../aiContent/providers/contentProviderErrors.js';
import { IMAGE_REFUSED } from './providers/openAIImageProvider.js';
import { validRawStrategy, providerError } from '../../testSupport/aiStrategyFixtures.js';
import { mockImageProvider, makeImage, removeProjectMedia, listProjectMedia } from '../../testSupport/designFixtures.js';

/**
 * Real MongoDB, real sharp, real files under storage/social_media/, scripted image provider. Proves that a
 * content_approved post gets ONE stored image attached through the existing versioning and goes to design_review
 * through the existing submitDesign - and that nothing stale, forged, duplicated, scheduled, published or leaked can happen.
 */

let mongoAvailable = false;
before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
    await SocialDesignGeneration.init();
  } catch { mongoAvailable = false; }
});
after(async () => {
  resetDesignProviderOverride();
  if (mongoAvailable) await mongoose.connection.close();
});

const SNAPSHOT = () => ({
  business: { name: 'Acme Dental', description: 'Family dentistry in Leeds', category: 'Dentist', location: { city: 'Leeds', country: 'UK' } },
  audience: { primary: 'Young families' }, toneOfVoice: { primary: 'Warm' }, brand: { primaryColor: '#1d4ed8' }, offers: [], competitors: [], prohibitedPhrases: [],
});

describe('AI design generation (real MongoDB + sharp + storage, scripted provider)', () => {
  let userId, reviewerId, project, pid, created, fb, ig, metaCalls, realFetch, fetchCalls, captured, realConsole;
  const track = (d) => { created.push(d); return d; };
  const original = {};

  async function seedPost({ platform = 'facebook', approve = true, content = 'Brushing for two minutes protects your smile. Book a check-up', media = [], generation = null } = {}) {
    const account = platform === 'facebook' ? fb : ig;
    const r = await createPublication(pid, userId, { platform, socialAccountId: account._id.toString(), content, media, ...(generation ? { generation } : {}) });
    assert.equal(r.success, true, 'seed create');
    let pub = r.publication;
    if (approve) {
      assert.equal((await submitContentForApproval(pid, pub.id, userId)).success, true);
      const a = await approveContent(pid, pub.id, reviewerId, 1);
      assert.equal(a.success, true, JSON.stringify(a));
      pub = a.publication;
    }
    return pub;
  }
  const row = (id) => SocialPublication.findById(id).lean();
  const gen = (provider, pub, extra = {}, id = pid, uid = userId) => {
    setDesignProviderOverride(provider);
    return startDesignGeneration(id, uid, { publicationId: pub.id, contentVersion: 1, ...extra }, { background: false });
  };
  const waitDone = async (id) => { for (let i = 0; i < 300; i += 1) { if (!(await SocialDesignGeneration.findById(id).lean()).active) return; await new Promise((r) => setTimeout(r, 20)); } throw new Error('did not finish'); };

  before(() => { for (const p of ['facebook', 'instagram']) for (const m of ['publish', 'remove', 'reconcile']) original[`${p}.${m}`] = adapters[p][m]; });

  beforeEach(async () => {
    if (!mongoAvailable) return;
    created = [];
    userId = new mongoose.Types.ObjectId();
    reviewerId = new mongoose.Types.ObjectId();
    project = track(await SeoProject.create({ user_id: userId, project_name: `Design ${Date.now()} ${Math.random().toString(36).slice(2, 8)}`, main_url: 'https://example.com', seo_scope: 'local', keywords: ['k'], description: 'Family dental practice' }));
    pid = project._id.toString();
    fb = await SocialAccount.create({ user_id: userId, project_id: project._id, platform: 'facebook', platformAccountId: 'pgd', platformAccountName: 'Page', accountType: 'page', pageId: 'pgd', accessToken: 'FB-SECRET-TOKEN', status: 'active', isActive: true });
    ig = await SocialAccount.create({ user_id: userId, project_id: project._id, platform: 'instagram', platformAccountId: 'igd', platformAccountName: 'IG', accountType: 'business', pageId: 'pgd', accessToken: 'IG-SECRET-TOKEN', status: 'active' });
    await SocialAIStrategy.create({ project_id: project._id, version: 1, status: 'ready', strategy: { ...validRawStrategy(), brandRules: { visualGuidelines: ['Bright, clean photography'], prohibitedPhrases: [] } }, profileSnapshot: { generatedAt: new Date(), hash: 'h', data: SNAPSHOT() }, generation: { startedAt: new Date(), finishedAt: new Date() } });
    metaCalls = [];
    for (const p of ['facebook', 'instagram']) for (const m of ['publish', 'remove', 'reconcile']) adapters[p][m] = async () => { metaCalls.push(`${p}.${m}`); return { success: false }; };
    fetchCalls = [];
    realFetch = globalThis.fetch;
    globalThis.fetch = async (...a) => { fetchCalls.push(String(a[0])); throw new Error('network is not available in this test'); };
    captured = [];
    realConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
    for (const k of Object.keys(realConsole)) console[k] = (...a) => { captured.push(a.map(String).join(' ')); };
  });

  afterEach(async () => {
    if (realConsole) for (const k of Object.keys(realConsole)) console[k] = realConsole[k];
    resetDesignProviderOverride();
    globalThis.fetch = realFetch;
    for (const key of Object.keys(original)) { const [p, m] = key.split('.'); adapters[p][m] = original[key]; }
    if (!mongoAvailable) return;
    const ids = created.map((d) => d._id);
    await Promise.all([
      SocialDesignGeneration.deleteMany({ project_id: { $in: ids } }), SocialPublication.deleteMany({ project_id: { $in: ids } }),
      SocialContentCalendarItem.deleteMany({ project_id: { $in: ids } }), SocialProduct.deleteMany({ project_id: { $in: ids } }), SocialBusinessProfile.deleteMany({ project_id: { $in: ids } }),
      SocialAIStrategy.deleteMany({ project_id: { $in: ids } }), SocialApprovalSettings.deleteMany({ project_id: { $in: ids } }), SocialAccount.deleteMany({ project_id: { $in: ids } }),
    ]);
    await SeoProject.deleteMany({ _id: { $in: ids } });
    for (const id of ids) await removeProjectMedia(id);
  });

  // ── the happy path ─────────────────────────────────────────────────────────
  test('1: content_approved -> a real stored image is attached, designVersion 2, and the post is in design_review via submitDesign', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const pub = await seedPost();
    assert.equal((await row(pub.id)).approvalState, 'content_approved');
    const provider = mockImageProvider();
    const r = await gen(provider, pub);
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(r.generation.status, 'ready');
    assert.equal(r.generation.designVersion, 2);
    assert.equal(provider.calls.length, 1);

    const after = await row(pub.id);
    assert.equal(after.approvalState, 'design_review');
    assert.equal(after.status, 'draft');
    assert.equal(after.designVersion, 2);
    assert.equal(after.contentVersion, 1);
    assert.equal(after.media.length, 1);
    assert.equal(after.media[0].type, 'image');
    assert.equal(mediaStorageService.isOwnedUrl(after.media[0].url), true);
    assert.match(after.media[0].url, new RegExp(`/storage/social_media/${pid}/[0-9a-f-]{36}\\.jpg$`));
    assert.equal((await listProjectMedia(pid)).length, 1, 'the file really exists');
    assert.equal(after.designSubmittedAt instanceof Date, true);
    assert.equal(after.scheduledAt ?? null, null);
    assert.equal(after.externalPostId ?? null, null);
    assert.equal(after.design.source, 'ai');
    assert.equal(after.design.contentVersion, 1);
    assert.equal(after.design.designVersion, 2);
  });

  test('2: nothing reaches Meta or the network, and nothing is scheduled or published', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const pub = await seedPost();
    await gen(mockImageProvider(), pub);
    assert.deepEqual(metaCalls, []);
    assert.deepEqual(fetchCalls, []);
    assert.equal(await SocialPublication.countDocuments({ project_id: project._id, status: { $ne: 'draft' } }), 0);
  });

  test('3: an Instagram draft (text only, the known gap) gets its design: square, JPEG, in design_review', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const pub = await seedPost({ platform: 'instagram' });
    const provider = mockImageProvider();
    const r = await gen(provider, pub);
    assert.equal(r.generation.status, 'ready');
    assert.ok(['1024x1024', '1536x1024', '1024x1536'].includes(provider.calls[0].size), 'the photograph is requested at a size the model supports');
    const after = await row(pub.id);
    assert.equal(after.approvalState, 'design_review');
    assert.equal(after.platform, 'instagram');
    const meta = await sharp(await storedFile(after.media[0].url)).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height], ['jpeg', 1024, 1024], 'the FINISHED design is the platform\'s square, not the photograph\'s shape');
  });

  test('4: the Facebook design is landscape; the photograph prompt is built on the server from the business, the scene and the brand - and carries no words of the post', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const pub = await seedPost({ content: 'Meet the friendly team behind your smile', generation: { source: 'ai', type: 'social_content', strategyVersion: 1, contentPillar: 'Meet the team', objective: 'behind_the_scenes' } });
    const provider = mockImageProvider();
    const r = await gen(provider, pub);
    assert.equal(r.generation.creative.type, 'team_story');
    assert.equal(r.generation.creative.layoutId, 'photo_hero');
    assert.equal(provider.calls.length, 1);
    const p = provider.calls[0].prompt;
    assert.match(p, /<scene>\n[^\n]*(clinic|patient|professional)/i, 'a dental practice gets a clinic scene');
    assert.match(p, /category: Dentist/);
    assert.match(p, /#1d4ed8/, 'the brand colour grades the photograph');
    assert.match(p, /NO text of any kind/);
    assert.equal(p.includes('friendly team behind your smile'), false, 'the post\'s words are drawn by Odito, never sent to the image model');
    const meta = await sharp(await storedFile((await row(pub.id)).media[0].url)).metadata();
    assert.deepEqual([meta.width, meta.height], [1536, 1024]);
  });

  test('5: design approval switched off -> the first design is auto-approved by the existing submitDesign (design_approved), still a draft', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialApprovalSettings.create({ project_id: project._id, contentApprovalRequired: true, designApprovalRequired: false });
    const pub = await seedPost();
    assert.equal((await row(pub.id)).approvalState, 'design_approved', 'content approval already auto-approves the design stage');
    // with design approval off the post is already design_approved with no media: replacing is allowed, no review stage is invented
    const r = await gen(mockImageProvider(), pub);
    assert.equal(r.success, true, JSON.stringify(r));
    const after = await row(pub.id);
    assert.equal(after.approvalState, 'design_approved');
    assert.equal(after.status, 'draft');
    assert.equal(after.media.length, 1);
  });

  // ── state / version / authorization rules ──────────────────────────────────
  test('6: a draft that is not in the workflow, and a post in content_review, are refused CONTENT_NOT_APPROVED - the provider is never called', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const provider = mockImageProvider();
    const unmanaged = await seedPost({ approve: false });
    assert.equal((await gen(provider, unmanaged)).error.code, 'CONTENT_NOT_APPROVED');
    const inReview = await seedPost({ approve: false });
    await submitContentForApproval(pid, inReview.id, userId);
    assert.equal((await gen(provider, inReview)).error.code, 'CONTENT_NOT_APPROVED');
    assert.equal(provider.calls.length, 0);
    assert.equal(await SocialDesignGeneration.countDocuments({ project_id: project._id }), 0);
  });

  test('6b: content_approved but the CURRENT caption is not the one that was approved (version drift) -> CONTENT_NOT_APPROVED', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const pub = await seedPost();
    await SocialPublication.updateOne({ _id: pub.id }, { $set: { contentApprovedVersion: 0 } });
    const provider = mockImageProvider();
    const r = await gen(provider, pub);
    assert.equal(r.error.code, 'CONTENT_NOT_APPROVED');
    assert.match(r.error.message, /current caption has not been approved/);
    assert.equal(provider.calls.length, 0);
  });

  test('7: a scheduled/published/cancelled post is refused DESIGN_NOT_ALLOWED', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const pub = await seedPost();
    await SocialPublication.updateOne({ _id: pub.id }, { $set: { status: 'scheduled', scheduledAt: new Date(Date.now() + 3_600_000) } });
    const provider = mockImageProvider();
    assert.equal((await gen(provider, pub)).error.code, 'DESIGN_NOT_ALLOWED');
    assert.equal(provider.calls.length, 0);
  });

  test('8: a stale or forged contentVersion is refused VERSION_MISMATCH with the real current version; missing/garbage versions are refused', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const pub = await seedPost();
    const provider = mockImageProvider();
    const stale = await gen(provider, pub, { contentVersion: 5 });
    assert.equal(stale.error.code, 'VERSION_MISMATCH');
    assert.equal(stale.error.currentContentVersion, 1);
    for (const contentVersion of [undefined, null, 0, -1, 1.5, '1', NaN, {}]) assert.equal((await gen(provider, pub, { contentVersion })).error.code, 'INVALID_VERSION', String(contentVersion));
    assert.equal(provider.calls.length, 0);
  });

  test('9: invalid / foreign / unknown publication ids are the same safe NOT_FOUND (no existence leak)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const mine = await seedPost();
    const owner2 = new mongoose.Types.ObjectId();
    const other = track(await SeoProject.create({ user_id: owner2, project_name: `Design other ${Date.now()}`, main_url: 'https://example.org', seo_scope: 'local', keywords: ['k'] }));
    const provider = mockImageProvider();
    setDesignProviderOverride(provider);
    const foreign = await startDesignGeneration(other._id.toString(), owner2, { publicationId: mine.id, contentVersion: 1 }, { background: false });
    const unknown = await startDesignGeneration(pid, userId, { publicationId: new mongoose.Types.ObjectId().toString(), contentVersion: 1 }, { background: false });
    assert.equal(foreign.error.code, 'NOT_FOUND');
    assert.deepEqual(foreign.error, { ...unknown.error }, 'identical to a publication that does not exist');
    for (const publicationId of ['nope', '', undefined, null, 5, {}, ['x']]) assert.equal((await startDesignGeneration(pid, userId, { publicationId, contentVersion: 1 }, { background: false })).error.code, 'INVALID_PUBLICATION');
    assert.equal(provider.calls.length, 0);
    assert.equal((await getDesignGenerationStatus(other._id.toString(), { publicationId: mine.id })).error.code, 'NOT_FOUND');
  });

  test('10: a disconnected platform account is refused PLATFORM_NOT_CONNECTED; the account is the post\'s own, never a client value', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const pub = await seedPost();
    await SocialAccount.updateOne({ _id: fb._id }, { $set: { status: 'expired' } });
    const provider = mockImageProvider();
    assert.equal((await gen(provider, pub, { platform: 'instagram', socialAccountId: ig._id.toString(), connected: true })).error.code, 'PLATFORM_NOT_CONNECTED');
    assert.equal(provider.calls.length, 0);
  });

  test('11: an already-approved design is only replaced on purpose (replaceApproved), and then goes back to design review as a NEW version', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const pub = await seedPost();
    await gen(mockImageProvider(), pub);
    assert.equal((await approveDesign(pid, pub.id, reviewerId, 2)).success, true);
    assert.equal((await row(pub.id)).approvalState, 'design_approved');
    const provider = mockImageProvider();
    assert.equal((await gen(provider, pub)).error.code, 'DESIGN_ALREADY_APPROVED');
    assert.equal(provider.calls.length, 0);
    const before = await row(pub.id);

    const again = await gen(provider, pub, { replaceApproved: true });
    assert.equal(again.generation.status, 'ready');
    const after = await row(pub.id);
    assert.equal(after.designVersion, 3);
    assert.equal(after.approvalState, 'design_review', 'the earlier design approval is withdrawn');
    assert.equal(after.designApprovedVersion ?? null, null);
    assert.notEqual(after.media[0].url, before.media[0].url);
    assert.equal(after.contentVersion, 1);
    assert.equal(after.contentApprovedVersion, 1, 'the content approval is untouched');
  });

  test('12: regenerating after "request changes" creates a new design version and the change request is answered', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const pub = await seedPost();
    await gen(mockImageProvider(), pub);
    assert.equal((await requestDesignChanges(pid, pub.id, reviewerId, { version: 2, reason: 'Make it brighter' })).success, true);
    const r = await gen(mockImageProvider(), pub);
    assert.equal(r.generation.status, 'ready');
    assert.equal(r.generation.designVersion, 3);
    const after = await row(pub.id);
    assert.equal(after.designVersion, 3);
    assert.equal(after.approvalState, 'design_review');
    assert.equal(after.media.length, 1);
  });

  // ── content / design version safety ────────────────────────────────────────
  test('13: the caption edited while the image is being drawn -> the new image is DISCARDED, the newer post is untouched, the file is deleted', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const pub = await seedPost();
    let release;
    const gate = new Promise((res) => { release = res; });
    setDesignProviderOverride(mockImageProvider({ gate }));
    const started = await startDesignGeneration(pid, userId, { publicationId: pub.id, contentVersion: 1 }, { background: true });
    const edit = await updatePublication(pid, pub.id, userId, { content: 'A completely new caption' });
    assert.equal(edit.success, true);
    assert.equal((await row(pub.id)).contentVersion, 2);
    assert.equal((await row(pub.id)).approvalState, 'content_review');
    release();
    await waitDone(started.generation.id);

    const rec = await SocialDesignGeneration.findById(started.generation.id).lean();
    assert.equal(rec.status, 'failed');
    assert.equal(rec.failure.code, 'DESIGN_STALE');
    assert.equal(rec.failure.message, DESIGN_FAILURE_MESSAGES.DESIGN_STALE);
    const after = await row(pub.id);
    assert.equal(after.content, 'A completely new caption');
    assert.equal(after.approvalState, 'content_review', 'not moved backward or forward');
    assert.deepEqual(after.media, []);
    assert.equal(after.designVersion, 1);
    assert.deepEqual(await listProjectMedia(pid), [], 'the orphan file was removed');
  });

  test('13b: content approval NOT required: the caption edited while drawing keeps the post in content_approved, yet the image for the OLD version is still discarded', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialApprovalSettings.create({ project_id: project._id, contentApprovalRequired: false, designApprovalRequired: true });
    const pub = await seedPost({ approve: false });
    assert.equal((await submitContentForApproval(pid, pub.id, userId)).success, true);
    assert.equal((await row(pub.id)).approvalState, 'content_approved');
    let release;
    const gate = new Promise((res) => { release = res; });
    setDesignProviderOverride(mockImageProvider({ gate }));
    const started = await startDesignGeneration(pid, userId, { publicationId: pub.id, contentVersion: 1 }, { background: true });
    assert.equal((await updatePublication(pid, pub.id, userId, { content: 'A different caption, auto-approved again' })).success, true);
    const mid = await row(pub.id);
    assert.equal(mid.contentVersion, 2);
    assert.equal(mid.approvalState, 'content_approved', 'same approval state as when generation started');
    release();
    await waitDone(started.generation.id);
    const after = await row(pub.id);
    assert.deepEqual(after.media, [], 'the image drawn for caption v1 is not attached to caption v2');
    assert.equal(after.designVersion, 1);
    assert.equal(after.approvalState, 'content_approved');
    assert.equal((await SocialDesignGeneration.findById(started.generation.id).lean()).failure.code, 'DESIGN_STALE');
    assert.deepEqual(await listProjectMedia(pid), []);
  });

  test('14: the design replaced by hand while generating -> the AI image does not overwrite it', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const pub = await seedPost();
    let release;
    const gate = new Promise((res) => { release = res; });
    setDesignProviderOverride(mockImageProvider({ gate }));
    const started = await startDesignGeneration(pid, userId, { publicationId: pub.id, contentVersion: 1 }, { background: true });
    const handUrl = (await mediaStorageService.upload({ buffer: await makeImage({ width: 800, height: 800, format: 'jpeg' }), projectId: pid, extension: '.jpg' })).url;
    assert.equal((await updatePublication(pid, pub.id, userId, { media: [{ url: handUrl, type: 'image' }] })).success, true);
    release();
    await waitDone(started.generation.id);
    const after = await row(pub.id);
    assert.deepEqual(after.media.map((m) => m.url), [handUrl], 'the hand-uploaded design is still the design');
    assert.equal(after.designVersion, 2);
    assert.equal((await SocialDesignGeneration.findById(started.generation.id).lean()).failure.code, 'DESIGN_STALE');
    assert.deepEqual(await listProjectMedia(pid), [handUrl.split('/').pop()]);
  });

  test('15: the post scheduled while generating -> nothing is attached to a non-draft', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const pub = await seedPost();
    let release;
    const gate = new Promise((res) => { release = res; });
    setDesignProviderOverride(mockImageProvider({ gate }));
    const started = await startDesignGeneration(pid, userId, { publicationId: pub.id, contentVersion: 1 }, { background: true });
    await SocialPublication.updateOne({ _id: pub.id }, { $set: { status: 'scheduled', scheduledAt: new Date(Date.now() + 3_600_000) } });
    release();
    await waitDone(started.generation.id);
    assert.equal((await row(pub.id)).media.length, 0);
    assert.equal((await SocialDesignGeneration.findById(started.generation.id).lean()).status, 'failed');
    assert.deepEqual(await listProjectMedia(pid), []);
  });

  // ── provider / media / storage failures ────────────────────────────────────
  test('16: provider failures map to user-safe codes; the provider text, key and prompt are never stored or returned; no media, no state change', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const pub = await seedPost();
    const cases = [
      [PROVIDER_ERROR.RATE_LIMITED, 'AI_BUSY'], [PROVIDER_ERROR.UNAVAILABLE, 'AI_BUSY'], [PROVIDER_ERROR.TIMEOUT, 'AI_TIMEOUT'], [PROVIDER_ERROR.NETWORK, 'AI_UNREACHABLE'],
      [PROVIDER_ERROR.BAD_OUTPUT, 'AI_BAD_OUTPUT'], [PROVIDER_ERROR.AUTH, 'AI_UNAVAILABLE'], [PROVIDER_ERROR.QUOTA, 'AI_UNAVAILABLE'], [PROVIDER_ERROR.NOT_CONFIGURED, 'AI_UNAVAILABLE'],
      [IMAGE_REFUSED, 'DESIGN_REJECTED'], [PROVIDER_ERROR.FAILED, 'GENERATION_FAILED'], ['SOMETHING_UNEXPECTED', 'GENERATION_FAILED'],
    ];
    for (const [providerCode, expected] of cases) {
      const provider = mockImageProvider({ behavior: () => { throw providerError(providerCode, { message: 'sk-SECRET-KEY upstream said: <prompt text>' }); } });
      const r = await gen(provider, pub);
      assert.equal(r.generation.status, 'failed', providerCode);
      assert.equal(r.generation.failure.code, expected, providerCode);
      const stored = JSON.stringify(await SocialDesignGeneration.find({ project_id: project._id }).lean());
      assert.equal(stored.includes('sk-SECRET'), false);
      assert.equal(stored.includes('prompt text'), false);
      assert.equal(JSON.stringify(r).includes('sk-SECRET'), false);
      await SocialDesignGeneration.deleteMany({ project_id: project._id });
    }
    const after = await row(pub.id);
    assert.equal(after.approvalState, 'content_approved');
    assert.deepEqual(after.media, []);
    assert.equal(after.designVersion, 1);
    assert.deepEqual(await listProjectMedia(pid), []);
  });

  test('17: an unusable photograph (garbage, SVG with script, empty) -> MEDIA_INVALID, nothing stored or attached; an unusual SHAPE is simply cropped to its frame', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const pub = await seedPost({ platform: 'instagram' });
    const bads = [Buffer.from('not an image at all'), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), Buffer.alloc(0)];
    for (const bad of bads) {
      const r = await gen(mockImageProvider({ behavior: () => bad }), pub);
      assert.equal(r.generation.status, 'failed');
      assert.equal(r.generation.failure.code, 'MEDIA_INVALID');
      await SocialDesignGeneration.deleteMany({ project_id: project._id });
    }
    assert.deepEqual(await listProjectMedia(pid), []);
    const after = await row(pub.id);
    assert.deepEqual(after.media, []);
    assert.equal(after.approvalState, 'content_approved');
    // a very wide or a tiny photograph is a valid picture: the composer crops it to the frame, so the finished design is still the platform's size
    for (const odd of [await makeImage({ width: 2400, height: 800 }), await makeImage({ width: 100, height: 100 })]) {
      const r = await gen(mockImageProvider({ behavior: () => odd }), await seedPost({ platform: 'instagram' }));
      assert.equal(r.generation.status, 'ready', JSON.stringify(r.generation.failure));
      const meta = await sharp(await storedFile((await SocialPublication.findOne({ project_id: project._id, designVersion: 2 }).sort({ updatedAt: -1 }).lean()).media[0].url)).metadata();
      assert.deepEqual([meta.width, meta.height], [1024, 1024]);
    }
  });

  test('18: a storage failure -> STORAGE_FAILED, nothing attached, no half-written state', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const pub = await seedPost();
    const originalUpload = mediaStorageService.upload;
    mediaStorageService.upload = async () => { throw new Error('ENOSPC: no space left on device, write /var/secret/path'); };
    try {
      const r = await gen(mockImageProvider(), pub);
      assert.equal(r.generation.failure.code, 'STORAGE_FAILED');
      assert.equal(JSON.stringify(r).includes('/var/secret'), false);
    } finally { mediaStorageService.upload = originalUpload; }
    assert.deepEqual((await row(pub.id)).media, []);
    assert.equal((await row(pub.id)).approvalState, 'content_approved');
  });

  test('19: AI not configured -> AI_UNAVAILABLE and nothing is claimed', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const pub = await seedPost();
    const r = await gen(mockImageProvider({ available: false }), pub);
    assert.equal(r.error.code, 'AI_UNAVAILABLE');
    assert.equal(await SocialDesignGeneration.countDocuments({ project_id: project._id }), 0);
  });

  // ── concurrency / idempotency / recovery ───────────────────────────────────
  test('20: a burst of simultaneous requests (double click, two tabs) -> ONE claim, ONE provider call, ONE image, designVersion 2', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const pub = await seedPost();
    let release;
    const gate = new Promise((res) => { release = res; });
    const provider = mockImageProvider({ gate });
    setDesignProviderOverride(provider);
    const results = await Promise.all(Array.from({ length: 6 }, () => startDesignGeneration(pid, userId, { publicationId: pub.id, contentVersion: 1 }, { background: true })));
    assert.equal(results.filter((r) => r.started).length, 1, 'the partial unique index allows one claim');
    assert.equal(results.filter((r) => r.alreadyRunning).length, 5);
    assert.equal(new Set(results.map((r) => r.generation.id)).size, 1);
    release();
    await waitDone(results[0].generation.id);
    assert.equal(provider.calls.length, 1);
    assert.equal(await SocialDesignGeneration.countDocuments({ project_id: project._id }), 1);
    assert.equal((await listProjectMedia(pid)).length, 1);
    const after = await row(pub.id);
    assert.equal(after.designVersion, 2);
    assert.equal(after.media.length, 1);
  });

  test('21: different publications generate independently; the lock is per publication, not per project', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const a = await seedPost();
    const b = await seedPost();
    const [ra, rb] = await Promise.all([gen(mockImageProvider(), a), gen(mockImageProvider(), b)]);
    assert.equal(ra.generation.status, 'ready');
    assert.equal(rb.generation.status, 'ready');
    assert.equal((await row(a.id)).designVersion, 2);
    assert.equal((await row(b.id)).designVersion, 2);
  });

  test('22: after a generation ends, the same post can be generated again (no stale lock)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const pub = await seedPost();
    await gen(mockImageProvider(), pub);
    await SocialDesignGeneration.countDocuments({ project_id: project._id, active: true }).then((n) => assert.equal(n, 0));
    const second = await gen(mockImageProvider(), pub);
    assert.equal(second.generation.status, 'ready');
    assert.equal((await row(pub.id)).designVersion, 3);
  });

  test('23: an interrupted generation is failed after the stale window; the dead run cannot attach media afterwards; a fresh request works', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const pub = await seedPost();
    const old = new Date(Date.now() - DESIGN_STALE_MS - 60_000);
    const rec = await SocialDesignGeneration.create({
      project_id: project._id, publication_id: pub.id, status: 'generating', active: true, platform: 'facebook', contentVersion: 1, baseDesignVersion: 1, baseApprovalState: 'content_approved',
      generation: { startedAt: old, lockedBy: 'dead-instance:1:uuid' },
    });
    const s = await getDesignGenerationStatus(pid, { publicationId: pub.id });
    assert.equal(s.status, 'failed');
    assert.equal(s.generation.failure.code, 'GENERATION_INTERRUPTED');
    const provider = mockImageProvider();
    setDesignProviderOverride(provider);
    assert.equal(await runDesignGeneration(rec._id, 'dead-instance:1:uuid', userId), null, 'the conditional claim finds nothing');
    assert.equal(provider.calls.length, 0);
    assert.deepEqual((await row(pub.id)).media, []);
    assert.equal((await gen(mockImageProvider(), pub)).generation.status, 'ready');
  });

  test('24: lock lost between the image and the attach (recovered as stale mid-run) -> nothing attached and the stored file is deleted', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const pub = await seedPost();
    const provider = mockImageProvider({
      behavior: async ({ size }) => {
        // while the "provider" is drawing, the sweeper decides this run is dead
        await SocialDesignGeneration.updateOne({ publication_id: pub.id, active: true }, { $set: { 'generation.startedAt': new Date(Date.now() - DESIGN_STALE_MS - 1000) } });
        await recoverStaleDesignGenerations(pid, { publicationId: pub.id });
        return makeImage({ width: Number(size.split('x')[0]), height: Number(size.split('x')[1]) });
      },
    });
    const r = await gen(provider, pub);
    assert.equal(r.generation.status, 'failed');
    assert.equal(r.generation.failure.code, 'GENERATION_INTERRUPTED', 'the recovery outcome stands - the dead run does not overwrite it');
    assert.deepEqual((await row(pub.id)).media, []);
    assert.equal((await row(pub.id)).approvalState, 'content_approved');
    assert.deepEqual(await listProjectMedia(pid), [], 'the orphan file was removed');
  });

  test('25: a recent in-flight generation is NOT recovered', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const pub = await seedPost();
    await SocialDesignGeneration.create({ project_id: project._id, publication_id: pub.id, status: 'generating', active: true, platform: 'facebook', contentVersion: 1, baseDesignVersion: 1, baseApprovalState: 'content_approved', generation: { startedAt: new Date(), lockedBy: 'live' } });
    assert.equal(await recoverStaleDesignGenerations(pid), 0);
    const r = await startDesignGeneration(pid, userId, { publicationId: pub.id, contentVersion: 1 }, { background: false });
    assert.equal(r.alreadyRunning, true);
  });

  // ── status / records / secrets ─────────────────────────────────────────────
  test('26: status returns the REAL publication (media, design version, approval state) and a safe generation view', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const pub = await seedPost();
    assert.equal((await getDesignGenerationStatus(pid, { publicationId: pub.id })).status, 'none');
    const r = await gen(mockImageProvider(), pub);
    const s = await getDesignGenerationStatus(pid, { publicationId: pub.id, generationId: r.generation.id });
    assert.equal(s.status, 'ready');
    assert.equal(s.publication.approval.state, 'design_review');
    assert.equal(s.publication.approval.designVersion, 2);
    assert.equal(s.publication.media.length, 1);
    assert.deepEqual(s.publication.design, { source: 'ai', designVersion: 2, contentVersion: 1, generatedAt: s.publication.design.generatedAt });
    assert.equal((await getDesignGenerationStatus(pid, { publicationId: pub.id, generationId: 'nope' })).error.code, 'NOT_FOUND');
    assert.equal((await getDesignGenerationStatus(pid, { publicationId: pub.id, generationId: new mongoose.Types.ObjectId().toString() })).error.code, 'NOT_FOUND');
  });

  test('27: the AI design provenance stops being reported once a human replaces the design', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const pub = await seedPost();
    await gen(mockImageProvider(), pub);
    const handUrl = (await mediaStorageService.upload({ buffer: await makeImage({ width: 700, height: 700, format: 'jpeg' }), projectId: pid, extension: '.jpg' })).url;
    await updatePublication(pid, pub.id, userId, { media: [{ url: handUrl, type: 'image' }] });
    const s = await getDesignGenerationStatus(pid, { publicationId: pub.id });
    assert.equal(s.publication.design, null);
  });

  test('28: the record is metadata only; no prompt, no caption, no business text, no key, no token - in the record, the status or the logs', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const pub = await seedPost({ content: 'UNIQUE-CAPTION-MARKER brushing tips. Book a check-up' });
    const provider = mockImageProvider();
    const r = await gen(provider, pub);
    const rec = JSON.stringify(await SocialDesignGeneration.findOne({ project_id: project._id }).lean());
    const fullStatus = await getDesignGenerationStatus(pid, { publicationId: pub.id });
    const status = JSON.stringify(fullStatus.generation); // the publication part legitimately carries its own caption
    const logs = captured.join('\n');
    assert.ok(logs.includes('design_generation_started') && logs.includes('design_generation_completed'), 'structured events are logged');
    for (const secret of ['FB-SECRET-TOKEN', 'IG-SECRET-TOKEN', 'accessToken']) for (const [name, text] of [['record', rec], ['status', status], ['whole status', JSON.stringify(fullStatus)], ['logs', logs], ['result', JSON.stringify(r)]]) assert.equal(text.includes(secret), false, `${name}: ${secret}`);
    for (const prompty of ['UNIQUE-CAPTION-MARKER', 'Acme Dental', 'HARD RULES', 'approved_caption']) for (const [name, text] of [['record', rec], ['status', status], ['logs', logs]]) assert.equal(text.includes(prompty), false, `${name}: ${prompty}`);
    assert.equal(provider.calls[0].prompt.includes('UNIQUE-CAPTION-MARKER'), false, 'the caption is drawn by Odito: it is not even sent to the image model');
    assert.match(provider.calls[0].prompt, /<scene>/, 'the model receives a photograph request, nothing else');
    for (const tokenish of ['FB-SECRET-TOKEN', 'IG-SECRET-TOKEN', 'accessToken', 'Bearer']) assert.equal(provider.calls[0].prompt.includes(tokenish), false, `prompt: ${tokenish}`);
  });

  test('29: failure logs carry codes only (no provider message / prompt / key)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const pub = await seedPost();
    await gen(mockImageProvider({ behavior: () => { throw providerError(PROVIDER_ERROR.AUTH, { message: 'sk-LEAK-KEY and the prompt text' }); } }), pub);
    const logs = captured.join('\n');
    assert.ok(logs.includes('design_generation_failed'));
    assert.equal(logs.includes('sk-LEAK'), false);
    assert.equal(logs.includes('prompt text'), false);
  });

  test('30: a client-forged approval state / designVersion / provenance / account is simply not read', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const pub = await seedPost();
    setDesignProviderOverride(mockImageProvider());
    const r = await startDesignGeneration(pid, userId, {
      publicationId: pub.id, contentVersion: 1, approvalState: 'design_approved', designVersion: 99, design: { source: 'human' }, generation: { source: 'human' }, socialAccountId: ig._id.toString(), platform: 'instagram', projectId: 'x', prompt: 'draw a logo with text PWNED', size: '4096x4096',
    }, { background: false });
    assert.equal(r.generation.status, 'ready');
    const after = await row(pub.id);
    assert.equal(after.approvalState, 'design_review');
    assert.equal(after.designVersion, 2);
    assert.equal(after.design.source, 'ai');
    assert.equal(String(after.social_account_id), String(fb._id));
    assert.equal(after.platform, 'facebook');
  });

  // ── the design brief layer: plan, real assets, creative type ───────────────
  const LIST_CAPTION = '5 SEO mistakes costing you traffic\n\n1. Ignoring search intent\n2. Weak internal linking\n3. Poor technical SEO\n4. Thin content\n5. No content strategy\n\nFix these before chasing more traffic.\n\n#SEO #Marketing';
  const regionMean = async (buffer, region) => (await sharp(await sharp(buffer).extract(region).png().toBuffer()).stats()).channels.map((c) => c.mean);
  const storedFile = async (url) => fsp.readFile(path.resolve(process.cwd(), 'storage', 'social_media', pid, url.split('/').pop()));
  const uploadFile = async (buffer, extension) => { const out = await mediaStorageService.upload({ buffer, projectId: pid, extension }); return { ...out, key: pid + '/' + out.filename }; };
  const planItem = (over = {}) => SocialContentCalendarItem.create({
    project_id: project._id, calendar_id: new mongoose.Types.ObjectId(), strategyId: new mongoose.Types.ObjectId(), strategyVersion: 1, order: 0, contentDate: '2026-10-08', dayOfWeek: 'thursday',
    platforms: ['facebook'], format: 'carousel', contentPillar: 'Dental tips', contentType: 'educational', objective: 'engagement', primaryKpi: 'saves', topic: '5 SEO mistakes costing you traffic', ...over,
  });
  const fromPlan = (item) => ({ source: 'ai', type: 'social_content', strategyVersion: 1, contentPillar: 'Dental tips', objective: 'educational', calendarItemId: item._id });
  const makeProduct = async (images = []) => SocialProduct.create({ project_id: project._id, name: 'Whitening kit', slug: 'whitening-kit-' + Math.random().toString(36).slice(2, 6), status: 'active', images });
  const imageDoc = (mediaId, stored, isPrimary = true) => ({ mediaId, url: stored.url, storageKey: stored.key, mimeType: 'image/jpeg', isPrimary });

  test('31: the post\'s plan drives the design: the creative type and the points come from the plan and caption, an infographic needs NO photograph, and the brand colour is on the design', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const item = await planItem({ onCreativeText: '5 SEO Mistakes Costing You Traffic', contentBrief: 'Point 1: Ignoring search intent; Point 2: Weak internal linking; Point 3: Poor technical SEO' });
    const pub = await seedPost({ content: LIST_CAPTION, generation: fromPlan(item) });
    const provider = mockImageProvider();
    const r = await gen(provider, pub);
    assert.equal(r.generation.status, 'ready', JSON.stringify(r));
    assert.equal(provider.calls.length, 0, 'a numbered infographic has no photograph: the image model is not used (nothing to pay for, nothing to misspell)');
    assert.deepEqual(r.generation.creative, { type: 'educational_list', label: 'Educational list', layoutId: 'infographic_points', logoApplied: false, referencePhotos: 0, notes: [] });
    const rec = await SocialDesignGeneration.findById(r.generation.id).lean();
    assert.equal(rec.creative.type, 'educational_list');
    assert.match(rec.generation.promptVersion, /^social-ai-design-v\d+$/);
    const status = await getDesignGenerationStatus(pid, { publicationId: pub.id });
    assert.equal(status.generation.creative.type, 'educational_list');
    const design = await storedFile((await row(pub.id)).media[0].url);
    const [red, , blue] = await regionMean(design, { left: 700, top: 150, width: 100, height: 60 });
    assert.ok(blue > 150 && red < 90, 'the header is the brand blue (#1d4ed8)');
  });

  test('32: the creative choice is recorded as codes only: no headline, point, caption or prompt text reaches the record, the status or the logs', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const item = await planItem({ onCreativeText: 'UNIQUE-HEADLINE-MARKER' });
    const pub = await seedPost({ content: LIST_CAPTION.replace('Ignoring search intent', 'UNIQUE-POINT-MARKER'), generation: fromPlan(item) });
    const r = await gen(mockImageProvider(), pub);
    const rec = JSON.stringify(await SocialDesignGeneration.findById(r.generation.id).lean());
    // the generation record's own status (the status call also returns the real post, which legitimately holds its caption)
    const status = JSON.stringify((await getDesignGenerationStatus(pid, { publicationId: pub.id })).generation);
    const logs = captured.join('\n');
    for (const secret of ['UNIQUE-HEADLINE-MARKER', 'UNIQUE-POINT-MARKER', 'HARD RULES', 'text_to_render', 'Fix these before']) for (const [name, text] of [['record', rec], ['status', status], ['logs', logs]]) assert.equal(text.includes(secret), false, name + ': ' + secret);
  });

  test('33: a product design shows the REAL product photo (composed by Odito, never redrawn by the model): the planned product\'s selected image is read from storage and placed on the design', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const photo = await uploadFile(await sharp({ create: { width: 1800, height: 1200, channels: 3, background: '#aa6633' } }).withExif({ IFD0: { Copyright: 'PRODUCT-EXIF-MARKER' } }).jpeg().toBuffer(), '.jpg');
    const mediaId = new mongoose.Types.ObjectId();
    const product = await makeProduct([imageDoc(mediaId, photo)]);
    await SocialProduct.updateOne({ _id: product._id }, { $set: { benefits: ['Brighter in two weeks'], features: ['Enamel-safe gel'] } });
    const item = await planItem({ productId: product._id, productName: 'Whitening kit', selectedMediaIds: [mediaId], format: 'static_post', topic: 'Whitening kit', contentType: 'soft_sell', objective: 'conversion', primaryCta: 'Shop the kit' });
    const pub = await seedPost({ content: 'Meet the whitening kit.', generation: fromPlan(item) });
    const provider = mockImageProvider();
    const r = await gen(provider, pub);
    assert.equal(r.generation.status, 'ready', JSON.stringify(r));
    assert.equal(provider.calls.length, 0, 'the product is a real photograph: the model is never asked to draw it, so it cannot be changed');
    assert.equal(r.generation.creative.type, 'product_showcase');
    assert.equal(r.generation.creative.layoutId, 'product_hero');
    assert.equal(r.generation.creative.referencePhotos, 1);
    const bytes = await storedFile((await row(pub.id)).media[0].url);
    assert.equal(bytes.includes(Buffer.from('PRODUCT-EXIF-MARKER')), false, 'the stored design carries no metadata of the product photo');
    const [red, , blue] = await regionMean(bytes, { left: 330, top: 450, width: 60, height: 60 });
    assert.ok(red > blue + 40, 'the centre of the product card is the real (orange-brown) product photo');
  });

  test('34: with no selection the product\'s primary photo is used; a product photo that is missing, foreign or unreadable is NEVER replaced by an invented product', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const primary = await uploadFile(await sharp({ create: { width: 800, height: 800, channels: 3, background: '#336699' } }).jpeg().toBuffer(), '.jpg');
    const withPhoto = await makeProduct([imageDoc(new mongoose.Types.ObjectId(), primary)]);
    const first = await planItem({ productId: withPhoto._id, topic: 'Whitening kit', contentType: 'soft_sell' });
    const p1 = mockImageProvider();
    const r1 = await gen(p1, await seedPost({ content: 'Meet the whitening kit.', generation: fromPlan(first) }));
    assert.equal(r1.generation.creative.referencePhotos, 1, 'the primary photo');
    assert.equal(r1.generation.creative.layoutId, 'product_hero');

    // no image at all, a missing file, and another project\'s file key: all end the same way - a photograph-led design that says nothing about how the product looks
    const foreignKey = new mongoose.Types.ObjectId().toString() + '/' + crypto.randomUUID() + '.jpg';
    for (const images of [[], [imageDoc(new mongoose.Types.ObjectId(), { url: 'https://x.example/a.jpg', key: pid + '/' + crypto.randomUUID() + '.jpg' })], [imageDoc(new mongoose.Types.ObjectId(), { url: 'https://x.example/b.jpg', key: foreignKey })]]) {
      const product = await makeProduct(images);
      const item = await planItem({ productId: product._id, topic: 'Whitening kit', contentType: 'soft_sell' });
      const provider = mockImageProvider();
      const r = await gen(provider, await seedPost({ content: 'Meet the whitening kit.', generation: fromPlan(item) }));
      assert.equal(r.generation.status, 'ready', JSON.stringify(r));
      assert.deepEqual(provider.calls[0].referenceImages, []);
      assert.equal(/whitening kit/i.test(provider.calls[0].prompt), false, 'the product is not described to the model');
      assert.notEqual(r.generation.creative.type, 'product_showcase');
      assert.notEqual(r.generation.creative.layoutId, 'product_hero');
      assert.ok(r.generation.creative.notes.includes('product_photo_missing'));
    }
  });

  test('35: a product of ANOTHER project can never be pulled into a design (the item\'s product is looked up inside this project only)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const other = track(await SeoProject.create({ user_id: userId, project_name: 'Other ' + Date.now(), main_url: 'https://example.org', seo_scope: 'local', keywords: ['k'], description: 'x' }));
    const photo = await mediaStorageService.upload({ buffer: await sharp({ create: { width: 600, height: 600, channels: 3, background: '#ff0000' } }).jpeg().toBuffer(), projectId: String(other._id), extension: '.jpg' });
    const foreign = await SocialProduct.create({ project_id: other._id, name: 'Secret product', slug: 'secret', status: 'active', images: [{ mediaId: new mongoose.Types.ObjectId(), url: photo.url, storageKey: String(other._id) + '/' + photo.filename, mimeType: 'image/jpeg', isPrimary: true }] });
    const item = await planItem({ productId: foreign._id, topic: 'A gentle introduction', contentType: 'soft_sell' });
    const provider = mockImageProvider();
    const r = await gen(provider, await seedPost({ content: 'Meet the product.', generation: fromPlan(item) }));
    assert.equal(r.generation.status, 'ready');
    assert.deepEqual(provider.calls[0].referenceImages, []);
    assert.equal(provider.calls[0].prompt.includes('Secret product'), false);
    await SocialProduct.deleteMany({ project_id: other._id });
    await removeProjectMedia(String(other._id));
  });

  test('36: the REAL logo is placed on the finished design by Odito (never drawn by the model, never stretched); without a logo nothing is added', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const logo = await uploadFile(await sharp({ create: { width: 400, height: 200, channels: 4, background: '#101820' } }).png().toBuffer(), '.png');
    await SocialBusinessProfile.updateOne({ project_id: project._id }, { $set: { 'brand.logo': { url: logo.url, storageKey: logo.key, mimeType: 'image/png', updatedAt: new Date() } } }, { upsert: true });
    // a white picture with one dark block far from the measured regions: a completely blank picture is refused by the quality gate, so the backdrop must carry some content
    const white = () => sharp({ create: { width: 1536, height: 1024, channels: 3, background: '#ffffff' } }).composite([{ input: { create: { width: 320, height: 220, channels: 3, background: '#202020' } }, left: 1150, top: 740 }]).png().toBuffer();
    const provider = mockImageProvider({ behavior: white });
    const r = await gen(provider, await seedPost());
    assert.equal(r.generation.status, 'ready', JSON.stringify(r));
    assert.equal(r.generation.creative.logoApplied, true);
    assert.equal(/bottom-right|leave the|the real logo/i.test(provider.calls[0].prompt), false, 'the model is not asked to leave room for a logo: Odito places it');
    const after = await row((await SocialPublication.findOne({ project_id: project._id }).lean())._id);
    const design = await storedFile(after.media[0].url);
    const [onLogo] = await regionMean(design, { left: 90, top: 60, width: 70, height: 40 });
    const [elsewhere] = await regionMean(design, { left: 150, top: 560, width: 200, height: 160 });
    assert.ok(onLogo < 60, 'the real (dark) logo is at the top-left');
    assert.ok(elsewhere > 230, 'nothing else was changed in the text column');

    await SocialBusinessProfile.updateOne({ project_id: project._id }, { $set: { 'brand.logo': { url: null, storageKey: null } } });
    const none = mockImageProvider({ behavior: white });
    const r2 = await gen(none, await seedPost());
    assert.equal(r2.generation.creative.logoApplied, false);
    const design2 = await storedFile((await SocialPublication.findOne({ project_id: project._id, _id: { $ne: after._id }, designVersion: 2 }).sort({ updatedAt: -1 }).lean()).media[0].url);
    assert.ok((await regionMean(design2, { left: 90, top: 60, width: 70, height: 40 }))[0] > 200, 'no logo area is drawn when there is no logo');
  });

  test('37: a logo key that belongs to another project (or a file that is not an image) is ignored: the design is made without it', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const foreign = new mongoose.Types.ObjectId().toString() + '/' + crypto.randomUUID() + '.png';
    await SocialBusinessProfile.updateOne({ project_id: project._id }, { $set: { 'brand.logo': { url: 'https://x.example/l.png', storageKey: foreign, mimeType: 'image/png' } } }, { upsert: true });
    const r1 = await gen(mockImageProvider(), await seedPost());
    assert.equal(r1.generation.status, 'ready');
    assert.equal(r1.generation.creative.logoApplied, false);

    const notImage = await uploadFile(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), '.png');
    await SocialBusinessProfile.updateOne({ project_id: project._id }, { $set: { 'brand.logo': { url: notImage.url, storageKey: notImage.key, mimeType: 'image/png' } } });
    const r2 = await gen(mockImageProvider(), await seedPost());
    assert.equal(r2.generation.status, 'ready');
    assert.equal(r2.generation.creative.logoApplied, false);
  });

  test('38: the photograph is chosen for the BUSINESS and the topic: a dentist gets a clinic scene, never an unrelated stock scene; the same post always gets the same scene', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const pub = await seedPost({ content: 'Positioning beats polish. Always.' });
    const a = mockImageProvider();
    await gen(a, pub);
    const scene = (call) => /<scene>\n([^\n]+)\n/.exec(call.prompt)[1];
    assert.match(scene(a.calls[0]), /clinic|patient|treatment|consultation/i);
    await SocialDesignGeneration.deleteMany({ project_id: project._id });
    await SocialPublication.updateOne({ _id: pub.id }, { $set: { approvalState: 'content_approved', designVersion: 1, media: [] } });
    const b = mockImageProvider();
    await gen(b, pub);
    assert.equal(scene(b.calls[0]), scene(a.calls[0]), 'deterministic: the same input chooses the same scene');
  });

  test('39: a post with nothing to build a headline from (filler, emoji) fails BEFORE any image is paid for, with a message that says what to add: nothing is stored, the post is unchanged', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const pub = await seedPost({ content: 'ok ok ok ok ok ok ok ok ok ok ok ok ok ok ok ok' });
    const provider = mockImageProvider();
    const r = await gen(provider, pub);
    assert.equal(r.generation.status, 'failed');
    assert.equal(r.generation.failure.code, 'DESIGN_NEEDS_TEXT');
    assert.equal(r.generation.failure.message, DESIGN_FAILURE_MESSAGES.DESIGN_NEEDS_TEXT);
    assert.equal(provider.calls.length, 0, 'the provider was never called');
    assert.deepEqual(await listProjectMedia(pid), []);
    const after = await row(pub.id);
    assert.equal(after.approvalState, 'content_approved');
    assert.equal(after.designVersion, 1);
    assert.deepEqual(after.media, []);
    assert.equal((await SocialDesignGeneration.findById(r.generation.id).lean()).active, false);
  });

  test('39b: a long caption with no punctuation is NOT refused: it gets a bounded excerpt as its headline, the design is made, and the excerpt is recorded as a code only', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const pub = await seedPost({ content: 'Brushing for two minutes twice a day with a soft brush and fluoride toothpaste protects every single tooth in your whole mouth for years' });
    const provider = mockImageProvider();
    const r = await gen(provider, pub);
    assert.equal(r.generation.status, 'ready', JSON.stringify(r.generation.failure));
    assert.equal(provider.calls.length, 1);
    const record = await SocialDesignGeneration.findById(r.generation.id).lean();
    assert.ok(record.creative.notes.includes('headline_shortened'));
    assert.doesNotMatch(JSON.stringify(record), /Brushing for two minutes/, 'the record keeps codes, never post text');
    assert.equal((await row(pub.id)).designVersion, 2);
  });

  test('40: a prohibited phrase in the only possible headline keeps the design from being made (nothing banned is ever set in the image)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialBusinessProfile.updateOne({ project_id: project._id }, { $set: { prohibitedPhrases: ['cheapest'] } }, { upsert: true });
    const provider = mockImageProvider();
    const r = await gen(provider, await seedPost({ content: 'The cheapest check-up in town' }));
    assert.equal(r.generation.status, 'failed');
    assert.equal(r.generation.failure.code, 'DESIGN_BRIEF_INVALID');
    assert.equal(provider.calls.length, 0);
    const ok = mockImageProvider();
    const safe = await gen(ok, await seedPost({ content: 'A gentler check-up for your family' }));
    assert.equal(safe.generation.status, 'ready');
    assert.equal(ok.calls[0].prompt.includes('cheapest'), false, 'the phrase is not sent to the provider either');
  });

  test('41: the existing approval flow is untouched by the new brief: a generated creative still goes to Design Review, versions bump, and nothing is scheduled or published', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const item = await planItem({ onCreativeText: 'Strategy before channels' });
    const pub = await seedPost({ content: 'Strategy before channels. Always.', generation: fromPlan(item) });
    const r = await gen(mockImageProvider(), pub);
    assert.equal(r.generation.status, 'ready');
    const after = await row(pub.id);
    assert.equal(after.approvalState, 'design_review');
    assert.equal(after.designVersion, 2);
    assert.equal(after.status, 'draft');
    assert.equal(after.scheduledAt ?? null, null);
    assert.deepEqual(metaCalls, []);
    assert.deepEqual(fetchCalls, []);
    assert.equal(after.design.source, 'ai');
    assert.equal(String(after.generation.calendarItemId), String(item._id));
    const approved = await approveDesign(pid, pub.id, reviewerId, 2);
    assert.equal(approved.success, true, JSON.stringify(approved.error));
  });
  // ── image quality: the numbered-list defect, blank pictures, and a failed regeneration (Image Generation Quality Audit) ──
  const NUMBERED_CAPTION = [
    'Most agencies hit a growth ceiling — not because of clients, but because of capacity. Here\'s what changes that.', '',
    'If any of these feel familiar, your agency may already be ready for a white-label fulfillment partner:', '',
    '1. You\'re turning down service requests because your team can\'t cover them.', '2. Delivery quality is slipping as client volume grows.',
    '3. You\'re spending more time managing tasks than managing clients.', '4. Hiring feels like the only option — but the overhead doesn\'t add up.',
    '5. A client just asked for a service you don\'t offer yet.', '', 'Which of these signs sounds familiar to your agency right now? Drop a number in the comments.', '',
    '#AgencyGrowth #WhiteLabelMarketing',
  ].join('\n');

  test('Q1: a caption with a numbered list becomes a numbered INFOGRAPHIC with every point in full - never empty cards with giant list numerals (the reported defect)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const pub = await seedPost({ content: NUMBERED_CAPTION });
    const provider = mockImageProvider();
    const r = await gen(provider, pub);
    assert.equal(r.generation.status, 'ready', JSON.stringify(r.generation.failure));
    const record = await SocialDesignGeneration.findOne({ project_id: project._id }).lean();
    assert.deepEqual([record.creative.type, record.creative.layoutId], ['educational_list', 'infographic_points'], 'a numbered list is not "data"');
    assert.equal(provider.calls.length, 0, 'an infographic needs no photograph: no image is paid for');
    const after = await row(pub.id);
    assert.equal(after.media.length, 1);
    const meta = await sharp(await storedFile(after.media[0].url)).metadata();
    assert.deepEqual([meta.width, meta.height], [1536, 1024]);
    // the picture carries information (it is not a handful of flat cards)
    const { assessRaster } = await import('./designQuality.js');
    const quality = await assessRaster(await storedFile(after.media[0].url));
    assert.equal(quality.blank, false);
    assert.ok(quality.stdev > 20, `stdev ${quality.stdev}`);
    assert.doesNotMatch(JSON.stringify(record), /turning down service requests|growth ceiling/, 'the record holds codes, never the post text');
  });

  test('Q2: a provider picture that decodes but is BLANK is refused (MEDIA_INVALID): nothing stored, nothing attached, the post is unchanged', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const pub = await seedPost();
    const flat = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#f5f5f5' } }).png().toBuffer();
    const r = await gen(mockImageProvider({ behavior: () => flat }), pub);
    assert.equal(r.generation.status, 'failed');
    assert.equal(r.generation.failure.code, 'MEDIA_INVALID');
    assert.deepEqual(await listProjectMedia(pid), []);
    const after = await row(pub.id);
    assert.deepEqual([after.media, after.designVersion, after.approvalState], [[], 1, 'content_approved']);
  });

  test('Q3: a FAILED regeneration keeps the previous successful design: same file, same version, same approval state - and the file is still on disk', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const pub = await seedPost();
    assert.equal((await gen(mockImageProvider(), pub)).generation.status, 'ready');
    const good = await row(pub.id);
    assert.equal(good.designVersion, 2);
    for (const behavior of [() => { throw providerError(PROVIDER_ERROR.TIMEOUT); }, () => Buffer.from('not an image'), () => sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#ffffff' } }).png().toBuffer()]) {
      const failed = await gen(mockImageProvider({ behavior }), pub);
      assert.equal(failed.generation.status, 'failed');
      const now = await row(pub.id);
      assert.deepEqual([now.media[0].url, now.designVersion, now.approvalState], [good.media[0].url, 2, 'design_review']);
    }
    assert.deepEqual((await listProjectMedia(pid)).length, 1, 'no stray file from the failed attempts, and the good one is kept');
    assert.ok((await storedFile(good.media[0].url)).length > 1000);
    // and a later successful regeneration is a NEW version with a NEW file
    assert.equal((await gen(mockImageProvider(), pub)).generation.status, 'ready');
    const next = await row(pub.id);
    assert.equal(next.designVersion, 3);
    assert.notEqual(next.media[0].url, good.media[0].url);
  });

  test('Q4: a design a person has not approved can never become the published asset: an attached design is only ever in design_review until the existing design approval, and scheduling needs that approval', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const pub = await seedPost();
    await gen(mockImageProvider(), pub);
    const generated = await row(pub.id);
    assert.equal(generated.approvalState, 'design_review');
    assert.equal(generated.designApprovedVersion ?? null, null);
    assert.deepEqual(metaCalls, [], 'generating a design never touches Meta');
    assert.equal(generated.status, 'draft');
  });

  // ── the final raster gate, end to end (no paid call: the photograph is the scripted provider's, the composition is replaced by a blank one) ──
  const blankComposer = (width = 1536, height = 1024) => async () => ({
    buffer: await sharp({ create: { width, height, channels: 3, background: '#ffffff' } }).png().toBuffer(),
    report: { layout: 'photo_hero', texts: [], overflow: [], shortened: [], notes: [], fonts: {} },
  });

  test('Q5: a BLANK final image fails the generation (DESIGN_COMPOSE_FAILED) and the previous design, its version, its approval state and its file are untouched; nothing blank is stored', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const pub = await seedPost();
    assert.equal((await gen(mockImageProvider(), pub)).generation.status, 'ready');
    const good = await row(pub.id);
    assert.deepEqual([good.designVersion, good.approvalState], [2, 'design_review']);
    const filesBefore = await listProjectMedia(pid);

    setDesignComposerOverride(blankComposer());
    let failed;
    try { failed = await gen(mockImageProvider(), pub); } finally { setDesignComposerOverride(null); }
    assert.equal(failed.generation.status, 'failed', 'a blank design is not a success');
    assert.equal(failed.generation.failure.code, 'DESIGN_COMPOSE_FAILED');
    assert.match(failed.generation.failure.message, /nothing was saved and your current design is unchanged/);
    const record = await SocialDesignGeneration.findById(failed.generation.id).lean();
    assert.deepEqual([record.status, record.active, record.failure.code, record.result?.mediaUrl ?? null], ['failed', false, 'DESIGN_COMPOSE_FAILED', null]);

    const now = await row(pub.id);
    assert.deepEqual([now.media[0].url, now.designVersion, now.approvalState, now.designApprovedVersion ?? null], [good.media[0].url, 2, 'design_review', null], 'the current design stays active');
    assert.deepEqual(await listProjectMedia(pid), filesBefore, 'no blank asset was written');
    assert.ok((await storedFile(good.media[0].url)).length > 1000, 'the good design is still on disk');

    // and the post can still be regenerated normally afterwards: the failed attempt left no lock behind
    assert.equal((await gen(mockImageProvider(), pub)).generation.status, 'ready');
    assert.equal((await row(pub.id)).designVersion, 3);
  });

  test('Q6: a blank final image on a FIRST design: nothing is attached, the post stays content_approved, no file is stored, and the failure is the plain composition message', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const pub = await seedPost();
    setDesignComposerOverride(blankComposer());
    let r;
    try { r = await gen(mockImageProvider(), pub); } finally { setDesignComposerOverride(null); }
    assert.deepEqual([r.generation.status, r.generation.failure.code], ['failed', 'DESIGN_COMPOSE_FAILED']);
    const after = await row(pub.id);
    assert.deepEqual([after.media, after.designVersion, after.approvalState], [[], 1, 'content_approved']);
    assert.deepEqual(await listProjectMedia(pid), []);
    assert.deepEqual(metaCalls, [], 'nothing reached Meta');
  });

  test('Q7: a numbered-list post that is blank after composition is refused the same way (no photograph is involved, so no provider call at all)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const pub = await seedPost({ content: NUMBERED_CAPTION });
    const provider = mockImageProvider();
    setDesignComposerOverride(blankComposer());
    let r;
    try { r = await gen(provider, pub); } finally { setDesignComposerOverride(null); }
    assert.equal(r.generation.failure.code, 'DESIGN_COMPOSE_FAILED');
    assert.equal(provider.calls.length, 0);
    assert.deepEqual((await row(pub.id)).media, []);
  });

  // ── provider independence: a design made only by Odito's own composition never needs (or calls) the image provider ──────────────────────────
  const STATS_CAPTION = 'Agencies that standardise delivery grow faster.\n\nRevenue per client rose 42% in a year when delivery was standardised.\n\nAverage turnaround fell from 9 days to 4 days after the move.';
  const QUOTE_CAPTION = 'As our founder likes to say: "Great marketing is not louder, it is clearer and kinder to the customer."\n\nThat idea guides every campaign we run.';
  const LOCAL_DESIGNS = {
    'numbered list': { caption: NUMBERED_CAPTION, layout: 'infographic_points' },
    statistics: { caption: STATS_CAPTION, layout: 'insight_stats' },
    quote: { caption: QUOTE_CAPTION, layout: 'statement_quote' },
  };

  for (const [name, c] of Object.entries(LOCAL_DESIGNS)) {
    test(`P1 (${name}): with NO image provider configured the design is still made: stored, validated, versioned 1 -> 2, in Design Review, never approved - and the provider is never called`, async (t) => {
      if (!mongoAvailable) return t.skip('local MongoDB not reachable');
      const pub = await seedPost({ content: c.caption });
      const provider = mockImageProvider({ available: false });
      const r = await gen(provider, pub);
      assert.equal(r.success, true, JSON.stringify(r));
      assert.equal(r.generation.status, 'ready', JSON.stringify(r.generation.failure));
      assert.equal(provider.calls.length, 0, 'no image request, so nothing paid');
      assert.deepEqual(fetchCalls, [], 'no network request of any kind');
      const record = await SocialDesignGeneration.findOne({ project_id: project._id }).lean();
      assert.equal(record.creative.layoutId, c.layout);
      assert.equal(record.model, 'odito-composer');
      const after = await row(pub.id);
      assert.deepEqual([after.designVersion, after.approvalState, after.designApprovedVersion ?? null, after.status], [2, 'design_review', null, 'draft']);
      assert.equal(after.media.length, 1);
      // the same final raster validation as every other design: it carries information (it is not blank) and is a real stored image
      const { assessRaster } = await import('./designQuality.js');
      const bytes = await storedFile(after.media[0].url);
      assert.equal((await assessRaster(bytes)).blank, false);
      assert.ok((await sharp(bytes).metadata()).width >= 1000);
      assert.deepEqual(metaCalls, [], 'nothing was published or sent to Meta');
    });
  }

  test('P2: a design that NEEDS an AI photograph, with no provider configured, is refused before anything is claimed - with a message that says what is unavailable and what still works', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const pub = await seedPost();
    const before = await row(pub.id);
    const provider = mockImageProvider({ available: false });
    const r = await gen(provider, pub);
    assert.equal(r.success, false);
    assert.equal(r.error.code, 'AI_UNAVAILABLE');
    assert.match(r.error.message, /needs an AI-generated photograph/);
    assert.match(r.error.message, /lists, statistics, quotes/);
    assert.match(r.error.message, /try again later/i);
    assert.equal(provider.calls.length, 0);
    assert.equal(await SocialDesignGeneration.countDocuments({ project_id: project._id }), 0, 'nothing claimed');
    const after = await row(pub.id);
    assert.deepEqual([after.media, after.designVersion, after.approvalState], [before.media, before.designVersion, before.approvalState]);
    assert.equal(JSON.stringify(r).includes('API_KEY'), false);
  });

  test('P3: a photo design that cannot get its photograph keeps the previous design: same file, version and approval state, no stand-in picture, and no request is made', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const pub = await seedPost();
    assert.equal((await gen(mockImageProvider(), pub)).generation.status, 'ready');
    const good = await row(pub.id);
    const files = await listProjectMedia(pid);
    assert.deepEqual([good.designVersion, good.approvalState], [2, 'design_review']);

    // (a) not configured when the request arrives
    const off = mockImageProvider({ available: false });
    const r1 = await gen(off, pub);
    assert.equal(r1.error.code, 'AI_UNAVAILABLE');
    // (b) configured when the request arrives, gone by the time the photograph is needed (the producer's own guard)
    const flaky = mockImageProvider();
    let asked = 0;
    flaky.isAvailable = () => { asked += 1; return asked === 1; };
    const r2 = await gen(flaky, pub);
    assert.equal(r2.generation.status, 'failed');
    assert.equal(r2.generation.failure.code, 'AI_UNAVAILABLE');
    assert.equal(r2.generation.failure.message, DESIGN_FAILURE_MESSAGES.AI_UNAVAILABLE);
    assert.equal(flaky.calls.length, 0, 'the provider was never asked to make a picture');

    const now = await row(pub.id);
    assert.deepEqual([now.media[0].url, now.designVersion, now.approvalState, now.designApprovedVersion ?? null], [good.media[0].url, 2, 'design_review', null]);
    assert.deepEqual(await listProjectMedia(pid), files, 'no stand-in or partial file was written');
    assert.equal(await SocialDesignGeneration.countDocuments({ project_id: project._id, active: true }), 0, 'no lock is left behind');
    // and it works again once the provider is back
    assert.equal((await gen(mockImageProvider(), pub)).generation.status, 'ready');
    assert.equal((await row(pub.id)).designVersion, 3);
  });

  test('P4: a configured provider is used normally for a photo design: exactly one request, a photograph under the composed design, the same versioning', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const pub = await seedPost();
    const provider = mockImageProvider();
    const r = await gen(provider, pub);
    assert.equal(r.generation.status, 'ready', JSON.stringify(r.generation.failure));
    assert.equal(provider.calls.length, 1);
    const record = await SocialDesignGeneration.findOne({ project_id: project._id }).lean();
    assert.equal(record.model, 'mock-image-model');
    assert.equal(record.creative.layoutId, 'photo_hero');
    assert.deepEqual([(await row(pub.id)).designVersion, (await row(pub.id)).approvalState], [2, 'design_review']);
  });

  test('P5: concurrent requests for a list design with no provider still make exactly one generation, one image, one new version', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const pub = await seedPost({ content: NUMBERED_CAPTION });
    const provider = mockImageProvider({ available: false });
    setDesignProviderOverride(provider);
    const results = await Promise.all(Array.from({ length: 6 }, () => startDesignGeneration(pid, userId, { publicationId: pub.id, contentVersion: 1 }, { background: true })));
    assert.equal(results.filter((r) => r.started).length, 1, 'one claim');
    assert.equal(results.filter((r) => r.alreadyRunning).length, 5);
    assert.equal(new Set(results.map((r) => r.generation.id)).size, 1);
    await waitDone(results[0].generation.id);
    assert.equal(provider.calls.length, 0);
    assert.equal(await SocialDesignGeneration.countDocuments({ project_id: project._id }), 1);
    assert.equal((await listProjectMedia(pid)).length, 1);
    const after = await row(pub.id);
    assert.deepEqual([after.designVersion, after.media.length, after.approvalState], [2, 1, 'design_review']);
  });

});
