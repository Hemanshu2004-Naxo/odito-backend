/**
 * Provider-independent error vocabulary for the AI Visibility system.
 *
 * Every error carries a stable `code` and a user-safe `message`. Nothing here ever wraps an SDK error, a
 * provider response body or a request configuration, because those can echo credentials.
 */

export const VISIBILITY_ERROR = Object.freeze({
  PROJECT_NOT_FOUND: 'VISIBILITY_PROJECT_NOT_FOUND',
  INSUFFICIENT_PROFILE: 'VISIBILITY_INSUFFICIENT_PROFILE',
  PROMPT_SET_INVALID: 'VISIBILITY_PROMPT_SET_INVALID',
  PROMPT_SET_PERSIST_FAILED: 'VISIBILITY_PROMPT_SET_PERSIST_FAILED',
  QUESTION_SET_INVALID: 'VISIBILITY_QUESTION_SET_INVALID',
  QUESTION_SET_NOT_FOUND: 'VISIBILITY_QUESTION_SET_NOT_FOUND',
  QUESTION_SET_STATE: 'VISIBILITY_QUESTION_SET_STATE',
  QUESTION_SET_LIMIT: 'VISIBILITY_QUESTION_SET_LIMIT',
});

export class VisibilityError extends Error {
  /**
   * @param {string} code    one of VISIBILITY_ERROR (or a provider-specific code)
   * @param {string} message user-safe text
   * @param {object} [details] safe, structured context (validation issue codes etc.). Never secrets.
   */
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'VisibilityError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export default { VISIBILITY_ERROR, VisibilityError };
