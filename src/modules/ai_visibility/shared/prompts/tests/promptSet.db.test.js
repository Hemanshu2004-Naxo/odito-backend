import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import AiVisibilityPromptSet from '../models/AiVisibilityPromptSet.js';
import { getOrCreatePromptSet, listPromptSets } from '../services/promptSetService.js';
import { generatePromptSet } from '../services/promptGenerationService.js';
import { GENERATOR_VERSION } from '../config/promptConfig.js';
import { makeProfile, makeSocial } from '../../tests/fixtures.js';
import { connectTestDb, disconnectTestDb, dropTestCollections } from '../../tests/testDb.js';

let up = false;
before(async () => {
  up = await connectTestDb();
  if (up) await AiVisibilityPromptSet.syncIndexes();
});
after(async () => { if (up) await dropTestCollections(['ai_visibility_prompt_sets']); await disconnectTestDb(); });
beforeEach(async () => { if (up) await dropTestCollections(['ai_visibility_prompt_sets']); });

const cfg = { useOpenAi: false, apiKey: '', repairAttempts: 1, fallbackReuseMs: 60_000 };
const gen = (profile) => generatePromptSet(profile, { provider: { isAvailable: () => false }, config: cfg });
const withProject = (profile, projectId) => ({ ...profile, projectId });
const deps = (extra = {}) => ({ generate: gen, config: cfg, ...extra });

describe('prompt-set persistence (isolated MongoDB)', () => {
  test('first call creates version 1 with the validated prompts and input snapshot', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const profile = withProject(makeProfile(), String(new mongoose.Types.ObjectId()));
    const { promptSet, reused } = await getOrCreatePromptSet(profile, deps());
    assert.equal(reused, false);
    assert.equal(promptSet.version, 1);
    assert.equal(promptSet.prompts.length, 5);
    assert.equal(promptSet.generatorVersion, GENERATOR_VERSION);
    assert.equal(promptSet.profileHash, profile.profileHash);
    assert.equal(promptSet.generatedBy, 'template');
    assert.equal(promptSet.inputSnapshot.businessName, 'ASG Eye Hospital');
    assert.ok(!('description' in promptSet.inputSnapshot) && !('keywords' in promptSet.inputSnapshot));
  });

  test('unchanged profile -> the same set is reused (no new version, no generation)', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const profile = withProject(makeProfile(), String(new mongoose.Types.ObjectId()));
    let generations = 0;
    const counted = async (p) => { generations += 1; return gen(p); };
    const first = await getOrCreatePromptSet(profile, deps({ generate: counted }));
    const second = await getOrCreatePromptSet(profile, deps({ generate: counted }));
    assert.equal(second.reused, true);
    assert.equal(String(second.promptSet._id), String(first.promptSet._id));
    assert.equal(generations, 1);
    assert.equal(await AiVisibilityPromptSet.countDocuments({ projectId: profile.projectId }), 1);
  });

  test('a material change produces a NEW version and history is preserved untouched', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const projectId = String(new mongoose.Types.ObjectId());
    const a = withProject(makeProfile(), projectId);
    const b = withProject(makeProfile({ social: makeSocial({ competitors: [{ name: 'New Rival' }] }) }), projectId);
    assert.notEqual(a.profileHash, b.profileHash);
    const v1 = await getOrCreatePromptSet(a, deps());
    const v2 = await getOrCreatePromptSet(b, deps());
    assert.deepEqual([v1.promptSet.version, v2.promptSet.version], [1, 2]);
    const all = await listPromptSets(projectId);
    assert.equal(all.length, 2);
    const original = await AiVisibilityPromptSet.findById(v1.promptSet._id).lean();
    assert.deepEqual(original.prompts, v1.promptSet.prompts); // v1 unchanged
    // going back to the first profile reuses v1 rather than minting v3
    const again = await getOrCreatePromptSet(a, deps());
    assert.equal(again.promptSet.version, 1);
    assert.equal(again.reused, true);
  });

  test('concurrent requests for one profile share a single generation and a single document', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const profile = withProject(makeProfile(), String(new mongoose.Types.ObjectId()));
    let generations = 0;
    const slow = async (p) => { generations += 1; await new Promise((r) => setTimeout(r, 30)); return gen(p); };
    const results = await Promise.all(Array.from({ length: 8 }, () => getOrCreatePromptSet(profile, deps({ generate: slow }))));
    assert.equal(generations, 1);
    assert.equal(new Set(results.map((r) => String(r.promptSet._id))).size, 1);
    assert.equal(await AiVisibilityPromptSet.countDocuments({ projectId: profile.projectId }), 1);
  });

  test('cross-process race on the same profile: the database index makes the loser adopt the winner', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const profile = withProject(makeProfile(), String(new mongoose.Types.ObjectId()));
    // While "this process" is generating, "another process" stores the set for the same profile.
    const racing = async (p) => {
      const winner = await gen(p);
      await AiVisibilityPromptSet.create({ projectId: p.projectId, version: 1, profileHash: p.profileHash, generatorVersion: winner.generatorVersion, inputSnapshot: {}, prompts: winner.prompts, generatedBy: 'template', tokenUsage: { inputTokens: 0, outputTokens: 0 } });
      return gen(p);
    };
    const { promptSet, reused } = await getOrCreatePromptSet(profile, deps({ generate: racing }));
    assert.equal(reused, true);
    assert.equal(promptSet.version, 1);
    assert.equal(await AiVisibilityPromptSet.countDocuments({ projectId: profile.projectId }), 1);
  });

  test('different profiles of one project created concurrently get distinct, gap-free-enough unique versions', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const projectId = String(new mongoose.Types.ObjectId());
    const profiles = ['Alpha Rival', 'Beta Rival', 'Gamma Rival', 'Delta Rival'].map((n) => withProject(makeProfile({ social: makeSocial({ competitors: [{ name: n }] }) }), projectId));
    const results = await Promise.all(profiles.map((p) => getOrCreatePromptSet(p, deps())));
    const versions = results.map((r) => r.promptSet.version).sort();
    assert.deepEqual(versions, [1, 2, 3, 4]);
  });

  test('a template_fallback set is reused only briefly and never blocks a later settled set', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const profile = withProject(makeProfile(), String(new mongoose.Types.ObjectId()));
    const fallbackGen = async (p) => ({ ...(await gen(p)), generatedBy: 'template_fallback', fallbackReason: 'AI_PROVIDER_TIMEOUT' });
    const t0 = new Date('2026-01-01T00:00:00Z');
    const first = await getOrCreatePromptSet(profile, deps({ generate: fallbackGen, now: () => t0 }));
    assert.equal(first.promptSet.generatedBy, 'template_fallback');
    assert.equal(first.promptSet.fallbackReason, 'AI_PROVIDER_TIMEOUT');
    const soon = await getOrCreatePromptSet(profile, deps({ generate: fallbackGen, now: () => new Date(t0.getTime() + 10_000) }));
    assert.equal(soon.reused, true);
    // after the reuse window OpenAI is tried again and its result becomes the settled set for this profile
    const openaiGen = async (p) => ({ ...(await gen(p)), generatedBy: 'openai', model: 'm' });
    const later = await getOrCreatePromptSet(profile, deps({ generate: openaiGen, now: () => new Date(t0.getTime() + 120_000), config: { ...cfg, fallbackReuseMs: 60_000 } }));
    assert.equal(later.reused, false);
    assert.equal(later.promptSet.version, 2);
    assert.equal(later.promptSet.generatedBy, 'openai');
    const final = await getOrCreatePromptSet(profile, deps({ generate: fallbackGen, now: () => new Date(t0.getTime() + 130_000) }));
    assert.equal(final.promptSet.version, 2);
  });

  test('a profile that cannot be turned into prompts stores nothing', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const profile = withProject(makeProfile({ project: { industry: null }, social: null }), String(new mongoose.Types.ObjectId()));
    await assert.rejects(getOrCreatePromptSet(profile, deps()), { code: 'VISIBILITY_INSUFFICIENT_PROFILE' });
    assert.equal(await AiVisibilityPromptSet.countDocuments({ projectId: profile.projectId }), 0);
  });
});
