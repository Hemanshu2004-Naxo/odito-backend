import User from '../../user/model/User.js';
import SeoProject from '../../app_user/model/SeoProject.js';
import AuditRun from '../../audit_history/model/AuditRun.js';
import Transaction from '../../subscription/model/Transaction.js';
import PagePurchase from '../../page_purchase/model/PagePurchase.js';
import CreditPurchase from '../../credit_purchase/model/CreditPurchase.js';
import SystemAdminAuditLog from '../../subscription/model/SystemAdminAuditLog.js';
import { summarizeQuota } from '../../../utils/creditService.js';

// roleId -> name. Duplicates the same tiny map already hand-kept in
// authController.js (getRoleName) — that one is private to the auth module,
// so this follows the same "small enum map duplicated per module" precedent
// already established by SUBSCRIPTION_STATUSES below and in
// adminSubscriptionController.js, rather than importing an unrelated
// controller's internal helper.
const ROLE_NAMES = { 1: 'systemadmin', 2: 'superadmin', 3: 'admin', 4: 'agency_admin', 5: 'user' };
const VALID_ROLE_IDS = [1, 2, 3, 4, 5];

// Kept in sync with User.js's subscription.status enum by hand — same
// convention adminSubscriptionController.js already uses.
const SUBSCRIPTION_STATUSES = ['inactive', 'active', 'paused', 'canceled', 'past_due'];

const SORT_OPTIONS = {
  newest: { createdAt: -1 },
  oldest: { createdAt: 1 },
  lastLogin: { lastLogin: -1 },
  name: { firstName: 1, lastName: 1 },
  email: { email: 1 },
};

// Explicit allow-list projection — never select password or
// oauthProvider/oauthProviderId. `subscription` pulls the whole embedded
// doc (plan/status/stripeCustomerId/stripeSubscriptionId/credits/pages) in
// one go.
const USER_PROJECTION = 'firstName lastName email avatar roleId isActive isEmailVerified lastLogin createdAt subscription';

function serializeUserSummary(user) {
  const { credits, pages } = summarizeQuota(user);
  return {
    id: user._id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    avatar: user.avatar,
    roleId: user.roleId,
    roleName: ROLE_NAMES[user.roleId] || 'user',
    isActive: user.isActive,
    isEmailVerified: user.isEmailVerified,
    subscription: {
      plan: user.subscription.plan,
      status: user.subscription.status,
    },
    credits,
    pages,
    createdAt: user.createdAt,
    lastLogin: user.lastLogin || null,
  };
}

function serializeTransactionForBilling(t) {
  return {
    id: t._id,
    date: t.createdAt,
    amount: t.amount,
    currency: t.currency,
    type: t.type,
    status: t.status,
    source: 'subscription',
  };
}

function serializePagePurchaseForBilling(p) {
  return {
    id: p._id,
    date: p.createdAt,
    amount: p.pricePaid,
    currency: p.currency,
    type: 'page_pack',
    status: p.status,
    source: 'page_purchase',
  };
}

function serializeCreditPurchaseForBilling(c) {
  return {
    id: c._id,
    date: c.createdAt,
    amount: c.pricePaid,
    currency: c.currency,
    type: 'credit_pack',
    status: c.status,
    source: 'credit_purchase',
  };
}

/**
 * List + search + filter + sort + paginate users. Mirrors the query-shape
 * already used by taskController.getTasks / fixLogController (parse
 * page/limit, build a $regex $or for search, skip+limit+countDocuments in
 * parallel) — no new pagination helper invented.
 */
const listUsers = async ({ page, limit, search, role, subscriptionStatus, emailVerified, accountStatus, sort }) => {
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

  if (role !== undefined && role !== null && role !== '') {
    const roleNum = parseInt(role, 10);
    if (VALID_ROLE_IDS.includes(roleNum)) {
      query.roleId = roleNum;
    }
  }

  if (subscriptionStatus && SUBSCRIPTION_STATUSES.includes(subscriptionStatus)) {
    query['subscription.status'] = subscriptionStatus;
  }

  if (emailVerified === 'true') query.isEmailVerified = true;
  else if (emailVerified === 'false') query.isEmailVerified = false;

  if (accountStatus === 'active') query.isActive = true;
  else if (accountStatus === 'suspended') query.isActive = false;

  const sortSpec = SORT_OPTIONS[sort] || SORT_OPTIONS.newest;

  const [users, total] = await Promise.all([
    User.find(query).select(USER_PROJECTION).sort(sortSpec).skip(skip).limit(limitNum).lean(),
    User.countDocuments(query),
  ]);

  return {
    users: users.map(serializeUserSummary),
    pagination: {
      page: pageNum,
      limit: limitNum,
      total,
      pages: Math.max(1, Math.ceil(total / limitNum)),
    },
  };
};

/**
 * Full profile for one user: account + subscription + credits + pages +
 * project/audit counts + last 5 billing records. Returns null if the user
 * doesn't exist — ObjectId format validation is the controller's job (same
 * split adminSubscriptionController.js's loadTargetUser uses).
 */
const getUserDetail = async (userId) => {
  const user = await User.findById(userId).select(USER_PROJECTION).lean();
  if (!user) return null;

  const [projects, transactions, pagePurchases, creditPurchases] = await Promise.all([
    SeoProject.find({ user_id: userId, is_deleted: { $ne: true } }).select('_id').lean(),
    Transaction.find({ user: userId }).sort({ createdAt: -1 }).limit(5).lean(),
    PagePurchase.find({ userId, status: { $ne: 'pending' } }).sort({ createdAt: -1 }).limit(5).lean(),
    CreditPurchase.find({ userId, status: { $ne: 'pending' } }).sort({ createdAt: -1 }).limit(5).lean(),
  ]);

  const projectCount = projects.length;
  const auditCount = projectCount > 0
    ? await AuditRun.countDocuments({ projectId: { $in: projects.map((p) => p._id) } })
    : 0;

  const recentBilling = [
    ...transactions.map(serializeTransactionForBilling),
    ...pagePurchases.map(serializePagePurchaseForBilling),
    ...creditPurchases.map(serializeCreditPurchaseForBilling),
  ]
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 5);

  const { credits, pages } = summarizeQuota(user);

  return {
    id: user._id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    avatar: user.avatar,
    roleId: user.roleId,
    roleName: ROLE_NAMES[user.roleId] || 'user',
    isActive: user.isActive,
    isEmailVerified: user.isEmailVerified,
    createdAt: user.createdAt,
    lastLogin: user.lastLogin || null,
    subscription: {
      plan: user.subscription.plan,
      status: user.subscription.status,
      stripeCustomerId: user.subscription.stripeCustomerId || null,
      stripeSubscriptionId: user.subscription.stripeSubscriptionId || null,
    },
    credits,
    pages,
    statistics: { projectCount, auditCount },
    recentBilling,
  };
};

/**
 * Sets isActive=false and writes a SystemAdminAuditLog row — same
 * findByIdAndUpdate + SystemAdminAuditLog.create shape as adminUpdateStatus
 * in adminSubscriptionController.js. Returns null if the user doesn't exist.
 */
const suspendUser = async (userId, adminId, reason) => {
  const user = await User.findById(userId).select('isActive');
  if (!user) return null;

  const before = { isActive: user.isActive };
  const after = { isActive: false };

  await User.findByIdAndUpdate(user._id, { $set: { isActive: false } });

  await SystemAdminAuditLog.create({
    admin: adminId,
    targetUser: user._id,
    action: 'account_suspended',
    before,
    after,
    reason: reason || null,
  });

  return { before, after };
};

const activateUser = async (userId, adminId, reason) => {
  const user = await User.findById(userId).select('isActive');
  if (!user) return null;

  const before = { isActive: user.isActive };
  const after = { isActive: true };

  await User.findByIdAndUpdate(user._id, { $set: { isActive: true } });

  await SystemAdminAuditLog.create({
    admin: adminId,
    targetUser: user._id,
    action: 'account_activated',
    before,
    after,
    reason: reason || null,
  });

  return { before, after };
};

export { listUsers, getUserDetail, suspendUser, activateUser };
