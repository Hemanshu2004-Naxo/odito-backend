import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SeoProject from '../../../app_user/model/SeoProject.js';
import SocialAccount from '../../model/SocialAccount.js';
import SocialAIStrategy from '../../model/SocialAIStrategy.js';
import SocialBusinessProfile from '../../model/SocialBusinessProfile.js';
import SocialContentGeneration from '../../model/SocialContentGeneration.js';
import SocialPublication from '../../model/SocialPublication.js';
import SocialApprovalSettings from '../../model/SocialApprovalSettings.js';
import adapters from '../platformAdapters/index.js';
import { updateProfile } from '../socialBusinessProfileService.js';
import { createPublication, approveContent } from '../socialPublishingService.js';
import {
  startContentGeneration, runContentGeneration, getContentGenerationStatus, recoverStaleContentGenerations,
  setContentProviderOverride, resetContentProviderOverride, CONTENT_FAILURE_MESSAGES,
} from './socialContentGenerationService.js';
import { CONTENT_STALE_MS } from './contentConfig.js';
import { PROVIDER_ERROR } from './providers/contentProviderErrors.js';
import { validRawStrategy, validRawPost, mockContentProvider, providerError } from '../../testSupport/aiStrategyFixtures.js';

/**
 * Real MongoDB, scripted AI provider. Proves that one generation produces ONE real SocialPublication
 * draft that enters the EXISTING approval workflow - and that nothing is scheduled, published, sent to
 * Meta, invented, leaked or created twice.
 */

let mongoAvailable = false;
before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
    await Promise.all([SocialContentGeneration.init(), SocialAIStrategy.init()]);
  } catch {
    mongoAvailable = false;
  }
});
after(async () => {
  resetContentProviderOverride();
  if (mongoAvailable) await mongoose.connection.close();
});

const clone = (o) => JSON.parse(JSON.stringify(o));

const SNAPSHOT = () => ({
  business: { name: 'Acme Dental', description: 'Family dentistry in Leeds', category: 'Dentist', website: 'https://acme.example', language: 'en', location: { city: 'Leeds', country: 'UK' }, serviceArea: null },
  audience: { primary: 'Young families', secondary: [] }, toneOfVoice: { primary: 'Warm', secondary: [] }, goals: ['More bookings'], uniqueSellingPoints: ['Open late'],
  offers: [{ name: 'Free check-up', description: 'First visit free', url: null }], competitors: [], prohibitedPhrases: ['cheapest'], additionalInstructions: '',
  brand: {}, connectedPlatforms: { facebook: true, instagram: true },
});

describe('single-post AI content generation (real MongoDB, scripted provider)', () => {
  let userId, project, pid, created, fb, ig, metaCalls, realFetch, fetchCalls;
  const track = (d) => { created.push(d); return d; };
  const original = {};

  async function newProject(owner = userId) {
    return track(await SeoProject.create({
      user_id: owner, project_name: `Content ${Date.now()} ${Math.random().toString(36).slice(2, 8)}`, main_url: 'https://example.com', seo_scope: 'local', keywords: ['k'],
      description: 'Family dental practice', industry: 'Dentist',
    }));
  }

  async function seedStrategy(projectId = pid, { version = 1, status = 'ready', mutate = null } = {}) {
    const strategy = validRawStrategy();
    strategy.brandRules = { ...strategy.brandRules, prohibitedPhrases: [] };
    if (mutate) mutate(strategy);
    return SocialAIStrategy.create({
      project_id: projectId, version, status, strategy,
      profileSnapshot: { generatedAt: new Date('2026-01-01T00:00:00Z'), hash: `hash-v${version}`, data: SNAPSHOT() },
      generation: { startedAt: new Date(), finishedAt: new Date() },
    });
  }

  async function seedAccounts(projectId = project._id, owner = userId, pageId = `pg_${Math.random().toString(36).slice(2, 8)}`) {
    const f = await SocialAccount.create({ user_id: owner, project_id: projectId, platform: 'facebook', platformAccountId: pageId, platformAccountName: 'Page', accountType: 'page', pageId, accessToken: 'FB-SECRET-TOKEN', status: 'active', isActive: true });
    const i = await SocialAccount.create({ user_id: owner, project_id: projectId, platform: 'instagram', platformAccountId: `ig_${pageId}`, platformAccountName: 'IG', accountType: 'business', pageId, accessToken: 'IG-SECRET-TOKEN', status: 'active' });
    return { f, i };
  }

  const gen = (provider, input = {}, id = pid, uid = userId) => {
    setContentProviderOverride(provider);
    return startContentGeneration(id, uid, { platform: 'facebook', contentPillar: 'Dental tips', objective: 'educational', ...input }, { background: false });
  };
  const lastDraft = () => SocialPublication.findOne({ project_id: project._id }).sort({ createdAt: -1 }).lean();

  before(() => {
    for (const p of ['facebook', 'instagram']) for (const m of ['publish', 'remove', 'reconcile']) original[`${p}.${m}`] = adapters[p][m];
  });

  beforeEach(async () => {
    if (!mongoAvailable) return;
    created = [];
    userId = new mongoose.Types.ObjectId();
    project = await newProject();
    pid = project._id.toString();
    ({ f: fb, i: ig } = await seedAccounts());
    await seedStrategy();
    // Anything that would talk to Meta (or anywhere) is counted - it must stay at zero.
    metaCalls = [];
    for (const p of ['facebook', 'instagram']) for (const m of ['publish', 'remove', 'reconcile']) adapters[p][m] = async (...a) => { metaCalls.push(`${p}.${m}`); return { success: false }; };
    fetchCalls = [];
    realFetch = globalThis.fetch;
    globalThis.fetch = async (...a) => { fetchCalls.push(String(a[0])); throw new Error('network is not available in this test'); };
  });

  afterEach(async () => {
    resetContentProviderOverride();
    globalThis.fetch = realFetch;
    for (const key of Object.keys(original)) { const [p, m] = key.split('.'); adapters[p][m] = original[key]; }
    if (!mongoAvailable) return;
    const ids = created.map((d) => d._id);
    await Promise.all([
      SocialContentGeneration.deleteMany({ project_id: { $in: ids } }),
      SocialPublication.deleteMany({ project_id: { $in: ids } }),
      SocialAIStrategy.deleteMany({ project_id: { $in: ids } }),
      SocialBusinessProfile.deleteMany({ project_id: { $in: ids } }),
      SocialApprovalSettings.deleteMany({ project_id: { $in: ids } }),
      SocialAccount.deleteMany({ project_id: { $in: ids } }),
    ]);
    await SeoProject.deleteMany({ _id: { $in: ids } });
  });

  // ── the happy path: a real draft in the existing workflow ──────────────────
  test('1: a valid generation saves ONE real draft: status draft, content = caption + hashtags, contentVersion 1, in content_review', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const provider = mockContentProvider();
    const r = await gen(provider);
    assert.equal(r.success, true);
    assert.equal(r.generation.status, 'ready');
    assert.equal(provider.calls.length, 1);

    const pubs = await SocialPublication.find({ project_id: project._id }).lean();
    assert.equal(pubs.length, 1);
    const pub = pubs[0];
    assert.equal(pub.status, 'draft', 'a draft - never scheduled, publishing or published');
    assert.equal(pub.platform, 'facebook');
    assert.equal(pub.content, `${validRawPost().caption}\n\n#DentalCare #HealthySmile`);
    assert.equal(pub.contentVersion, 1);
    assert.equal(pub.approvalState, 'content_review', 'submitted through the EXISTING workflow');
    assert.equal(pub.scheduledAt ?? null, null);
    assert.equal(pub.externalPostId ?? null, null);
    assert.equal(String(pub.social_account_id), String(fb._id));
  });

  test('2: nothing reaches Meta or the network, and no publish/schedule happens', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await gen(mockContentProvider());
    assert.deepEqual(metaCalls, []);
    assert.deepEqual(fetchCalls, []);
    assert.equal(await SocialPublication.countDocuments({ project_id: project._id, status: { $ne: 'draft' } }), 0);
  });

  test('3: provenance: source ai, strategy version, snapshot hash + time, pillar, objective and the generation id', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const r = await gen(mockContentProvider());
    const pub = await lastDraft();
    assert.equal(pub.generation.source, 'ai');
    assert.equal(pub.generation.type, 'social_content');
    assert.equal(pub.generation.strategyVersion, 1);
    assert.equal(pub.generation.profileSnapshotHash, 'hash-v1');
    assert.equal(new Date(pub.generation.profileSnapshotGeneratedAt).toISOString(), '2026-01-01T00:00:00.000Z');
    assert.equal(pub.generation.contentPillar, 'Dental tips');
    assert.equal(pub.generation.objective, 'educational');
    assert.equal(String(pub.generation.generationId), r.generation.id);
  });

  test('4: a post that is NOT AI-made has no provenance, and no second collection holds AI posts', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const manual = await createPublication(pid, userId, { platform: 'facebook', socialAccountId: fb._id.toString(), content: 'Hand-written' });
    assert.equal(manual.publication.generation, null);
    const raw = await SocialPublication.findById(manual.publication.id).lean();
    assert.equal(raw.generation?.source ?? null, null);
  });

  test('5: the status read returns the REAL saved draft (re-read, so later edits show) and the AI notes', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const r = await gen(mockContentProvider());
    await SocialPublication.updateOne({ project_id: project._id }, { $set: { content: 'Edited by a human' } });
    const s = await getContentGenerationStatus(pid, { generationId: r.generation.id });
    assert.equal(s.status, 'ready');
    assert.equal(s.publication.content, 'Edited by a human');
    assert.equal(s.publication.status, 'draft');
    assert.equal(s.publication.approvalState, 'content_review');
    assert.equal(s.publication.contentVersion, 1);
    assert.equal(s.publication.generation.contentPillar, 'Dental tips');
    assert.equal(s.generation.result.callToAction, 'Book a check-up');
    assert.deepEqual(s.generation.result.hashtags, ['#DentalCare', '#HealthySmile']);
    // with no id, the latest generation
    assert.equal((await getContentGenerationStatus(pid)).generation.id, r.generation.id);
  });

  test('6: no generation yet -> status none; an unknown or foreign-project id is NOT_FOUND', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    assert.equal((await getContentGenerationStatus(pid)).status, 'none');
    const r = await gen(mockContentProvider());
    const other = await newProject();
    const foreign = await getContentGenerationStatus(other._id.toString(), { generationId: r.generation.id });
    assert.equal(foreign.success, false);
    assert.equal(foreign.error.code, 'NOT_FOUND');
    assert.equal((await getContentGenerationStatus(pid, { generationId: 'not-an-id' })).error.code, 'NOT_FOUND');
    assert.equal((await getContentGenerationStatus(other._id.toString())).status, 'none', 'another project never sees this project\'s generation');
  });

  // ── approval workflow integration ──────────────────────────────────────────
  test('7: approval is decided by the EXISTING settings: content approval off -> auto-approved; on -> content_review', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialApprovalSettings.create({ project_id: project._id, contentApprovalRequired: false, designApprovalRequired: true });
    await gen(mockContentProvider());
    assert.equal((await lastDraft()).approvalState, 'content_approved');
    assert.equal((await lastDraft()).status, 'draft', 'auto-approved content is still a draft - nothing is scheduled or published');
  });

  test('8: the generated draft is approved through the normal workflow and the contentVersion guard still applies', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await gen(mockContentProvider());
    const pub = await lastDraft();
    const reviewer = new mongoose.Types.ObjectId();
    const stale = await approveContent(pid, String(pub._id), reviewer, 7);
    assert.equal(stale.success, false, 'a wrong content version is refused');
    const ok = await approveContent(pid, String(pub._id), reviewer, 1);
    assert.equal(ok.success, true);
    assert.equal((await lastDraft()).approvalState, 'content_approved');
  });

  // ── request validation: nothing is claimed, the AI is never called ─────────
  test('9: an unknown, missing or unsupported platform is refused before the AI is called', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const provider = mockContentProvider();
    for (const platform of ['tiktok', 'x', '', undefined, null, 5, ['facebook'], { a: 1 }]) {
      const r = await gen(provider, { platform });
      assert.equal(r.success, false, String(platform));
      assert.equal(r.error.code, 'INVALID_PLATFORM');
    }
    assert.equal(provider.calls.length, 0);
    assert.equal(await SocialContentGeneration.countDocuments({ project_id: project._id }), 0);
  });

  test('10: a platform that is not connected (as the SERVER sees it) is refused - a client "connected" flag is not read', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialAccount.deleteMany({ project_id: project._id, platform: 'instagram' });
    const provider = mockContentProvider();
    const r = await gen(provider, { platform: 'instagram', connected: true, connectedPlatforms: { instagram: true } });
    assert.equal(r.success, false);
    assert.equal(r.error.code, 'PLATFORM_NOT_CONNECTED');
    assert.equal(provider.calls.length, 0);
    // an expired Facebook connection is not "connected" either
    await SocialAccount.updateOne({ _id: fb._id }, { $set: { status: 'expired' } });
    assert.equal((await gen(provider, { platform: 'facebook' })).error.code, 'PLATFORM_NOT_CONNECTED');
    assert.equal(provider.calls.length, 0);
  });

  test('11: an Instagram post is allowed when Instagram is genuinely connected, and is a draft for the Instagram account', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const provider = mockContentProvider({ behavior: () => validRawPost({ platform: 'instagram' }) });
    const r = await gen(provider, { platform: 'instagram' });
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(r.generation.status, 'ready');
    const pub = await lastDraft();
    assert.equal(pub.platform, 'instagram');
    assert.equal(String(pub.social_account_id), String(ig._id));
    assert.equal(pub.status, 'draft');
  });

  test('12: a platform the strategy does not cover is refused', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialAIStrategy.deleteMany({ project_id: project._id });
    await seedStrategy(pid, { mutate: (s) => { s.platformStrategy = s.platformStrategy.filter((p) => p.platform === 'facebook'); } });
    const r = await gen(mockContentProvider(), { platform: 'instagram' });
    assert.equal(r.error.code, 'PLATFORM_NOT_IN_STRATEGY');
  });

  test('13: the content pillar must be one of the stored strategy\'s pillars (exact), with the allowed list returned', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const provider = mockContentProvider();
    for (const contentPillar of ['Made up pillar', 'dental tips', '', '   ', undefined, 5]) {
      const r = await gen(provider, { contentPillar });
      assert.equal(r.success, false, String(contentPillar));
      assert.equal(r.error.code, 'INVALID_PILLAR');
    }
    const r = await gen(provider, { contentPillar: 'Nope' });
    assert.deepEqual(r.error.allowed, ['Dental tips', 'Meet the team', 'Offers']);
    assert.equal(provider.calls.length, 0);
  });

  test('14: the objective must be a known value AND part of the strategy\'s content mix', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const provider = mockContentProvider();
    for (const objective of ['go_viral', '', undefined, null, 5, 'EDUCATIONAL']) assert.equal((await gen(provider, { objective })).error.code, 'INVALID_OBJECTIVE', String(objective));
    const r = await gen(provider, { objective: 'hard_sell' }); // valid value, not in this strategy's mix
    assert.equal(r.error.code, 'OBJECTIVE_NOT_IN_STRATEGY');
    assert.deepEqual(r.error.allowed.sort(), ['behind_the_scenes', 'educational', 'soft_sell']);
    assert.equal(provider.calls.length, 0);
  });

  test('15: no ready strategy -> NO_STRATEGY (a failed or archived-only history does not count); nothing is generated', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialAIStrategy.deleteMany({ project_id: project._id });
    const provider = mockContentProvider();
    assert.equal((await gen(provider)).error.code, 'NO_STRATEGY');
    await seedStrategy(pid, { version: 1, status: 'failed' });
    assert.equal((await gen(provider)).error.code, 'NO_STRATEGY');
    assert.equal(provider.calls.length, 0);
    assert.equal(await SocialPublication.countDocuments({ project_id: project._id }), 0);
  });

  test('16: AI not configured -> AI_UNAVAILABLE, nothing claimed; an unknown project -> NOT_FOUND', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const r = await gen(mockContentProvider({ available: false }));
    assert.equal(r.error.code, 'AI_UNAVAILABLE');
    assert.equal(await SocialContentGeneration.countDocuments({ project_id: project._id }), 0);
    const nf = await gen(mockContentProvider(), {}, new mongoose.Types.ObjectId().toString());
    assert.equal(nf.error.code, 'NOT_FOUND');
  });

  // ── snapshot usage ─────────────────────────────────────────────────────────
  test('17: the post is written from the STORED strategy snapshot, even after the live profile has changed', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await updateProfile(pid, userId, { overrides: { businessName: 'Totally New Name', description: 'A different business now' }, uniqueSellingPoints: ['Brand new USP'] });
    const provider = mockContentProvider();
    await gen(provider);
    const prompt = provider.calls[0].user;
    assert.match(prompt, /name: Acme Dental/);
    assert.match(prompt, /unique_selling_points: Open late/);
    assert.equal(prompt.includes('Totally New Name'), false);
    assert.equal(prompt.includes('Brand new USP'), false);
    assert.equal(prompt.includes('A different business now'), false);
  });

  test('18: the newest READY strategy version is used, and its version is recorded', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialAIStrategy.updateOne({ project_id: project._id, version: 1 }, { $set: { status: 'archived' } });
    await seedStrategy(pid, { version: 2, mutate: (s) => { s.summary = 'Version two summary'; } });
    await seedStrategy(pid, { version: 3, status: 'failed' });
    const provider = mockContentProvider();
    await gen(provider);
    assert.match(provider.calls[0].user, /strategy_summary: Version two summary/);
    assert.equal((await lastDraft()).generation.strategyVersion, 2);
  });

  // ── prohibited phrases / invention guard / repair ──────────────────────────
  test('19: a prohibited phrase in the output is rejected, ONE repair is attempted, then it succeeds with the corrected text', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const provider = mockContentProvider({
      behavior: ({ callNumber }) => (callNumber === 1 ? validRawPost({ caption: 'The cheapest way to a bright smile. Book a check-up' }) : validRawPost()),
    });
    const r = await gen(provider);
    assert.equal(r.generation.status, 'ready');
    assert.equal(provider.calls.length, 2, 'exactly one repair');
    assert.match(provider.calls[1].user, /<previous_attempt_feedback>[\s\S]*prohibited phrase "cheapest"/);
    assert.equal(provider.calls[0].user.includes('previous_attempt_feedback'), false);
    assert.equal((await lastDraft()).content.includes('cheapest'), false);
    assert.equal(await SocialPublication.countDocuments({ project_id: project._id }), 1);
  });

  test('20: still invalid after the one repair -> failed safely: no draft, user-safe message, MAX_REPAIR_ATTEMPTS honoured', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const provider = mockContentProvider({ behavior: () => validRawPost({ caption: 'The CHEAPEST smile in town. Book a check-up' }) });
    const r = await gen(provider);
    assert.equal(provider.calls.length, 2, 'first attempt + one repair, never more');
    assert.equal(r.generation.status, 'failed');
    assert.equal(r.generation.failure.code, 'AI_BAD_OUTPUT');
    assert.equal(r.generation.failure.message, CONTENT_FAILURE_MESSAGES.AI_BAD_OUTPUT);
    assert.equal(await SocialPublication.countDocuments({ project_id: project._id }), 0);
    const s = await getContentGenerationStatus(pid);
    assert.equal(s.status, 'failed');
    assert.equal(s.publication, null);
  });

  test('21: a phrase the business banned AFTER the strategy was made is still kept out (stricter, never weaker)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await updateProfile(pid, userId, { prohibitedPhrases: ['smile'] });
    const provider = mockContentProvider();
    const r = await gen(provider); // the valid post says "smile"
    assert.equal(r.generation.status, 'failed');
    assert.match(provider.calls[0].user, /<prohibited_phrases>[\s\S]*cheapest[\s\S]*smile[\s\S]*<\/prohibited_phrases>/);
    assert.equal(await SocialPublication.countDocuments({ project_id: project._id }), 0);
  });

  test('22: invented prices/percentages/URLs are rejected; figures the business supplied are allowed', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const invented = mockContentProvider({ behavior: () => validRawPost({ caption: 'Check-ups from only $29 this week. Book a check-up' }) });
    assert.equal((await gen(invented)).generation.status, 'failed');
    assert.equal(await SocialPublication.countDocuments({ project_id: project._id }), 0);
    // a website the business supplied is fine
    const supplied = mockContentProvider({ behavior: () => validRawPost({ caption: 'Learn more at https://acme.example today. Book a check-up' }) });
    assert.equal((await gen(supplied)).generation.status, 'ready');
  });

  test('23: malformed output (not an object, wrong types, unknown extras, echo mismatch) never becomes a draft', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const bads = [null, 'a post', [], validRawPost({ caption: 42 }), validRawPost({ hashtags: 'x' }), validRawPost({ platform: 'instagram' }), validRawPost({ contentPillar: 'Offers' }), validRawPost({ objective: 'soft_sell' }), { caption: 'only a caption' }];
    for (const bad of bads) {
      const r = await gen(mockContentProvider({ behavior: () => bad }));
      assert.equal(r.generation.status, 'failed', JSON.stringify(bad));
      await SocialContentGeneration.deleteMany({ project_id: project._id });
    }
    assert.equal(await SocialPublication.countDocuments({ project_id: project._id }), 0);
  });

  test('24: extra fields the model adds (e.g. a scheduledAt, status or approvalState) are never saved onto the draft', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await gen(mockContentProvider({ behavior: () => ({ ...validRawPost(), scheduledAt: '2030-01-01', status: 'published', approvalState: 'design_approved', contentVersion: 99, externalPostId: 'x' }) }));
    const pub = await lastDraft();
    assert.equal(pub.status, 'draft');
    assert.equal(pub.approvalState, 'content_review');
    assert.equal(pub.contentVersion, 1);
    assert.equal(pub.scheduledAt ?? null, null);
    assert.equal(pub.externalPostId ?? null, null);
  });

  // ── provider failures: safe messages, nothing leaked ───────────────────────
  test('25: provider failures map to user-safe codes; the provider message, key and prompt are never stored or returned', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const cases = [
      [PROVIDER_ERROR.RATE_LIMITED, 'AI_BUSY'], [PROVIDER_ERROR.UNAVAILABLE, 'AI_BUSY'], [PROVIDER_ERROR.TIMEOUT, 'AI_TIMEOUT'], [PROVIDER_ERROR.NETWORK, 'AI_UNREACHABLE'],
      [PROVIDER_ERROR.BAD_OUTPUT, 'AI_BAD_OUTPUT'], [PROVIDER_ERROR.NOT_CONFIGURED, 'AI_UNAVAILABLE'], [PROVIDER_ERROR.AUTH, 'AI_UNAVAILABLE'], [PROVIDER_ERROR.QUOTA, 'AI_UNAVAILABLE'],
      [PROVIDER_ERROR.MISCONFIGURED, 'AI_UNAVAILABLE'], [PROVIDER_ERROR.FAILED, 'GENERATION_FAILED'], ['SOMETHING_UNEXPECTED', 'GENERATION_FAILED'],
    ];
    for (const [providerCode, expected] of cases) {
      const provider = mockContentProvider({ behavior: () => { throw providerError(providerCode, { message: 'sk-SECRET-KEY upstream said: <prompt text>' }); } });
      const r = await gen(provider);
      assert.equal(r.generation.status, 'failed', providerCode);
      assert.equal(r.generation.failure.code, expected, providerCode);
      const stored = JSON.stringify(await SocialContentGeneration.findOne({ project_id: project._id }).lean());
      assert.equal(stored.includes('sk-SECRET'), false);
      assert.equal(stored.includes('prompt text'), false);
      assert.equal(JSON.stringify(r).includes('sk-SECRET'), false);
      await SocialContentGeneration.deleteMany({ project_id: project._id });
    }
    assert.equal(await SocialPublication.countDocuments({ project_id: project._id }), 0);
  });

  test('26: tokens never reach the prompt, the generation record, the status or the draft', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const provider = mockContentProvider();
    const r = await gen(provider);
    const everything = JSON.stringify([provider.calls, r, await getContentGenerationStatus(pid), await SocialContentGeneration.find({ project_id: project._id }).lean(), await lastDraft()]);
    assert.equal(everything.includes('FB-SECRET-TOKEN'), false);
    assert.equal(everything.includes('IG-SECRET-TOKEN'), false);
    assert.equal(/accessToken/i.test(JSON.stringify(await getContentGenerationStatus(pid))), false);
  });

  test('27: a connection lost between the click and the run fails the generation and creates no draft', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    let release;
    const gate = new Promise((res) => { release = res; });
    const provider = mockContentProvider({ gate });
    setContentProviderOverride(provider);
    const started = await startContentGeneration(pid, userId, { platform: 'facebook', contentPillar: 'Dental tips', objective: 'educational' }, { background: true });
    assert.equal(started.generation.status, 'generating');
    await SocialAccount.updateOne({ _id: fb._id }, { $set: { status: 'expired' } });
    release();
    for (let i = 0; i < 100; i += 1) { if ((await SocialContentGeneration.findById(started.generation.id).lean()).status !== 'generating') break; await new Promise((r) => setTimeout(r, 20)); }
    const rec = await SocialContentGeneration.findById(started.generation.id).lean();
    assert.equal(rec.status, 'failed');
    assert.equal(rec.failure.code, 'PLATFORM_NOT_CONNECTED');
    assert.equal(await SocialPublication.countDocuments({ project_id: project._id }), 0);
  });

  // ── concurrency / idempotency ──────────────────────────────────────────────
  test('28: a second request while one is running joins it (alreadyRunning) - one AI call, one draft', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    let release;
    const gate = new Promise((res) => { release = res; });
    const provider = mockContentProvider({ gate });
    setContentProviderOverride(provider);
    const input = { platform: 'facebook', contentPillar: 'Dental tips', objective: 'educational' };
    const a = await startContentGeneration(pid, userId, input, { background: true });
    const b = await startContentGeneration(pid, userId, input, { background: true });
    assert.equal(a.alreadyRunning, false);
    assert.equal(b.alreadyRunning, true);
    assert.equal(b.generation.id, a.generation.id);
    release();
    for (let i = 0; i < 100; i += 1) { if ((await SocialContentGeneration.findById(a.generation.id).lean()).status !== 'generating') break; await new Promise((r) => setTimeout(r, 20)); }
    assert.equal(provider.calls.length, 1);
    assert.equal(await SocialPublication.countDocuments({ project_id: project._id }), 1);
    assert.equal(await SocialContentGeneration.countDocuments({ project_id: project._id }), 1);
  });

  test('29: a burst of simultaneous requests (two tabs, double click) creates exactly one claim and one draft', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const provider = mockContentProvider();
    setContentProviderOverride(provider);
    const input = { platform: 'facebook', contentPillar: 'Dental tips', objective: 'educational' };
    const results = await Promise.all(Array.from({ length: 6 }, () => startContentGeneration(pid, userId, input, { background: true })));
    assert.equal(results.filter((r) => r.started).length, 1, 'the database partial unique index allows one claim');
    assert.equal(new Set(results.map((r) => r.generation.id)).size, 1);
    for (let i = 0; i < 150; i += 1) { if (!(await SocialContentGeneration.countDocuments({ project_id: project._id, status: 'generating' }))) break; await new Promise((r) => setTimeout(r, 20)); }
    assert.equal(await SocialPublication.countDocuments({ project_id: project._id }), 1);
    assert.equal(provider.calls.length, 1);
  });

  test('30: after a generation ends, the next one is a new generation and a new draft (no stale lock)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await gen(mockContentProvider());
    await gen(mockContentProvider());
    assert.equal(await SocialPublication.countDocuments({ project_id: project._id }), 2);
    assert.equal(await SocialContentGeneration.countDocuments({ project_id: project._id }), 2);
  });

  test('31: different projects generate independently, and a project never sees or touches another\'s drafts', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const owner2 = new mongoose.Types.ObjectId();
    const p2 = await newProject(owner2);
    await seedAccounts(p2._id, owner2);
    await seedStrategy(p2._id.toString());
    const [a, b] = await Promise.all([gen(mockContentProvider(), {}, pid, userId), gen(mockContentProvider(), {}, p2._id.toString(), owner2)]);
    assert.equal(a.generation.status, 'ready');
    assert.equal(b.generation.status, 'ready');
    assert.equal(await SocialPublication.countDocuments({ project_id: project._id }), 1);
    assert.equal(await SocialPublication.countDocuments({ project_id: p2._id }), 1);
    // project 1 asking for project 2's generation is refused
    assert.equal((await getContentGenerationStatus(pid, { generationId: b.generation.id })).error.code, 'NOT_FOUND');
    // project 2 has no strategy of its own that project 1 can borrow
    await SocialAIStrategy.deleteMany({ project_id: p2._id });
    assert.equal((await gen(mockContentProvider(), {}, p2._id.toString(), owner2)).error.code, 'NO_STRATEGY');
  });

  // ── interruption ───────────────────────────────────────────────────────────
  test('32: a generation interrupted (process died) is failed after the stale window and cannot create a draft afterwards', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const old = new Date(Date.now() - CONTENT_STALE_MS - 60_000);
    const rec = await SocialContentGeneration.create({
      project_id: project._id, status: 'generating', request: { platform: 'facebook', contentPillar: 'Dental tips', objective: 'educational' },
      strategy: { id: (await SocialAIStrategy.findOne({ project_id: project._id }))._id, version: 1, profileSnapshotHash: 'hash-v1', profileSnapshotGeneratedAt: new Date() },
      social_account_id: fb._id, generation: { startedAt: old, lockedBy: 'dead-instance:1:uuid' },
    });
    const s = await getContentGenerationStatus(pid);
    assert.equal(s.status, 'failed');
    assert.equal(s.generation.failure.code, 'GENERATION_INTERRUPTED');
    // the dead run wakes up late: its conditional write finds nothing
    const provider = mockContentProvider();
    setContentProviderOverride(provider);
    assert.equal(await runContentGeneration(rec._id, 'dead-instance:1:uuid', userId), null);
    assert.equal(provider.calls.length, 0);
    assert.equal(await SocialPublication.countDocuments({ project_id: project._id }), 0);
    // a fresh request is possible again
    assert.equal((await gen(mockContentProvider())).generation.status, 'ready');
  });

  test('33: a recent in-flight generation is NOT recovered', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialContentGeneration.create({
      project_id: project._id, status: 'generating', request: { platform: 'facebook', contentPillar: 'Dental tips', objective: 'educational' },
      strategy: { id: new mongoose.Types.ObjectId(), version: 1 }, social_account_id: fb._id, generation: { startedAt: new Date(), lockedBy: 'live' },
    });
    assert.equal(await recoverStaleContentGenerations(pid), 0);
    setContentProviderOverride(mockContentProvider());
    const r = await startContentGeneration(pid, userId, { platform: 'facebook', contentPillar: 'Dental tips', objective: 'educational' }, { background: false });
    assert.equal(r.alreadyRunning, true);
  });

  test('34: the generation record holds metadata only - no prompt, no caption text, no secrets', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await gen(mockContentProvider());
    const rec = await SocialContentGeneration.findOne({ project_id: project._id }).lean();
    assert.equal(rec.status, 'ready');
    assert.equal(rec.generation.attempts, 1);
    assert.equal(rec.generation.model, 'mock-content-model');
    assert.equal(rec.generation.usage.inputTokens, 50);
    assert.match(rec.generation.promptVersion, /^social-ai-content-v\d+$/);
    const text = JSON.stringify(rec);
    assert.equal(text.includes(validRawPost().caption), false, 'the draft is the single home of the text');
    assert.equal(text.includes('Acme Dental'), false, 'no copy of the business profile');
  });
});

void clone;
