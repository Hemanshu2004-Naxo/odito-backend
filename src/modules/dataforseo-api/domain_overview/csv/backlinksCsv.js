/**
 * The CSV of the Backlinks export (built on the server, streamed). The columns are the Backlinks page's own, in the same order as its
 * "Export current page" (the frontend's exportCsv.js): the two files have the same header. A missing value is an empty cell, never 0;
 * provider text is formula-guarded (a cell starting with = + - @ would run as a formula in a spreadsheet).
 */

export function csvCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csvLine = (cells) => `${cells.map(csvCell).join(',')}\r\n`;

const yn = (v) => (v === true ? 'yes' : v === false ? 'no' : null);

/** [header, value(payloadRow)] — the order is the file's column order. */
export const BACKLINK_CSV_COLUMNS = Object.freeze([
  ['Source URL', (b) => b.url_from],
  ['Source title', (b) => b.page_from_title],
  ['Source domain', (b) => b.domain_from],
  ['Domain rank', (b) => b.domain_from_rank],
  ['Page rank', (b) => b.page_from_rank],
  ['Anchor', (b) => b.anchor ?? b.alt],
  ['Item type', (b) => b.item_type],
  ['Target URL', (b) => b.url_to],
  ['Target status', (b) => b.url_to_status_code],
  ['Redirect target', (b) => b.url_to_redirect_target],
  ['Dofollow', (b) => yn(b.dofollow)],
  ['Attributes', (b) => (b.attributes?.length ? b.attributes.join('; ') : null)],
  ['Placement', (b) => b.semantic_location],
  ['Spam score', (b) => b.backlink_spam_score],
  ['Country', (b) => b.domain_from_country],
  ['First seen', (b) => b.first_seen],
  ['Last seen', (b) => b.last_seen],
  ['New', (b) => yn(b.is_new)],
  ['Lost', (b) => yn(b.is_lost)],
  ['Broken', (b) => yn(b.is_broken)],
]);

export const BACKLINK_CSV_HEADER = BACKLINK_CSV_COLUMNS.map(([h]) => h);
export const backlinkCsvLine = (b) => csvLine(BACKLINK_CSV_COLUMNS.map(([, get]) => get(b)));
