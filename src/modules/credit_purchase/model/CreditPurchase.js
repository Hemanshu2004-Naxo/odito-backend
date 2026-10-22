import mongoose from 'mongoose';

/**
 * A one-time "Buy Credits" purchase — permanently raises
 * subscription.credits.limit, never touches subscription.plan/status,
 * pages, or credits.used. The CreditPurchase counterpart to
 * modules/page_purchase/model/PagePurchase.js — same shape, same
 * lifecycle, deliberately a SEPARATE collection from both Transaction
 * (subscription billing history) and PagePurchase (this is neither a
 * subscription event nor a page-quota purchase).
 *
 * Created as 'pending' by the checkout endpoint (controller/
 * creditPurchaseController.js) at the same moment the Stripe Checkout
 * Session is created, then flipped to 'paid'/'failed' by the webhook
 * (service/creditPurchaseWebhookService.js) once Stripe confirms
 * payment — one document, updated in place, never a second row for the
 * same session.
 *
 * `pricePaid` follows the same convention as Transaction.amount /
 * PagePurchase.pricePaid — the currency's smallest unit (cents), never a
 * float.
 */
const creditPurchaseSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  creditsPurchased: {
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
  // The natural idempotency key for this document — see PagePurchase.js's
  // own comment for the exact same pattern (checkout creates it once,
  // webhook updates that same row by this field, never a second one).
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
  // it (service/creditPurchaseWebhookService.js). Existing rows predating
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

creditPurchaseSchema.index({ userId: 1, createdAt: -1 });

const CreditPurchase = mongoose.model('CreditPurchase', creditPurchaseSchema);
export default CreditPurchase;
