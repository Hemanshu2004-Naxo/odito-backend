import mongoose from 'mongoose';

/**
 * One organic keyword a project's domain ranked for, as of ONE scan. Rows are never updated: a repeat scan writes a new set under its own
 * scanId, so "what changed" is always a comparison of two stored sets. `row` is the parsed record exactly as the Organic Keywords page and
 * the dashboard consume it (domainOverviewProvider.parseRankedKeyword); the flat fields next to it exist only to be indexed, filtered and
 * sorted in MongoDB. A value the provider did not send is null here, never 0.
 *
 * `device` is null: the Labs ranked_keywords endpoint has no device parameter and does not say which one it measured, so none is claimed.
 * It is part of the identity so a device-specific source can be added later without a migration.
 *
 * Relationship to seo_rankings / seo_rankings_current: those hold the user's TRACKED keywords (the SERP is checked for keywords the user
 * chose). This is the other direction (the keywords the provider says the domain ranks for), a different grain, so it is a separate
 * collection and does not compete with them.
 */
const schema = new mongoose.Schema({
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'SeoProject', required: true },
  domain: { type: String, required: true, maxlength: 253 },
  scanId: { type: mongoose.Schema.Types.ObjectId, required: true },
  nk: { type: String, required: true, maxlength: 40 },
  keyword: { type: String, required: true, maxlength: 700 },
  normalizedKeyword: { type: String, required: true, maxlength: 700 },
  location: { type: String, default: null, maxlength: 100 },
  language: { type: String, default: null, maxlength: 100 },
  device: { type: String, default: null, maxlength: 20 },
  position: { type: Number, default: null },
  positionAbsolute: { type: Number, default: null },
  previousPosition: { type: Number, default: null },
  rankingUrl: { type: String, default: null, maxlength: 2000 },
  relativeUrl: { type: String, default: null, maxlength: 2000 },
  title: { type: String, default: null, maxlength: 500 },
  searchVolume: { type: Number, default: null },
  keywordDifficulty: { type: Number, default: null },
  cpc: { type: Number, default: null },
  searchIntent: { type: String, default: null, maxlength: 30 },
  trafficEstimate: { type: Number, default: null },
  serpFeatures: { type: [String], default: [] },
  competitionLevel: { type: String, default: null, maxlength: 20 },
  isNewRanking: { type: Boolean, default: null },
  isUp: { type: Boolean, default: null },
  isDown: { type: Boolean, default: null },
  row: { type: mongoose.Schema.Types.Mixed, required: true },
  provider: { type: new mongoose.Schema({ name: String, endpoint: String, lastUpdatedTime: String }, { _id: false }), default: null },
  capturedAt: { type: Date, required: true },
}, { collection: 'seo_keyword_rankings', timestamps: true, minimize: false });

// Duplicate prevention + the target of every idempotent bulk upsert.
schema.index({ projectId: 1, scanId: 1, nk: 1 }, { unique: true, name: 'seo_kw_scan_nk' });
// The page's sorts within one scan: traffic (default), position, search volume. Other sorts (difficulty, CPC, keyword) scan the
// project+scan set, which a scan caps (see config.js), so they stay bounded.
schema.index({ projectId: 1, scanId: 1, trafficEstimate: -1 }, { name: 'seo_kw_scan_traffic' });
schema.index({ projectId: 1, scanId: 1, position: 1 }, { name: 'seo_kw_scan_position' });
schema.index({ projectId: 1, scanId: 1, searchVolume: -1 }, { name: 'seo_kw_scan_volume' });
// One keyword across scans: its ranking history and best position.
schema.index({ projectId: 1, normalizedKeyword: 1, capturedAt: -1 }, { name: 'seo_kw_history' });

export default mongoose.models.SeoKeywordRanking || mongoose.model('SeoKeywordRanking', schema);
