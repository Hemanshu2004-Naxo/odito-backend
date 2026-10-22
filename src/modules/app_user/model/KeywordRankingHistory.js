import mongoose from 'mongoose';

/**
 * KeywordRankingHistory — Append-only time-series of keyword rank events.
 *
 * Collection: keyword_ranking_history
 *
 * One document per keyword per scan event (never updated, only inserted).
 * TTL index purges entries older than 365 days.
 */

const rankingUrlSchema = new mongoose.Schema({
  rank: { type: Number, required: true, min: 1, max: 100 },
  url:  { type: String, required: true, trim: true },
  type: { type: String, enum: ['homepage', 'internal_page'], default: 'internal_page' }
}, { _id: false });

const keywordRankingHistorySchema = new mongoose.Schema({
  project_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SeoProject',
    required: true
  },
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },

  domain:   { type: String, required: true, trim: true, lowercase: true },
  keyword:  { type: String, required: true, trim: true },

  // Pre-computed lowercase/trimmed keyword for fast case-insensitive index lookups
  keyword_normalized: { type: String, required: true, lowercase: true, trim: true },

  // Which device this observation is for. Rows written before mobile tracking
  // have no `device` and MUST be read as desktop (queries use $ne:'mobile').
  // Deliberately no default, so a legacy-shaped write can never claim mobile.
  device:       { type: String, enum: ['desktop', 'mobile'] },

  scanned_at:   { type: Date, required: true, default: Date.now },
  current_rank: { type: Number, default: null, min: 1, max: 100 },
  // Maps is requested at depth 100 (MapsRankingService), so a real position can be 1-100.
  // The old max of 20 made every history row for a keyword at Maps #21+ fail validation.
  maps_rank:    { type: Number, default: null, min: 1, max: 100 },
  // 'dev_seed' — written only by scripts/seedRankingHistory.js (local dev/QA
  // tooling), never by a real scan path. Lets that script identify and
  // idempotently replace exactly the entries it created, without touching
  // real scan history.
  scan_source:  { type: String, enum: ['onboarding', 'manual_rescan', 'scheduled', 'dev_seed', 'manual_add'], default: 'onboarding' },

  ranking_urls: [rankingUrlSchema]
});

// Primary history lookup — project + normalized keyword + time desc
keywordRankingHistorySchema.index(
  { project_id: 1, keyword_normalized: 1, scanned_at: -1 }
);

// Project timeline — all keywords for a project sorted by time
keywordRankingHistorySchema.index(
  { project_id: 1, scanned_at: -1 }
);

// TTL: auto-purge entries older than 365 days
keywordRankingHistorySchema.index(
  { scanned_at: 1 },
  { expireAfterSeconds: 31_536_000 }
);

const KeywordRankingHistory = mongoose.model(
  'KeywordRankingHistory',
  keywordRankingHistorySchema,
  'keyword_ranking_history'
);

export default KeywordRankingHistory;
