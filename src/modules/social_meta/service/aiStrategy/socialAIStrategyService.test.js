import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SeoProject from '../../../app_user/model/SeoProject.js';
import GoogleConnection from '../../../app_user/model/GoogleConnection.js';
import BusinessProfileMetadata from '../../../app_user/model/BusinessProfileMetadata.js';
import SocialAccount from '../../model/SocialAccount.js';
import SocialBusinessProfile from '../../model/SocialBusinessProfile.js';
import SocialAIStrategy from '../../model/SocialAIStrategy.js';
import { updateProfile } from '../socialBusinessProfileService.js';
import {
  startGeneration, runGeneration, getStrategyState, getGenerationStatus, recoverStaleGenerations, setProviderOverride, resetProviderOverride, FAILURE_MESSAGES,
} from './socialAIStrategyService.js';
import { STRATEGY_STALE_MS } from './strategyConfig.js';
import { validRawStrategy, mockProvider, providerError } from '../../testSupport/aiStrategyFixtures.js';

/**
 * Real MongoDB, scripted AI provider. Proves the state machine (claim, one-in-flight,
 * stale recovery, version increment, failure isolation), that the strategy consumes
 * the resolved profile and snapshots it, and that nothing fake or secret is saved or returned.
 */

let mongoAvailable = false;
before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
    await SocialAIStrategy.init();
  } catch {
    mongoAvailable = false;
  }
});
after(async () => {
  resetProviderOverride();
  if (mongoAvailable) await mongoose.connection.close();
});

const clone = (o) => JSON.parse(JSON.stringify(o));
const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error('waitFor timed out');
};

describe('AI Strategy service (real MongoDB, scripted provider)', () => {
  let userId, project, pid, created;
  const track = (d) => { created.push(d); return d; };

  async function newProject(extra = {}, owner = userId) {
    return track(await SeoProject.create({
      user_id: owner, project_name: `Strategy ${Date.now()} ${Math.random().toString(36).slice(2, 8)}`, main_url: 'https://example.com', seo_scope: 'local', keywords: ['k'],
      description: 'Family dental practice', industry: 'Dentist', ...extra,
    }));
  }
  const fullProfile = (id = pid, uid = userId) => updateProfile(id, uid, {
    audience: { primary: 'Young families' }, toneOfVoice: { primary: 'Warm' }, goals: ['More bookings'], uniqueSellingPoints: ['Open late'], prohibitedPhrases: ['cheapest'],
  });
  const run = (provider, id = pid, uid = userId) => { setProviderOverride(provider); return startGeneration(id, uid, { background: false }); };

  beforeEach(async () => {
    if (!mongoAvailable) return;
    created = [];
    userId = new mongoose.Types.ObjectId();
    project = await newProject();
    pid = project._id.toString();
  });

  afterEach(async () => {
    resetProviderOverride();
    if (!mongoAvailable) return;
    const ids = created.map((d) => d._id);
    await Promise.all([
      SocialAIStrategy.deleteMany({ project_id: { $in: ids } }),
      SocialBusinessProfile.deleteMany({ project_id: { $in: ids } }),
      SocialAccount.deleteMany({ project_id: { $in: ids } }),
      GoogleConnection.deleteMany({ project_id: { $in: ids } }),
      BusinessProfileMetadata.deleteMany({ project_id: { $in: ids } }),
    ]);
    await SeoProject.deleteMany({ _id: { $in: ids } });
  });

  // ── reading ─────────────────────────────────────────────────────────────
  test('1: no strategy yet — status none, nothing invented, live gaps and canGenerate reported', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const state = await getStrategyState(pid);
    assert.equal(state.status, 'none');
    assert.equal(state.strategy, null);
    assert.equal(state.generation, null);
    assert.equal(state.profile.canGenerate, true);
    assert.equal(state.profile.changed, false);
    assert.ok(state.profile.gaps.some((g) => g.field === 'audience' && g.importance === 'high'));
  });

  test('2: an unknown project reads as null', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    assert.equal(await getStrategyState(new mongoose.Types.ObjectId().toString()), null);
  });

  // ── generation ──────────────────────────────────────────────────────────
  test('3: generating saves a validated READY strategy at version 1 with the exact profile snapshot', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await fullProfile();
    const provider = mockProvider();
    const r = await run(provider);
    assert.equal(r.success, true);
    assert.equal(provider.calls.length, 1);

    const state = await getStrategyState(pid);
    assert.equal(state.status, 'ready');
    assert.equal(state.strategy.version, 1);
    assert.equal(state.strategy.status, 'ready');
    assert.equal(state.strategy.strategy.summary, validRawStrategy().summary);
    const snap = state.strategy.profileSnapshot;
    assert.ok(snap.generatedAt);
    assert.equal(snap.data.business.name, project.project_name);
    assert.equal(snap.data.business.description, 'Family dental practice');
    assert.equal(snap.data.audience.primary, 'Young families');
    assert.deepEqual(snap.data.goals, ['More bookings']);
    assert.equal(state.profile.changed, false);
  });

  test('4: the strategy is built from the RESOLVED profile (an override wins) and the AI is told so', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await fullProfile();
    await updateProfile(pid, userId, { overrides: { businessName: 'Brand Override Name', description: 'Override description' } });
    const provider = mockProvider();
    await run(provider);
    assert.match(provider.calls[0].user, /name: Brand Override Name/);
    assert.match(provider.calls[0].user, /description: Override description/);
    const doc = await SocialAIStrategy.findOne({ project_id: project._id }).lean();
    assert.equal(doc.profileSnapshot.data.business.name, 'Brand Override Name');
  });

  test('5: the server owns connection status and prohibited phrases; the AI cannot change them', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await fullProfile();
    track(await SocialAccount.create({ user_id: userId, project_id: project._id, platform: 'facebook', platformAccountId: 'pg1', platformAccountName: 'Page', accountType: 'page', pageId: 'pg1', accessToken: 'FB-SECRET', status: 'active', isActive: true }));
    await run(mockProvider());
    const s = (await getStrategyState(pid)).strategy.strategy;
    assert.deepEqual(s.platformStrategy.map((p) => [p.platform, p.connected]), [['facebook', true], ['instagram', false]]);
    assert.deepEqual(s.brandRules.prohibitedPhrases, ['cheapest']);
  });

  test('6: percentages are normalised and saved summing to exactly 100', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await fullProfile();
    await run(mockProvider({ behavior: () => { const s = clone(validRawStrategy()); s.contentMix[0].percentage = 47; s.contentPillars[0].suggestedPercentage = 52; return s; } }));
    const s = (await getStrategyState(pid)).strategy.strategy;
    assert.equal(s.contentMix.reduce((a, m) => a + m.percentage, 0), 100);
    assert.equal(s.contentPillars.reduce((a, p) => a + p.suggestedPercentage, 0), 100);
  });

  // ── missing information / gaps ──────────────────────────────────────────
  test('7: missing audience and goals are reported as high gaps and never invented, even if the AI invents them', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    // no Social profile at all: nothing supplied
    const provider = mockProvider({ behavior: () => validRawStrategy() }); // the AI "invents" an audience and goals
    await run(provider);
    const state = await getStrategyState(pid);
    const s = state.strategy.strategy;
    assert.equal(s.audience.primaryAudience, '');
    assert.deepEqual([s.audience.secondaryAudiences, s.audience.painPoints, s.audience.interests, s.audience.motivations], [[], [], [], []]);
    assert.deepEqual(s.goals, []);
    const gaps = Object.fromEntries(state.strategy.strategyGaps.map((g) => [g.field, g]));
    assert.equal(gaps.audience.importance, 'high');
    assert.equal(gaps.goals.importance, 'high');
    assert.equal(gaps.audience.source, 'profile');
    assert.match(provider.calls[0].user, /<missing_information>[\s\S]*audience \(high\)/);
    assert.equal(/primary_audience:/.test(provider.calls[0].user), false);
  });

  test('8: AI-reported gaps are kept; a gap the server already found is not duplicated', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await fullProfile();
    await run(mockProvider({ behavior: () => ({ ...validRawStrategy(), gaps: [{ field: 'offers', reason: 'AI: no offers.', importance: 'low' }, { field: 'competitors', reason: 'dup', importance: 'low' }] }) }));
    const gaps = (await getStrategyState(pid)).strategy.strategyGaps;
    assert.equal(gaps.filter((g) => g.field === 'competitors').length, 1, 'server + AI both found competitors: one entry');
    assert.equal(gaps.find((g) => g.field === 'competitors').source, 'profile');
    assert.equal(gaps.find((g) => g.field === 'offers').source, 'profile', 'offers is also a server gap here');
  });

  test('9: too little to work from — refused with INSUFFICIENT_PROFILE, nothing claimed, the AI is never called', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const bare = await newProject({ description: undefined, industry: undefined, business_type: undefined });
    const provider = mockProvider();
    const r = await run(provider, bare._id.toString());
    assert.equal(r.success, false);
    assert.equal(r.error.code, 'INSUFFICIENT_PROFILE');
    assert.equal(r.error.blockers[0].field, 'description');
    assert.equal(provider.calls.length, 0);
    assert.equal(await SocialAIStrategy.countDocuments({ project_id: bare._id }), 0);
    assert.equal((await getStrategyState(bare._id.toString())).profile.canGenerate, false);
  });

  // ── invalid / failed AI output ──────────────────────────────────────────
  test('10: malformed AI output is never saved; one repair attempt gets Odito\'s own validation messages', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await fullProfile();
    const provider = mockProvider({ behavior: ({ callNumber }) => (callNumber === 1 ? { summary: 'only a summary' } : validRawStrategy()) });
    const r = await run(provider);
    assert.equal(r.generation.status, 'ready');
    assert.equal(provider.calls.length, 2);
    assert.match(provider.calls[1].user, /<previous_attempt_feedback>/);
    assert.match(provider.calls[1].user, /overview: must be an object/); // the first problems found, in schema order
  });

  test('11: output that stays invalid fails the attempt with a safe message, saves NO strategy and falls back to nothing', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await fullProfile();
    const provider = mockProvider({ behavior: () => 'not json at all' });
    const r = await run(provider);
    assert.equal(r.generation.status, 'failed');
    assert.equal(r.generation.failure.code, 'AI_BAD_OUTPUT');
    assert.equal(provider.calls.length, 2, 'initial + one repair, then it stops');
    const doc = await SocialAIStrategy.findOne({ project_id: project._id }).lean();
    assert.equal(doc.status, 'failed');
    assert.equal(doc.strategy, null, 'no partial or placeholder strategy was written');
    const state = await getStrategyState(pid);
    assert.equal(state.status, 'failed');
    assert.equal(state.strategy, null);
    assert.equal(state.generation.failure.message, FAILURE_MESSAGES.AI_BAD_OUTPUT);
  });

  test('12: a strategy using a prohibited phrase is rejected', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await fullProfile();
    const r = await run(mockProvider({ behavior: () => ({ ...validRawStrategy(), recommendations: ['Advertise our cheapest option'] }) }));
    assert.equal(r.generation.status, 'failed');
  });

  test('13: provider failures become user-safe codes; no provider text, key or prompt reaches the document or the API', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await fullProfile();
    const cases = [
      ['CLAUDE_TIMEOUT', 'AI_TIMEOUT'], ['CLAUDE_OVERLOADED', 'AI_BUSY'], ['CLAUDE_RATE_LIMITED', 'AI_BUSY'], ['CLAUDE_NETWORK_ERROR', 'AI_UNREACHABLE'],
      ['CLAUDE_AUTH', 'AI_UNAVAILABLE'], ['CLAUDE_BAD_OUTPUT', 'AI_BAD_OUTPUT'], ['CLAUDE_HTTP_500', 'GENERATION_FAILED'],
    ];
    for (const [providerCode, expected] of cases) {
      const r = await run(mockProvider({ behavior: () => { throw providerError(providerCode, { bodySnippet: 'sk-ant-api03-SECRETKEY leaked body' }); } }));
      assert.equal(r.generation.failure.code, expected, providerCode);
      assert.equal(r.generation.failure.message, FAILURE_MESSAGES[expected]);
    }
    const docs = await SocialAIStrategy.find({ project_id: project._id }).lean();
    const dump = JSON.stringify(docs) + JSON.stringify(await getStrategyState(pid));
    for (const secret of ['sk-ant-api03-SECRETKEY', 'leaked body', 'x-api-key', 'ANTHROPIC']) assert.equal(dump.includes(secret), false, secret);
    assert.equal(dump.includes('You are the social media strategist'), false, 'the system prompt is never stored or returned');
  });

  test('14: AI not configured — fails before anything is claimed (503-class), no document, no call', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await fullProfile();
    const provider = mockProvider({ available: false });
    const r = await run(provider);
    assert.equal(r.success, false);
    assert.equal(r.error.code, 'AI_UNAVAILABLE');
    assert.equal(provider.calls.length, 0);
    assert.equal(await SocialAIStrategy.countDocuments({ project_id: project._id }), 0);
  });

  // ── versions / history / regeneration ───────────────────────────────────
  test('15: regenerating creates the next version, archives the previous one and gives the AI the previous strategy', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await fullProfile();
    await run(mockProvider());
    const provider = mockProvider({ behavior: () => ({ ...validRawStrategy(), summary: 'Second version summary.' }) });
    await run(provider);
    const docs = await SocialAIStrategy.find({ project_id: project._id }).sort({ version: 1 }).lean();
    assert.deepEqual(docs.map((d) => [d.version, d.status]), [[1, 'archived'], [2, 'ready']]);
    const state = await getStrategyState(pid);
    assert.equal(state.strategy.version, 2);
    assert.equal(state.strategy.strategy.summary, 'Second version summary.');
    assert.match(provider.calls[0].user, /<previous_strategy>[\s\S]*summary: Build local trust/);
  });

  test('16: a FAILED regeneration leaves the last good strategy as current; status is failed, never ready-by-accident', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await fullProfile();
    await run(mockProvider());
    const r = await run(mockProvider({ behavior: () => { throw providerError('CLAUDE_TIMEOUT'); } }));
    assert.equal(r.generation.status, 'failed');
    const state = await getStrategyState(pid);
    assert.equal(state.status, 'failed');
    assert.equal(state.strategy.version, 1, 'v1 is still the current strategy');
    assert.equal(state.strategy.strategy.summary, validRawStrategy().summary);
    assert.equal(state.generation.version, 2);
    assert.equal(state.generation.failure.code, 'AI_TIMEOUT');
  });

  test('17: retry after a failure succeeds as the next version and clears the failed state', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await fullProfile();
    await run(mockProvider({ behavior: () => { throw providerError('CLAUDE_OVERLOADED'); } }));
    await run(mockProvider());
    const state = await getStrategyState(pid);
    assert.equal(state.status, 'ready');
    assert.equal(state.strategy.version, 2);
    assert.equal(state.generation, null);
  });

  // ── profile change detection ────────────────────────────────────────────
  test('18: editing the Business Profile flags the strategy as based on an older profile (no auto-regeneration)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await fullProfile();
    const provider = mockProvider();
    await run(provider);
    assert.equal((await getStrategyState(pid)).profile.changed, false);

    await updateProfile(pid, userId, { goals: ['More bookings', 'More reviews'], toneOfVoice: { primary: 'Playful' } });
    const state = await getStrategyState(pid);
    assert.equal(state.profile.changed, true);
    assert.deepEqual(state.profile.changes.sort(), ['goals', 'toneOfVoice']);
    assert.equal(state.status, 'ready', 'the old strategy stays viewable');
    assert.equal(provider.calls.length, 1, 'nothing was regenerated');
    assert.equal(await SocialAIStrategy.countDocuments({ project_id: project._id }), 1);

    await updateProfile(pid, userId, { goals: ['More bookings'], toneOfVoice: { primary: 'Warm' } });
    assert.equal((await getStrategyState(pid)).profile.changed, false, 'reverting the edit clears the warning');
  });

  test('19: Google data changes are detected too, but a new review (rating) is not a profile change', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await fullProfile();
    track(await GoogleConnection.create({ user_id: userId, project_id: project._id, purpose: 'business_profile', service_type: ['business_profile'], business_account_id: 'a1', business_location_id: 'l1', refresh_token: 'SECRET-REFRESH', access_token: 'SECRET-ACCESS', google_email: 'o@example.com', google_name: 'O', status: 'active' }));
    const meta = track(await BusinessProfileMetadata.create({ user_id: userId, project_id: project._id, business_account_id: 'a1', business_location_id: 'l1', business_name: 'Google Name', category: 'Dentist', description: 'Google description', average_rating: 4.5, total_review_count: 10, reviews_capability: { status: 'available' }, metadata_last_synced_at: new Date(), details_last_synced_at: new Date() }));
    await run(mockProvider());
    const snap = (await getStrategyState(pid)).strategy.profileSnapshot.data;
    assert.equal(snap.business.name, 'Google Name');
    assert.equal(snap.business.rating, 4.5);

    await BusinessProfileMetadata.updateOne({ _id: meta._id }, { $set: { average_rating: 3.9, total_review_count: 55 } });
    assert.equal((await getStrategyState(pid)).profile.changed, false);
    await BusinessProfileMetadata.updateOne({ _id: meta._id }, { $set: { description: 'A new Google description' } });
    const state = await getStrategyState(pid);
    assert.equal(state.profile.changed, true);
    assert.deepEqual(state.profile.changes, ['business.description']);
  });

  test('20: tokens and Google ids never appear in the stored snapshot or any API output', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await fullProfile();
    track(await GoogleConnection.create({ user_id: userId, project_id: project._id, purpose: 'business_profile', service_type: ['business_profile'], business_account_id: 'acct-XYZ', business_location_id: 'loc-XYZ', refresh_token: 'SECRET-REFRESH', access_token: 'SECRET-ACCESS', google_email: 'o@example.com', google_name: 'O', status: 'active' }));
    track(await BusinessProfileMetadata.create({ user_id: userId, project_id: project._id, business_account_id: 'acct-XYZ', business_location_id: 'loc-XYZ', business_name: 'G', phone: '+1 555 0100', metadata_last_synced_at: new Date() }));
    track(await SocialAccount.create({ user_id: userId, project_id: project._id, platform: 'facebook', platformAccountId: 'pg1', platformAccountName: 'Page', accountType: 'page', pageId: 'pg1', accessToken: 'FB-SECRET', status: 'active', isActive: true }));
    const provider = mockProvider();
    await run(provider);
    const doc = await SocialAIStrategy.findOne({ project_id: project._id }).lean();
    const dump = JSON.stringify(doc) + JSON.stringify(await getStrategyState(pid)) + provider.calls.map((c) => c.user + c.system).join('\n');
    for (const secret of ['SECRET-REFRESH', 'SECRET-ACCESS', 'FB-SECRET', 'enc:v1', 'acct-XYZ', 'loc-XYZ', 'refresh_token', 'access_token', '+1 555 0100']) assert.equal(dump.includes(secret), false, secret);
  });

  // ── concurrency / lifecycle ─────────────────────────────────────────────
  test('21: a second request while one is running returns the running one — no second job, no second AI call', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await fullProfile();
    let release;
    const gate = new Promise((r) => { release = r; });
    const provider = mockProvider({ gate });
    setProviderOverride(provider);
    const first = await startGeneration(pid, userId);
    assert.equal(first.started, true);
    const second = await startGeneration(pid, userId);
    assert.equal(second.started, false);
    assert.equal(second.alreadyRunning, true);
    assert.equal(second.generation.id, first.generation.id);
    assert.equal((await getGenerationStatus(pid)).status, 'generating');

    release();
    await waitFor(async () => (await getGenerationStatus(pid)).status === 'ready');
    assert.equal(provider.calls.length, 1);
    assert.equal(await SocialAIStrategy.countDocuments({ project_id: project._id }), 1);
  });

  test('22: many simultaneous requests produce exactly one generation (database-enforced)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await fullProfile();
    let release;
    const gate = new Promise((r) => { release = r; });
    const provider = mockProvider({ gate });
    setProviderOverride(provider);
    const results = await Promise.all(Array.from({ length: 8 }, () => startGeneration(pid, userId)));
    assert.equal(results.filter((r) => r.success && r.started).length, 1, 'exactly one request won the claim');
    assert.equal(results.filter((r) => r.alreadyRunning).length, 7);
    assert.equal(await SocialAIStrategy.countDocuments({ project_id: project._id, status: 'generating' }), 1);
    release();
    await waitFor(async () => (await getGenerationStatus(pid)).status === 'ready');
    assert.equal(provider.calls.length, 1);
  });

  test('23: an interrupted generation is recovered as failed after the stale window, and a late result cannot overwrite anything', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await fullProfile();
    const now = new Date();
    const stale = await SocialAIStrategy.create({
      project_id: project._id, version: 1, status: 'generating', profileSnapshot: { generatedAt: now, hash: 'h', data: { audience: { primary: 'x' }, goals: [], connectedPlatforms: {}, prohibitedPhrases: [], business: {} } },
      generation: { startedAt: new Date(now.getTime() - STRATEGY_STALE_MS - 60_000), lockedBy: 'dead-process:1' },
    });
    const status = await getGenerationStatus(pid, { now });
    assert.equal(status.status, 'failed');
    assert.equal(status.generation.failure.code, 'GENERATION_INTERRUPTED');
    assert.equal((await SocialAIStrategy.findById(stale._id).lean()).status, 'failed');

    // the original run finally returns — it must be ignored
    const late = await runGeneration(stale._id, 'dead-process:1');
    assert.equal(late, null);
    assert.equal((await SocialAIStrategy.findById(stale._id).lean()).status, 'failed');
    assert.equal((await SocialAIStrategy.findById(stale._id).lean()).strategy, null);

    // and the project can generate again
    const r = await run(mockProvider());
    assert.equal(r.generation.status, 'ready');
    assert.equal(r.generation.version, 2);
  });

  test('24: a run that is NOT stale is left alone by recovery', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await SocialAIStrategy.create({ project_id: project._id, version: 1, status: 'generating', generation: { startedAt: new Date(), lockedBy: 'live:1' } });
    assert.equal(await recoverStaleGenerations(pid), 0);
    assert.equal((await getGenerationStatus(pid)).status, 'generating');
  });

  test('25: a run whose lock owner is not the one that claimed it cannot write a result', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await fullProfile();
    const doc = await SocialAIStrategy.create({ project_id: project._id, version: 1, status: 'generating', profileSnapshot: { generatedAt: new Date(), hash: 'h', data: {} }, generation: { startedAt: new Date(), lockedBy: 'owner:1' } });
    const provider = mockProvider();
    setProviderOverride(provider);
    assert.equal(await runGeneration(doc._id, 'someone-else:2'), null);
    assert.equal(provider.calls.length, 0);
    assert.equal((await SocialAIStrategy.findById(doc._id).lean()).status, 'generating');
  });

  // ── isolation ───────────────────────────────────────────────────────────
  test('26: project isolation — strategies, status and snapshots of one project are invisible to another', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const other = await newProject({ description: 'Other business' }, new mongoose.Types.ObjectId());
    await fullProfile();
    await updateProfile(other._id.toString(), other.user_id, { goals: ['Other goal'] });
    await run(mockProvider({ behavior: () => ({ ...validRawStrategy(), summary: 'Mine.' }) }));
    await run(mockProvider({ behavior: () => ({ ...validRawStrategy(), summary: 'Theirs.' }) }), other._id.toString(), other.user_id);

    const mine = await getStrategyState(pid);
    const theirs = await getStrategyState(other._id.toString());
    assert.equal(mine.strategy.strategy.summary, 'Mine.');
    assert.equal(theirs.strategy.strategy.summary, 'Theirs.');
    assert.equal(JSON.stringify(mine).includes('Other business'), false);
    assert.equal(JSON.stringify(mine).includes('Other goal'), false);
    assert.equal((await getGenerationStatus(new mongoose.Types.ObjectId().toString())).status, 'none');
    // a generation for one project never blocks or reuses the other's
    assert.equal(await SocialAIStrategy.countDocuments({ project_id: { $in: [project._id, other._id] } }), 2);
  });

  test('27: the public generation object exposes only safe fields (no lock owner, model, usage or prompt version)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await fullProfile();
    const r = await run(mockProvider());
    assert.deepEqual(Object.keys(r.generation).sort(), ['failure', 'finishedAt', 'id', 'planning', 'startedAt', 'status', 'version']);
    const state = await getStrategyState(pid);
    assert.deepEqual(Object.keys(state.strategy).sort(), ['generatedAt', 'id', 'planning', 'profileSnapshot', 'status', 'strategy', 'strategyGaps', 'version']);
    const doc = await SocialAIStrategy.findOne({ project_id: project._id }).lean();
    assert.equal(doc.generation.model, 'mock-model');
    assert.equal(doc.generation.usage.inputTokens, 100);
    assert.equal(JSON.stringify(state).includes('mock-model'), false);
  });

  // ── why a strategy was refused: sanitised, exact, and never shown to the user ──────────
  const captureLogs = () => { const lines = []; const real = { error: console.error, warn: console.warn, info: console.info, log: console.log }; for (const k of Object.keys(real)) console[k] = (...a) => lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); return { lines, restore: () => Object.assign(console, real) }; };
  const overflow = (s, n = 4) => { s.toneAndVoice.avoid = Array.from({ length: n }, (_, i) => `thing to avoid ${i}`); };

  test('24: THE BUG: a strategy whose only problem is a list one entry too long is SAVED (the extra entry is dropped and the list reported), not discarded with a vague failure', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await fullProfile();
    const provider = mockProvider({ behavior: () => { const s = validRawStrategy(); s.toneAndVoice.avoid = Array.from({ length: 12 }, (_, i) => `a different thing to avoid ${i}`); s.brandAnalysis.strengths = Array.from({ length: 6 }, (_, i) => `strength number ${i}`); return s; } });
    const r = await run(provider);
    assert.equal(r.generation.status, 'ready', JSON.stringify(r.generation.failure));
    assert.equal(provider.calls.length, 1, 'no repair call was needed');
    const doc = await SocialAIStrategy.findOne({ project_id: project._id }).lean();
    assert.equal(doc.strategy.toneAndVoice.avoid.length, 10);
    assert.equal(doc.strategy.brandAnalysis.strengths.length, 5);
  });

  test('25: output that stays invalid: the failed generation records WHICH rules failed on each attempt (path + code + rule), the log says so, and neither the user nor any value is exposed', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await fullProfile();
    const bad = () => { const s = validRawStrategy(); s.summary = 'x'.repeat(5000); s.platformStrategy[0].postsPerWeek = '12 posts a week'; s.recommendations = ['Advertise our cheapest option']; return s; };
    const logs = captureLogs();
    let r;
    try { r = await run(mockProvider({ behavior: () => bad() })); } finally { logs.restore(); }
    assert.equal(r.generation.status, 'failed');
    assert.equal(r.generation.failure.code, 'AI_BAD_OUTPUT');
    assert.equal(r.generation.failure.message, FAILURE_MESSAGES.AI_BAD_OUTPUT);
    assert.equal(FAILURE_MESSAGES.AI_BAD_OUTPUT, 'AI returned a strategy Odito could not use. Please try again.');
    const doc = await SocialAIStrategy.findOne({ project_id: project._id }).lean();
    const key = (v) => `${v.attempt}:${v.path}:${v.code}`;
    assert.deepEqual(doc.failure.validation.map(key).sort(), [
      '1:platformStrategy[0].postsPerWeek:WRONG_TYPE', '1:summary:TOO_LONG', '1:strategy:PROHIBITED_PHRASE',
      '2:platformStrategy[0].postsPerWeek:WRONG_TYPE', '2:summary:TOO_LONG', '2:strategy:PROHIBITED_PHRASE',
    ].map((x) => x.replace('1:strategy', '1:recommendations[0]').replace('2:strategy', '2:recommendations[0]')).sort());
    const failedLine = logs.lines.find((l) => l.includes('Generation failed'));
    assert.ok(failedLine, 'the failure is logged');
    for (const expected of ['validationErrors', 'summary', 'TOO_LONG', 'WRONG_TYPE', 'PROHIBITED_PHRASE', 'STRATEGY_INVALID']) assert.ok(failedLine.includes(expected), expected);
    for (const secret of ['cheapest', 'xxxxxxxx', '12 posts a week', 'Family dental practice', 'Young families']) assert.equal(failedLine.includes(secret) || JSON.stringify(doc.failure).includes(secret), false, `no value leaks: ${secret}`);
    const api = JSON.stringify(await getStrategyState(pid));
    assert.equal(api.includes('validation'), false, 'the technical details never reach the client');
    assert.equal(api.includes('TOO_LONG'), false);
    assert.ok(doc.generation.usage.outputTokens >= 0 && doc.generation.attempts === 2);
  });

  test('26: invalid first, then a valid repair: the repair prompt lists the failed FIELDS with their rules, and the result is READY', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await fullProfile();
    const provider = mockProvider({ behavior: ({ callNumber }) => { if (callNumber === 1) { const s = validRawStrategy(); s.summary = 'x'.repeat(5000); s.goals = 'not a list'; return s; } return validRawStrategy(); } });
    const r = await run(provider);
    assert.equal(r.generation.status, 'ready');
    assert.equal(provider.calls.length, 2);
    const repair = provider.calls[1].user;
    assert.match(repair, /summary: must be \d+ characters or fewer/);
    assert.match(repair, /goals: /);
    assert.match(repair, /Return a corrected strategy/);
    assert.equal(repair.includes('xxxxxxxx'), false, 'the invalid value itself is not echoed back');
  });

  test('27: a repair that breaks a BUSINESS rule is still refused (prohibited phrase, in the field where it appears), and the last good strategy stays current', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await fullProfile();
    assert.equal((await run(mockProvider())).generation.status, 'ready');
    const provider = mockProvider({ behavior: ({ callNumber }) => { const s = validRawStrategy(); if (callNumber === 1) s.summary = 'x'.repeat(5000); else s.brandAnalysis.weaknesses[0] = 'Our cheapest plan is hard to explain'; return s; } });
    const r = await run(provider);
    assert.equal(r.generation.status, 'failed');
    const failed = await SocialAIStrategy.findOne({ project_id: project._id, status: 'failed' }).lean();
    assert.ok(failed.failure.validation.some((v) => v.attempt === 2 && v.path === 'brandAnalysis.weaknesses[0]' && v.code === 'PROHIBITED_PHRASE'));
    const state = await getStrategyState(pid);
    assert.equal(state.strategy.version, 1, 'the last good strategy is still the current one');
  });

  test('28: an empty, malformed or truncated tool result fails with explicit sanitised errors (never a crash, never a saved strategy)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await fullProfile();
    for (const bad of [{}, [], 'text', null]) {
      await SocialAIStrategy.deleteMany({ project_id: project._id });
      const r = await run(mockProvider({ behavior: () => bad }));
      assert.equal(r.generation.status, 'failed', JSON.stringify(bad));
      const doc = await SocialAIStrategy.findOne({ project_id: project._id }).lean();
      assert.ok(doc.failure.validation.length > 0, `explicit errors for ${JSON.stringify(bad)}`);
      assert.equal(doc.strategy, null);
    }
    // a provider-level refusal (truncated at the token limit) is reported by its reason code
    await SocialAIStrategy.deleteMany({ project_id: project._id });
    const logs = captureLogs();
    try { await run(mockProvider({ behavior: () => { throw providerError('CLAUDE_BAD_OUTPUT', { reason: 'max_tokens_truncated' }); } })); } finally { logs.restore(); }
    const line = logs.lines.find((l) => l.includes('Generation failed'));
    assert.ok(line.includes('max_tokens_truncated') && line.includes('CLAUDE_BAD_OUTPUT'));
  });
});
