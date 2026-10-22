/**
 * Pure, DB-free helpers for the new Add/Delete Keyword feature.
 *
 * Nothing in this file touches Mongoose, nothing here is called by any
 * existing code path (onboarding, rescan, history derivation) — it exists
 * solely for the new addKeyword()/deleteKeyword() service functions (Phase 2)
 * to build on. No APIs are exposed from this file; it has no side effects.
 *
 * IMPORTANT: this file's normalizeForDuplicateCheck() is intentionally a
 * SEPARATE function from rankingHistoryService.js's own normalizeKeyword().
 * That existing function is the one stored as keyword_normalized on every
 * KeywordRankingHistory document and used to join history for prev-week/
 * prev-month derivation — changing its behavior would silently break the
 * join for any keyword whose raw text has irregular whitespace, because
 * already-persisted history rows would keep their OLD normalized value
 * forever while newly-computed ones diverged. This file's stricter
 * normalization (whitespace-collapse, Unicode NFC) is used ONLY to decide
 * "is this candidate keyword a likely duplicate of an existing one" at
 * Add-Keyword time — it never becomes a stored keyword_normalized value.
 */

// No magic numbers elsewhere: MIN matches SeoProject's own existing
// pre-save filter (`keyword.length >= 2`); MAX matches the same schema
// file's project_name maxlength precedent (100) — not an arbitrary pick.
export const MIN_KEYWORD_LENGTH = 2;
export const MAX_KEYWORD_LENGTH = 100;

// C0 control characters + DEL, built from char codes rather than typed
// literally so the source file never contains raw non-printable bytes.
const CONTROL_CHARS_REGEX = new RegExp(
  '[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + String.fromCharCode(127) + ']'
);

function keywordError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Validates and trims a raw keyword string. Throws (never returns false)
 * so callers get a typed, logged error the same way otpService.js's
 * verifyOtp() does — a single `throw` site, not a scattered if/return chain.
 * @param {*} rawKeyword - untrusted input, may be any type
 * @returns {string} the trimmed, valid keyword
 * @throws {Error} code one of INVALID_KEYWORD_EMPTY, INVALID_KEYWORD_TOO_SHORT,
 *   INVALID_KEYWORD_TOO_LONG, INVALID_KEYWORD_CHARS
 */
export function validateKeywordInput(rawKeyword) {
  if (typeof rawKeyword !== 'string') {
    throw keywordError('Keyword is required.', 'INVALID_KEYWORD_EMPTY');
  }

  const trimmed = rawKeyword.trim();

  if (trimmed.length === 0) {
    throw keywordError('Keyword is required.', 'INVALID_KEYWORD_EMPTY');
  }

  if (trimmed.length < MIN_KEYWORD_LENGTH) {
    throw keywordError(`Keyword must be at least ${MIN_KEYWORD_LENGTH} characters.`, 'INVALID_KEYWORD_TOO_SHORT');
  }

  if (trimmed.length > MAX_KEYWORD_LENGTH) {
    throw keywordError(`Keyword cannot exceed ${MAX_KEYWORD_LENGTH} characters.`, 'INVALID_KEYWORD_TOO_LONG');
  }

  // Control/non-printable characters only (null bytes, embedded
  // newlines/tabs, etc). Real keywords legitimately contain hyphens,
  // apostrophes, ampersands, digits ("women's shoes", "AT&T support",
  // "3M command strips"), so this is deliberately not a punctuation
  // blocklist — only genuinely non-printable input is rejected.
  if (CONTROL_CHARS_REGEX.test(trimmed)) {
    throw keywordError('Keyword contains invalid characters.', 'INVALID_KEYWORD_CHARS');
  }

  // Reject strings with no alphanumeric content at all (e.g. "!!!", "   -- ").
  if (!/[\p{L}\p{N}]/u.test(trimmed)) {
    throw keywordError('Keyword must contain at least one letter or number.', 'INVALID_KEYWORD_CHARS');
  }

  return trimmed;
}

/**
 * Stricter normalization than rankingHistoryService.js's normalizeKeyword()
 * — see the file-level comment for why these are deliberately separate.
 * Used only for duplicate-candidate comparison, never persisted.
 * @param {string} keyword
 * @returns {string}
 */
export function normalizeForDuplicateCheck(keyword) {
  return (keyword || '')
    .normalize('NFC')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * @param {string} candidateKeyword - raw, not yet normalized
 * @param {string[]} existingKeywords - raw keyword strings already tracked
 *   on the project (e.g. SeoRankingCurrent.keywords[].keyword)
 * @returns {boolean}
 */
export function isDuplicateKeyword(candidateKeyword, existingKeywords) {
  const normalizedCandidate = normalizeForDuplicateCheck(candidateKeyword);
  return (existingKeywords || []).some(
    (existing) => normalizeForDuplicateCheck(existing) === normalizedCandidate
  );
}

/**
 * Pure quota math — no DB access. limit === null means unlimited.
 * @param {number} usedCount
 * @param {number|null} limit
 * @returns {{used:number, limit:number|null, remaining:number|null}}
 */
export function computeKeywordUsage(usedCount, limit) {
  return {
    used: usedCount,
    limit,
    remaining: limit === null ? null : Math.max(0, limit - usedCount),
  };
}
