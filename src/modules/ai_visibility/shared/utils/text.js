/**
 * Text hygiene for UNTRUSTED business data (customer-typed fields, website-extracted metadata) and for
 * model-generated prompt text. Pure functions, no I/O.
 */

// C0/C1 control characters, zero-width / bidi-control characters, line and paragraph separators, BOM.
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202F\u2060-\u2064\uFEFF]/g;

/** Trim, normalize (NFC), remove control/invisible characters, collapse whitespace, cap the length. null when nothing is left. */
export function cleanText(value, maxLen = 200) {
  if (typeof value !== 'string') return null;
  let s = value.normalize('NFC').replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (s.length > maxLen) s = s.slice(0, maxLen).trim();
  return s || null;
}

/**
 * Phrases that only make sense as an attempt to steer a model or smuggle configuration/markup. A legitimate
 * business name, service, competitor, industry, location - or a search-style prompt - contains none of them.
 */
export const INSTRUCTION_PATTERNS = Object.freeze([
  /\b(ignore|disregard|forget|override|bypass)\b[^.?!]{0,40}\b(instructions?|prompts?|rules?|above|previous|system|guidelines?)\b/i,
  /\bsystem\s*(prompt|message|instructions?)\b/i,
  /\byou\s+are\s+(now|no\s+longer)\b/i,
  /\b(new|updated|real)\s+instructions?\b/i,
  /\b(api[\s_-]?key|secret[\s_-]?key|password|bearer)\b/i,
  /\b(model_name|web_search|max_output_tokens|user_prompt|response_format|json_schema)\b/i,
  /\bjailbreak\b/i,
  /<\s*\/?\s*[a-z!][^>]*>/i, // HTML / XML tags
  /```/, // code fences
  /\{\{|\}\}|\$\{|<\||\|>|\[\/?INST\]/, // template / chat-format delimiters
  /\b(rm\s+-rf|drop\s+table|select\s+\*\s+from)\b/i,
]);

export function looksLikeInstruction(text) {
  if (typeof text !== 'string') return false;
  return INSTRUCTION_PATTERNS.some((re) => re.test(text));
}

/** URLs / bare domains inside free text. Prompts and business facts must never carry them. */
const URL_LIKE = /(https?:\/\/|ftp:\/\/|www\.)|\b[a-z0-9][a-z0-9-]*\.(com|net|org|io|co|in|uk|us|app|dev|ai|info|biz|edu|gov|me|xyz|site|online|store|shop)\b(\/|\b)/i;
export function containsUrlLike(text) {
  return typeof text === 'string' && URL_LIKE.test(text);
}

/**
 * Cleans one untrusted fact. Returns { value, flagged }: `value` is null when the input is empty OR looks like an
 * instruction / carries a URL (so it is dropped rather than passed on), `flagged` says why a non-empty input was dropped.
 * `allowUrlLike` is for brand names, which may legitimately look like a domain ("Booking.com").
 */
export function sanitizeFact(raw, maxLen = 150, { allowUrlLike = false } = {}) {
  const value = cleanText(raw, maxLen);
  if (!value) return { value: null, flagged: false };
  if (looksLikeInstruction(value) || (!allowUrlLike && containsUrlLike(value))) return { value: null, flagged: true };
  return { value, flagged: false };
}

/** Lower-case, NFKC, collapsed whitespace - the canonical form for comparing and hashing short strings. */
export function normalizeKey(value) {
  if (typeof value !== 'string') return '';
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim();
}

export default { cleanText, sanitizeFact, normalizeKey, looksLikeInstruction, containsUrlLike, INSTRUCTION_PATTERNS };
