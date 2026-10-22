import User from '../../user/model/User.js';
import Transaction from '../../subscription/model/Transaction.js';
import PagePurchase from '../../page_purchase/model/PagePurchase.js';
import CreditPurchase from '../../credit_purchase/model/CreditPurchase.js';
import SeoProject from '../../app_user/model/SeoProject.js';
import AuditRun from '../../audit_history/model/AuditRun.js';
import Job from '../../jobs/model/Job.js';
import WebhookEvent from '../../subscription/model/WebhookEvent.js';

// Job.status enum is ['pending','claimed','processing','completed','failed','retrying']
// (see modules/jobs/model/Job.js) — the dashboard only needs the 4 buckets
// below, so 'claimed'/'processing'/'retrying' are all folded into "running".
const JOB_STATUS_BUCKETS = {
  pending: 'pending',
  claimed: 'running',
  processing: 'running',
  retrying: 'running',
  completed: 'completed',
  failed: 'failed',
};

// WebhookEvent.status enum is ['processing','completed','failed','ignored']
// (see modules/subscription/model/WebhookEvent.js) — 'processing' is
// displayed as "pending" on the dashboard since that's the useful label for
// "not finished yet", the real schema value is unchanged.
const WEBHOOK_STATUS_BUCKETS = {
  processing: 'pending',
  completed: 'completed',
  failed: 'failed',
  ignored: 'ignored',
};

const bucketize = (rows, bucketMap, buckets) => {
  const counts = Object.fromEntries(buckets.map((bucket) => [bucket, 0]));
  for (const row of rows) {
    const bucket = bucketMap[row._id];
    if (bucket) counts[bucket] += row.count;
  }
  return counts;
};

/**
 * Sum a purchase/transaction collection's paid amount for one "success"
 * status in a single aggregate query. Amounts are stored in cents on all
 * three revenue-contributing models (Transaction.amount, PagePurchase/
 * CreditPurchase.pricePaid) — see systemAdminDashboardService's Phase 2B
 * dependency audit.
 */
const sumPaidAmount = async (Model, statusValue, amountField) => {
  const [result] = await Model.aggregate([
    { $match: { status: statusValue } },
    { $group: { _id: null, total: { $sum: `$${amountField}` } } },
  ]);
  return result?.total || 0;
};

/**
 * One $facet aggregation on User covers total/active/verified counts plus
 * the active-subscription count, instead of 4 separate countDocuments()
 * round trips.
 */
const getUserAndSubscriptionStats = async () => {
  const [result] = await User.aggregate([
    {
      $facet: {
        total: [{ $count: 'count' }],
        active: [{ $match: { isActive: true } }, { $count: 'count' }],
        verified: [{ $match: { isEmailVerified: true } }, { $count: 'count' }],
        activeSubscriptions: [{ $match: { 'subscription.status': 'active' } }, { $count: 'count' }],
      },
    },
  ]);

  const pick = (buckets) => buckets?.[0]?.count || 0;
  return {
    users: {
      total: pick(result?.total),
      active: pick(result?.active),
      verified: pick(result?.verified),
    },
    subscriptions: {
      active: pick(result?.activeSubscriptions),
    },
  };
};

/**
 * Revenue = sum of every successfully-paid Transaction (subscription
 * checkouts/renewals) + PagePurchase + CreditPurchase. Only 'succeeded'
 * Transactions and 'paid' Page/CreditPurchases are counted — pending,
 * failed, refunded, and canceled records are excluded, so this is never a
 * fabricated or inflated total.
 */
const getRevenueStats = async () => {
  const [transactionCents, pageCents, creditCents] = await Promise.all([
    sumPaidAmount(Transaction, 'succeeded', 'amount'),
    sumPaidAmount(PagePurchase, 'paid', 'pricePaid'),
    sumPaidAmount(CreditPurchase, 'paid', 'pricePaid'),
  ]);

  const totalCents = transactionCents + pageCents + creditCents;
  return {
    totalCents,
    total: Math.round(totalCents) / 100,
  };
};

const getJobStats = async () => {
  const rows = await Job.aggregate([
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  return bucketize(rows, JOB_STATUS_BUCKETS, ['pending', 'running', 'completed', 'failed']);
};

const getWebhookStats = async () => {
  const rows = await WebhookEvent.aggregate([
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  return bucketize(rows, WEBHOOK_STATUS_BUCKETS, ['pending', 'completed', 'failed', 'ignored']);
};

/**
 * Single aggregation entry point for the System Admin dashboard. Runs every
 * collection query concurrently via Promise.all — one HTTP call in, 6
 * concurrent Mongo queries out (1 $facet for all 4 user/subscription
 * counts, 3 revenue sums running in parallel inside getRevenueStats, 1
 * projects count, 1 audits count, 1 jobs group, 1 webhooks group).
 */
const getDashboardStats = async () => {
  const [userAndSubscriptionStats, revenue, projectsTotal, auditsTotal, jobs, webhooks] = await Promise.all([
    getUserAndSubscriptionStats(),
    getRevenueStats(),
    SeoProject.countDocuments({ is_deleted: { $ne: true } }),
    AuditRun.countDocuments({}),
    getJobStats(),
    getWebhookStats(),
  ]);

  return {
    users: userAndSubscriptionStats.users,
    subscriptions: userAndSubscriptionStats.subscriptions,
    revenue,
    projects: { total: projectsTotal },
    audits: { total: auditsTotal },
    jobs,
    webhooks,
  };
};

export { getDashboardStats };
