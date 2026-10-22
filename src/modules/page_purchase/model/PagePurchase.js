import mongoose from 'mongoose';

/**
 * A one-time "Buy More Pages" purchase — permanently raises
 * subscription.pages.limit, never touches subscription.plan/status or
 * credits. Deliberately a SEPARATE model/collection from Transaction
 * (subscription billing history) — this is not a subscription event.
 *
 * Created as 'pending' by the checkout endpoint (controller/
 * pagePurchaseController.js) at the same moment the Stripe Checkout
 * Session is created, then flipped to 'paid'/'failed' by the webhook
 * (service/pagePurchaseWebhookService.js) once Stripe confirms payment —
 * one document, updated in place, never a second row for the same
 * session. The webhook is what actually grants pages; this document is
 * the audit trail of that decision, not the trigger for it.
 *
 * `pricePaid` follows the same convention as Transaction.amount — the
 * currency's smallest unit (cents), never a float.
 */
const pagePurchaseSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  // Which project's URL Selection screen the purchase was initiated from,
  // if any — nullable since this modal is designed to be reusable from
  // Dashboard/Settings/Subscription too, where there is no single project
  // in context.
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SeoProject',
    default: null,
  },
  pagesPurchased: {
    type: Number,
    required: true,
    min: 1,
  },
  pricePaid: {
    type: Number,
    required: true,
    min: 0,
  },
  currency: {
    type: String,
    required: true,
    default: 'usd',
  },
  // The natural idempotency key for this document: the checkout endpoint
  // creates exactly one PagePurchase per Stripe Checkout Session, and the
  // webhook updates that same row by this field rather than ever creating
  // a second one for the same session (see the webhook service's own
  // comments for the defense-in-depth fallback path).
  stripeSessionId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  paymentIntentId: {
    type: String,
    default: null,
  },
  // Stripe's own hosted invoice page/PDF for this purchase — only
  // populated once `invoice_creation` is enabled on the Checkout Session
  // (stripeService.createOneTimePaymentSession) and the webhook fetches
  // it (service/pagePurchaseWebhookService.js). Existing rows predating
  // this field simply read back `null` — no migration needed.
  hostedInvoiceUrl: {
    type: String,
    default: null,
  },
  invoicePdfUrl: {
    type: String,
    default: null,
  },
  status: {
    type: String,
    enum: ['pending', 'paid', 'failed', 'refunded'],
    default: 'pending',
  },
}, {
  timestamps: true,
});

pagePurchaseSchema.index({ userId: 1, createdAt: -1 });

const PagePurchase = mongoose.model('PagePurchase', pagePurchaseSchema);
export default PagePurchase;
