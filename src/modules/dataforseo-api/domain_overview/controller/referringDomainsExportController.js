import { getDomainOverviewSection } from '../service/domainOverviewService.js';
import { getDomainLists } from '../service/domainListService.js';
import { parseReferringDomainsQuery } from '../validator/referringDomainsQuery.js';
import { REFERRING_DOMAINS_EXPORT } from '../config.js';
import { ValidationFailure } from '../../shared/targetDomain.js';
import { LoggerUtil } from '../../../../utils/LoggerUtil.js';
import { RD_CSV_HEADER, referringDomainCsvLine } from '../csv/referringDomainsCsv.js';
import { csvLine } from '../csv/backlinksCsv.js';
import { sendError } from './domainOverviewController.js';

/**
 * "Export with current filters" for the Referring Domains page, done on the server: the same status / dofollow / sort / filters as the page,
 * fetched in batches of 1,000 by offset, up to REFERRING_DOMAINS_EXPORT.maxRows, and STREAMED back as CSV.
 *
 *  - Every batch goes through the normal section service, so it is cached (24 h) like any page: exporting the same thing twice is free.
 *  - The first batch is fetched BEFORE the response starts, so a provider failure is an ordinary JSON error. The headers then carry the
 *    number of rows the file will have (X-Export-Rows), which is what the browser's progress bar counts against.
 *  - If the browser cancels, no further batch is fetched: nothing more is bought.
 *  - A failure after the file has started drops the connection instead of ending the file normally, so a truncated export is never taken for a
 *    complete one.
 *  - The "Disavowed" column comes from the project's saved list, read explicitly (the field is select:false).
 * Runs AFTER auth + validateProjectAccess().
 */

const FORBIDDEN = ['limit', 'offset', 'token'];

/** GET /projects/:projectId/referring-domains-export?status&dofollow&order_by&filters[&max_rows] */
export async function exportReferringDomains(req, res) {
  let aborted = false;
  res.on('close', () => { if (!res.writableEnded) aborted = true; });
  const userId = String(req.user?._id || '');
  try {
    for (const k of FORBIDDEN) if (req.query[k] !== undefined) throw new ValidationFailure(k, `${k} is not accepted by the export: it pages by itself`);
    let wanted = REFERRING_DOMAINS_EXPORT.maxRows;
    if (req.query.max_rows !== undefined) {
      const n = /^\d{1,6}$/.test(String(req.query.max_rows)) ? Number(req.query.max_rows) : NaN;
      if (!(n >= 1)) throw new ValidationFailure('max_rows', 'max_rows must be a positive whole number');
      wanted = Math.min(n, REFERRING_DOMAINS_EXPORT.maxRows);
    }
    const base = { status: req.query.status, dofollow: req.query.dofollow, order_by: req.query.order_by, filters: req.query.filters };
    const batch = (n) => parseReferringDomainsQuery({ ...base, limit: String(REFERRING_DOMAINS_EXPORT.batch), ...(n ? { offset: String(n * REFERRING_DOMAINS_EXPORT.batch) } : {}) });

    const lists = await getDomainLists(req.project._id);
    const ctx = { disavowed: new Set(lists.disavowed) };
    const first = await getDomainOverviewSection({ project: req.project, section: 'referring-domains', query: batch(0), userId });
    const total = first.result.totalCount ?? 0;
    const rows = Math.min(total, wanted);
    const batches = Math.ceil(rows / REFERRING_DOMAINS_EXPORT.batch);

    res.status(200);
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="referring-domains.csv"',
      'Cache-Control': 'no-store',
      'X-Export-Rows': String(rows),
      'X-Export-Batches': String(batches),
      'Access-Control-Expose-Headers': 'X-Export-Rows, X-Export-Batches, Content-Disposition',
    });
    res.write(`﻿${csvLine(RD_CSV_HEADER)}`);

    let written = 0;
    let current = first;
    for (let n = 0; ; n += 1) {
      const chunk = current.result.items.slice(0, rows - written).map((r) => referringDomainCsvLine(r, ctx)).join('');
      if (chunk && !res.write(chunk)) await new Promise((resolve) => res.once('drain', resolve));
      written += Math.min(current.result.items.length, rows - written);
      if (written >= rows || current.result.items.length === 0 || aborted || n + 1 >= batches) break;
      // eslint-disable-next-line no-await-in-loop
      current = await getDomainOverviewSection({ project: req.project, section: 'referring-domains', query: batch(n + 1), userId });
      if (aborted) break;
    }
    LoggerUtil.info('Referring domains export finished', { projectId: String(req.project._id), rows, written, aborted });
    return res.end();
  } catch (err) {
    if (res.headersSent) {
      LoggerUtil.warn('Referring domains export failed after it started; the connection is dropped so the file is not mistaken for a complete one', { code: err?.code });
      return res.destroy();
    }
    return sendError(res, err, { userId, projectId: String(req.project?._id || ''), section: 'referring-domains-export' });
  }
}
