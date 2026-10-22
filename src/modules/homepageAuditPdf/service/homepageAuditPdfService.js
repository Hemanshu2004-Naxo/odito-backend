import fs from 'fs';
import HomepageAuditRepository from '../repository/homepageAuditRepository.js';
import { mapHomepageAuditToPdfData } from './homepageAuditPdfMapper.js';
import { generateHomepageAuditPDF } from '../../../services/homepageAuditPuppeteerService.js';

/**
 * Typed error for the Homepage Audit PDF data layer. Carries an HTTP status
 * code and a stable machine-readable `code` so the controller can translate
 * it into the standard `{ success: false, error, message }` envelope without
 * string-matching error messages.
 */
class HomepageAuditPdfError extends Error {
  constructor(code, message, statusCode) {
    super(message);
    this.name = 'HomepageAuditPdfError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Data service only: load HomepageAudit -> validate -> map -> return.
 * No Puppeteer, no rendering, no storage, no job creation — those belong to
 * later phases. Readiness gaps (performance/accessibility not yet completed,
 * no Google Business Profile) are NOT errors here; they're valid, expected
 * states the mapper already represents via `readiness` flags in a normal
 * successful response. Only a missing/invalid audit or a structurally broken
 * snapshot is an error condition.
 */
class HomepageAuditPdfService {
  constructor() {
    this.repository = new HomepageAuditRepository();
  }

  /**
   * @param {string} auditId
   * @returns {Promise<object>} The PDF data contract (see homepageAuditPdfMapper.js).
   * @throws {HomepageAuditPdfError} invalid_id | not_found | malformed_snapshot | mapping_failed
   */
  async getPdfData(auditId) {
    if (!this.repository.isValidObjectId(auditId)) {
      throw new HomepageAuditPdfError('invalid_id', 'auditId is not a valid identifier', 400);
    }

    const auditDoc = await this.repository.getById(auditId);
    if (!auditDoc) {
      throw new HomepageAuditPdfError('not_found', 'Homepage audit not found', 404);
    }

    if (!auditDoc.snapshot || typeof auditDoc.snapshot !== 'object') {
      throw new HomepageAuditPdfError(
        'malformed_snapshot',
        'Homepage audit snapshot is missing or malformed',
        422
      );
    }

    try {
      return mapHomepageAuditToPdfData(auditDoc);
    } catch (err) {
      throw new HomepageAuditPdfError('mapping_failed', err.message, 422);
    }
  }

  /**
   * Check if a generated PDF file exists on disk. If so, return it.
   * Otherwise, trigger backend PDF generation using Puppeteer.
   *
   * @param {string} auditId
   * @param {string} [token]
   * @returns {Promise<object>} PDF metadata (filePath, fileName, status, etc.)
   */
  async generatePdf(auditId, token = null) {
    if (!this.repository.isValidObjectId(auditId)) {
      throw new HomepageAuditPdfError('invalid_id', 'auditId is not a valid identifier', 400);
    }

    const auditDoc = await this.repository.getById(auditId);
    if (!auditDoc) {
      throw new HomepageAuditPdfError('not_found', 'Homepage audit not found', 404);
    }

    // Cache check: if status is ready and file exists, return instantly.
    if (
      auditDoc.pdf &&
      auditDoc.pdf.status === 'ready' &&
      auditDoc.pdf.filePath &&
      fs.existsSync(auditDoc.pdf.filePath)
    ) {
      console.log(`[HA_PDF] 🚀 Serving cached PDF for audit: ${auditId}`);
      return auditDoc.pdf;
    }

    // Set generating status
    await this.repository.updatePdf(auditId, {
      status: 'generating',
      generatedAt: new Date(),
    });

    try {
      const result = await generateHomepageAuditPDF(auditId, token);

      const pdfData = {
        status: 'ready',
        filePath: result.filePath,
        fileName: result.fileName,
        generatedAt: new Date(),
        fileSizeBytes: result.fileSize,
        checksum: result.checksum,
      };

      await this.repository.updatePdf(auditId, pdfData);
      return pdfData;
    } catch (err) {
      await this.repository.updatePdf(auditId, {
        status: 'failed',
        generatedAt: new Date(),
      });
      throw new HomepageAuditPdfError(
        'generation_failed',
        `Failed to generate PDF via Puppeteer: ${err.message}`,
        500
      );
    }
  }
}

export default HomepageAuditPdfService;
export { HomepageAuditPdfError };
