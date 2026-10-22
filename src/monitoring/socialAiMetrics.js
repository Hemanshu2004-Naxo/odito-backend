import mongoose from 'mongoose';
import { counter, gauge, histogram, registerCollector } from './metrics.js';
import SocialContentCalendar from '../modules/social_meta/model/SocialContentCalendar.js';
import SocialAIUsage from '../modules/social_meta/model/SocialAIUsage.js';
import SocialPublication from '../modules/social_meta/model/SocialPublication.js';
import { CALENDAR_MAX_RUN_MS, CALENDAR_QUOTA_RECONCILE_AFTER_MS } from '../modules/social_meta/service/calendar/calendarConfig.js';
import { validateSocialAiConfig } from '../config/socialAiAllowance.js';
import { LoggerUtil } from '../utils/LoggerUtil.js';

/**
 * Social Media AI operational metrics - what an operator needs to be told about: stuck or partial calendars, recovery that does not work,
 * provider errors, quota settlement failures, publishing failures, expired connections and project-cleanup failures.
 *
 * Event counters are incremented where the event happens (calendarGenerationRunner, calendarQuotaService, socialPublishingService, ...) through the
 * small record* helpers below; every label value is from a fixed list (see metrics.js), never an id, a URL or a message.
 * Gauges are read from the database at scrape time (cached a few seconds, every query bounded by maxTimeMS and answered from an index
 * or a small collection), so they describe the whole fleet, not one process.
 */

// ── event counters ───────────────────────────────────────────────────────────

const RUN_OUTCOMES = ['ready', 'partial', 'failed', 'retry_scheduled', 'paused', 'lock_lost', 'cancelled'];
const runs = counter({ name: 'odito_social_calendar_runs_total', help: 'Calendar generation runs by how they ended (retry_scheduled = a transient failure that will be retried automatically).', label: 'outcome', allowed: RUN_OUTCOMES });
const runDuration = histogram({ name: 'odito_social_calendar_run_duration_seconds', help: 'Wall-clock length of calendar generation runs that reached ready, partial or failed.', buckets: [5, 15, 30, 60, 120, 300, 600, 1800, 3600] });

const TAKEOVER_RESULTS = ['resumed', 'finished_interrupted', 'project_gone'];
const takeovers = counter({ name: 'odito_social_calendar_takeovers_total', help: 'Generations taken over after their worker died or its lease expired (resumed), ended because attempts ran out, or dropped because the project is gone.', label: 'result', allowed: TAKEOVER_RESULTS });
const sweeps = counter({ name: 'odito_social_calendar_recovery_sweeps_total', help: 'Recovery sweeps by result. An error means the sweep itself could not run.', label: 'result', allowed: ['ok', 'error'] });
const lastSweepOk = gauge({ name: 'odito_social_calendar_recovery_last_ok_timestamp_seconds', help: 'Unix time of the last recovery sweep that completed in this process (0 = none yet). Alert when it is old on every instance.' });

const PROVIDER_CODES = ['AI_UNAVAILABLE', 'AI_BUSY', 'AI_TIMEOUT', 'AI_UNREACHABLE', 'AI_BAD_OUTPUT', 'GENERATION_INTERRUPTED', 'GENERATION_FAILED', 'QUOTA_EXCEEDED', 'QUOTA_NOT_CONFIGURED', 'PLAN_REQUIRED', 'TOO_MANY_GENERATIONS'];
const providerErrors = counter({ name: 'odito_social_calendar_provider_errors_total', help: 'Calendar generations that hit an AI-provider (or allowance) failure, by Odito failure code.', label: 'code', allowed: PROVIDER_CODES });

const QUOTA_EVENTS = ['reserved', 'refused_quota', 'refused_in_flight', 'blocked_config', 'settled', 'settle_failed', 'released_stale'];
const quotaEvents = counter({ name: 'odito_social_quota_events_total', help: 'Social AI allowance events. settle_failed and blocked_config need a human.', label: 'event', allowed: QUOTA_EVENTS });

const publishOutcomes = counter({ name: 'odito_social_publish_total', help: 'Publish attempts by outcome (failed includes ones that will be retried).', label: 'outcome', allowed: ['published', 'failed', 'reconnect_required'] });
const connectionsExpired = counter({ name: 'odito_social_connections_expired_total', help: 'Meta connections marked expired because the token stopped working.' });

const CLEANUP_STEPS = ['inventory', 'credentials', 'usage-reservations', 'publications', 'accounts', 'media', 'orphan-sweep'];
const cleanupFailures = counter({ name: 'odito_social_cleanup_failures_total', help: 'Project-deletion cleanup steps that failed (critical ones keep the project in the trash for a retry).', label: 'step', allowed: CLEANUP_STEPS });

const collectErrors = counter({ name: 'odito_social_metrics_collection_errors_total', help: 'Scrape-time database reads that failed or timed out.' });

// ── gauges read from the database at scrape time ─────────────────────────────

const generations = gauge({ name: 'odito_social_calendar_generations', help: 'Calendars in generation now. active = a live worker holds the lease; retry_waiting = waiting out a transient failure; overdue = lease expired more than 3 minutes ago and nobody took it over (a stuck calendar).', label: 'state', allowed: ['active', 'retry_waiting', 'overdue'] });
const partialCalendars = gauge({ name: 'odito_social_calendar_partial', help: 'Partial calendars waiting for the person to resume them.' });
const leakedReservations = gauge({ name: 'odito_social_quota_leaked_reservations', help: 'Allowance ledgers (this month) holding a reservation older than the longest possible run: a settlement that never happened.' });
const overduePublications = gauge({ name: 'odito_social_publications_overdue', help: 'Scheduled posts more than 15 minutes past their time and still not published (the scheduler is off, stuck or failing).' });
const quotaPlansUnconfigured = gauge({ name: 'odito_social_quota_plans_unconfigured', help: 'Plans (and the no-plan group) with no usable Social AI allowance in PRODUCTION: their calendar generation is refused. 0 outside production.' });

const OVERDUE_LEASE_MS = 3 * 60 * 1000;
const PUBLICATION_GRACE_MS = 15 * 60 * 1000;
const CACHE_MS = 15 * 1000;
let refreshedAt = 0;

export async function refreshGauges({ now = new Date(), force = false } = {}) {
  if (!force && Date.now() - refreshedAt < CACHE_MS) return;
  refreshedAt = Date.now();
  // no database connection: nothing to read (and Mongoose would only buffer the queries until the scrape's time bound)
  if (mongoose.connection.readyState !== 1) { collectErrors.inc(); return; }
  const count = async (model, filter) => {
    try { return await model.countDocuments(filter).maxTimeMS(1500); } catch (error) { collectErrors.inc(); LoggerUtil.warn('[SOCIAL_METRICS] A gauge could not be read', { message: error.message }); return null; }
  };
  const leaked = new Date(now.getTime() - CALENDAR_MAX_RUN_MS - CALENDAR_QUOTA_RECONCILE_AFTER_MS);
  const period = now.toISOString().slice(0, 7);
  const lease = 'generation.lease.expiresAt';
  const [active, retrying, overdue, partial, leakedCount, late] = await Promise.all([
    count(SocialContentCalendar, { status: 'generating', [lease]: { $gte: now }, 'generation.retry.at': null }),
    count(SocialContentCalendar, { status: 'generating', [lease]: { $gte: now }, 'generation.retry.at': { $ne: null } }),
    count(SocialContentCalendar, { status: 'generating', [lease]: { $lt: new Date(now.getTime() - OVERDUE_LEASE_MS) } }),
    count(SocialContentCalendar, { status: 'partial' }),
    count(SocialAIUsage, { period, reservations: { $elemMatch: { at: { $lt: leaked } } } }),
    count(SocialPublication, { status: 'scheduled', scheduledAt: { $lt: new Date(now.getTime() - PUBLICATION_GRACE_MS) } }),
  ]);
  if (active !== null) generations.set('active', active);
  if (retrying !== null) generations.set('retry_waiting', retrying);
  if (overdue !== null) generations.set('overdue', overdue);
  if (partial !== null) partialCalendars.setUnlabelled(partial);
  if (leakedCount !== null) leakedReservations.setUnlabelled(leakedCount);
  if (late !== null) overduePublications.setUnlabelled(late);

  const report = validateSocialAiConfig(process.env);
  const unusable = Object.values(report.plans).filter((p) => p.state !== 'limited' && p.state !== 'unlimited').length + (['limited', 'unlimited'].includes(report.noPlan.state) ? 0 : 1);
  quotaPlansUnconfigured.setUnlabelled(report.production ? unusable : 0);
}
registerCollector(() => refreshGauges());

// ── recording helpers (the only API the rest of the code uses) ───────────────

export const recordRunOutcome = (outcome, durationMs = null) => {
  runs.inc(outcome);
  if (durationMs != null && ['ready', 'partial', 'failed'].includes(outcome)) runDuration.observe(durationMs / 1000);
};
export const recordTakeover = (result) => takeovers.inc(result);
export const recordRecoverySweep = (ok) => { sweeps.inc(ok ? 'ok' : 'error'); if (ok) lastSweepOk.setUnlabelled(Math.floor(Date.now() / 1000)); };
export const recordProviderError = (code) => providerErrors.inc(code);
export const recordQuotaEvent = (event, n = 1) => quotaEvents.inc(event, n);
export const recordPublish = (outcome) => publishOutcomes.inc(outcome);
export const recordConnectionExpired = () => connectionsExpired.inc();
export const recordCleanupFailure = (step) => cleanupFailures.inc(step);

export default { recordRunOutcome, recordTakeover, recordRecoverySweep, recordProviderError, recordQuotaEvent, recordPublish, recordConnectionExpired, recordCleanupFailure, refreshGauges };
