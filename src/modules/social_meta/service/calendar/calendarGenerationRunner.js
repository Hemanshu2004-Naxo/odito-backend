import os from 'os';
import crypto from 'crypto';
import mongoose from 'mongoose';
import SocialContentCalendar from '../../model/SocialContentCalendar.js';
import SocialContentCalendarItem from '../../model/SocialContentCalendarItem.js';
import SocialAIStrategy from '../../model/SocialAIStrategy.js';
import SocialAIUsage from '../../model/SocialAIUsage.js';
import { attemptRecord, flattenAttempts, describeProviderFailure } from '../aiStrategy/strategyDiagnostics.js';
import { buildCalendarToolSchema, validateCalendarBatch, applyVariety, varietyCarryFromItems } from './calendarOutputSchema.js';
import { buildSystemPrompt, buildUserPrompt } from './calendarPromptBuilder.js';
import {
  getProvider, planSlots, seedForCalendar, buildPlanningContext, finalizeItem, chunk, planSummaryOf, calendarFailureFor, CALENDAR_FAILURE_MESSAGES, MAX_REPAIR_FEEDBACK, toId, fail,
} from './calendarPlanningContext.js';
import {
  CALENDAR_BATCH_SIZE, CALENDAR_MAX_REPAIR_ATTEMPTS, CALENDAR_HISTORY_LIMIT, CALENDAR_LEASE_MS, CALENDAR_HEARTBEAT_MS, CALENDAR_MAX_RUN_ATTEMPTS,
  CALENDAR_RETRY_BACKOFF_MS, CALENDAR_RETRY_BACKOFF_MAX_MS, CALENDAR_MAX_RUN_MS, CALENDAR_MAX_CONCURRENT_RUNS,
} from './calendarConfig.js';
import { getProjectState, getTrashedProjectIds, PROJECT_STATES } from '../projectLifecycleGuard.js';
import { reserveCalendarQuota, releaseCalendarQuota, settleQuietly } from './calendarQuotaService.js';
import { recordRunOutcome, recordTakeover, recordProviderError } from '../../../../monitoring/socialAiMetrics.js';
import SeoProject from '../../../app_user/model/SeoProject.js';
import { LoggerUtil } from '../../../../utils/LoggerUtil.js';

/**
 * calendarGenerationRunner - the DURABLE half of calendar generation. A calendar document is its own job record; this module
 * claims it, runs it batch by batch, and makes every way it can stop recoverable.
 *
 *   CLAIM      an atomic update gives one worker the generation (`generation.lockedBy`) and a LEASE (`generation.lease.expiresAt`).
 *   HEARTBEAT  while it runs, the owner renews the lease every few seconds with a conditional write. The same write is how it finds
 *              out the generation was cancelled, deleted with its project, or taken over by another worker: it then stops.
 *   BATCHES    each validated batch is saved at once as items, keyed by (calendar, slot) with an upsert that only inserts. A batch
 *              that is retried - after a crash, a take-over, a resume - can therefore never create a second item for a slot or
 *              overwrite an existing one, and the batches already saved are never generated (or paid for) again.
 *   RECOVERY   a lease that is not renewed expires; any instance (the cron sweep, or a request) then takes the generation over with
 *              a conditional claim and continues from the saved batches. No process-local state decides anything: the database does.
 *   STOPPING   a transient provider failure (busy, timeout, network) is retried automatically after a growing delay, up to
 *              CALENDAR_MAX_RUN_ATTEMPTS runs. A permanent one (the AI's answer failed Odito's checks twice, no key, ...) is NOT
 *              retried automatically. When a run cannot continue it ends `partial` (some posts saved: the person can resume) or
 *              `failed` (none saved). Nothing that is not `ready` ever replaces the last good calendar.
 *
 * The server owns the schedule: dates, pillars and (for fixed modes) platforms come from the planner, never from the model.
 * It never creates a design, approves, schedules or publishes anything.
 */

export const INSTANCE = `${os.hostname()}:${process.pid}`;
const newOwner = () => `${INSTANCE}:${crypto.randomUUID()}`;
const leaseUntil = (now) => new Date(now.getTime() + CALENDAR_LEASE_MS);
const coded = (code, message) => Object.assign(new Error(message || code), { code });

const TRANSIENT_FAILURES = new Set(['AI_BUSY', 'AI_TIMEOUT', 'AI_UNREACHABLE']);
const isTransient = (error) => TRANSIENT_FAILURES.has(calendarFailureFor(error).code);
const backoffMs = (attempt) => Math.min(CALENDAR_RETRY_BACKOFF_MS * 2 ** Math.max(0, attempt - 1), CALENDAR_RETRY_BACKOFF_MAX_MS);

// ── bounded concurrency (this process only; exclusivity PER CALENDAR is the database lease) ───

/** A counting semaphore (exported for tests). */
export class Semaphore {
  constructor(n) { this.free = n; this.waiting = []; }
  async acquire() {
    if (this.free > 0) { this.free -= 1; return; }
    await new Promise((resolve) => this.waiting.push(resolve));
  }
  release() {
    const next = this.waiting.shift();
    if (next) next(); else this.free += 1;
  }
}
const runSlots = new Semaphore(CALENDAR_MAX_CONCURRENT_RUNS);

// ── lease + heartbeat ────────────────────────────────────────────────────────

function startHeartbeat(calendarId, lockedBy) {
  const state = { lost: false, stopped: false };
  const lock = { _id: calendarId, status: 'generating', 'generation.lockedBy': lockedBy };
  const tick = async () => {
    if (state.stopped || state.lost) return;
    try {
      const now = new Date();
      const renewed = await SocialContentCalendar.updateOne(lock, { $set: { 'generation.lease.expiresAt': leaseUntil(now), 'generation.heartbeatAt': now } });
      // matched nothing: it was cancelled, deleted with its project, or another worker took it over
      if (!renewed.matchedCount) state.lost = true;
    } catch (error) {
      // a database blip: the lease may lapse, in which case the take-over is safe (batch writes are idempotent)
      LoggerUtil.warn('[SOCIAL_CALENDAR] Heartbeat failed', { message: error.message }, { calendarId: String(calendarId), runId: lockedBy });
    }
  };
  const timer = setInterval(tick, CALENDAR_HEARTBEAT_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return { state, tick, stop() { state.stopped = true; clearInterval(timer); } };
}

// ── the run ──────────────────────────────────────────────────────────────────

/** Fields of a saved item, from a finalized plan item. Everything the model could influence has been validated; `slot` is the planner's. */
function itemDocument(it, doc, strategyDoc) {
  return {
    project_id: doc.project_id,
    calendar_id: doc._id,
    strategyId: strategyDoc._id,
    strategyVersion: strategyDoc.version,
    profileSnapshotHash: strategyDoc.profileSnapshot.hash || null,
    order: it.slot,
    slot: it.slot,
    contentDate: it.contentDate,
    dayOfWeek: it.dayOfWeek,
    platforms: it.platforms,
    format: it.format,
    deliverable: it.deliverable,
    contentPillar: it.contentPillar,
    contentType: it.contentType,
    objective: it.objective,
    primaryKpi: it.primaryKpi,
    targetAudience: it.targetAudience,
    serviceId: it.serviceId ? toId(it.serviceId) : null,
    serviceName: it.serviceName,
    productId: it.productId ? toId(it.productId) : null,
    productName: it.productName,
    occasion: it.occasion,
    topic: it.topic,
    angle: it.angle,
    hook: it.hook,
    hookRef: it.hookRef,
    onCreativeText: it.onCreativeText,
    creativeDirection: it.creativeDirection,
    contentBrief: it.contentBrief,
    captionDirection: it.captionDirection,
    primaryCta: it.primaryCta,
    engagementPrompt: it.engagementPrompt,
    caption: it.caption,
    hashtags: it.hashtags,
    platformContent: it.platformContent,
    selectedMediaIds: it.selectedMediaIds.map(toId),
    requiredAssets: it.requiredAssets,
    requiresReview: it.requiresReview,
    approvalNotes: it.approvalNotes,
    footerDisclaimer: it.footerDisclaimer,
    status: 'planned',
    revision: 0,
    editedFields: [],
    isManual: false,
    publicationIds: [],
  };
}

/** Saves one batch. Idempotent: an upsert that only ever INSERTS, so a retried batch changes nothing that already exists. */
export async function saveBatch(items, doc, strategyDoc) {
  try {
    await SocialContentCalendarItem.bulkWrite(
      items.map((it) => ({ updateOne: { filter: { calendar_id: doc._id, slot: it.slot }, update: { $setOnInsert: itemDocument(it, doc, strategyDoc) }, upsert: true } })),
      { ordered: false },
    );
  } catch (error) {
    // two workers saving the same slot at once: the loser's duplicate-key error means the slot IS saved - that is the idempotency, not a failure
    const writeErrors = error?.writeErrors || error?.result?.getWriteErrors?.() || [];
    if (!(error?.code === 11000 || (writeErrors.length && writeErrors.every((e) => (e.code ?? e.err?.code) === 11000)))) throw error;
  }
}

/**
 * Runs one claimed generation (this process holds `lockedBy`). Never throws. Returns the finished calendar when it became `ready`, else null.
 * `ctxOverride` is for tests only.
 */
export async function runCalendarGeneration(calendarId, lockedBy) {
  const lock = { _id: calendarId, status: 'generating', 'generation.lockedBy': lockedBy };
  const doc = await SocialContentCalendar.findOne(lock).lean();
  if (!doc) return null;

  const heartbeat = startHeartbeat(calendarId, lockedBy);
  await runSlots.acquire();
  try {
    return await execute(doc, lock, heartbeat);
  } finally {
    runSlots.release();
    heartbeat.stop();
  }
}

async function execute(doc, lock, heartbeat) {
  const calendarId = doc._id;
  const started = Date.now();
  const usage = { inputTokens: 0, outputTokens: 0 };
  let attempts = 0;
  let model = null;
  const rejected = []; // sanitized record of every batch attempt Odito's validation refused: paths + codes + rules, never values

  /** Renews the lease right now and refuses to go on when this run no longer owns the generation, the project is gone/paused, or the run is too old. */
  const checkpoint = async () => {
    await heartbeat.tick();
    if (heartbeat.state.lost) throw coded('LOCK_LOST');
    if (Date.now() - started > CALENDAR_MAX_RUN_MS) throw coded('RUN_TOO_LONG');
    const project = await getProjectState(doc.project_id);
    if (project !== PROJECT_STATES.ACTIVE) throw coded(project === PROJECT_STATES.TRASHED ? 'PROJECT_PAUSED' : 'PROJECT_GONE');
  };

  try {
    const strategyDoc = await SocialAIStrategy.findOne({ _id: doc.strategy.id, project_id: doc.project_id }).lean();
    if (!strategyDoc?.strategy || !strategyDoc.profileSnapshot?.data) throw coded('GENERATION_FAILED', 'strategy missing');
    const ctx = await buildPlanningContext(strategyDoc, doc.project_id);
    const { slots, distribution } = planSlots(doc.config, ctx.strategy, seedForCalendar(doc));
    if (!slots.length) throw coded('GENERATION_FAILED', 'no slots');

    // What an earlier run (or a crashed one) already saved is the truth: only the missing slots are generated.
    const saved = await SocialContentCalendarItem.find({ calendar_id: calendarId, slot: { $type: 'number' } }).sort({ slot: 1 }).select('slot topic serviceId productId format').lean();
    const done = new Set(saved.map((i) => i.slot));
    const remaining = slots.filter((s) => !done.has(s.index));
    const batches = chunk(remaining, CALENDAR_BATCH_SIZE);
    const completedBefore = doc.generation?.progress?.completedBatches || 0;
    const totalBatches = completedBefore + batches.length;

    const provider = getProvider();
    const system = buildSystemPrompt();
    const schema = buildCalendarToolSchema({ platforms: doc.config.platforms, hasServices: ctx.catalog.services.size > 0, hasProducts: ctx.catalog.products.size > 0 });
    const planned = { topics: saved.map((i) => i.topic.toLowerCase()), services: {}, products: {} };
    for (const it of saved) {
      if (it.serviceId) planned.services[String(it.serviceId)] = (planned.services[String(it.serviceId)] || 0) + 1;
      if (it.productId) planned.products[String(it.productId)] = (planned.products[String(it.productId)] || 0) + 1;
    }
    let carry = varietyCarryFromItems(saved);

    // Every run that spends tokens has a reservation on the usage ledger. A new or resumed run already has one (idempotent here); one that
    // does not - a crash between claiming and reserving, a run from before the ledger - gets it now, or stops before any AI call if it cannot.
    if (!(await SocialAIUsage.exists({ 'reservations.calendar_id': calendarId }))) {
      const owner = doc.generatedBy || (await SeoProject.findById(doc.project_id).select('user_id').lean())?.user_id;
      const reserved = await reserveCalendarQuota({
        userId: owner, projectId: doc.project_id, calendarId, posts: Math.max(0, slots.length - done.size),
        base: { saved: done.size, inputTokens: doc.generation?.usage?.inputTokens || 0, outputTokens: doc.generation?.usage?.outputTokens || 0, aiCalls: doc.generation?.attempts || 0 },
      });
      if (!reserved.success) throw Object.assign(new Error(reserved.error.code), { code: reserved.error.code, quotaError: reserved.error });
    }

    await checkpoint();
    await SocialContentCalendar.updateOne(lock, {
      $set: {
        'plan.pillarDistribution': distribution,
        'generation.progress.totalPosts': slots.length,
        'generation.progress.plannedPosts': done.size,
        'generation.progress.totalBatches': totalBatches,
      },
    });

    for (let b = 0; b < batches.length; b += 1) {
      await checkpoint();
      const batchSlots = batches[b];
      let validated = null;
      let feedback = [];
      for (let i = 0; i <= CALENDAR_MAX_REPAIR_ATTEMPTS && !validated; i += 1) {
        const user = buildUserPrompt({
          snapshotData: ctx.snapshotData, strategy: ctx.strategy, config: doc.config, slots: batchSlots, progress: { batch: completedBefore + b + 1, batches: totalBatches },
          planned, catalog: { services: ctx.catalogEntries.services, products: ctx.catalogEntries.products }, prohibitedPhrases: ctx.prohibitedPhrases, repairFeedback: feedback,
        });
        // eslint-disable-next-line no-await-in-loop
        const result = await provider.generateCalendarPlan({ system, user, schema });
        attempts += result.attempts || 1;
        usage.inputTokens += result.usage?.inputTokens || 0;
        usage.outputTokens += result.usage?.outputTokens || 0;
        model = result.model || model;
        const check = validateCalendarBatch(result.parsed, {
          slots: batchSlots, selectedPlatforms: doc.config.platforms, strategy: ctx.strategy, catalog: ctx.catalog,
          prohibitedPhrases: ctx.prohibitedPhrases, allowedFactsText: ctx.allowedFactsText, usedTopics: new Set(planned.topics),
        });
        if (check.ok) validated = check;
        else {
          feedback = check.errors.slice(0, MAX_REPAIR_FEEDBACK);
          rejected.push({ ...attemptRecord({ attempt: i + 1, errors: check.errors, outputTokens: result.usage?.outputTokens || 0 }), batch: completedBefore + b + 1 });
        }
      }
      if (!validated) throw Object.assign(new Error('CALENDAR_INVALID'), { code: 'CALENDAR_INVALID', validation: rejected });

      // variety continues from the previous batch (same result as one pass over the whole calendar), then the server-owned finishing
      const varied = applyVariety(validated.items.sort((a, c) => a.slot - c.slot), { serviceCount: ctx.catalog.services.size, productCount: ctx.catalog.products.size, total: slots.length, carry });
      carry = varied.carry;
      const finalItems = varied.items.map((it) => finalizeItem(it, ctx, ctx.snapshotData.business?.category));

      await checkpoint(); // still the owner, right before writing
      await saveBatch(finalItems, doc, strategyDoc);
      for (const it of finalItems) {
        planned.topics.push(it.topic.toLowerCase());
        if (it.serviceId) planned.services[it.serviceId] = (planned.services[it.serviceId] || 0) + 1;
        if (it.productId) planned.products[it.productId] = (planned.products[it.productId] || 0) + 1;
      }
      const plannedPosts = await SocialContentCalendarItem.countDocuments({ calendar_id: calendarId, slot: { $type: 'number' } });
      const progressed = await SocialContentCalendar.updateOne(lock, {
        $set: { 'generation.progress.plannedPosts': plannedPosts, ...(model ? { 'generation.model': model } : {}) },
        $inc: { 'generation.progress.completedBatches': 1, 'generation.batches': 1, 'generation.usage.inputTokens': usage.inputTokens, 'generation.usage.outputTokens': usage.outputTokens, 'generation.attempts': attempts },
        ...(varied.warnings.length ? { $addToSet: { 'plan.warnings': { $each: varied.warnings } } } : {}),
      });
      usage.inputTokens = 0; usage.outputTokens = 0; attempts = 0; // already added to the document; the totals below only carry what is not saved yet
      if (!progressed.matchedCount) throw coded('LOCK_LOST');
    }

    // Every slot saved? Then the calendar is ready: the summary is computed from the items, and "ready" is a conditional update by lock owner.
    const items = await SocialContentCalendarItem.find({ calendar_id: calendarId, slot: { $type: 'number' } }).select('contentPillar platforms').lean();
    if (items.length !== slots.length) throw coded('GENERATION_INCOMPLETE', `expected ${slots.length} posts, found ${items.length}`);
    const summary = planSummaryOf(items, distribution);
    await checkpoint();
    const finishedAt = new Date();
    const ready = await SocialContentCalendar.findOneAndUpdate(lock, {
      $set: {
        status: 'ready',
        'plan.totalItems': summary.totalItems,
        'plan.pillarDistribution': summary.pillarDistribution,
        'plan.platformCounts': summary.platformCounts,
        'generation.finishedAt': finishedAt,
        'generation.progress.plannedPosts': items.length,
        'generation.lease.expiresAt': null,
        'generation.retry': { code: null, at: null },
        'generation.durationMs': (doc.generation?.durationMs || 0) + (Date.now() - started),
        failure: { code: null, message: null, at: null },
      },
    }, { new: true }).lean();
    if (!ready) throw coded('LOCK_LOST');

    await settleQuietly(calendarId); // what this run produced is committed to the usage ledger; the reservation is released
    // The previous ready version is kept as history (never deleted here); very old history is pruned.
    await SocialContentCalendar.updateMany({ project_id: doc.project_id, status: 'ready', version: { $lt: ready.version } }, { $set: { status: 'archived' } });
    await pruneHistory(doc.project_id);
    recordRunOutcome('ready', Date.now() - started);
    LoggerUtil.info('[SOCIAL_CALENDAR] Calendar ready', { projectId: String(doc.project_id), calendarId: String(calendarId), runId: lock['generation.lockedBy'], version: ready.version, items: items.length, batches: ready.generation?.batches, runAttempts: ready.generation?.runAttempts, durationMs: Date.now() - started, repairedAfter: rejected.length ? flattenAttempts(rejected) : undefined });
    return ready;
  } catch (error) {
    heartbeat.stop(); // a late tick must not renew the lease over the retry time (or the final state) that settle() writes
    await settle(doc, lock, error, { started, usage, attempts, model, rejected });
    return null;
  }
}

/** What happens when a run stops: it is recoverable, retried later, or finished as partial / failed. Never throws. */
async function settle(doc, lock, error, { started, usage, attempts, model, rejected }) {
  const calendarId = doc._id;
  const runId = lock['generation.lockedBy']; // correlates every line of this run (and the takeover that continues it) in the logs
  try {
    const at = new Date();
    const carryUsage = { 'generation.usage.inputTokens': usage.inputTokens, 'generation.usage.outputTokens': usage.outputTokens, 'generation.attempts': attempts };

    if (error?.code === 'LOCK_LOST') {
      // cancelled, deleted with its project, or taken over. If nobody owns the calendar any more, nothing it wrote may survive.
      if (!(await SocialContentCalendar.exists({ _id: calendarId, status: { $in: ['generating', 'partial', 'ready', 'archived'] } }))) {
        await SocialContentCalendarItem.deleteMany({ calendar_id: calendarId });
      }
      recordRunOutcome('lock_lost');
      LoggerUtil.warn('[SOCIAL_CALENDAR] Run stopped: it no longer owns the generation', { calendarId: String(calendarId), runId });
      return;
    }

    if (error?.code === 'PROJECT_PAUSED') {
      // trashed: stop dispatching, keep everything; the lease is released so it continues after a restore (a pause is not a failed attempt)
      await SocialContentCalendar.updateOne(lock, { $set: { 'generation.lease.expiresAt': at }, $inc: { 'generation.runAttempts': -1, ...carryUsage } });
      recordRunOutcome('paused');
      LoggerUtil.warn('[SOCIAL_CALENDAR] Run paused: the project is in the trash', { calendarId: String(calendarId), runId });
      return;
    }

    if (error?.code === 'PROJECT_GONE') {
      recordRunOutcome('cancelled');
      await SocialContentCalendar.updateOne(lock, { $set: { status: 'cancelled', 'generation.finishedAt': at, 'generation.lease.expiresAt': null } });
      await settleQuietly(calendarId); // before the posts go: what was generated is counted
      await SocialContentCalendarItem.deleteMany({ calendar_id: calendarId });
      return;
    }

    const failure = error?.quotaError
      ? { code: error.quotaError.code, message: error.quotaError.message } // the allowance refused it: say how much is left, in the person's own terms
      : error?.code === 'RUN_TOO_LONG'
        ? { code: 'GENERATION_INTERRUPTED', message: CALENDAR_FAILURE_MESSAGES.GENERATION_INTERRUPTED }
        : calendarFailureFor(error);
    const savedPosts = await SocialContentCalendarItem.countDocuments({ calendar_id: calendarId, slot: { $type: 'number' } });
    const current = await SocialContentCalendar.findOne(lock).select('generation.runAttempts').lean();
    if (!current) return;
    const runAttempts = current.generation?.runAttempts || 1;

    if (isTransient(error) && runAttempts < CALENDAR_MAX_RUN_ATTEMPTS) {
      // wait it out: the lease is set to the retry time, so the recovery sweep continues the run when that time comes
      const retryAt = new Date(at.getTime() + backoffMs(runAttempts));
      await SocialContentCalendar.updateOne(lock, { $set: { 'generation.lease.expiresAt': retryAt, 'generation.retry': { code: failure.code, at: retryAt }, 'generation.progress.plannedPosts': savedPosts }, $inc: carryUsage });
      recordRunOutcome('retry_scheduled');
      recordProviderError(failure.code);
      LoggerUtil.warn('[SOCIAL_CALENDAR] Transient failure; the run will continue automatically', { calendarId: String(calendarId), runId, failureCode: failure.code, runAttempts, retryAt: retryAt.toISOString(), savedPosts });
      return;
    }

    // Permanent (or out of attempts): stop. Saved posts are kept as a resumable partial calendar; with none saved it is a plain failure.
    const status = savedPosts > 0 ? 'partial' : 'failed';
    await SocialContentCalendar.updateOne(lock, {
      $set: {
        status,
        'generation.finishedAt': at,
        'generation.lease.expiresAt': null,
        'generation.progress.plannedPosts': savedPosts,
        'generation.retry': { code: null, at: null },
        ...(model ? { 'generation.model': model } : {}),
        'generation.durationMs': (doc.generation?.durationMs || 0) + (Date.now() - started),
        failure: { ...failure, at, validation: flattenAttempts(error?.validation || []) },
      },
      $inc: carryUsage,
    });
    await settleQuietly(calendarId); // a stopped generation keeps only what it really produced (a resume reserves just the missing posts)
    recordRunOutcome(status, Date.now() - started);
    recordProviderError(failure.code);
    LoggerUtil.error('[SOCIAL_CALENDAR] Generation stopped', { ...describeProviderFailure(error), message: error?.code ? undefined : error?.message, validationErrors: error?.validation ? flattenAttempts(error.validation) : undefined, savedPosts, runAttempts }, { calendarId: String(calendarId), runId, failureCode: failure.code, status });
  } catch (inner) {
    LoggerUtil.error('[SOCIAL_CALENDAR] Could not record how a generation stopped', { message: inner.message }, { calendarId: String(calendarId), runId });
  }
}

/** Starts the run of an already-claimed generation: in the background by default, awaited in tests. */
export async function launchRun(calendarId, lockedBy, { background = true } = {}) {
  const run = () => runCalendarGeneration(calendarId, lockedBy).catch((error) => {
    LoggerUtil.error('[SOCIAL_CALENDAR] Generation bookkeeping failed', { message: error.message }, { calendarId: String(calendarId), runId: lockedBy });
  });
  if (background) { setImmediate(run); return null; }
  return run();
}

// ── resume / cancel / recovery ───────────────────────────────────────────────

function isInFlightConflict(error) {
  if (error?.code !== 11000) return false;
  if (error.keyPattern) return !('version' in error.keyPattern);
  return String(error.message).includes('unique_calendar_generating_in_flight');
}

/**
 * Continues a PARTIAL calendar the person asked to resume: only the missing batches are generated. The claim is one conditional update
 * (partial -> generating); the run counter restarts, because the person has now decided to go on.
 * @returns {Promise<{ success: true, calendar, alreadyRunning: boolean } | { success: false, error }>}
 */
export async function resumeCalendarGeneration(projectId, { now = new Date(), background = true, userId = null } = {}) {
  const pid = toId(projectId);
  const running = await SocialContentCalendar.findOne({ project_id: pid, status: 'generating' }).lean();
  if (running) return { success: true, alreadyRunning: true, calendar: running };
  const partial = await SocialContentCalendar.findOne({ project_id: pid, status: 'partial' }).sort({ version: -1 }).lean();
  if (!partial) return fail('NOTHING_TO_RESUME', 'There is no unfinished calendar to resume.');
  if (!getProvider().isAvailable()) return fail('AI_UNAVAILABLE', CALENDAR_FAILURE_MESSAGES.AI_UNAVAILABLE);
  if (!(await SocialAIStrategy.exists({ _id: partial.strategy.id, project_id: pid }))) return fail('NO_STRATEGY', 'The strategy this calendar was planned from is no longer available. Start a new calendar instead.');

  // The usage allowance: only the posts still MISSING are reserved - the ones already saved were counted when it stopped.
  const savedPosts = await SocialContentCalendarItem.countDocuments({ calendar_id: partial._id, slot: { $type: 'number' } });
  const missing = Math.max(0, (partial.generation?.progress?.totalPosts || 0) - savedPosts);
  const owner = userId || (await SeoProject.findById(pid).select('user_id').lean())?.user_id;
  const reservation = await reserveCalendarQuota({
    userId: owner, projectId: pid, calendarId: partial._id, posts: missing, now,
    base: { saved: savedPosts, inputTokens: partial.generation?.usage?.inputTokens || 0, outputTokens: partial.generation?.usage?.outputTokens || 0, aiCalls: partial.generation?.attempts || 0 },
  });
  if (!reservation.success) return { success: false, error: reservation.error };

  const lockedBy = newOwner();
  let claimed = null;
  try {
    claimed = await SocialContentCalendar.findOneAndUpdate(
      { _id: partial._id, project_id: pid, status: 'partial' },
      { $set: { status: 'generating', 'generation.lockedBy': lockedBy, 'generation.lease.expiresAt': leaseUntil(now), 'generation.runAttempts': 1, 'generation.retry': { code: null, at: null }, 'generation.finishedAt': null, failure: { code: null, message: null, at: null } } },
      { new: true },
    ).lean();
  } catch (error) {
    await releaseCalendarQuota({ userId: owner, projectId: pid, calendarId: partial._id, now });
    if (!isInFlightConflict(error)) throw error;
    return { success: true, alreadyRunning: true, calendar: await SocialContentCalendar.findOne({ project_id: pid, status: 'generating' }).lean() };
  }
  if (!claimed) {
    await releaseCalendarQuota({ userId: owner, projectId: pid, calendarId: partial._id, now });
    return fail('CONFLICT', 'That calendar changed at the same moment. Please try again.');
  }
  LoggerUtil.info('[SOCIAL_CALENDAR] Generation resumed', { projectId: String(projectId), calendarId: String(claimed._id), runId: lockedBy, savedPosts: claimed.generation?.progress?.plannedPosts });
  const result = await launchRun(claimed._id, lockedBy, { background });
  return { success: true, alreadyRunning: false, calendar: result || (await SocialContentCalendar.findById(claimed._id).lean()) };
}

/**
 * Stops an unfinished calendar (running, waiting for a retry, or partial) and discards what it saved so far. A running worker notices on its
 * next heartbeat or batch and stops; the last good calendar is untouched.
 */
export async function cancelCalendarGeneration(projectId, { now = new Date() } = {}) {
  const pid = toId(projectId);
  const target = await SocialContentCalendar.findOne({ project_id: pid, status: { $in: ['generating', 'partial'] } }).sort({ version: -1 }).lean();
  if (!target) return fail('NOTHING_TO_CANCEL', 'There is no unfinished calendar to stop.');
  const cancelled = await SocialContentCalendar.findOneAndUpdate(
    { _id: target._id, project_id: pid, status: { $in: ['generating', 'partial'] } },
    { $set: { status: 'cancelled', 'generation.finishedAt': now, 'generation.lease.expiresAt': null, 'generation.retry': { code: null, at: null }, failure: { code: 'GENERATION_CANCELLED', message: 'This calendar was stopped.', at: now } } },
    { new: true },
  ).lean();
  if (!cancelled) return fail('CONFLICT', 'That calendar changed at the same moment. Please try again.');
  await settleQuietly(cancelled._id); // before the posts are discarded: what was generated was real work and is counted
  await SocialContentCalendarItem.deleteMany({ calendar_id: cancelled._id });
  LoggerUtil.info('[SOCIAL_CALENDAR] Generation cancelled', { projectId: String(projectId), calendarId: String(cancelled._id), version: cancelled.version });
  return { success: true, calendar: cancelled };
}

/** Finishes a generation that will not be continued automatically: partial when it saved posts, else failed. */
async function finishInterrupted(doc, filter, now) {
  const savedPosts = await SocialContentCalendarItem.countDocuments({ calendar_id: doc._id, slot: { $type: 'number' } });
  const failure = { code: 'GENERATION_INTERRUPTED', message: CALENDAR_FAILURE_MESSAGES.GENERATION_INTERRUPTED, at: now };
  const res = await SocialContentCalendar.updateOne(filter, { $set: { status: savedPosts > 0 ? 'partial' : 'failed', 'generation.finishedAt': now, 'generation.lease.expiresAt': null, 'generation.progress.plannedPosts': savedPosts, 'generation.retry': { code: null, at: null }, failure } });
  if (res.modifiedCount > 0) await settleQuietly(doc._id);
  return res.modifiedCount > 0;
}

/**
 * Takes over generations whose lease expired (their worker died, hung, or is waiting out a retry) and continues them from the batches
 * already saved. Safe to call from any instance, at any time, concurrently: each take-over is one conditional update. Generations of a
 * trashed project are left alone (they continue after a restore). One project, or all of them (the cron sweep).
 *
 * @returns {Promise<{ found: number, resumed: number, finished: number }>}
 */
export async function recoverInterruptedCalendars({ projectId = null, now = new Date(), resume = true, background = true, limit = 20 } = {}) {
  const summary = { found: 0, resumed: 0, finished: 0 };
  const scope = projectId ? { project_id: toId(projectId) } : await (async () => { const trashed = await getTrashedProjectIds(); return trashed.length ? { project_id: { $nin: trashed } } : {}; })();

  // generations that predate leases: their worker is gone for good (it ran in a process that has since restarted)
  const legacy = await SocialContentCalendar.find({ ...scope, status: 'generating', 'generation.lease.expiresAt': null, 'generation.startedAt': { $lt: new Date(now.getTime() - CALENDAR_LEASE_MS) } }).limit(limit).lean();
  for (const doc of legacy) {
    summary.found += 1;
    // eslint-disable-next-line no-await-in-loop
    if (await finishInterrupted(doc, { _id: doc._id, status: 'generating', 'generation.lease.expiresAt': null }, now)) { summary.finished += 1; recordTakeover('finished_interrupted'); }
  }

  const expired = { ...scope, status: 'generating', 'generation.lease.expiresAt': { $lt: now } };
  const docs = await SocialContentCalendar.find(expired).sort({ 'generation.lease.expiresAt': 1 }).limit(limit).lean();
  for (const doc of docs) {
    summary.found += 1;
    // eslint-disable-next-line no-await-in-loop
    const state = await getProjectState(doc.project_id);
    if (state === PROJECT_STATES.TRASHED) continue;
    const filter = { _id: doc._id, status: 'generating', 'generation.lease.expiresAt': { $lt: now } };
    if (state === PROJECT_STATES.MISSING) {
      // eslint-disable-next-line no-await-in-loop
      await SocialContentCalendar.updateOne(filter, { $set: { status: 'cancelled', 'generation.lease.expiresAt': null } });
      // eslint-disable-next-line no-await-in-loop
      await settleQuietly(doc._id);
      // eslint-disable-next-line no-await-in-loop
      await SocialContentCalendarItem.deleteMany({ calendar_id: doc._id });
      summary.finished += 1;
      recordTakeover('project_gone');
      continue;
    }
    if ((doc.generation?.runAttempts || 0) >= CALENDAR_MAX_RUN_ATTEMPTS || !resume) {
      // eslint-disable-next-line no-await-in-loop
      if (await finishInterrupted(doc, filter, now)) { summary.finished += 1; recordTakeover('finished_interrupted'); }
      continue;
    }
    const lockedBy = newOwner();
    // eslint-disable-next-line no-await-in-loop
    const claimed = await SocialContentCalendar.findOneAndUpdate(filter, { $set: { 'generation.lockedBy': lockedBy, 'generation.lease.expiresAt': leaseUntil(now) }, $inc: { 'generation.runAttempts': 1 } }, { new: true }).lean();
    if (!claimed) continue; // another instance took it first
    summary.resumed += 1;
    recordTakeover('resumed');
    LoggerUtil.warn('[SOCIAL_CALENDAR] Taking over an interrupted generation', { calendarId: String(claimed._id), runId: lockedBy, projectId: String(claimed.project_id), runAttempts: claimed.generation?.runAttempts, savedPosts: claimed.generation?.progress?.plannedPosts });
    // eslint-disable-next-line no-await-in-loop
    await launchRun(claimed._id, lockedBy, { background });
  }
  return summary;
}

/** Removes old versions beyond the history limit, EXCEPT any that own an item linked to a real publication. */
export async function pruneHistory(projectId) {
  const old = await SocialContentCalendar.find({ project_id: projectId, status: { $in: ['archived', 'cancelled', 'failed'] } }).sort({ version: -1 }).skip(CALENDAR_HISTORY_LIMIT).select('_id').lean();
  for (const c of old) {
    // eslint-disable-next-line no-await-in-loop
    const linked = await SocialContentCalendarItem.exists({ calendar_id: c._id, 'publicationIds.0': { $exists: true } });
    if (linked) continue;
    // eslint-disable-next-line no-await-in-loop
    await SocialContentCalendarItem.deleteMany({ calendar_id: c._id });
    // eslint-disable-next-line no-await-in-loop
    await SocialContentCalendar.deleteOne({ _id: c._id });
  }
}

export default { runCalendarGeneration, launchRun, resumeCalendarGeneration, cancelCalendarGeneration, recoverInterruptedCalendars, pruneHistory };
