import mongoose from 'mongoose';

/**
 * One cached DataForSEO response (already reduced to the fields Odito uses). DataForSEO bills every call (the historical
 * overview ~$0.14), so responses are kept in MongoDB rather than process memory: a server restart must not re-buy them.
 *
 * `key` identifies endpoint + target + location + language (+ an optional variant such as a date range). `expiresAt` is the FRESHNESS
 * deadline only: nothing deletes an entry when it passes. It stays as the last successful answer (shown as stale) until a newer
 * success replaces it. There used to be a MongoDB TTL index on `expiresAt` that deleted entries; the schema no longer declares it, and
 * scripts/migrateCacheTtl.js drops the old index from an existing database (documents are untouched).
 * Only successful responses are ever stored; a failed attempt is only noted in lastAttemptedAt / lastErrorCode.
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
  // Last attempt to refresh this entry (success or failure) and the error code when it failed; the payload above is always the last SUCCESS.
  lastAttemptedAt: { type: Date, default: null },
  lastErrorCode: { type: String, default: null, maxlength: 60 },
}, { collection: 'dataforseo_api_cache', minimize: false });

const DataForSeoCacheEntry = mongoose.models.DataForSeoCacheEntry
  || mongoose.model('DataForSeoCacheEntry', dataForSeoCacheEntrySchema);

export default DataForSeoCacheEntry;
