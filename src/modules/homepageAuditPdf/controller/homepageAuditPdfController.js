import HomepageAuditPdfService, { HomepageAuditPdfError } from '../service/homepageAuditPdfService.js';

const service = new HomepageAuditPdfService();

/**
 * GET /homepage-audit-pdf/:auditId/data
 *
 * Returns the normalized PDF data contract as JSON. This endpoint exists
 * only for development, debugging, validation, and future renderer
 * consumption — it does not generate a PDF file.
 */
export async function getHomepageAuditPdfDataController(req, res) {
  try {
    const { auditId } = req.params;
    const data = await service.getPdfData(auditId);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    if (err instanceof HomepageAuditPdfError) {
      return res.status(err.statusCode).json({
        success: false,
        error: err.code,
        message: err.message,
      });
    }

    console.error('[HOMEPAGE_AUDIT_PDF] Unexpected error:', err);
    return res.status(500).json({
      success: false,
      error: 'internal_error',
      message: 'Internal server error',
    });
  }
}

/**
 * POST /homepage-audit-pdf/:auditId/generate
 *
 * Checks if the PDF is already generated on the backend.
 * If yes, returns it immediately from the filesystem cache.
 * If not, spins up headless Chrome via Puppeteer to generate,
 * saves it, and sends the PDF back.
 */
export async function generateHomepageAuditPdfController(req, res) {
  try {
    const { auditId } = req.params;
    const token = req.headers.authorization?.replace('Bearer ', '') || null;
    const result = await service.generatePdf(auditId, token);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${result.fileName}"`);
    return res.sendFile(result.filePath, (err) => {
      if (err) {
        console.error(`[HOMEPAGE_AUDIT_PDF] Error sending PDF file: ${err.message}`);
        if (!res.headersSent) {
          res.status(500).json({
            success: false,
            message: 'Error sending PDF file',
            error: err.message,
          });
        }
      }
    });
  } catch (err) {
    if (err instanceof HomepageAuditPdfError) {
      return res.status(err.statusCode).json({
        success: false,
        error: err.code,
        message: err.message,
      });
    }

    console.error('[HOMEPAGE_AUDIT_PDF] Unexpected generation error:', err);
    return res.status(500).json({
      success: false,
      error: 'internal_error',
      message: 'Internal server error',
    });
  }
}
