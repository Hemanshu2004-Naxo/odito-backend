/**
 * promptSafety - ONE way every Social Media AI prompt (strategy, calendar, single post) turns text that a person or a website supplied
 * into a value that is safe to put inside a delimited DATA block.
 *
 * The prompts never put such text in the system message; they put it in the user message, one `label: value` line each, inside
 * `<block>` ... `</block>` delimiters, and tell the model the block is data. The remaining way for a value to attack that structure is to
 * LOOK like a delimiter (`</business>`, `<system>`) - so the one character that can start a delimiter, `<`, is made visibly different
 * wherever it could open or close a tag. Everything else is kept, so legitimate business content is not damaged:
 * "5 < 10", "<3", "Tom & Jerry's", prices, accents, emoji and non-Latin scripts are all passed through unchanged.
 *
 * Also: control characters become spaces, line breaks collapse (a value can never start a new line of instructions), and the length is bounded.
 */

// U+2039 SINGLE LEFT-POINTING ANGLE QUOTATION MARK: reads the same to a person, can never open a tag
const OPEN_ANGLE_QUOTE = String.fromCharCode(0x2039);
const LOOKS_LIKE_A_TAG = /<(?=[/!?]?[A-Za-z_])/g;
const CONTROL = new RegExp(`[\x00-\x08\x0B\x0C\x0E-\x1F\x7F${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`, 'g');

/** `<` that could begin a tag - directly followed by a name, `/`, `!` or `?` (`<x`, `</x`, `<!x`, `<?x`) - becomes U+2039; a `<` followed by a space or a digit (a comparison, a heart) is kept; every other `<` and every `>` is left alone. */
export const neutralizeDelimiters = (text) => String(text ?? '').replace(LOOKS_LIKE_A_TAG, OPEN_ANGLE_QUOTE);

/**
 * @param {*} value anything; null / undefined give ''
 * @param {{ max?: number }} [options]
 * @returns {string} one line, at most `max` characters, containing nothing that can imitate a prompt delimiter
 */
export function cleanPromptValue(value, { max = 400 } = {}) {
  return neutralizeDelimiters(String(value ?? '').replace(CONTROL, ' ').replace(/\r?\n/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, max);
}

export default { neutralizeDelimiters, cleanPromptValue };
