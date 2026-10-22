import { generateProjectPDF } from '../../services/puppeteerPdfService.js';
import fs from 'fs';
import path from 'path';

/**
 * Generate 30-page PDF for a project using Puppeteer
 * Opens the frontend report page directly with auth token
 */
export async function generatePDF(req, res) {
  const { projectId, type } = req.params;
  const userId = req.user.id;
  
  console.log(`[EXPORT] ════════════════════════════════════════════`);
  console.log(`[EXPORT] 🖨️  30-PAGE PDF EXPORT STARTED`);
  console.log(`[EXPORT]    type      : ${type}`);
  console.log(`[EXPORT]    projectId : ${projectId}`);
  console.log(`[EXPORT]    userId    : ${userId}`);
  console.log(`[EXPORT] ════════════════════════════════════════════`);

  try {
    // Generate PDF using Puppeteer service
    const result = await generateProjectPDF(projectId, userId, {
      reportType: type,
      userToken: req.headers.authorization?.replace('Bearer ', '')
    });

    console.log(`[EXPORT] ✅ PDF generated successfully`);
    console.log(`[EXPORT]    file     : ${result.filePath}`);
    console.log(`[EXPORT]    size     : ${(result.fileSize / 1024).toFixed(1)} KB`);
    console.log(`[EXPORT]    time     : ${(result.generationTimeMs / 1000).toFixed(1)}s`);

    // Send the PDF file
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${result.fileName}"`);
    res.sendFile(result.filePath, (err) => {
      if (err) {
        console.error(`[EXPORT] ❌ Error sending file: ${err.message}`);
        if (!res.headersSent) {
          res.status(500).json({
            success: false,
            message: 'Error sending PDF file',
            error: err.message
          });
        }
      }
    });

  } catch (error) {
    console.error(`[EXPORT] ❌ PDF generation failed: ${error.message}`);
    
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: 'Failed to generate PDF',
        error: error.message
      });
    }
  }
}
