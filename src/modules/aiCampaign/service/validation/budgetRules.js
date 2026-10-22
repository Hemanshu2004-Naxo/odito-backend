/**
 * Budget rule (Phase 5, spec §10).
 *
 * The Phase 1 structure validator already requires `dailyBudgetMicros` to
 * be an integer >= 1 (which, by construction, already excludes NaN,
 * Infinity, and negative values — `Number.isInteger()` is false for all
 * three). This rule is defence-in-depth on top of that guarantee (in case
 * a future change to the normalizer ever regresses it) plus the one thing
 * Phase 1 does NOT check: currency is never assumed here or anywhere else
 * in this module — every message reads the draft's own `campaign.currency`
 * and never defaults it from location or any other source (spec §10's
 * explicit "never default currency based on location").
 */

import { MICROS_PER_UNIT } from '../../constants/aiCampaignEnums.js';
import { error } from './issueHelpers.js';

/** Major-unit, currency-labelled display string — never assumes a currency. */
export function formatBudgetMajorUnits(campaign) {
  const micros = campaign?.dailyBudgetMicros;
  const currency = campaign?.currency || null;
  if (typeof micros !== 'number' || !Number.isFinite(micros)) return 'not set';
  const major = micros / MICROS_PER_UNIT;
  return currency ? `${major} ${currency}` : String(major);
}

export function runBudgetRule(draftPlain) {
  const issues = [];
  const micros = draftPlain?.campaign?.dailyBudgetMicros;

  // Defence-in-depth only — Phase 1 already guarantees this for anything
  // that reached persistence. Kept cheap and side-effect-free.
  if (micros !== undefined) {
    if (Number.isNaN(micros) || !Number.isFinite(micros)) {
      issues.push(error({
        code: 'BUDGET_NOT_A_FINITE_NUMBER',
        category: 'budget',
        path: 'campaign.dailyBudgetMicros',
        message: 'The daily budget is not a valid number.',
        recommendation: 'Set a positive daily budget in the campaign settings.',
      }));
    } else if (micros <= 0) {
      issues.push(error({
        code: 'BUDGET_NOT_POSITIVE',
        category: 'budget',
        path: 'campaign.dailyBudgetMicros',
        message: 'The daily budget must be greater than zero.',
        recommendation: 'Set a positive daily budget in the campaign settings.',
      }));
    } else if (!Number.isSafeInteger(micros)) {
      issues.push(error({
        code: 'BUDGET_OUT_OF_RANGE',
        category: 'budget',
        path: 'campaign.dailyBudgetMicros',
        message: 'The daily budget is outside the supported range.',
        recommendation: 'Set a realistic daily budget in the campaign settings.',
      }));
    }
  }

  if (!draftPlain?.campaign?.currency) {
    issues.push(error({
      code: 'CURRENCY_MISSING',
      category: 'budget',
      path: 'campaign.currency',
      message: 'No currency is set for this campaign.',
      recommendation: 'Set the campaign currency in the campaign settings.',
    }));
  }

  return issues;
}

export default { runBudgetRule, formatBudgetMajorUnits };
