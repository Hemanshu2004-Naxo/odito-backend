import mongoose from 'mongoose';

/**
 * One REAL provider request (a cache hit never writes here), recorded where every purchase passes: the fetcher inside
 * domainOverviewService.getDomainOverviewSection. It is the audit trail behind the project / scan cost summaries.
 *
 * What is NOT stored: credentials, headers, request bodies, response bodies, search queries or any personal data. Only identifiers, the
 * dataset, timings, counts and a stable error CODE. `cost` is the charge the provider reported for the call (USD) and is null when it
 * said nothing: totals only ever add up the costs that are known, and say how many requests had none.
 */
const schema = new mongoose.Schema({
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'SeoProject', required: true },
  scanId: { type: mongoose.Schema.Types.ObjectId, default: null },
  // scan = bought by a scan; refresh = a user's explicit Refresh; read = a read-through purchase (only when SEO_DB_FIRST_READS=false).
  trigger: { type: String, enum: ['scan', 'refresh', 'read'], required: true },
  dataset: { type: String, required: true, maxlength: 60 },
  endpoint: { type: String, required: true, maxlength: 100 },
  target: { type: String, required: true, maxlength: 253 },
  startedAt: { type: Date, required: true },
  durationMs: { type: Number, default: null },
  success: { type: Boolean, required: true },
  errorCode: { type: String, default: null, maxlength: 60 },
  requestedRecords: { type: Number, default: null },
  returnedRecords: { type: Number, default: null },
  // Provider requests are single attempts (a retry is a new request with its own row), so this is 0 unless a caller retried inside one.
  retryCount: { type: Number, default: 0 },
  cost: { type: Number, default: null },
}, { collection: 'seo_provider_requests', timestamps: { createdAt: 'createdAt', updatedAt: false }, minimize: false });

schema.index({ projectId: 1, startedAt: -1 }, { name: 'seo_pr_project_time' });
schema.index({ scanId: 1 }, { name: 'seo_pr_scan', partialFilterExpression: { scanId: { $type: 'objectId' } } });

export default mongoose.models.SeoProviderRequest || mongoose.model('SeoProviderRequest', schema);
