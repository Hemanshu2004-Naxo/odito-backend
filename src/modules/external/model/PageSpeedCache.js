import mongoose from 'mongoose';

const metricSchema = new mongoose.Schema({
  score: { type: Number, default: null },
  fcp:   { type: String, default: null },
  lcp:   { type: String, default: null },
  tbt:   { type: String, default: null },
  cls:   { type: String, default: null }
}, { _id: false });

const pageSpeedCacheSchema = new mongoose.Schema({
  // Normalized URL — shared normalizeUrl() is applied before every read/write
  url: {
    type: String,
    required: true,
    trim: true
  },

  // Composite score (average of mobile + desktop, 0-100)
  score: { type: Number, default: null },

  // Per-device Core Web Vitals — only fields Odito actually displays
  mobile:  { type: metricSchema, default: null },
  desktop: { type: metricSchema, default: null },

  // Only 'completed' and 'partial' records are written (never 'fallback')
  status: {
    type: String,
    enum: ['completed', 'partial'],
    required: true
  },

  // When the data was fetched from Google — used for 7-day freshness check
  fetched_at: {
    type: Date,
    required: true,
    default: Date.now
  }

}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
});

// Primary lookup: most recent record for a URL (the hot-path query)
pageSpeedCacheSchema.index({ url: 1, fetched_at: -1 });

// Reporting: time-range scans across all URLs
pageSpeedCacheSchema.index({ fetched_at: -1 });

// Trend queries: score history per URL
pageSpeedCacheSchema.index({ url: 1, score: 1 });

const PageSpeedCache = mongoose.model('PageSpeedCache', pageSpeedCacheSchema, 'pagespeed_cache');
export default PageSpeedCache;
