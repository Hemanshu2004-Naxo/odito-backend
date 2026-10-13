import os from 'os';
import crypto from 'crypto';
import mongoose from 'mongoose';
import SocialAIStrategy from '../../model/SocialAIStrategy.js';
import SeoProject from '../../../app_user/model/SeoProject.js';
import { resolveSocialBusinessProfile } from '../socialBusinessProfileResolver.js';
import { buildProfileSnapshot, buildProfileData, hashProfileData, diffProfileData, computeProfileGaps, generationBlockers, snapshotFactsText } from './profileSnapshot.js';
import { buildSystemPrompt, buildUserPrompt, PROMPT_VERSION } from './socialAIStrategyPromptBuilder.js';
import { attemptRecord, flattenAttempts, describeProviderFailure } from './strategyDiagnostics.js';
import { validateStrategyOutput } from './strategyOutputSchema.js';
import { validateStrategyPlanning, toStoredPlanning, toApiPlanning, splitAcross } from './strategyPlanning.js';
import { checkQuotaFor } from '../calendar/calendarQuotaService.js';
import claudeStrategyProvider from './claudeStrategyProvider.js';
import { STRATEGY_STALE_MS, STRATEGY_MAX_REPAIR_ATTEMPTS, STRATEGY_HISTORY_LIMIT } from './strategyConfig.js';
import { LoggerUtil } from '../../../../utils/LoggerUtil.js';

/**
 * socialAIStrategyService — AI Strategy generation, state and read model.
 *
 * It CONSUMES `resolvedProfile` (socialBusinessProfileResolver.js); it contains no
 * Google / project precedence logic of its own. The profile is resolved ONCE per
 * generation and stored as `profileSnapshot`; the generation then runs entirely
 * from that stored snapshot, so what the AI saw is exactly what is recorded.
 *
 * Generation architecture. A strategy call takes tens of seconds, so it never
 * runs inside the HTTP request: startGeneration() atomically CLAIMS the work by
 * inserting a `generating` SocialAIStrategy (a partial unique index allows only
 * one per project, across processes) and returns immediately; the call runs in
 * the background of this Node process (it is I/O-bound, so it does not block the
 * event loop) and the client polls /status. The Odito Job collection was
 * deliberately not used: it is the audit pipeline's queue (Python workers,
 * chaining, shared stale-lock recovery), and every Node-only job type so far has
 * needed edits to the shared Job enum, config, indexes and recovery code. The
 * strategy document is its own durable job record instead: claim = insert,
 * result = a conditional update by lock owner, interruption = a time-based
 * recovery (STRATEGY_STALE_MS) that fails the attempt so the project can retry.
 *
 * A failed attempt never touches the last good strategy; "current" is always the
 * highest `ready` version.
 */

const SERVICE = 'SocialAIStrategy';
const INSTANCE = `${os.hostname()}:${process.pid}`;

let _providerOverride = null;
/** Test seam: substitute the AI provider (same interface as ClaudeStrategyProvider). */
export function setProviderOverride(provider) { _providerOverride = provider || null; }
export function resetProviderOverride() { _providerOverride = null; }
const getProvider = () => _providerOverride || claudeStrategyProvider;

/** How many of Odito's own validation messages a repair attempt is shown. */
const MAX_REPAIR_FEEDBACK = 15;

const toId = (id) => (mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : id);
const iso = (d) => (d ? new Date(d).toISOString() : null);

// ── failures (user-safe; never a provider message, prompt or key) ────────────

export const FAILURE_MESSAGES = Object.freeze({
  AI_UNAVAILABLE: 'AI strategy generation is not available right now. Please try again later.',
  AI_BUSY: 'The AI service is busy right now. Please try again in a few minutes.',
  AI_TIMEOUT: 'The AI took too long to respond. Please try again.',
  AI_UNREACHABLE: 'Odito could not reach the AI service. Please try again.',
  AI_BAD_OUTPUT: 'AI returned a strategy Odito could not use. Please try again.',
  GENERATION_INTERRUPTED: 'Strategy generation was interrupted. Please try again.',
  GENERATION_FAILED: 'Strategy generation failed. Please try again.',
});

export function failureFor(error) {
  const map = {
    CLAUDE_NOT_CONFIGURED: 'AI_UNAVAILABLE', CLAUDE_AUTH: 'AI_UNAVAILABLE',
    CLAUDE_RATE_LIMITED: 'AI_BUSY', CLAUDE_OVERLOADED: 'AI_BUSY',
    CLAUDE_TIMEOUT: 'AI_TIMEOUT', CLAUDE_NETWORK_ERROR: 'AI_UNREACHABLE',
    CLAUDE_BAD_OUTPUT: 'AI_BAD_OUTPUT', STRATEGY_INVALID: 'AI_BAD_OUTPUT',
  };
  const code = map[error?.code] || 'GENERATION_FAILED';
  return { code, message: FAILURE_MESSAGES[code] };
}

// ── read model ───────────────────────────────────────────────────────────────

function toApiStrategy(doc) {
  return {
    id: String(doc._id),
    version: doc.version,
    status: doc.status,
    generatedAt: iso(doc.generation?.finishedAt),
    strategy: doc.strategy,
    strategyGaps: doc.strategyGaps || [],
    // the planning choice this version was created with (null for a version saved before the wizard)
    planning: toApiPlanning(doc.planning),
    // the exact business facts the AI was given (no tokens, no Google ids)
    profileSnapshot: { generatedAt: iso(doc.profileSnapshot?.generatedAt), data: doc.profileSnapshot?.data || null },
  };
}

function toApiGeneration(doc) {
  return {
    id: String(doc._id),
    version: doc.version,
    status: doc.status,
    startedAt: iso(doc.generation?.startedAt),
    finishedAt: iso(doc.generation?.finishedAt),
    // the choice this attempt was started with: a failed attempt keeps it, so the person retries with the same selections
    planning: toApiPlanning(doc.planning),
    failure: doc.status === 'failed' ? { code: doc.failure?.code || 'GENERATION_FAILED', message: doc.failure?.message || FAILURE_MESSAGES.GENERATION_FAILED } : null,
  };
}

/** Fails any attempt that has been `generating` longer than STRATEGY_STALE_MS (process died / provider hung). */
export async function recoverStaleGenerations(projectId, { now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - STRATEGY_STALE_MS);
  const result = await SocialAIStrategy.updateMany(
    { project_id: toId(projectId), status: 'generating', 'generation.startedAt': { $lt: cutoff } },
    { $set: { status: 'failed', 'generation.finishedAt': now, failure: { code: 'GENERATION_INTERRUPTED', message: FAILURE_MESSAGES.GENERATION_INTERRUPTED, at: now } } },
  );
  if (result.modifiedCount) LoggerUtil.warn(`[SOCIAL_AI_STRATEGY] Recovered ${result.modifiedCount} interrupted generation(s)`, { projectId: String(projectId) });
  return result.modifiedCount;
}

async function latestAndCurrent(projectId) {
  const pid = toId(projectId);
  const [latest, current] = await Promise.all([
    SocialAIStrategy.findOne({ project_id: pid, status: { $in: ['generating', 'failed', 'ready'] } }).sort({ version: -1 }).lean(),
    SocialAIStrategy.findOne({ project_id: pid, status: 'ready' }).sort({ version: -1 }).lean(),
  ]);
  return { latest, current };
}

function describeAttempt(latest, current) {
  // an attempt only matters if it is NEWER than the current ready strategy
  return latest && latest.version > (current?.version || 0) && latest.status !== 'ready' ? latest : null;
}

/** Cheap read for polling: no profile resolution. */
export async function getGenerationStatus(projectId, { now = new Date() } = {}) {
  await recoverStaleGenerations(projectId, { now });
  const { latest, current } = await latestAndCurrent(projectId);
  const attempt = describeAttempt(latest, current);
  const status = attempt ? (attempt.status === 'generating' ? 'generating' : 'failed') : (current ? 'ready' : 'none');
  return { status, currentVersion: current?.version || null, generation: attempt ? toApiGeneration(attempt) : null };
}

/** The live profile as strategy data (one resolver call, logo skipped so this is cheap and network-free). */
async function liveProfile(projectId) {
  const [resolved, project] = await Promise.all([
    resolveSocialBusinessProfile(projectId, { includeLogo: false }),
    SeoProject.findById(projectId).select('seo_scope').lean(),
  ]);
  if (!resolved) return null;
  // the resolver returns { resolvedProfile, editableProfile, googleStatus }; the strategy consumes resolvedProfile
  return { resolved: resolved.resolvedProfile, seoScope: project?.seo_scope || null };
}

/** Hash of the live profile in the strategy's own terms (the same one a strategy stores), or null if the project is gone. */
export async function getLiveProfileHash(projectId) {
  const live = await liveProfile(projectId);
  return live ? hashProfileData(buildProfileData(live.resolved, { seoScope: live.seoScope })) : null;
}

/** Full read model: current strategy, latest attempt, and how the live Business Profile compares. */
export async function getStrategyState(projectId, { now = new Date() } = {}) {
  await recoverStaleGenerations(projectId, { now });
  const [{ latest, current }, live] = await Promise.all([latestAndCurrent(projectId), liveProfile(projectId)]);
  if (!live) return null;

  const data = buildProfileData(live.resolved, { seoScope: live.seoScope });
  const blockers = generationBlockers(data);
  const attempt = describeAttempt(latest, current);
  const changed = !!current && hashProfileData(data) !== current.profileSnapshot?.hash;

  return {
    status: attempt ? (attempt.status === 'generating' ? 'generating' : 'failed') : (current ? 'ready' : 'none'),
    strategy: current ? toApiStrategy(current) : null,
    generation: attempt ? toApiGeneration(attempt) : null,
    profile: {
      changed,
      changes: changed ? diffProfileData(current.profileSnapshot?.data, data) : [],
      gaps: computeProfileGaps(data),
      canGenerate: blockers.length === 0,
      blockers,
      connectedPlatforms: data.connectedPlatforms,
    },
  };
}

// ── generation ───────────────────────────────────────────────────────────────

const fail = (code, message, extra = {}) => ({ success: false, error: { code, message, ...extra } });

function isInFlightConflict(error) {
  if (error?.code !== 11000) return false;
  if (error.keyPattern) return !('version' in error.keyPattern);
  return String(error.message).includes('unique_strategy_generating_in_flight');
}

/**
 * Starts a generation for the project. Idempotent per project: if one is already
 * in flight it is returned instead of starting a second.
 *
 * @param {object} [options]
 * @param {boolean} [options.background=true]  false awaits the whole run (tests)
 */
export async function startGeneration(projectId, userId, { now = new Date(), background = true, planning: planningInput, expectedVersion, requestId, today } = {}) {
  // The planning choice is checked FIRST and by the calendar planner: an unsupported value is refused before anything is claimed or written.
  let planning = null;
  if (planningInput !== undefined && planningInput !== null) {
    const checked = validateStrategyPlanning(planningInput, today ? { today } : undefined);
    if (checked.error) return { success: false, error: checked.error };
    planning = checked.value;
  }
  if (expectedVersion !== undefined && expectedVersion !== null && (!Number.isInteger(expectedVersion) || expectedVersion < 0)) return fail('INVALID_FIELD', 'expectedVersion must be a whole number.', { field: 'expectedVersion' });
  if (requestId !== undefined && requestId !== null && !(typeof requestId === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(requestId))) return fail('INVALID_FIELD', 'requestId must be 8-80 letters, digits, - or _.', { field: 'requestId' });

  const provider = getProvider();
  // Fail fast, before anything is claimed or written, when AI is not configured.
  if (!provider.isAvailable()) return fail('AI_UNAVAILABLE', FAILURE_MESSAGES.AI_UNAVAILABLE);

  await recoverStaleGenerations(projectId, { now });

  const running = await SocialAIStrategy.findOne({ project_id: toId(projectId), status: 'generating' }).lean();
  if (running) return { success: true, started: false, alreadyRunning: true, generation: toApiGeneration(running) };

  // The same request sent again (a lost response, a double click that slipped past the client) is the same version, never a second one.
  if (requestId) {
    const same = await SocialAIStrategy.findOne({ project_id: toId(projectId), 'generation.requestId': requestId, status: { $in: ['generating', 'ready'] } }).lean();
    if (same) return { success: true, started: false, alreadyRunning: same.status === 'generating', alreadyDone: same.status === 'ready', generation: toApiGeneration(same) };
  }

  // Optimistic concurrency: the person decided against the strategy they saw. If a newer one exists, they must look again first.
  if (expectedVersion !== undefined && expectedVersion !== null) {
    const current = await SocialAIStrategy.findOne({ project_id: toId(projectId), status: 'ready' }).sort({ version: -1 }).select('version').lean();
    if ((current?.version || 0) !== expectedVersion) return fail('STRATEGY_CONFLICT', 'The strategy changed since you opened this page. Reload to see the latest version, then try again.', { currentVersion: current?.version || 0 });
  }

  const live = await liveProfile(projectId);
  if (!live) return fail('NOT_FOUND', 'Project not found.');
  const snapshot = buildProfileSnapshot(live.resolved, { seoScope: live.seoScope, now });
  const blockers = generationBlockers(snapshot.data);
  if (blockers.length) return fail('INSUFFICIENT_PROFILE', blockers[0].reason, { blockers });

  const lockedBy = `${INSTANCE}:${crypto.randomUUID()}`;
  let doc = null;
  for (let attempt = 0; attempt < 3 && !doc; attempt += 1) {
    const last = await SocialAIStrategy.findOne({ project_id: toId(projectId) }).sort({ version: -1 }).select('version').lean();
    try {
      doc = await SocialAIStrategy.create({
        project_id: toId(projectId),
        version: (last?.version || 0) + 1,
        status: 'generating',
        profileSnapshot: snapshot,
        generation: { startedAt: now, lockedBy, promptVersion: PROMPT_VERSION, requestId: requestId || null },
        planning: planning ? toStoredPlanning(planning, now) : null,
        generatedBy: userId || null,
      });
    } catch (error) {
      if (isInFlightConflict(error)) {
        const existing = await SocialAIStrategy.findOne({ project_id: toId(projectId), status: 'generating' }).lean();
        return { success: true, started: false, alreadyRunning: true, generation: existing ? toApiGeneration(existing) : null };
      }
      if (error?.code !== 11000) throw error; // a version collision just loops and re-reads the latest version
    }
  }
  if (!doc) return fail('CONFLICT', 'Another generation started at the same time. Please try again.');

  LoggerUtil.info('[SOCIAL_AI_STRATEGY] Generation claimed', { projectId: String(projectId), strategyId: String(doc._id), version: doc.version });

  const run = () => runGeneration(doc._id, lockedBy).catch((error) => {
    // runGeneration records its own failures; this is only for bookkeeping that itself broke
    LoggerUtil.error('[SOCIAL_AI_STRATEGY] Generation bookkeeping failed', { message: error.message }, { strategyId: String(doc._id) });
  });
  if (background) {
    setImmediate(run);
    return { success: true, started: true, alreadyRunning: false, generation: toApiGeneration(doc) };
  }
  await run();
  const finished = await SocialAIStrategy.findById(doc._id).lean();
  return { success: true, started: true, alreadyRunning: false, generation: toApiGeneration(finished) };
}

/** The strategy as saved: the AI's validated output plus the parts the SERVER owns. */
function assemble(validated, snapshotData, profileGaps, planning = null) {
  const strategy = JSON.parse(JSON.stringify(validated.strategy));

  // The person's frequency is a decision, not a suggestion: whatever the AI wrote, the stored strategy says what was chosen, and the per-platform
  // numbers add up to it.
  if (planning) {
    const ppw = planning.postsPerWeek;
    const range = strategy.postingStrategy.postsPerWeekRange;
    strategy.postingStrategy.postsPerWeek = ppw;
    strategy.postingStrategy.postsPerWeekRange = { min: Math.min(range.min, ppw), max: Math.max(range.max, ppw) };
    const split = splitAcross(strategy.platformStrategy.map((p) => p.postsPerWeek), ppw);
    strategy.platformStrategy = strategy.platformStrategy.map((p, i) => ({ ...p, postsPerWeek: split[i] }));
  }

  // Do not let the AI present an audience / goals the business never supplied.
  if (!(snapshotData.audience.primary || '').trim()) {
    strategy.audience = { primaryAudience: '', secondaryAudiences: [], painPoints: [], needs: [], motivations: [], buyingTriggers: [], objections: [], interests: [] };
  }
  if (!snapshotData.goals.length) strategy.goals = [];

  // Competitor analysis exists only for competitors the business supplied; with none, it is empty whatever the AI wrote.
  const supplied = (snapshotData.competitors || []).map((c) => c.name).filter(Boolean);
  strategy.competitorAnalysis = supplied.length
    ? { hasCompetitorData: true, analysisBasis: 'supplied_competitors', ...strategy.competitorAnalysis }
    : { hasCompetitorData: false, analysisBasis: 'none', competitorsConsidered: [], differentiationOpportunities: [], contentGaps: [], recommendations: [] };

  // Odito has no live trend / search / social data, and the server (not the AI) says so: the topics are recommendations.
  strategy.trendDataSource = 'none';

  // Connection status and the business's own prohibited phrases are facts, not AI opinions.
  strategy.platformStrategy = strategy.platformStrategy.map((p) => ({ ...p, connected: !!snapshotData.connectedPlatforms[p.platform] }));
  strategy.brandRules = { visualGuidelines: strategy.brandRules.visualGuidelines, messagingRules: strategy.brandRules.messagingRules, prohibitedPhrases: [...snapshotData.prohibitedPhrases] };

  // Gaps: the server's own findings win; the AI may add ones the server cannot know.
  const known = new Set(profileGaps.map((g) => g.field));
  const gaps = [...profileGaps, ...validated.gaps.filter((g) => !known.has(g.field))];
  return { strategy, gaps };
}

/**
 * Runs one claimed generation to completion. Writes only through conditional
 * updates keyed on the lock owner, so an attempt that was recovered as
 * interrupted (or otherwise superseded) can never overwrite anything.
 */
export async function runGeneration(strategyId, lockedBy) {
  const doc = await SocialAIStrategy.findOne({ _id: strategyId, status: 'generating', 'generation.lockedBy': lockedBy }).lean();
  if (!doc) return null;
  const snapshotData = doc.profileSnapshot.data;
  const profileGaps = computeProfileGaps(snapshotData);
  const started = Date.now();
  const usage = { inputTokens: 0, outputTokens: 0 };
  let attempts = 0;
  let model = null;

  try {
    const previousDoc = await SocialAIStrategy.findOne({ project_id: doc.project_id, status: 'ready' }).sort({ version: -1 }).select('strategy.summary strategy.contentPillars').lean();
    const previous = previousDoc?.strategy ? { summary: previousDoc.strategy.summary, contentPillars: previousDoc.strategy.contentPillars } : null;
    // the choice stored on THIS attempt (re-validated, so a document edited by hand can never feed the prompt something unsupported)
    const chosen = doc.planning ? validateStrategyPlanning({ postsPerWeek: doc.planning.postsPerWeek, months: doc.planning.months, platforms: doc.planning.platforms }) : null;
    const planning = chosen?.value ? { postsPerWeek: chosen.value.postsPerWeek, months: chosen.value.months, totalPosts: chosen.value.estimatedPosts, platforms: chosen.value.platforms } : null;
    const provider = getProvider();
    const system = buildSystemPrompt();

    let validated = null;
    let feedback = [];
    const rejected = []; // sanitized record of every attempt Odito's validation refused: paths + codes + rules, never values
    for (let i = 0; i <= STRATEGY_MAX_REPAIR_ATTEMPTS && !validated; i += 1) {
      const result = await provider.generateStrategy({ system, user: buildUserPrompt({ snapshotData, profileGaps, previous, repairFeedback: feedback, planning }), generationId: String(strategyId) });
      attempts += result.attempts || 1;
      usage.inputTokens += result.usage?.inputTokens || 0;
      usage.outputTokens += result.usage?.outputTokens || 0;
      model = result.model || model;
      const check = validateStrategyOutput(result.parsed, {
        prohibitedPhrases: snapshotData.prohibitedPhrases,
        suppliedCompetitors: (snapshotData.competitors || []).map((c) => c.name),
        allowedFactsText: snapshotFactsText(snapshotData),
        expectedPlatforms: planning?.platforms || null,
      });
      if (check.ok) validated = check;
      else {
        feedback = check.errors.slice(0, MAX_REPAIR_FEEDBACK);
        rejected.push(attemptRecord({ attempt: i + 1, errors: check.errors, outputTokens: result.usage?.outputTokens || 0 }));
      }
    }
    if (!validated) {
      const err = new Error('STRATEGY_INVALID');
      err.code = 'STRATEGY_INVALID';
      err.validation = rejected;
      throw err;
    }

    const { strategy, gaps } = assemble(validated, snapshotData, profileGaps, planning);
    const finishedAt = new Date();
    const saved = await SocialAIStrategy.findOneAndUpdate(
      { _id: strategyId, status: 'generating', 'generation.lockedBy': lockedBy },
      { $set: { status: 'ready', strategy, strategyGaps: gaps, 'generation.finishedAt': finishedAt, 'generation.model': model, 'generation.attempts': attempts, 'generation.durationMs': Date.now() - started, 'generation.usage': usage, failure: { code: null, message: null, at: null } } },
      { new: true },
    ).lean();
    if (!saved) {
      LoggerUtil.warn('[SOCIAL_AI_STRATEGY] Result discarded: the attempt was no longer the active generation', { strategyId: String(strategyId) });
      return null;
    }

    // The previous ready version becomes history; very old history is pruned.
    await SocialAIStrategy.updateMany({ project_id: doc.project_id, status: 'ready', version: { $lt: saved.version } }, { $set: { status: 'archived' } });
    await SocialAIStrategy.deleteMany({ project_id: doc.project_id, status: 'archived', version: { $lte: saved.version - STRATEGY_HISTORY_LIMIT } });
    LoggerUtil.info('[SOCIAL_AI_STRATEGY] Strategy ready', { projectId: String(doc.project_id), strategyId: String(strategyId), version: saved.version, durationMs: Date.now() - started, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, trimmedLists: validated.trimmed?.length ? validated.trimmed : undefined });
    return saved;
  } catch (error) {
    const failure = failureFor(error);
    const at = new Date();
    await SocialAIStrategy.findOneAndUpdate(
      { _id: strategyId, status: 'generating', 'generation.lockedBy': lockedBy },
      { $set: { status: 'failed', 'generation.finishedAt': at, 'generation.attempts': attempts, 'generation.durationMs': Date.now() - started, 'generation.usage': usage, ...(model ? { 'generation.model': model } : {}), failure: { ...failure, at, validation: flattenAttempts(error?.validation || []) } } },
    );
    // technical detail goes to the server log only: codes, the sanitized validation rules (path + code + rule, never a value) and token counts - never to the client
    LoggerUtil.error('[SOCIAL_AI_STRATEGY] Generation failed', { ...describeProviderFailure(error), message: error?.code ? undefined : error?.message, validationErrors: error?.validation ? flattenAttempts(error.validation) : undefined, outputTokens: usage.outputTokens, attempts }, { strategyId: String(strategyId), failureCode: failure.code });
    return null;
  }
}

export default { startGeneration, runGeneration, getStrategyState, getGenerationStatus, recoverStaleGenerations, setProviderOverride, resetProviderOverride, failureFor, FAILURE_MESSAGES };
