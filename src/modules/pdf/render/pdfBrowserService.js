import puppeteer from 'puppeteer';
import { resolveChromePath } from './chromePath.js';
import { FONT_FACE_CHECKS } from './fonts.js';

/**
 * Bounded, in-process Chromium renderer for HTML -> PDF.
 *
 *  - ONE shared browser process, launched lazily and relaunched if it dies.
 *  - A fresh incognito context + page per export, always closed in `finally`.
 *  - At most `maxConcurrent` renders run at once; up to `maxQueue` more wait;
 *    anything beyond that is rejected with RENDERER_BUSY (HTTP 503).
 *  - Launch / content / pdf steps have timeouts (PDF_RENDER_TIMEOUT_MS overall).
 *  - Every network request is blocked except data: URLs, so a render can never
 *    reach internal hosts or leak data; fonts are inlined by the caller.
 */

export class PdfRenderError extends Error {
  constructor(message, code = 'PDF_RENDER_FAILED', status = 500) {
    super(message);
    this.name = 'PdfRenderError';
    this.code = code;
    this.status = status;
  }
}

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

function safeManagedPath() {
  try { return puppeteer.executablePath(); } catch { return null; }
}

export function createPdfBrowserService({
  launch = (opts) => puppeteer.launch(opts),
  env = process.env,
  resolvePath = () => resolveChromePath({ env, managedPath: safeManagedPath() }),
} = {}) {
  const maxConcurrent = num(env.PDF_MAX_CONCURRENCY, 2);
  const maxQueue = num(env.PDF_MAX_QUEUE, 4);
  const renderTimeout = num(env.PDF_RENDER_TIMEOUT_MS, 60_000);
  const launchTimeout = num(env.PDF_LAUNCH_TIMEOUT_MS, 30_000);
  const idleMs = num(env.PDF_BROWSER_IDLE_MS, 5 * 60_000);

  let browser = null;
  let launching = null;
  let idleTimer = null;
  let running = 0;
  const waiters = [];

  async function getBrowser() {
    if (browser && browser.isConnected()) return browser;
    if (launching) return launching;
    const executablePath = resolvePath();
    if (!executablePath) {
      throw new PdfRenderError(
        'No Chrome/Chromium executable was found. Set PDF_CHROME_PATH (or PUPPETEER_EXECUTABLE_PATH) or install the Puppeteer browser.',
        'RENDERER_UNAVAILABLE', 503
      );
    }
    const args = ['--disable-dev-shm-usage', '--font-render-hinting=none', '--disable-gpu'];
    // Required inside most containers that run as root; opt-in so a normal host keeps the sandbox.
    if (String(env.PDF_CHROME_NO_SANDBOX).toLowerCase() === 'true') args.push('--no-sandbox', '--disable-setuid-sandbox');
    launching = Promise.resolve()
      .then(() => launch({ headless: 'new', executablePath, args, timeout: launchTimeout }))
      .then((b) => {
        browser = b;
        b.on('disconnected', () => { if (browser === b) browser = null; });
        return b;
      })
      .catch((err) => {
        throw new PdfRenderError(`Could not start the PDF renderer: ${err.message}`, 'RENDERER_UNAVAILABLE', 503);
      })
      .finally(() => { launching = null; });
    return launching;
  }

  function touchIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (running === 0) closeBrowser().catch(() => {}); }, idleMs);
    idleTimer.unref?.();
  }

  async function closeBrowser() {
    clearTimeout(idleTimer);
    const b = browser;
    browser = null;
    if (b) await b.close().catch(() => {});
  }

  function acquire() {
    if (running < maxConcurrent) { running += 1; return Promise.resolve(); }
    if (waiters.length >= maxQueue) {
      return Promise.reject(new PdfRenderError('The PDF renderer is at capacity. Please try again shortly.', 'RENDERER_BUSY', 503));
    }
    return new Promise((resolve, reject) => {
      const w = { resolve, reject, timer: null };
      w.timer = setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i >= 0) waiters.splice(i, 1);
        reject(new PdfRenderError('Timed out waiting for a free PDF renderer slot.', 'RENDERER_BUSY', 503));
      }, renderTimeout);
      waiters.push(w);
    });
  }

  function release() {
    const next = waiters.shift();
    if (next) { clearTimeout(next.timer); next.resolve(); } else { running -= 1; }
  }

  async function withTimeout(promise, ms, what) {
    let t;
    try {
      return await Promise.race([
        promise,
        new Promise((_, rej) => { t = setTimeout(() => rej(new PdfRenderError(`PDF rendering timed out (${what}).`, 'RENDER_TIMEOUT', 504)), ms); }),
      ]);
    } finally { clearTimeout(t); }
  }

  /**
   * Render a self-contained HTML document to an A4 PDF buffer.
   * @param {string} html
   * @param {{ expectedPages?: number|null }} [opts]
   */
  async function renderPdf(html, { expectedPages = null } = {}) {
    await acquire();
    let context = null;
    let page = null;
    try {
      const b = await getBrowser();
      const work = (async () => {
        context = await b.createIncognitoBrowserContext();
        page = await context.newPage();
        await page.setRequestInterception(true);
        page.on('request', (req) => {
          if (req.url().startsWith('data:') || req.url() === 'about:blank') req.continue(); else req.abort();
        });
        await page.setContent(html, { waitUntil: 'load', timeout: renderTimeout });

        // Readiness: report marker present, fonts actually loaded, images decoded.
        const ready = await page.evaluate(async (checks, expected) => {
          await document.fonts.ready;
          await Promise.all(checks.map((f) => document.fonts.load(f)));
          const fontsOk = checks.every((f) => document.fonts.check(f));
          await Promise.all([...document.images].map((i) => (i.complete ? null : i.decode().catch(() => null))));
          const root = document.getElementById('root');
          const sheets = document.querySelectorAll('.sheet').length;
          return { fontsOk, marker: root?.dataset.reportReady === 'true', sheets, expectedOk: expected == null || sheets === expected };
        }, FONT_FACE_CHECKS, expectedPages);
        if (!ready.marker) throw new PdfRenderError('The report document did not render.', 'RENDER_INVALID', 500);
        if (!ready.fontsOk) throw new PdfRenderError('Report fonts failed to load.', 'RENDER_FONTS', 500);
        if (!ready.expectedOk) throw new PdfRenderError(`Rendered ${ready.sheets} page(s), expected ${expectedPages}.`, 'RENDER_INVALID', 500);

        const buf = await page.pdf({ preferCSSPageSize: true, printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
        return Buffer.from(buf);
      })();
      work.catch(() => {}); // a late failure after a timeout must not become an unhandled rejection
      const pdf = await withTimeout(work, renderTimeout, 'page render');
      if (!pdf || pdf.length < 1000 || pdf.subarray(0, 5).toString() !== '%PDF-') {
        throw new PdfRenderError('The renderer produced an invalid PDF.', 'RENDER_INVALID', 500);
      }
      return pdf;
    } catch (err) {
      if (err instanceof PdfRenderError) throw err;
      // A crashed/disconnected browser is dropped so the next export relaunches it.
      if (!browser || !browser.isConnected()) browser = null;
      throw new PdfRenderError(`PDF rendering failed: ${err.message}`, 'PDF_RENDER_FAILED', 500);
    } finally {
      await page?.close().catch(() => {});
      await context?.close().catch(() => {});
      release();
      touchIdle();
    }
  }

  // ── Page inspection (AI investigations) ─────────────────────────────────────────────────────────────────
  // Same shared Chromium and lifecycle as PDF export, but its OWN small gate so investigations can never starve exports (or vice versa).
  const inspectMax = num(env.RENDER_MAX_CONCURRENCY, 2);
  const inspectQueue = num(env.RENDER_MAX_QUEUE, 4);
  const inspectTimeout = num(env.RENDER_TIMEOUT_MS, 30_000);
  let inspecting = 0;
  const inspectWaiters = [];

  function acquireInspect(signal) {
    if (signal?.aborted) return Promise.reject(new PdfRenderError('Rendering was cancelled.', 'RENDER_CANCELLED', 499));
    if (inspecting < inspectMax) { inspecting += 1; return Promise.resolve(); }
    if (inspectWaiters.length >= inspectQueue) return Promise.reject(new PdfRenderError('The page renderer is at capacity.', 'RENDERER_BUSY', 503));
    return new Promise((resolve, reject) => {
      const w = { resolve: () => { clearTimeout(w.timer); signal?.removeEventListener?.('abort', w.onAbort); resolve(); }, timer: null, onAbort: null };
      const drop = (err) => { const i = inspectWaiters.indexOf(w); if (i >= 0) inspectWaiters.splice(i, 1); clearTimeout(w.timer); reject(err); };
      w.timer = setTimeout(() => drop(new PdfRenderError('Timed out waiting for a free page renderer.', 'RENDERER_BUSY', 503)), inspectTimeout);
      w.onAbort = () => drop(new PdfRenderError('Rendering was cancelled.', 'RENDER_CANCELLED', 499));
      signal?.addEventListener?.('abort', w.onAbort, { once: true });
      inspectWaiters.push(w);
    });
  }
  function releaseInspect() {
    const next = inspectWaiters.shift();
    if (next) next.resolve(); else inspecting -= 1;
  }

  /**
   * Loads a real page in an isolated incognito context under a request policy and returns its final DOM as HTML.
   *
   * @param {string} url
   * @param {{ policy: { check: Function, addBytes: Function, recordResponse: Function, assertClean: Function, close: Function },
   *           signal?: AbortSignal, timeoutMs?: number, settleMs?: number, maxHtmlBytes?: number, userAgent?: string }} opts
   *   `policy.check({url, method, resourceType, isNavigation}) -> {allow, reason?}` is awaited for EVERY request, including each redirect hop;
   *   a denied request is aborted before it is sent. See ai-investigation/render/navigationPolicy.js.
   */
  async function inspectPage(url, { policy, signal, timeoutMs = inspectTimeout, settleMs = 4000, maxHtmlBytes = 3 * 1024 * 1024, userAgent = 'Mozilla/5.0 (compatible; OditoInvestigator/1.0)' } = {}) {
    if (!policy) throw new PdfRenderError('A navigation policy is required.', 'RENDER_POLICY_REQUIRED', 500);
    await acquireInspect(signal);
    let context = null; let page = null; const t0 = Date.now();
    let onAbort = null;
    try {
      const b = await getBrowser();
      const timings = {};
      let mainBlocked = null; let mainStatus = null; let navError = null;
      const work = (async () => {
        context = await b.createIncognitoBrowserContext();
        page = await context.newPage();
        // Pop-ups / new tabs opened by the page are closed immediately (registered AFTER the main page exists, so it is never one of them).
        const mainTarget = page.target();
        // window.open is neutralised before any page script runs; if a new page still appears it is attached to a deny-everything interceptor
        // FIRST (request interception is per page, so it would otherwise load unrestricted) and then closed.
        await page.evaluateOnNewDocument(() => { try { window.open = () => null; } catch (e) { /* ignore */ } });
        context.on('targetcreated', async (t) => {
          try {
            if (t.type() !== 'page' || t === mainTarget) return;
            const popup = await t.page();
            if (!popup) return;
            await popup.setRequestInterception(true).catch(() => {});
            popup.on('request', (r) => { if (!r.isInterceptResolutionHandled()) r.abort('blockedbyclient').catch(() => {}); });
            await popup.close().catch(() => {});
          } catch { /* ignore */ }
        });
        await page.setUserAgent(userAgent);
        await page.setViewport({ width: 1280, height: 900 });
        await page.setBypassServiceWorker(true);
        page.on('dialog', (d) => d.dismiss().catch(() => {}));
        const cdp = await page.target().createCDPSession();
        await cdp.send('Network.enable');
        cdp.on('Network.loadingFinished', (e) => policy.addBytes(e.encodedDataLength));
        await page.setRequestInterception(true);
        page.on('request', async (req) => {
          if (req.isInterceptResolutionHandled()) return;
          let decision;
          try {
            decision = await policy.check({ url: req.url(), method: req.method(), resourceType: req.resourceType(), isNavigation: req.isNavigationRequest() });
          } catch { decision = { allow: false, reason: 'policy_error' }; }
          if (req.isInterceptResolutionHandled()) return;
          if (decision.allow) { req.continue().catch(() => {}); return; }
          if (req.isNavigationRequest() && req.frame() === page.mainFrame() && !mainBlocked) mainBlocked = decision.reason;
          req.abort('blockedbyclient').catch(() => {});
        });
        page.on('response', (res) => {
          try { policy.recordResponse({ url: res.url(), remoteAddress: res.remoteAddress()?.ip }); } catch { /* ignore */ }
        });

        const tNav = Date.now();
        let response = null;
        try {
          response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        } catch (e) { navError = e; }
        timings.navigationMs = Date.now() - tNav;
        if (!response) {
          if (mainBlocked) throw new PdfRenderError(`The page navigation was blocked by the security policy (${mainBlocked}).`, 'RENDER_NAVIGATION_BLOCKED', 422);
          throw new PdfRenderError(`The page could not be loaded in the browser (${String(navError?.message || 'no response').slice(0, 120)}).`, 'RENDER_NAVIGATION_FAILED', 502);
        }
        mainStatus = response.status();
        const tSettle = Date.now();
        await page.waitForNetworkIdle({ idleTime: 600, timeout: Math.min(settleMs, timeoutMs) }).catch(() => {});
        timings.settleMs = Date.now() - tSettle;
        const finalUrl = page.url();
        // The final URL itself must still be on the policy's side of the line (client-side redirects).
        const finalDecision = await policy.checkFinalUrl(finalUrl);
        if (!finalDecision.allow) throw new PdfRenderError(`The page ended on a location the security policy does not allow (${finalDecision.reason}).`, 'RENDER_NAVIGATION_BLOCKED', 422);
        policy.close();
        policy.assertClean();
        const html = await page.content();
        const bytes = Buffer.byteLength(html, 'utf8');
        return {
          html: bytes > maxHtmlBytes ? Buffer.from(html, 'utf8').subarray(0, maxHtmlBytes).toString('utf8') : html,
          htmlBytes: bytes, htmlTruncated: bytes > maxHtmlBytes, finalUrl, status: mainStatus,
          redirects: response.request().redirectChain().map((r) => ({ from: r.url(), status: r.response()?.status() ?? null })),
        };
      })();
      work.catch(() => {}); // a late failure after a timeout/cancel must not become an unhandled rejection
      const cancel = new Promise((_, reject) => {
        onAbort = () => reject(new PdfRenderError('Rendering was cancelled.', 'RENDER_CANCELLED', 499));
        if (signal?.aborted) onAbort(); else signal?.addEventListener?.('abort', onAbort, { once: true });
      });
      cancel.catch(() => {});
      const result = await Promise.race([
        work,
        cancel,
        new Promise((_, reject) => { const t = setTimeout(() => reject(new PdfRenderError('Rendering timed out.', 'RENDER_TIMEOUT', 504)), timeoutMs + settleMs + 2000); t.unref?.(); work.finally(() => clearTimeout(t)).catch(() => {}); }),
      ]);
      return { ...result, timings: { ...timings, totalMs: Date.now() - t0 } };
    } catch (err) {
      if (err instanceof PdfRenderError || err?.code === 'RENDER_POLICY_VIOLATION') throw err;
      if (!browser || !browser.isConnected()) browser = null;
      throw new PdfRenderError(`Page rendering failed: ${err.message}`, 'RENDER_FAILED', 500);
    } finally {
      try { policy.close(); } catch { /* ignore */ }
      if (onAbort) signal?.removeEventListener?.('abort', onAbort);
      await page?.close().catch(() => {});
      await context?.close().catch(() => {});
      releaseInspect();
      touchIdle();
    }
  }

  return {
    renderPdf,
    inspectPage,
    closeBrowser,
    _state: () => ({ running, queued: waiters.length, hasBrowser: !!browser }), // unchanged shape (existing tests pin it)
    _inspectState: () => ({ inspecting, queued: inspectWaiters.length, hasBrowser: !!browser }),
  };
}

let shared = null;
export function getPdfBrowserService() {
  if (!shared) shared = createPdfBrowserService();
  return shared;
}
