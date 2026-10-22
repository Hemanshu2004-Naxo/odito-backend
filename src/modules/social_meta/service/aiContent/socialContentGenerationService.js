import os from 'os';
import crypto from 'crypto';
import mongoose from 'mongoose';
import SocialAIStrategy from '../../model/SocialAIStrategy.js';
import SocialContentGeneration from '../../model/SocialContentGeneration.js';
import SocialContentCalendarItem from '../../model/SocialContentCalendarItem.js';
import { linkPublicationToItem } from '../calendar/calendarItemLinks.js';
import SeoProject from '../../../app_user/model/SeoProject.js';
import { getActiveFacebookAccount, getActiveInstagramAccount } from '../facebookAccountService.js';
import { findProfile } from '../socialBusinessProfileService.js';
import { createPublication, submitContentForApproval, getPublication } from '../socialPublishingService.js';
import { CONTENT_MIX_TYPES } from '../aiStrategy/strategyOutputSchema.js';
import { snapshotFactsText } from '../aiStrategy/profileSnapshot.js';
import { FAILURE_MESSAGES, failureFor } from '../aiStrategy/socialAIStrategyService.js';
import { PLATFORMS, validateContentOutput } from './contentOutputSchema.js';
import { getDefaultContentProvider } from './providers/index.js';
import { PROVIDER_FAILURE_CODE } from './providers/contentProviderErrors.js';
import { buildSystemPrompt, buildUserPrompt, CONTENT_PROMPT_VERSION } from './socialContentPromptBuilder.js';
import { CONTENT_MAX_REPAIR_ATTEMPTS, CONTENT_STALE_MS } from './contentConfig.js';
import { LoggerUtil } from '../../../../utils/LoggerUtil.js';

/**
 * socialContentGenerationService - ONE AI-written post -> a real SocialPublication
 * DRAFT that then goes through the EXISTING content approval workflow.
 *
 *   validate request (platform / pillar / objective, against the STORED strategy)
 *     -> claim (database-enforced: one generation in flight per project)  -> 202
 *     -> background: prompt from the strategy's stored profile snapshot -> AI (structured)
 *     -> strict validation (+ one repair)  -> createPublication (status 'draft')
 *     -> submitContentForApproval (the existing workflow decides the approval state)
 *
 * What this service never does: call Meta, schedule, publish, approve, write an approval
 * state itself, or read the live Business Profile to build the post. The ONE live read is
 * the profile's prohibited phrases, which are unioned with the snapshot's - a phrase the
 * business has banned since the strategy was made must still be kept out, so this can only
 * make the rules stricter, never weaker.
 *
 * Why a small SocialContentGeneration record at all: a generation can fail before any
 * draft exists (nothing else could hold that failure), and the lock that stops double
 * clicks / two tabs from creating two drafts has to live in the database. Same pattern as
 * the AI Strategy (claim = insert, result = conditional update by lock owner, interruption
 * = time-based recovery).
 */

const INSTANCE = `${os.hostname()}:${process.pid}`;
const toId = (id) => (mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : id);
const iso = (d) => (d ? new Date(d).toISOString() : null);
const fail = (code, message, extra = {}) => ({ success: false, error: { code, message, ...extra } });

// ── provider seam ────────────────────────────────────────────────────────────

// The service depends on a provider CONTRACT - isAvailable(), generateContent({ system, user }) - and never
// on a vendor. Which provider writes single posts is decided in ./providers/index.js.
let _providerOverride = null;
/** Test seam only: substitute the AI provider (same contract). Production never sets it. */
export function setContentProviderOverride(provider) { _providerOverride = provider || null; }
export function resetContentProviderOverride() { _providerOverride = null; }
const getProvider = () => _providerOverride || getDefaultContentProvider();

// ── failures (user-safe; never a provider message, prompt or key) ────────────

export const CONTENT_FAILURE_MESSAGES = Object.freeze({
  ...FAILURE_MESSAGES,
  // the strategy wording says "strategy"; these are about a post
  AI_UNAVAILABLE: 'AI post generation is not available right now. Please try again later.',
  AI_BAD_OUTPUT: 'The AI returned a post that did not meet Odito\'s checks. Please try again.',
  GENERATION_INTERRUPTED: 'Post generation was interrupted. Please try again.',
  GENERATION_FAILED: 'Post generation failed. Please try again.',
  PLATFORM_NOT_CONNECTED: 'That account is no longer connected. Reconnect it and try again.',
  DRAFT_CREATE_FAILED: 'The post was written but could not be saved as a draft. Please try again.',
});

export function contentFailureFor(error) {
  if (error?.code === 'CONTENT_INVALID') return { code: 'AI_BAD_OUTPUT', message: CONTENT_FAILURE_MESSAGES.AI_BAD_OUTPUT };
  const mapped = PROVIDER_FAILURE_CODE[error?.code];
  if (mapped) return { code: mapped, message: CONTENT_FAILURE_MESSAGES[mapped] };
  if (error?.code === 'PLATFORM_NOT_CONNECTED' || error?.code === 'DRAFT_CREATE_FAILED') return { code: error.code, message: CONTENT_FAILURE_MESSAGES[error.code] };
  return failureFor(error);
}

// ── read model ───────────────────────────────────────────────────────────────

function toApiGeneration(rec) {
  return {
    id: String(rec._id),
    status: rec.status,
    request: { platform: rec.request.platform, contentPillar: rec.request.contentPillar, objective: rec.request.objective },
    calendarItemId: rec.calendar_item_id ? String(rec.calendar_item_id) : null,
    strategyVersion: rec.strategy?.version ?? null,
    startedAt: iso(rec.generation?.startedAt),
    finishedAt: iso(rec.generation?.finishedAt),
    failure: rec.status === 'failed' ? { code: rec.failure?.code || 'GENERATION_FAILED', message: rec.failure?.message || CONTENT_FAILURE_MESSAGES.GENERATION_FAILED } : null,
    // the AI's notes beside the draft (the draft itself is the source of truth for the text)
    result: rec.status === 'ready' ? { callToAction: rec.result?.callToAction ?? null, hashtags: rec.result?.hashtags || [], rationale: rec.result?.rationale ?? null } : null,
  };
}

/** The saved draft, as the preview needs it. Read from the real SocialPublication, never from the AI's output. */
function toApiDraft(pub) {
  return {
    id: pub.id,
    status: pub.status,
    platform: pub.platform,
    content: pub.content,
    contentVersion: pub.approval?.contentVersion ?? 1,
    approvalState: pub.approval?.state ?? null,
    approvalStage: pub.approval?.stage ?? null,
    generation: pub.generation || null,
  };
}

/** Fails any generation that has been `generating` longer than CONTENT_STALE_MS (process died / provider hung). */
export async function recoverStaleContentGenerations(projectId, { now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - CONTENT_STALE_MS);
  const result = await SocialContentGeneration.updateMany(
    { project_id: toId(projectId), status: 'generating', 'generation.startedAt': { $lt: cutoff } },
    { $set: { status: 'failed', 'generation.finishedAt': now, failure: { code: 'GENERATION_INTERRUPTED', message: CONTENT_FAILURE_MESSAGES.GENERATION_INTERRUPTED, at: now } } },
  );
  if (result.modifiedCount) LoggerUtil.warn(`[SOCIAL_AI_CONTENT] Recovered ${result.modifiedCount} interrupted generation(s)`, { projectId: String(projectId) });
  return result.modifiedCount;
}

/**
 * Status of one generation (by id) or, without an id, of the project's most recent one.
 * Ready results include the REAL saved draft (re-read now, so edits since are shown).
 */
export async function getContentGenerationStatus(projectId, { generationId = null, now = new Date() } = {}) {
  await recoverStaleContentGenerations(projectId, { now });
  let rec;
  if (generationId) {
    if (!mongoose.Types.ObjectId.isValid(generationId)) return fail('NOT_FOUND', 'That generation was not found.');
    rec = await SocialContentGeneration.findOne({ _id: generationId, project_id: toId(projectId) }).lean();
    if (!rec) return fail('NOT_FOUND', 'That generation was not found.');
  } else {
    rec = await SocialContentGeneration.findOne({ project_id: toId(projectId) }).sort({ createdAt: -1 }).lean();
    if (!rec) return { success: true, status: 'none', generation: null, publication: null };
  }
  let publication = null;
  if (rec.status === 'ready' && rec.publication_id) {
    const pub = await getPublication(projectId, String(rec.publication_id));
    publication = pub ? toApiDraft(pub) : null; // null: the draft was deleted since
  }
  return { success: true, status: rec.status, generation: toApiGeneration(rec), publication };
}

// ── starting a generation ────────────────────────────────────────────────────

function isInFlightConflict(error) {
  return error?.code === 11000;
}

/**
 * Validates the request, claims the work and (by default) runs it in the background.
 *
 * @param {object} input  { platform, contentPillar, objective } - nothing else is read from the client
 * @param {object} [options]
 * @param {boolean} [options.background=true]  false awaits the whole run (tests)
 * @param {string|null} [options.calendarItemId]  INTERNAL: set only by the calendar service after a project-scoped lookup
 *        (the HTTP controller never passes it). The post is then written from that plan item and the draft is linked back to it.
 */
export async function startContentGeneration(projectId, userId, input = {}, { now = new Date(), background = true, calendarItemId = null } = {}) {
  const { platform, objective } = input || {};
  const contentPillar = typeof input?.contentPillar === 'string' ? input.contentPillar.trim() : '';

  if (typeof platform !== 'string' || !PLATFORMS.includes(platform)) return fail('INVALID_PLATFORM', `platform must be one of: ${PLATFORMS.join(', ')}.`);
  if (typeof objective !== 'string' || !CONTENT_MIX_TYPES.includes(objective)) return fail('INVALID_OBJECTIVE', `objective must be one of: ${CONTENT_MIX_TYPES.join(', ')}.`);
  if (!contentPillar || contentPillar.length > 100) return fail('INVALID_PILLAR', 'contentPillar is required.');

  if (!(await SeoProject.exists({ _id: toId(projectId), is_deleted: { $ne: true } }))) return fail('NOT_FOUND', 'Project not found.');

  // The STORED strategy is the source of truth for what may be requested.
  const strategyDoc = await SocialAIStrategy.findOne({ project_id: toId(projectId), status: 'ready' }).sort({ version: -1 }).lean();
  if (!strategyDoc?.strategy || !strategyDoc.profileSnapshot?.data) {
    return fail('NO_STRATEGY', 'Generate an AI strategy first - posts are written from your strategy.');
  }
  const strategy = strategyDoc.strategy;
  if (!(strategy.contentPillars || []).some((p) => p.name === contentPillar)) return fail('INVALID_PILLAR', 'That content pillar is not part of your current strategy.', { allowed: strategy.contentPillars.map((p) => p.name) });
  if (!(strategy.contentMix || []).some((m) => m.type === objective && m.percentage > 0)) return fail('OBJECTIVE_NOT_IN_STRATEGY', 'That objective is not part of your current strategy\'s content mix.', { allowed: strategy.contentMix.filter((m) => m.percentage > 0).map((m) => m.type) });
  if (!(strategy.platformStrategy || []).some((p) => p.platform === platform)) return fail('PLATFORM_NOT_IN_STRATEGY', `Your current strategy does not cover ${platform}. Regenerate the strategy to include it.`);

  // Connection is decided HERE, from the database - a client-supplied `connected` is never read.
  const account = platform === 'facebook' ? await getActiveFacebookAccount(projectId) : await getActiveInstagramAccount(projectId);
  if (!account) return fail('PLATFORM_NOT_CONNECTED', `Connect your ${platform === 'facebook' ? 'Facebook Page' : 'Instagram account'} before generating a post for it.`);

  const provider = getProvider();
  if (!provider.isAvailable()) return fail('AI_UNAVAILABLE', CONTENT_FAILURE_MESSAGES.AI_UNAVAILABLE);

  await recoverStaleContentGenerations(projectId, { now });
  const running = await SocialContentGeneration.findOne({ project_id: toId(projectId), status: 'generating' }).lean();
  if (running) return { success: true, started: false, alreadyRunning: true, generation: toApiGeneration(running) };

  const lockedBy = `${INSTANCE}:${crypto.randomUUID()}`;
  let rec;
  try {
    rec = await SocialContentGeneration.create({
      project_id: toId(projectId),
      status: 'generating',
      request: { platform, contentPillar, objective },
      strategy: {
        id: strategyDoc._id,
        version: strategyDoc.version,
        profileSnapshotHash: strategyDoc.profileSnapshot.hash || null,
        profileSnapshotGeneratedAt: strategyDoc.profileSnapshot.generatedAt || null,
      },
      social_account_id: account._id,
      calendar_item_id: calendarItemId ? toId(calendarItemId) : null,
      generation: { startedAt: now, lockedBy, promptVersion: CONTENT_PROMPT_VERSION },
      requestedBy: userId || null,
    });
  } catch (error) {
    if (!isInFlightConflict(error)) throw error;
    const existing = await SocialContentGeneration.findOne({ project_id: toId(projectId), status: 'generating' }).lean();
    return { success: true, started: false, alreadyRunning: true, generation: existing ? toApiGeneration(existing) : null };
  }

  LoggerUtil.info('[SOCIAL_AI_CONTENT] Generation claimed', { projectId: String(projectId), generationId: String(rec._id), platform, strategyVersion: strategyDoc.version });

  const run = () => runContentGeneration(rec._id, lockedBy, userId).catch((error) => {
    LoggerUtil.error('[SOCIAL_AI_CONTENT] Generation bookkeeping failed', { message: error.message }, { generationId: String(rec._id) });
  });
  if (background) {
    setImmediate(run);
    return { success: true, started: true, alreadyRunning: false, generation: toApiGeneration(rec) };
  }
  await run();
  return { success: true, started: true, alreadyRunning: false, generation: toApiGeneration(await SocialContentGeneration.findById(rec._id).lean()) };
}

// ── the run ──────────────────────────────────────────────────────────────────

/** Every string the business supplied (the stored profile snapshot) - the only facts a post may state figures/addresses from. */
const dedupe = (list) => [...new Map(list.map((p) => [String(p).trim().toLowerCase(), String(p).trim()]).filter(([k]) => k)).values()];

/**
 * Runs one claimed generation to completion. Writes only through conditional updates keyed on
 * the lock owner, so an interrupted (stale-recovered) run can never create a draft or overwrite
 * a newer outcome.
 */
export async function runContentGeneration(generationId, lockedBy, userId = null) {
  const lock = { _id: generationId, status: 'generating', 'generation.lockedBy': lockedBy };
  const rec = await SocialContentGeneration.findOne(lock).lean();
  if (!rec) return null;

  const started = Date.now();
  const usage = { inputTokens: 0, outputTokens: 0 };
  let attempts = 0;
  let model = null;

  try {
    // 1. The STORED strategy and ITS profile snapshot - not the live profile.
    const strategyDoc = await SocialAIStrategy.findById(rec.strategy.id).lean();
    if (!strategyDoc?.strategy || !strategyDoc.profileSnapshot?.data) throw Object.assign(new Error('strategy missing'), { code: 'GENERATION_FAILED' });
    const { strategy } = strategyDoc;
    const snapshotData = strategyDoc.profileSnapshot.data;
    const { platform, contentPillar, objective } = rec.request;
    const pillar = strategy.contentPillars.find((p) => p.name === contentPillar);
    if (!pillar) throw Object.assign(new Error('pillar missing'), { code: 'GENERATION_FAILED' });

    // 2. The account must still be connected (re-read: it may have been disconnected since the claim).
    const account = platform === 'facebook' ? await getActiveFacebookAccount(rec.project_id) : await getActiveInstagramAccount(rec.project_id);
    if (!account || String(account._id) !== String(rec.social_account_id)) throw Object.assign(new Error('account gone'), { code: 'PLATFORM_NOT_CONNECTED' });

    // 3. Rules the output is checked against: snapshot + strategy + (only ever stricter) the current profile's phrases.
    const currentProfile = await findProfile(rec.project_id);
    const prohibitedPhrases = dedupe([...(snapshotData.prohibitedPhrases || []), ...(strategy.brandRules?.prohibitedPhrases || []), ...(currentProfile?.prohibitedPhrases || [])]);
    const allowedFactsText = snapshotFactsText(snapshotData);

    // 3b. The plan this post executes: re-read NOW (it may have been edited since the click), scoped to the project.
    const planItem = rec.calendar_item_id ? await SocialContentCalendarItem.findOne({ _id: rec.calendar_item_id, project_id: rec.project_id }).lean() : null;
    if (rec.calendar_item_id && !planItem) throw Object.assign(new Error('calendar item gone'), { code: 'GENERATION_FAILED' });

    // 4. Generate -> validate -> (one repair) .
    const provider = getProvider();
    const system = buildSystemPrompt();
    let validated = null;
    let feedback = [];
    for (let i = 0; i <= CONTENT_MAX_REPAIR_ATTEMPTS && !validated; i += 1) {
      const user = buildUserPrompt({ snapshotData, strategy, platform, pillar, objective, prohibitedPhrases, repairFeedback: feedback, planItem });
      const result = await provider.generateContent({ system, user, generationId: String(generationId) });
      attempts += result.attempts || 1;
      usage.inputTokens += result.usage?.inputTokens || 0;
      usage.outputTokens += result.usage?.outputTokens || 0;
      model = result.model || model;
      const check = validateContentOutput(result.parsed, { platform, contentPillar, objective, hashtagStrategy: strategy.hashtagStrategy, prohibitedPhrases, allowedFactsText });
      if (check.ok) validated = check;
      else feedback = check.errors.slice(0, 8);
    }
    if (!validated) throw Object.assign(new Error('CONTENT_INVALID'), { code: 'CONTENT_INVALID' });

    // 5. Still the active run? (a recovered/superseded run must not create a draft)
    const stillOurs = await SocialContentGeneration.findOneAndUpdate(lock, { $set: { 'generation.attempts': attempts } }, { new: true }).lean();
    if (!stillOurs) {
      LoggerUtil.warn('[SOCIAL_AI_CONTENT] Result discarded: the generation was no longer active', { generationId: String(generationId) });
      return null;
    }

    // 6. The real draft - through the same service every other post uses. status stays 'draft'; nothing is scheduled or sent.
    const created = await createPublication(rec.project_id, userId || rec.requestedBy, {
      platform,
      socialAccountId: String(rec.social_account_id),
      content: validated.content.text,
      generation: {
        source: 'ai',
        type: 'social_content',
        generationId: rec._id,
        strategyId: rec.strategy.id,
        strategyVersion: rec.strategy.version,
        profileSnapshotHash: rec.strategy.profileSnapshotHash,
        profileSnapshotGeneratedAt: rec.strategy.profileSnapshotGeneratedAt,
        contentPillar,
        objective,
        calendarItemId: planItem ? planItem._id : null,
      },
    });
    if (!created.success) throw Object.assign(new Error('draft not created'), { code: created.error?.code?.startsWith('ACCOUNT_') ? 'PLATFORM_NOT_CONNECTED' : 'DRAFT_CREATE_FAILED' });

    // 7. Into the EXISTING approval workflow (it decides content_review vs. auto-approval from the project's settings).
    const submitted = await submitContentForApproval(rec.project_id, created.publication.id, userId || rec.requestedBy);
    if (!submitted.success) LoggerUtil.warn('[SOCIAL_AI_CONTENT] Draft created but could not be submitted for review', { generationId: String(generationId), code: submitted.error?.code });
    // Link the draft back to the plan item it came from (a reference + the planning status only; the publication is untouched).
    if (planItem) await linkPublicationToItem({ projectId: rec.project_id, itemId: planItem._id, publicationId: created.publication.id }).catch((e) => LoggerUtil.warn('[SOCIAL_AI_CONTENT] Could not link the draft to its calendar item', { generationId: String(generationId), message: e.message }));

    const saved = await SocialContentGeneration.findOneAndUpdate(lock, {
      $set: {
        status: 'ready',
        publication_id: created.publication.id,
        result: { callToAction: validated.content.callToAction, hashtags: validated.content.hashtags, rationale: validated.content.rationale },
        'generation.finishedAt': new Date(), 'generation.model': model, 'generation.attempts': attempts, 'generation.durationMs': Date.now() - started, 'generation.usage': usage,
        failure: { code: null, message: null, at: null },
      },
    }, { new: true }).lean();
    LoggerUtil.info('[SOCIAL_AI_CONTENT] Draft created', { projectId: String(rec.project_id), generationId: String(generationId), publicationId: String(created.publication.id), inTokens: usage.inputTokens, outTokens: usage.outputTokens, durationMs: Date.now() - started });
    return saved;
  } catch (error) {
    const failure = contentFailureFor(error);
    const at = new Date();
    await SocialContentGeneration.findOneAndUpdate(lock, {
      $set: { status: 'failed', 'generation.finishedAt': at, 'generation.attempts': attempts, 'generation.durationMs': Date.now() - started, failure: { ...failure, at } },
    });
    // technical detail goes to the server log only (a code, never a message that could echo a key or body)
    LoggerUtil.error('[SOCIAL_AI_CONTENT] Generation failed', { providerCode: error?.code || null }, { generationId: String(generationId), failureCode: failure.code });
    return null;
  }
}

export default { startContentGeneration, runContentGeneration, getContentGenerationStatus, recoverStaleContentGenerations, setContentProviderOverride, resetContentProviderOverride, contentFailureFor };
