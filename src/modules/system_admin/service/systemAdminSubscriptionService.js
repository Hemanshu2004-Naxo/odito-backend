import User from '../../user/model/User.js';
import Transaction from '../../subscription/model/Transaction.js';
import PagePurchase from '../../page_purchase/model/PagePurchase.js';
import CreditPurchase from '../../credit_purchase/model/CreditPurchase.js';
import { getPlan, getActivePlans } from '../../../config/plans.js';
import { summarizeQuota } from '../../../utils/creditService.js';
import { fetchSubscriptionRenewalInfo } from '../../../services/stripeService.js';

// Kept in sync with User.js's subscription.status enum by hand — same
// convention adminSubscriptionController.js/systemAdminUserService.js
// already use. NOTE: there is no 'trial' status in this schema (verified
// against User.js) — omitted here rather than fabricated.
const SUBSCRIPTION_STATUSES = ['inactive', 'active', 'paused', 'canceled', 'past_due'];

// roleId -> name, same small duplicated map as systemAdminUserService.js.
const ROLE_NAMES = { 1: 'systemadmin', 2: 'superadmin', 3: 'admin', 4: 'agency_admin', 5: 'user' };

// Transaction.type -> a human label for the Timeline card. 'refunded' is a
// real enum value not explicitly requested by the spec but included since
// it's real data, not fabricated.
const TRANSACTION_TYPE_LABEL = {
  checkout: 'Activated',
  renewal: 'Renewed',
  payment_failed: 'Payment Failed',
  cancelled: 'Cancelled',
  resumed: 'Resumed',
  refunded: 'Refunded',
  upgraded: 'Upgraded',
  downgraded: 'Downgraded',
};

const SORT_OPTIONS = {
  newest: { createdAt: -1 },
  oldest: { createdAt: 1 },
  plan: { 'subscription.plan': 1 },
  status: { 'subscription.status': 1 },
  updated: { updatedAt: -1 },
  // No renewal date is stored locally (see fetchSubscriptionRenewalInfo's
  // doc comment) and fetching it live per-row would mean one Stripe API
  // call per table row on every page load — so 'renewal' sort degrades to
  // 'updated' rather than either erroring or making that N+1 call.
  renewal: { updatedAt: -1 },
};

const USER_PROJECTION = 'firstName lastName email avatar roleId isActive isEmailVerified createdAt updatedAt subscription';

function getPlanSafe(planId) {
  if (!planId) return null;
  try {
    return getPlan(planId);
  } catch {
    return null;
  }
}

function serializeSubscriptionSummary(user) {
  const { credits, pages } = summarizeQuota(user);
  const plan = getPlanSafe(user.subscription.plan);

  return {
    id: user._id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    avatar: user.avatar,
    plan: plan ? { id: plan.id, name: plan.name } : null,
    status: user.subscription.status,
    credits,
    pages,
    stripeCustomerId: user.subscription.stripeCustomerId || null,
    stripeSubscriptionId: user.subscription.stripeSubscriptionId || null,
    // Locally-derivable proxy only — never a fabricated date. See
    // SORT_OPTIONS.renewal comment for why a real per-row renewal date
    // isn't fetched in a list context.
    autoRenews: Boolean(user.subscription.stripeSubscriptionId) && user.subscription.status === 'active',
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function serializeTimelineEvent(t) {
  return {
    id: t._id,
    date: t.createdAt,
    type: t.type,
    label: TRANSACTION_TYPE_LABEL[t.type] || t.type,
    status: t.status,
    amount: t.amount,
    currency: t.currency,
  };
}

function serializeCreditPurchaseRow(c) {
  return {
    id: c._id,
    date: c.createdAt,
    amount: c.pricePaid,
    currency: c.currency,
    status: c.status,
    creditsPurchased: c.creditsPurchased,
  };
}

function serializePagePurchaseRow(p) {
  return {
    id: p._id,
    date: p.createdAt,
    amount: p.pricePaid,
    currency: p.currency,
    status: p.status,
    pagesPurchased: p.pagesPurchased,
  };
}

/**
 * Sums one model's paid amount for one user under a $match filter. Same
 * $group-sum shape systemAdminDashboardService.js uses platform-wide — this
 * is deliberately a separate, per-user-scoped helper (different filter
 * shape, different metric) rather than importing that one, since reusing it
 * here would mean threading a userId through a function designed for a
 * global total.
 */
async function sumPaidAmount(Model, matchQuery, amountField) {
  const [result] = await Model.aggregate([
    { $match: matchQuery },
    { $group: { _id: null, total: { $sum: `$${amountField}` } } },
  ]);
  return result?.total || 0;
}

async function getBillingSummary(userId) {
  const [transactionCents, creditCents, pageCents, transactionCount] = await Promise.all([
    sumPaidAmount(Transaction, { user: userId, status: 'succeeded' }, 'amount'),
    sumPaidAmount(CreditPurchase, { userId, status: 'paid' }, 'pricePaid'),
    sumPaidAmount(PagePurchase, { userId, status: 'paid' }, 'pricePaid'),
    Transaction.countDocuments({ user: userId, status: 'succeeded' }),
  ]);

  const totalCents = transactionCents + creditCents + pageCents;
  return {
    totalCents,
    total: Math.round(totalCents) / 100,
    transactionCount,
  };
}

/**
 * List + search + filter + sort + paginate subscriptions. Same query-shape
 * as systemAdminUserService.listUsers — search is the same $regex $or on
 * firstName/lastName/email, pagination is the same skip+limit+
 * countDocuments-in-parallel pattern.
 */
const listSubscriptions = async ({ page, limit, search, plan, status, hasStripeCustomer, hasSubscription, sort }) => {
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const skip = (pageNum - 1) * limitNum;

  const query = {};

  if (search && String(search).trim()) {
    const term = String(search).trim();
    query.$or = [
      { firstName: { $regex: term, $options: 'i' } },
      { lastName: { $regex: term, $options: 'i' } },
      { email: { $regex: term, $options: 'i' } },
    ];
  }

  // Validated against the real, active plan list — config/plans.js is the
  // single source of truth; only 'starter' exists today, so filter options
  // beyond it are never fabricated.
  const activePlanIds = getActivePlans().map((p) => p.id);
  if (plan && activePlanIds.includes(plan)) {
    query['subscription.plan'] = plan;
  }

  if (status && SUBSCRIPTION_STATUSES.includes(status)) {
    query['subscription.status'] = status;
  }

  if (hasStripeCustomer === 'yes') query['subscription.stripeCustomerId'] = { $exists: true };
  else if (hasStripeCustomer === 'no') query['subscription.stripeCustomerId'] = { $exists: false };

  if (hasSubscription === 'yes') query['subscription.stripeSubscriptionId'] = { $exists: true };
  else if (hasSubscription === 'no') query['subscription.stripeSubscriptionId'] = { $exists: false };

  const sortSpec = SORT_OPTIONS[sort] || SORT_OPTIONS.newest;

  const [users, total] = await Promise.all([
    User.find(query).select(USER_PROJECTION).sort(sortSpec).skip(skip).limit(limitNum).lean(),
    User.countDocuments(query),
  ]);

  return {
    subscriptions: users.map(serializeSubscriptionSummary),
    pagination: {
      page: pageNum,
      limit: limitNum,
      total,
      pages: Math.max(1, Math.ceil(total / limitNum)),
    },
  };
};

/**
 * Full subscription profile for one user: account + subscription (incl.
 * live-fetched renewal info) + credits + pages + billing summary + last-10
 * Transaction events (Timeline card) + last-5 CreditPurchase/PagePurchase
 * rows (Purchases card, merged client-side — no second server-side merge).
 */
const getSubscriptionDetail = async (userId) => {
  const user = await User.findById(userId).select(USER_PROJECTION).lean();
  if (!user) return null;

  const [transactions, creditPurchases, pagePurchases, billingSummary, renewal] = await Promise.all([
    Transaction.find({ user: userId }).sort({ createdAt: -1 }).limit(10).lean(),
    CreditPurchase.find({ userId, status: { $ne: 'pending' } }).sort({ createdAt: -1 }).limit(5).lean(),
    PagePurchase.find({ userId, status: { $ne: 'pending' } }).sort({ createdAt: -1 }).limit(5).lean(),
    getBillingSummary(userId),
    fetchSubscriptionRenewalInfo(user.subscription.stripeSubscriptionId),
  ]);

  const { credits, pages } = summarizeQuota(user);
  const plan = getPlanSafe(user.subscription.plan);

  return {
    account: {
      id: user._id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      roleId: user.roleId,
      roleName: ROLE_NAMES[user.roleId] || 'user',
    },
    subscription: {
      plan: plan ? { id: plan.id, name: plan.name } : null,
      status: user.subscription.status,
      stripeCustomerId: user.subscription.stripeCustomerId || null,
      stripeSubscriptionId: user.subscription.stripeSubscriptionId || null,
      renewal,
    },
    credits,
    pages,
    billingSummary,
    recentTransactions: transactions.map(serializeTimelineEvent),
    recentAdditionalCredits: creditPurchases.map(serializeCreditPurchaseRow),
    recentAdditionalPages: pagePurchases.map(serializePagePurchaseRow),
  };
};

export { listSubscriptions, getSubscriptionDetail };
