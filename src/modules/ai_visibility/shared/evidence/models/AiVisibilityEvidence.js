import mongoose from 'mongoose';
import { GROUPS } from '../../questions/config/questionConfig.js';

/**
 * One piece of AI-visibility EVIDENCE: what one provider answered to one approved question in one run. Provider-independent
 * (`provider` says which collector produced it), so Gemini / Perplexity / Google AI Overview results can use the same collection.
 *
 * Why a separate collection (not an array on the run): an approved-question run holds up to ~50 answers of several KB each, results are
 * written one at a time as they arrive, and history is queried by project / question / provider across runs.
 *
 * Reusable question DEFINITIONS live in `ai_visibility_question_sets`; this holds only what happened when one was asked. The question
 * text is copied here (and into the run's snapshot) on purpose: later edits or archiving of a question set never change evidence.
 *
 * Lifecycle of a document:  pending -> running -> succeeded | failed          (skipped = never sent: cancel, cost guard, fatal provider error)
 *   - documents are created `pending` for every snapshotted question when a worker first prepares the run (unique {runId, questionId}
 *     makes that idempotent, so a recovered run never duplicates evidence);
 *   - a question is claimed `pending -> running`; a worker that dies leaves it `running`, and the next owner of the run resets it to `pending`;
 *   - succeeded / failed / skipped are final and are never overwritten.
 *
 * Cost: `cost` is the provider-reported number as reported; null with costStatus 'unknown' means the provider did not report one (NOT zero).
 * No raw provider payload and no request credentials are stored. Retention: `retainUntil` + a TTL index (see config evidenceRetentionDays).
 */
export const EVIDENCE_SCHEMA_VERSION = 1;
export const EVIDENCE_STATUS = Object.freeze({ PENDING: 'pending', RUNNING: 'running', SUCCEEDED: 'succeeded', FAILED: 'failed', SKIPPED: 'skipped' });

const citationSchema = new mongoose.Schema({
  url: { type: String, required: true },
  normalizedUrl: { type: String, default: null },
  host: { type: String, default: null },
  title: { type: String, default: null },
  isTarget: { type: Boolean, default: false },
  position: { type: Number, default: null }, // 1-based order the answer cites it in
  valid: { type: Boolean, default: true },
}, { _id: false });

const evidenceSchema = new mongoose.Schema({
  schemaVersion: { type: Number, default: EVIDENCE_SCHEMA_VERSION },
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'SeoProject', required: true },
  runId: { type: mongoose.Schema.Types.ObjectId, ref: 'ChatGptVisibilityRun', required: true },
  provider: { type: String, required: true, default: 'chatgpt' },
  questionSetId: { type: mongoose.Schema.Types.ObjectId, ref: 'AiVisibilityQuestionSet', required: true },
  questionSetVersion: { type: Number, required: true },

  // The question as it was asked (copied from the run snapshot).
  questionId: { type: String, required: true },
  group: { type: String, enum: Object.values(GROUPS), required: true },
  intent: { type: String, required: true },
  questionText: { type: String, required: true },
  service: { type: String, default: null },
  location: { type: String, default: null },
  language: { type: String, default: 'en' },
  templateId: { type: String, default: null },

  status: { type: String, enum: Object.values(EVIDENCE_STATUS), default: EVIDENCE_STATUS.PENDING, required: true },
  attempts: { type: Number, default: 0 }, // provider requests actually sent (retries included)
  claimedBy: { type: String, default: null },
  claimedAt: { type: Date, default: null },

  // Collection details: what was REQUESTED (server config) and what the provider REPORTED.
  model: { type: String, default: null },
  modelReported: { type: String, default: null },
  webSearch: { type: Boolean, default: null },
  country: { type: String, default: null },
  city: { type: String, default: null },
  // How location was applied: provider setting vs question text only. Never inferred.
  locationApplied: { type: String, enum: ['provider_country', 'provider_country_city', 'none'], default: 'none' },

  answerText: { type: String, default: null },
  annotations: { type: [{ _id: false, title: { type: String, default: null }, url: { type: String, required: true } }], default: [] },
  citations: { type: [citationSchema], default: [] },
  firstPartyPages: { type: [String], default: [] }, // distinct normalized target-domain URLs
  externalDomains: { type: [String], default: [] }, // distinct hosts of non-target citations

  analysis: {
    brandMentioned: { type: Boolean, default: null },
    brandMentionCount: { type: Number, default: null },
    // Heuristic (see recommendationDetection.js): the brand is presented as an option/recommendation, not merely named.
    recommended: { type: Boolean, default: null },
    recommendationMethod: { type: String, default: null },
    competitorMentions: { type: mongoose.Schema.Types.Mixed, default: [] },
    // Citation signals (classifyCitations): separate on purpose.
    officialCited: { type: Boolean, default: null }, // an actual citation on the verified official domain
    thirdPartyCited: { type: Boolean, default: null }, // an actual citation on any other site
    officialDomainInText: { type: Boolean, default: null }, // the domain written in the text, not linked
    brandListPosition: { type: Number, default: null }, // position among the answer list items
    officialDomain: { type: String, default: null }, // the domain checked against (the run target host)
  },

  cost: { type: Number, default: null },
  costStatus: { type: String, enum: ['reported', 'unknown', 'not_applicable'], default: 'not_applicable' },
  costUnit: { type: String, default: null },
  providerRequestId: { type: String, default: null },
  usage: { inputTokens: { type: Number, default: null }, outputTokens: { type: Number, default: null } },

  errorCode: { type: String, default: null },
  // retryable | non_retryable | fatal (account-level) | parse (provider answered but unusable) | cancelled | budget | not_executed
  errorClass: { type: String, default: null },
  retryable: { type: Boolean, default: null },

  startedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  durationMs: { type: Number, default: null },
  createdAt: { type: Date, default: Date.now },
  retainUntil: { type: Date, default: null },
}, { collection: 'ai_visibility_evidence', timestamps: false, strict: true });

// Idempotent preparation + the "never two results for one question in one run" guarantee.
evidenceSchema.index({ runId: 1, questionId: 1 }, { unique: true, name: 'unique_evidence_per_run_question' });
evidenceSchema.index({ projectId: 1, runId: 1, status: 1 });
evidenceSchema.index({ projectId: 1, questionId: 1, createdAt: -1 }); // one question's history across runs / set versions
evidenceSchema.index({ projectId: 1, provider: 1, createdAt: -1 });
evidenceSchema.index({ runId: 1, group: 1, intent: 1 });
evidenceSchema.index({ retainUntil: 1 }, { expireAfterSeconds: 0, name: 'evidence_retention_ttl' }); // documents with no retainUntil never expire

const AiVisibilityEvidence = mongoose.models.AiVisibilityEvidence || mongoose.model('AiVisibilityEvidence', evidenceSchema);
export default AiVisibilityEvidence;
