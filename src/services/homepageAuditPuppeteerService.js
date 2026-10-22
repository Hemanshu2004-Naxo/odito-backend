/**
 * Homepage Audit Puppeteer PDF Service
 *
 * Generates the Homepage Audit PDF by opening the dedicated
 * frontend render route in headless Chromium and calling page.pdf().
 *
 * Flow:
 *   1. Launch headless Chrome via Puppeteer
 *   2. Inject JWT token into localStorage BEFORE navigation (same as Full Audit)
 *   3. Navigate → FRONTEND_URL/homepage-audit-report/{auditId}
 *   4. Wait for #report-loaded (data + render complete)
 *   5. Wait for window.__PDF_READY__ === true (fonts + images ready)
 *   6. page.pdf() → A4, printBackground: true, 0mm margins
 *   7. Save to /reports/ → return metadata
 *
 * Mirrors puppeteerPdfService.js structure exactly so maintenance is uniform.
 */

import puppeteer from 'puppeteer';
import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { getEnvVar } from '../config/env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const FRONTEND_URL = getEnvVar('CORS_ORIGIN'); // e.g. http://localhost:3000
const REPORTS_DIR = path.join(__dirname, '..', '..', 'reports');

const NAVIGATION_TIMEOUT = 60_000;  // 60s for page load
const REPORT_LOAD_TIMEOUT = 60_000;  // 60s for #report-loaded
const PDF_READY_TIMEOUT = 30_000;  // 30s for window.__PDF_READY__
const STABILIZE_DELAY_MS = 1_500;   // brief pause before capture

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function ensureReportsDir() {
  if (!fs.existsSync(REPORTS_DIR)) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    console.log(`[HA_PDF] 📁 Created reports directory: ${REPORTS_DIR}`);
  }
  return REPORTS_DIR;
}

function md5(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Service
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a PDF for the given Homepage Audit via Puppeteer.
 *
 * @param {string} auditId  - HomepageAudit._id (MongoDB ObjectId string)
 * @param {string} [token]  - JWT to inject into localStorage so the render
 *                            page can call the authenticated data API.
 *                            If omitted, the data API is called unauthenticated
 *                            (acceptable while the route has no auth guard).
 * @returns {Promise<{
 *   filePath: string,
 *   fileName: string,
 *   fileSize: number,
 *   checksum: string,
 *   generationTimeMs: number
 * }>}
 */
export async function generateHomepageAuditPDF(auditId, token = null) {
  const startTime = Date.now();
  const reportsDir = ensureReportsDir();
  let browser = null;

  console.log(`[HA_PDF] ════════════════════════════════════════════`);
  console.log(`[HA_PDF] 🖨️  Homepage Audit PDF generation started`);
  console.log(`[HA_PDF]    auditId  : ${auditId}`);
  console.log(`[HA_PDF]    frontend : ${FRONTEND_URL}`);
  console.log(`[HA_PDF] ════════════════════════════════════════════`);

  try {
    // ── Step 1: Launch headless browser ─────────────────────────────────────
    console.log(`[HA_PDF] [1/5] Launching headless browser...`);

    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        '--font-render-hinting=none',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-extensions',
      ],
      defaultViewport: { width: 794, height: 1123 }, // A4 @ 96dpi
      timeout: 30_000,
    });

    const page = await browser.newPage();

    // Forward browser console errors to backend log for debugging
    page.on('console', (msg) => {
      const text = msg.text();
      if (msg.type() === 'error') {
        console.log(`[HA_PDF] [BROWSER_ERR] ${text}`);
      } else if (text.includes('[HA_REPORT]') || text.includes('__PDF_READY__')) {
        console.log(`[HA_PDF] [BROWSER_LOG] ${text}`);
      }
    });

    console.log(`[HA_PDF] [1/5] ✅ Browser launched`);

    // ── Step 2: Inject JWT token before navigation ───────────────────────────
    console.log(`[HA_PDF] [2/5] Injecting auth token before navigation...`);

    if (token) {
      await page.setRequestInterception(true);
      page.on('request', (request) => {
        request.continue({
          headers: {
            ...request.headers(),
            Authorization: `Bearer ${token}`,
          },
        });
      });

      await page.evaluateOnNewDocument((tkn) => {
        localStorage.setItem('token', tkn);
        localStorage.setItem('authToken', tkn);
      }, token);
    }

    console.log(`[HA_PDF] [2/5] ✅ Auth configured`);

    // ── Step 3: Navigate to the dedicated render route ───────────────────────
    const renderUrl = `${FRONTEND_URL}/homepage-audit-report/${auditId}`;
    console.log(`[HA_PDF] [3/5] Navigating to: ${renderUrl}`);

    await page.goto(renderUrl, {
      waitUntil: 'networkidle0',
      timeout: NAVIGATION_TIMEOUT,
    });

    console.log(`[HA_PDF] [3/5] ✅ Page navigation complete`);

    // ── Step 4: Wait for readiness signals ──────────────────────────────────
    console.log(`[HA_PDF] [4/5] Waiting for readiness signals...`);

    // 4a. #report-loaded — data fetched and all 8 pages rendered into DOM
    try {
      await page.waitForSelector('#report-loaded', { timeout: REPORT_LOAD_TIMEOUT });
      console.log(`[HA_PDF] ✅ #report-loaded detected`);
    } catch (err) {
      console.warn(`[HA_PDF] ⚠️  #report-loaded not found after ${REPORT_LOAD_TIMEOUT}ms — continuing`);
    }

    // 4b. window.__PDF_READY__ — fonts loaded, document.fonts.ready resolved
    try {
      await page.waitForFunction(() => window.__PDF_READY__ === true, {
        timeout: PDF_READY_TIMEOUT,
      });
      console.log(`[HA_PDF] ✅ window.__PDF_READY__ === true`);
    } catch (err) {
      console.warn(`[HA_PDF] ⚠️  __PDF_READY__ not set after ${PDF_READY_TIMEOUT}ms — continuing`);
    }

    // 4c. Brief stabilization delay (lets any final paint/layout flush)
    await new Promise((r) => setTimeout(r, STABILIZE_DELAY_MS));

    console.log(`[HA_PDF] [4/5] ✅ Readiness confirmed`);

    // ── Step 4.5: Pagination Height Diagnostics ──────────────────────────────
    console.log(`[HA_PDF] Running real-time height diagnostics...`);
    try {
      const logs = await page.evaluate(() => {
        const pageHeight = 1123;
        const results = [];
        const pageDivs = Array.from(document.querySelectorAll('.pdf-container > div'));

        pageDivs.forEach((pageDiv, pageIdx) => {
          const pageNum = pageIdx + 1;
          results.push(`\n=== Physical PDF Page ${pageNum} ===`);

          const componentRoot = pageDiv.firstElementChild;
          if (!componentRoot) {
            results.push('  Empty page container.');
            return;
          }

          const children = Array.from(componentRoot.children);
          let currentY = 56; // Starts at top margin (56px)

          children.forEach((child) => {
            const rect = child.getBoundingClientRect();
            const height = Math.round(rect.height);
            const style = window.getComputedStyle(child);
            const marginTop = parseInt(style.marginTop || '0', 10);
            const marginBottom = parseInt(style.marginBottom || '0', 10);
            const totalHeight = height + marginTop + marginBottom;

            const remainingSpace = pageHeight - currentY;
            const elementId = child.id || child.className || child.tagName;

            let textLabel = child.innerText ? child.innerText.split('\n')[0].substring(0, 40) : '';
            if (!textLabel && child.tagName) {
              textLabel = `<${child.tagName.toLowerCase()}>`;
            }

            const avoidBreak = style.breakInside === 'avoid' || style.pageBreakInside === 'avoid';
            let decision = 'Renders inline';

            if (avoidBreak) {
              if (totalHeight > remainingSpace) {
                decision = `🔴 Pushed to NEXT page (Height: ${totalHeight}px > Remaining: ${remainingSpace}px)`;
                currentY = 56 + totalHeight; // Reset position to top of next page
              } else {
                decision = `🟢 Fits on current page (Height: ${totalHeight}px <= Remaining: ${remainingSpace}px)`;
                currentY += totalHeight;
              }
            } else {
              currentY += totalHeight;
            }

            results.push(`  - Element: ${elementId} [${textLabel}]`);
            results.push(`    Height: ${totalHeight}px | Margin-Top: ${marginTop}px`);
            results.push(`    Remaining Page Space (before render): ${remainingSpace}px`);
            results.push(`    Decision: ${decision}`);
          });
        });
        return results.join('\n');
      });
      console.log(`[HA_PDF] Height Diagnostics Report:\n${logs}`);
    } catch (err) {
      console.warn(`[HA_PDF] Height diagnostics error:`, err.message);
    }

    // ── Step 5: Generate PDF ─────────────────────────────────────────────────
    console.log(`[HA_PDF] [5/5] Generating PDF via page.pdf()...`);
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      // 0mm margins — the React page components own their own padding/margins.
      // The Full Audit uses 10mm but Homepage Audit pages have built-in spacing.
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });

    // ── Save to filesystem ───────────────────────────────────────────────────
    const date = new Date().toISOString().split('T')[0];
    const fileName = `homepage-audit-${auditId}-${date}.pdf`;
    const filePath = path.join(reportsDir, fileName);

    fs.writeFileSync(filePath, pdfBuffer);

    const fileSize = fs.statSync(filePath).size;
    const checksum = md5(pdfBuffer);
    const generationTimeMs = Date.now() - startTime;

    console.log(`[HA_PDF] ════════════════════════════════════════════`);
    console.log(`[HA_PDF] ✅ PDF GENERATION COMPLETE`);
    console.log(`[HA_PDF]    file    : ${filePath}`);
    console.log(`[HA_PDF]    size    : ${(fileSize / 1024).toFixed(1)} KB`);
    console.log(`[HA_PDF]    md5     : ${checksum}`);
    console.log(`[HA_PDF]    time    : ${(generationTimeMs / 1000).toFixed(1)}s`);
    console.log(`[HA_PDF] ════════════════════════════════════════════`);

    return { filePath, fileName, fileSize, checksum, generationTimeMs };

  } catch (error) {
    const elapsed = Date.now() - startTime;
    console.error(`[HA_PDF] ════════════════════════════════════════════`);
    console.error(`[HA_PDF] ❌ PDF GENERATION FAILED`);
    console.error(`[HA_PDF]    auditId : ${auditId}`);
    console.error(`[HA_PDF]    error   : ${error.message}`);
    console.error(`[HA_PDF]    after   : ${(elapsed / 1000).toFixed(1)}s`);
    console.error(`[HA_PDF] ════════════════════════════════════════════`);

    // Debug screenshot on failure
    if (browser) {
      try {
        const pages = await browser.pages();
        if (pages.length > 0) {
          const screenshotPath = path.join(
            REPORTS_DIR,
            `debug-ha-${auditId}-${Date.now()}.png`
          );
          await pages[0].screenshot({ path: screenshotPath, fullPage: true });
          console.error(`[HA_PDF] 📸 Debug screenshot: ${screenshotPath}`);
        }
      } catch (_) { /* ignore screenshot errors */ }
    }

    throw error;

  } finally {
    if (browser) {
      try {
        await browser.close();
        console.log(`[HA_PDF] 🔒 Browser closed`);
      } catch (_) { /* ignore */ }
    }
  }
}

export default { generateHomepageAuditPDF };
