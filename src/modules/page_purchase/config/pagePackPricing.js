/**
 * Backend source of truth for "Buy More Pages" pricing and page-count
 * bounds. The frontend has its own copy of this same rate
 * (frontend/lib/pagePacks.js, $0.05/page) purely for instant UI display —
 * this file is what actually determines what a customer is charged. The
 * checkout endpoint (controller/pagePurchaseController.js) NEVER accepts a
 * price from the client, only a page count, and always recomputes the
 * amount from here.
 */

export const MIN_PAGES_PER_PURCHASE = 1;
export const MAX_PAGES_PER_PURCHASE = 5000;

// $0.05/page — matches frontend/lib/pagePacks.js's PAGE_PACK_OPTIONS rate
// (100 pages -> $5, 300 pages -> $15). Keep both in sync if this changes.
export const PAGE_PACK_RATE_CENTS_PER_PAGE = 5;

/**
 * @param {number} pages
 * @returns {number} price in cents
 */
export function calculatePagePackPriceCents(pages) {
  return Math.round(pages * PAGE_PACK_RATE_CENTS_PER_PAGE);
}

/**
 * @param {number} pages
 * @returns {boolean} true iff `pages` is a whole number within the
 *   configured purchasable range
 */
export function isValidPageCount(pages) {
  return Number.isInteger(pages) && pages >= MIN_PAGES_PER_PURCHASE && pages <= MAX_PAGES_PER_PURCHASE;
}
