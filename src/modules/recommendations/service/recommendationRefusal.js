/**
 * Base class for deliberate, user-facing refusals by a deterministic
 * (non-LLM) recommendation builder — e.g. "the FAQ pairs could not be reliably
 * extracted" or "reliable rating data is unavailable". recommendationController
 * relays code/message/statusCode as-is (duck-typed on `userFacing`) instead of a
 * generic 500, and nothing is stored when one is thrown.
 */
export class RecommendationRefusedError extends Error {
  constructor(code, message, statusCode = 422) {
    super(message);
    this.name = 'RecommendationRefusedError';
    this.code = code;
    this.statusCode = statusCode;
    this.userFacing = true;
  }
}

export default { RecommendationRefusedError };
