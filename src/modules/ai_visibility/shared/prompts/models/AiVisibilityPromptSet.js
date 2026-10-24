import mongoose from 'mongoose';
import { PROMPT_CATEGORIES, GENERATED_BY } from '../config/promptConfig.js';

/**
 * A versioned, validated five-prompt set for one project. Provider-independent: ChatGPT today, Claude/Gemini later all
 * read the same documents. Sets are immutable history - a changed profile produces a NEW version, never an edit.
 *
 * Indexes enforce the two concurrency guarantees:
 *   {projectId, version}                            unique - two writers can never take the same version number
 *   {projectId, profileHash, generatorVersion}      unique among sets built from a settled outcome (openai | template),
 *                                                   so concurrent requests for the same profile cannot create duplicate versions
 * A `template_fallback` set (OpenAI failed) is deliberately outside the second index: it is only reused for a short time, after
 * which a later request may create a better (openai) set for the same profile.
 *
 * Collection name: ai_visibility_prompt_sets (provider-neutral on purpose).
 */
const promptSchema = new mongoose.Schema({
  category: { type: String, enum: PROMPT_CATEGORIES, required: true },
  text: { type: String, required: true },
  branded: { type: Boolean, required: true },
  usesService: { type: Boolean, required: true },
  usesCompetitors: { type: Boolean, required: true },
}, { _id: false });

const promptSetSchema = new mongoose.Schema({
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'SeoProject', required: true },
  version: { type: Number, required: true, min: 1 },
  profileHash: { type: String, required: true },
  generatorVersion: { type: String, required: true },
  // The validated facts the prompts were built from (no description, no keywords): what makes a set reproducible and auditable.
  inputSnapshot: { type: mongoose.Schema.Types.Mixed, required: true },
  prompts: { type: [promptSchema], required: true },
  generatedBy: { type: String, enum: Object.values(GENERATED_BY), required: true },
  fallbackReason: { type: String, default: null },
  model: { type: String, default: null },
  promptLanguage: { type: String, default: 'en' },
  tokenUsage: {
    inputTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
  },
  createdAt: { type: Date, default: Date.now },
}, { collection: 'ai_visibility_prompt_sets', timestamps: false });

promptSetSchema.index({ projectId: 1, version: 1 }, { unique: true, name: 'unique_project_version' });
promptSetSchema.index(
  { projectId: 1, profileHash: 1, generatorVersion: 1 },
  {
    unique: true,
    name: 'unique_settled_set_per_profile',
    partialFilterExpression: { generatedBy: { $in: [GENERATED_BY.OPENAI, GENERATED_BY.TEMPLATE] } },
  },
);
promptSetSchema.index({ projectId: 1, createdAt: -1 });

const AiVisibilityPromptSet = mongoose.models.AiVisibilityPromptSet || mongoose.model('AiVisibilityPromptSet', promptSetSchema);
export default AiVisibilityPromptSet;
