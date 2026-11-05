import mongoose from 'mongoose';

/**
 * One timestamped snapshot of a SUMMARY dataset (rank overview, backlink summary, counts ...), appended every time Odito really buys fresh
 * provider data for a project. This is Odito's own history: reports compare snapshots, they never re-buy the past.
 *
 * Rules: append-only (no code path updates or deletes a snapshot); `capturedAt` is the provider fetch time (UTC), never a guess; a failed
 * or cached answer never creates one. Row-level lists (keywords, backlinks, referring domains ...) are NOT snapshotted here: a single
 * document would hit MongoDB's 16 MB limit, and they get their own row collections.
 */
const seoSnapshotSchema = new mongoose.Schema({
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'SeoProject', required: true },
  domain: { type: String, required: true, maxlength: 253 },
  // The scan that bought it; null when it came from a user's explicit refresh.
  scanId: { type: mongoose.Schema.Types.ObjectId, default: null },
  datasetType: { type: String, required: true, maxlength: 60 },
  // The domain-overview section it came from (e.g. 'rd-last-30'), because one dataset type can have several parts.
  part: { type: String, required: true, maxlength: 60 },
  // The provider question's variant (e.g. a history date range); part of the identity of the data.
  variant: { type: String, default: '', maxlength: 200 },
  market: { type: new mongoose.Schema({ location: String, language: String }, { _id: false }), default: null },
  data: { type: mongoose.Schema.Types.Mixed, required: true },
  // What the provider reported charging for the call, when it said so.
  cost: { type: Number, default: null },
  capturedAt: { type: Date, required: true },
  provider: { type: String, default: 'dataforseo', maxlength: 30 },
  source: { type: String, enum: ['scan', 'refresh'], required: true },
  schemaVersion: { type: Number, default: 1 },
}, { collection: 'seo_snapshots', timestamps: { createdAt: 'createdAt', updatedAt: false }, minimize: false });

// History of one dataset part for a project, newest first (comparisons, charts).
seoSnapshotSchema.index({ projectId: 1, datasetType: 1, part: 1, capturedAt: -1 }, { name: 'seo_snapshots_project_type_part_time' });
// Everything one scan produced.
seoSnapshotSchema.index({ scanId: 1 }, { name: 'seo_snapshots_scan', partialFilterExpression: { scanId: { $type: 'objectId' } } });

const SeoSnapshot = mongoose.models.SeoSnapshot || mongoose.model('SeoSnapshot', seoSnapshotSchema);
export default SeoSnapshot;
