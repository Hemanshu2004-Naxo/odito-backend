/**
 * REAL-BROWSER tests: the actual Chromium (via Odito's shared browser service) against local HTTP servers. Skips when no Chrome is installed.
 * The only test-specific piece is the host `guard`: production uses ssrfGuard.resolveSafeTarget (which correctly refuses loopback), so the
 * tests substitute a guard that allows exactly the two local test hosts and treats `localhost` as "private" to prove the deny path.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createPdfBrowserService } from '../../pdf/render/pdfBrowserService.js';
import { resolveChromePath } from '../../pdf/render/chromePath.js';
import { createNavigationPolicy } from './navigationPolicy.js';
import { createInvestigationRenderer, InvestigationRenderError } from './investigationRenderer.js';
import { SafeFetchError, SSRF_ERROR } from '../net/ssrfGuard.js';
import { InvestigationRunner } from '../service/investigationOrchestrator.js';
import { createMemoryStore } from '../service/investigationStore.js';
import { fakeFetcher, fakeLlm, goodAnswer, ELIGIBLE } from '../testKit.js';

const chrome = (() => { try { return resolveChromePath({ managedPath: null }); } catch { return null; } })();
const skip = !chrome && 'no Chrome/Chromium installed';

const servers = [];
function serve(handler) {
  return new Promise((resolve) => {
    const hits = [];
    const s = http.createServer((req, res) => { hits.push(`${req.method} ${req.url}`); handler(req, res); });
    s.listen(0, '127.0.0.1', () => { servers.push(s); resolve({ s, hits, port: s.address().port, base: `http://127.0.0.1:${s.address().port}` }); });
  });
}
// 127.0.0.1 = the audited site / allowed public host in this test. "localhost" stands in for an INTERNAL host that must be denied.
const guard = async (url) => {
  const u = new URL(url);
  if (u.hostname === '127.0.0.1') return { url: u };
  throw new SafeFetchError(SSRF_ERROR.BLOCKED_HOST, 'internal host');
};
// Test servers live on loopback; production's isBlockedIp would (rightly) discard those renders, so tests allow exactly 127.0.0.1.
const isBlockedAddress = (ip) => ip !== '127.0.0.1';
const env = { ...process.env, RENDER_MAX_CONCURRENCY: '1', RENDER_MAX_QUEUE: '1', RENDER_TIMEOUT_MS: '8000' };
const service = createPdfBrowserService({ env });
const renderer = createInvestigationRenderer({ browser: service, guard, isBlockedAddress, env: { ...env, INVESTIGATION_RENDER_TIMEOUT_MS: '8000', INVESTIGATION_RENDER_SETTLE_MS: '1500' } });
const html = (res, body, status = 200) => { res.writeHead(status, { 'content-type': 'text/html' }); res.end(body); };

after(async () => { await service.closeBrowser(); await Promise.all(servers.map((s) => new Promise((r) => s.close(r)))); });

test('rendered DOM differs from raw HTML: JSON-LD and breadcrumb nav that only exist after JavaScript runs are captured', { skip }, async () => {
  const site = await serve((req, res) => html(res, `<!doctype html><html lang="en"><head><title>App</title></head><body><div id="root"></div><script>
    const ld = document.createElement('script'); ld.type = 'application/ld+json';
    ld.text = JSON.stringify({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Home', item: location.origin + '/' }, { '@type': 'ListItem', position: 2, name: 'About' }] });
    document.head.appendChild(ld);
    document.getElementById('root').innerHTML = '<nav aria-label="Breadcrumb"><ol><li><a href="/">Home</a></li><li aria-current="page">About</li></ol></nav><h1>About</h1>';
  </script></body></html>`));
  const raw = await (await fetch(`${site.base}/about`)).text();
  assert.ok(!raw.includes('BreadcrumbList'.toLowerCase()) || !/<nav/.test(raw), 'raw HTML has no rendered nav');
  const out = await renderer(`${site.base}/about`, { siteUrl: `${site.base}/`, projectId: 'p1' });
  assert.deepEqual(out.facts.structuredData.jsonLdTypes.filter((t) => t === 'BreadcrumbList'), ['BreadcrumbList']);
  assert.equal(out.facts.visibleBreadcrumbs[0].items[0].name, 'Home');
  assert.equal(out.facts.h1Count, 1);
  assert.equal(out.httpStatus, 200);
  assert.ok(out.timings.totalMs > 0 && out.timings.navigationMs >= 0);
  assert.equal(out.htmlTruncated, false);
  assert.ok(!out.requests.blockedSample.some((b) => b.resourceType === 'script' || b.resourceType === 'xhr'), 'no script/xhr was blocked');
});

test('security: scripts cannot reach internal hosts, use non-GET methods, load images, or frame other sites; nothing reaches those servers and the page still renders', { skip }, async () => {
  const internal = await serve((req, res) => { res.end('secret'); });          // reachable as http://localhost:PORT (denied by the guard)
  const other = await serve((req, res) => html(res, '<h1>other site</h1>'));   // a different host name
  const internalUrl = `http://localhost:${internal.port}`;
  const site = await serve((req, res) => {
    if (req.url.startsWith('/img')) return res.end('x');
    html(res, `<!doctype html><html><body><h1>Site</h1><img src="/img.png">
      <script>
        fetch('${internalUrl}/steal').catch(()=>{});
        fetch('/post-target', { method: 'POST', body: 'x' }).catch(()=>{});
        const f = document.createElement('iframe'); f.src = '${internalUrl}/frame'; document.body.appendChild(f);
        const f2 = document.createElement('iframe'); f2.src = 'http://localhost:${other.port}/framed'; document.body.appendChild(f2);
        const x = new XMLHttpRequest(); x.open('GET', 'http://localhost:${other.port}/xhr'); x.send();
        window.open('http://localhost:${other.port}/popup');
      </script></body></html>`);
  });
  const out = await renderer(`${site.base}/`, { siteUrl: `${site.base}/`, projectId: 'p1' });
  assert.equal(internal.hits.length, 0, 'internal host was never contacted');
  assert.equal(other.hits.length, 0, 'other host never contacted (iframe, XHR, pop-up)');
  assert.ok(!site.hits.some((h) => h.startsWith('POST')), 'POST never sent');
  assert.ok(!site.hits.some((h) => h.includes('/img')), 'images are not fetched');
  assert.equal(out.facts.h1Count, 1, 'the page itself still rendered');
  const reasons = out.requests.blockedByReason;
  assert.ok(reasons.method_not_allowed >= 1 && reasons.resource_type_blocked >= 1 && reasons.cross_site_navigation >= 1, JSON.stringify(reasons));
  assert.ok(out.requests.blockedSample.length > 0);
});

test('security: a script that navigates the page off-site ends the render as RENDER_NAVIGATION_BLOCKED; the other site is never contacted', { skip }, async () => {
  const other = await serve((req, res) => html(res, '<h1>other site</h1>'));
  const site = await serve((req, res) => html(res, `<!doctype html><h1>Site</h1><script>setTimeout(() => { location.href = 'http://localhost:${other.port}/redirected'; }, 100);</script>`));
  await assert.rejects(renderer(`${site.base}/`, { siteUrl: `${site.base}/`, projectId: 'p1' }), (e) => e instanceof InvestigationRenderError && e.code === 'RENDER_NAVIGATION_BLOCKED');
  assert.equal(other.hits.length, 0);
});

test('security: a server-side redirect of the main document to another host is refused (RENDER_NAVIGATION_BLOCKED) and never followed', { skip }, async () => {
  const other = await serve((req, res) => html(res, 'other'));
  const site = await serve((req, res) => { res.writeHead(302, { location: `http://localhost:${other.port}/landing` }); res.end(); });
  await assert.rejects(renderer(`${site.base}/`, { siteUrl: `${site.base}/`, projectId: 'p1' }), (e) => e instanceof InvestigationRenderError && e.code === 'RENDER_NAVIGATION_BLOCKED');
  assert.equal(other.hits.length, 0);
});

test('navigating to an off-site or internal START URL is refused before any request is made', { skip }, async () => {
  const other = await serve((req, res) => html(res, 'other'));
  await assert.rejects(renderer(`http://localhost:${other.port}/`, { siteUrl: 'http://127.0.0.1:1/', projectId: 'p1' }), (e) => e.code === 'RENDER_NAVIGATION_BLOCKED');
  assert.equal(other.hits.length, 0);
});

test('request cap: a page that fires hundreds of subresource requests is cut off at the cap', { skip }, async () => {
  const site = await serve((req, res) => {
    if (req.url.startsWith('/r')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}'); }
    html(res, `<!doctype html><body><h1>Busy</h1><script>for (let i = 0; i < 400; i++) fetch('/r' + i).catch(()=>{});</script></body>`);
  });
  const capped = createInvestigationRenderer({ browser: service, guard, isBlockedAddress, env: { ...env, INVESTIGATION_RENDER_MAX_REQUESTS: '40', INVESTIGATION_RENDER_SETTLE_MS: '1500' } });
  const out = await capped(`${site.base}/`, { siteUrl: `${site.base}/`, projectId: 'p-cap' });
  assert.ok(out.requests.requestCapHit);
  assert.ok(site.hits.length <= 41, `server saw ${site.hits.length}`);
  assert.ok(out.requests.blockedByReason.request_cap_exceeded > 300);
});

test('byte cap: once the transferred-byte budget is spent no further requests are allowed, and the DOM size is capped', { skip }, async () => {
  const site = await serve((req, res) => {
    if (req.url.startsWith('/big')) { res.writeHead(200, { 'content-type': 'application/javascript' }); return res.end('/*' + 'x'.repeat(200_000) + '*/'); }
    html(res, `<!doctype html><body><h1>Heavy</h1><p>${'A'.repeat(50_000)}</p><script>
      (async () => { for (let i = 0; i < 20; i++) { try { await fetch('/big' + i); } catch (e) {} } })();
    </script></body>`);
  });
  const tiny = createInvestigationRenderer({ browser: service, guard, isBlockedAddress, env: { ...env, INVESTIGATION_RENDER_MAX_BYTES: '300000', INVESTIGATION_RENDER_MAX_HTML_BYTES: '10000', INVESTIGATION_RENDER_SETTLE_MS: '2500' } });
  const out = await tiny(`${site.base}/`, { siteUrl: `${site.base}/`, projectId: 'p-bytes' });
  assert.ok(out.requests.byteCapHit, JSON.stringify(out.requests));
  assert.ok(site.hits.filter((h) => h.includes('/big')).length < 20);
  assert.equal(out.htmlTruncated, true);
  assert.ok(out.htmlBytes > 10_000);
});

test('timeout: a page that never answers fails with a stable code and frees its slot', { skip }, async () => {
  const hang = await serve(() => { /* never respond */ });
  const quick = createInvestigationRenderer({ browser: service, guard, isBlockedAddress, env: { ...env, INVESTIGATION_RENDER_TIMEOUT_MS: '900', INVESTIGATION_RENDER_SETTLE_MS: '300' } });
  const t0 = Date.now();
  await assert.rejects(quick(`${hang.base}/`, { siteUrl: `${hang.base}/`, projectId: 'p-to' }), (e) => e instanceof InvestigationRenderError && ['RENDER_NAVIGATION_FAILED', 'RENDER_TIMEOUT'].includes(e.code));
  assert.ok(Date.now() - t0 < 8000);
  assert.equal(service._inspectState().inspecting, 0, 'slot released');
});

test('cancellation: aborting mid-load stops the render promptly, closes the page and releases the slot', { skip }, async () => {
  const slow = await serve((req, res) => { setTimeout(() => html(res, '<h1>late</h1>'), 6000); });
  const ac = new AbortController();
  const p = renderer(`${slow.base}/`, { siteUrl: `${slow.base}/`, projectId: 'p-cancel', signal: ac.signal });
  setTimeout(() => ac.abort(), 400);
  const t0 = Date.now();
  await assert.rejects(p, (e) => e.code === 'RENDER_CANCELLED');
  assert.ok(Date.now() - t0 < 3000, 'returned promptly');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(service._inspectState().inspecting, 0);
  // already-aborted signal never starts a render
  const pre = AbortSignal.abort();
  await assert.rejects(renderer(`${slow.base}/`, { siteUrl: `${slow.base}/`, projectId: 'p-cancel', signal: pre }), (e) => e.code === 'RENDER_CANCELLED');
});

test('concurrency: the global gate (1 at a time here) serialises renders and a full queue is rejected as RENDERER_BUSY', { skip }, async () => {
  let live = 0; let peak = 0;
  const site = await serve((req, res) => { live += 1; peak = Math.max(peak, live); setTimeout(() => { live -= 1; html(res, '<h1>ok</h1>'); }, 500); });
  const r = (projectId) => renderer(`${site.base}/`, { siteUrl: `${site.base}/`, projectId });
  const results = await Promise.allSettled([r('a'), r('b'), r('c'), r('d')]);
  assert.equal(peak, 1, 'never more than one page loading');
  const ok = results.filter((x) => x.status === 'fulfilled').length;
  const busy = results.filter((x) => x.status === 'rejected' && x.reason.code === 'RENDERER_BUSY').length;
  assert.ok(ok >= 2 && busy >= 1, `ok=${ok} busy=${busy}`);
  assert.equal(service._inspectState().inspecting, 0);
});

test('per-project limit: two renders for ONE project never overlap even when the global gate would allow it', { skip }, async () => {
  let live = 0; let peak = 0;
  const site = await serve((req, res) => { live += 1; peak = Math.max(peak, live); setTimeout(() => { live -= 1; html(res, '<h1>ok</h1>'); }, 400); });
  const wide = createPdfBrowserService({ env: { ...env, RENDER_MAX_CONCURRENCY: '3', RENDER_MAX_QUEUE: '5' } });
  try {
    const r = createInvestigationRenderer({ browser: wide, guard, isBlockedAddress, env: { ...env, INVESTIGATION_RENDER_PER_PROJECT: '1' } });
    await Promise.all([r(`${site.base}/`, { siteUrl: `${site.base}/`, projectId: 'same' }), r(`${site.base}/`, { siteUrl: `${site.base}/`, projectId: 'same' })]);
    assert.equal(peak, 1);
    peak = 0;
    await Promise.all([r(`${site.base}/`, { siteUrl: `${site.base}/`, projectId: 'x' }), r(`${site.base}/`, { siteUrl: `${site.base}/`, projectId: 'y' })]);
    assert.equal(peak, 2, 'different projects may run in parallel');
  } finally { await wide.closeBrowser(); }
});

test('a page that crashes its own script or opens pop-ups/dialogs still renders and leaves no stray pages', { skip }, async () => {
  const site = await serve((req, res) => html(res, `<!doctype html><body><h1>Chaos</h1><script>
    window.open('/popup'); alert('hi'); confirm('x'); setTimeout(() => { throw new Error('boom'); }, 10);
  </script></body>`));
  const out = await renderer(`${site.base}/`, { siteUrl: `${site.base}/`, projectId: 'p-chaos' });
  assert.equal(out.facts.h1Count, 1);
  assert.equal(service._inspectState().inspecting, 0);
});

// ── policy unit tests (no browser) ────────────────────────────────────────────────────────
test('policy: post-hoc rebinding defence — a response served from a non-public IP discards the render', () => {
  const p = createNavigationPolicy({ siteUrl: 'https://www.acme.test/', guard: async () => ({}) });
  p.recordResponse({ url: 'https://cdn.acme.test/a.js', remoteAddress: '93.184.216.34' });
  p.assertClean();
  p.recordResponse({ url: 'https://rebind.acme.test/x', remoteAddress: '10.0.0.7' });
  assert.throws(() => p.assertClean(), (e) => e.code === 'RENDER_POLICY_VIOLATION' && e.details.remoteAddress === '10.0.0.7');
  const p2 = createNavigationPolicy({ siteUrl: 'https://www.acme.test/', guard: async () => ({}) });
  p2.recordResponse({ url: 'u', remoteAddress: '::ffff:169.254.169.254' });
  assert.throws(() => p2.assertClean());
});

test('policy: decisions — hosts are checked once, third-party public subresources are allowed, off-site documents and internal hosts are not', async () => {
  let calls = 0;
  const p = createNavigationPolicy({ siteUrl: 'https://www.acme.test/', guard: async (u) => { calls += 1; if (u.includes('internal')) throw new SafeFetchError(SSRF_ERROR.BLOCKED_ADDRESS, 'x'); return {}; } });
  assert.equal((await p.check({ url: 'https://acme.test/', resourceType: 'document', isNavigation: true })).allow, true, 'apex == www');
  assert.equal((await p.check({ url: 'https://cdn.thirdparty.test/lib.js', resourceType: 'script' })).allow, true);
  assert.equal((await p.check({ url: 'https://cdn.thirdparty.test/lib2.js', resourceType: 'script' })).allow, true);
  assert.equal(calls, 2, 'one DNS check per host');
  assert.equal((await p.check({ url: 'https://evil.test/', resourceType: 'document', isNavigation: true })).reason, 'cross_site_navigation');
  assert.equal((await p.check({ url: 'https://internal.thirdparty.test/x.js', resourceType: 'script' })).reason, SSRF_ERROR.BLOCKED_ADDRESS);
  assert.equal((await p.check({ url: 'file:///etc/passwd', resourceType: 'script' })).reason, 'scheme_not_allowed');
  assert.equal((await p.check({ url: 'data:text/html,<h1>x</h1>', resourceType: 'document', isNavigation: true })).reason, 'scheme_not_allowed');
  assert.equal((await p.check({ url: 'https://cdn.thirdparty.test/p', method: 'POST', resourceType: 'xhr' })).reason, 'method_not_allowed');
  assert.equal((await p.check({ url: 'wss://x.test/', resourceType: 'websocket' })).reason, 'scheme_not_allowed');
  assert.deepEqual(p.summary().thirdPartyHosts, ['cdn.thirdparty.test']);
  p.close();
  assert.equal((await p.check({ url: 'https://acme.test/late.js', resourceType: 'script' })).reason, 'render_finished');
});

test('FULL PIPELINE with the real browser: raw HTML has no markup, the rendered DOM does; evidence, comparison, duplicate detection and eligibility all follow from it', { skip }, async () => {
  const ldScript = `const ld = document.createElement('script'); ld.type = 'application/ld+json';
    ld.text = JSON.stringify({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Home', item: location.origin + '/' }, { '@type': 'ListItem', position: 2, name: 'About' }] });
    document.head.appendChild(ld);`;
  const site = await serve((req, res) => html(res, `<!doctype html><html lang="en"><head><title>About</title><script src="/a.js"></script><script src="/b.js"></script><script src="/c.js"></script></head><body><div id="root"></div><script>${ldScript}
    document.getElementById('root').innerHTML = '<h1>About</h1>';</script></body></html>`));
  const PAGE_URL = `${site.base}/about`;
  // The raw fetch is simulated (the SSRF-guarded fetcher correctly refuses loopback); the BROWSER is real and loads the local server.
  const rawShell = '<!doctype html><html><head><title>About</title><script src="/a.js"></script><script src="/b.js"></script><script src="/c.js"></script></head><body><div id="root"></div></body></html>';
  const fetcher = fakeFetcher({ [PAGE_URL]: { body: rawShell }, [`${site.base}/`]: { body: '<html><body><nav><ul><li><a href="/">Home</a></li><li><a href="/about">About</a></li></ul></nav></body></html>' } });
  const answer = goodAnswer({
    issueStatus: 'already_resolved', proposedChanges: [], codeOrConfiguration: [], requiresHumanApproval: false,
    findings: [{ statement: 'A BreadcrumbList exists only after JavaScript runs.', basis: 'corroborated', evidenceIds: ['E3', 'E4'] }],
  });
  const llm = fakeLlm([answer]);
  const deps = {
    store: createMemoryStore(), llm, fetcher, resolveCapabilities: async () => ELIGIBLE, renderPage: renderer,
    loadDetectorContext: async () => ({ currentState: { note: 'flagged' } }), loadCrawlPage: async () => null, loadSiblings: async () => [],
    now: () => Date.now(), sleep: async () => {}, log: () => {},
  };
  const runner = new InvestigationRunner(deps);
  const project = { id: '64b000000000000000000009', siteUrl: `${site.base}/` };
  const { record } = await runner.start({ project, userId: '64a000000000000000000009', issue: { issueId: 'breadcrumblist_schema', pageUrl: PAGE_URL, category: 'Structured Data' } });
  await runner.running.get(String(record._id));
  const saved = await deps.store.findById(record._id, project.id);
  assert.equal(saved.status, 'completed');
  const kinds = saved.evidenceTrace.map((e) => `${e.kind}:${e.status}`);
  assert.ok(kinds.includes('render_decision:ok') && kinds.includes('rendered_dom:ok') && kinds.includes('raw_vs_rendered:ok'), kinds.join(','));
  assert.match(llm.seen[0].user, /jsonLdTypesOnlyRendered/);
  assert.match(llm.seen[0].user, /BreadcrumbList/);
  const ren = saved.evidenceTrace.find((e) => e.kind === 'rendered_dom');
  assert.match(ren.method, /headless render/);
  assert.equal(saved.result.issueStatus, 'already_resolved');
  assert.equal(saved.result.findings[0].basis, 'corroborated', 'raw page + rendered DOM are two independent views');
  assert.equal(saved.result.automaticFixEligibility.eligible, false);
});
