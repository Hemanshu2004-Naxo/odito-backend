import GoogleConnection from '../modules/app_user/model/GoogleConnection.js';
import GoogleAdsCampaign from '../modules/app_user/model/GoogleAdsCampaign.js';
import GoogleAdsCampaignMetrics from '../modules/app_user/model/GoogleAdsCampaignMetrics.js';
import GoogleAdsCampaignSnapshot from '../modules/app_user/model/GoogleAdsCampaignSnapshot.js';
import GoogleAdsKeyword from '../modules/app_user/model/GoogleAdsKeyword.js';
import GoogleAdsSearchTerm from '../modules/app_user/model/GoogleAdsSearchTerm.js';
import GoogleAdsOptimizationHistory from '../modules/app_user/model/GoogleAdsOptimizationHistory.js';
import GoogleAdsRecommendation from '../modules/app_user/model/GoogleAdsRecommendation.js';
import GoogleAdsDevicePerformance from '../modules/app_user/model/GoogleAdsDevicePerformance.js';
import GoogleAdsGeoPerformance from '../modules/app_user/model/GoogleAdsGeoPerformance.js';
import GoogleAdsAudiencePerformance from '../modules/app_user/model/GoogleAdsAudiencePerformance.js';
import GoogleAdsAd from '../modules/app_user/model/GoogleAdsAd.js';
import GoogleAdsConversionAction from '../modules/app_user/model/GoogleAdsConversionAction.js';
import GoogleAdsBudgetAlert from '../modules/app_user/model/GoogleAdsBudgetAlert.js';
import { JobService } from '../modules/jobs/service/jobService.js';
import auditProgressService from '../modules/jobs/service/auditProgressService.js';
import { LoggerUtil } from '../utils/LoggerUtil.js';
import {
  getGoogleAdsCampaignsForSync,
  getGoogleAdsDailyCampaignMetrics,
  getGoogleAdsKeywordsForSync,
  getGoogleAdsSearchTermsForSync,
  getGoogleAdsOptimizationScore,
  getGoogleAdsRecommendationsForSync,
  getGoogleAdsDevicePerformanceForSync,
  getGoogleAdsGeoPerformanceForSync,
  getGoogleAdsDemographicPerformanceForSync,
  getGoogleAdsAudienceSegmentPerformanceForSync,
  getGoogleAdsAdsForSync,
  getGoogleAdsConversionActionsForSync,
  clearCacheForGoogleAdsConnection
} from './googleAdsService.js';
import { generateBudgetAlerts } from './googleAdsBudgetService.js';
import { computeAndPersistCapabilities } from './googleAdsCapabilityService.js';

/**
 * Google Ads Sync Orchestrator (Phase 6.3 campaign metrics + Phase 6.4
 * keywords/search terms/optimization score/recommendations)
 *
 * Node-self-processed job runner, structured to mirror
 * chainingEngine.js's _runProjectTaskVerificationJob exactly: 'processing'
 * -> do the work -> 'completed', or on failure jobService.failJob() (which
 * decides retry-vs-terminal via the existing getRetryBackoffMs schedule) -
 * no second queue, no second retry mechanism, no new websocket transport.
 * The only reason this isn't IN chainingEngine.js itself is that
 * GOOGLE_ADS_SYNC has no PIPELINE_CONFIG entry (it's never created as the
 * "next job" after another job completes - always created directly by
 * googleAdsController's refresh endpoint), so it never needs
 * chainingEngine's declarative dispatch-map machinery.
 *
 * Sync strategy (Phase 2 - Enterprise Historical Sync):
 * - HISTORICAL sync (google_ads_history_synced_at not yet set on the
 *   connection): backfill daily metrics + device performance from the
 *   earliest campaign's start date through today (capped at
 *   HISTORICAL_MAX_LOOKBACK_DAYS), fetched/upserted in
 *   HISTORICAL_CHUNK_DAYS-sized chunks (see runChunkedSync). This becomes
 *   the permanent analytics database range=all reads against - the
 *   dashboard should never be empty for an account with real history just
 *   because it has no spend in the last 30 days.
 * - INCREMENTAL sync (every run after the first successful historical one):
 *   re-fetch only a trailing INCREMENTAL_RECONCILE_DAYS window (unchanged
 *   from before this phase). Google Ads conversion data can be attributed
 *   retroactively for several days after a click, so a fixed reconciliation
 *   window - not just "since last sync" - is what keeps recent conversion
 *   counts accurate without ever touching (or re-fetching) older, already-
 *   finalized daily rows. bulkUpsertDailyMetrics/bulkUpsertDaily are pure
 *   upserts keyed by (project, campaign|device, date) - a re-synced day
 *   overwrites that day's own row, never duplicates it and never touches
 *   any other day, so historical rows already backfilled are never lost or
 *   corrupted by a later incremental run.
 * - Weekly/monthly snapshots are always recomputed from OUR already-synced
 *   GoogleAdsCampaignMetrics rows for every period the just-synced window
 *   touches (never fetched from Google a second time) - upserted by period
 *   key, so only the touched periods' rows change; every other period is
 *   left exactly as it was.
 *
 * Phase 6.4 additions:
 * - Search terms and optimization score are folded into runGoogleAdsSync as
 *   two more stages (same job, same window) rather than getting their own
 *   job type - neither was given its own dedicated refresh endpoint in the
 *   Phase 6.4 API Endpoints list, so they piggyback on the endpoint that
 *   already exists ("Refresh Campaign Metrics").
 * - Keywords and Recommendations DO get their own standalone orchestrators
 *   (runGoogleAdsKeywordSync, runGoogleAdsRecommendationSync) and their own
 *   job types (GOOGLE_ADS_KEYWORD_SYNC, GOOGLE_ADS_RECOMMENDATION_SYNC),
 *   since both have their own dedicated refresh endpoints and independent
 *   reasons to run without a full campaign resync (keyword lists can be
 *   large; recommendations change based on actions taken directly in the
 *   Google Ads UI).
 *
 * Phase 6.5 additions (device/geo/audience/ad/attribution performance +
 * budget alerts + capability matrix): same reasoning as search terms/
 * optimization score above - none of these has its own dedicated refresh
 * endpoint in the Phase 6.5 API Endpoints list, so all six fold into this
 * same job as further stages rather than six more job types. Each of these
 * six stages is wrapped in its own try/catch and logged as a WARNING (not
 * fatal) on failure - they are enrichment on top of the core campaign+
 * metrics sync, and a permission/quota error on, say, the geo query must
 * not fail campaigns/metrics/keywords that already succeeded ("Partial
 * Failures" handling). The job timeout was raised from 5 to 10 minutes to
 * match the added Google API call volume (see jobTypes.js).
 */

const SERVICE = 'GoogleAdsSync';
const INCREMENTAL_RECONCILE_DAYS = 7;
// Phase 2 (Enterprise Historical Sync). A HISTORICAL sync (no prior
// google_ads_history_synced_at on the connection) backfills from the
// earliest campaign start date through today, instead of a fixed 30-day
// window - this is what makes range=all / 12m meaningful instead of
// perpetually empty for accounts with real history but no recent spend.
// HISTORICAL_MAX_LOOKBACK_DAYS is a safety ceiling, not a target: it only
// bites when NO campaign has a discoverable start date (never observed in
// practice, but GAQL's start_date_time is technically optional), so a
// single malformed/missing date can never turn into an unbounded query.
const HISTORICAL_MAX_LOOKBACK_DAYS = 1095; // ~3 years
// The historical window is fetched in HISTORICAL_CHUNK_DAYS-sized slices
// (oldest first), each fetched + upserted + logged independently, instead
// of one multi-year GAQL call: bounds per-request Google API payload size
// and Node memory, and means a transient failure partway through a 3-year
// backfill only loses one quarter's progress, not the whole run (already-
// upserted chunks stay in Mongo - re-running the job just re-covers the
// same idempotent upsert, never duplicates). An INCREMENTAL sync's 7-day
// window is always smaller than one chunk, so chunkDateRange() below
// naturally collapses it to exactly one chunk - identical to a single
// unchunked call, zero behavior change for the existing incremental path.
const HISTORICAL_CHUNK_DAYS = 90;
// Unchanged from before Phase 2 - GOOGLE_ADS_KEYWORD_SYNC (a separate job/
// button/domain from the campaign metrics sync above) stays on its
// original fixed-window behavior. GoogleAdsKeyword rows are a current-state
// snapshot per keyword (upserted by identity, tagged with the date_range
// the last sync covered), not a daily time series like
// GoogleAdsCampaignMetrics - there is no per-day history to backfill, so
// the historical-vs-incremental redesign above does not apply here. See
// computeSyncWindow's own doc comment.
const KEYWORD_FULL_SYNC_LOOKBACK_DAYS = 30;

const jobService = new JobService();

// ─────────────────────────────────────────────────────────────────────────
// Date helpers (all UTC-based, deterministic)
// ─────────────────────────────────────────────────────────────────────────

function utcMidnight(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function getWeekStart(date) {
  const d = utcMidnight(date);
  const day = d.getUTCDay(); // 0 = Sunday ... 6 = Saturday
  const diffToMonday = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diffToMonday);
  return d;
}

function getWeekEnd(weekStart) {
  const d = new Date(weekStart);
  d.setUTCDate(d.getUTCDate() + 6);
  return d;
}

function getMonthStart(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function getMonthEnd(monthStart) {
  return new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 0));
}

/** Every distinct weekly or monthly period touched by [startDate, endDate], inclusive. */
function collectPeriods(startDate, endDate, periodType) {
  const periods = new Map();
  const cursor = new Date(startDate);
  while (cursor <= endDate) {
    const periodStart = periodType === 'weekly' ? getWeekStart(cursor) : getMonthStart(cursor);
    const key = periodStart.toISOString();
    if (!periods.has(key)) {
      const periodEnd = periodType === 'weekly' ? getWeekEnd(periodStart) : getMonthEnd(periodStart);
      periods.set(key, { periodStart, periodEnd });
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return Array.from(periods.values());
}

/**
 * Earliest usable campaign start date across a just-fetched campaign list,
 * clamped to HISTORICAL_MAX_LOOKBACK_DAYS. `campaign.startDate` is already a
 * plain 'YYYY-MM-DD' string here (see googleAdsService.js's mapCampaignRow /
 * extractDateOnly - v24's start_date_time sliced to the date portion), so no
 * further GAQL-shape handling is needed at this layer.
 */
function determineHistoricalStartDate(campaigns, today) {
  const floor = new Date(today);
  floor.setUTCDate(floor.getUTCDate() - (HISTORICAL_MAX_LOOKBACK_DAYS - 1));

  const starts = (campaigns || [])
    .map((c) => c.startDate)
    .filter(Boolean)
    .map((d) => new Date(`${d}T00:00:00.000Z`))
    .filter((d) => !Number.isNaN(d.getTime()));

  if (starts.length === 0) return floor;

  const earliest = starts.reduce((min, d) => (d < min ? d : min), starts[0]);
  return earliest < floor ? floor : earliest;
}

/**
 * Decides the sync type and date window for this run (Phase 2: Enterprise
 * Historical Sync).
 *
 * HISTORICAL (google_ads_history_synced_at not yet set on the connection):
 * backfill everything from the earliest campaign's start date through
 * today - this is the one-time "become the permanent analytics database"
 * run. Requires the just-fetched campaign list (for their start dates),
 * which is why this is now called AFTER getGoogleAdsCampaignsForSync in
 * runGoogleAdsSync, not before it as the old computeSyncWindow was.
 *
 * INCREMENTAL (every run after the first successful historical one): same
 * fixed INCREMENTAL_RECONCILE_DAYS trailing window as before - Google Ads
 * conversion data can be attributed retroactively for several days after a
 * click, so re-fetching a small trailing window (not just "since last
 * sync") is what keeps recent conversion counts accurate without ever
 * re-touching older, already-finalized daily rows.
 */
function computeHistoricalSyncWindow(googleConnection, campaigns) {
  const today = utcMidnight(new Date());
  const isHistorical = !googleConnection.google_ads_history_synced_at;

  if (isHistorical) {
    const startDate = determineHistoricalStartDate(campaigns, today);
    return { startDate, endDate: today, syncType: 'historical', isHistorical: true };
  }

  const startDate = new Date(today);
  startDate.setUTCDate(startDate.getUTCDate() - (INCREMENTAL_RECONCILE_DAYS - 1));
  return { startDate, endDate: today, syncType: 'incremental', isHistorical: false };
}

/**
 * Original fixed-window sync logic, kept verbatim for
 * runGoogleAdsKeywordSync (GOOGLE_ADS_KEYWORD_SYNC) - see
 * KEYWORD_FULL_SYNC_LOOKBACK_DAYS's doc comment for why keyword sync did
 * NOT move to the historical/incremental model above.
 */
function computeSyncWindow(lastCompletedAt) {
  const today = utcMidnight(new Date());
  const isFullSync = !lastCompletedAt;
  const lookbackDays = isFullSync ? KEYWORD_FULL_SYNC_LOOKBACK_DAYS : INCREMENTAL_RECONCILE_DAYS;

  const startDate = new Date(today);
  startDate.setUTCDate(startDate.getUTCDate() - (lookbackDays - 1));

  return { startDate, endDate: today, syncType: isFullSync ? 'full' : 'incremental' };
}

/**
 * Splits [startDate, endDate] into consecutive chunkDays-sized windows,
 * oldest first, inclusive on both ends. A window shorter than chunkDays
 * (e.g. every INCREMENTAL_RECONCILE_DAYS run) naturally collapses to a
 * single chunk.
 */
function chunkDateRange(startDate, endDate, chunkDays) {
  const chunks = [];
  let cursor = new Date(startDate);
  while (cursor <= endDate) {
    const chunkEnd = new Date(cursor);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + (chunkDays - 1));
    const boundedEnd = chunkEnd > endDate ? new Date(endDate) : chunkEnd;
    chunks.push({ start: new Date(cursor), end: boundedEnd });
    cursor = new Date(boundedEnd);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return chunks;
}

/**
 * Generic chunked fetch-normalize-upsert runner, shared by the daily
 * campaign metrics and device performance stages (the two truly per-day,
 * unboundedly-scaling-with-date-range fetches in this sync) - one
 * implementation instead of two copies of the same chunking loop. Logs
 * fetch/upsert timing and row counts per chunk (sync duration, records
 * processed, API response times - the observability this phase asks for),
 * and emits a progress event per chunk so a multi-year historical backfill
 * still shows real incremental progress instead of sitting at one fixed
 * percentage for minutes.
 *
 * @param {Function} fetchNormalized - (start, end) => Promise<Array> of
 *   ALREADY-NORMALIZED rows (caller's responsibility - keeps this helper
 *   agnostic of either domain's row shape)
 * @param {Function} upsert - (normalizedRows) => Promise<{inserted, updated}>
 */
async function runChunkedSync({ label, startDate, endDate, jobId, projectId, fetchNormalized, upsert }) {
  const chunks = chunkDateRange(startDate, endDate, HISTORICAL_CHUNK_DAYS);
  const totals = { inserted: 0, updated: 0, rows: 0, chunkCount: chunks.length };

  for (let i = 0; i < chunks.length; i++) {
    const { start, end } = chunks[i];
    const windowLabel = `${start.toISOString().slice(0, 10)}..${end.toISOString().slice(0, 10)}`;

    const fetchStartedAt = Date.now();
    const rows = await fetchNormalized(start, end);
    const fetchMs = Date.now() - fetchStartedAt;

    const upsertStartedAt = Date.now();
    const result = await upsert(rows);
    const upsertMs = Date.now() - upsertStartedAt;

    totals.inserted += result.inserted || 0;
    totals.updated += result.updated || 0;
    totals.rows += rows.length;

    LoggerUtil.info(`${SERVICE}: ${label} chunk synced`, {
      jobId, projectId, chunk: `${i + 1}/${chunks.length}`, window: windowLabel,
      rowCount: rows.length, inserted: result.inserted || 0, updated: result.updated || 0,
      fetchMs, upsertMs
    });
  }

  return totals;
}

// ─────────────────────────────────────────────────────────────────────────
// Normalization
// ─────────────────────────────────────────────────────────────────────────

/**
 * Converts one already-enum-decoded GAQL metrics row (campaign.id,
 * segments.date, metrics.*) into the flat shape
 * GoogleAdsCampaignMetrics.bulkUpsertDailyMetrics expects, computing every
 * rate metric from this row's own raw counts.
 */
function normalizeDailyMetricRow(row, projectId, customerId) {
  const impressions = row.metrics?.impressions || 0;
  const clicks = row.metrics?.clicks || 0;
  const costMicros = row.metrics?.cost_micros || 0;
  const cost = costMicros / 1_000_000;
  const conversions = row.metrics?.conversions || 0;
  const conversionsValue = row.metrics?.conversions_value || 0;

  return {
    projectId,
    customerId,
    campaignId: String(row.campaign.id),
    date: new Date(`${row.segments.date}T00:00:00.000Z`),
    impressions,
    clicks,
    costMicros,
    cost,
    conversions,
    conversionsValue,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
    avgCpc: clicks > 0 ? cost / clicks : 0,
    costPerConversion: conversions > 0 ? cost / conversions : 0,
    roas: cost > 0 ? conversionsValue / cost : 0
  };
}

/**
 * googleAdsService.getGoogleAdsSearchTermsForSync already returns fully
 * normalized rows (metrics computed, enums decoded, suggestedAction
 * computed) - this just adds the date_range this sync run covered and maps
 * field names onto what GoogleAdsSearchTerm.bulkUpsertSearchTerms expects.
 */
function normalizeSearchTermRow(row, startDate, endDate) {
  return {
    campaignId: row.campaignId,
    campaignName: row.campaignName,
    adGroupId: row.adGroupId,
    adGroupName: row.adGroupName,
    searchTerm: row.searchTerm,
    targetingStatus: row.targetingStatus,
    suggestedAction: row.suggestedAction,
    metrics: row.metrics,
    dateRangeStart: startDate,
    dateRangeEnd: endDate
  };
}

/**
 * Recomputes account-level weekly + monthly snapshots for every period the
 * [startDate, endDate] window touches, reading exclusively from
 * GoogleAdsCampaignMetrics (zero additional Google API calls). Per-campaign
 * snapshots are out of scope for this phase - "Campaign Details" reads the
 * daily grain directly (GoogleAdsCampaignMetrics.getCampaignSeries).
 */
async function generateAccountSnapshots(projectId, customerId, startDate, endDate) {
  const today = utcMidnight(new Date());
  const rows = [];

  for (const periodType of ['weekly', 'monthly']) {
    const periods = collectPeriods(startDate, endDate, periodType);
    for (const { periodStart, periodEnd } of periods) {
      const clampedEnd = periodEnd > today ? today : periodEnd;
      const totals = await GoogleAdsCampaignMetrics.getAccountAggregate(projectId, customerId, periodStart, clampedEnd);

      rows.push({
        projectId,
        customerId,
        campaignId: null,
        periodType,
        periodStart,
        periodEnd,
        impressions: totals.impressions,
        clicks: totals.clicks,
        costMicros: totals.costMicros,
        cost: totals.cost,
        conversions: totals.conversions,
        conversionsValue: totals.conversionsValue,
        ctr: totals.ctr,
        avgCpc: totals.avgCpc,
        costPerConversion: totals.costPerConversion,
        roas: totals.roas
      });
    }
  }

  return GoogleAdsCampaignSnapshot.bulkUpsertSnapshots(rows);
}

// ─────────────────────────────────────────────────────────────────────────
// Main orchestrator
// ─────────────────────────────────────────────────────────────────────────

/**
 * Runs one Google Ads campaign sync for a job created by
 * jobService.createAndDispatchGoogleAdsSyncJob. Always called directly by
 * the caller that created the job (never dispatched to a worker) - see the
 * file-level doc comment for why this mirrors
 * chainingEngine._runProjectTaskVerificationJob's shape without living
 * inside chainingEngine.js itself.
 *
 * @param {Object} job - a Job document with jobType GOOGLE_ADS_SYNC
 * @returns {Promise<Object|null>} the final Job document (completed/retrying/failed), or null if job bookkeeping itself failed
 */
export async function runGoogleAdsSync(job) {
  const jobId = job._id.toString();
  const projectId = job.project_id.toString();
  const { connectionId, customerId } = job.input_data || {};
  const startedAt = Date.now();

  const stats = {
    campaignsInserted: 0, campaignsUpdated: 0, campaignsRemoved: 0, metricsInserted: 0, metricsUpdated: 0, metricsChunks: 0,
    searchTermsUpserted: 0, optimizationScoreSynced: false,
    devicePerformanceUpserted: 0, geoPerformanceUpserted: 0, audiencePerformanceUpserted: 0,
    adsUpserted: 0, conversionActionsUpserted: 0, budgetAlertsGenerated: 0
  };

  if (!connectionId || !customerId) {
    return failSync(job, new Error('GOOGLE_ADS_SYNC job is missing connectionId/customerId in input_data'), stats, startedAt, projectId, null);
  }

  try {
    await jobService.updateJobStatus(job._id, 'processing', {
      started_at: new Date(),
      last_attempted_at: new Date(),
      // Node-self-processed jobs never go through the normal claim flow, so
      // claimed_at was previously never set here - which meant a hung/
      // crashed sync (Node process dies mid-await, no exception ever
      // thrown) could never be reclaimed: staleLockScheduler's existing
      // 5-minute sweep (cleanupStaleLocks) already resets ANY jobType stuck
      // in 'processing' past LOCK_TIMEOUT_MS, but only ever matched jobs
      // that had a claimed_at to compare against. Setting it here is enough
      // to make that already-running, jobType-agnostic sweep cover this job
      // type too - no new sweep needed.
      claimed_at: new Date()
    });

    const googleConnection = await GoogleConnection.findById(connectionId);
    if (!googleConnection || googleConnection.status !== 'active') {
      throw new Error('Google Ads connection is not active - reconnect Google Ads and try again');
    }

    await GoogleConnection.findByIdAndUpdate(connectionId, { $set: { google_ads_last_sync_started_at: new Date() } });

    // ── Stage: fetching_campaigns ──────────────────────────────────────
    // Moved ahead of the sync-window computation (Phase 2): a HISTORICAL
    // window needs the campaigns' own start dates to know how far back to
    // backfill, so campaign metadata must be fetched first now.
    auditProgressService.emitGoogleAdsSyncProgress({ jobId, projectId, customerId, stage: 'fetching_campaigns', progress: 5 });
    const campaigns = await getGoogleAdsCampaignsForSync(googleConnection);
    LoggerUtil.info(`${SERVICE}: campaign metadata fetched`, { jobId, projectId, campaignCount: campaigns.length });

    const { startDate, endDate, syncType, isHistorical } = computeHistoricalSyncWindow(googleConnection, campaigns);
    const windowLabel = `${startDate.toISOString().slice(0, 10)}..${endDate.toISOString().slice(0, 10)}`;

    auditProgressService.emitGoogleAdsSyncStarted({ jobId, projectId, customerId, syncType });
    LoggerUtil.service(SERVICE, 'sync', 'started', {
      jobId, projectId, customerId, syncType, window: windowLabel,
      windowDays: Math.round((endDate - startDate) / (24 * 60 * 60 * 1000)) + 1
    });

    // ── Stage: updating_database (campaign metadata) ────────────────────
    auditProgressService.emitGoogleAdsSyncProgress({ jobId, projectId, customerId, stage: 'updating_database', progress: 12 });
    const campaignResult = await GoogleAdsCampaign.bulkUpsertCampaigns(campaigns, googleConnection.user_id, projectId, customerId);
    stats.campaignsInserted = campaignResult.inserted;
    stats.campaignsUpdated = campaignResult.updated;
    stats.campaignsRemoved = await GoogleAdsCampaign.markMissingAsRemoved(projectId, customerId, campaigns.map((c) => c.campaignId));

    // ── Stage: fetching_metrics (chunked for HISTORICAL windows) ─────────
    auditProgressService.emitGoogleAdsSyncProgress({ jobId, projectId, customerId, stage: 'fetching_metrics', progress: 20 });
    const metricsStartedAt = Date.now();
    const metricsResult = await runChunkedSync({
      label: 'daily metrics',
      startDate, endDate, jobId, projectId,
      fetchNormalized: async (start, end) => {
        const rows = await getGoogleAdsDailyCampaignMetrics(googleConnection, start, end);
        return rows.map((row) => normalizeDailyMetricRow(row, projectId, customerId));
      },
      upsert: (rows) => GoogleAdsCampaignMetrics.bulkUpsertDailyMetrics(rows)
    });
    stats.metricsInserted = metricsResult.inserted;
    stats.metricsUpdated = metricsResult.updated;
    stats.metricsChunks = metricsResult.chunkCount;
    LoggerUtil.service(SERVICE, 'fetching_metrics', 'completed', {
      jobId, projectId, window: windowLabel, chunks: metricsResult.chunkCount, rowCount: metricsResult.rows,
      inserted: metricsResult.inserted, updated: metricsResult.updated, durationMs: Date.now() - metricsStartedAt
    });
    auditProgressService.emitGoogleAdsSyncProgress({ jobId, projectId, customerId, stage: 'updating_database', progress: 70 });

    // ── Stage: fetching_search_terms (Phase 6.4) ─────────────────────────
    auditProgressService.emitGoogleAdsSyncProgress({ jobId, projectId, customerId, stage: 'fetching_search_terms', progress: 75 });
    const searchTermRows = await getGoogleAdsSearchTermsForSync(googleConnection, startDate, endDate);
    const normalizedSearchTerms = searchTermRows.map((row) => normalizeSearchTermRow(row, startDate, endDate));
    const searchTermResult = await GoogleAdsSearchTerm.bulkUpsertSearchTerms(normalizedSearchTerms, googleConnection.user_id, projectId, customerId);
    stats.searchTermsUpserted = (searchTermResult.inserted || 0) + (searchTermResult.updated || 0);
    LoggerUtil.info(`${SERVICE}: search terms synced`, { jobId, projectId, count: searchTermRows.length });

    // ── Stage: fetching_optimization_score (Phase 6.4) ───────────────────
    auditProgressService.emitGoogleAdsSyncProgress({ jobId, projectId, customerId, stage: 'fetching_optimization_score', progress: 45 });
    try {
      const { optimizationScore, optimizationScoreWeight } = await getGoogleAdsOptimizationScore(googleConnection);
      await GoogleAdsOptimizationHistory.upsertScore(projectId, customerId, utcMidnight(new Date()), optimizationScore, optimizationScoreWeight);
      stats.optimizationScoreSynced = true;
    } catch (optError) {
      // Non-fatal: the rest of the sync (campaigns/metrics/search terms) is
      // still valuable even if the account has no optimization score yet
      // (brand-new accounts) or the call itself fails transiently.
      LoggerUtil.warn(`${SERVICE}: optimization score sync failed (non-fatal)`, { jobId, projectId, message: optError.message });
    }

    // ── Stage: fetching_device_performance (Phase 6.5, chunked since Phase 2) ─
    auditProgressService.emitGoogleAdsSyncProgress({ jobId, projectId, customerId, stage: 'fetching_device_performance', progress: 72 });
    try {
      const deviceStartedAt = Date.now();
      const deviceResult = await runChunkedSync({
        label: 'device performance',
        startDate, endDate, jobId, projectId,
        fetchNormalized: async (start, end) => {
          const rows = await getGoogleAdsDevicePerformanceForSync(googleConnection, start, end);
          return rows.map((row) => ({
            projectId, customerId, device: row.device, date: new Date(`${row.date}T00:00:00.000Z`),
            impressions: row.metrics.impressions, clicks: row.metrics.clicks, costMicros: row.metrics.cost_micros, cost: row.metrics.cost,
            conversions: row.metrics.conversions, conversionsValue: row.metrics.conversions_value, ctr: row.metrics.ctr,
            avgCpc: row.metrics.avg_cpc, roas: row.metrics.cost > 0 ? row.metrics.conversions_value / row.metrics.cost : 0
          }));
        },
        upsert: (rows) => GoogleAdsDevicePerformance.bulkUpsertDaily(rows)
      });
      stats.devicePerformanceUpserted = deviceResult.inserted + deviceResult.updated;
      LoggerUtil.service(SERVICE, 'fetching_device_performance', 'completed', {
        jobId, projectId, chunks: deviceResult.chunkCount, rowCount: deviceResult.rows, durationMs: Date.now() - deviceStartedAt
      });
    } catch (deviceError) {
      LoggerUtil.warn(`${SERVICE}: device performance sync failed (non-fatal)`, { jobId, projectId, message: deviceError.message });
    }

    // ── Stage: fetching_geo_performance (Phase 6.5) ──────────────────────
    auditProgressService.emitGoogleAdsSyncProgress({ jobId, projectId, customerId, stage: 'fetching_geo_performance', progress: 58 });
    try {
      let geoUpserted = 0;
      for (const geoLevel of ['country', 'region', 'city']) {
        const geoRows = await getGoogleAdsGeoPerformanceForSync(googleConnection, geoLevel, startDate, endDate);
        const normalizedGeoRows = geoRows.map((row) => ({
          projectId, customerId, geoLevel: row.geoLevel, geoTargetId: row.geoTargetId, name: row.name, countryCode: row.countryCode,
          metrics: row.metrics, dateRangeStart: startDate, dateRangeEnd: endDate
        }));
        const geoResult = await GoogleAdsGeoPerformance.bulkUpsertGeoPerformance(normalizedGeoRows, googleConnection.user_id, projectId, customerId);
        geoUpserted += (geoResult.inserted || 0) + (geoResult.updated || 0);
      }
      stats.geoPerformanceUpserted = geoUpserted;
    } catch (geoError) {
      LoggerUtil.warn(`${SERVICE}: geo performance sync failed (non-fatal)`, { jobId, projectId, message: geoError.message });
    }

    // ── Stage: fetching_audience_performance (Phase 6.5) ─────────────────
    auditProgressService.emitGoogleAdsSyncProgress({ jobId, projectId, customerId, stage: 'fetching_audience_performance', progress: 66 });
    try {
      let audienceUpserted = 0;
      for (const dimensionType of ['age', 'gender', 'household_income']) {
        const rows = await getGoogleAdsDemographicPerformanceForSync(googleConnection, dimensionType, startDate, endDate);
        const normalized = rows.map((row) => ({ ...row, dateRangeStart: startDate, dateRangeEnd: endDate }));
        const result = await GoogleAdsAudiencePerformance.bulkUpsertAudiencePerformance(normalized, googleConnection.user_id, projectId, customerId);
        audienceUpserted += (result.inserted || 0) + (result.updated || 0);
      }
      for (const dimensionType of ['affinity', 'in_market', 'audience_segment']) {
        const rows = await getGoogleAdsAudienceSegmentPerformanceForSync(googleConnection, dimensionType, startDate, endDate);
        const normalized = rows.map((row) => ({ ...row, dateRangeStart: startDate, dateRangeEnd: endDate }));
        const result = await GoogleAdsAudiencePerformance.bulkUpsertAudiencePerformance(normalized, googleConnection.user_id, projectId, customerId);
        audienceUpserted += (result.inserted || 0) + (result.updated || 0);
      }
      stats.audiencePerformanceUpserted = audienceUpserted;
    } catch (audienceError) {
      LoggerUtil.warn(`${SERVICE}: audience performance sync failed (non-fatal)`, { jobId, projectId, message: audienceError.message });
    }

    // ── Stage: fetching_ad_performance (Phase 6.5) ───────────────────────
    auditProgressService.emitGoogleAdsSyncProgress({ jobId, projectId, customerId, stage: 'fetching_ad_performance', progress: 74 });
    try {
      const adRows = await getGoogleAdsAdsForSync(googleConnection, startDate, endDate);
      const normalizedAds = adRows.map((row) => ({ ...row, dateRangeStart: startDate, dateRangeEnd: endDate }));
      const adResult = await GoogleAdsAd.bulkUpsertAds(normalizedAds, googleConnection.user_id, projectId, customerId);
      await GoogleAdsAd.markMissingAsRemoved(projectId, customerId, adRows.map((a) => `${a.adGroupId}:${a.adId}`));
      stats.adsUpserted = (adResult.inserted || 0) + (adResult.updated || 0);
    } catch (adError) {
      LoggerUtil.warn(`${SERVICE}: ad performance sync failed (non-fatal)`, { jobId, projectId, message: adError.message });
    }

    // ── Stage: fetching_attribution_data (Phase 6.5) ─────────────────────
    auditProgressService.emitGoogleAdsSyncProgress({ jobId, projectId, customerId, stage: 'fetching_attribution_data', progress: 82 });
    try {
      const conversionActionRows = await getGoogleAdsConversionActionsForSync(googleConnection, startDate, endDate);
      const normalizedActions = conversionActionRows.map((row) => ({ ...row, dateRangeStart: startDate, dateRangeEnd: endDate }));
      const caResult = await GoogleAdsConversionAction.bulkUpsertConversionActions(normalizedActions, googleConnection.user_id, projectId, customerId);
      await GoogleAdsConversionAction.markMissingAsRemoved(projectId, customerId, conversionActionRows.map((c) => c.conversionActionId));
      stats.conversionActionsUpserted = (caResult.inserted || 0) + (caResult.updated || 0);
    } catch (attributionError) {
      LoggerUtil.warn(`${SERVICE}: attribution data sync failed (non-fatal)`, { jobId, projectId, message: attributionError.message });
    }

    // ── Stage: generating_budget_alerts (Phase 6.5) ──────────────────────
    auditProgressService.emitGoogleAdsSyncProgress({ jobId, projectId, customerId, stage: 'generating_budget_alerts', progress: 88 });
    try {
      const activeAlerts = await generateBudgetAlerts(projectId, customerId);
      const alertResult = await GoogleAdsBudgetAlert.reconcileAlerts(projectId, customerId, activeAlerts);
      stats.budgetAlertsGenerated = alertResult.active;
    } catch (alertError) {
      LoggerUtil.warn(`${SERVICE}: budget alert generation failed (non-fatal)`, { jobId, projectId, message: alertError.message });
    }

    // ── Stage: generating_aggregates (weekly/monthly rollups) ────────────
    auditProgressService.emitGoogleAdsSyncProgress({ jobId, projectId, customerId, stage: 'generating_aggregates', progress: 93 });
    await generateAccountSnapshots(projectId, customerId, startDate, endDate);

    // Capability matrix - computed last, from whatever this run actually
    // observed (see googleAdsCapabilityService.js). Non-fatal: a failure
    // here just leaves the previous matrix in place, never blocks the sync.
    try {
      await computeAndPersistCapabilities(connectionId, projectId, customerId);
    } catch (capabilityError) {
      LoggerUtil.warn(`${SERVICE}: capability matrix computation failed (non-fatal)`, { jobId, projectId, message: capabilityError.message });
    }

    // Invalidate the read-path cache so Overview/Campaign List reflect this
    // sync immediately instead of serving a stale cached response for up to
    // the remainder of the 10-minute TTL.
    clearCacheForGoogleAdsConnection(connectionId);

    const durationMs = Date.now() - startedAt;
    const completedJob = await jobService.updateJobStatus(job._id, 'completed', {
      result_data: { syncType, isHistorical, window: windowLabel, stats, durationMs }
    });

    await GoogleConnection.findByIdAndUpdate(connectionId, {
      $set: {
        google_ads_last_sync_completed_at: new Date(),
        google_ads_last_sync_duration_ms: durationMs,
        google_ads_last_sync_stats: stats,
        google_ads_last_sync_error: null,
        last_used_at: new Date(),
        // One-way flag - see its schema doc comment. Only ever set here, on
        // a HISTORICAL run's success; an incremental run's $set simply omits
        // it, leaving whatever value (or null) is already there untouched.
        ...(isHistorical ? { google_ads_history_synced_at: new Date() } : {})
      }
    });

    auditProgressService.emitGoogleAdsSyncCompleted({ jobId, projectId, customerId, stats });
    LoggerUtil.service(SERVICE, 'sync', 'completed', {
      jobId, projectId, customerId, syncType, isHistorical, durationMs,
      metricsChunks: stats.metricsChunks, stats
    });

    return completedJob;
  } catch (error) {
    return failSync(job, error, stats, startedAt, projectId, customerId, connectionId);
  }
}

/**
 * Shared failure path: records partial stats + the error on GoogleConnection
 * (best-effort, "Partial Failures" support), routes the Job itself through
 * jobService.failJob (the existing retry/backoff mechanism - unmodified),
 * and emits google_ads_sync:failed. See the "retrying" branch's comment for
 * the one known limitation this phase ships with.
 */
async function failSync(job, error, stats, startedAt, projectId, customerId, connectionId) {
  const jobId = job._id.toString();
  const durationMs = Date.now() - startedAt;

  LoggerUtil.error(`${SERVICE}: sync failed`, error, { jobId, projectId, customerId, stats, durationMs });

  if (connectionId) {
    try {
      await GoogleConnection.findByIdAndUpdate(connectionId, {
        $set: {
          google_ads_last_sync_failed_at: new Date(),
          google_ads_last_sync_duration_ms: durationMs,
          google_ads_last_sync_stats: stats,
          google_ads_last_sync_error: error.message
        }
      });
    } catch (bookkeepingError) {
      LoggerUtil.error(`${SERVICE}: failed to record sync failure on GoogleConnection`, bookkeepingError, { jobId });
    }
  }

  let failedJob = null;
  try {
    failedJob = await jobService.failJob(job._id, error, { result_data: { stats, durationMs } });
  } catch (failError) {
    LoggerUtil.error(`${SERVICE}: failJob bookkeeping failed`, failError, { jobId });
  }

  if (failedJob?.status === 'retrying') {
    // Should never actually happen: JOB_TYPE_CONFIG[GOOGLE_ADS_SYNC/
    // KEYWORD_SYNC/RECOMMENDATION_SYNC].maxAttempts is 1, so
    // jobService.failJob's own shouldRetry check (newAttempts < max_attempts)
    // always goes straight to terminal 'failed' for these job types. That
    // maxAttempts value is load-bearing, not arbitrary - a prior version had
    // maxAttempts:3, and since nothing (unlike PROJECT_TASK_VERIFICATION's
    // verificationBatchRecoveryService sweep) ever reclaims a job left in
    // 'retrying' for these Node-self-processed job types, every failed sync
    // left a permanently-stuck 'retrying' row - and GET /sync-status treats
    // 'retrying' as "in flight", so the Google Ads page never exited its
    // loading state again for that project, even after a later sync
    // succeeded. If you're bumping maxAttempts back up, a real reclaim sweep
    // needs to come with it (see jobTypes.js's comment on GOOGLE_ADS_SYNC).
    LoggerUtil.warn(`${SERVICE}: attempt failed but job unexpectedly left in 'retrying' - it will not be auto-reclaimed`, {
      jobId, attempts: failedJob.attempts, maxAttempts: failedJob.max_attempts
    });
  }

  auditProgressService.emitGoogleAdsSyncFailed({ jobId, projectId, customerId, errorMessage: error.message });

  return failedJob;
}

// ─────────────────────────────────────────────────────────────────────────
// Keyword sync (Phase 6.4) - own job type, own GoogleConnection bookkeeping
// fields, same overall shape as runGoogleAdsSync/failSync above.
// ─────────────────────────────────────────────────────────────────────────

/** googleAdsService.getGoogleAdsKeywordsForSync already returns normalized fields; just maps names onto GoogleAdsKeyword.bulkUpsertKeywords' expected shape. */
function normalizeKeywordRow(row, startDate, endDate) {
  return {
    adGroupId: row.adGroupId,
    adGroupName: row.adGroupName,
    criterionId: row.criterionId,
    campaignId: row.campaignId,
    campaignName: row.campaignName,
    keywordText: row.keywordText,
    matchType: row.matchType,
    status: row.status,
    qualityScore: row.qualityScore,
    metrics: row.metrics,
    dateRangeStart: startDate,
    dateRangeEnd: endDate
  };
}

/**
 * @param {Object} job - a Job document with jobType GOOGLE_ADS_KEYWORD_SYNC
 * @returns {Promise<Object|null>}
 */
export async function runGoogleAdsKeywordSync(job) {
  const jobId = job._id.toString();
  const projectId = job.project_id.toString();
  const { connectionId, customerId } = job.input_data || {};
  const startedAt = Date.now();
  const stats = { inserted: 0, updated: 0, removed: 0 };

  if (!connectionId || !customerId) {
    return failKeywordSync(job, new Error('GOOGLE_ADS_KEYWORD_SYNC job is missing connectionId/customerId in input_data'), stats, startedAt, projectId, null, null);
  }

  try {
    // claimed_at set so a hung/crashed run is covered by staleLockScheduler's
    // existing jobType-agnostic 5-minute sweep - see the identical comment
    // on runGoogleAdsSync's own 'processing' transition above.
    await jobService.updateJobStatus(job._id, 'processing', { started_at: new Date(), last_attempted_at: new Date(), claimed_at: new Date() });

    const googleConnection = await GoogleConnection.findById(connectionId);
    if (!googleConnection || googleConnection.status !== 'active') {
      throw new Error('Google Ads connection is not active - reconnect Google Ads and try again');
    }

    await GoogleConnection.findByIdAndUpdate(connectionId, { $set: { google_ads_keyword_sync_started_at: new Date() } });

    const { startDate, endDate, syncType } = computeSyncWindow(googleConnection.google_ads_keyword_sync_completed_at);
    const windowLabel = `${startDate.toISOString().slice(0, 10)}..${endDate.toISOString().slice(0, 10)}`;

    auditProgressService.emitGoogleAdsKeywordSyncStarted({ jobId, projectId, customerId });
    LoggerUtil.service(SERVICE, 'keywordSync', 'started', { jobId, projectId, customerId, syncType, window: windowLabel });

    auditProgressService.emitGoogleAdsKeywordSyncProgress({ jobId, projectId, customerId, stage: 'fetching_keywords', progress: 30 });
    const keywordRows = await getGoogleAdsKeywordsForSync(googleConnection, startDate, endDate);
    LoggerUtil.info(`${SERVICE}: keywords fetched`, { jobId, projectId, count: keywordRows.length, window: windowLabel });

    auditProgressService.emitGoogleAdsKeywordSyncProgress({ jobId, projectId, customerId, stage: 'updating_database', progress: 70 });
    const normalized = keywordRows.map((row) => normalizeKeywordRow(row, startDate, endDate));
    const upsertResult = await GoogleAdsKeyword.bulkUpsertKeywords(normalized, googleConnection.user_id, projectId, customerId);
    stats.inserted = upsertResult.inserted;
    stats.updated = upsertResult.updated;

    const seenPairs = keywordRows.map((k) => `${k.adGroupId}:${k.criterionId}`);
    stats.removed = await GoogleAdsKeyword.markMissingAsRemoved(projectId, customerId, seenPairs);

    clearCacheForGoogleAdsConnection(connectionId);

    const durationMs = Date.now() - startedAt;
    const completedJob = await jobService.updateJobStatus(job._id, 'completed', { result_data: { syncType, window: windowLabel, stats, durationMs } });

    await GoogleConnection.findByIdAndUpdate(connectionId, {
      $set: {
        google_ads_keyword_sync_completed_at: new Date(),
        google_ads_keyword_sync_duration_ms: durationMs,
        google_ads_keyword_sync_stats: stats,
        google_ads_keyword_sync_error: null,
        last_used_at: new Date()
      }
    });

    auditProgressService.emitGoogleAdsKeywordSyncCompleted({ jobId, projectId, customerId, stats });
    LoggerUtil.service(SERVICE, 'keywordSync', 'completed', { jobId, projectId, customerId, durationMs, stats });

    return completedJob;
  } catch (error) {
    return failKeywordSync(job, error, stats, startedAt, projectId, customerId, connectionId);
  }
}

async function failKeywordSync(job, error, stats, startedAt, projectId, customerId, connectionId) {
  const jobId = job._id.toString();
  const durationMs = Date.now() - startedAt;

  LoggerUtil.error(`${SERVICE}: keyword sync failed`, error, { jobId, projectId, customerId, stats, durationMs });

  if (connectionId) {
    try {
      await GoogleConnection.findByIdAndUpdate(connectionId, {
        $set: {
          google_ads_keyword_sync_failed_at: new Date(),
          google_ads_keyword_sync_duration_ms: durationMs,
          google_ads_keyword_sync_stats: stats,
          google_ads_keyword_sync_error: error.message
        }
      });
    } catch (bookkeepingError) {
      LoggerUtil.error(`${SERVICE}: failed to record keyword sync failure on GoogleConnection`, bookkeepingError, { jobId });
    }
  }

  let failedJob = null;
  try {
    failedJob = await jobService.failJob(job._id, error, { result_data: { stats, durationMs } });
  } catch (failError) {
    LoggerUtil.error(`${SERVICE}: keyword sync failJob bookkeeping failed`, failError, { jobId });
  }

  if (failedJob?.status === 'retrying') {
    LoggerUtil.warn(`${SERVICE}: keyword sync attempt failed, will not be auto-reclaimed`, {
      jobId, attempts: failedJob.attempts, maxAttempts: failedJob.max_attempts
    });
  }

  auditProgressService.emitGoogleAdsKeywordSyncFailed({ jobId, projectId, customerId, errorMessage: error.message });

  return failedJob;
}

// ─────────────────────────────────────────────────────────────────────────
// Recommendation sync (Phase 6.4) - own job type. Unlike the other syncs,
// this is not date-windowed (recommendations have no history dimension in
// this phase) - every run fetches the account's current recommendation
// list in full (it's a small, bounded resource, not a reporting table).
// ─────────────────────────────────────────────────────────────────────────

/**
 * @param {Object} job - a Job document with jobType GOOGLE_ADS_RECOMMENDATION_SYNC
 * @returns {Promise<Object|null>}
 */
export async function runGoogleAdsRecommendationSync(job) {
  const jobId = job._id.toString();
  const projectId = job.project_id.toString();
  const { connectionId, customerId } = job.input_data || {};
  const startedAt = Date.now();
  const stats = { inserted: 0, updated: 0, resolved: 0 };

  if (!connectionId || !customerId) {
    return failRecommendationSync(job, new Error('GOOGLE_ADS_RECOMMENDATION_SYNC job is missing connectionId/customerId in input_data'), stats, startedAt, projectId, null, null);
  }

  try {
    // claimed_at set so a hung/crashed run is covered by staleLockScheduler's
    // existing jobType-agnostic 5-minute sweep - see the identical comment
    // on runGoogleAdsSync's own 'processing' transition above.
    await jobService.updateJobStatus(job._id, 'processing', { started_at: new Date(), last_attempted_at: new Date(), claimed_at: new Date() });

    const googleConnection = await GoogleConnection.findById(connectionId);
    if (!googleConnection || googleConnection.status !== 'active') {
      throw new Error('Google Ads connection is not active - reconnect Google Ads and try again');
    }

    await GoogleConnection.findByIdAndUpdate(connectionId, { $set: { google_ads_recommendation_sync_started_at: new Date() } });

    auditProgressService.emitGoogleAdsRecommendationSyncStarted({ jobId, projectId, customerId });
    LoggerUtil.service(SERVICE, 'recommendationSync', 'started', { jobId, projectId, customerId });

    auditProgressService.emitGoogleAdsRecommendationSyncProgress({ jobId, projectId, customerId, stage: 'fetching_recommendations', progress: 30 });
    const recommendationRows = await getGoogleAdsRecommendationsForSync(googleConnection);
    LoggerUtil.info(`${SERVICE}: recommendations fetched`, { jobId, projectId, count: recommendationRows.length });

    // Resolve campaign_name from the already-synced GoogleAdsCampaign
    // collection (the raw fetch only has campaign_id - see
    // getGoogleAdsRecommendationsForSync's doc comment) rather than a
    // second Google API call.
    const campaignIds = [...new Set(recommendationRows.map((r) => r.campaignId).filter(Boolean))];
    const campaignNameById = new Map();
    if (campaignIds.length) {
      const campaignDocs = await GoogleAdsCampaign.find(
        { project_id: projectId, google_ads_customer_id: customerId, campaign_id: { $in: campaignIds } },
        { campaign_id: 1, name: 1 }
      ).lean();
      for (const c of campaignDocs) campaignNameById.set(c.campaign_id, c.name);
    }

    auditProgressService.emitGoogleAdsRecommendationSyncProgress({ jobId, projectId, customerId, stage: 'updating_database', progress: 70 });
    const normalized = recommendationRows.map((r) => ({ ...r, campaignName: r.campaignId ? campaignNameById.get(r.campaignId) || null : null }));
    const upsertResult = await GoogleAdsRecommendation.bulkUpsertRecommendations(normalized, googleConnection.user_id, projectId, customerId);
    stats.inserted = upsertResult.inserted;
    stats.updated = upsertResult.updated;

    const seenResourceNames = recommendationRows.map((r) => r.resourceName);
    stats.resolved = await GoogleAdsRecommendation.markMissingAsResolved(projectId, customerId, seenResourceNames);

    clearCacheForGoogleAdsConnection(connectionId);

    const durationMs = Date.now() - startedAt;
    const completedJob = await jobService.updateJobStatus(job._id, 'completed', { result_data: { stats, durationMs } });

    await GoogleConnection.findByIdAndUpdate(connectionId, {
      $set: {
        google_ads_recommendation_sync_completed_at: new Date(),
        google_ads_recommendation_sync_duration_ms: durationMs,
        google_ads_recommendation_sync_stats: stats,
        google_ads_recommendation_sync_error: null,
        last_used_at: new Date()
      }
    });

    auditProgressService.emitGoogleAdsRecommendationSyncCompleted({ jobId, projectId, customerId, stats });
    LoggerUtil.service(SERVICE, 'recommendationSync', 'completed', { jobId, projectId, customerId, durationMs, stats });

    return completedJob;
  } catch (error) {
    return failRecommendationSync(job, error, stats, startedAt, projectId, customerId, connectionId);
  }
}

async function failRecommendationSync(job, error, stats, startedAt, projectId, customerId, connectionId) {
  const jobId = job._id.toString();
  const durationMs = Date.now() - startedAt;

  LoggerUtil.error(`${SERVICE}: recommendation sync failed`, error, { jobId, projectId, customerId, stats, durationMs });

  if (connectionId) {
    try {
      await GoogleConnection.findByIdAndUpdate(connectionId, {
        $set: {
          google_ads_recommendation_sync_failed_at: new Date(),
          google_ads_recommendation_sync_duration_ms: durationMs,
          google_ads_recommendation_sync_stats: stats,
          google_ads_recommendation_sync_error: error.message
        }
      });
    } catch (bookkeepingError) {
      LoggerUtil.error(`${SERVICE}: failed to record recommendation sync failure on GoogleConnection`, bookkeepingError, { jobId });
    }
  }

  let failedJob = null;
  try {
    failedJob = await jobService.failJob(job._id, error, { result_data: { stats, durationMs } });
  } catch (failError) {
    LoggerUtil.error(`${SERVICE}: recommendation sync failJob bookkeeping failed`, failError, { jobId });
  }

  if (failedJob?.status === 'retrying') {
    LoggerUtil.warn(`${SERVICE}: recommendation sync attempt failed, will not be auto-reclaimed`, {
      jobId, attempts: failedJob.attempts, maxAttempts: failedJob.max_attempts
    });
  }

  auditProgressService.emitGoogleAdsRecommendationSyncFailed({ jobId, projectId, customerId, errorMessage: error.message });

  return failedJob;
}

export default { runGoogleAdsSync, runGoogleAdsKeywordSync, runGoogleAdsRecommendationSync };
