import mongoose from 'mongoose';

/**
 * SocialAIUsage - the usage LEDGER of the Social Media AI calendar: one document per (scope, id, calendar month), where scope is
 * `user` (the account that pays) or `project`. It is what makes limits hold on any number of API instances: every reservation and every
 * settlement is ONE conditional update of ONE document, so two requests can never both pass a limit that only has room for one.
 *
 *   committedPosts   posts that were really generated (saved) in this period
 *   reservations     posts promised to generations that are running right now: { calendar_id, posts, at, base* }. A reservation counts
 *                    against the limit while it exists and is removed (atomically, together with the commit) when the run stops.
 *                    Its length is also the number of generations in flight (the concurrency cap).
 *   aiCalls / tokens / estimatedCostUsd   what the provider reported (cost only when per-token prices are configured - Odito does not invent prices)
 *
 * The `base*` fields record where the calendar stood when the reservation was made, so settling computes exactly what THIS run added:
 * a resumed calendar is never charged again for the posts it already had.
 */
const reservationSchema = new mongoose.Schema({
  calendar_id: { type: mongoose.Schema.Types.ObjectId, required: true },
  posts: { type: Number, required: true, min: 0 },
  at: { type: Date, required: true },
  baseSaved: { type: Number, default: 0 },
  baseInputTokens: { type: Number, default: 0 },
  baseOutputTokens: { type: Number, default: 0 },
  baseAiCalls: { type: Number, default: 0 },
}, { _id: false });

const socialAIUsageSchema = new mongoose.Schema({
  scope: { type: String, enum: ['user', 'project'], required: true },
  scope_id: { type: mongoose.Schema.Types.ObjectId, required: true },
  period: { type: String, required: true, match: /^\d{4}-\d{2}$/ }, // UTC calendar month, "2026-10"
  committedPosts: { type: Number, default: 0, min: 0 },
  aiCalls: { type: Number, default: 0, min: 0 },
  inputTokens: { type: Number, default: 0, min: 0 },
  outputTokens: { type: Number, default: 0, min: 0 },
  estimatedCostUsd: { type: Number, default: 0, min: 0 },
  reservations: { type: [reservationSchema], default: [] },
}, {
  timestamps: true,
  strict: true,
  collection: 'social_ai_usage',
});

socialAIUsageSchema.index({ scope: 1, scope_id: 1, period: 1 }, { unique: true, name: 'unique_usage_scope_period' });
// the reconciliation sweep: ledgers that hold a reservation
socialAIUsageSchema.index({ 'reservations.calendar_id': 1 }, { name: 'usage_by_reservation' });

const SocialAIUsage = mongoose.model('SocialAIUsage', socialAIUsageSchema);
export default SocialAIUsage;
