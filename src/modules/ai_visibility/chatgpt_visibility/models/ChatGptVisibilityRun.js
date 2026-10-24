import mongoose from 'mongoose';
import { PROMPT_CATEGORIES } from '../../shared/prompts/config/promptConfig.js';

/**
 * One ChatGPT Visibility run: five sampled prompt executions plus their metrics, for one project (and, for automatic runs,
 * one full-audit run). Lives in its OWN collection - never in `jobs` - because the SEO recrawl deletes every project job and the
 * SEO stale-lock sweep advances the audit pipeline for any stuck job; neither may touch visibility history.
 *
 * Lifecycle:  queued -> running -> completed | partial | failed | cancelled        (skipped = recorded but never run)
 *   completed  all five executions succeeded
 *   partial    some succeeded, some failed/skipped: metrics are computed over the successes only
 *   failed     nothing succeeded (or the run could not start, e.g. the profile is unusable)
 *   skipped    an automatic trigger was refused by a cost/abuse limit; the document is the durable "decision made" record
 *
 * Concurrency / idempotency (all enforced by indexes):
 *   unique {projectId, auditRunId}      one run per full-audit run (partial: only when auditRunId is set)
 *   unique {projectId} while active     at most one queued|running run per project
 * Ownership of a running run is a lease (lockedBy + lease.expiresAt) renewed by a heartbeat; every write by a worker is
 * conditional on still being the owner.
 */
const annotationSchema = new mongoose.Schema({
  title: { type: String, default: null },
  url: { type: String, required: true },
}, { _id: false });

const executionSchema = new mongoose.Schema({
  category: { type: String, enum: PROMPT_CATEGORIES, required: true },
  branded: { type: Boolean, required: true },
  promptText: { type: String, required: true },
  status: { type: String, enum: ['pending', 'succeeded', 'failed', 'skipped'], default: 'pending' },
  attempts: { type: Number, default: 0 },
  providerRequestId: { type: String, default: null },
  model: { type: String, default: null },
  webSearch: { type: Boolean, default: null },
  country: { type: String, default: null },
  city: { type: String, default: null },
  answerText: { type: String, default: null },
  annotations: { type: [annotationSchema], default: [] },
  analysis: { type: mongoose.Schema.Types.Mixed, default: null },
  // Provider-reported cost, as reported. null = the provider did not report one (NOT zero).
  cost: { type: Number, default: null },
  usage: {
    inputTokens: { type: Number, default: null },
    outputTokens: { type: Number, default: null },
  },
  errorCode: { type: String, default: null },
  retryable: { type: Boolean, default: null },
  executedAt: { type: Date, default: null },
  durationMs: { type: Number, default: null },
}, { _id: false });

const runSchema = new mongoose.Schema({
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'SeoProject', required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  // SeoProject.current_run_id of the full audit this run belongs to. null for a manually started run.
  auditRunId: { type: mongoose.Schema.Types.ObjectId, default: null },
  trigger: {
    source: { type: String, enum: ['audit', 'repair', 'manual'], required: true },
    auditRunSource: { type: String, default: null }, // initial_audit | manual_recrawl | ...
  },

  // How this run chooses what to ask. Documents written before this field existed are `legacy_prompts` (the default), so history
  // keeps its meaning:
  //   legacy_prompts      the five generated prompts, results embedded in `executions`
  //   approved_questions  an immutable snapshot of the project's APPROVED question set, results in `ai_visibility_evidence`
  executionMode: { type: String, enum: ['legacy_prompts', 'approved_questions'], default: 'legacy_prompts' },
  provider: { type: String, default: 'chatgpt' },
  questionSetId: { type: mongoose.Schema.Types.ObjectId, ref: 'AiVisibilityQuestionSet', default: null },
  questionSetVersion: { type: Number, default: null },
  // The exact questions this run asks, copied at creation. Written once; later edits / archiving of the set cannot change a run.
  questionSnapshot: {
    type: [new mongoose.Schema({
      questionId: { type: String, required: true },
      group: { type: String, required: true },
      intent: { type: String, required: true },
      text: { type: String, required: true },
      service: { type: String, default: null },
      location: { type: String, default: null },
      language: { type: String, default: 'en' },
      templateId: { type: String, default: null },
      priority: { type: String, default: 'medium' },
      // City sent to the provider for THIS question (a confirmed target city the question names), else null = use the project's city.
      searchCity: { type: String, default: null },
    }, { _id: false })],
    default: undefined,
  },
  // Server policy in force when the run was created (what was applied, for audit). Never taken from a request.
  policy: { type: mongoose.Schema.Types.Mixed, default: null },
  questionStats: {
    total: { type: Number, default: 0 },
    succeeded: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    skipped: { type: Number, default: 0 },
    pending: { type: Number, default: 0 },
  },

  promptSetId: { type: mongoose.Schema.Types.ObjectId, ref: 'AiVisibilityPromptSet', default: null },
  promptSetVersion: { type: Number, default: null },
  promptGeneratedBy: { type: String, default: null },
  promptTokenUsage: {
    inputTokens: { type: Number, default: null },
    outputTokens: { type: Number, default: null },
  },

  status: { type: String, enum: ['queued', 'running', 'completed', 'partial', 'failed', 'cancelled', 'skipped'], default: 'queued' },
  attempts: { type: Number, default: 0 }, // worker claims (crash-recovery bound), not provider requests
  lockedBy: { type: String, default: null },
  lease: { expiresAt: { type: Date, default: null } },
  heartbeatAt: { type: Date, default: null },
  cancelRequested: { type: Boolean, default: false },
  progress: {
    completed: { type: Number, default: 0 },
    total: { type: Number, default: 5 },
    stage: { type: String, default: 'queued' },
  },

  startedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  failedAt: { type: Date, default: null },
  failureCode: { type: String, default: null },
  failureMessage: { type: String, default: null },

  // What the run measured against (names, competitors, host, reliability) and where (market): a reproducible snapshot.
  target: { type: mongoose.Schema.Types.Mixed, default: null },
  market: { type: mongoose.Schema.Types.Mixed, default: null },

  executions: { type: [executionSchema], default: [] },
  metrics: { type: mongoose.Schema.Types.Mixed, default: null },
  totalCost: {
    amount: { type: Number, default: null },
    unit: { type: String, default: null },
    unknownCount: { type: Number, default: 0 }, // successful executions whose cost the provider did not report
  },
}, { collection: 'chatgpt_visibility_runs', timestamps: true, strict: true });

runSchema.index({ projectId: 1, auditRunId: 1 }, { unique: true, name: 'unique_run_per_audit_run', partialFilterExpression: { auditRunId: { $type: 'objectId' } } });
runSchema.index({ projectId: 1 }, { unique: true, name: 'one_active_run_per_project', partialFilterExpression: { status: { $in: ['queued', 'running'] } } });
runSchema.index({ projectId: 1, createdAt: -1 });
runSchema.index({ status: 1, 'lease.expiresAt': 1 });
runSchema.index({ userId: 1, createdAt: -1 });
runSchema.index({ projectId: 1, executionMode: 1, createdAt: -1 });

const ChatGptVisibilityRun = mongoose.models.ChatGptVisibilityRun || mongoose.model('ChatGptVisibilityRun', runSchema);
export default ChatGptVisibilityRun;
