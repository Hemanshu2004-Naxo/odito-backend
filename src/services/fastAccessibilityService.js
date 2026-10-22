/**
 * Fast Accessibility Audit Service
 * 
 * Lightweight Puppeteer + axe-core accessibility scanner.
 * Designed for speed (≤ 20s total execution).
 * 
 * Strategy:
 *   1. Launch headless Chrome with minimal config
 *   2. Block heavy resources (images, media, fonts)
 *   3. Navigate with domcontentloaded (fast)
 *   4. Inject axe-core source and run wcag2a-only scan
 *   5. Run all DOM checks in a single evaluate() call
 *   6. Calculate score and return structured result
 */

import puppeteer from 'puppeteer';
import axe from 'axe-core';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const TOTAL_TIMEOUT_MS = 20_000;        // 20s hard cap for entire audit
const PAGE_LOAD_TIMEOUT_MS = 15_000;    // 15s for page navigation
const AXE_TIMEOUT_MS = 10_000;          // 10s fail-safe for axe scan

const BLOCKED_RESOURCE_TYPES = ['image', 'media', 'font'];

// Chrome launch args (matches puppeteerPdfService.js pattern)
const CHROME_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-default-apps',
  '--disable-sync',
  '--no-first-run',
];

// ─────────────────────────────────────────────────────────────────────────────
// Score calculation config (strict and realistic scoring)
// ─────────────────────────────────────────────────────────────────────────────

const SCORE_PENALTIES = {
  axeViolation:   { perItem: 5, cap: 40 },    // HIGH impact - 5 points per issue
  missingLabel:   { perItem: 3, cap: 30 },    // VERY HIGH impact - 3 points per missing label
  missingLandmark:{ perItem: 4, cap: 20 },    // MEDIUM impact - 4 points per missing landmark
  focusIssue:     { perItem: 2, cap: 15 },    // MEDIUM impact - 2 points per focus issue
  clickableDiv:   { perItem: 2, cap: 12 },    // LOW-MEDIUM impact - 2 points per bad click
  autoplayMedia:  { perItem: 3, cap: 9 },     // LOW impact - 3 points per autoplay element
  h1Issue:        { flat: 8 },                // MEDIUM impact - 8 points if h1 issues
};

// ─────────────────────────────────────────────────────────────────────────────
// Service Class
// ─────────────────────────────────────────────────────────────────────────────

class FastAccessibilityService {

  /**
   * Run a fast accessibility audit on the given URL.
   * @param {string} url - Fully qualified URL to audit
   * @returns {Promise<object>} Structured audit result
   */
  async runAudit(url) {
    const startTime = Date.now();
    let browser = null;

    console.log(`[FAST_A11Y] ════════════════════════════════════════════`);
    console.log(`[FAST_A11Y] 🔍 Starting fast accessibility audit`);
    console.log(`[FAST_A11Y]    url: ${url}`);
    console.log(`[FAST_A11Y] ════════════════════════════════════════════`);

    try {
      // ─── Step 1: Launch browser ──────────────────────────────────────
      browser = await puppeteer.launch({
        headless: 'new',
        executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        args: CHROME_ARGS,
        defaultViewport: { width: 1280, height: 720 },
        timeout: 10_000,
      });

      const page = await browser.newPage();

      // ─── Step 2: Block heavy resources (BEFORE navigation) ───────────
      await page.setRequestInterception(true);

      page.on('request', (req) => {
        const type = req.resourceType();
        if (BLOCKED_RESOURCE_TYPES.includes(type)) {
          req.abort();
        } else {
          req.continue();
        }
      });

      // ─── Step 3: Navigate (fast — domcontentloaded only) ─────────────
      console.log(`[FAST_A11Y] Navigating to ${url}...`);

      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: PAGE_LOAD_TIMEOUT_MS,
      });

      console.log(`[FAST_A11Y] ✅ Page loaded (${Date.now() - startTime}ms)`);

      // ─── Step 4: Inject axe-core and run limited scan ────────────────
      let axeViolations = [];

      try {
        // Inject axe-core source directly
        await page.addScriptTag({ content: axe.source });

        // Run with fail-safe timeout
        const axeResults = await Promise.race([
          page.evaluate(() => {
            return window.axe.run({
              runOnly: {
                type: 'tag',
                values: ['wcag2a'],
              },
            });
          }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Axe timeout')), AXE_TIMEOUT_MS)
          ),
        ]);

        axeViolations = axeResults.violations || [];
        console.log(`[FAST_A11Y] ✅ axe-core scan complete: ${axeViolations.length} violations (${Date.now() - startTime}ms)`);

      } catch (axeError) {
        console.warn(`[FAST_A11Y] ⚠️ axe-core scan failed/timed out: ${axeError.message}`);
        // Continue — DOM checks will still run
      }

      // ─── Step 5: Run ALL DOM checks in ONE evaluate() call ───────────
      const domResults = await page.evaluate(() => {
        // Landmark presence
        const landmarks = {
          main: !!document.querySelector('main'),
          nav: !!document.querySelector('nav'),
          header: !!document.querySelector('header'),
          footer: !!document.querySelector('footer'),
        };

        // Clickable non-semantic elements
        const badClicks = document.querySelectorAll('div[onclick], span[onclick]').length;

        // Heading check
        const h1Count = document.querySelectorAll('h1').length;

        // Focus outline check (only a, button, input — optimized)
        const focusIssues = [...document.querySelectorAll('a, button, input')]
          .filter(el => getComputedStyle(el).outline === 'none').length;

        // Missing labels (correct logic — check labels, aria-label, label[for])
        const inputs = document.querySelectorAll('input, textarea, select');
        const missingLabels = [...inputs].filter(input => {
          const hasLabel =
            input.labels?.length > 0 ||
            input.getAttribute('aria-label') ||
            document.querySelector(`label[for="${input.id}"]`);
          return !hasLabel;
        }).length;

        // Autoplay media
        const autoplayMedia = document.querySelectorAll('video[autoplay], audio[autoplay]').length;

        return {
          landmarks,
          badClicks,
          h1Count,
          focusIssues,
          missingLabels,
          autoplayMedia,
        };
      });

      console.log(`[FAST_A11Y] ✅ DOM checks complete (${Date.now() - startTime}ms)`);

      // ─── Step 6: Calculate score and build response ──────────────────
      const score = this._calculateScore(axeViolations, domResults);

      // Limit axe details to top 5 (prevent large payloads)
      const axeDetails = axeViolations.slice(0, 5).map(v => ({
        id: v.id,
        impact: v.impact,
        description: v.description,
        nodes_count: v.nodes?.length || 0,
      }));

      const executionTimeMs = Date.now() - startTime;

      console.log(`[FAST_A11Y] ════════════════════════════════════════════`);
      console.log(`[FAST_A11Y] ✅ Audit complete`);
      console.log(`[FAST_A11Y]    score: ${score}`);
      console.log(`[FAST_A11Y]    time:  ${executionTimeMs}ms`);
      console.log(`[FAST_A11Y] ════════════════════════════════════════════`);

      return {
        success: true,
        data: {
          url,
          accessibility_score: score,
          execution_time_ms: executionTimeMs,
          issues: {
            axe_violations: axeViolations.length,
            clickable_divs: domResults.badClicks,
            missing_labels: domResults.missingLabels,
            focus_issues: domResults.focusIssues,
            autoplay_media: domResults.autoplayMedia,
            h1_count: domResults.h1Count,
          },
          landmarks: domResults.landmarks,
          axe_details: axeDetails,
        },
      };

    } catch (error) {
      const executionTimeMs = Date.now() - startTime;

      console.error(`[FAST_A11Y] ════════════════════════════════════════════`);
      console.error(`[FAST_A11Y] ❌ Audit failed`);
      console.error(`[FAST_A11Y]    url:   ${url}`);
      console.error(`[FAST_A11Y]    error: ${error.message}`);
      console.error(`[FAST_A11Y]    after: ${executionTimeMs}ms`);
      console.error(`[FAST_A11Y] ════════════════════════════════════════════`);

      return {
        success: false,
        error: this._classifyError(error),
        message: this._getUserMessage(error),
      };

    } finally {
      // ALWAYS close browser — prevents memory leaks and hanging Chrome processes
      if (browser) {
        try {
          await browser.close();
          console.log(`[FAST_A11Y] 🔒 Browser closed`);
        } catch (closeErr) {
          console.error(`[FAST_A11Y] ⚠️ Browser close error: ${closeErr.message}`);
        }
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private Helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Calculate accessibility score (0–100) with strict weighted penalties.
   * Starts at 100, deducts per issue type with caps to reflect real accessibility quality.
   */
  _calculateScore(axeViolations, domResults) {
    let score = 100;

    // axe violations - HIGH impact (5 points each, max 40)
    const axePenalty = Math.min(
      axeViolations.length * SCORE_PENALTIES.axeViolation.perItem,
      SCORE_PENALTIES.axeViolation.cap
    );
    score -= axePenalty;

    // Missing labels - VERY HIGH impact (3 points each, max 30)
    const labelPenalty = Math.min(
      domResults.missingLabels * SCORE_PENALTIES.missingLabel.perItem,
      SCORE_PENALTIES.missingLabel.cap
    );
    score -= labelPenalty;

    // Missing landmarks - MEDIUM impact (4 points each, max 20)
    const missingLandmarks = Object.values(domResults.landmarks).filter(v => !v).length;
    const landmarkPenalty = Math.min(
      missingLandmarks * SCORE_PENALTIES.missingLandmark.perItem,
      SCORE_PENALTIES.missingLandmark.cap
    );
    score -= landmarkPenalty;

    // h1 issues - MEDIUM impact (8 points flat penalty)
    if (domResults.h1Count !== 1) {
      score -= SCORE_PENALTIES.h1Issue.flat;
    }

    // Focus issues - MEDIUM impact (2 points each, max 15)
    const focusPenalty = Math.min(
      domResults.focusIssues * SCORE_PENALTIES.focusIssue.perItem,
      SCORE_PENALTIES.focusIssue.cap
    );
    score -= focusPenalty;

    // Clickable non-semantic elements - LOW-MEDIUM impact (2 points each, max 12)
    const clickPenalty = Math.min(
      domResults.badClicks * SCORE_PENALTIES.clickableDiv.perItem,
      SCORE_PENALTIES.clickableDiv.cap
    );
    score -= clickPenalty;

    // Autoplay media - LOW impact (3 points each, max 9)
    const autoplayPenalty = Math.min(
      domResults.autoplayMedia * SCORE_PENALTIES.autoplayMedia.perItem,
      SCORE_PENALTIES.autoplayMedia.cap
    );
    score -= autoplayPenalty;

    return Math.max(0, Math.round(score));
  }

  /**
   * Classify error type for API response.
   */
  _classifyError(error) {
    if (error.message?.includes('net::ERR_NAME_NOT_RESOLVED')) return 'invalid_domain';
    if (error.message?.includes('net::ERR_CONNECTION_REFUSED')) return 'connection_refused';
    if (error.message?.includes('net::ERR_CONNECTION_TIMED_OUT')) return 'timeout';
    if (error.message?.includes('Navigation timeout')) return 'timeout';
    if (error.message?.includes('Timed out')) return 'timeout';
    return 'audit_failed';
  }

  /**
   * Get user-friendly error message.
   */
  _getUserMessage(error) {
    const errorType = this._classifyError(error);

    const messages = {
      invalid_domain: 'The domain could not be resolved. Please check the URL.',
      connection_refused: 'Could not connect to the website. It may be down.',
      timeout: 'The website took too long to respond. Please try again.',
      audit_failed: 'Accessibility audit failed. Please try again later.',
    };

    return messages[errorType] || messages.audit_failed;
  }
}

export default FastAccessibilityService;
