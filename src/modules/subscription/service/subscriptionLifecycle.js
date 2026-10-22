/**
 * Single source of truth for "what is a user allowed to do while their
 * subscription is in status X" — Phase 15 Task 4. Every caller (project
 * creation, URL selection, the Change Plan API) asks these two functions
 * instead of comparing `subscription.status` against a string itself, so
 * the policy is defined in exactly one place.
 *
 * Deliberately conservative: only 'active' permits quota consumption or a
 * plan change. 'past_due' blocks both — a subscription with a failing
 * payment should not accumulate further usage or let the user switch plans
 * to dodge the existing invoice; the fix is resolving payment via the
 * Billing Portal, which is unaffected by this gate. 'paused' and 'canceled'
 * are equally blocked for the same reason. There is no separate 'resumed'
 * status to special-case — a resume (see subscriptionWebhookService.js's
 * wasInterrupted branch) already transitions `status` back to 'active',
 * which these functions handle automatically.
 */

const ACTIONABLE_STATUS = 'active';

/**
 * @param {string} status - a User.subscription.status value
 * @returns {boolean} whether this user may consume credits/pages right now
 */
export function canConsumeQuota(status) {
  return status === ACTIONABLE_STATUS;
}

/**
 * @param {string} status - a User.subscription.status value
 * @returns {boolean} whether this user may request a plan change right now
 */
export function canChangePlan(status) {
  return status === ACTIONABLE_STATUS;
}
