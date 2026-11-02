import mongoose from 'mongoose';

/**
 * The per-project, per-UTC-day count of Google Places requests Local Competitors made (each billed by Google). Same mechanics as
 * CompetitorEnrichmentUsage: one document per (project, day), reserved with one conditional update (enrichmentStore.reserveProviderCall),
 * so the cap holds across server instances and a restart does not reset it. Expires on its own a week later. It stores NO Google content.
 */
const usageSchema = new mongoose.Schema({
  project_id: { type: mongoose.Schema.Types.ObjectId, required: true },
  day: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  calls: { type: Number, required: true, default: 0, min: 0 },
  expires_at: { type: Date, required: true },
}, { collection: 'competitor_local_usage' });

usageSchema.index({ project_id: 1, day: 1 }, { unique: true, name: 'competitor_local_usage_project_day' });
usageSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0, name: 'competitor_local_usage_ttl' });

const CompetitorLocalUsage = mongoose.models.CompetitorLocalUsage || mongoose.model('CompetitorLocalUsage', usageSchema);
export default CompetitorLocalUsage;
