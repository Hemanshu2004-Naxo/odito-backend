/**
 * Analytics Mapper
 *
 * Isolates every Google Analytics Data API / Admin API field name
 * (dimensionValues/metricValues arrays, GA4 metric API names, Admin API
 * resource shapes) from the rest of the backend. analyticsService.js calls
 * these transforms immediately after each Google HTTP call, before caching
 * or returning - no other file (controller, route, or future frontend
 * consumer) should ever see a raw GA4 response shape.
 *
 * TREND_METRIC_NAMES is the single source of truth for both the runReport
 * request (analyticsService.js builds its `metrics` array from this) and
 * the response parsing below (metricValues[i] is read positionally, in
 * this exact order) - keeping request and response decoding driven by one
 * shared array instead of two independently-maintained lists.
 *
 * DTO field names (users/newUsers/sessions/engagedSessions/views/
 * avgEngagementTime/bounceRate/conversions) intentionally match the keys
 * already used by the shipped frontend's AnalyticsKPICard/TrafficChartCard
 * sample data (app/app/google-visibility/analytics/page.jsx) - not wired
 * yet (out of scope for this phase), but this makes that future wiring a
 * prop swap instead of a remapping exercise.
 */

export const TREND_METRIC_NAMES = [
  'activeUsers',
  'newUsers',
  'sessions',
  'engagedSessions',
  'screenPageViews',
  'averageSessionDuration',
  'bounceRate',
  'conversions',
];

// GA4 returns the `date` dimension as 'YYYYMMDD' - normalize to 'YYYY-MM-DD'
// so it matches every other date string already used across Odito's API
// responses and is directly usable by `new Date(...)` / chart libraries.
function normalizeGA4Date(raw) {
  if (!raw || raw.length !== 8) return raw || null;
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

function toNumber(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

// Stable, URL/React-key-safe identifier derived from a Google-returned
// label (channel name, country name, browser name, ...) - Google gives us
// display strings, not machine keys, for every one of these dimensions.
function slugify(label) {
  const slug = String(label ?? '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return slug || 'unknown';
}

/**
 * Metrics for the Breakdown endpoint's channel report (sessionDefaultChannelGroup
 * dimension) - positional, same convention as TREND_METRIC_NAMES.
 */
export const CHANNEL_METRIC_NAMES = ['activeUsers', 'sessions', 'engagementRate', 'conversions'];

/**
 * Metrics for the shared Events/Conversions report (eventName dimension).
 * `conversions` (Google's own per-event conversion count, 0 for any event
 * not flagged as a conversion in this GA4 property's Admin config) is what
 * lets toConversionsDTO identify real conversion events instead of
 * guessing from the name - see toConversionsDTO.
 */
export const EVENT_METRIC_NAMES = ['eventCount', 'activeUsers', 'conversions'];

/**
 * Event name -> display bucket, for the Conversions widget's 5 named
 * categories (Purchases/Leads/Newsletter/Downloads/Form Submissions).
 * Keys are GA4's own standard/recommended/automatically-collected event
 * names (Google's Analytics event reference), not an Odito-invented
 * mapping - `purchase` and `generate_lead` are GA4-recommended ecommerce/
 * lead-gen events, `file_download` and `form_submit` are automatically
 * collected by GA4's Enhanced Measurement. A property whose conversion
 * event uses a different custom name (e.g. `newsletter_signup` instead of
 * `sign_up`) is not silently miscategorized - it falls into "Other
 * Conversion Events" in toConversionsDTO rather than being guessed at.
 * Extend this map only with names Google itself documents as standard.
 */
export const CONVERSION_EVENT_CATEGORIES = {
  purchase: 'Purchases',
  generate_lead: 'Leads',
  sign_up: 'Newsletter',
  file_download: 'Downloads',
  form_submit: 'Form Submissions',
};

const CONVERSION_CATEGORY_ORDER = ['Purchases', 'Leads', 'Newsletter', 'Downloads', 'Form Submissions', 'Other Conversion Events'];

/**
 * Analytics Health scoring formula (v1) - an ODITO-DERIVED score, not a
 * Google Analytics metric. GA4 exposes no composite "health" concept;
 * this is a documented, deterministic weighted average of 5 component
 * scores (each 0-100), computed from data already fetched by the Trends
 * endpoint - see toHealthDTO.
 *
 * Component scores (each independently clamped to 0-100):
 *   usersScore        = 50 + usersTrend%        (0% trend -> neutral 50; +/-50% trend -> 100/0)
 *   sessionsScore      = 50 + sessionsTrend%
 *   conversionsScore  = 50 + conversionsTrend%
 *   engagementScore    = engagedSessions / sessions, as a percentage (0-100 directly)
 *   bounceScore        = 100 - averageBounceRate (lower bounce = higher score)
 *
 * Final score = weighted sum of the 5 component scores (weights below,
 * sum to 1.0), rounded to the nearest integer. "Trend" in every component
 * is the same first-half-vs-second-half comparison already used for KPI
 * trend arrows elsewhere in Odito (see computeHalfPeriodTrend) - not a
 * Google-provided figure.
 *
 * Weights are a v1 product decision, not derived from any external
 * benchmark - conversions is weighted highest (0.25) as the most
 * business-relevant signal, bounce lowest (0.15) as the noisiest/most
 * property-type-dependent one. `formulaVersion` is returned in every
 * Health response specifically so a future weight change is visible to
 * any consumer, not a silent behavior change.
 */
const HEALTH_FORMULA_VERSION = 'v1';
const HEALTH_WEIGHTS = { users: 0.20, sessions: 0.20, conversions: 0.25, engagement: 0.20, bounce: 0.15 };
const HEALTH_STATUS_BANDS = [
  { min: 80, status: 'Strong' },
  { min: 60, status: 'Good' },
  { min: 40, status: 'Fair' },
  { min: 0, status: 'Needs Attention' },
];
// +/- this percent counts as "stable" for a reason string, not up/down -
// avoids a reason flipping between "increasing"/"declining" on noise.
const HEALTH_TREND_STABLE_THRESHOLD = 5;

// Same half-vs-half / period-vs-period trend formula already used by the
// frontend's buildKpisFromTrends (lib/businessProfileTrends.js) - kept
// identical here so a percentage labeled "trend" means the same thing
// across every Odito surface, GBP or Analytics: 0% (not NaN/Infinity) when
// the previous period was genuinely zero and stays zero, 100% when it went
// from zero to something.
function computeTrend(current, previous) {
  if (previous > 0) return Math.round(((current - previous) / previous) * 1000) / 10;
  return current > 0 ? 100 : 0;
}

function clamp(value, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value));
}

// Sum (or average) a metric across the first half vs. second half of a
// chronological trends series, expressed as a computeTrend() percentage -
// the same half-vs-half technique as computeTrend's callers above, applied
// here as a Health-score INPUT rather than a display arrow. `mode: 'sum'`
// for count-like metrics (users/sessions/conversions), `mode: 'avg'` for
// rate-like metrics (bounceRate) where summing would be meaningless.
function computeHalfPeriodTrend(series, key, mode = 'sum') {
  const mid = Math.floor(series.length / 2);
  const firstHalf = series.slice(0, mid);
  const secondHalf = series.slice(mid);

  const aggregate = (rows) => {
    if (rows.length === 0) return 0;
    const sum = rows.reduce((acc, row) => acc + (row[key] || 0), 0);
    return mode === 'avg' ? sum / rows.length : sum;
  };

  return computeTrend(aggregate(secondHalf), aggregate(firstHalf));
}

/**
 * Single-dimension, single-metric report (countries/devices/browsers/OS
 * sub-reports of the Breakdown batch) -> [{key, label, value}], sorted
 * desc. `report` may be undefined/malformed if batchRunReports ever
 * returns fewer entries than requested - every read below is optional-
 * chained so a partial/short response degrades to an empty list for that
 * one widget rather than throwing and blanking the whole endpoint.
 */
function mapSingleDimensionReport(report, metricIndex = 0) {
  const rows = report?.rows || [];
  return rows
    .map((row) => {
      const label = row?.dimensionValues?.[0]?.value;
      if (!label) return null;
      return { key: slugify(label), label, value: Math.round(toNumber(row?.metricValues?.[metricIndex]?.value)) };
    })
    .filter(Boolean)
    .sort((a, b) => b.value - a.value);
}

// Countries report requests two dimensions (country, countryId) in the
// same single sub-request - zero extra Google cost (still one report row
// per country), but gives a stable ISO-ish code alongside the display name
// for whenever a future frontend phase wants to render a flag.
function mapCountriesReport(report) {
  const rows = report?.rows || [];
  return rows
    .map((row) => {
      const label = row?.dimensionValues?.[0]?.value;
      if (!label) return null;
      const countryId = row?.dimensionValues?.[1]?.value || null;
      return { key: slugify(label), label, countryId, value: Math.round(toNumber(row?.metricValues?.[0]?.value)) };
    })
    .filter(Boolean)
    .sort((a, b) => b.value - a.value);
}

// Channel report (CHANNEL_METRIC_NAMES, in that order) -> one parsed array
// reused for BOTH the Traffic Sources donut and the Top Channels table
// (see toBreakdownDTO) - one Google report, two DTO projections, computed
// together rather than re-parsing the same rows twice.
function mapChannelReport(report) {
  const rows = report?.rows || [];
  return rows
    .map((row) => {
      const label = row?.dimensionValues?.[0]?.value;
      if (!label) return null;
      const m = row?.metricValues || [];
      return {
        key: slugify(label),
        label,
        users: Math.round(toNumber(m[0]?.value)),
        sessions: Math.round(toNumber(m[1]?.value)),
        engagementRate: toNumber(m[2]?.value),
        conversions: Math.round(toNumber(m[3]?.value)),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.users - a.users);
}

/**
 * Shared by toEventsDTO and toConversionsDTO - both read the exact same
 * raw rows (one Google report, two DTO shapes), so the dimensionValues/
 * metricValues parsing and current-vs-previous-period grouping happens
 * once here rather than twice.
 *
 * Rows carry 2 dimension values: [eventName, dateRange] - `dateRange` is
 * GA4's own auto-appended pseudo-dimension whenever a request has 2+
 * dateRanges (no need to declare it in the request's `dimensions` array),
 * valued 'date_range_0' for the first entry in the request's dateRanges
 * array and 'date_range_1' for the second. analyticsService.js's events
 * request always sends [previousPeriod, currentPeriod] in that order, so
 * date_range_0 = previous, date_range_1 = current.
 */
function groupEventRows(rawRows = []) {
  const byEvent = new Map();

  for (const row of rawRows) {
    const eventName = row?.dimensionValues?.[0]?.value;
    const period = row?.dimensionValues?.[1]?.value;
    if (!eventName || !period) continue;

    if (!byEvent.has(eventName)) {
      byEvent.set(eventName, {
        name: eventName,
        current: { eventCount: 0, activeUsers: 0, conversions: 0 },
        previous: { eventCount: 0, activeUsers: 0, conversions: 0 },
      });
    }

    const entry = byEvent.get(eventName);
    const bucket = period === 'date_range_1' ? entry.current : entry.previous;
    const m = row?.metricValues || [];
    bucket.eventCount += toNumber(m[0]?.value);
    bucket.activeUsers += toNumber(m[1]?.value);
    bucket.conversions += toNumber(m[2]?.value);
  }

  return byEvent;
}

export class AnalyticsMapper {
  /**
   * Raw runReport rows (dimension=date, metrics=TREND_METRIC_NAMES in that
   * exact order) -> { series, totals }.
   *
   * `bounceRate`/`avgEngagementTime` totals are a mean of the daily values,
   * not a re-derived "total bounces / total sessions" - a documented
   * simplification for Phase 1 (matching how GBP's own trend totals are
   * simple sums, not re-derived ratios); revisit only if a Phase 2 review
   * finds the mean materially diverges from Google's own period-level
   * bounceRate for a given property.
   */
  static toTrendsSeries(rawRows = []) {
    const series = rawRows
      .map((row) => {
        const dateValue = row.dimensionValues?.[0]?.value;
        if (!dateValue) return null;
        const m = row.metricValues || [];

        return {
          date: normalizeGA4Date(dateValue),
          users: Math.round(toNumber(m[0]?.value)),
          newUsers: Math.round(toNumber(m[1]?.value)),
          sessions: Math.round(toNumber(m[2]?.value)),
          engagedSessions: Math.round(toNumber(m[3]?.value)),
          views: Math.round(toNumber(m[4]?.value)),
          avgEngagementTime: toNumber(m[5]?.value),
          bounceRate: toNumber(m[6]?.value),
          conversions: Math.round(toNumber(m[7]?.value)),
        }
      })
      .filter(Boolean)
      // Defense in depth - the request already sends orderBys:[{dimension:'date'}],
      // but sorting ~366 tiny objects is negligible cost for a guaranteed order.
      .sort((a, b) => a.date.localeCompare(b.date));

    const sums = series.reduce((acc, row) => {
      acc.users += row.users;
      acc.newUsers += row.newUsers;
      acc.sessions += row.sessions;
      acc.engagedSessions += row.engagedSessions;
      acc.views += row.views;
      acc.conversions += row.conversions;
      acc.avgEngagementTimeSum += row.avgEngagementTime;
      acc.bounceRateSum += row.bounceRate;
      return acc;
    }, {
      users: 0, newUsers: 0, sessions: 0, engagedSessions: 0, views: 0,
      conversions: 0, avgEngagementTimeSum: 0, bounceRateSum: 0,
    });

    const dayCount = series.length || 1;

    return {
      series,
      totals: {
        users: sums.users,
        newUsers: sums.newUsers,
        sessions: sums.sessions,
        engagedSessions: sums.engagedSessions,
        views: sums.views,
        conversions: sums.conversions,
        avgEngagementTime: Math.round((sums.avgEngagementTimeSum / dayCount) * 10) / 10,
        bounceRate: Math.round((sums.bounceRateSum / dayCount) * 10) / 10,
      },
    };
  }

  /**
   * Admin API properties.get response + dataStreams.list response ->
   * flat property DTO. `streams` is the raw dataStreams array; only the
   * first WEB stream (if any) is used - a GA4 property can also have
   * iOS/Android streams, which have no measurementId/defaultUri to surface
   * on this card. Both fields are null (never thrown) when a property has
   * no web stream, e.g. an app-only GA4 property.
   */
  static toPropertyDetails(propertyResource, streams = []) {
    const webStream = streams.find((s) => s?.webStreamData) || null;

    return {
      propertyName: propertyResource?.displayName || null,
      timezone: propertyResource?.timeZone || null,
      websiteUrl: webStream?.webStreamData?.defaultUri || null,
      measurementId: webStream?.webStreamData?.measurementId || null,
    };
  }

  /**
   * batchRunReports response `reports` array (5 entries, in the fixed
   * order analyticsService.js's getAnalyticsBreakdowns sends them: channels,
   * countries, devices, browsers, operatingSystems) -> one Breakdown DTO
   * powering Traffic Sources, Top Channels, Countries, Devices, Browsers
   * and Operating Systems.
   *
   * No per-row trend/color here by design: colors are a frontend rendering
   * concern (not introduced in this backend phase, matching how Phase 1's
   * trends DTO also carries no color), and a per-channel trend would
   * require the same 2-dateRanges technique used for Events below across
   * all 5 bundled reports - deliberately out of scope for Phase 2 since
   * the widget list here doesn't call for it (unlike Events, which
   * explicitly does). Revisit only if a future phase's UI spec asks for it.
   */
  static toBreakdownDTO(reports = []) {
    const [channelsReport, countriesReport, devicesReport, browsersReport, osReport] = reports;

    const channelRows = mapChannelReport(channelsReport);

    return {
      sources: channelRows.map(({ key, label, users }) => ({ key, label, value: users })),
      channels: channelRows,
      countries: mapCountriesReport(countriesReport),
      devices: mapSingleDimensionReport(devicesReport, 0),
      browsers: mapSingleDimensionReport(browsersReport, 0),
      operatingSystems: mapSingleDimensionReport(osReport, 0),
    };
  }

  /**
   * Raw eventName-dimensioned runReport rows -> top events by count, each
   * with a real period-over-period trend (current vs. previous period,
   * both fetched in the same request via 2 dateRanges - see
   * groupEventRows). `rawRows` are the SAME rows toConversionsDTO reads -
   * see analyticsService.js's getAnalyticsEventsData/getAnalyticsConversionsData,
   * which share one cached Google fetch between the two endpoints.
   */
  static toEventsDTO(rawRows = [], { limit = 10 } = {}) {
    const grouped = Array.from(groupEventRows(rawRows).values());

    const events = grouped
      .map((e) => ({
        name: e.name,
        count: Math.round(e.current.eventCount),
        users: Math.round(e.current.activeUsers),
        trend: computeTrend(e.current.eventCount, e.previous.eventCount),
        trendDirection: e.current.eventCount >= e.previous.eventCount ? 'up' : 'down',
      }))
      .filter((e) => e.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);

    return { events };
  }

  /**
   * Same raw rows as toEventsDTO, filtered to Google-verified conversion
   * events (the `conversions` metric > 0 for that event, in either period -
   * not a name guess) and bucketed into the 5 named categories in
   * CONVERSION_EVENT_CATEGORIES, with an "Other Conversion Events" catch-
   * all for conversion-flagged events this map doesn't recognize by name.
   * Only categories with at least one matching event appear in the
   * response (a property with no purchases configured simply has no
   * "Purchases" entry, rather than a hardcoded zero row).
   */
  static toConversionsDTO(rawRows = []) {
    const grouped = Array.from(groupEventRows(rawRows).values());
    const buckets = new Map();
    let totalConversions = 0;

    for (const e of grouped) {
      if (e.current.conversions <= 0 && e.previous.conversions <= 0) continue;

      const label = CONVERSION_EVENT_CATEGORIES[e.name] || 'Other Conversion Events';
      if (!buckets.has(label)) buckets.set(label, { count: 0, previousCount: 0 });
      const bucket = buckets.get(label);
      bucket.count += e.current.conversions;
      bucket.previousCount += e.previous.conversions;
      totalConversions += e.current.conversions;
    }

    const conversions = CONVERSION_CATEGORY_ORDER
      .filter((label) => buckets.has(label))
      .map((label) => {
        const bucket = buckets.get(label);
        return {
          key: slugify(label),
          label,
          count: Math.round(bucket.count),
          trend: computeTrend(bucket.count, bucket.previousCount),
        };
      });

    return { conversions, totalConversions: Math.round(totalConversions) };
  }

  /**
   * 3 raw runRealtimeReport responses -> one Realtime DTO. `activeUsers` is
   * derived from deviceSplit's sum (see getAnalyticsRealtimeData for why
   * that's accurate rather than approximate - deviceCategory has a small,
   * exhaustive, un-truncated value set) rather than a 4th no-dimension
   * Google call.
   */
  static toRealtimeDTO({ pagesReport, countriesReport, devicesReport } = {}) {
    const topPages = (pagesReport?.rows || [])
      .map((row) => {
        const path = row?.dimensionValues?.[0]?.value;
        if (!path) return null;
        return { path, users: Math.round(toNumber(row?.metricValues?.[0]?.value)) };
      })
      .filter(Boolean);

    const topCountries = (countriesReport?.rows || [])
      .map((row) => {
        const label = row?.dimensionValues?.[0]?.value;
        if (!label) return null;
        return { key: slugify(label), label, users: Math.round(toNumber(row?.metricValues?.[0]?.value)) };
      })
      .filter(Boolean);

    const deviceSplit = (devicesReport?.rows || [])
      .map((row) => {
        const label = row?.dimensionValues?.[0]?.value;
        if (!label) return null;
        return { key: slugify(label), label, users: Math.round(toNumber(row?.metricValues?.[0]?.value)) };
      })
      .filter(Boolean);

    const activeUsers = deviceSplit.reduce((sum, d) => sum + d.users, 0);

    return { activeUsers, topPages, topCountries, deviceSplit };
  }

  /**
   * Odito-derived Analytics Health score - see the HEALTH_* constants
   * above for the full documented formula. Operates entirely on an
   * already-fetched Trends series (no Google call of its own).
   *
   * Returns { score: null, status: 'Insufficient Data', ... } rather than
   * a misleading number when there are too few daily data points (<4) for
   * a first-half-vs-second-half comparison to mean anything - a brand new
   * connection with 1-2 days of history should not get a confident-looking
   * score built from noise.
   */
  static toHealthDTO(series = []) {
    if (series.length < 4) {
      return {
        score: null,
        status: 'Insufficient Data',
        reasons: ['Not enough daily data points yet to compute a reliable health score.'],
        formulaVersion: HEALTH_FORMULA_VERSION,
      };
    }

    const usersTrend = computeHalfPeriodTrend(series, 'users', 'sum');
    const sessionsTrend = computeHalfPeriodTrend(series, 'sessions', 'sum');
    const conversionsTrend = computeHalfPeriodTrend(series, 'conversions', 'sum');
    // Negative = improving (average bounce rate went down second half vs first).
    const bounceRateTrend = computeHalfPeriodTrend(series, 'bounceRate', 'avg');

    const totalSessions = series.reduce((sum, row) => sum + row.sessions, 0);
    const totalEngagedSessions = series.reduce((sum, row) => sum + row.engagedSessions, 0);
    const engagementRate = totalSessions > 0 ? totalEngagedSessions / totalSessions : 0;
    const avgBounceRate = series.reduce((sum, row) => sum + row.bounceRate, 0) / series.length;

    const usersScore = clamp(50 + usersTrend);
    const sessionsScore = clamp(50 + sessionsTrend);
    const conversionsScore = clamp(50 + conversionsTrend);
    const engagementScore = clamp(engagementRate * 100);
    const bounceScore = clamp(100 - avgBounceRate);

    const rawScore =
      usersScore * HEALTH_WEIGHTS.users +
      sessionsScore * HEALTH_WEIGHTS.sessions +
      conversionsScore * HEALTH_WEIGHTS.conversions +
      engagementScore * HEALTH_WEIGHTS.engagement +
      bounceScore * HEALTH_WEIGHTS.bounce;

    const score = Math.round(clamp(rawScore));
    const status = (HEALTH_STATUS_BANDS.find((band) => score >= band.min) || HEALTH_STATUS_BANDS[HEALTH_STATUS_BANDS.length - 1]).status;

    const reasons = [];
    if (sessionsTrend > HEALTH_TREND_STABLE_THRESHOLD) reasons.push('Sessions increasing');
    else if (sessionsTrend < -HEALTH_TREND_STABLE_THRESHOLD) reasons.push('Sessions declining');
    else reasons.push('Sessions stable');

    if (bounceRateTrend < -HEALTH_TREND_STABLE_THRESHOLD) reasons.push('Bounce rate improving');
    else if (bounceRateTrend > HEALTH_TREND_STABLE_THRESHOLD) reasons.push('Bounce rate worsening');
    else reasons.push('Bounce rate stable');

    if (conversionsTrend > HEALTH_TREND_STABLE_THRESHOLD) reasons.push('Conversions increasing');
    else if (conversionsTrend < -HEALTH_TREND_STABLE_THRESHOLD) reasons.push('Conversions declining');
    else reasons.push('Conversions stable');

    return { score, status, reasons, formulaVersion: HEALTH_FORMULA_VERSION };
  }

  /**
   * Recent Analytics Activity, synthesized server-side from GoogleConnection's
   * own timestamps - never a Google API call, never a hardcoded list.
   *
   * Odito does not currently persist a granular sync-event history
   * (last_sync_at is one rolling timestamp per connection, shared across
   * all 3 Google services, not a per-sync log) - so only what is honestly
   * derivable is represented: when the property was connected, and when it
   * last synced. Inventing separately-timestamped "Cache Refresh" or
   * "Historical Sync" entries with no real distinguishing data behind them
   * would be exactly the hardcoding this method is required not to do.
   * Revisit if/when a real sync-event log exists.
   */
  static toActivityDTO(googleConnection) {
    const activity = [];

    if (googleConnection?.connected_at) {
      activity.push({
        id: 'connected',
        text: 'Google Analytics property connected',
        timestamp: googleConnection.connected_at,
      });
    }

    if (googleConnection?.last_sync_at) {
      activity.push({
        id: 'last_sync',
        text: 'Last sync completed',
        timestamp: googleConnection.last_sync_at,
      });
    }

    activity.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    return { activity };
  }
}

export default AnalyticsMapper;
