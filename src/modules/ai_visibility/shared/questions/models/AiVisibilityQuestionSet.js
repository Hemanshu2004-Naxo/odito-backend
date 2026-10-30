import mongoose from 'mongoose';
import { GROUPS, INTENT_NAMES, BRAND_INTENT, PRIORITIES, QUESTION_STATUS, GENERATED_BY } from '../config/questionConfig.js';

/**
 * A versioned question set for one project, provider-independent (ChatGPT, Gemini, Perplexity and Google AI Overview
 * collectors will all read the same approved set). Lifecycle: draft -> approved -> archived.
 *
 *   draft      editable by the owner (toggle / reword questions); never executed
 *   approved   IMMUTABLE. This is the fixed set every run is compared against. At most one approved set per project
 *   archived   a previously approved set replaced by a newer approval, or a discarded draft; kept as history
 *
 * Changing the questions means creating a new version, so a trend line never mixes two different question lists.
 * Collection: ai_visibility_question_sets.
 */
const questionSchema = new mongoose.Schema({
  id: { type: String, required: true },
  group: { type: String, enum: Object.values(GROUPS), required: true },
  text: { type: String, required: true },
  intent: { type: String, enum: [...INTENT_NAMES, BRAND_INTENT], required: true },
  // What the question is about (service / problem / requirement / ...), whether it names the business, and its meaning key
  // (intent | subject | place): two questions with the same key ask the same thing.
  topic: { type: String, default: null },
  brandNamed: { type: Boolean, default: false },
  semanticKey: { type: String, default: null },
  validationStatus: { type: String, enum: ['passed', 'user_edited'], default: 'passed' },
  service: { type: String, default: null },
  location: { type: String, default: null },
  language: { type: String, default: 'en' },
  templateId: { type: String, default: null },
  priority: { type: String, enum: PRIORITIES, default: 'medium' },
  selectionReason: { type: String, default: '' },
  source: { type: String, enum: ['template', 'openai', 'user'], default: 'template' },
  enabled: { type: Boolean, default: true },
}, { _id: false });

const questionSetSchema = new mongoose.Schema({
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'SeoProject', required: true },
  version: { type: Number, required: true, min: 1 },
  status: { type: String, enum: Object.values(QUESTION_STATUS), default: QUESTION_STATUS.DRAFT, required: true },
  profileHash: { type: String, required: true },
  generatorVersion: { type: String, required: true },
  // The sanitised confirmed inputs the set was built from: what makes it reproducible and auditable.
  inputs: { type: mongoose.Schema.Types.Mixed, required: true },
  language: { type: String, default: 'en' },
  generatedBy: { type: String, enum: Object.values(GENERATED_BY), required: true },
  fallbackReason: { type: String, default: null },
  model: { type: String, default: null },
  questions: { type: [questionSchema], default: [] },
  missingBusinessInformation: { type: [String], default: [] },
  warnings: { type: [String], default: [] },
  // generated / accepted / rejected (+ reason codes) / duplicatesRemoved / per-intent coverage (questionGenerationService.buildGenerationReport)
  generationReport: { type: mongoose.Schema.Types.Mixed, default: null },
  tokenUsage: { inputTokens: { type: Number, default: 0 }, outputTokens: { type: Number, default: 0 } },
  createdBy: { type: mongoose.Schema.Types.ObjectId, default: null },
  approvedAt: { type: Date, default: null },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
  archivedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
}, { collection: 'ai_visibility_question_sets', timestamps: false });

questionSetSchema.index({ projectId: 1, version: 1 }, { unique: true, name: 'unique_project_question_version' });
// The database, not application code, guarantees there is never more than one approved set per project.
questionSetSchema.index(
  { projectId: 1 },
  { unique: true, name: 'one_approved_question_set_per_project', partialFilterExpression: { status: QUESTION_STATUS.APPROVED } },
);
questionSetSchema.index({ projectId: 1, createdAt: -1 });

const AiVisibilityQuestionSet = mongoose.models.AiVisibilityQuestionSet || mongoose.model('AiVisibilityQuestionSet', questionSetSchema);
export default AiVisibilityQuestionSet;
