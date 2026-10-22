import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';

import { waitForReportReady, ReportReadinessError } from './pdfReadiness.js';
import { resolveChromePath } from '../modules/pdf/render/chromePath.js';

const chrome = (() => { try { return resolveChromePath({ managedPath: null }); } catch { return null; } })();

describe('report readiness contract (real Chromium, no sleeps in the code under test)', { skip: chrome ? false : 'no Chrome/Chromium available' }, () => {
  let browser;
  before(async () => { browser = await puppeteer.launch({ headless: 'new', executablePath: chrome, args: ['--disable-gpu'] }); });
  after(async () => { await browser?.close(); });

  const load = async (body, script = '') => {
    const page = await browser.newPage();
    await page.setContent(`<html><body>${body}<script>${script}</script></body></html>`);
    return page;
  };
  const pagesHtml = (n) => Array.from({ length: n }, (_, i) => `<div data-report-page="p${i}">Page ${i}</div>`).join('');

  test('success: resolves as soon as the page signals ready after async work, reporting the rendered page count', async () => {
    const page = await load('<div id="root">Loading Report Data...</div>',
      `setTimeout(()=>{document.getElementById('root').outerHTML='${pagesHtml(3)}'; window.__PDF_READY__=true;}, 300);`);
    const t0 = Date.now();
    const r = await waitForReportReady(page, { timeoutMs: 5000 });
    assert.equal(r.pages, 3);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 250 && elapsed < 3000, `elapsed ${elapsed}`); // waited for the signal, not for a timeout
    await page.close();
  });

  test('a stale #report-loaded selector is irrelevant: readiness does not depend on it', async () => {
    const page = await load(pagesHtml(2), 'window.__PDF_READY__ = true;');
    assert.equal(await page.$('#report-loaded'), null);
    assert.equal((await waitForReportReady(page, { timeoutMs: 2000 })).pages, 2);
    await page.close();
  });

  test('timeout: never-ready page fails with READY_TIMEOUT at the configured limit (not 60s)', async () => {
    const page = await load(pagesHtml(2));
    const t0 = Date.now();
    await assert.rejects(() => waitForReportReady(page, { timeoutMs: 400 }), (e) => e instanceof ReportReadinessError && e.code === 'READY_TIMEOUT');
    assert.ok(Date.now() - t0 < 3000);
    await page.close();
  });

  test('render failure: __PDF_ERROR__ fails fast with REPORT_ERROR (does not wait for the timeout)', async () => {
    const page = await load('<h2>Error Loading Report</h2>', 'setTimeout(()=>{window.__PDF_ERROR__="Report belongs to a different project";}, 100);');
    const t0 = Date.now();
    await assert.rejects(() => waitForReportReady(page, { timeoutMs: 20000 }), (e) => e.code === 'REPORT_ERROR' && /different project/.test(e.message));
    assert.ok(Date.now() - t0 < 3000);
    await page.close();
  });

  test('incomplete report: ready flag but no rendered pages -> REPORT_INCOMPLETE', async () => {
    const page = await load('<div>nothing rendered</div>', 'window.__PDF_READY__ = true;');
    await assert.rejects(() => waitForReportReady(page, { timeoutMs: 2000 }), (e) => e.code === 'REPORT_INCOMPLETE');
    await page.close();
  });

  test('incomplete report: a loading screen still visible is never captured', async () => {
    const page = await load(`${pagesHtml(1)}<p>Loading Report Data...</p>`, 'window.__PDF_READY__ = true;');
    await assert.rejects(() => waitForReportReady(page, { timeoutMs: 2000 }), (e) => e.code === 'REPORT_INCOMPLETE');
    await page.close();
  });

  test('an error screen is rejected even if a ready flag leaked through', async () => {
    const page = await load(`${pagesHtml(1)}<h2>Error Loading Report</h2>`, 'window.__PDF_READY__ = true;');
    await assert.rejects(() => waitForReportReady(page, { timeoutMs: 2000 }), (e) => e.code === 'REPORT_ERROR');
    await page.close();
  });
});

describe('email PDF service wiring', () => {
  test('no stale #report-loaded wait, no fixed sleeps, no hardcoded Chrome path, no token in the URL', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('./puppeteerPdfService.js', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /waitForSelector\('#report-loaded'/);
    assert.doesNotMatch(src, /waitForTimeout/);
    assert.doesNotMatch(src, /C:\\\\Program Files/);
    assert.match(src, /waitForReportReady/);
    assert.doesNotMatch(src, /\?[^`'"]*token=/);
  });
});
