/**
 * Readiness contract between the report page (`/project/:id/report?export=true`)
 * and the Puppeteer/email PDF capture.
 *
 * The page sets, in this order of meaning:
 *   window.__PDF_READY__  === true      the canonical report loaded AND every page rendered
 *   window.__PDF_ERROR__  === "<text>"  loading/rendering failed (capture must not proceed)
 * and each rendered page carries `data-report-page`.
 *
 * `waitForReportReady` waits for one of those signals (no sleeps), then verifies
 * the DOM really holds a complete report before the caller prints it.
 */

export class ReportReadinessError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ReportReadinessError';
    this.code = code; // READY_TIMEOUT | REPORT_ERROR | REPORT_INCOMPLETE
  }
}

/**
 * @param {import('puppeteer').Page} page
 * @param {{ timeoutMs?: number, minPages?: number }} [opts]
 * @returns {Promise<{ pages: number }>}
 */
export async function waitForReportReady(page, { timeoutMs = 60_000, minPages = 1 } = {}) {
  try {
    await page.waitForFunction(
      () => window.__PDF_READY__ === true || (typeof window.__PDF_ERROR__ === 'string' && window.__PDF_ERROR__.length > 0),
      { timeout: timeoutMs }
    );
  } catch (err) {
    throw new ReportReadinessError(`Report was not ready within ${timeoutMs}ms`, 'READY_TIMEOUT');
  }

  const state = await page.evaluate(async () => {
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    const text = document.body ? document.body.innerText : '';
    return {
      ready: window.__PDF_READY__ === true,
      error: typeof window.__PDF_ERROR__ === 'string' ? window.__PDF_ERROR__ : null,
      pages: document.querySelectorAll('[data-report-page]').length,
      loadingVisible: /Loading Report Data|Loading\.\.\./i.test(text),
      errorVisible: /Error Loading Report/i.test(text),
    };
  });

  if (state.error) throw new ReportReadinessError(`Report failed to load: ${state.error}`, 'REPORT_ERROR');
  if (!state.ready || state.errorVisible) throw new ReportReadinessError('Report did not reach a ready state', 'REPORT_ERROR');
  if (state.loadingVisible || state.pages < minPages) {
    throw new ReportReadinessError(`Report content is incomplete (${state.pages} page(s) rendered)`, 'REPORT_INCOMPLETE');
  }
  return { pages: state.pages };
}
