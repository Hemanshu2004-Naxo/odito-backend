/**
 * Backend source of truth for "Buy Credits" pricing and quantity bounds —
 * the credits counterpart to modules/page_purchase/config/pagePackPricing.js,
 * same shape, same purpose. The checkout endpoint
 * (controller/creditPurchaseController.js) NEVER accepts a price from the
 * client, only a credit count, and always recomputes the amount from here.
 *
 * Rate: $15.00/credit (1500 cents). Credits are a much heavier resource
 * than pages — the Starter plan's entire $25/month grants only 1 credit
 * alongside 100 pages (config/plans.js) — so this is priced accordingly,
 * as a flat per-unit rate rather than tiered, matching the pages module's
 * own flat-rate approach. Changing the price later is a one-line edit
 * here — no other file.
 */

export const MIN_CREDITS_PER_PURCHASE = 1;
export const MAX_CREDITS_PER_PURCHASE = 100;

export const CREDIT_PACK_RATE_CENTS_PER_CREDIT = 1500;

/**
 * @param {number} credits
 * @returns {number} price in cents
 */
export function calculateCreditPackPriceCents(credits) {
  return Math.round(credits * CREDIT_PACK_RATE_CENTS_PER_CREDIT);
}

/**
 * @param {number} credits
 * @returns {boolean} true iff `credits` is a whole number within the
 *   configured purchasable range
 */
export function isValidCreditCount(credits) {
  return Number.isInteger(credits) && credits >= MIN_CREDITS_PER_PURCHASE && credits <= MAX_CREDITS_PER_PURCHASE;
}
