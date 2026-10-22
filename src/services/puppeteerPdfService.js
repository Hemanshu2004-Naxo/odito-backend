/**
 * Puppeteer PDF Service
 * 
 * Directly opens the frontend report page with proper authentication
 * to generate the same 30-page PDF that users get manually.
 * 
 * Flow:
 *   1. Launch headless Chrome via Puppeteer
 *   2. Inject JWT token into localStorage BEFORE navigation
 *   3. Navigate directly to: /project/{projectId}/report?export=true&type={type}
 *   4. Wait for window.__PDF_READY__ (report loaded and rendered)
 *   5. Generate PDF directly from the page
 *   6. Return the PDF file path
 */

import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import jwt from 'jsonwebtoken';
import { waitForReportReady } from './pdfReadiness.js';
import { resolveChromePath } from '../modules/pdf/render/chromePath.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
import { getEnvVar, getServiceUrls } from '../config/env.js';

// ─────────────────────────────────────────────────────────────────────────────

const FRONTEND_URL = getEnvVar('CORS_ORIGIN');
const REPORTS_DIR = path.join(__dirname, '..', '..', 'reports');

// Timeouts
const NAVIGATION_TIMEOUT = 60_000;      // 60s for page load
const DASHBOARD_LOAD_TIMEOUT = 45_000;  // 45s for dashboard content
const EXPORT_COMPLETION_TIMEOUT = 180_000; // 3 min for 30-page PDF generation
const POST_EXPORT_DELAY = 5_000;        // 5s safety delay after export
const READY_TIMEOUT = 60_000;           // max wait for the report-ready signal (it normally arrives in a few seconds)

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ensure reports directory exists
 */
function ensureReportsDir() {
  if (!fs.existsSync(REPORTS_DIR)) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    console.log(`[PUPPETEER_PDF] 📁 Created reports directory: ${REPORTS_DIR}`);
  }
  return REPORTS_DIR;
}

/**
 * Generate a short-lived JWT for the given user ID.
 * Uses the same JWT_SECRET and payload format as authService.generateToken().
 * 
 * @param {string} userId - MongoDB user _id
 * @returns {string} JWT token valid for 1 hour
 */
function generateServiceToken(userId) {
  return jwt.sign(
    { id: userId },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
}

/**
 * Find the most recently created PDF file in the reports directory.
 * 
 * @param {string} dir - Directory to search
 * @param {number} sinceMs - Only consider files modified after this timestamp
 * @returns {string|null} Absolute path to the newest PDF file, or null
 */
function findLatestPdf(dir, sinceMs) {
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.pdf'))
    .map(f => ({
      name: f,
      path: path.join(dir, f),
      mtime: fs.statSync(path.join(dir, f)).mtimeMs
    }))
    .filter(f => f.mtime >= sinceMs)
    .sort((a, b) => b.mtime - a.mtime);

  return files.length > 0 ? files[0].path : null;
}

/**
 * Wait for a new PDF file to appear in the download directory.
 * Polls every second until a new .pdf file is detected or timeout expires.
 * 
 * @param {string} dir - Directory to watch
 * @param {number} sinceMs - Timestamp before the download was triggered
 * @param {number} timeoutMs - Max time to wait
 * @returns {Promise<string>} Absolute path to the downloaded PDF
 */
async function waitForDownloadedPdf(dir, sinceMs, timeoutMs = 30_000) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const pdfPath = findLatestPdf(dir, sinceMs);
    
    if (pdfPath) {
      // Verify the file is not still being written (size is stable)
      const size1 = fs.statSync(pdfPath).size;
      await new Promise(r => setTimeout(r, 1000));
      const size2 = fs.statSync(pdfPath).size;

      if (size2 > 0 && size1 === size2) {
        return pdfPath;
      }
    }

    await new Promise(r => setTimeout(r, 1000));
  }

  throw new Error(`[PUPPETEER_PDF] Timed out waiting for PDF download in ${dir}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Service Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate the 30-page project PDF by automating the frontend Export button.
 * 
 * @param {string} projectId - MongoDB project _id
 * @param {string} userId - MongoDB user _id (owner of the project)
 * @param {Object} [options] - Optional configuration
 * @param {string} [options.userToken] - Pre-existing JWT. If omitted, a service token is generated.
 * @param {string} [options.reportType='seo'] - 'seo' or 'ai'
 * @returns {Promise<{ filePath: string, fileName: string, publicUrl: string }>}
 */
export async function generateProjectPDF(projectId, userId, options = {}) {
  const startTime = Date.now();
  const reportsDir = ensureReportsDir();
  const token = options.userToken || generateServiceToken(userId);
  const reportType = options.reportType || 'seo';
  
  let browser = null;

  console.log(`[PUPPETEER_PDF] ════════════════════════════════════════════`);
  console.log(`[PUPPETEER_PDF] 🖨️  Starting PDF generation`);
  console.log(`[PUPPETEER_PDF]    projectId : ${projectId}`);
  console.log(`[PUPPETEER_PDF]    userId    : ${userId}`);
  console.log(`[PUPPETEER_PDF]    reportType: ${reportType}`);
  console.log(`[PUPPETEER_PDF]    frontend  : ${FRONTEND_URL}`);
  console.log(`[PUPPETEER_PDF] ════════════════════════════════════════════`);

  try {
    // ─── Step 1: Launch headless browser ──────────────────────────────────
    console.log(`[PUPPETEER_PDF] [1/5] Launching headless browser...`);

    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: resolveChromePath({ managedPath: (() => { try { return puppeteer.executablePath(); } catch { return null; } })() }) || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        '--font-render-hinting=none',
        '--disable-features=IsolateOrigins,site-per-process',
      ],
      defaultViewport: { width: 1200, height: 800 },
      timeout: 30_000,
    });

    const page = await browser.newPage();
    
    // Suppress console noise but keep important logs
    page.on('console', msg => {
      const text = msg.text();
      if (msg.type() === 'error') {
        console.log(`[PUPPETEER_PDF] [BROWSER_ERROR] ${text}`);
      } else if (text.includes('[REPORT]')) {
        console.log(`[PUPPETEER_PDF] [BROWSER_LOG] ${text}`);
      }
    });

    console.log(`[PUPPETEER_PDF] [1/5] ✅ Browser launched`);

    // ─── Step 2: Inject JWT token BEFORE navigation ───────────────────────
    console.log(`[PUPPETEER_PDF] [2/5] Injecting JWT token before navigation...`);

    // Set up request interception to add auth header
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      // Add authorization header to all requests
      const headers = {
        ...request.headers(),
        'Authorization': `Bearer ${token}`
      };
      request.continue({ headers });
    });

    // Inject token into localStorage before any page loads
    await page.evaluateOnNewDocument((tkn) => {
      localStorage.setItem('token', tkn);
      localStorage.setItem('authToken', tkn);
      console.log('[INJECTION] JWT token injected into localStorage');
    }, token);

    console.log(`[PUPPETEER_PDF] [2/5] ✅ JWT token injected`);

    // ─── Step 3: Navigate directly to report page ─────────────────────────
    const reportUrl = `${FRONTEND_URL}/project/${projectId}/report?export=true&type=${reportType}`;
    console.log(`[PUPPETEER_PDF] [3/5] Navigating to report page: ${reportUrl}`);

    await page.goto(reportUrl, {
      waitUntil: 'networkidle0',
      timeout: NAVIGATION_TIMEOUT,
    });

    console.log(`[PUPPETEER_PDF] [3/5] ✅ Report page loaded`);

    // ─── Step 4: Wait for the report to be fully rendered ────────────────
    // One contract (see pdfReadiness.js): the report page sets window.__PDF_READY__
    // only after the canonical report loaded and every page rendered, or
    // window.__PDF_ERROR__ on failure. No fixed sleeps; an incomplete or failed
    // report aborts the export instead of being printed.
    console.log(`[PUPPETEER_PDF] [4/5] WAITING FOR REPORT READY`);
    const readiness = await waitForReportReady(page, { timeoutMs: READY_TIMEOUT, minPages: 1 });
    console.log(`[PUPPETEER_PDF] ✅ Report ready (${readiness.pages} pages)`);

    // ─── Step 5: Generate PDF directly ───────────────────────────────────
    console.log(`[PUPPETEER_PDF] [5/5] Generating PDF...`);

    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: {
        top: '10mm',
        right: '10mm',
        bottom: '10mm',
        left: '10mm'
      }
    });

    // Save PDF to file
    const timestamp = new Date().toISOString().split('T')[0];
    const fileName = `report-${projectId}-${timestamp}.pdf`;
    const filePath = path.join(reportsDir, fileName);

    fs.writeFileSync(filePath, pdfBuffer);

    const fileSize = fs.statSync(filePath).size;
    const elapsedMs = Date.now() - startTime;
    const serviceUrls = getServiceUrls();
    const publicUrl = `${serviceUrls.backend}/reports/${fileName}`;

    console.log(`[PUPPETEER_PDF] ════════════════════════════════════════════`);
    console.log(`[PUPPETEER_PDF] ✅ PDF GENERATION COMPLETE`);
    console.log(`[PUPPETEER_PDF]    file     : ${filePath}`);
    console.log(`[PUPPETEER_PDF]    size     : ${(fileSize / 1024).toFixed(1)} KB`);
    console.log(`[PUPPETEER_PDF]    time     : ${(elapsedMs / 1000).toFixed(1)}s`);
    console.log(`[PUPPETEER_PDF]    publicUrl: ${publicUrl}`);
    console.log(`[PUPPETEER_PDF] ════════════════════════════════════════════`);

    return {
      filePath,
      fileName,
      publicUrl,
      fileSize,
      generationTimeMs: elapsedMs,
    };

  } catch (error) {
    const elapsedMs = Date.now() - startTime;
    console.error(`[PUPPETEER_PDF] ════════════════════════════════════════════`);
    console.error(`[PUPPETEER_PDF] ❌ PDF GENERATION FAILED`);
    console.error(`[PUPPETEER_PDF]    projectId: ${projectId}`);
    console.error(`[PUPPETEER_PDF]    error    : ${error.message}`);
    console.error(`[PUPPETEER_PDF]    after    : ${(elapsedMs / 1000).toFixed(1)}s`);
    console.error(`[PUPPETEER_PDF] ════════════════════════════════════════════`);

    // Capture screenshot for debugging if page is still alive
    if (browser) {
      try {
        const pages = await browser.pages();
        if (pages.length > 0) {
          const debugScreenshot = path.join(reportsDir, `debug-${projectId}-${Date.now()}.png`);
          await pages[0].screenshot({ path: debugScreenshot, fullPage: true });
          console.error(`[PUPPETEER_PDF] 📸 Debug screenshot saved: ${debugScreenshot}`);
        }
      } catch (screenshotErr) {
        // Ignore screenshot errors
      }
    }

    throw error;

  } finally {
    // Always close the browser
    if (browser) {
      try {
        await browser.close();
        console.log(`[PUPPETEER_PDF] 🔒 Browser closed`);
      } catch (closeErr) {
        console.error(`[PUPPETEER_PDF] ⚠️  Browser close error: ${closeErr.message}`);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────────────────────────────────────

export default { generateProjectPDF };
