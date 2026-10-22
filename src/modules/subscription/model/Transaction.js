import mongoose from 'mongoose';

/**
 * User-facing billing history — distinct from WebhookEvent (which is a
 * pure idempotency/audit log with no user reference, no amount, no
 * currency, and cannot serve this purpose without becoming a different
 * model entirely). A Transaction is created by, and only by, the existing
 * webhook handlers in subscriptionWebhookService.js — never a second
 * webhook endpoint, never a separate write path.
 *
 * `amount` is stored in the currency's smallest unit (cents), matching
 * Stripe's own convention throughout its API — never a float.
 *
 * Deliberately does NOT duplicate plan configuration (price, credits,
 * pages, features) — those live exclusively in config/plans.js. This model
 * only ever stores what a billing-history row needs to render itself.
 */
const transactionSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  // The Stripe Subscription this transaction belongs to. Not always present
  // (e.g. absent before a subscription object exists), so not required.
  stripeSubscriptionId: {
    type: String,
    default: null,
    index: true,
  },
  // The originating webhook event id. Required and unique — this is the
  // natural, already-existing idempotency key (see WebhookEvent), reused
  // here rather than inventing a second one. In practice a duplicate can
  // only be attempted if a handler is somehow invoked twice for the same
  // event, which the outer WebhookEvent claim in processStripeEvent()
  // already prevents — this unique index is a data-integrity safety net,
  // not a second idempotency mechanism.
  stripeEventId: {
    type: String,
    required: true,
    unique: true,
  },
  stripeInvoiceId: {
    type: String,
    default: null,
  },
  stripePaymentIntentId: {
    type: String,
    default: null,
  },
  stripeCheckoutSessionId: {
    type: String,
    default: null,
  },
  // Stripe's own hosted invoice page — present on invoice.paid /
  // invoice.payment_failed events, and (Phase 18) fetched directly via
  // stripeService.retrieveInvoice() in handleCheckoutCompleted using
  // session.invoice. Reused as-is; nothing here ever generates a PDF or
  // stores an invoice file. Existing rows predating this field simply
  // read back `null` (Mongoose default) — no migration needed.
  hostedInvoiceUrl: {
    type: String,
    default: null,
  },
  // Stripe's own hosted PDF download link for the same invoice — same
  // source/lifecycle as hostedInvoiceUrl above.
  invoicePdfUrl: {
    type: String,
    default: null,
  },
  amount: {
    type: Number,
    default: null,
  },
  currency: {
    type: String,
    default: null,
  },
  status: {
    type: String,
    enum: ['succeeded', 'failed', 'canceled'],
    required: true,
  },
  type: {
    // 'upgraded'/'downgraded' added in Phase 15 for plan-change events —
    // see handleSubscriptionUpdated() in subscriptionWebhookService.js.
    // Non-monetary, like 'cancelled'/'resumed': amount/currency stay null,
    // since the actual prorated charge (if any) arrives on its own
    // invoice.paid event and is recorded as its own 'renewal' Transaction.
    type: String,
    enum: ['checkout', 'renewal', 'payment_failed', 'cancelled', 'resumed', 'refunded', 'upgraded', 'downgraded'],
    required: true,
  },
}, {
  timestamps: true,
});

// The exact shape GET /subscription/history queries by — newest-first,
// scoped to one user.
transactionSchema.index({ user: 1, createdAt: -1 });

const Transaction = mongoose.model('Transaction', transactionSchema);
export default Transaction;
