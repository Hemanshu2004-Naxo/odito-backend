import mongoose from 'mongoose';
import User from '../../user/model/User.js';
import Transaction from '../../subscription/model/Transaction.js';
import PagePurchase from '../../page_purchase/model/PagePurchase.js';
import CreditPurchase from '../../credit_purchase/model/CreditPurchase.js';

/**
 * Payments & Billing (Phase 2E) — the ONE shared normalizer for merging
 * Transaction/PagePurchase/CreditPurchase into a single payment shape.
 * Every row, regardless of source, ends up with: user, paymentType, amount,
 * currency, status, hostedInvoiceUrl/invoicePdfUrl, createdAt.
 *
 * This exists in two forms because a Mongo aggregation pipeline can't call
 * a JS function — buildUnifiedPaymentsPipeline() below is the pipeline-stage
 * form (used by listPayments/getPaymentsSummary, runs entirely in MongoDB,
 * no per-row Node work), and normalizeDetailDoc() further down is the JS
 * form (used by getPaymentDetail on one already-fetched document). Both
 * encode the exact same field-mapping rules; kept in this one file, next to
 * each other, specifically so they can't drift apart.
 *
 * Deliberately does NOT touch subscriptionController.js's private
 * serializeTransaction/serializePagePurchase/serializeCreditPurchase (used
 * by GET /subscription/history) — that is the real "Billing History
 * implementation" Phase 2E is told not to modify. This is a new, dedicated
 * normalizer for the System Admin payments module.
 */

const PAYMENT_TYPES = ['subscription', 'additional_credits', 'additional_pages'];
const PAYMENT_STATUSES = ['paid', 'pending', 'failed', 'refunded', 'canceled'];

const SORT_OPTIONS = {
  newest: { createdAt: -1 },
  oldest: { createdAt: 1 },
  amount: { amount: -1 },
  status: { status: 1 },
  type: { paymentType: 1 },
};

function userJoinStages(localField) {
  return [
    {
      $lookup: {
        from: User.collection.name,
        localField,
        foreignField: '_id',
        as: '_user',
      },
    },
    { $unwind: { path: '$_user', preserveNullAndEmptyArrays: true } },
    {
      $addFields: {
        userId: `$${localField}`,
        userFirstName: '$_user.firstName',
        userLastName: '$_user.lastName',
        userEmail: '$_user.email',
        userAvatar: '$_user.avatar',
      },
    },
  ];
}

const COMMON_PROJECTION = {
  source: 1,
  paymentType: 1,
  status: 1,
  amount: 1,
  currency: 1,
  hostedInvoiceUrl: 1,
  invoicePdfUrl: 1,
  createdAt: 1,
  userId: 1,
  userFirstName: 1,
  userLastName: 1,
  userEmail: 1,
  userAvatar: 1,
};

function transactionPipeline() {
  return [
    ...userJoinStages('user'),
    {
      $addFields: {
        source: 'transaction',
        paymentType: 'subscription',
        // Transaction.status only ever holds succeeded/failed/canceled —
        // 'refunded' isn't a status value on this model, it's a `type`
        // event. Reading type first (before falling back to status) is
        // what lets a refunded subscription payment surface as
        // status:'refunded' in the unified vocabulary instead of
        // incorrectly staying 'paid'.
        status: {
          $switch: {
            branches: [
              { case: { $eq: ['$type', 'refunded'] }, then: 'refunded' },
              { case: { $eq: ['$type', 'cancelled'] }, then: 'canceled' },
              { case: { $eq: ['$type', 'payment_failed'] }, then: 'failed' },
              { case: { $eq: ['$status', 'succeeded'] }, then: 'paid' },
            ],
            default: '$status',
          },
        },
      },
    },
    { $project: COMMON_PROJECTION },
  ];
}

function pagePurchasePipeline() {
  return [
    ...userJoinStages('userId'),
    {
      $addFields: {
        source: 'page_purchase',
        paymentType: 'additional_pages',
        amount: '$pricePaid',
      },
    },
    { $project: COMMON_PROJECTION },
  ];
}

function creditPurchasePipeline() {
  return [
    ...userJoinStages('userId'),
    {
      $addFields: {
        source: 'credit_purchase',
        paymentType: 'additional_credits',
        amount: '$pricePaid',
      },
    },
    { $project: COMMON_PROJECTION },
  ];
}

/**
 * The single base pipeline both listPayments() and getPaymentsSummary()
 * build on — normalizes and unions all 3 sources exactly once per call,
 * nothing computed twice. Must be run via Transaction.aggregate(...) (the
 * first stages implicitly operate on Transaction's own documents; the two
 * $unionWith stages bring in the other two collections through their own
 * normalize pipelines).
 */
function buildUnifiedPaymentsPipeline() {
  return [
    ...transactionPipeline(),
    { $unionWith: { coll: PagePurchase.collection.name, pipeline: pagePurchasePipeline() } },
    { $unionWith: { coll: CreditPurchase.collection.name, pipeline: creditPurchasePipeline() } },
  ];
}

function buildMatchStage({ search, paymentType, status, invoice, currency }) {
  const match = {};

  if (search && String(search).trim()) {
    const term = String(search).trim();
    match.$or = [
      { userFirstName: { $regex: term, $options: 'i' } },
      { userLastName: { $regex: term, $options: 'i' } },
      { userEmail: { $regex: term, $options: 'i' } },
    ];
  }

  if (paymentType && PAYMENT_TYPES.includes(paymentType)) match.paymentType = paymentType;
  if (status && PAYMENT_STATUSES.includes(status)) match.status = status;

  if (invoice === 'available') match.hostedInvoiceUrl = { $ne: null };
  else if (invoice === 'unavailable') match.hostedInvoiceUrl = null;

  if (currency && String(currency).trim()) match.currency = String(currency).trim().toLowerCase();

  return match;
}

function serializeListRow(row) {
  return {
    id: `${row.source}:${row._id}`,
    paymentType: row.paymentType,
    user: row.userId
      ? {
          id: row.userId,
          firstName: row.userFirstName || null,
          lastName: row.userLastName || null,
          email: row.userEmail || null,
          avatar: row.userAvatar || null,
        }
      : null,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    hostedInvoiceUrl: row.hostedInvoiceUrl || null,
    invoicePdfUrl: row.invoicePdfUrl || null,
    createdAt: row.createdAt,
  };
}

/**
 * List + search + filter + sort + paginate across all 3 payment sources —
 * ONE aggregation call, entirely server-side in MongoDB. No Stripe API call
 * anywhere in this function (Step 13's explicit requirement) and no N+1:
 * the $lookup happens once per source pipeline, not once per row.
 */
const listPayments = async ({ page, limit, search, paymentType, status, invoice, currency, sort }) => {
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const skip = (pageNum - 1) * limitNum;

  const matchStage = buildMatchStage({ search, paymentType, status, invoice, currency });
  const sortSpec = SORT_OPTIONS[sort] || SORT_OPTIONS.newest;

  const pipeline = [
    ...buildUnifiedPaymentsPipeline(),
    ...(Object.keys(matchStage).length ? [{ $match: matchStage }] : []),
    {
      $facet: {
        data: [{ $sort: sortSpec }, { $skip: skip }, { $limit: limitNum }],
        totalCount: [{ $count: 'count' }],
        currencies: [{ $group: { _id: '$currency' } }, { $sort: { _id: 1 } }],
      },
    },
  ];

  const [result] = await Transaction.aggregate(pipeline);
  const total = result?.totalCount?.[0]?.count || 0;
  const currencies = (result?.currencies || []).map((c) => c._id).filter(Boolean);

  return {
    payments: (result?.data || []).map(serializeListRow),
    pagination: {
      page: pageNum,
      limit: limitNum,
      total,
      pages: Math.max(1, Math.ceil(total / limitNum)),
    },
    filters: { currencies },
  };
};

/**
 * Platform-wide revenue/status rollup for the 6 summary cards. Same base
 * pipeline as listPayments (via buildUnifiedPaymentsPipeline) — one more
 * aggregation call, not a re-fetch of the same data through a second code
 * path.
 */
const getPaymentsSummary = async () => {
  const pipeline = [
    ...buildUnifiedPaymentsPipeline(),
    {
      $facet: {
        totalRevenue: [{ $match: { status: 'paid' } }, { $group: { _id: null, total: { $sum: '$amount' } } }],
        subscriptionRevenue: [
          { $match: { status: 'paid', paymentType: 'subscription' } },
          { $group: { _id: null, total: { $sum: '$amount' } } },
        ],
        creditsRevenue: [
          { $match: { status: 'paid', paymentType: 'additional_credits' } },
          { $group: { _id: null, total: { $sum: '$amount' } } },
        ],
        pagesRevenue: [
          { $match: { status: 'paid', paymentType: 'additional_pages' } },
          { $group: { _id: null, total: { $sum: '$amount' } } },
        ],
        pendingCount: [{ $match: { status: 'pending' } }, { $count: 'count' }],
        failedCount: [{ $match: { status: 'failed' } }, { $count: 'count' }],
      },
    },
  ];

  const [result] = await Transaction.aggregate(pipeline);
  const cents = (facet) => result?.[facet]?.[0]?.total || 0;
  const count = (facet) => result?.[facet]?.[0]?.count || 0;

  const toDollars = (c) => Math.round(c) / 100;

  return {
    totalRevenue: toDollars(cents('totalRevenue')),
    subscriptionRevenue: toDollars(cents('subscriptionRevenue')),
    additionalCreditsRevenue: toDollars(cents('creditsRevenue')),
    additionalPagesRevenue: toDollars(cents('pagesRevenue')),
    pendingPayments: count('pendingCount'),
    failedPayments: count('failedCount'),
  };
};

const SOURCE_MODEL = {
  transaction: Transaction,
  page_purchase: PagePurchase,
  credit_purchase: CreditPurchase,
};

function normalizeDetailDoc(source, doc, user) {
  const isTransaction = source === 'transaction';

  const paymentType = isTransaction
    ? 'subscription'
    : source === 'page_purchase'
      ? 'additional_pages'
      : 'additional_credits';

  const amount = isTransaction ? doc.amount : doc.pricePaid;

  let status;
  if (isTransaction) {
    if (doc.type === 'refunded') status = 'refunded';
    else if (doc.type === 'cancelled') status = 'canceled';
    else if (doc.type === 'payment_failed') status = 'failed';
    else status = doc.status === 'succeeded' ? 'paid' : doc.status;
  } else {
    status = doc.status;
  }

  return {
    id: `${source}:${doc._id}`,
    paymentType,
    amount,
    currency: doc.currency,
    status,
    createdAt: doc.createdAt,
    customer: user
      ? { id: user._id, firstName: user.firstName, lastName: user.lastName, email: user.email }
      : null,
    // Display-safe reference IDs only — never a client_secret, webhook
    // secret, or API key. stripeCustomerId comes from the user's
    // subscription block (none of the 3 payment models store it directly).
    stripe: {
      checkoutSessionId: isTransaction ? doc.stripeCheckoutSessionId || null : doc.stripeSessionId || null,
      invoiceId: isTransaction ? doc.stripeInvoiceId || null : null,
      paymentIntentId: isTransaction ? doc.stripePaymentIntentId || null : doc.paymentIntentId || null,
      subscriptionId: isTransaction ? doc.stripeSubscriptionId || null : null,
      customerId: user?.subscription?.stripeCustomerId || null,
    },
    invoice: {
      hostedInvoiceUrl: doc.hostedInvoiceUrl || null,
      invoicePdfUrl: doc.invoicePdfUrl || null,
    },
  };
}

/**
 * paymentId is "<source>:<objectId>" (e.g. "transaction:65f1a2..."),
 * produced by serializeListRow above — the composite id is how the list
 * and detail endpoints agree on which of the 3 collections a given payment
 * lives in without a 3-way probe query.
 */
const getPaymentDetail = async (paymentId) => {
  const [source, rawId] = String(paymentId).split(':');
  const Model = SOURCE_MODEL[source];
  if (!Model || !rawId || !mongoose.Types.ObjectId.isValid(rawId)) return null;

  const doc = await Model.findById(rawId).lean();
  if (!doc) return null;

  const userId = source === 'transaction' ? doc.user : doc.userId;
  const user = await User.findById(userId)
    .select('firstName lastName email subscription.stripeCustomerId')
    .lean();

  return normalizeDetailDoc(source, doc, user);
};

export { listPayments, getPaymentsSummary, getPaymentDetail };
