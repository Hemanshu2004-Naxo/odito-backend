import Job from '../modules/jobs/model/Job.js';
import GoogleAdsRecommendation from '../modules/app_user/model/GoogleAdsRecommendation.js';
import GoogleAdsBudgetAlert from '../modules/app_user/model/GoogleAdsBudgetAlert.js';
import GoogleAdsCampaign from '../modules/app_user/model/GoogleAdsCampaign.js';
import GoogleAdsOptimizationHistory from '../modules/app_user/model/GoogleAdsOptimizationHistory.js';

/**
 * Google Ads Recent Activity Feed (Gap #7, frontend integration audit)
 *
 * Entirely derived from data this codebase already persists - no new
 * "activity log" collection. Five sources, each queried once (bounded by
 * `limit` and the lookback window), normalized into one common shape, then
 * merged and sorted by timestamp - the same "read already-synced data,
 * zero Google API calls" role every other Phase 6.5 read-service plays.
 *
 * Sources:
 * 1. Sync History      - completed/failed Job documents (GOOGLE_ADS_SYNC,
 *                         GOOGLE_ADS_KEYWORD_SYNC, GOOGLE_ADS_RECOMMENDATION_SYNC)
 * 2. Recommendations    - newly identified (first_synced_at) and resolved
 *                         (resolved_at) recommendations
 * 3. Budget Alerts      - newly triggered and newly resolved alerts
 * 4. Campaign Changes   - newly synced (first_synced_at) and removed
 *                         (removed_at) campaigns
 * 5. Optimization Events - day-over-day optimization score deltas large
 *                         enough to be worth surfacing
 *
 * `timestamp` is returned as a raw ISO date, not a pre-rendered "2h ago"
 * string - relative-time formatting is tied to the viewer's current clock
 * at render time, not a business-logic decision, so it's left to the
 * frontend the same way a date-formatting library would be.
 */

const DEFAULT_LOOKBACK_DAYS = 14;
const DEFAULT_LIMIT = 20;
const OPTIMIZATION_SCORE_DELTA_THRESHOLD_PCT = 3; // only surface score swings of 3+ percentage points

const SYNC_JOB_LABELS = {
  GOOGLE_ADS_SYNC: 'Campaign sync',
  GOOGLE_ADS_KEYWORD_SYNC: 'Keyword sync',
  GOOGLE_ADS_RECOMMENDATION_SYNC: 'Recommendation sync'
};

const CATEGORY_COLOR = {
  sync: '#3b82f6',        // blue
  recommendation: '#8b5cf6', // violet
  budget_alert: '#f59e0b',   // amber
  campaign: '#10b981',       // emerald
  optimization: '#14b8a6'    // teal
};

function utcMidnight(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

async function getSyncHistoryEvents(projectId, since, limit) {
  const jobs = await Job.find({
    project_id: projectId,
    jobType: { $in: Object.keys(SYNC_JOB_LABELS) },
    status: { $in: ['completed', 'failed'] },
    $or: [{ completed_at: { $gte: since } }, { failed_at: { $gte: since } }]
  }, { jobType: 1, status: 1, completed_at: 1, failed_at: 1, result_data: 1, error: 1 })
    .sort({ completed_at: -1, failed_at: -1 })
    .limit(limit)
    .lean();

  return jobs.map((job) => {
    const label = SYNC_JOB_LABELS[job.jobType] || 'Sync';
    const timestamp = job.status === 'completed' ? job.completed_at : job.failed_at;

    if (job.status === 'completed') {
      const stats = job.result_data?.stats || {};
      const statsSummary = Object.entries(stats)
        .filter(([, v]) => typeof v === 'number' && v > 0)
        .map(([k, v]) => `${v} ${k.replace(/([A-Z])/g, ' $1').toLowerCase().trim()}`)
        .slice(0, 2)
        .join(', ');
      return {
        id: `job:${job._id}`,
        type: 'sync',
        text: statsSummary ? `${label} completed - ${statsSummary}` : `${label} completed`,
        severity: 'info',
        color: CATEGORY_COLOR.sync,
        timestamp
      };
    }

    return {
      id: `job:${job._id}`,
      type: 'sync',
      text: `${label} failed - ${job.error?.message || 'unknown error'}`,
      severity: 'critical',
      color: '#ef4444',
      timestamp
    };
  }).filter((e) => e.timestamp);
}

async function getRecommendationEvents(projectId, customerId, since, limit) {
  const [newRecs, resolvedRecs] = await Promise.all([
    GoogleAdsRecommendation.find(
      { project_id: projectId, google_ads_customer_id: customerId, first_synced_at: { $gte: since } },
      { title: 1, first_synced_at: 1, priority: 1 }
    ).sort({ first_synced_at: -1 }).limit(limit).lean(),
    GoogleAdsRecommendation.find(
      { project_id: projectId, google_ads_customer_id: customerId, is_resolved: true, resolved_at: { $gte: since } },
      { title: 1, resolved_at: 1 }
    ).sort({ resolved_at: -1 }).limit(limit).lean()
  ]);

  const events = [];
  for (const rec of newRecs) {
    events.push({
      id: `rec-new:${rec._id}`,
      type: 'recommendation',
      text: `New recommendation: ${rec.title}`,
      severity: rec.priority === 'high' ? 'warning' : 'info',
      color: CATEGORY_COLOR.recommendation,
      timestamp: rec.first_synced_at
    });
  }
  for (const rec of resolvedRecs) {
    events.push({
      id: `rec-resolved:${rec._id}`,
      type: 'recommendation',
      text: `Recommendation resolved: ${rec.title}`,
      severity: 'info',
      color: CATEGORY_COLOR.recommendation,
      timestamp: rec.resolved_at
    });
  }
  return events;
}

async function getBudgetAlertEvents(projectId, customerId, since, limit) {
  const [triggered, resolved] = await Promise.all([
    GoogleAdsBudgetAlert.find(
      { project_id: projectId, google_ads_customer_id: customerId, triggered_at: { $gte: since } },
      { message: 1, severity: 1, triggered_at: 1 }
    ).sort({ triggered_at: -1 }).limit(limit).lean(),
    GoogleAdsBudgetAlert.find(
      { project_id: projectId, google_ads_customer_id: customerId, is_resolved: true, resolved_at: { $gte: since } },
      { campaign_name: 1, alert_type: 1, resolved_at: 1 }
    ).sort({ resolved_at: -1 }).limit(limit).lean()
  ]);

  const events = [];
  for (const alert of triggered) {
    events.push({
      id: `alert-new:${alert._id}`,
      type: 'budget_alert',
      text: alert.message,
      severity: alert.severity,
      color: CATEGORY_COLOR.budget_alert,
      timestamp: alert.triggered_at
    });
  }
  for (const alert of resolved) {
    events.push({
      id: `alert-resolved:${alert._id}`,
      type: 'budget_alert',
      text: `Budget alert resolved for ${alert.campaign_name || 'a campaign'} (${alert.alert_type.replace(/_/g, ' ')})`,
      severity: 'info',
      color: CATEGORY_COLOR.budget_alert,
      timestamp: alert.resolved_at
    });
  }
  return events;
}

async function getCampaignChangeEvents(projectId, customerId, since, limit) {
  const [added, removed] = await Promise.all([
    GoogleAdsCampaign.find(
      { project_id: projectId, google_ads_customer_id: customerId, first_synced_at: { $gte: since } },
      { name: 1, first_synced_at: 1 }
    ).sort({ first_synced_at: -1 }).limit(limit).lean(),
    GoogleAdsCampaign.find(
      { project_id: projectId, google_ads_customer_id: customerId, is_removed: true, removed_at: { $gte: since } },
      { name: 1, removed_at: 1 }
    ).sort({ removed_at: -1 }).limit(limit).lean()
  ]);

  const events = [];
  for (const c of added) {
    events.push({ id: `campaign-new:${c._id}`, type: 'campaign', text: `Campaign added: ${c.name}`, severity: 'info', color: CATEGORY_COLOR.campaign, timestamp: c.first_synced_at });
  }
  for (const c of removed) {
    events.push({ id: `campaign-removed:${c._id}`, type: 'campaign', text: `Campaign removed: ${c.name}`, severity: 'warning', color: CATEGORY_COLOR.campaign, timestamp: c.removed_at });
  }
  return events;
}

async function getOptimizationEvents(projectId, customerId, since, limit) {
  const rows = await GoogleAdsOptimizationHistory.find(
    { project_id: projectId, google_ads_customer_id: customerId, date: { $gte: since } },
    { date: 1, optimization_score_percent: 1 }
  ).sort({ date: 1 }).lean();

  const events = [];
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1].optimization_score_percent;
    const curr = rows[i].optimization_score_percent;
    if (typeof prev !== 'number' || typeof curr !== 'number') continue;

    const delta = curr - prev;
    if (Math.abs(delta) < OPTIMIZATION_SCORE_DELTA_THRESHOLD_PCT) continue;

    events.push({
      id: `optimization:${rows[i]._id}`,
      type: 'optimization',
      text: delta > 0
        ? `Optimization score improved from ${prev.toFixed(0)}% to ${curr.toFixed(0)}%`
        : `Optimization score dropped from ${prev.toFixed(0)}% to ${curr.toFixed(0)}%`,
      severity: delta > 0 ? 'info' : 'warning',
      color: CATEGORY_COLOR.optimization,
      timestamp: rows[i].date
    });
  }

  return events.slice(-limit).reverse();
}

/**
 * Merges all 5 sources, sorted by timestamp desc, capped at `limit` total
 * entries. `lookbackDays` bounds every source query (Gap #7 asks for a
 * "normalized activity feed ordered by timestamp", not an unbounded
 * account history).
 */
export async function getGoogleAdsActivityFeed(projectId, customerId, { limit = DEFAULT_LIMIT, lookbackDays = DEFAULT_LOOKBACK_DAYS } = {}) {
  const since = new Date(utcMidnight(new Date()));
  since.setUTCDate(since.getUTCDate() - lookbackDays);

  // Each source is capped at `limit` independently (bounded, not N+1 -
  // five fixed queries regardless of account size) - the final merge then
  // caps the combined, sorted result to `limit` again.
  const [syncEvents, recommendationEvents, budgetAlertEvents, campaignEvents, optimizationEvents] = await Promise.all([
    getSyncHistoryEvents(projectId, since, limit),
    getRecommendationEvents(projectId, customerId, since, limit),
    getBudgetAlertEvents(projectId, customerId, since, limit),
    getCampaignChangeEvents(projectId, customerId, since, limit),
    getOptimizationEvents(projectId, customerId, since, limit)
  ]);

  const merged = [...syncEvents, ...recommendationEvents, ...budgetAlertEvents, ...campaignEvents, ...optimizationEvents]
    .filter((e) => e.timestamp)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, limit);

  return merged;
}

export default { getGoogleAdsActivityFeed };
