import GoogleAdsCampaign from '../modules/app_user/model/GoogleAdsCampaign.js';
import GoogleAdsCampaignMetrics from '../modules/app_user/model/GoogleAdsCampaignMetrics.js';
import { scoreBudget, scoreBudgetUtilization, clamp } from './googleAdsHealthService.js';

/**
 * Google Ads Budget Analytics (Phase 6.5, extended per the frontend
 * integration audit's Gap #5)
 *
 * Entirely computed from already-synced data (GoogleAdsCampaign.budget +
 * GoogleAdsCampaignMetrics) - zero Google API calls, same "derived read
 * layer" role googleAdsHealthService.js already plays for Campaign Health.
 * Reuses that same file's `scoreBudget`/`scoreBudgetUtilization` pacing
 * formulas rather than re-implementing budget-utilization scoring a second
 * time - see `budgetHealth` below for exactly how.
 */

const BURN_RATE_WINDOW_DAYS = 7;

function utcMidnight(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function getMonthStart(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function daysInMonth(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
}

/**
 * Buckets a "how does actual MTD spend compare to what we'd expect by this
 * point in the month" ratio into a status label. Deliberately NOT a flat
 * "spend / monthlyBudget" threshold - on day 3 of a 30-day month even
 * perfectly-paced spend is only ~10% of the monthly budget, which a flat
 * threshold would misreport as "underspending". Comparing against the
 * ELAPSED fraction of the month (paceRatio) is what makes day 3 and day 27
 * comparable. Same 0.7/1.05 sweet-spot thresholds scoreBudget/
 * scoreBudgetUtilization already use, not a second arbitrary cutoff.
 */
function computeBudgetStatus(paceRatio) {
  if (paceRatio === null) return 'no_budget';
  if (paceRatio > 1.05) return 'overspending';
  if (paceRatio < 0.7) return 'underspending';
  return 'healthy';
}

/**
 * Account-wide budget overview: total daily budget across active campaigns,
 * an estimated monthly cap, today's/yesterday's/month-to-date spend,
 * remaining budget, a burn rate (avg daily spend over the last
 * BURN_RATE_WINDOW_DAYS), and a pace-relative budget health score/status
 * (Gap #5).
 */
export async function getBudgetOverview(projectId, customerId) {
  const today = utcMidnight(new Date());
  const yesterday = new Date(today);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const monthStart = getMonthStart(today);
  const totalDaysInMonth = daysInMonth(today);
  const daysElapsed = today.getUTCDate();

  const burnWindowStart = new Date(today);
  burnWindowStart.setUTCDate(burnWindowStart.getUTCDate() - (BURN_RATE_WINDOW_DAYS - 1));

  const [campaigns, mtdAggregate, burnWindowAggregate, todayAggregate, yesterdayAggregate] = await Promise.all([
    GoogleAdsCampaign.find({ project_id: projectId, google_ads_customer_id: customerId, is_removed: false }, { budget: 1 }).lean(),
    GoogleAdsCampaignMetrics.getAccountAggregate(projectId, customerId, monthStart, today),
    GoogleAdsCampaignMetrics.getAccountAggregate(projectId, customerId, burnWindowStart, today),
    GoogleAdsCampaignMetrics.getAccountAggregate(projectId, customerId, today, today),
    GoogleAdsCampaignMetrics.getAccountAggregate(projectId, customerId, yesterday, yesterday)
  ]);

  const dailyBudgetCampaigns = campaigns.filter((c) => c.budget?.amount > 0 && c.budget?.period !== 'CUSTOM_PERIOD');
  const dailyBudgetTotal = dailyBudgetCampaigns.reduce((sum, c) => sum + c.budget.amount, 0);
  const campaignsWithoutBudget = campaigns.length - dailyBudgetCampaigns.length;

  const monthlyBudget = dailyBudgetTotal * totalDaysInMonth;
  const spend = mtdAggregate.cost;
  const remaining = Math.max(monthlyBudget - spend, 0);
  const utilization = monthlyBudget > 0 ? (spend / monthlyBudget) * 100 : null;
  const burnRate = burnWindowAggregate.cost / BURN_RATE_WINDOW_DAYS; // avg $/day, last 7 days

  // Pace ratio: actual MTD spend vs. what MTD spend "should" be if the
  // month's budget were consumed evenly across its elapsed days so far.
  const expectedUtilization = daysElapsed > 0 ? daysElapsed / totalDaysInMonth : null;
  const paceRatio = (monthlyBudget > 0 && expectedUtilization) ? (utilization / 100) / expectedUtilization : null;
  const budgetHealth = scoreBudgetUtilization(paceRatio !== null ? paceRatio * 100 : null);
  const budgetStatus = computeBudgetStatus(paceRatio);

  return {
    dailyBudget: Math.round(dailyBudgetTotal * 100) / 100,
    monthlyBudget: Math.round(monthlyBudget * 100) / 100,
    todaySpend: Math.round(todayAggregate.cost * 100) / 100,
    yesterdaySpend: Math.round(yesterdayAggregate.cost * 100) / 100,
    spend: Math.round(spend * 100) / 100,
    remaining: Math.round(remaining * 100) / 100,
    utilizationPct: utilization !== null ? Math.round(utilization * 10) / 10 : null,
    burnRatePerDay: Math.round(burnRate * 100) / 100,
    budgetHealth: { score: budgetHealth.available ? budgetHealth.score : null, available: budgetHealth.available },
    budgetStatus,
    daysElapsed,
    totalDaysInMonth,
    campaignCount: campaigns.length,
    campaignsWithoutBudget
  };
}

const FORECAST_LABELS = {
  on_track: 'On Track',
  will_overspend: 'Will Overspend',
  will_underspend: 'Will Underspend',
  no_budget_configured: 'No Budget Configured'
};

function buildForecastMessage(forecastStatus, projectedSpend, monthlyBudget, variancePct) {
  const spendStr = `$${projectedSpend.toFixed(2)}`;
  const budgetStr = `$${monthlyBudget.toFixed(2)}`;
  if (forecastStatus === 'no_budget_configured') {
    return 'No budget has been configured for any active campaign yet.';
  }
  if (forecastStatus === 'will_overspend') {
    return `At the current pace, you're projected to spend ${spendStr} this month, ${Math.abs(variancePct).toFixed(0)}% over your ${budgetStr} budget.`;
  }
  if (forecastStatus === 'will_underspend') {
    return `At the current pace, you're projected to spend ${spendStr} this month, ${Math.abs(variancePct).toFixed(0)}% under your ${budgetStr} budget.`;
  }
  return `At the current pace, you're on track to spend approximately ${spendStr} this month, close to your ${budgetStr} budget.`;
}

/**
 * Linear projection: if the last BURN_RATE_WINDOW_DAYS' daily spend rate
 * holds for the rest of the month, will total spend land within, under, or
 * over the estimated monthly budget - a ±10% band around the monthly
 * budget is treated as "on track" rather than triggering a false alarm on
 * ordinary day-to-day variance.
 */
export async function getBudgetForecast(projectId, customerId) {
  const overview = await getBudgetOverview(projectId, customerId);
  const projectedSpend = overview.burnRatePerDay * overview.totalDaysInMonth;
  const daysRemaining = overview.totalDaysInMonth - overview.daysElapsed;

  let forecastStatus = 'on_track';
  let variancePct = 0;
  if (overview.monthlyBudget > 0) {
    variancePct = ((projectedSpend - overview.monthlyBudget) / overview.monthlyBudget) * 100;
    if (variancePct > 10) forecastStatus = 'will_overspend';
    else if (variancePct < -10) forecastStatus = 'will_underspend';
  } else {
    forecastStatus = 'no_budget_configured';
  }

  const roundedProjectedSpend = Math.round(projectedSpend * 100) / 100;
  const roundedVariancePct = Math.round(variancePct * 10) / 10;

  return {
    projectedSpend: roundedProjectedSpend,
    monthlyBudget: overview.monthlyBudget,
    forecastStatus,
    forecastLabel: FORECAST_LABELS[forecastStatus],
    forecastMessage: buildForecastMessage(forecastStatus, roundedProjectedSpend, overview.monthlyBudget, roundedVariancePct),
    variancePct: roundedVariancePct,
    daysRemaining,
    burnRatePerDay: overview.burnRatePerDay
  };
}

/** Per-campaign budget health, reusing the exact same pacing formula as googleAdsHealthService's overall Campaign Health score. */
export async function getCampaignBudgetHealth(projectId, customerId) {
  const today = utcMidnight(new Date());
  const windowStart = new Date(today);
  windowStart.setUTCDate(windowStart.getUTCDate() - (BURN_RATE_WINDOW_DAYS - 1));

  const campaigns = await GoogleAdsCampaign.find({ project_id: projectId, google_ads_customer_id: customerId, is_removed: false }).lean();

  const results = [];
  for (const campaign of campaigns) {
    const recentMetricsRows = await GoogleAdsCampaignMetrics.getCampaignSeries(projectId, campaign.campaign_id, windowStart, today);
    const budgetScore = scoreBudget(campaign, recentMetricsRows);
    results.push({ campaignId: campaign.campaign_id, campaignName: campaign.name, ...budgetScore });
  }
  return results;
}

/**
 * Computes the current set of active budget alerts for every campaign -
 * returned as plain objects for GoogleAdsBudgetAlert.reconcileAlerts to
 * upsert/resolve. Pure computation, no Google API calls.
 */
export async function generateBudgetAlerts(projectId, customerId) {
  const today = utcMidnight(new Date());
  const windowStart = new Date(today);
  windowStart.setUTCDate(windowStart.getUTCDate() - (BURN_RATE_WINDOW_DAYS - 1));
  const totalDaysInMonth = daysInMonth(today);

  const campaigns = await GoogleAdsCampaign.find({ project_id: projectId, google_ads_customer_id: customerId, is_removed: false }).lean();

  const alerts = [];
  for (const campaign of campaigns) {
    const budgetAmount = campaign.budget?.amount;

    if (!budgetAmount || budgetAmount <= 0) {
      alerts.push({
        campaignId: campaign.campaign_id, campaignName: campaign.name, alertType: 'no_budget_set', severity: 'info',
        message: `${campaign.name} has no budget configured.`, details: null
      });
      continue;
    }

    const recentMetricsRows = await GoogleAdsCampaignMetrics.getCampaignSeries(projectId, campaign.campaign_id, windowStart, today);
    if (!recentMetricsRows.length) continue; // nothing spent yet, nothing to alert on

    const avgDailySpend = recentMetricsRows.reduce((sum, r) => sum + (r.cost || 0), 0) / recentMetricsRows.length;
    const utilization = avgDailySpend / budgetAmount;
    const projectedMonthlySpend = avgDailySpend * totalDaysInMonth;
    const projectedMonthlyBudget = budgetAmount * totalDaysInMonth;
    const details = { budgetAmount, avgDailySpend: Math.round(avgDailySpend * 100) / 100, utilization: Math.round(utilization * 1000) / 1000, projectedMonthlySpend: Math.round(projectedMonthlySpend * 100) / 100 };

    if (utilization >= 1.8) {
      alerts.push({ campaignId: campaign.campaign_id, campaignName: campaign.name, alertType: 'budget_depleted', severity: 'critical',
        message: `${campaign.name} is spending ${Math.round(utilization * 100)}% of its daily budget - likely capped by Google's own delivery limit.`, details });
    } else if (utilization > 1.05) {
      alerts.push({ campaignId: campaign.campaign_id, campaignName: campaign.name, alertType: 'overspend', severity: 'warning',
        message: `${campaign.name} is averaging ${Math.round(utilization * 100)}% of its daily budget over the last ${BURN_RATE_WINDOW_DAYS} days.`, details });
    } else if (utilization < 0.5) {
      alerts.push({ campaignId: campaign.campaign_id, campaignName: campaign.name, alertType: 'underspend', severity: 'info',
        message: `${campaign.name} is only using ${Math.round(utilization * 100)}% of its daily budget - consider reallocating.`, details });
    }

    if (projectedMonthlySpend > projectedMonthlyBudget * 1.1 && utilization < 1.8) {
      alerts.push({ campaignId: campaign.campaign_id, campaignName: campaign.name, alertType: 'projected_overspend', severity: 'warning',
        message: `${campaign.name} is projected to spend ${Math.round(((projectedMonthlySpend / projectedMonthlyBudget) - 1) * 100)}% over its monthly budget at the current pace.`, details });
    }
  }

  return alerts;
}

export default { getBudgetOverview, getBudgetForecast, getCampaignBudgetHealth, generateBudgetAlerts };
