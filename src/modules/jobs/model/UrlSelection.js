import mongoose from 'mongoose';

/**
 * UrlSelection — records the user's approved subset of qualified URLs for
 * one audit run, produced by POST /projects/:projectId/url-selection.
 *
 * Deliberately separate from seo_audit_url_pool (Python-owned diagnostic
 * log of probe results, never written to from Node) rather than mutating
 * that collection — keeps ownership boundaries clean and gives this
 * feature its own idempotency/audit trail, mirroring the JobGroup pattern.
 */
const urlSelectionSchema = new mongoose.Schema({
  project_id: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: 'SeoProject'
  },
  run_id: {
    type: mongoose.Schema.Types.ObjectId,
    required: true
  },
  source_job_id: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: 'Job'
  },
  selected_urls: {
    type: [String],
    required: true
  },
  total_available: {
    type: Number,
    required: true,
    min: 0
  },
  total_selected: {
    type: Number,
    required: true,
    min: 0
  },
  approved_by: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: 'User'
  },
  approved_at: {
    type: Date,
    default: Date.now
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'expired', 'cancelled'],
    default: 'approved'
  }
}, {
  collection: 'url_selections',
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
});

// Idempotency backstop: a duplicate/double-submitted approval for the same
// run fails atomically at the DB level (caught via code===11000 the same
// way JobGroup creation is), instead of silently creating a second
// selection record and a second set of chunk jobs.
urlSelectionSchema.index({ project_id: 1, run_id: 1 }, { unique: true });

const UrlSelection = mongoose.model('UrlSelection', urlSelectionSchema);

export default UrlSelection;
