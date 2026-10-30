import { getTopPagesSection, loadTraffic } from '../service/topPagesService.js';
import { parseDomainPagesQuery } from '../validator/domainPagesQuery.js';
import { TOP_PAGES_EXPORT } from '../config.js';
import { ValidationFailure } from '../../shared/targetDomain.js';
import { LoggerUtil } from '../../../../utils/LoggerUtil.js';
import { TP_CSV_HEADER, topPageCsvLine } from '../csv/topPagesCsv.js';
import { csvLine } from '../csv/backlinksCsv.js';
import { sendError } from './domainOverviewController.js';

/**
 * "Export with current filters" for the Top Pages page, done on the server: the same sort / filters as the page, fetched in batches of 1,000 by
 * offset, up to TOP_PAGES_EXPORT.maxRows, and STREAMED back as CSV — with the SAME traffic join the table has (loaded once for the whole file).
 *
 *  - Every batch goes through the normal section service, so it is cached (24 h) like any page: exporting the same thing twice is free.
 *  - The first batch is fetched BEFORE the response starts, so a provider failure is an ordinary JSON error. The headers then carry the number of
 *    rows the file will have (X-Export-Rows), which is what the browser's progress bar counts against.
 *  - If the browser cancels, no further batch is fetched. A failure after the file has started drops the connection, so a truncated export is
 *    never taken for a complete one.
 * Runs AFTER auth + validateProjectAccess().
 */

const FORBIDDEN = ['limit', 'offset', 'token', 'status'];

/** GET /projects/:projectId/top-pages-export?order_by&filters[&max_rows] */
export async function exportTopPages(req, res) {
  let aborted = false;
  res.on('close', () => { if (!res.writableEnded) aborted = true; });
  const userId = String(req.user?._id || '');
  try {
    for (const k of FORBIDDEN) if (req.query[k] !== undefined) throw new ValidationFailure(k, `${k} is not accepted by the export: it pages by itself`);
    let wanted = TOP_PAGES_EXPORT.maxRows;
    if (req.query.max_rows !== undefined) {
      const n = /^\d{1,6}$/.test(String(req.query.max_rows)) ? Number(req.query.max_rows) : NaN;
      if (!(n >= 1)) throw new ValidationFailure('max_rows', 'max_rows must be a positive whole number');
      wanted = Math.min(n, TOP_PAGES_EXPORT.maxRows);
    }
    const base = { order_by: req.query.order_by, filters: req.query.filters };
    const batch = (n) => parseDomainPagesQuery({ ...base, limit: String(TOP_PAGES_EXPORT.batch), ...(n ? { offset: String(n * TOP_PAGES_EXPORT.batch) } : {}) });

    // The query is validated before anything is bought: a bad filter is a 400, not a charge.
    const firstQuery = batch(0);
    const traffic = await loadTraffic({ project: req.project, userId });
    const first = await getTopPagesSection({ project: req.project, section: 'domain-pages', query: firstQuery, userId, traffic });
    const total = first.result.totalCount ?? 0;
    const rows = Math.min(total, wanted);
    const batches = Math.ceil(rows / TOP_PAGES_EXPORT.batch);

    res.status(200);
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="top-pages.csv"',
      'Cache-Control': 'no-store',
      'X-Export-Rows': String(rows),
      'X-Export-Batches': String(batches),
      'Access-Control-Expose-Headers': 'X-Export-Rows, X-Export-Batches, Content-Disposition',
    });
    res.write(`﻿${csvLine(TP_CSV_HEADER)}`);

    let written = 0;
    let current = first;
    for (let n = 0; ; n += 1) {
      const chunk = current.result.items.slice(0, rows - written).map(topPageCsvLine).join('');
      if (chunk && !res.write(chunk)) await new Promise((resolve) => res.once('drain', resolve));
      written += Math.min(current.result.items.length, rows - written);
      if (written >= rows || current.result.items.length === 0 || aborted || n + 1 >= batches) break;
      // eslint-disable-next-line no-await-in-loop
      current = await getTopPagesSection({ project: req.project, section: 'domain-pages', query: batch(n + 1), userId, traffic });
      if (aborted) break;
    }
    LoggerUtil.info('Top pages export finished', { projectId: String(req.project._id), rows, written, aborted });
    return res.end();
  } catch (err) {
    if (res.headersSent) {
      LoggerUtil.warn('Top pages export failed after it started; the connection is dropped so the file is not mistaken for a complete one', { code: err?.code });
      return res.destroy();
    }
    return sendError(res, err, { userId, projectId: String(req.project?._id || ''), section: 'top-pages-export' });
  }
}
