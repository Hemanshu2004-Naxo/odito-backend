import { createRequire } from 'module';
import { CanonicalReportService } from '../report/canonicalReportService.js';
import { defaultReportDeps } from '../report/defaultReportDeps.js';
import { getFontCss } from './fonts.js';
import { buildPdfFilename } from './filename.js';
import { getPdfBrowserService, PdfRenderError } from './pdfBrowserService.js';

const require = createRequire(import.meta.url);
let docModule = null;
// Generated bundle of the frontend report pages (frontend/scripts/build-pdf-renderer.mjs).
const loadDocumentRenderer = () => (docModule ??= require('./vendor/reportDocument.cjs'));

/** Count PDF page objects (/Type /Page, not /Pages). */
export function countPdfPages(buf) {
  const m = buf.toString('latin1').match(/\/Type\s*\/Page(?![s\w])/g);
  return m ? m.length : 0;
}

/**
 * Build the canonical report for a project (+ optional audit run), render the
 * report pages to HTML, and print them to a PDF with Chromium.
 *
 * The report comes straight from CanonicalReportService via the backend's own
 * deps: no HTTP request, no user token, no public render route.
 */
export async function generateFullAuditPdf(
  projectId,
  { auditNumber = null, deps = defaultReportDeps, renderer = getPdfBrowserService(), now = new Date() } = {}
) {
  const report = await CanonicalReportService.build(projectId, { auditNumber, deps });
  const { renderReportDocument } = loadDocumentRenderer();
  const { html, pageCount, pageIds } = renderReportDocument(report, { fontCss: getFontCss(), generatedAt: now });

  const pdf = await renderer.renderPdf(html, { expectedPages: pageCount });
  const pages = countPdfPages(pdf);
  if (pages !== pageCount) {
    // Content overflowing a sheet would add pages; never ship a mis-paginated file.
    throw new PdfRenderError(`PDF has ${pages} page(s) but the report has ${pageCount}.`, 'RENDER_INVALID', 500);
  }
  const filename = buildPdfFilename({
    projectName: report.metadata.projectName,
    domain: report.metadata.domain,
    auditNumber: report.metadata.audit?.auditNumber ?? null,
    date: report.metadata.auditDate || now,
  });
  return {
    pdf, filename, pages, pageIds,
    report: { schemaVersion: report.schemaVersion, auditNumber: report.metadata.audit?.auditNumber ?? null },
  };
}
