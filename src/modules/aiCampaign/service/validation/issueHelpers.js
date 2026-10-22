/**
 * Shared helpers for Phase 5 validation rules. Every rule module returns
 * plain arrays of these — never a Mongoose document, never anything with a
 * method on it — so campaignValidationService can freely aggregate,
 * persist, and re-shape them.
 */

import { ISSUE_SEVERITIES, ISSUE_CATEGORIES } from '../../constants/validationEnums.js';

/**
 * Build one validation issue. Throws on an invalid severity/category —
 * these are always rule-author mistakes (never user input), so failing
 * loudly during development is more useful than silently coercing.
 */
export function makeIssue({ code, severity, category, path = null, message, recommendation = null }) {
  if (!ISSUE_SEVERITIES.includes(severity)) {
    throw new Error(`makeIssue: invalid severity "${severity}"`);
  }
  if (!ISSUE_CATEGORIES.includes(category)) {
    throw new Error(`makeIssue: invalid category "${category}"`);
  }
  if (!code || typeof code !== 'string') {
    throw new Error('makeIssue: code is required');
  }
  if (!message || typeof message !== 'string') {
    throw new Error('makeIssue: message is required');
  }
  return {
    code,
    severity,
    category,
    path,
    message: message.slice(0, 500),
    recommendation: recommendation ? String(recommendation).slice(0, 500) : null,
  };
}

export const error = (args) => makeIssue({ ...args, severity: 'error' });
export const warning = (args) => makeIssue({ ...args, severity: 'warning' });
export const info = (args) => makeIssue({ ...args, severity: 'info' });

export default { makeIssue, error, warning, info };
