import User from '../modules/user/model/User.js';

/**
 * Subscription quota operations — two independent resources, both stored the
 * same way on the User document: {limit, used}. `remaining` is never
 * stored — always derived as `limit - used`.
 *
 *  - Project credits: User.subscription.credits
 *  - Crawl pages:     User.subscription.pages
 *  - Manual recrawls: User.subscription.recrawls
 */

/**
 * Read-only check: does this user have at least `amount` credits remaining?
 * Accepts an already-loaded User document/plain object — does not hit the DB.
 * @param {Object} user - User document with subscription.credits
 * @param {number} [amount=1]
 * @returns {boolean}
 */
export function hasCredits(user, amount = 1) {
  const { limit, used } = user.subscription.credits;
  return (limit - used) >= amount;
}

/**
 * Atomically deduct `amount` credits. Guarded via $expr so concurrent
 * requests can never push `used` past `limit` — MongoDB serializes
 * concurrent updates to the same document, so this is race-safe without a
 * separate lock.
 * @param {string|import('mongoose').Types.ObjectId} userId
 * @param {number} [amount=1]
 * @returns {Promise<Object>} updated User document
 * @throws {Error} code === 'INSUFFICIENT_CREDITS' if the balance is too low
 */
export async function deductCredits(userId, amount = 1) {
  const user = await User.findOneAndUpdate(
    {
      _id: userId,
      $expr: {
        $gte: [
          { $subtract: ['$subscription.credits.limit', '$subscription.credits.used'] },
          amount
        ]
      }
    },
    { $inc: { 'subscription.credits.used': amount } },
    { new: true }
  );

  if (!user) {
    const error = new Error(`Not enough credits to deduct ${amount}`);
    error.code = 'INSUFFICIENT_CREDITS';
    throw error;
  }

  return user;
}

/**
 * Compensating action for a deduction whose follow-up work failed after the
 * deduction already succeeded (e.g. project creation failed post-deduct).
 * Lowers `used` — never invalid, since `used` only ever increases via
 * deductCredits().
 * @param {string|import('mongoose').Types.ObjectId} userId
 * @param {number} [amount=1]
 * @returns {Promise<Object>} updated User document
 */
export async function refundCredits(userId, amount = 1) {
  return User.findByIdAndUpdate(
    userId,
    { $inc: { 'subscription.credits.used': -amount } },
    { new: true }
  );
}

/**
 * Grant additional credit capacity (e.g. a top-up purchase). Raises `limit`
 * — never touches `used` — since remaining is always `limit - used`.
 * @param {string|import('mongoose').Types.ObjectId} userId
 * @param {number} amount
 * @returns {Promise<Object>} updated User document
 */
export async function addCredits(userId, amount) {
  return User.findByIdAndUpdate(
    userId,
    { $inc: { 'subscription.credits.limit': amount } },
    { new: true }
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Pages
// ─────────────────────────────────────────────────────────────────────────

/**
 * Read-only check: does this user have at least `amount` pages remaining?
 * Accepts an already-loaded User document/plain object — does not hit the DB.
 * @param {Object} user - User document with subscription.pages
 * @param {number} amount
 * @returns {boolean}
 */
export function hasPages(user, amount) {
  const { limit, used } = user.subscription.pages;
  return (limit - used) >= amount;
}

/**
 * Atomically deduct `amount` pages. Guarded via $expr so concurrent
 * requests can never push `used` past `limit` — same single-document atomic
 * pattern as deductCredits().
 * @param {string|import('mongoose').Types.ObjectId} userId
 * @param {number} amount
 * @returns {Promise<Object>} updated User document
 * @throws {Error} code === 'INSUFFICIENT_PAGES' if the balance is too low
 */
export async function deductPages(userId, amount) {
  const user = await User.findOneAndUpdate(
    {
      _id: userId,
      $expr: {
        $gte: [
          { $subtract: ['$subscription.pages.limit', '$subscription.pages.used'] },
          amount
        ]
      }
    },
    { $inc: { 'subscription.pages.used': amount } },
    { new: true }
  );

  if (!user) {
    const error = new Error(`Not enough pages to deduct ${amount}`);
    error.code = 'INSUFFICIENT_PAGES';
    throw error;
  }

  return user;
}

/**
 * Compensating action for a page deduction whose follow-up work failed after
 * the deduction already succeeded. Lowers `used` — never invalid, since
 * `used` only ever increases via deductPages().
 * @param {string|import('mongoose').Types.ObjectId} userId
 * @param {number} amount
 * @returns {Promise<Object>} updated User document
 */
export async function refundPages(userId, amount) {
  return User.findByIdAndUpdate(
    userId,
    { $inc: { 'subscription.pages.used': -amount } },
    { new: true }
  );
}

/**
 * Grant additional page capacity (e.g. a top-up purchase). Raises `limit`
 * — never touches `used` — since remaining is always `limit - used`. Pages
 * are a lifetime quota: nothing ever resets `used` automatically.
 * @param {string|import('mongoose').Types.ObjectId} userId
 * @param {number} amount
 * @returns {Promise<Object>} updated User document
 */
export async function addPages(userId, amount) {
  return User.findByIdAndUpdate(
    userId,
    { $inc: { 'subscription.pages.limit': amount } },
    { new: true }
  );
}

/**
 * Sets both credits and pages to a plan's defaults — `limit` from the plan,
 * `used` reset to 0 for both. This is an ABSOLUTE allocation, distinct from
 * every other function in this file (which are all relative/$inc). It
 * exists for exactly two callers: subscription activation
 * (checkout.session.completed) and monthly renewal (invoice.paid) — see
 * subscriptionWebhookService.js. Both call this same function rather than
 * each independently constructing the same $set, so there is exactly one
 * place "what does allocating a plan's quota mean" is defined.
 * @param {string|import('mongoose').Types.ObjectId} userId
 * @param {{credits:number, pages:number, recrawls?:number}} planLimits - typically from getPlanLimits()
 * @returns {Promise<Object>} updated User document
 */
export async function allocateQuotaFromPlan(userId, planLimits) {
  return User.findByIdAndUpdate(
    userId,
    {
      $set: {
        'subscription.credits.limit': planLimits.credits,
        'subscription.credits.used': 0,
        'subscription.pages.limit': planLimits.pages,
        'subscription.pages.used': 0,
        'subscription.recrawls.limit': planLimits.recrawls ?? 0,
        'subscription.recrawls.used': 0,
      },
    },
    { new: true }
  );
}

/**
 * Reallocates both credits and pages `limit` to a new plan's values —
 * WITHOUT touching `used`. This is the plan-CHANGE counterpart to
 * allocateQuotaFromPlan() (which is for activation/renewal and always
 * resets `used` to 0): a mid-cycle upgrade or downgrade must never erase
 * usage the user has already consumed this period, only ever change the
 * ceiling against it.
 *
 * On an upgrade, `remaining` (limit - used, computed by summarizeQuota())
 * increases immediately. On a downgrade, `remaining` can drop to zero or go
 * negative if `used` already exceeds the new `limit` — that's intentional,
 * not a bug: hasCredits()/hasPages() already correctly block any further
 * consumption in that case (`limit - used >= amount` is false), and `used`
 * naturally resets to 0 at the next renewal via allocateQuotaFromPlan(), the
 * same as it always has. No credit/page value is ever fabricated or lost.
 * @param {string|import('mongoose').Types.ObjectId} userId
 * @param {{credits:number, pages:number, recrawls?:number}} newPlanLimits - typically from getPlanLimits()
 * @returns {Promise<Object>} updated User document
 */
export async function reallocateQuotaForPlanChange(userId, newPlanLimits) {
  return User.findByIdAndUpdate(
    userId,
    {
      $set: {
        'subscription.credits.limit': newPlanLimits.credits,
        'subscription.pages.limit': newPlanLimits.pages,
        'subscription.recrawls.limit': newPlanLimits.recrawls ?? 0,
      },
    },
    { new: true }
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Manual recrawls
// ─────────────────────────────────────────────────────────────────────────

/**
 * Read-only check: does this user have at least one manual recrawl left?
 * Tolerates a User loaded before the `recrawls` field existed (treated as 0).
 * @param {Object} user - User document/plain object with `subscription`
 * @param {number} [amount=1]
 * @returns {boolean}
 */
export function hasRecrawls(user, amount = 1) {
  const { limit = 0, used = 0 } = user.subscription?.recrawls || {};
  return (limit - used) >= amount;
}

/**
 * Atomically reserve `amount` manual recrawls. Same single-document $expr
 * guard as deductCredits(), so two simultaneous Start Recrawl clicks can
 * never consume more than the remaining allowance.
 * @param {string|import('mongoose').Types.ObjectId} userId
 * @param {number} [amount=1]
 * @returns {Promise<Object>} updated User document
 * @throws {Error} code === 'INSUFFICIENT_RECRAWLS' if the balance is too low
 */
export async function deductRecrawls(userId, amount = 1) {
  const user = await User.findOneAndUpdate(
    {
      _id: userId,
      $expr: {
        $gte: [
          {
            $subtract: [
              { $ifNull: ['$subscription.recrawls.limit', 0] },
              { $ifNull: ['$subscription.recrawls.used', 0] },
            ],
          },
          amount,
        ],
      },
    },
    { $inc: { 'subscription.recrawls.used': amount } },
    { new: true }
  );

  if (!user) {
    const error = new Error(`Not enough manual recrawls to deduct ${amount}`);
    error.code = 'INSUFFICIENT_RECRAWLS';
    throw error;
  }

  return user;
}

/**
 * Compensating action when a recrawl never actually started after its
 * reservation succeeded (job creation threw). Not used for pipeline
 * failures after a successful start — see projectAuditService.js.
 * @param {string|import('mongoose').Types.ObjectId} userId
 * @param {number} [amount=1]
 * @returns {Promise<Object>} updated User document
 */
export async function refundRecrawls(userId, amount = 1) {
  return User.findOneAndUpdate(
    { _id: userId, 'subscription.recrawls.used': { $gte: amount } },
    { $inc: { 'subscription.recrawls.used': -amount } },
    { new: true }
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Combined summary
// ─────────────────────────────────────────────────────────────────────────

/**
 * Synchronous {limit,used,remaining} breakdown for both quota resources,
 * from an already-loaded User document/plain object — no DB access.
 * `remaining` is calculated here, never read from a stored field. This is
 * the single place that calculation happens; getQuotaSummary() below and
 * any auth-response formatting both build on top of this instead of
 * recomputing it.
 * @param {Object} user - User document/plain object with `subscription`
 * @returns {{credits:{limit:number,used:number,remaining:number}, pages:{limit:number,used:number,remaining:number}, recrawls:{limit:number,used:number,remaining:number}}}
 */
export function summarizeQuota(user) {
  const { credits, pages, recrawls } = user.subscription;
  const recrawlLimit = recrawls?.limit ?? 0;
  const recrawlUsed = recrawls?.used ?? 0;

  return {
    credits: {
      limit: credits.limit,
      used: credits.used,
      remaining: credits.limit - credits.used,
    },
    pages: {
      limit: pages.limit,
      used: pages.used,
      remaining: pages.limit - pages.used,
    },
    recrawls: {
      limit: recrawlLimit,
      used: recrawlUsed,
      remaining: Math.max(0, recrawlLimit - recrawlUsed),
    },
  };
}

/**
 * Read-only combined credits + pages summary for a user, fetched fresh from
 * the DB. Thin wrapper around summarizeQuota() — see that function for the
 * actual calculation.
 * @param {string|import('mongoose').Types.ObjectId} userId
 * @returns {Promise<{credits:{limit:number,used:number,remaining:number}, pages:{limit:number,used:number,remaining:number}}>}
 * @throws {Error} if the user does not exist
 */
export async function getQuotaSummary(userId) {
  const user = await User.findById(userId, 'subscription').lean();

  if (!user) {
    throw new Error('User not found');
  }

  return summarizeQuota(user);
}
