import mongoose from 'mongoose';

/**
 * One cached DataForSEO response (already reduced to the fields Odito uses). DataForSEO bills every call (the historical
 * overview ~$0.14), so responses are kept in MongoDB rather than process memory: a server restart must not re-buy them.
 *
 * `key` identifies endpoint + target + location + language (+ an optional variant such as a date range). `expiresAt` is both
 * the freshness deadline the service checks and the TTL-index field MongoDB uses to delete the document afterwards.
 * Only successful responses are ever stored.
 */
const dataForSeoCacheEntrySchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, maxlength: 600 },
  endpoint: { type: String, required: true, maxlength: 100 },
  target: { type: String, required: true, maxlength: 253 },
  location: { type: String, default: '', maxlength: 100 },
  language: { type: String, default: '', maxlength: 100 },
  variant: { type: String, default: '', maxlength: 200 },
  payload: { type: mongoose.Schema.Types.Mixed, required: true },
  // What the provider charged for the call that produced this payload (USD), when it said so.
  cost: { type: Number, default: null },
  fetchedAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
}, { collection: 'dataforseo_api_cache', minimize: false });

dataForSeoCacheEntrySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'dataforseo_cache_ttl' });

const DataForSeoCacheEntry = mongoose.models.DataForSeoCacheEntry
  || mongoose.model('DataForSeoCacheEntry', dataForSeoCacheEntrySchema);

export default DataForSeoCacheEntry;
