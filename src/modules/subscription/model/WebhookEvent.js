import mongoose from 'mongoose';

/**
 * Idempotency + audit log for incoming Stripe webhook events. Exists only
 * for this purpose — it is not a business-data model.
 *
 * The unique index on `stripeEventId` is the entire idempotency mechanism:
 * `WebhookEvent.create({stripeEventId, ...})` is attempted first, before
 * any business logic runs. If Stripe redelivers the same event (which it
 * does, by design, on any non-2xx response or just as a network retry),
 * the second `create()` call fails with a MongoDB duplicate-key error
 * (code 11000) and the handler returns success having executed zero
 * business logic — see subscriptionWebhookService.js.
 */
const webhookEventSchema = new mongoose.Schema({
  stripeEventId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  eventType: {
    type: String,
    required: true,
  },
  processedAt: {
    type: Date,
    default: null,
  },
  status: {
    type: String,
    enum: ['processing', 'completed', 'failed', 'ignored'],
    default: 'processing',
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
  processingError: {
    type: String,
    default: null,
  },
}, {
  timestamps: true,
});

const WebhookEvent = mongoose.model('WebhookEvent', webhookEventSchema);
export default WebhookEvent;
