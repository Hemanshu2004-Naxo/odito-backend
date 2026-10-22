/**
 * H1 value normalization — the single definition of "a valid H1 to write".
 *
 * The recommendation for h1_missing is model-generated text and frequently arrives as markup:
 *
 *     <h1>
 *       SEO Reseller Services by Naxonify
 *     </h1>
 *
 * Nothing model-generated is trusted. The value that reaches WordPress (and the value the
 * task is later verified against) is PLAIN TEXT: a single wrapping <h1> (no attributes) is
 * unwrapped, everything else that looks like markup is refused rather than "cleaned", because
 * a cleaned-up script/iframe/handler is still an attempt to inject one.
 *
 * Pure and dependency-free: used by the WordPress content adapters, TaskHistoryService (the
 * frozen expected-after value) and tests.
 */

export const H1_LIMITS = Object.freeze({ maxLength: 200 });

export const H1_ERRORS = Object.freeze({
  NOT_A_STRING: 'NOT_A_STRING',
  EMPTY: 'EMPTY',
  TOO_LONG: 'TOO_LONG',
  MULTIPLE_H1: 'MULTIPLE_H1',
  ATTRIBUTES: 'ATTRIBUTES',
  SCRIPT: 'SCRIPT',
  IFRAME: 'IFRAME',
  EVENT_HANDLER: 'EVENT_HANDLER',
  HTML_NOT_ALLOWED: 'HTML_NOT_ALLOWED',
  MALFORMED: 'MALFORMED',
  CONTROL_CHARACTERS: 'CONTROL_CHARACTERS',
  SHORTCODE_CHARACTERS: 'SHORTCODE_CHARACTERS',
});

const MESSAGES = {
  NOT_A_STRING: 'The H1 must be text.',
  EMPTY: 'The recommended H1 is empty.',
  TOO_LONG: `The recommended H1 is too long (maximum ${H1_LIMITS.maxLength} characters).`,
  MULTIPLE_H1: 'The recommendation contains more than one H1.',
  ATTRIBUTES: 'The recommended H1 carries HTML attributes, which are not allowed.',
  SCRIPT: 'The recommended H1 contains a script.',
  IFRAME: 'The recommended H1 contains an iframe.',
  EVENT_HANDLER: 'The recommended H1 contains an event handler.',
  HTML_NOT_ALLOWED: 'The recommended H1 contains HTML markup; an H1 must be plain text.',
  MALFORMED: 'The recommended H1 is malformed markup.',
  CONTROL_CHARACTERS: 'The recommended H1 contains control characters.',
  SHORTCODE_CHARACTERS: 'The recommended H1 contains square brackets, which are not allowed in a page-builder heading.',
};

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”' };

export function decodeEntities(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body.toLowerCase()) ? NAMED_ENTITIES[body.toLowerCase()] : whole;
  });
}

const fail = (code) => ({ ok: false, code, message: MESSAGES[code] });

/**
 * @param {unknown} raw
 * @returns {{ok: true, text: string} | {ok: false, code: string, message: string}}
 */
export function normalizeH1Value(raw) {
  if (typeof raw !== 'string') return fail(H1_ERRORS.NOT_A_STRING);
  let value = raw.trim();
  if (!value) return fail(H1_ERRORS.EMPTY);

  // Anything that is not one plain wrapper is examined as markup BEFORE any unwrapping.
  const h1Opens = value.match(/<\s*h1\b/gi) || [];
  if (h1Opens.length > 1) return fail(H1_ERRORS.MULTIPLE_H1);

  if (h1Opens.length === 1) {
    const wrapped = /^<\s*h1(\s[^>]*)?>([\s\S]*)<\s*\/\s*h1\s*>$/i.exec(value);
    if (!wrapped) return fail(H1_ERRORS.MALFORMED);
    if (wrapped[1] && wrapped[1].trim()) return fail(H1_ERRORS.ATTRIBUTES);
    value = wrapped[2];
  }

  if (/<\s*script/i.test(value)) return fail(H1_ERRORS.SCRIPT);
  if (/<\s*iframe/i.test(value)) return fail(H1_ERRORS.IFRAME);
  if (/<[^>]*\son[a-z]+\s*=/i.test(value)) return fail(H1_ERRORS.EVENT_HANDLER);
  if (/[<>]/.test(value)) return fail(H1_ERRORS.HTML_NOT_ALLOWED);

  // Entities are decoded so the value is compared/written as the text it really is, and
  // re-checked so "&lt;script&gt;" cannot smuggle markup past the check above.
  const decoded = decodeEntities(value);
  if (/[<>]/.test(decoded)) return fail(H1_ERRORS.HTML_NOT_ALLOWED);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(decoded)) return fail(H1_ERRORS.CONTROL_CHARACTERS);
  if (/[[\]]/.test(decoded) || /%(22|91|93)/i.test(decoded)) return fail(H1_ERRORS.SHORTCODE_CHARACTERS);

  const text = decoded.replace(/\s+/g, ' ').trim();
  if (!text) return fail(H1_ERRORS.EMPTY);
  if (text.length > H1_LIMITS.maxLength) return fail(H1_ERRORS.TOO_LONG);
  return { ok: true, text };
}

/** The plain-text H1, or null when the value is not a valid H1. */
export function extractH1TextValue(raw) {
  const result = normalizeH1Value(raw);
  return result.ok ? result.text : null;
}

export default { normalizeH1Value, extractH1TextValue, decodeEntities, H1_LIMITS, H1_ERRORS };
