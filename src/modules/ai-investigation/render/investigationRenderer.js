/**
 * investigationRenderer — the `deps.renderPage` implementation: Odito's existing shared Chromium (pdfBrowserService) driven under a
 * per-render navigation policy. Called only when the evidence plan decides rendering is worth it (see renderDecision.js).
 *
 * Limits (all overridable by env): per-project concurrency (default 1), global concurrency / queue / timeout live in the browser service
 * (RENDER_MAX_CONCURRENCY, RENDER_MAX_QUEUE, RENDER_TIMEOUT_MS). Per render: request cap, transferred-byte cap, DOM size cap.
 */

import { getPdfBrowserService, PdfRenderError } from '../../pdf/render/pdfBrowserService.js';
import { inspectHtml } from '../evidence/pageInspector.js';
import { createNavigationPolicy } from './navigationPolicy.js';
import { createLimiter } from '../service/investigationOrchestrator.js';

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

export class InvestigationRenderError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'InvestigationRenderError'; this.code = code; this.details = details; }
}

export function createInvestigationRenderer({
  browser = null, getBrowser = () => browser || getPdfBrowserService(), guard, isBlockedAddress, env = process.env, now = () => Date.now(),
} = {}) {
  const perProjectMax = num(env.INVESTIGATION_RENDER_PER_PROJECT, 1);
  const limiters = new Map();
  const limiterFor = (projectId) => {
    const k = String(projectId || 'none');
    if (!limiters.has(k)) limiters.set(k, createLimiter(perProjectMax));
    return limiters.get(k);
  };

  /** @returns {Promise<object>} bounded facts of the rendered DOM + provenance; throws InvestigationRenderError with a stable code */
  return async function renderPage(url, { signal, siteUrl, projectId } = {}) {
    const limiter = limiterFor(projectId);
    const startedAt = now();
    try {
      await limiter.acquire(signal);
    } catch {
      throw new InvestigationRenderError('RENDER_CANCELLED', 'Rendering was cancelled while waiting for a slot.');
    }
    try {
      const policy = createNavigationPolicy({
        siteUrl, ...(guard ? { guard } : {}), ...(isBlockedAddress ? { isBlockedAddress } : {}),
        maxRequests: num(env.INVESTIGATION_RENDER_MAX_REQUESTS, 150), maxBytes: num(env.INVESTIGATION_RENDER_MAX_BYTES, 8 * 1024 * 1024),
      });
      let out;
      try {
        out = await getBrowser().inspectPage(url, {
          policy, signal, timeoutMs: num(env.INVESTIGATION_RENDER_TIMEOUT_MS, 25_000), settleMs: num(env.INVESTIGATION_RENDER_SETTLE_MS, 4000),
          maxHtmlBytes: num(env.INVESTIGATION_RENDER_MAX_HTML_BYTES, 3 * 1024 * 1024),
        });
      } catch (error) {
        const code = error instanceof PdfRenderError || error?.code ? error.code : 'RENDER_FAILED';
        throw new InvestigationRenderError(code, error.message, { requests: policy.summary(), durationMs: now() - startedAt });
      }
      return {
        facts: inspectHtml(out.html, out.finalUrl),
        finalUrl: out.finalUrl, httpStatus: out.status, redirects: out.redirects,
        timings: out.timings, htmlBytes: out.htmlBytes, htmlTruncated: out.htmlTruncated,
        requests: policy.summary(), engine: 'chromium (shared Odito browser service)',
      };
    } finally {
      limiter.release();
    }
  };
}

export default { createInvestigationRenderer, InvestigationRenderError };
