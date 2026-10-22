import mongoose from 'mongoose';

/**
 * SeoRanking — Stores keyword ranking results from the onboarding flow.
 *
 * Collection: seo_rankings
 *
 * Created separately from SeoProject to maintain clean separation
 * of concerns.  Each document represents one ranking snapshot taken
 * during onboarding for a given project.
 */
const seoRankingSchema = new mongoose.Schema({
  // Link to the SEO project
  project_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SeoProject',
    required: true,
    index: true
  },

  // Link to the user who owns the project
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },

  // The domain that was checked
  domain: {
    type: String,
    required: true,
    trim: true,
    lowercase: true
  },

  // Human-readable location string (e.g. "Nashik, Maharashtra, India")
  location: {
    type: String,
    trim: true,
    default: null
  },

  // DataForSEO location_code used in the SERP query — required to reproduce the same query
  location_code: {
    type: Number,
    default: null
  },

  // ISO-2 country code (e.g. "IN", "US")
  country: {
    type: String,
    uppercase: true,
    trim: true,
    default: null
  },

  // Language code used (e.g. "en", "hi")
  language: {
    type: String,
    lowercase: true,
    trim: true,
    default: 'en'
  },

  // Whether this ranking was for local or national SEO scope
  seo_scope: {
    type: String,
    enum: ['local', 'national', null],
    default: null
  },

  // How this ranking was triggered
  ranking_source: {
    type: String,
    enum: ['onboarding', 'manual_refresh', 'scheduled'],
    default: 'onboarding'
  },

  // Array of keyword → rank pairs
  keywords: [{
    keyword: {
      type: String,
      required: true,
      trim: true
    },
    // Backward-compat field — equals best_rank
    rank: {
      type: Number,
      default: null,
      min: 1,
      max: 100
    },
    // Lowest (best) rank position found across all matching URLs
    best_rank: {
      type: Number,
      default: null,
      min: 1,
      max: 100
    },
    // All URLs from the domain that appeared in the SERP
    ranking_urls: [{
      rank: { type: Number, required: true, min: 1, max: 100 },
      url:  { type: String, required: true, trim: true },
      type: { type: String, enum: ['homepage', 'internal_page'], default: 'internal_page' }
    }],
    // Mobile organic result for the same keyword (legacy /rankings/check path).
    // mobile_status: 'ok' (mobile_rank null => not found), 'error' (check failed,
    // rank unknown). Unset => mobile never collected.
    mobile_rank:   { type: Number, default: null, min: 1, max: 100 },
    mobile_status: { type: String, enum: ['ok', 'error'] },
    // Desktop check failed (rank unknown) — distinguishes failure from rank null.
    scan_error:    { type: String, default: null },
    // Google Maps position and business details (local SEO only)
    // Maps is requested at depth 100, so a real position can be 1-100 (max was 20: save-ranking threw a ValidationError for Maps #21+).
    maps_rank: { type: Number, default: null, min: 1, max: 100 },
    maps_listing: {
      title:   { type: String, default: null },
      rating:  { type: Number, default: null },
      reviews: { type: Number, default: null },
      address: { type: String, default: null }
    }
  }],

  created_at: {
    type: Date,
    default: Date.now
  }
});

// Compound index for efficient lookups
seoRankingSchema.index({ project_id: 1, created_at: -1 });

const SeoRanking = mongoose.model('SeoRanking', seoRankingSchema, 'seo_rankings');
export default SeoRanking;
