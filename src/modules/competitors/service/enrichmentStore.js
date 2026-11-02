import ProjectCompetitor from '../model/ProjectCompetitor.js';
import CompetitorEnrichmentUsage from '../model/CompetitorEnrichmentUsage.js';
import { SECTION_ERROR } from './enrichmentMetrics.js';

/**
 * The enrichment queue, which is the project_competitors collection itself (status + lease fields), exactly like the Google AI Overview
 * and investigation runs: every take-over is ONE conditional update, so two workers can never own the same competitor, and a worker that
 * lost its lease (it crashed, or took too long) writes nothing because every write below is guarded by lease ownership.
 * Only the `enrichment` object is ever written here.
 */

export class ProviderBudgetExceeded extends Error {
  constructor() {
    super('This project reached its daily limit of data-provider calls for competitor enrichment.');
    this.name = 'ProviderBudgetExceeded';
    this.code = SECTION_ERROR.PROJECT_BUDGET;
  }
}

const day = (now) => new Date(now).toISOString().slice(0, 10);

/**
 * Reserves ONE real provider call for the project today, or throws ProviderBudgetExceeded and reserves nothing. One conditional upsert:
 * the cap is part of the filter, so concurrent workers cannot overshoot it; at the cap the upsert hits the unique (project, day) index
 * instead of matching, which is how "full" is told apart from "first call of the day" (a lost first-call race is simply retried once).
 */
export async function reserveProviderCall(projectId, cap, now = Date.now(), Usage = CompetitorEnrichmentUsage) {
  const filter = { project_id: projectId, day: day(now), calls: { $lt: cap } };
  const update = { $inc: { calls: 1 }, $setOnInsert: { expires_at: new Date(now + 8 * 24 * 60 * 60_000) } };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await Usage.updateOne(filter, update, { upsert: true });
      return;
    } catch (err) {
      if (err?.code !== 11000) throw err;
      const current = await Usage.findOne({ project_id: projectId, day: day(now) }).lean();
      if (current && current.calls >= cap) throw new ProviderBudgetExceeded();
      // Another worker created today's document between our attempt and now: it has room, so try once more.
    }
  }
  throw new ProviderBudgetExceeded();
}

/** How many real calls the project has used today (for logs and the details view). */
export async function providerCallsToday(projectId, now = Date.now()) {
  const doc = await CompetitorEnrichmentUsage.findOne({ project_id: projectId, day: day(now) }).lean();
  return doc?.calls ?? 0;
}

/**
 * Puts a competitor in the queue (a new one, a changed website, or a manual refresh). Existing sections are kept for a refresh, so the
 * user keeps seeing the last known numbers while new ones arrive; `wipe` (the website changed) removes them because they describe
 * another domain. Refuses (returns null) while a worker holds a valid lease, so a refresh can never interleave with a running fetch.
 * @returns the updated lean document, or null when it is not there / currently being processed
 */
export async function queueEnrichment({ id, projectId, now = new Date(), wipe = false }) {
  const filter = {
    _id: id,
    project_id: projectId,
    domain: { $type: 'string' },
    $or: [{ 'enrichment.status': { $ne: 'processing' } }, { 'enrichment.lease_until': { $lt: now } }, { 'enrichment.lease_until': null }],
  };
  const set = {
    'enrichment.status': 'pending',
    'enrichment.requested_at': now,
    'enrichment.next_attempt_at': now,
    'enrichment.attempts': 0,
    'enrichment.lease_owner': null,
    'enrichment.lease_until': null,
    'enrichment.last_error_code': null,
  };
  const update = wipe ? { $set: set, $unset: { 'enrichment.sections': '', 'enrichment.finished_at': '', 'enrichment.last_success_at': '', 'enrichment.market': '' } } : { $set: set };
  return ProjectCompetitor.findOneAndUpdate(filter, update, { new: true }).lean();
}

/**
 * Competitors that were finished before the head-to-head comparison existed carry a `not_configured` shared section. Queue them again so
 * they get one: only the shared section is fetched (rank and backlinks were answered after their original request, so a run keeps them).
 * Never touches one that is queued or running. @returns {Promise<number>} how many were queued
 */
export async function requeueMissingShared({ now = new Date(), projectId = null } = {}) {
  const res = await ProjectCompetitor.updateMany(
    {
      domain: { $type: 'string' },
      ...(projectId ? { project_id: projectId } : {}),
      'enrichment.status': { $in: ['enriched', 'partial', 'no_data'] },
      'enrichment.sections.shared.status': 'not_configured',
    },
    { $set: { 'enrichment.status': 'pending', 'enrichment.next_attempt_at': now, 'enrichment.attempts': 0, 'enrichment.last_error_code': null } },
  );
  return res.modifiedCount ?? 0;
}

/** No website (yet, or any more): nothing can be fetched, and whatever was fetched for the old website is dropped. */
export async function markNoWebsite({ id, projectId }) {
  return ProjectCompetitor.findOneAndUpdate(
    { _id: id, project_id: projectId },
    { $set: { 'enrichment.status': 'no_website', 'enrichment.lease_owner': null, 'enrichment.lease_until': null, 'enrichment.attempts': 0 }, $unset: { 'enrichment.sections': '', 'enrichment.finished_at': '', 'enrichment.last_success_at': '', 'enrichment.market': '', 'enrichment.requested_at': '', 'enrichment.next_attempt_at': '' } },
    { new: true },
  ).lean();
}

/**
 * Takes ONE competitor that is due: `pending` with its next attempt reached, or `processing` whose lease expired (a crashed worker).
 * One conditional update: of any number of simultaneous callers exactly one gets a given document. The attempt is counted here.
 * @returns the claimed lean document (enrichment.attempts already incremented), or null when nothing is due
 */
export async function claimNext({ owner, now = new Date(), leaseMs, projectId = null }) {
  return ProjectCompetitor.findOneAndUpdate(
    {
      domain: { $type: 'string' },
      ...(projectId ? { project_id: projectId } : {}),
      $or: [
        { 'enrichment.status': 'pending', 'enrichment.next_attempt_at': { $lte: now } },
        { 'enrichment.status': 'processing', 'enrichment.lease_until': { $lt: now } },
      ],
    },
    {
      $set: { 'enrichment.status': 'processing', 'enrichment.lease_owner': owner, 'enrichment.lease_until': new Date(now.getTime() + leaseMs), 'enrichment.started_at': now },
      $inc: { 'enrichment.attempts': 1 },
    },
    { new: true, sort: { 'enrichment.next_attempt_at': 1 } },
  ).lean();
}

const owned = (id, owner, now) => ({ _id: id, 'enrichment.status': 'processing', 'enrichment.lease_owner': owner, 'enrichment.lease_until': { $gt: now } });

/** Saves one finished section, only while the caller still owns the lease. @returns {Promise<boolean>} false = the lease was lost: stop. */
export async function saveSection({ id, owner, key, section, now = new Date() }) {
  const res = await ProjectCompetitor.updateOne(owned(id, owner, now), { $set: { [`enrichment.sections.${key}`]: section } });
  return res.matchedCount === 1;
}

/**
 * Ends a run, only while the caller still owns the lease: records the status, the market used and any error, and releases the lease.
 * `status: 'pending'` with `nextAttemptAt` is "try the failed sections again later".
 */
export async function finishRun({ id, owner, status, nextAttemptAt = null, errorCode = null, market = null, succeeded = false, refundAttempt = false, now = new Date() }) {
  const set = {
    'enrichment.status': status,
    'enrichment.finished_at': now,
    'enrichment.lease_owner': null,
    'enrichment.lease_until': null,
    'enrichment.next_attempt_at': nextAttemptAt,
    'enrichment.last_error_code': errorCode,
    ...(market ? { 'enrichment.market': { location: market.location, language: market.language } } : {}),
    ...(succeeded ? { 'enrichment.last_success_at': now } : {}),
  };
  const res = await ProjectCompetitor.updateOne(
    // Guard on the lease ownership only (not its expiry): finishing slightly late is still the same worker's run, unless someone took over.
    { _id: id, 'enrichment.status': 'processing', 'enrichment.lease_owner': owner },
    { $set: set, ...(refundAttempt ? { $inc: { 'enrichment.attempts': -1 } } : {}) },
  );
  return res.matchedCount === 1;
}
