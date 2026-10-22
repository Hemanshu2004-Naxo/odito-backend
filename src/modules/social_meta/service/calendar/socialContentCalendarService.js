import crypto from 'crypto';
import SocialContentCalendar from '../../model/SocialContentCalendar.js';
import SocialContentCalendarItem from '../../model/SocialContentCalendarItem.js';
import SeoProject from '../../../app_user/model/SeoProject.js';
import { resolveSocialBusinessProfile } from '../socialBusinessProfileResolver.js';
import { generationBlockers, buildProfileData } from '../aiStrategy/profileSnapshot.js';
import { getLiveProfileHash } from '../aiStrategy/socialAIStrategyService.js';
import { validateCalendarInput, previewCalendarPlan } from './calendarPlanner.js';
import { CALENDAR_PROMPT_VERSION } from './calendarPromptBuilder.js';
import {
  CALENDAR_LEASE_MS, CALENDAR_MIN_DAYS, CALENDAR_MAX_DAYS, CALENDAR_MIN_MONTHS, CALENDAR_MAX_MONTHS, CALENDAR_MAX_POSTS,
} from './calendarConfig.js';
import { effectiveStatusOf, isItemLocked, contentIdOf } from './calendarItemRules.js';
import { listCalendarVersions, getCalendarVersion, restoreCalendarVersion } from './calendarHistoryService.js';
import { reserveCalendarQuota, getUsageSummary, checkQuotaFor } from './calendarQuotaService.js';
import { toApiPlanning } from '../aiStrategy/strategyPlanning.js';
import mongoose from 'mongoose';
import { loadPublicationSummaries } from './calendarItemLinks.js';
import {
  getProvider, latestReadyStrategy, connectedPlatforms, platformStates, CALENDAR_FAILURE_MESSAGES, toId, fail,
} from './calendarPlanningContext.js';
import {
  INSTANCE, launchRun, resumeCalendarGeneration, cancelCalendarGeneration, recoverInterruptedCalendars, pruneHistory,
} from './calendarGenerationRunner.js';
import { LoggerUtil } from '../../../../utils/LoggerUtil.js';

// These live in calendarPlanningContext.js / calendarGenerationRunner.js (so neither half imports the other); re-exported so every existing importer is unaffected.
export {
  setCalendarProviderOverride, resetCalendarProviderOverride, getCalendarProvider, CALENDAR_FAILURE_MESSAGES, calendarFailureFor, latestReadyStrategy, connectedPlatforms,
  buildPlanningContext, seedForCalendar, planSlots,
} from './calendarPlanningContext.js';
export { runCalendarGeneration, resumeCalendarGeneration, cancelCalendarGeneration, recoverInterruptedCalendars } from './calendarGenerationRunner.js';

/**
 * socialContentCalendarService - Content Calendar planning: the PLAN between the AI Strategy (the brain) and content
 * generation (the execution). This file is the read model, the request validation and the start of a generation; the
 * durable run itself (claim, lease, batches, resume, recovery) is calendarGenerationRunner.js.
 *
 *   validate the user's choices (start date, months, posts per week, platforms, distribution)
 *     -> the SERVER loads the authoritative strategy, its profile snapshot and the business's active catalog
 *        (nothing about the strategy or the business is ever read from the client)
 *     -> the size is known exactly (the planner's weekly quotas) and checked against the safety limit BEFORE any AI call
 *     -> claim (database-enforced: ONE generation in flight per project)  -> 202
 *     -> background: the server fixes the slots (dates, pillars, fixed platforms); the model plans each batch of slots
 *        and WRITES each post; every batch is strictly validated (+ one repair) and SAVED AT ONCE, so a crash, a provider outage or a
 *        later failure never throws saved batches away: the generation can be taken over, retried or resumed from them
 *     -> when every slot is saved the calendar becomes `ready` (a conditional update by lock owner)
 *
 * It never creates a design, approves, schedules, publishes or calls Meta. A planned item can later
 * be handed to the existing content / design generation and approval workflow; this service only plans.
 *
 * Versioning: every generation is a new calendar VERSION pinned to the strategy version (and profile snapshot hash)
 * it was planned from. Regenerating is an explicit user action that archives the previous version - never deletes it
 * - and a generation that is not `ready` never touches the last good calendar. A calendar is never mutated by a strategy or profile
 * change; it is reported as "planned from an older strategy" and the user chooses to regenerate.
 */

const iso = (d) => (d ? new Date(d).toISOString() : null);

// ── read model ───────────────────────────────────────────────────────────────

/**
 * @param {object} doc  a stored item
 * @param {object[]} [publications]  summaries of the item's linked publications (see loadPublicationSummaries); [] when none
 */
export function toApiItem(doc, publications = []) {
  return {
    id: String(doc._id),
    contentId: contentIdOf(doc),
    revision: doc.revision ?? 0,
    isManual: !!doc.isManual,
    editedFields: [...(doc.editedFields || [])],
    planApprovedAt: iso(doc.planApprovedAt),
    effectiveStatus: effectiveStatusOf(doc, publications),
    locked: isItemLocked(doc, publications),
    caption: doc.caption || '',
    hashtags: [...(doc.hashtags || [])],
    platformContent: (doc.platformContent || []).map((p) => ({ platform: p.platform, caption: p.caption || '', primaryCta: p.primaryCta || '', hashtags: [...(p.hashtags || [])] })),
    selectedMediaIds: (doc.selectedMediaIds || []).map(String),
    publications,
    order: doc.order,
    date: doc.contentDate,
    dayOfWeek: doc.dayOfWeek,
    platforms: [...(doc.platforms || [])],
    format: doc.format,
    deliverable: doc.deliverable || '',
    contentPillar: doc.contentPillar,
    contentType: doc.contentType,
    objective: doc.objective,
    primaryKpi: doc.primaryKpi,
    targetAudience: doc.targetAudience || '',
    serviceId: doc.serviceId ? String(doc.serviceId) : null,
    serviceName: doc.serviceName ?? null,
    productId: doc.productId ? String(doc.productId) : null,
    productName: doc.productName ?? null,
    occasion: doc.occasion || '',
    topic: doc.topic,
    angle: doc.angle || '',
    hook: doc.hook || '',
    hookRef: doc.hookRef ?? null,
    onCreativeText: doc.onCreativeText || '',
    creativeDirection: doc.creativeDirection || '',
    contentBrief: doc.contentBrief || '',
    captionDirection: doc.captionDirection || '',
    primaryCta: doc.primaryCta || '',
    engagementPrompt: doc.engagementPrompt || '',
    requiredAssets: [...(doc.requiredAssets || [])],
    requiresReview: !!doc.requiresReview,
    approvalNotes: doc.approvalNotes || '',
    footerDisclaimer: doc.footerDisclaimer || '',
    status: doc.status,
    publicationIds: (doc.publicationIds || []).map(String),
    strategyVersion: doc.strategyVersion,
  };
}

function toApiCalendar(doc) {
  return {
    id: String(doc._id),
    version: doc.version,
    status: doc.status,
    generatedAt: iso(doc.generation?.finishedAt),
    config: { ...doc.config, platforms: [...doc.config.platforms] },
    strategy: { id: String(doc.strategy.id), version: doc.strategy.version },
    plan: {
      totalItems: doc.plan?.totalItems || 0,
      pillarDistribution: (doc.plan?.pillarDistribution || []).map((p) => ({ pillar: p.pillar, targetPercent: p.targetPercent, plannedCount: p.plannedCount, plannedPercent: p.plannedPercent })),
      platformCounts: doc.plan?.platformCounts ? { ...(doc.plan.platformCounts instanceof Map ? Object.fromEntries(doc.plan.platformCounts) : doc.plan.platformCounts) } : {},
      warnings: [...(doc.plan?.warnings || [])],
    },
  };
}

/** The progress of a generation, as the client may see it (counts only). */
const toApiProgress = (doc) => {
  const p = doc.generation?.progress || {};
  return { plannedPosts: p.plannedPosts || 0, totalPosts: p.totalPosts || 0, completedBatches: p.completedBatches || 0, totalBatches: p.totalBatches || 0 };
};

function toApiGeneration(doc) {
  const g = doc.generation || {};
  const stopped = doc.status === 'failed' || doc.status === 'partial';
  return {
    id: String(doc._id),
    version: doc.version,
    status: doc.status,
    startedAt: iso(g.startedAt),
    finishedAt: iso(g.finishedAt),
    config: doc.config ? { ...doc.config, platforms: [...doc.config.platforms] } : null,
    progress: toApiProgress(doc),
    // a transient problem the run is waiting out (a code and the time it will continue); null otherwise
    retry: doc.status === 'generating' && g.retry?.code ? { code: g.retry.code, at: iso(g.retry.at) } : null,
    runAttempts: g.runAttempts || 0,
    canResume: doc.status === 'partial',
    failure: stopped ? { code: doc.failure?.code || 'GENERATION_FAILED', message: doc.failure?.message || CALENDAR_FAILURE_MESSAGES.GENERATION_FAILED } : null,
  };
}

/**
 * Takes over generations of this project whose lease expired (the worker died, hung, or was waiting out a retry) and continues them
 * from the batches already saved. Kept under its old name for existing callers.
 */
export async function recoverStaleCalendarGenerations(projectId, { now = new Date(), resume = true } = {}) {
  const result = await recoverInterruptedCalendars({ projectId, now, resume });
  return result.resumed + result.finished;
}

async function latestAndCurrent(projectId) {
  const pid = toId(projectId);
  const [latest, current] = await Promise.all([
    SocialContentCalendar.findOne({ project_id: pid, status: { $in: ['generating', 'partial', 'failed', 'ready'] } }).sort({ version: -1 }).lean(),
    SocialContentCalendar.findOne({ project_id: pid, status: 'ready' }).sort({ version: -1 }).lean(),
  ]);
  return { latest, current };
}

// an attempt only matters if it is NEWER than the current ready calendar
const describeAttempt = (latest, current) => (latest && latest.version > (current?.version || 0) && latest.status !== 'ready' ? latest : null);
const statusOf = (attempt, current) => (attempt ? attempt.status : (current ? 'ready' : 'none'));

/** Cheap read for polling: no profile resolution, no items. Also takes over an interrupted generation (see recoverInterruptedCalendars). */
export async function getCalendarGenerationStatus(projectId, { now = new Date() } = {}) {
  await recoverStaleCalendarGenerations(projectId, { now });
  const { latest, current } = await latestAndCurrent(projectId);
  const attempt = describeAttempt(latest, current);
  return { status: statusOf(attempt, current), currentVersion: current?.version || null, generation: attempt ? toApiGeneration(attempt) : null };
}

/** Full read model: the current calendar and its items, the latest attempt, what the user can choose, and whether the calendar is out of date. */
export async function getCalendarState(projectId, { now = new Date(), userId = null } = {}) {
  if (!(await SeoProject.exists({ _id: toId(projectId), is_deleted: { $ne: true } }))) return null;
  await recoverStaleCalendarGenerations(projectId, { now });
  const [{ latest, current }, strategyDoc, connected] = await Promise.all([latestAndCurrent(projectId), latestReadyStrategy(projectId), connectedPlatforms(projectId)]);
  const attempt = describeAttempt(latest, current);

  let items = [];
  let stale = null;
  if (current) {
    const docs = await SocialContentCalendarItem.find({ project_id: toId(projectId), calendar_id: current._id }).sort({ contentDate: 1, order: 1 }).lean();
    const publications = await loadPublicationSummaries(projectId, docs.flatMap((d) => d.publicationIds || []));
    items = docs.map((d) => toApiItem(d, (d.publicationIds || []).map((id) => publications.get(String(id))).filter(Boolean)));
    const liveHash = await getLiveProfileHash(projectId);
    stale = {
      strategyChanged: !!strategyDoc && String(strategyDoc._id) !== String(current.strategy.id),
      currentStrategyVersion: strategyDoc?.version || null,
      profileChanged: !!current.strategy.profileSnapshotHash && !!liveHash && liveHash !== current.strategy.profileSnapshotHash,
    };
  }

  // An unfinished calendar (stopped after saving some posts) is shown as what it is: read-only posts, how far it got, and how to go on.
  let partial = null;
  if (attempt?.status === 'partial') {
    const docs = await SocialContentCalendarItem.find({ project_id: toId(projectId), calendar_id: attempt._id }).sort({ contentDate: 1, order: 1 }).lean();
    partial = { calendar: toApiCalendar(attempt), items: docs.map((d) => toApiItem(d, [])) };
  }

  const strategy = strategyDoc?.strategy || null;
  return {
    status: statusOf(attempt, current),
    calendar: current ? toApiCalendar(current) : null,
    items,
    generation: attempt ? toApiGeneration(attempt) : null,
    partial,
    stale,
    strategy: strategy
      ? {
        available: true,
        id: String(strategyDoc._id),
        version: strategyDoc.version,
        platforms: (strategy.platformStrategy || []).map((p) => p.platform),
        hasHooks: (strategy.workingHooks || []).length > 0,
        // the choice made when this strategy was created: the calendar form starts from it (null for a strategy saved before the wizard)
        planning: toApiPlanning(strategyDoc.planning),
        recommended: { postsPerWeek: strategy.postingStrategy?.postsPerWeek ?? null, range: strategy.postingStrategy?.postsPerWeekRange || null, days: strategy.postingStrategy?.recommendedDays || [] },
      }
      : { available: false },
    connectedPlatforms: connected,
    // 'connected' | 'expired' | 'none' per platform: an expired connection is fixed with Reconnect, not Connect
    platformStates: await platformStates(projectId),
    // this month's allowance for the account and the project (null limit = unlimited)
    quota: userId ? await getUsageSummary({ userId, projectId, now }) : null,
    // minDays / maxDays are kept for older clients; the product's model is months
    limits: { minDays: CALENDAR_MIN_DAYS, maxDays: CALENDAR_MAX_DAYS, minMonths: CALENDAR_MIN_MONTHS, maxMonths: CALENDAR_MAX_MONTHS, maxPostsPerWeek: 7, maxPosts: CALENDAR_MAX_POSTS },
  };
}

// ── starting a generation ────────────────────────────────────────────────────

function isInFlightConflict(error) {
  if (error?.code !== 11000) return false;
  if (error.keyPattern) return !('version' in error.keyPattern);
  return String(error.message).includes('unique_calendar_generating_in_flight');
}

/**
 * The strategy's saved planning choice fills in what a calendar request leaves out (posts per week, months, platforms), and ONLY that: anything the
 * request does state wins, the strategy is never modified, and a strategy saved before the wizard (no choice) changes nothing. Legacy requests that
 * give an explicit endDate keep their own length.
 */
async function withStrategyPlanning(projectId, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const missing = ['postsPerWeek', 'months', 'platforms'].filter((k) => input[k] === undefined);
  if (!missing.length || (input.endDate !== undefined && input.months === undefined)) return input;
  const strategyDoc = await latestReadyStrategy(projectId);
  const planning = toApiPlanning(strategyDoc?.planning);
  if (!planning) return input;
  const filled = { ...input };
  for (const key of missing) filled[key] = Array.isArray(planning[key]) ? [...planning[key]] : planning[key];
  return filled;
}

/** What a set of choices means (end date, exact post count, steps), with no AI call and no write. */
export async function previewCalendar(rawInput, { today, userId = null, projectId = null } = {}) {
  const input = projectId ? await withStrategyPlanning(projectId, rawInput) : rawInput;
  const result = previewCalendarPlan(input, today ? { today } : undefined);
  if (result.error) return { success: false, error: result.error };
  if (!userId || !projectId) return { success: true, preview: result.value };
  // the same allowance /generate will enforce, read without reserving anything: the form can say so BEFORE the person clicks
  const quota = await checkQuotaFor({ userId, projectId, posts: result.value.totalPosts });
  if (!quota.ok) return { success: false, error: quota.error };
  return { success: true, preview: { ...result.value, quota: quota.summary } };
}

/**
 * Validates the request, claims the work and (by default) runs it in the background. Idempotent per project: if a
 * generation is already in flight it is returned instead of starting a second. An unfinished (partial) calendar of the project
 * is discarded once the new one is claimed: starting afresh is the person's decision to replace it (resume is the other choice).
 *
 * @param {object} input  { startDate, months (or a legacy endDate), postsPerWeek, platforms, distributionMode } - nothing else is read from the client
 * @param {object} [options]
 * @param {boolean} [options.background=true]  false awaits the whole run (tests)
 * @param {string} [options.today]  YYYY-MM-DD, tests only
 */
export async function startCalendarGeneration(projectId, userId, rawInput = {}, { now = new Date(), background = true, today } = {}) {
  const input = await withStrategyPlanning(projectId, rawInput);
  const checked = validateCalendarInput(input, today ? { today } : undefined);
  if (checked.error) return { success: false, error: checked.error };
  const config = checked.value;

  if (!(await SeoProject.exists({ _id: toId(projectId), is_deleted: { $ne: true } }))) return fail('NOT_FOUND', 'Project not found.');

  // The STORED strategy is the source of truth for what may be planned.
  const strategyDoc = await latestReadyStrategy(projectId);
  if (!strategyDoc?.strategy || !strategyDoc.profileSnapshot?.data) return fail('NO_STRATEGY', 'Generate an AI strategy first - the calendar is planned from your strategy.');
  const strategy = strategyDoc.strategy;
  if (!(strategy.contentPillars || []).length || !(strategy.contentMix || []).some((m) => m.percentage > 0)) return fail('NO_STRATEGY', 'Your strategy has no content pillars to plan from. Regenerate it.');

  // The business must still be describable (it may have lost its description since the strategy was made).
  const live = await resolveSocialBusinessProfile(projectId, { includeLogo: false });
  if (!live) return fail('NOT_FOUND', 'Project not found.');
  const blockers = generationBlockers(buildProfileData(live.resolvedProfile));
  if (blockers.length) return fail('INSUFFICIENT_PROFILE', blockers[0].reason, { blockers });

  // Platforms: connected NOW (decided here from the database, never from the client) and covered by the strategy.
  const connected = await connectedPlatforms(projectId);
  const missing = config.platforms.filter((p) => !connected[p]);
  const label = (p) => (p === 'facebook' ? 'Facebook Page' : 'Instagram account');
  if (missing.length) {
    const states = await platformStates(projectId);
    const expired = missing.filter((p) => states[p] === 'expired');
    if (expired.length) return fail('PLATFORM_RECONNECT_REQUIRED', `The connection to your ${expired.map(label).join(' and ')} has expired or was revoked in Meta. Reconnect ${expired.length > 1 ? 'them' : 'it'} before planning content for ${expired.length > 1 ? 'them' : 'it'}.`, { platforms: expired });
  }
  if (missing.length) return fail('PLATFORM_NOT_CONNECTED', `Connect your ${missing.map((p) => (p === 'facebook' ? 'Facebook Page' : 'Instagram account')).join(' and ')} before planning content for ${missing.length > 1 ? 'them' : 'it'}.`, { platforms: missing });
  const uncovered = config.platforms.filter((p) => !(strategy.platformStrategy || []).some((s) => s.platform === p));
  if (uncovered.length) return fail('PLATFORM_NOT_IN_STRATEGY', `Your current strategy does not cover ${uncovered.join(' and ')}. Regenerate the strategy to include it.`, { platforms: uncovered });

  const provider = getProvider();
  if (!provider.isAvailable()) return fail('AI_UNAVAILABLE', CALENDAR_FAILURE_MESSAGES.AI_UNAVAILABLE);

  // The size of the calendar is known exactly BEFORE any AI call (the quota per week is the server's, not the model's): refuse
  // an empty or oversized one here, so an expensive run never starts for a request that could not be honoured.
  const plannedSize = previewCalendarPlan(input, today ? { today } : undefined);
  if (plannedSize.error) return { success: false, error: plannedSize.error };

  // A generation whose worker died is taken over (not reported as "running" forever): only a LIVE one blocks a new request.
  await recoverStaleCalendarGenerations(projectId, { now });
  const running = await SocialContentCalendar.findOne({ project_id: toId(projectId), status: 'generating' }).lean();
  if (running) return { success: true, started: false, alreadyRunning: true, generation: toApiGeneration(running) };

  const calendarId = new mongoose.Types.ObjectId();

  const lockedBy = `${INSTANCE}:${crypto.randomUUID()}`;
  let doc = null;
  for (let attempt = 0; attempt < 3 && !doc; attempt += 1) {
    const last = await SocialContentCalendar.findOne({ project_id: toId(projectId) }).sort({ version: -1 }).select('version').lean();
    try {
      doc = await SocialContentCalendar.create({
        _id: calendarId,
        project_id: toId(projectId),
        version: (last?.version || 0) + 1,
        status: 'generating',
        config: { startDate: config.startDate, endDate: config.endDate, months: config.months, postsPerWeek: config.postsPerWeek, platforms: config.platforms, distributionMode: config.distributionMode },
        strategy: { id: strategyDoc._id, version: strategyDoc.version, profileSnapshotHash: strategyDoc.profileSnapshot.hash || null },
        generation: {
          startedAt: now,
          lockedBy,
          lease: { expiresAt: new Date(now.getTime() + CALENDAR_LEASE_MS) },
          runAttempts: 1,
          progress: { totalPosts: plannedSize.value.totalPosts, plannedPosts: 0, totalBatches: plannedSize.value.steps, completedBatches: 0 },
          promptVersion: CALENDAR_PROMPT_VERSION,
        },
        generatedBy: userId || null,
      });
    } catch (error) {
      if (isInFlightConflict(error)) {
        const existing = await SocialContentCalendar.findOne({ project_id: toId(projectId), status: 'generating' }).lean();
        return { success: true, started: false, alreadyRunning: true, generation: existing ? toApiGeneration(existing) : null };
      }
      if (error?.code !== 11000) throw error; // a version collision just loops and re-reads the latest version
    }
  }
  if (!doc) return fail('CONFLICT', 'Another generation started at the same time. Please try again.');

  // The usage allowance, reserved BEFORE any AI call and by the request that WON the claim above (so a double click is simply "already
  // running", never a second reservation). Database-enforced, so it holds across instances. When it refuses, the claim is withdrawn: nothing ran.
  const reservation = await reserveCalendarQuota({ userId, projectId, calendarId, posts: plannedSize.value.totalPosts, now });
  if (!reservation.success) {
    await SocialContentCalendar.deleteOne({ _id: doc._id, status: 'generating' });
    return { success: false, error: reservation.error };
  }

  LoggerUtil.info('[SOCIAL_CALENDAR] Generation claimed', { projectId: String(projectId), calendarId: String(doc._id), version: doc.version, strategyVersion: strategyDoc.version, totalPosts: plannedSize.value.totalPosts, months: config.months });

  // starting afresh replaces any unfinished calendar of this project (never the last READY one, which stays until this one is ready)
  const older = await SocialContentCalendar.find({ project_id: toId(projectId), status: 'partial', version: { $lt: doc.version } }).select('_id').lean();
  if (older.length) {
    await SocialContentCalendar.updateMany({ _id: { $in: older.map((o) => o._id) }, status: 'partial' }, { $set: { status: 'cancelled', 'generation.finishedAt': now } });
    await SocialContentCalendarItem.deleteMany({ calendar_id: { $in: older.map((o) => o._id) } });
    await pruneHistory(toId(projectId));
  }

  if (background) {
    await launchRun(doc._id, lockedBy, { background: true });
    return { success: true, started: true, alreadyRunning: false, generation: toApiGeneration(doc) };
  }
  await launchRun(doc._id, lockedBy, { background: false });
  return { success: true, started: true, alreadyRunning: false, generation: toApiGeneration(await SocialContentCalendar.findById(doc._id).lean()) };
}

/** Resumes an unfinished (partial) calendar: only the missing posts are generated. */
export async function resumeCalendar(projectId, { now = new Date(), background = true, userId = null } = {}) {
  const result = await resumeCalendarGeneration(projectId, { now, background, userId });
  if (!result.success) return result;
  return { success: true, started: !result.alreadyRunning, alreadyRunning: result.alreadyRunning, generation: result.calendar ? toApiGeneration(result.calendar) : null };
}

/** Stops an unfinished calendar and discards what it saved so far. */
export async function cancelCalendar(projectId, { now = new Date() } = {}) {
  const result = await cancelCalendarGeneration(projectId, { now });
  return result.success ? { success: true, generation: toApiGeneration(result.calendar) } : result;
}

/** The versions of the calendar (current + history) with what was edited / approved / turned into posts in each. */
export const listVersions = (projectId) => listCalendarVersions(projectId);
/** One version's posts, read-only. */
export const getVersion = (projectId, calendarId) => getCalendarVersion(projectId, calendarId, toApiItem);
/** Brings an archived version back as the current calendar (whole, with its own edits and approvals). */
export const restoreVersion = (projectId, calendarId) => restoreCalendarVersion(projectId, calendarId);

export default {
  listVersions, getVersion, restoreVersion,
  startCalendarGeneration, previewCalendar, resumeCalendar, cancelCalendar, getCalendarState, getCalendarGenerationStatus, recoverStaleCalendarGenerations,
};
