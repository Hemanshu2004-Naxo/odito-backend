import { ALL_COLUMNS } from './bulkImportConstants.js';

/**
 * Bulk Upload — the ONE place CSV cells are escaped for files Odito
 * EMITS (the template + the Phase 3 error report). Every value is
 * treated as untrusted user input.
 *
 * Formula-injection hardening: a cell whose first character is a
 * spreadsheet formula trigger (`= + - @`, TAB, CR) is prefixed with a
 * single quote so a spreadsheet opens it as literal text. Then standard
 * RFC-4180 quoting is applied for commas / quotes / newlines.
 */
export function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /["\r\n,]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

export function csvRow(fields) {
  return fields.map(csvCell).join(',');
}

/** The downloadable import template — header row + three worked examples. */
export function buildTemplateCsv() {
  const lines = [
    ALL_COLUMNS.join(','),
    csvRow(['facebook', 'Our latest product update is live!', 'https://cdn.example.com/launch.jpg', '2026-09-10 10:00', 'Asia/Kolkata', 'schedule']),
    csvRow(['instagram', 'New drop - swipe to see more.', 'https://cdn.example.com/launch.jpg', '2026-09-10 11:00', 'Asia/Kolkata', 'schedule']),
    csvRow(['facebook', 'A quick text-only announcement.', '', '', '', 'draft']),
  ];
  return `${lines.join('\r\n')}\r\n`;
}

const ERROR_REPORT_HEADERS = ['row_number', 'platform', 'content', 'status', 'error_codes', 'error_messages'];
const MAX_CONTENT_IN_REPORT = 2000;

/**
 * Builds the error-report CSV from SocialImportRow documents (already
 * filtered to status invalid|failed and ownership-checked by the
 * caller). Exposes only safe, user-facing fields — never `raw`,
 * `idempotencyKey`, `fileHash`, `batch_id`, or a Mongo `_id`.
 */
export function buildErrorReportCsv(rows) {
  const lines = [ERROR_REPORT_HEADERS.join(',')];
  for (const row of rows) {
    const platform = row.normalized?.platform || row.raw?.platform || '';
    const rawContent = row.normalized?.content ?? row.raw?.content ?? '';
    const content = String(rawContent).slice(0, MAX_CONTENT_IN_REPORT);
    const errs = Array.isArray(row.errors) ? row.errors : [];
    lines.push(csvRow([
      row.rowNumber,
      platform,
      content,
      row.status,
      errs.map((e) => e.code).join('; '),
      errs.map((e) => e.message).join(' | '),
    ]));
  }
  return `${lines.join('\r\n')}\r\n`;
}
