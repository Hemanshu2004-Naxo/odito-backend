/**
 * Divi 4 (shortcode) page content: a small, quote-aware tag parser and a minimal-edit writer.
 *
 * Divi 4 stores a page as shortcodes in post_content:
 *
 *   <!-- wp:divi/placeholder -->
 *   [et_pb_section admin_label="Page Title Section" ...][et_pb_row ...][et_pb_column ...]
 *     [et_pb_heading title="@ET-DC@eyJ...@" title_level="h2" _dynamic_attributes="title" ...][/et_pb_heading]
 *   [/et_pb_column][/et_pb_row][/et_pb_section]
 *   <!-- /wp:divi/placeholder -->
 *
 * Nothing here treats the content as HTML and nothing is regex-replaced across the document.
 * Tags are located with exact offsets, and an edit replaces ONLY the attribute value ranges it
 * targets (or removes/inserts a single attribute) — every other character of the content,
 * including all unrelated modules, their settings, whitespace and the wp:divi/placeholder
 * comments, is preserved byte for byte. That is what makes "only this heading changed"
 * checkable (see the adapter's verify step).
 */

export class DiviParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DiviParseError';
  }
}

const TAG_START = /\[(\/?)(et_pb_[a-z0-9_]+)/g;
const WS = /\s/;

/**
 * @typedef {{name: string, value: string, start: number, end: number, valueStart: number, valueEnd: number, quoted: boolean}} Attr
 * @typedef {{name: string, closing: boolean, start: number, end: number, attrs: Attr[]}} Tag
 */

/** Every et_pb_* opening/closing tag, in document order. @returns {Tag[]} */
export function parseTags(raw) {
  const tags = [];
  for (const m of raw.matchAll(TAG_START)) {
    const start = m.index;
    let i = start + m[0].length;
    const closing = m[1] === '/';
    const name = m[2];
    const attrs = [];

    if (closing) {
      const close = raw.indexOf(']', i);
      if (close === -1) throw new DiviParseError(`Unterminated closing tag [/${name}`);
      tags.push({ name, closing: true, start, end: close + 1, attrs });
      continue;
    }

    for (;;) {
      while (i < raw.length && WS.test(raw[i])) i += 1;
      if (i >= raw.length) throw new DiviParseError(`Unterminated tag [${name}`);
      if (raw[i] === ']') { i += 1; break; }
      if (raw[i] === '/' && raw[i + 1] === ']') { i += 2; break; }

      const nameMatch = /^[A-Za-z0-9_:-]+/.exec(raw.slice(i, i + 96));
      if (!nameMatch) throw new DiviParseError(`Malformed attribute in [${name} at offset ${i}`);
      const attrStart = i;
      i += nameMatch[0].length;
      let value = '';
      let valueStart = i;
      let valueEnd = i;
      let quoted = false;
      if (raw[i] === '=') {
        i += 1;
        if (raw[i] === '"') {
          quoted = true;
          valueStart = i + 1;
          const close = raw.indexOf('"', valueStart);
          if (close === -1) throw new DiviParseError(`Unterminated attribute value in [${name}`);
          valueEnd = close;
          i = close + 1;
        } else {
          valueStart = i;
          while (i < raw.length && !WS.test(raw[i]) && raw[i] !== ']') i += 1;
          valueEnd = i;
        }
        value = raw.slice(valueStart, valueEnd);
      }
      attrs.push({ name: nameMatch[0], value, start: attrStart, end: i, valueStart, valueEnd, quoted });
    }
    tags.push({ name, closing: false, start, end: i, attrs });
  }
  return tags;
}

export const getAttr = (tag, name) => tag.attrs.find((a) => a.name === name);
export const attrValue = (tag, name) => getAttr(tag, name)?.value;

/**
 * Applies attribute edits to ONE tag and returns the new content. Edits are
 * {name, value: string} (set; added if missing) or {name, value: null} (remove).
 * Only those characters change; the rest of `raw` is returned untouched.
 */
export function editTag(raw, tag, edits) {
  const replacements = []; // {start, end, text}
  let insertAt = tag.attrs.length ? tag.attrs[tag.attrs.length - 1].end : tag.start + 1 + tag.name.length;
  let inserted = '';

  for (const { name, value } of edits) {
    const attr = getAttr(tag, name);
    if (value === null) {
      if (attr) replacements.push({ start: attr.start - 1, end: attr.end, text: '' }); // also drops the one space before it
    } else if (attr) {
      if (!attr.quoted) throw new DiviParseError(`Attribute ${name} is not quoted; refusing to rewrite it`);
      replacements.push({ start: attr.valueStart, end: attr.valueEnd, text: value });
    } else {
      inserted += ` ${name}="${value}"`;
    }
  }
  if (inserted) replacements.push({ start: insertAt, end: insertAt, text: inserted });

  let out = raw;
  for (const r of replacements.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, r.start) + r.text + out.slice(r.end);
  }
  return out;
}

/** Top-level sections in order: {open: Tag, closeStart, closeEnd}. Divi sections never nest. */
export function findSections(raw, tags = parseTags(raw)) {
  const sections = [];
  const opens = tags.filter((t) => t.name === 'et_pb_section' && !t.closing);
  for (const open of opens) {
    const close = tags.find((t) => t.name === 'et_pb_section' && t.closing && t.start > open.end);
    if (!close) throw new DiviParseError('Section without a closing [/et_pb_section]');
    sections.push({ open, closeStart: close.start, closeEnd: close.end });
  }
  return sections;
}

// ── attribute value encoding (what the Divi builder itself writes) ───────────

/** Plain text -> a value safe inside a double-quoted Divi attribute. */
export function encodeAttrValue(text) {
  return String(text).replace(/&/g, '&amp;').replace(/"/g, '%22').replace(/\[/g, '%91').replace(/\]/g, '%93');
}

export function decodeAttrValue(value) {
  return String(value).replace(/%22/g, '"').replace(/%91/g, '[').replace(/%93/g, ']').replace(/&amp;/g, '&');
}

/**
 * Divi "dynamic content" values look like `@ET-DC@<base64 json>@`. Returns the parsed
 * descriptor ({dynamic: true, content: 'post_title', settings}) or null.
 */
export function decodeDynamicContent(value) {
  const m = /^@ET-DC@([A-Za-z0-9+/=_-]+)@$/.exec(String(value || ''));
  if (!m) return null;
  try {
    const parsed = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export default { DiviParseError, parseTags, getAttr, attrValue, editTag, findSections, encodeAttrValue, decodeAttrValue, decodeDynamicContent };
