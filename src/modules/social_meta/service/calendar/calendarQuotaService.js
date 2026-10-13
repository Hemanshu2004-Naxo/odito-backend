import mongoose from 'mongoose';
import SocialAIUsage from '../../model/SocialAIUsage.js';
import SocialContentCalendar from '../../model/SocialContentCalendar.js';
import SocialContentCalendarItem from '../../model/SocialContentCalendarItem.js';
import User from '../../../user/model/User.js';
import { getSocialAiAllowance, getProjectAllowance, isProduction, planAllowanceEnvVar } from '../../../../config/socialAiAllowance.js';
import {
  CALENDAR_QUOTA_MAX_IN_FLIGHT_PER_USER,
  CALENDAR_COST_USD_PER_MTOK_INPUT, CALENDAR_COST_USD_PER_MTOK_OUTPUT, CALENDAR_QUOTA_RECONCILE_AFTER_MS,
} from './calendarConfig.js';
import { LoggerUtil } from '../../../../utils/LoggerUtil.js';
import { recordQuotaEvent } from '../../../../monitoring/socialAiMetrics.js';

/**
 * calendarQuotaService - usage limits and cost tracking for calendar generation, enforced in the DATABASE so they hold on any number of
 * API instances (the in-process rate limiter only smooths bursts on one).
 *
 *   RESERVE   before any AI call, the posts the calendar needs are reserved on the account's ledger and the project's ledger. A reservation
 *             is one conditional update of one document, so concurrent requests cannot both fit into room that only one fits into.
 *   SETTLE    when the run stops - ready, partial, failed, cancelled, interrupted - the reservation is removed and what was REALLY
 *             produced is committed in the SAME atomic update (posts actually saved, AI calls, tokens, estimated cost). Settling twice
 *             is a no-op, so a retry, a crash or a sweep can never double-charge or leak.
 *   RESUME    a partial calendar reserves only its MISSING posts; the posts it already has were committed when it stopped.
 *   RECONCILE a sweep releases reservations whose generation is gone or finished without settling (a deleted project, a crash between steps).
 *
 * Limits (per UTC calendar month; none is invented): the account's plan entitlement (config/socialAiAllowance.js: plans.js, a per-plan
 * deployment setting, the no-plan setting, then the platform-wide setting), SOCIAL_AI_CALENDAR_QUOTA_PROJECT_POSTS_PER_MONTH per project,
 * and a safety cap on generations running at once per account. Nothing decided means REFUSED in production (fail closed), never unlimited.
 */

const toId = (id) => (mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : id);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-10" for a date (UTC calendar month). */
export const periodOf = (now = new Date()) => now.toISOString().slice(0, 7);
/** When the period's allowance resets: the first instant of the next UTC month. */
export function periodResetsAt(period) {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m, 1));
}
const resetLabel = (period) => { const d = periodResetsAt(period); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };

const reservedOf = (doc) => (doc?.reservations || []).reduce((n, r) => n + r.posts, 0);
const usedOf = (doc) => (doc?.committedPosts || 0) + reservedOf(doc);

const BLOCKED_LOG_EVERY_MS = 60_000;
const blockedLoggedAt = new Map();
/** One error line per cause per minute: a misconfiguration is loud once, not once per page load. */
function logBlockedOnce(context) {
  const key = `${context.reason}:${context.plan}`;
  const last = blockedLoggedAt.get(key) || 0;
  if (Date.now() - last < BLOCKED_LOG_EVERY_MS) return;
  blockedLoggedAt.set(key, Date.now());
  recordQuotaEvent('blocked_config');
  LoggerUtil.error('[SOCIAL_CALENDAR_QUOTA] No usable Social AI allowance - calendar generation is refused', context);
}

/**
 * The limits that apply to this account. `blocked` is set when no allowance is decided for it in production (or the configuration is
 * invalid): the generation is then refused with a stable code - never allowed as "unlimited".
 */
export async function limitsFor(userId, { env = process.env } = {}) {
  const user = await User.findById(toId(userId)).select('subscription.plan').lean();
  const allowance = getSocialAiAllowance(user?.subscription?.plan || null, env);
  const base = { projectPosts: getProjectAllowance(env), maxInFlight: CALENDAR_QUOTA_MAX_IN_FLIGHT_PER_USER, planId: allowance.planId, blocked: null };
  if (allowance.state === 'limited') return { ...base, userPosts: allowance.posts, source: allowance.source };
  if (allowance.state === 'unlimited') return { ...base, userPosts: null, source: allowance.source };
  const noPlan = !allowance.planId;
  if (allowance.state === 'unconfigured' && !isProduction(env)) return { ...base, userPosts: null, source: 'none' }; // development / tests: no setup needed
  logBlockedOnce({ reason: allowance.state, plan: allowance.planId || 'none', setting: noPlan ? 'SOCIAL_AI_NO_PLAN_CALENDAR_POSTS_PER_MONTH' : planAllowanceEnvVar(allowance.planId), detail: allowance.reason || null });
  const blocked = noPlan && allowance.state === 'unconfigured'
    ? { code: 'PLAN_REQUIRED', message: 'AI content calendars are included with an Odito subscription plan. Choose a plan to plan content with AI.' }
    : { code: 'QUOTA_NOT_CONFIGURED', message: 'AI calendar planning is temporarily unavailable for your plan. Please try again later or contact support.' };
  return { ...base, userPosts: 0, source: 'none', blocked };
}

const ensureLedger = async (scope, scopeId, period) => {
  try {
    await SocialAIUsage.updateOne({ scope, scope_id: toId(scopeId), period }, { $setOnInsert: { scope, scope_id: toId(scopeId), period, committedPosts: 0, reservations: [] } }, { upsert: true });
  } catch (error) {
    if (error?.code !== 11000) throw error; // another request created it at the same moment
  }
};

const shortfall = (scope, doc, limit, requested, period) => {
  const used = usedOf(doc);
  const remaining = Math.max(0, limit - used);
  const who = scope === 'user' ? 'your account' : 'this project';
  return {
    code: 'QUOTA_EXCEEDED',
    scope,
    message: `Your calendar needs ${requested} posts, but ${who} has ${remaining} of ${limit} calendar posts left this month (${used} used). The allowance resets on ${resetLabel(period)}. Choose fewer posts per week or a shorter calendar, or contact support about a higher allowance.`,
    limit, used, remaining, requested, period, resetsAt: periodResetsAt(period).toISOString(),
  };
};

/** One atomic reservation on one ledger, refused when it would pass the post limit or the in-flight cap. */
async function reserveOn(scope, scopeId, period, calendarId, posts, base, { limitPosts, maxInFlight, now }) {
  await ensureLedger(scope, scopeId, period);
  const filter = { scope, scope_id: toId(scopeId), period, 'reservations.calendar_id': { $ne: calendarId } };
  const rules = [];
  if (limitPosts != null) rules.push({ $lte: [{ $add: ['$committedPosts', { $sum: '$reservations.posts' }, posts] }, limitPosts] });
  if (maxInFlight != null) rules.push({ $lt: [{ $size: '$reservations' }, maxInFlight] });
  if (rules.length) filter.$expr = { $and: rules };
  const doc = await SocialAIUsage.findOneAndUpdate(filter, { $push: { reservations: { calendar_id: calendarId, posts, at: now, ...base } } }, { new: true }).lean();
  if (doc) return { ok: true };
  const current = await SocialAIUsage.findOne({ scope, scope_id: toId(scopeId), period }).lean();
  if ((current?.reservations || []).some((r) => String(r.calendar_id) === String(calendarId))) return { ok: true, already: true };
  if (maxInFlight != null && (current?.reservations || []).length >= maxInFlight) {
    recordQuotaEvent('refused_in_flight');
    return { ok: false, error: { code: 'TOO_MANY_GENERATIONS', scope, message: `You already have ${(current.reservations || []).length} calendars being generated. Wait for one to finish (or stop it) before starting another.`, inFlight: current.reservations.length, maxInFlight } };
  }
  recordQuotaEvent('refused_quota');
  return { ok: false, error: shortfall(scope, current, limitPosts, posts, period) };
}

async function release(scope, scopeId, period, calendarId) {
  await SocialAIUsage.updateOne({ scope, scope_id: toId(scopeId), period }, { $pull: { reservations: { calendar_id: calendarId } } });
}

/**
 * Reserves `posts` for a generation, on the account and on the project, before anything expensive happens.
 * @param {object} args { userId, projectId, calendarId, posts, base: { saved, inputTokens, outputTokens, aiCalls }, now }
 * @returns {Promise<{ success: true, period: string } | { success: false, error: object }>}
 */
export async function reserveCalendarQuota({ userId, projectId, calendarId, posts, base = {}, now = new Date() }) {
  const period = periodOf(now);
  const limits = await limitsFor(userId);
  if (limits.blocked) return { success: false, error: limits.blocked };
  const stored = { baseSaved: base.saved || 0, baseInputTokens: base.inputTokens || 0, baseOutputTokens: base.outputTokens || 0, baseAiCalls: base.aiCalls || 0 };
  const cid = toId(calendarId);
  const onUser = await reserveOn('user', userId, period, cid, posts, stored, { limitPosts: limits.userPosts, maxInFlight: limits.maxInFlight, now });
  if (!onUser.ok) return { success: false, error: onUser.error };
  const onProject = await reserveOn('project', projectId, period, cid, posts, stored, { limitPosts: limits.projectPosts, maxInFlight: null, now });
  if (!onProject.ok) {
    await release('user', userId, period, cid); // all or nothing
    return { success: false, error: onProject.error };
  }
  recordQuotaEvent('reserved');
  return { success: true, period };
}

/** Gives a reservation back without committing anything (the generation never started). */
export async function releaseCalendarQuota({ userId, projectId, calendarId, now = new Date() }) {
  const period = periodOf(now);
  await release('user', userId, period, toId(calendarId));
  await release('project', projectId, period, toId(calendarId));
}

const costOf = (inputTokens, outputTokens) => {
  if (CALENDAR_COST_USD_PER_MTOK_INPUT == null && CALENDAR_COST_USD_PER_MTOK_OUTPUT == null) return 0;
  return Math.round((((inputTokens / 1e6) * (CALENDAR_COST_USD_PER_MTOK_INPUT || 0)) + ((outputTokens / 1e6) * (CALENDAR_COST_USD_PER_MTOK_OUTPUT || 0))) * 1e6) / 1e6;
};

/**
 * Settles the reservation(s) of a generation that has stopped: removes them and commits what this run really produced, in ONE atomic
 * update per ledger. Idempotent - a second call finds nothing to settle. Safe to call for a calendar that no longer exists (zero is committed).
 * Call it BEFORE discarding a calendar's posts, so what was generated is counted.
 * @returns {Promise<{ settled: number, postsCommitted: number }>}
 */
export async function settleCalendarQuota(calendarId) {
  const cid = toId(calendarId);
  const ledgers = await SocialAIUsage.find({ 'reservations.calendar_id': cid }).lean();
  if (!ledgers.length) return { settled: 0, postsCommitted: 0 };
  const calendar = await SocialContentCalendar.findById(cid).select('generation.usage generation.attempts').lean();
  const saved = calendar ? await SocialContentCalendarItem.countDocuments({ calendar_id: cid, slot: { $type: 'number' } }) : 0;
  let settled = 0;
  let postsCommitted = 0;
  for (const ledger of ledgers) {
    const entry = ledger.reservations.find((r) => String(r.calendar_id) === String(cid));
    const posts = calendar ? Math.min(Math.max(0, saved - (entry.baseSaved || 0)), entry.posts) : 0;
    const inputTokens = calendar ? Math.max(0, (calendar.generation?.usage?.inputTokens || 0) - (entry.baseInputTokens || 0)) : 0;
    const outputTokens = calendar ? Math.max(0, (calendar.generation?.usage?.outputTokens || 0) - (entry.baseOutputTokens || 0)) : 0;
    const aiCalls = calendar ? Math.max(0, (calendar.generation?.attempts || 0) - (entry.baseAiCalls || 0)) : 0;
    // matches only while THIS reservation is still there: a concurrent settle wins once, the other finds nothing
    // eslint-disable-next-line no-await-in-loop
    const done = await SocialAIUsage.findOneAndUpdate(
      { _id: ledger._id, reservations: { $elemMatch: { calendar_id: cid, at: entry.at } } },
      { $pull: { reservations: { calendar_id: cid } }, $inc: { committedPosts: posts, aiCalls, inputTokens, outputTokens, estimatedCostUsd: costOf(inputTokens, outputTokens) } },
    );
    if (done) { settled += 1; if (ledger.scope === 'user') postsCommitted = posts; }
  }
  if (settled) recordQuotaEvent('settled'); // one event per settled calendar (not per ledger)
  if (settled) LoggerUtil.info('[SOCIAL_CALENDAR_QUOTA] Settled', { calendarId: String(cid), ledgers: settled, postsCommitted });
  return { settled, postsCommitted };
}

/** settleCalendarQuota that never throws (the reconciliation sweep repairs anything it could not do). */
export async function settleQuietly(calendarId) {
  try { return await settleCalendarQuota(calendarId); } catch (error) {
    recordQuotaEvent('settle_failed');
    LoggerUtil.error('[SOCIAL_CALENDAR_QUOTA] Could not settle a reservation (the sweep will retry)', { message: error.message }, { calendarId: String(calendarId) });
    return { settled: 0, postsCommitted: 0, error: true };
  }
}

/**
 * What the account and the project have used this month, and what is left (null limit = unlimited). Read-only.
 * `used` = `committed` (posts really generated) + `reserved` (held by calendars still being generated, released or committed when they stop).
 * The default view is safe for a client; `internal: true` adds the plan source and token / cost counters, which never leave the server.
 */
export async function getUsageSummary({ userId, projectId, now = new Date(), internal = false }) {
  const period = periodOf(now);
  const [limits, userDoc, projectDoc] = await Promise.all([
    limitsFor(userId),
    SocialAIUsage.findOne({ scope: 'user', scope_id: toId(userId), period }).lean(),
    SocialAIUsage.findOne({ scope: 'project', scope_id: toId(projectId), period }).lean(),
  ]);
  const view = (doc, limit) => ({ limit, used: usedOf(doc), committed: doc?.committedPosts || 0, reserved: reservedOf(doc), remaining: limit == null ? null : Math.max(0, limit - usedOf(doc)) });
  const summary = {
    period,
    resetsAt: periodResetsAt(period).toISOString(),
    user: view(userDoc, limits.userPosts),
    project: view(projectDoc, limits.projectPosts),
    inFlight: (userDoc?.reservations || []).length,
    maxInFlight: limits.maxInFlight,
    unavailable: limits.blocked ? { code: limits.blocked.code, message: limits.blocked.message } : null,
  };
  if (!internal) return summary;
  return {
    ...summary,
    source: limits.source,
    planId: limits.planId,
    usage: { aiCalls: userDoc?.aiCalls || 0, inputTokens: userDoc?.inputTokens || 0, outputTokens: userDoc?.outputTokens || 0, estimatedCostUsd: CALENDAR_COST_USD_PER_MTOK_INPUT != null || CALENDAR_COST_USD_PER_MTOK_OUTPUT != null ? (userDoc?.estimatedCostUsd || 0) : null },
  };
}

/** Would `posts` more fit right now? Read-only (nothing is reserved): for the form's preview. */
export async function checkQuotaFor({ userId, projectId, posts, now = new Date() }) {
  const summary = await getUsageSummary({ userId, projectId, now });
  if (summary.unavailable) return { ok: false, summary, error: { ...summary.unavailable } };
  for (const scope of ['user', 'project']) {
    const s = summary[scope];
    if (s.limit != null && s.used + posts > s.limit) {
      return { ok: false, summary, error: shortfall(scope, { committedPosts: s.used }, s.limit, posts, summary.period) };
    }
  }
  return { ok: true, summary };
}

/**
 * Releases reservations whose generation is not running any more (finished without settling, deleted with its project, a crash between
 * two steps). Run by the recovery sweep; idempotent and safe on many instances.
 * @returns {Promise<{ checked: number, settled: number }>}
 */
export async function reconcileQuotaReservations({ now = new Date(), limit = 50 } = {}) {
  const cutoff = new Date(now.getTime() - CALENDAR_QUOTA_RECONCILE_AFTER_MS);
  const ledgers = await SocialAIUsage.find({ reservations: { $elemMatch: { at: { $lt: cutoff } } } }).limit(limit).lean();
  const summary = { checked: 0, settled: 0 };
  const seen = new Set();
  for (const ledger of ledgers) {
    for (const r of ledger.reservations) {
      if (r.at >= cutoff || seen.has(String(r.calendar_id))) continue;
      seen.add(String(r.calendar_id));
      summary.checked += 1;
      // eslint-disable-next-line no-await-in-loop
      const calendar = await SocialContentCalendar.findById(r.calendar_id).select('status').lean();
      if (!calendar || calendar.status !== 'generating') {
        // eslint-disable-next-line no-await-in-loop
        const result = await settleQuietly(r.calendar_id);
        summary.settled += result.settled;
      }
    }
  }
  if (summary.settled) { recordQuotaEvent('released_stale', summary.settled); LoggerUtil.warn('[SOCIAL_CALENDAR_QUOTA] Released stale reservations', summary); }
  return summary;
}

export default { limitsFor, reserveCalendarQuota, releaseCalendarQuota, settleCalendarQuota, settleQuietly, getUsageSummary, checkQuotaFor, reconcileQuotaReservations, periodOf, periodResetsAt };
