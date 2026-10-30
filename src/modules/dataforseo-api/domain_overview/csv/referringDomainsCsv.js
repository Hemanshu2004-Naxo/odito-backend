import { csvLine } from './backlinksCsv.js';

/**
 * The CSV of the Referring Domains export (built on the server, streamed). The same columns, in the same order, as the page's "Export current
 * page" (the frontend's exportCsv.js): the two files have one header. Every derived value (quality, dofollow share, top country, placement)
 * is the one the server already computed when it parsed the row. A missing value is an empty cell, never 0; the formula guard is in csvCell.
 */

const QUALITY_LABEL = Object.freeze({ high: 'High', medium: 'Medium', low: 'Low', toxic: 'Toxic' });
const pct = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

/** [header, value(payloadRow, { disavowed })] — the order is the file's column order. */
export const RD_CSV_COLUMNS = Object.freeze([
  ['Domain', (r) => r.domain],
  ['Quality', (r) => QUALITY_LABEL[r.quality] ?? null],
  ['Rank', (r) => r.rank],
  ['Backlinks', (r) => r.backlinks],
  ['Referring pages', (r) => r.referring_pages],
  ['Dofollow %', (r) => pct(r.dofollow_pct)],
  ['Spam score', (r) => r.backlinks_spam_score],
  ['Placement', (r) => (r.main_placement === '' ? null : r.main_placement)],
  ['Top country', (r) => (r.top_country === '' ? null : r.top_country)],
  ['Broken backlinks', (r) => r.broken_backlinks],
  ['First seen', (r) => r.first_seen],
  ['Lost date', (r) => r.lost_date],
  ['Disavowed', (r, ctx) => (ctx.disavowed.has(r.domain) ? 'yes' : 'no')],
]);

export const RD_CSV_HEADER = RD_CSV_COLUMNS.map(([h]) => h);
export const referringDomainCsvLine = (row, ctx) => csvLine(RD_CSV_COLUMNS.map(([, get]) => get(row, ctx)));
