/**
 * Safe diagnostics for a rejected strategy. When the model's answer fails Odito's validation the developer needs to know WHICH
 * rule failed - but never the model's text, the business's facts or any secret. Everything here keeps only:
 *   - the field PATH (a schema location such as `platformStrategy[1].role`),
 *   - a fixed error CODE (TOO_LONG, OUT_OF_RANGE, WRONG_TYPE, ...),
 *   - a generic RULE sentence (the limit, never the value).
 * Quoted values, supplied figures / addresses and phrases in the validator's messages are removed.
 */

export const VALIDATION_CODES = Object.freeze([
  'TOO_LONG', 'TOO_MANY', 'TOO_FEW', 'OUT_OF_RANGE', 'WRONG_TYPE', 'EMPTY', 'BAD_ENUM', 'DUPLICATE', 'PERCENT_SUM', 'PROHIBITED_PHRASE',
  'UNSUPPORTED_FACT', 'CONTROL_CHARACTERS', 'TREND_CLAIM', 'MISSING', 'OTHER',
]);

const RULES = [
  [/characters or fewer/i, 'TOO_LONG'],
  [/can have at most|appears? at most/i, 'TOO_MANY'],
  [/needs at least|needs \d+-\d+|needs exactly/i, 'TOO_FEW'],
  [/must be between/i, 'OUT_OF_RANGE'],
  [/percentages must add up/i, 'PERCENT_SUM'],
  [/prohibited phrase/i, 'PROHIBITED_PHRASE'],
  [/not in the supplied business information|was not supplied|not supplied by the business/i, 'UNSUPPORTED_FACT'],
  [/must not claim .*trending|trending or viral/i, 'TREND_CLAIM'],
  [/control characters/i, 'CONTROL_CHARACTERS'],
  [/appears more than once/i, 'DUPLICATE'],
  [/must be one of/i, 'BAD_ENUM'],
  [/must not be empty/i, 'EMPTY'],
  [/must be (text|a number|a list|an object|true or false)/i, 'WRONG_TYPE'],
  [/is required|missing/i, 'MISSING'],
];

/** "platformStrategy[1].role: must be 160 characters or fewer" -> { path, code, rule }; no quoted value, no supplied figure survives. */
export function summarizeValidationError(message) {
  const text = String(message ?? '');
  const split = text.indexOf(': ');
  const path = (split > 0 ? text.slice(0, split) : 'strategy').replace(/[^\w.\[\]-]/g, '').slice(0, 120) || 'strategy';
  const rest = split > 0 ? text.slice(split + 2) : text;
  const code = (RULES.find(([re]) => re.test(rest)) || [null, 'OTHER'])[1];
  const rule = rest
    .replace(/"[^"]*"/g, '"…"')
    .replace(/information:.*$/i, 'information')
    .replace(/\(got [^)]*\)/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  return { path, code, rule };
}

export function summarizeValidationErrors(errors, { max = 25 } = {}) {
  return (errors || []).slice(0, max).map(summarizeValidationError);
}

/** What a failed provider call tells us, without the provider's text: the Odito/provider code and the reason code only. */
export function describeProviderFailure(error) {
  return {
    providerCode: error?.code || null,
    reason: typeof error?.reason === 'string' ? error.reason.slice(0, 60) : null,
    httpStatus: Number.isInteger(error?.httpStatus) ? error.httpStatus : null,
  };
}

/** The per-attempt record kept while a generation runs: { attempt, outputTokens, errors: [{path, code, rule}] }. */
export function attemptRecord({ attempt, errors, outputTokens = 0, stopReason = null }) {
  return { attempt, outputTokens, stopReason, errorCount: (errors || []).length, errors: summarizeValidationErrors(errors) };
}

/** The flat, capped list persisted on a failed generation (paths + codes only): [{ attempt, path, code, rule }]. */
export function flattenAttempts(attempts, { max = 25 } = {}) {
  return attempts.flatMap((a) => a.errors.map((e) => ({ ...(a.batch ? { batch: a.batch } : {}), attempt: a.attempt, ...e }))).slice(0, max);
}
