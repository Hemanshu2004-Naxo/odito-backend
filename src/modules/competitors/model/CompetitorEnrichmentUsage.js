import mongoose from 'mongoose';

/**
 * The per-project, per-UTC-day count of REAL provider calls My Competitors enrichment caused (cache hits are free and never counted).
 * One document per (project, day); reserved with one conditional update (service/enrichmentStore.js reserveProviderCall), so the cap holds
 * across several server instances, and a restart does not reset it. Expires on its own a week later.
 */
const usageSchema = new mongoose.Schema({
  project_id: { type: mongoose.Schema.Types.ObjectId, required: true },
  day: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  calls: { type: Number, required: true, default: 0, min: 0 },
  expires_at: { type: Date, required: true },
}, { collection: 'competitor_enrichment_usage' });

usageSchema.index({ project_id: 1, day: 1 }, { unique: true, name: 'competitor_enrichment_usage_project_day' });
usageSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0, name: 'competitor_enrichment_usage_ttl' });

const CompetitorEnrichmentUsage = mongoose.models.CompetitorEnrichmentUsage || mongoose.model('CompetitorEnrichmentUsage', usageSchema);
export default CompetitorEnrichmentUsage;
