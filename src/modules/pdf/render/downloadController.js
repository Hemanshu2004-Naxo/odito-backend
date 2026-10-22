import mongoose from 'mongoose';
import { generateFullAuditPdf } from './fullAuditPdfService.js';
import { PdfRenderError } from './pdfBrowserService.js';
import { ReportError } from '../report/canonicalReportService.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

const err = (res, status, message, code) => res.status(status).json({ success: false, error: { message, code } });

/** Reject malformed ids before they reach the database (runs ahead of validateProjectAccess). */
export function validateDownloadParams(req, res, next) {
  if (!mongoose.Types.ObjectId.isValid(req.params.projectId)) {
    return err(res, 400, 'Invalid project id', 'INVALID_PROJECT_ID');
  }
  const raw = req.query?.auditNumber;
  if (raw !== undefined) {
    const n = Number(raw);
    if (!/^\d+$/.test(String(raw)) || !Number.isInteger(n) || n < 1) {
      return err(res, 400, 'auditNumber must be a positive integer', 'INVALID_AUDIT_NUMBER');
    }
    req.auditNumber = n;
  }
  return next();
}

/**
 * GET /api/pdf/:projectId/download[?auditNumber=N]
 * Generates the Full Audit PDF on the server and returns the PDF bytes.
 * Auth + project ownership are enforced by the route middleware.
 */
export function createDownloadHandler({ generate = generateFullAuditPdf } = {}) {
  return async function downloadFullAuditPdf(req, res) {
    const { projectId } = req.params;
    const started = Date.now();
    try {
      const out = await generate(projectId, { auditNumber: req.auditNumber ?? null });
      // `filename` is generated from [a-z0-9-] only (see filename.js); never raw user input.
      res.status(200);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
      res.setHeader('Content-Length', String(out.pdf.length));
      res.setHeader('Cache-Control', 'private, no-store, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Report-Pages', String(out.pages));
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Report-Pages');
      LoggerUtil.info('Full audit PDF generated', { projectId, pages: out.pages, bytes: out.pdf.length, ms: Date.now() - started });
      return res.end(out.pdf);
    } catch (e) {
      if (e instanceof ReportError && e.statusCode < 500) return err(res, e.statusCode, e.message, e.code);
      if (e instanceof PdfRenderError) {
        LoggerUtil.error('Full audit PDF render failed', e, { projectId, code: e.code });
        return err(res, e.status, publicRenderMessage(e), e.code);
      }
      LoggerUtil.error('Full audit PDF download failed', e, { projectId });
      return err(res, 500, 'The PDF could not be generated.', 'PDF_GENERATION_FAILED');
    }
  };
}

function publicRenderMessage(e) {
  switch (e.code) {
    case 'RENDERER_BUSY': return 'The PDF service is busy. Please try again in a moment.';
    case 'RENDERER_UNAVAILABLE': return 'The PDF service is temporarily unavailable.';
    case 'RENDER_TIMEOUT': return 'Generating the PDF took too long. Please try again.';
    default: return 'The PDF could not be generated.';
  }
}
