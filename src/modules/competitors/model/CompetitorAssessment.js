import mongoose from 'mongoose';

/**
 * The business-relevance assessment of ONE website for ONE project. Separate from project_competitors on purpose: the SEO list shows
 * hundreds of domains that are not (and should not become) saved competitors, but each one the user looks at can have an assessment.
 *
 *   auto      what the rules decided, with the reasons, the signals and the versions of the rules and the curated registry that produced it.
 *             Reassessment only ever rewrites this object.
 *   override  the user's own decision (class, note, who, when). Reassessment NEVER touches it. The effective class is override ?? auto.
 *
 * The same queue mechanics as My Competitors enrichment (status + lease, every take-over one conditional update, writes guarded by lease
 * ownership), so a crashed worker is recovered and two workers never assess the same domain.
 */
export const ASSESSMENT_CLASSES = Object.freeze(['direct_competitor', 'indirect_competitor', 'informational_directory', 'not_relevant', 'needs_review']);
export const ASSESSMENT_STATUSES = Object.freeze(['pending', 'processing', 'done', 'failed']);

const reasonSchema = new mongoose.Schema({
  code: { type: String, required: true, maxlength: 60 },
  text: { type: String, required: true, maxlength: 400 },
  source: { type: String, required: true, maxlength: 30 },
}, { _id: false });

const autoSchema = new mongoose.Schema({
  class: { type: String, enum: ASSESSMENT_CLASSES, required: true },
  confidence: { type: Number, min: 0, max: 1, required: true },
  level: { type: String, enum: ['high', 'medium', 'low'], required: true },
  reasons: { type: [reasonSchema], default: [] },
  signals: { type: mongoose.Schema.Types.Mixed, default: null },
  facts: { type: mongoose.Schema.Types.Mixed, default: null },
  rules_version: { type: String, required: true, maxlength: 40 },
  registry_version: { type: String, required: true, maxlength: 40 },
  fetch_failed: { type: Boolean, default: false },
  assessed_at: { type: Date, required: true },
}, { _id: false });

const overrideSchema = new mongoose.Schema({
  class: { type: String, enum: ASSESSMENT_CLASSES, required: true },
  note: { type: String, default: null, maxlength: 500 },
  user_id: { type: mongoose.Schema.Types.ObjectId, required: true },
  at: { type: Date, required: true },
}, { _id: false });

const assessmentSchema = new mongoose.Schema({
  project_id: { type: mongoose.Schema.Types.ObjectId, required: true },
  domain: { type: String, required: true, maxlength: 253 },
  status: { type: String, enum: ASSESSMENT_STATUSES, required: true, default: 'pending' },
  requested_at: { type: Date, default: null },
  started_at: { type: Date, default: null },
  finished_at: { type: Date, default: null },
  attempts: { type: Number, default: 0 },
  next_attempt_at: { type: Date, default: null },
  lease_owner: { type: String, default: null, maxlength: 80 },
  lease_until: { type: Date, default: null },
  last_error_code: { type: String, default: null, maxlength: 60 },
  // Set by "check this site again": the next run must read the website itself, not reuse facts cached by an earlier (or failed) read.
  force_refetch: { type: Boolean, default: false },
  auto: { type: autoSchema, default: undefined },
  override: { type: overrideSchema, default: null },
}, { collection: 'project_competitor_assessments', timestamps: true });

export const ASSESSMENT_UNIQUE_INDEX = 'project_competitor_assessment_unique';
assessmentSchema.index({ project_id: 1, domain: 1 }, { unique: true, name: ASSESSMENT_UNIQUE_INDEX });
assessmentSchema.index({ status: 1, next_attempt_at: 1, lease_until: 1 }, { name: 'project_competitor_assessment_queue' });

const CompetitorAssessment = mongoose.models.CompetitorAssessment || mongoose.model('CompetitorAssessment', assessmentSchema);
export default CompetitorAssessment;
