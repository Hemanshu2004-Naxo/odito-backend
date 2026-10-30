import { getDomainOverviewSection } from '../service/domainOverviewService.js';
import { parseBacklinksListQuery } from '../validator/backlinksListQuery.js';
import { BACKLINKS_EXPORT } from '../config.js';
import { ValidationFailure } from '../../shared/targetDomain.js';
import { LoggerUtil } from '../../../../utils/LoggerUtil.js';
import { BACKLINK_CSV_HEADER, backlinkCsvLine, csvLine } from '../csv/backlinksCsv.js';
import { sendError } from './domainOverviewController.js';

/**
 * "Export with current filters" for the Backlinks page, done on the server: the same tab / group / sort / filters as the page, fetched in
 * batches of 1,000 following each response's search_after_token, up to BACKLINKS_EXPORT.maxRows, and STREAMED back as CSV.
 *
 *  - Every batch goes through the normal section service, so it is cached (24 h) like any page: exporting the same thing twice is free.
 *  - The first batch is fetched BEFORE the response starts, so a provider failure is an ordinary JSON error. The headers then carry the
 *    number of rows the file will have (X-Export-Rows), which is what the browser's progress bar counts against.
 *  - If the browser cancels (closes the request), no further batch is fetched: nothing more is bought.
 *  - A failure after the file has started drops the connection instead of ending the file normally, so a truncated export can never be
 *    mistaken for a complete one.
 * Runs AFTER auth + validateProjectAccess().
 */

const FORBIDDEN = ['limit', 'offset', 'token'];

/** GET /projects/:projectId/backlinks-export?status&mode&order_by&filters[&max_rows] */
export async function exportBacklinks(req, res) {
  let aborted = false;
  res.on('close', () => { if (!res.writableEnded) aborted = true; });
  try {
    for (const k of FORBIDDEN) if (req.query[k] !== undefined) throw new ValidationFailure(k, `${k} is not accepted by the export: it pages by itself`);
    // The browser says how many rows the user agreed to (and was shown the cost of); the server never exports more than that or the cap.
    let wanted = BACKLINKS_EXPORT.maxRows;
    if (req.query.max_rows !== undefined) {
      const n = /^\d{1,6}$/.test(String(req.query.max_rows)) ? Number(req.query.max_rows) : NaN;
      if (!(n >= 1)) throw new ValidationFailure('max_rows', 'max_rows must be a positive whole number');
      wanted = Math.min(n, BACKLINKS_EXPORT.maxRows);
    }
    const base = { status: req.query.status, mode: req.query.mode, order_by: req.query.order_by, filters: req.query.filters };
    const batch = (token) => parseBacklinksListQuery({ ...base, limit: String(BACKLINKS_EXPORT.batch), ...(token ? { token } : {}) });

    const first = await getDomainOverviewSection({ project: req.project, section: 'backlinks-list', query: batch(null) });
    const total = first.result.totalCount ?? 0;
    const rows = Math.min(total, wanted);
    const batches = Math.ceil(rows / BACKLINKS_EXPORT.batch);

    res.status(200);
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="backlinks.csv"',
      'Cache-Control': 'no-store',
      'X-Export-Rows': String(rows),
      'X-Export-Batches': String(batches),
      'Access-Control-Expose-Headers': 'X-Export-Rows, X-Export-Batches, Content-Disposition',
    });
    res.write(`﻿${csvLine(BACKLINK_CSV_HEADER)}`);

    let written = 0;
    let current = first;
    for (let n = 0; ; n += 1) {
      const chunk = current.result.items.slice(0, rows - written).map(backlinkCsvLine).join('');
      if (chunk && !res.write(chunk)) await new Promise((resolve) => res.once('drain', resolve));
      written += Math.min(current.result.items.length, rows - written);
      const token = current.result.nextToken;
      if (written >= rows || !token || current.result.items.length === 0 || aborted) break;
      // eslint-disable-next-line no-await-in-loop
      current = await getDomainOverviewSection({ project: req.project, section: 'backlinks-list', query: batch(token) });
      if (aborted) break;
    }
    LoggerUtil.info('Backlinks export finished', { projectId: String(req.project._id), rows, written, aborted });
    return res.end();
  } catch (err) {
    if (res.headersSent) {
      LoggerUtil.warn('Backlinks export failed after it started; the connection is dropped so the file is not mistaken for a complete one', { code: err?.code });
      return res.destroy();
    }
    return sendError(res, err, { userId: String(req.user?._id || ''), projectId: String(req.project?._id || ''), section: 'backlinks-export' });
  }
}
