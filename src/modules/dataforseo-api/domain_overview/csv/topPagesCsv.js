import { csvLine } from './backlinksCsv.js';
import { FLAG_LABELS } from '../provider/pageMetrics.js';

/**
 * The CSV of the Top Pages export (built on the server, streamed). The same columns, in the same order, as the page's "Export current page"
 * (the frontend's exportCsv.js): the two files have one header. Every derived value (normalised URL, dofollow share, flags, suggested fix) is
 * the one the server already computed. A missing value is an empty cell, never 0 (a page whose traffic could not be joined has an EMPTY
 * traffic cell); the formula guard is in csvCell.
 */

const pct = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

/** [header, value(payloadRow)] — the order is the file's column order. */
export const TP_CSV_COLUMNS = Object.freeze([
  ['URL', (r) => r.url],
  ['Normalised URL', (r) => r.normalized_url],
  ['Status', (r) => r.status_code],
  ['Redirect target', (r) => r.location],
  ['Title', (r) => r.title],
  ['Referring domains', (r) => r.referring_domains],
  ['Backlinks', (r) => r.backlinks],
  ['Broken backlinks', (r) => r.broken_backlinks],
  ['Dofollow %', (r) => pct(r.dofollow_pct)],
  ['Rank', (r) => r.rank],
  ['Est. traffic', (r) => r.traffic],
  ['Keywords', (r) => r.keywords],
  ['Flags', (r) => (r.flags?.length ? r.flags.map((f) => FLAG_LABELS[f] ?? f).join('; ') : null)],
  ['Suggested fix', (r) => r.suggested_fix],
  ['First seen', (r) => r.first_seen],
  ['Last crawled', (r) => r.fetch_time],
]);

export const TP_CSV_HEADER = TP_CSV_COLUMNS.map(([h]) => h);
export const topPageCsvLine = (row) => csvLine(TP_CSV_COLUMNS.map(([, get]) => get(row)));
