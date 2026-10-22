import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { buildPdfFilename, slugify } from './filename.js';
import { resolveChromePath, candidateSystemPaths } from './chromePath.js';
import { createPdfBrowserService, PdfRenderError } from './pdfBrowserService.js';
import { createDownloadHandler, validateDownloadParams } from './downloadController.js';
import { ReportError } from '../report/canonicalReportService.js';
import { countPdfPages, generateFullAuditPdf } from './fullAuditPdfService.js';
import pdfRoutes from '../routes/pdfRoutes.js';

// ── helpers ──────────────────────────────────────────────────────────────────

const mockRes = () => {
  const res = { statusCode: 200, headers: {}, body: undefined, ended: false };
  res.status = (c) => { res.statusCode = c; return res; };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.json = (b) => { res.body = b; return res; };
  res.end = (b) => { res.ended = true; res.body = b; return res; };
  return res;
};

function fakeBrowserFactory({ pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(2000, 1)]), pdfDelay = 0, failPdf = false } = {}) {
  const log = { launches: 0, pagesOpened: 0, pagesClosed: 0, contextsOpened: 0, contextsClosed: 0, maxParallel: 0, parallel: 0 };
  const makeBrowser = () => {
    let connected = true;
    const handlers = {};
    return {
      isConnected: () => connected,
      on: (e, fn) => { handlers[e] = fn; },
      close: async () => { connected = false; },
      _crash: () => { connected = false; handlers.disconnected?.(); },
      createIncognitoBrowserContext: async () => {
        log.contextsOpened += 1;
        return {
          close: async () => { log.contextsClosed += 1; },
          newPage: async () => {
            log.pagesOpened += 1;
            return {
              setRequestInterception: async () => {},
              on: () => {},
              setContent: async () => {},
              evaluate: async () => ({ fontsOk: true, marker: true, sheets: 3, expectedOk: true }),
              pdf: async () => {
                log.parallel += 1; log.maxParallel = Math.max(log.maxParallel, log.parallel);
                try {
                  if (pdfDelay) await new Promise((r) => setTimeout(r, pdfDelay));
                  if (failPdf) throw new Error('chrome exploded');
                  return pdf;
                } finally { log.parallel -= 1; }
              },
              close: async () => { log.pagesClosed += 1; },
            };
          },
        };
      },
    };
  };
  const browsers = [];
  return { log, browsers, launch: async () => { log.launches += 1; const b = makeBrowser(); browsers.push(b); return b; } };
}

const svc = (factory, env = {}) => createPdfBrowserService({ launch: factory.launch, env: { PDF_BROWSER_IDLE_MS: '60000', ...env }, resolvePath: () => '/fake/chrome' });

// ── filenames ────────────────────────────────────────────────────────────────

describe('filenames', () => {
  test('deterministic, only [a-z0-9-], includes domain, audit number and date', () => {
    const f = buildPdfFilename({ projectName: 'Acme Inc.', domain: 'acme.example.com', auditNumber: 3, date: '2026-05-02T10:00:00Z' });
    assert.equal(f, 'odito-full-audit-acme-example-com-audit3-2026-05-02.pdf');
  });
  test('header-injection and path characters never survive', () => {
    const f = buildPdfFilename({ projectName: 'x"\r\nSet-Cookie: a=b; ../../etc/passwd', domain: null, auditNumber: null, date: '2026-01-01' });
    assert.match(f, /^odito-full-audit-[a-z0-9-]+-2026-01-01\.pdf$/);
    assert.doesNotMatch(f, /[\r\n";/\\]/);
  });
  test('empty / non-latin names fall back safely', () => {
    assert.equal(slugify('日本語'), 'project');
    assert.equal(slugify(null), 'project');
    assert.ok(slugify('a'.repeat(200)).length <= 40);
  });
});

// ── chrome path resolution ───────────────────────────────────────────────────

describe('chrome path resolution', () => {
  const only = (...paths) => (p) => paths.includes(p);
  test('explicit env wins; explicit-but-missing fails instead of silently falling back', () => {
    assert.equal(resolveChromePath({ env: { PDF_CHROME_PATH: '/opt/chrome' }, exists: only('/opt/chrome', '/usr/bin/chromium'), platform: 'linux' }), '/opt/chrome');
    assert.equal(resolveChromePath({ env: { PDF_CHROME_PATH: '/nope' }, exists: only('/usr/bin/chromium'), platform: 'linux' }), null);
  });
  test('managed browser, then standard system locations, then null', () => {
    assert.equal(resolveChromePath({ env: {}, managedPath: '/m/chrome', exists: only('/m/chrome'), platform: 'linux' }), '/m/chrome');
    assert.equal(resolveChromePath({ env: {}, exists: only('/usr/bin/chromium'), platform: 'linux' }), '/usr/bin/chromium');
    assert.equal(resolveChromePath({ env: {}, exists: () => false, platform: 'linux' }), null);
  });
  test('no machine-specific path is hardcoded', () => {
    const src = fs.readFileSync(new URL('./chromePath.js', import.meta.url), 'utf8') + fs.readFileSync(new URL('./pdfBrowserService.js', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /C:\\\\Program Files|C:\/Program Files|Users\\\\|HP\\\\/);
    assert.ok(candidateSystemPaths('win32', { PROGRAMFILES: 'X:\\PF' }).some((p) => p.includes('X:\\PF')));
  });
});

// ── browser lifecycle ────────────────────────────────────────────────────────

describe('browser service', () => {
  test('returns a valid PDF and closes the page and context', async () => {
    const f = fakeBrowserFactory();
    const s = svc(f);
    const pdf = await s.renderPdf('<html></html>', { expectedPages: 3 });
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    assert.deepEqual([f.log.pagesOpened, f.log.pagesClosed, f.log.contextsOpened, f.log.contextsClosed], [1, 1, 1, 1]);
    assert.deepEqual(s._state(), { running: 0, queued: 0, hasBrowser: true });
    await s.closeBrowser();
  });

  test('one shared browser is reused across exports', async () => {
    const f = fakeBrowserFactory();
    const s = svc(f);
    await s.renderPdf('a'); await s.renderPdf('b');
    assert.equal(f.log.launches, 1);
    await s.closeBrowser();
  });

  test('a renderer error is a controlled PdfRenderError and everything is still cleaned up', async () => {
    const f = fakeBrowserFactory({ failPdf: true });
    const s = svc(f);
    await assert.rejects(() => s.renderPdf('x'), (e) => e instanceof PdfRenderError && e.code === 'PDF_RENDER_FAILED');
    assert.deepEqual([f.log.pagesClosed, f.log.contextsClosed], [1, 1]);
    assert.equal(s._state().running, 0);
    await s.closeBrowser();
  });

  test('an invalid (non-PDF / tiny) result is rejected', async () => {
    const f = fakeBrowserFactory({ pdf: Buffer.from('<html>error page</html>') });
    await assert.rejects(() => svc(f).renderPdf('x'), (e) => e.code === 'RENDER_INVALID');
  });

  test('a slow render times out with 504 and releases its slot', async () => {
    const f = fakeBrowserFactory({ pdfDelay: 400 });
    const s = svc(f, { PDF_RENDER_TIMEOUT_MS: '80' });
    await assert.rejects(() => s.renderPdf('x'), (e) => e.code === 'RENDER_TIMEOUT' && e.status === 504);
    assert.equal(s._state().running, 0);
    assert.equal(f.log.pagesClosed, 1);
    await s.closeBrowser();
  });

  test('concurrency is bounded; overflow beyond the queue is rejected with 503 and never runs', async () => {
    const f = fakeBrowserFactory({ pdfDelay: 120 });
    const s = svc(f, { PDF_MAX_CONCURRENCY: '1', PDF_MAX_QUEUE: '1' });
    const results = await Promise.allSettled([s.renderPdf('1'), s.renderPdf('2'), s.renderPdf('3')]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 2);
    const rejected = results.find((r) => r.status === 'rejected');
    assert.equal(rejected.reason.code, 'RENDERER_BUSY');
    assert.equal(rejected.reason.status, 503);
    assert.equal(f.log.maxParallel, 1);
    assert.equal(f.log.pagesOpened, 2);
    await s.closeBrowser();
  });

  test('a crashed browser is relaunched on the next export', async () => {
    const f = fakeBrowserFactory();
    const s = svc(f);
    await s.renderPdf('a');
    f.browsers[0]._crash();
    await s.renderPdf('b');
    assert.equal(f.log.launches, 2);
    await s.closeBrowser();
  });

  test('no Chrome found -> RENDERER_UNAVAILABLE (503), nothing launched', async () => {
    const f = fakeBrowserFactory();
    const s = createPdfBrowserService({ launch: f.launch, env: {}, resolvePath: () => null });
    await assert.rejects(() => s.renderPdf('x'), (e) => e.code === 'RENDERER_UNAVAILABLE' && e.status === 503);
    assert.equal(f.log.launches, 0);
    assert.equal(s._state().running, 0);
  });

  test('launch failure -> RENDERER_UNAVAILABLE, and a later attempt can retry', async () => {
    let n = 0;
    const f = fakeBrowserFactory();
    const s = createPdfBrowserService({ env: {}, resolvePath: () => '/fake', launch: async (o) => { n += 1; if (n === 1) throw new Error('boom'); return f.launch(o); } });
    await assert.rejects(() => s.renderPdf('x'), (e) => e.code === 'RENDERER_UNAVAILABLE');
    await s.renderPdf('x');
    await s.closeBrowser();
  });
});

// ── HTTP handler ─────────────────────────────────────────────────────────────

describe('download handler', () => {
  const handler = (generate) => createDownloadHandler({ generate });
  const call = async (h, { query = {}, auditNumber } = {}) => {
    const res = mockRes();
    const req = { params: { projectId: '64b000000000000000000001' }, query, auditNumber };
    await h(req, res);
    return res;
  };
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(100)]);

  test('returns raw PDF bytes with attachment, length and private no-store headers', async () => {
    const res = await call(handler(async () => ({ pdf, filename: 'odito-full-audit-x-2026-01-01.pdf', pages: 9 })));
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'application/pdf');
    assert.equal(res.headers['content-disposition'], 'attachment; filename="odito-full-audit-x-2026-01-01.pdf"');
    assert.equal(res.headers['content-length'], String(pdf.length));
    assert.match(res.headers['cache-control'], /private/);
    assert.match(res.headers['cache-control'], /no-store/);
    assert.ok(Buffer.isBuffer(res.body));
  });

  test('passes the validated audit number through', async () => {
    let seen;
    await call(handler(async (id, o) => { seen = o; return { pdf, filename: 'a.pdf', pages: 1 }; }), { auditNumber: 2 });
    assert.equal(seen.auditNumber, 2);
  });

  test('unknown project / audit -> 404 with the established error shape', async () => {
    const res = await call(handler(async () => { throw new ReportError('Audit #99 not found for this project', 404, 'AUDIT_NOT_FOUND'); }));
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { success: false, error: { message: 'Audit #99 not found for this project', code: 'AUDIT_NOT_FOUND' } });
  });

  test('renderer errors map to 503/504 with customer-safe text (no internals)', async () => {
    const busy = await call(handler(async () => { throw new PdfRenderError('internal detail /opt/chrome', 'RENDERER_BUSY', 503); }));
    assert.equal(busy.statusCode, 503);
    assert.doesNotMatch(JSON.stringify(busy.body), /opt\/chrome/);
    const slow = await call(handler(async () => { throw new PdfRenderError('x', 'RENDER_TIMEOUT', 504); }));
    assert.equal(slow.statusCode, 504);
    const other = await call(handler(async () => { throw new Error('mongo password leaked here'); }));
    assert.equal(other.statusCode, 500);
    assert.doesNotMatch(JSON.stringify(other.body), /mongo|password/);
  });

  test('parameter validation: malformed project id and audit numbers are 400', () => {
    const run = (params, query) => { const res = mockRes(); const req = { params, query }; let next = false; validateDownloadParams(req, res, () => { next = true; }); return { res, next, req }; };
    assert.equal(run({ projectId: 'zzz' }, {}).res.statusCode, 400);
    assert.equal(run({ projectId: '64b000000000000000000001' }, { auditNumber: 'abc' }).res.body.error.code, 'INVALID_AUDIT_NUMBER');
    assert.equal(run({ projectId: '64b000000000000000000001' }, { auditNumber: '0' }).next, false);
    assert.equal(run({ projectId: '64b000000000000000000001' }, { auditNumber: '1.5' }).next, false);
    const ok = run({ projectId: '64b000000000000000000001' }, { auditNumber: '2' });
    assert.equal(ok.next, true);
    assert.equal(ok.req.auditNumber, 2);
    assert.equal(run({ projectId: '64b000000000000000000001' }, {}).next, true);
  });

  test('the route is wired: params validation -> auth/ownership middleware -> handler, behind JWT auth', () => {
    const layers = pdfRoutes.stack;
    const idxAuth = layers.findIndex((l) => !l.route && l.name === 'auth');
    const dl = layers.findIndex((l) => l.route?.path === '/:projectId/download');
    assert.ok(idxAuth >= 0 && dl > idxAuth, 'download is registered after the auth middleware');
    const names = layers[dl].route.stack.map((s) => s.name);
    assert.equal(names[0], 'validateDownloadParams');
    assert.equal(names.length, 3);
    assert.equal(layers[dl].route.methods.get, true);
    // existing report endpoint is untouched
    assert.ok(layers.some((l) => l.route?.path === '/:projectId/report'));
  });
});

// ── real Chromium end-to-end (skipped when no Chrome is available) ───────────

const REAL_CHROME = (() => { try { return resolveChromePath({ managedPath: null }); } catch { return null; } })();

describe('real Chromium rendering', { skip: REAL_CHROME ? false : 'no Chrome/Chromium available' }, () => {
  const T = new Date('2026-05-01T10:00:00Z');
  const base = () => ({
    loadProject: async () => ({ _id: 'p1', user_id: 'u', project_name: 'Acme', main_url: 'https://www.acme.test/', website_score: 71, audit_started_at: T, pages_crawled: 40 }),
    loadLatestRun: async () => ({ _id: 'r', projectId: 'p1', auditNumber: 2, startedAt: T, completedAt: new Date('2026-05-01T10:30:00Z'), websiteScore: 80, performanceScore: 60, technicalHealthScore: 70, aiVisibilityScore: 50 }),
    loadRunByNumber: async () => null,
    issues: { getIssueSummary: async () => ({ totalIssues: 12, critical: 3, warnings: 5, informational: 4, resolved: 2 }), getCategoryCounts: async () => [] },
    getOnPageIssues: async () => ({ issues: [{ issue_code: 'TITLE_MISSING', title: 'Title missing', severity: 'high', category: 'Meta', pages_affected: 4, impact_percentage: 10, difficulty: 'easy' }], summary: { total_issue_types: 1, total_issues_found: 4, total_pages_analyzed: 40 } }),
    getIssueUrls: async () => [{ url: 'https://acme.test/a' }],
    getAccessibilityIssues: async () => ({ issues: [], summary: { total_issues_found: 0, total_issue_types: 0, total_pages_analyzed: 40 } }),
    getTechnicalChecks: async () => ({ success: true, data: { checks: [{ id: 'ssl', name: 'SSL', status: 'OK', message: 'valid' }], summary: { healthScore: 100 } } }),
    getCrawlability: async () => ({ metrics: { totalPages: 40, indexedPages: 40, blockedPages: 0, indexRate: 100 }, blockedReasons: [] }),
    getStructuredData: async () => ({ success: true, data: { withSchema: 40, withoutSchema: 0, coverage: 100, errors: 0, schemaTypes: [{ type: 'WebPage', count: 40, pages: 40 }] } }),
    getProjectPerformance: async () => ({ success: true, data: { summary: { performanceScore: 60 }, mobile: { performance_score: 55, metrics: { lcp: { value: 3 } } }, desktop: null } }),
    loadCurrentRankings: async () => null, deriveHistoricalRanks: async () => ({ weekByKeyword: new Map(), monthByKeyword: new Map() }), loadLegacyRankings: async () => null,
    findSearchConsoleConnection: async () => null, getSearchConsoleAggregates: async () => ({}),
    hubHandlers: {
      getAEOHubData: async (q, r) => r.json({ success: true, data: null }),
      getGEOHubData: async (q, r) => r.json({ success: true, data: null }),
      getAISOHubData: async (q, r) => r.json({ success: true, data: { job_id: 'j', pages_scored: 5, computed_at: T, aiso_score: 80, hero: { crawlability: 80 } } }),
    },
    loadIssueGuidance: async () => new Map([['TITLE_MISSING', { recommendation: 'Add a title.', impact: 'Titles matter.', expected: null }]]),
    loadAiOverallScore: async () => 55, countTasksByStatus: async () => ({}), compareLatest: async () => ({ available: false, reason: 'only_one_audit' }),
  });

  const renderer = createPdfBrowserService({ env: { PDF_CHROME_PATH: REAL_CHROME, PDF_RENDER_TIMEOUT_MS: '60000' } });

  test('produces a valid A4 PDF whose page count and order match the report', async () => {
    const out = await generateFullAuditPdf('p1', { deps: base(), renderer });
    assert.equal(out.pdf.subarray(0, 5).toString(), '%PDF-');
    assert.ok(out.pdf.length > 5000);
    assert.equal(countPdfPages(out.pdf), out.pages);
    assert.equal(out.pageIds[0], 'cover');
    assert.equal(out.pageIds[7], 'keyword-ranking');
    assert.equal(out.pageIds[out.pageIds.length - 1], 'about-odito');
    const media = [...out.pdf.toString('latin1').matchAll(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/g)].map((m) => [Math.round(+m[1]), Math.round(+m[2])]);
    assert.ok(media.length > 0 && media.every(([w, h]) => w === 595 && h === 842), JSON.stringify(media));
    assert.match(out.filename, /^odito-full-audit-acme-test-audit2-2026-05-01\.pdf$/);
  });

  test('degraded data (unavailable/partial sections) still renders without inventing content', async () => {
    const deps = base();
    deps.getProjectPerformance = async () => { throw new Error('x'); };
    deps.getOnPageIssues = async () => { throw new Error('x'); };
    const out = await generateFullAuditPdf('p1', { deps, renderer });
    assert.equal(countPdfPages(out.pdf), out.pages);
  });

  test('a missing audit run is a 404 ReportError (no PDF is attempted)', async () => {
    await assert.rejects(() => generateFullAuditPdf('p1', { deps: base(), auditNumber: 99, renderer }), (e) => e instanceof ReportError && e.statusCode === 404);
  });

  test('page / context cleanup after real renders', async () => {
    assert.deepEqual(renderer._state(), { running: 0, queued: 0, hasBrowser: true });
    await renderer.closeBrowser();
  });
});
