import mongoose from 'mongoose';

/**
 * SeoRankingCurrent — Canonical, single-document-per-project ranking state.
 *
 * Collection: seo_rankings_current
 *
 * One document per project_id (unique index).  Updated in-place on every scan.
 * The legacy seo_rankings collection remains untouched as an append-only archive.
 */

const rankingUrlSchema = new mongoose.Schema({
  rank: { type: Number, required: true, min: 1, max: 100 },
  url:  { type: String, required: true, trim: true },
  type: { type: String, enum: ['homepage', 'internal_page'], default: 'internal_page' }
});

/**
 * Independent scan state for ONE channel (desktop organic, mobile organic, Google Maps). Additive: the existing
 * last_scan_status / last_scan_error fields are unchanged and still drive current consumers.
 *
 *   status                   success | not_found | scan_error | pending. No default: absent means "never recorded" (legacy
 *                            keyword), which the API reports as pending rather than inventing a result.
 *   last_attempt_at          every attempt, successful or not
 *   last_successful_scan_at  only advances on success / not_found (a completed check); a failure never touches it
 *   error                    customer-safe message of the last failure; null after a completed check
 *   retry_count              provider retries the LAST attempt used (attempts - 1); 0 when it worked first time
 *   current_rank             the last SUCCESSFULLY observed rank; a failed scan leaves it as it was
 *   previous_successful_rank the successful rank before current_rank was last replaced
 *
 * Organic channels only (desktop_scan, mobile.scan), absent on keywords scanned before they existed and on Maps:
 *   status partial_success   the site was found in a partial provider response (DataForSEO 40106)
 *   serp_outcome             complete | no_results | partial | partial_without_results
 *   provider_code            the provider's task status code for the last attempt (20000, 40102, 40106, ...)
 *   requested_depth          organic depth asked for; returned_results is the organic item count actually returned
 */
const channelScanFields = {
  status:                   { type: String, enum: ['success', 'partial_success', 'not_found', 'scan_error', 'pending'] },
  serp_outcome:             { type: String, enum: ['complete', 'no_results', 'partial', 'partial_without_results'] },
  provider_code:            { type: Number },
  requested_depth:          { type: Number, min: 1 },
  returned_results:         { type: Number, min: 0 },
  last_attempt_at:          { type: Date, default: null },
  last_successful_scan_at:  { type: Date, default: null },
  error:                    { type: String, default: null },
  retry_count:              { type: Number, default: 0, min: 0 },
  current_rank:             { type: Number, default: null, min: 1, max: 100 },
  previous_successful_rank: { type: Number, default: null, min: 1, max: 100 }
};
const channelScanSchema = new mongoose.Schema(channelScanFields, { _id: false });
const mapsScanSchema = new mongoose.Schema({
  ...channelScanFields,
  // How the listing was identified: 'branch' (place_id / address / coordinates) or 'business' (unique name/domain match).
  match_level:      { type: String, enum: ['branch', 'business', null], default: null },
  match_confidence: { type: Number, default: null, min: 0, max: 100 }
}, { _id: false });

/**
 * Mobile organic ranking for one keyword — additive sibling of the (desktop)
 * top-level rank fields. Same conventions: current_rank is derived from
 * ranking_urls, prev_* are history-derived, errors never overwrite last known
 * good ranks.
 *
 * Deliberately NO defaults on last_scan_status / last_scanned_at: a legacy
 * keyword has no `mobile` object at all, and an unset last_scan_status is how
 * "never collected" is told apart from "scanned, not found" (status 'ok' +
 * null rank) and "scan failed" (status 'error'). A default of 'ok' would make
 * every old record look mobile-scanned.
 *
 * tracked_depth: deepest organic position the provider actually returned for
 * the last successful scan — the range a "not found" result is valid for.
 */
const mobileRankSchema = new mongoose.Schema({
  current_rank:    { type: Number, default: null, min: 1, max: 100 },
  best_rank:       { type: Number, default: null, min: 1, max: 100 },
  benchmark_rank:  { type: Number, default: null, min: 1, max: 100 },
  prev_scan_rank:  { type: Number, default: null, min: 1, max: 100 },
  prev_week_rank:  { type: Number, default: null, min: 1, max: 100 },
  prev_month_rank: { type: Number, default: null, min: 1, max: 100 },
  history_derived_at: { type: Date, default: null },
  ranking_urls:    [{ rank: { type: Number, required: true, min: 1, max: 100 }, url: { type: String, required: true, trim: true }, type: { type: String, enum: ['homepage', 'internal_page'], default: 'internal_page' }, _id: false }],
  tracked_depth:   { type: Number, default: null, min: 1, max: 100 },
  scan_count:      { type: Number, default: 0, min: 0 },
  last_scanned_at: { type: Date },
  last_scan_status:{ type: String, enum: ['ok', 'error'] },
  last_scan_error: { type: String, default: null },
  scan:            { type: channelScanSchema }
}, { _id: false });

const keywordRankSchema = new mongoose.Schema({
  keyword: { type: String, required: true, trim: true },

  // ── Rank fields ───────────────────────────────────────────────────────────
  // Invariant: current_rank === Math.min(...ranking_urls[].rank)
  // Never accept current_rank as a client input — always derived in the service layer.
  current_rank:    { type: Number, default: null, min: 1, max: 100 },
  best_rank:       { type: Number, default: null, min: 1, max: 100 },  // all-time min
  benchmark_rank:  { type: Number, default: null, min: 1, max: 100 },  // first detected; frozen
  prev_scan_rank:  { type: Number, default: null, min: 1, max: 100 },  // rank before last scan
  prev_week_rank:  { type: Number, default: null, min: 1, max: 100 },  // cached from history
  prev_month_rank: { type: Number, default: null, min: 1, max: 100 },  // cached from history
  maps_rank:       { type: Number, default: null, min: 1, max: 100 }, // Google Maps position (1-100; Maps is requested at depth 100)
  maps_listing:    {                                                    // Business details from Maps API
    title:   { type: String, default: null },
    rating:  { type: Number, default: null },
    reviews: { type: Number, default: null },
    address: { type: String, default: null }
  },

  // Backward-compat alias — always equals current_rank
  rank: { type: Number, default: null, min: 1, max: 100 },

  // When prev_week/month cached values were last derived from keyword_ranking_history
  history_derived_at: { type: Date, default: null },

  // ── Scan tracking ─────────────────────────────────────────────────────────
  scan_count:        { type: Number, default: 0, min: 0 },
  last_scan_source:  { type: String, enum: ['onboarding', 'manual_rescan', 'scheduled', 'dev_seed', 'manual_add'], default: 'onboarding' },
  last_rescanned_at: { type: Date, default: null },

  // 'error' means the last scan's organic SERP request/parse itself failed
  // (DataForSEO task-level error, timeout, etc.) — current_rank/best_rank/
  // ranking_urls above were left untouched by buildKeywordUpdate rather than
  // being overwritten with null, so the UI must render a distinct "scan
  // error" state instead of "Not ranked" (see UserAddedKeywords.jsx).
  last_scan_status:  { type: String, enum: ['ok', 'error'], default: 'ok' },
  last_scan_error:   { type: String, default: null },

  ranking_urls: [rankingUrlSchema],

  // Independent per-channel scan state (desktop organic / Google Maps). Mobile keeps its own under mobile.scan.
  desktop_scan: { type: channelScanSchema },
  maps_scan:    { type: mapsScanSchema },

  // Mobile organic ranking (absent on keywords never scanned for mobile).
  mobile: { type: mobileRankSchema }
});

const seoRankingCurrentSchema = new mongoose.Schema({
  project_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SeoProject',
    required: true
  },
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },

  domain:        { type: String, required: true, trim: true, lowercase: true },
  location:      { type: String, trim: true, default: null },
  location_code: { type: Number, default: null },
  country:       { type: String, uppercase: true, trim: true, default: null },
  language:      { type: String, lowercase: true, trim: true, default: 'en' },
  seo_scope:     { type: String, enum: ['local', 'national', null], default: null },

  // ── Project-level scan tracking ───────────────────────────────────────────
  scan_count:       { type: Number, default: 0, min: 0 },
  last_scan_source: { type: String, enum: ['onboarding', 'manual_rescan', 'scheduled', 'dev_seed', 'manual_add'], default: 'onboarding' },
  last_scanned_at:  { type: Date, default: null },
  created_at:       { type: Date, default: Date.now },

  keywords: [keywordRankSchema]
});

// One canonical document per project
seoRankingCurrentSchema.index({ project_id: 1 }, { unique: true });
seoRankingCurrentSchema.index({ user_id: 1 });

const SeoRankingCurrent = mongoose.model(
  'SeoRankingCurrent',
  seoRankingCurrentSchema,
  'seo_rankings_current'
);

export default SeoRankingCurrent;
