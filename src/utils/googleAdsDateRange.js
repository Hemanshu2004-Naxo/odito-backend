import { ErrorUtil } from './ErrorUtil.js';

/**
 * Shared dynamic date-range resolver for every Google Ads read endpoint
 * (googleAdsController.js) - Phase 2 (Enterprise Historical Sync).
 *
 * Replaces the old fixed `parseDateRange` (which only accepted a day-count
 * and silently defaulted anything else to 30) with real support for:
 *   range=7d | 30d | 90d | 12m | all
 *   startDate=YYYY-MM-DD & endDate=YYYY-MM-DD   (custom, either alone or
 *                                                 together with range=custom)
 *
 * `range=all` needs to know how far back this project/customer's data
 * actually goes - callers pass `getEarliestDate` (a thunk that queries
 * GoogleAdsCampaignMetrics.getEarliestDate, already index-covered) so that
 * work only happens for the one request type that needs it, not on every
 * call.
 *
 * Legacy numeric values (`range=7|30|90|365`, what the frontend sent before
 * this phase) are still accepted and mapped onto the new presets - existing
 * clients/bookmarked URLs/cached links never break.
 */

const LEGACY_NUMERIC_MAP = { '7': '7d', '30': '30d', '90': '90d', '365': '12m' };
const PRESET_DAYS = { '7d': 7, '30d': 30, '90d': 90 };

function utcMidnight(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function parseIsoDate(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    throw ErrorUtil.validation(`${label} must be a valid date in YYYY-MM-DD format`);
  }
  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) {
    throw ErrorUtil.validation(`${label} must be a valid date in YYYY-MM-DD format`);
  }
  return d;
}

/**
 * @param {Object} req - Express request (reads req.query.range/startDate/endDate)
 * @param {Object} opts
 * @param {() => Promise<Date|null>} opts.getEarliestDate - resolves the
 *   earliest metrics date for this project/customer; only invoked for
 *   range=all. Returns null if nothing has synced yet.
 * @returns {Promise<{startDate: Date, endDate: Date, days: number, range: string, cacheKey: string}>}
 */
export async function resolveGoogleAdsDateRange(req, { getEarliestDate } = {}) {
  const today = utcMidnight(new Date());
  const rawRange = req.query.range != null ? String(req.query.range) : null;
  const range = LEGACY_NUMERIC_MAP[rawRange] || rawRange || '30d';

  const hasCustomDates = req.query.startDate || req.query.endDate;

  if (range === 'custom' || (hasCustomDates && !['7d', '30d', '90d', '12m', 'all'].includes(range))) {
    if (!req.query.startDate || !req.query.endDate) {
      throw ErrorUtil.validation('Custom date ranges require both startDate and endDate');
    }
    const startDate = parseIsoDate(req.query.startDate, 'startDate');
    const endDate = parseIsoDate(req.query.endDate, 'endDate');
    if (startDate > endDate) {
      throw ErrorUtil.validation('startDate must be before or equal to endDate');
    }
    const cappedEnd = endDate > today ? today : endDate;
    const days = Math.round((cappedEnd - startDate) / (24 * 60 * 60 * 1000)) + 1;
    return { startDate, endDate: cappedEnd, days, range: 'custom', cacheKey: `custom:${req.query.startDate}:${req.query.endDate}` };
  }

  if (range === '12m') {
    const startDate = new Date(today);
    startDate.setUTCMonth(startDate.getUTCMonth() - 12);
    startDate.setUTCDate(startDate.getUTCDate() + 1); // inclusive of today's date 12 months back
    const days = Math.round((today - startDate) / (24 * 60 * 60 * 1000)) + 1;
    return { startDate, endDate: today, days, range: '12m', cacheKey: '12m' };
  }

  if (range === 'all') {
    const earliest = getEarliestDate ? await getEarliestDate() : null;
    // No data synced yet - fall back to a 30-day window so the endpoint
    // still returns a well-formed (empty) response instead of a
    // zero-length or negative range.
    const startDate = earliest ? utcMidnight(earliest) : (() => {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - 29);
      return d;
    })();
    const days = Math.round((today - startDate) / (24 * 60 * 60 * 1000)) + 1;
    return { startDate, endDate: today, days, range: 'all', cacheKey: `all:${startDate.toISOString().slice(0, 10)}` };
  }

  // 7d / 30d / 90d / anything unrecognized -> default to 30d
  const days = PRESET_DAYS[range] || 30;
  const resolvedRange = PRESET_DAYS[range] ? range : '30d';
  const startDate = new Date(today);
  startDate.setUTCDate(startDate.getUTCDate() - (days - 1));
  return { startDate, endDate: today, days, range: resolvedRange, cacheKey: resolvedRange };
}
