import AiVisibilityPromptSet from '../models/AiVisibilityPromptSet.js';
import { VisibilityError, VISIBILITY_ERROR } from '../../errors/visibilityErrors.js';
import { GENERATOR_VERSION, GENERATED_BY, getPromptConfig } from '../config/promptConfig.js';
import { generatePromptSet } from './promptGenerationService.js';

/**
 * Prompt-set persistence, versioning and reuse (provider-independent).
 *
 *   reuse   a stored set for the same project + profileHash + generatorVersion is returned unchanged. A settled set
 *           (openai | template) is reused indefinitely; a template_fallback set (OpenAI had failed) only for
 *           `fallbackReuseMs`, so a later run retries OpenAI instead of freezing the fallback in.
 *   new     a changed profile (new hash) or generator version produces the next version number; history is never edited.
 *   races   {projectId, version} and the settled-set index are unique. A lost version race retries with the next number
 *           (bounded); a lost settled-set race returns the winner's set. Within one process concurrent requests for the
 *           same profile share a single generation, so only one OpenAI call is made.
 *
 * Known limit: a `template` set (OpenAI unconfigured/disabled at the time) is "settled". Turning OpenAI on later does not
 * silently replace it; it is replaced when the profile changes or GENERATOR_VERSION is bumped.
 */

const MAX_VERSION_ATTEMPTS = 5;
const inflight = new Map();

export function buildInputSnapshot(profile) {
  const { business, market, website } = profile;
  return {
    businessName: business.name,
    nameSource: business.nameSource,
    nameVerified: business.nameVerified,
    nameReliability: business.nameReliability,
    aliases: business.aliases,
    industry: business.industry,
    services: business.services,
    competitors: business.competitors,
    market: {
      scope: market.scope, effectiveScope: market.effectiveScope, city: market.city, state: market.state,
      country: market.country, countryCode: market.countryCode, language: market.language, label: market.label,
    },
    targetHost: website.targetHost,
  };
}

const isDuplicateKey = (e) => e && (e.code === 11000 || e.code === 11001);

async function findReusable(profile, { Model, now, config }) {
  const base = { projectId: profile.projectId, profileHash: profile.profileHash, generatorVersion: GENERATOR_VERSION };
  const settled = await Model.findOne({ ...base, generatedBy: { $in: [GENERATED_BY.OPENAI, GENERATED_BY.TEMPLATE] } }).sort({ version: -1 }).lean();
  if (settled) return settled;
  return Model.findOne({
    ...base,
    generatedBy: GENERATED_BY.TEMPLATE_FALLBACK,
    createdAt: { $gte: new Date(now().getTime() - config.fallbackReuseMs) },
  }).sort({ version: -1 }).lean();
}

async function resolvePromptSet(profile, { Model, generate, now, config }) {
  const existing = await findReusable(profile, { Model, now, config });
  if (existing) return { promptSet: existing, reused: true };

  const generated = await generate(profile);

  for (let attempt = 1; attempt <= MAX_VERSION_ATTEMPTS; attempt += 1) {
    const last = await Model.findOne({ projectId: profile.projectId }).sort({ version: -1 }).select('version').lean();
    const version = (last?.version || 0) + 1;
    try {
      const doc = await Model.create({
        projectId: profile.projectId,
        version,
        profileHash: profile.profileHash,
        generatorVersion: generated.generatorVersion,
        inputSnapshot: buildInputSnapshot(profile),
        prompts: generated.prompts,
        generatedBy: generated.generatedBy,
        fallbackReason: generated.fallbackReason || null,
        model: generated.model || null,
        promptLanguage: generated.promptLanguage || 'en',
        tokenUsage: generated.tokenUsage || { inputTokens: 0, outputTokens: 0 },
        createdAt: now(),
      });
      return { promptSet: doc.toObject(), reused: false };
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      // Same profile won by a concurrent writer (settled-set index)? Use theirs. Otherwise it was the version number: retry.
      if (error.keyPattern?.profileHash || /unique_settled_set_per_profile/.test(error.message || '')) {
        const winner = await findReusable(profile, { Model, now, config });
        if (winner) return { promptSet: winner, reused: true };
      }
    }
  }
  throw new VisibilityError(VISIBILITY_ERROR.PROMPT_SET_PERSIST_FAILED, 'Could not store the prompt set');
}

/**
 * @param {object} profile normalized business profile
 * @param {{Model?:object, generate?:Function, now?:()=>Date, config?:object}} [deps] test seams
 * @returns {Promise<{promptSet:object, reused:boolean}>} promptSet is a plain object (lean)
 */
export function getOrCreatePromptSet(profile, deps = {}) {
  const resolved = {
    Model: deps.Model || AiVisibilityPromptSet,
    generate: deps.generate || generatePromptSet,
    now: deps.now || (() => new Date()),
    config: deps.config || getPromptConfig(),
  };
  const key = `${profile.projectId}:${profile.profileHash}:${GENERATOR_VERSION}`;
  if (inflight.has(key)) return inflight.get(key);
  const promise = resolvePromptSet(profile, resolved).finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

export async function listPromptSets(projectId, { limit = 20, skip = 0, Model = AiVisibilityPromptSet } = {}) {
  return Model.find({ projectId }).sort({ version: -1 }).skip(skip).limit(limit).lean();
}

export async function getPromptSet(projectId, setId, { Model = AiVisibilityPromptSet } = {}) {
  return Model.findOne({ _id: setId, projectId }).lean();
}

export default { getOrCreatePromptSet, listPromptSets, getPromptSet, buildInputSnapshot };
