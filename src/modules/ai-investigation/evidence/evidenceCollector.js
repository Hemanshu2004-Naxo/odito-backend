/**
 * evidenceCollector — gathers the evidence an investigation plan asks for, into an EvidenceLedger.
 *
 * Rules it enforces:
 *   - every outbound request goes through ssrfGuard.safeFetch, restricted to the audited site's host
 *   - the affected URL must belong to the audited site; otherwise nothing is fetched
 *   - each fetch is memoised per investigation; failures become explicit ledger entries (never "empty = fine")
 *   - fetched content is DATA: it is only parsed into bounded facts and never interpreted as instructions
 *   - a stored crawl is labelled as crawl data with its age, and is never presented as the live page
 *
 * Dependencies are injected so the whole thing runs offline in tests.
 */

import { safeFetch, SafeFetchError, SSRF_ERROR } from '../net/ssrfGuard.js';
import { inspectHtml } from './pageInspector.js';
import { decideRender } from './renderDecision.js';
import { compareRawRendered } from './renderComparison.js';
import { applicableAnalyzers } from '../structuredData/registry.js';
import { EvidenceLedger, EVIDENCE_SOURCE, EVIDENCE_STATUS, readLiveCache, writeLiveCache } from './evidenceLedger.js';

const KEPT_HEADERS = ['content-type', 'x-robots-tag', 'link', 'cache-control', 'last-modified', 'server', 'content-language'];
const AI_BOTS = ['gptbot', 'chatgpt-user', 'oai-searchbot', 'claudebot', 'claude-web', 'anthropic-ai', 'perplexitybot', 'google-extended', 'ccbot', 'applebot-extended'];

const hostOf = (url) => { try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; } };
const originOf = (url) => { try { return new URL(url).origin; } catch { return null; } };

export const isOnSite = (pageUrl, siteUrl) => !!hostOf(pageUrl) && hostOf(pageUrl) === hostOf(siteUrl);

function pickHeaders(headers = {}) {
  return Object.fromEntries(KEPT_HEADERS.filter((h) => headers[h] !== undefined).map((h) => [h, String(headers[h]).slice(0, 300)]));
}

/** Pure: parse robots.txt into what the investigation needs. */
export function parseRobotsTxt(text, pageUrl) {
  const groups = []; let current = null; const sitemaps = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase(); const value = m[2].trim();
    if (key === 'user-agent') {
      if (!current || current.rules.length) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
    } else if ((key === 'allow' || key === 'disallow') && current) current.rules.push({ type: key, path: value });
    else if (key === 'sitemap') sitemaps.push(value);
  }
  const path = (() => { try { const u = new URL(pageUrl); return u.pathname + u.search; } catch { return '/'; } })();
  const verdict = (agent) => {
    const exact = groups.filter((g) => g.agents.includes(agent));
    const applicable = exact.length ? exact : groups.filter((g) => g.agents.includes('*'));
    let best = null;
    for (const g of applicable) for (const r of g.rules) {
      if (!r.path) continue;
      const pattern = r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$');
      if (new RegExp(`^${pattern}`).test(path) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.type === 'allow'))) best = r;
    }
    return !best || best.type === 'allow' ? 'allowed' : 'disallowed';
  };
  return {
    groupCount: groups.length,
    sitemaps: sitemaps.slice(0, 5),
    pageForAllBots: verdict('*'),
    pageForGooglebot: verdict('googlebot'),
    aiBots: Object.fromEntries(AI_BOTS.filter((b) => groups.some((g) => g.agents.includes(b))).map((b) => [b, verdict(b)])),
    blocksEverything: groups.some((g) => g.agents.includes('*') && g.rules.some((r) => r.type === 'disallow' && r.path === '/')),
  };
}

function structuredTypesFromCrawl(structured) {
  const types = new Set();
  const walk = (n, d = 0) => {
    if (!n || d > 6) return;
    if (Array.isArray(n)) return n.forEach((x) => walk(x, d + 1));
    if (typeof n !== 'object') return;
    [].concat(n['@type'] || n.type || []).forEach((t) => typeof t === 'string' && types.add(t));
    Object.values(n).forEach((v) => v && typeof v === 'object' && walk(v, d + 1));
  };
  walk(structured);
  return [...types];
}

/**
 * @param {object} args
 * @param {{ id: string, siteUrl: string }} args.project
 * @param {{ issueId: string, pageUrl: string, category?: string, title?: string }} args.issue
 * @param {{ family: string, facets: string[] }} args.plan
 * @param {object} args.deps
 */
export async function collectEvidence({ project, issue, plan, deps, signal, onStep = () => {}, limits = {} }) {
  const { maxSiblingFetches = 2, fetchTimeoutMs = 15_000, maxBytes = 2 * 1024 * 1024 } = limits;
  const now = deps.now || (() => Date.now());
  const ledger = new EvidenceLedger({ now });
  const fetcher = deps.fetcher || safeFetch;
  const siteUrl = project.siteUrl;
  const restrictToHost = hostOf(siteUrl) ? siteUrl : null;
  const cancelled = () => signal?.aborted;

  /** One safe, memoised, cached-with-original-timestamp fetch that always yields a ledger item. */
  const fetchInto = (kind, url, { method = 'live GET (SSRF-guarded)', inspect = false } = {}) => ledger.once(`fetch|${url}`, async () => {
    const cached = readLiveCache(project.id, url, now());
    if (cached) return ledger.add({ ...cached, kind, fromCache: true, id: undefined });
    try {
      const res = await fetcher(url, { restrictToHost, timeoutMs: fetchTimeoutMs, maxBytes, signal });
      const base = {
        kind, source: EVIDENCE_SOURCE.LIVE_FETCH, method, url, httpStatus: res.status,
        status: EVIDENCE_STATUS.OK,
        summary: `HTTP ${res.status} from ${res.finalUrl}${res.redirects.length ? ` after ${res.redirects.length} redirect(s)` : ''}`,
      };
      const isHtml = /html|xml/i.test(String(res.headers['content-type'] || ''));
      let parsed = {};
      if (inspect && isHtml) {
        try {
          parsed = { facts: inspectHtml(res.body, res.finalUrl), headExcerpt: (res.body.match(/<head[\s\S]*?<\/head>/i)?.[0] || '').slice(0, 2500) };
        } catch (parseError) {
          // The page WAS retrieved; our own analysis failed. Say so (and keep the raw headers/status) instead of calling it a fetch failure.
          return ledger.add({
            kind, source: EVIDENCE_SOURCE.LIVE_FETCH, method, url, httpStatus: res.status, status: EVIDENCE_STATUS.ERROR,
            summary: `HTTP ${res.status} retrieved from ${res.finalUrl}, but the page could not be analysed.`,
            error: { code: 'INSPECT_FAILED', message: 'The page was retrieved but its HTML could not be analysed.' },
            data: { finalUrl: res.finalUrl, httpStatus: res.status, redirects: res.redirects, headers: pickHeaders(res.headers), bytes: res.body.length },
          });
        }
      } else parsed = { text: res.body.slice(0, 60_000) };
      const data = { finalUrl: res.finalUrl, httpStatus: res.status, redirects: res.redirects, headers: pickHeaders(res.headers), ...parsed, bytes: res.body.length };
      const item = ledger.add({ ...base, data, status: res.status >= 400 ? EVIDENCE_STATUS.ERROR : EVIDENCE_STATUS.OK, error: res.status >= 400 ? { code: `HTTP_${res.status}`, message: `The server answered HTTP ${res.status}.` } : null });
      // Cache a copy: later in-place refinements of the ledger item (robots/sitemap summaries) must not alter the cache.
      writeLiveCache(project.id, url, { ...item }, now());
      return item;
    } catch (error) {
      const blocked = error instanceof SafeFetchError && [SSRF_ERROR.BLOCKED_ADDRESS, SSRF_ERROR.BLOCKED_HOST, SSRF_ERROR.BLOCKED_PORT, SSRF_ERROR.BLOCKED_SCHEME, SSRF_ERROR.BLOCKED_CREDENTIALS, SSRF_ERROR.CROSS_HOST].includes(error.code);
      return ledger.add({
        kind, source: EVIDENCE_SOURCE.LIVE_FETCH, method, url,
        status: blocked ? EVIDENCE_STATUS.BLOCKED : EVIDENCE_STATUS.ERROR,
        summary: `Could not retrieve ${url}: ${error.message}`,
        error: { code: error.code || 'FETCH_FAILED', message: error.message },
      });
    }
  });

  // ── Scope check: only the audited site may be investigated ───────────────────────────────
  if (!isOnSite(issue.pageUrl, siteUrl)) {
    ledger.add({
      kind: 'page', source: EVIDENCE_SOURCE.LIVE_FETCH, method: 'scope check', url: issue.pageUrl, status: EVIDENCE_STATUS.BLOCKED,
      summary: 'The affected URL is not on the audited website, so it was not fetched.', error: { code: 'OUT_OF_SCOPE', message: 'URL host does not match the project website.' },
    });
    return ledger;
  }

  // ── Stored detection + crawl evidence (no network) ───────────────────────────────────────
  onStep('detector_evidence');
  try {
    const detector = await deps.loadDetectorContext?.(project.id, issue.issueId, issue.pageUrl);
    if (detector) {
      ledger.add({
        kind: 'detector', source: EVIDENCE_SOURCE.DETECTOR, method: 'IssueContextEngine.resolve', url: issue.pageUrl,
        summary: 'Why the detector flagged this page.', data: detector,
      });
    } else {
      ledger.add({ kind: 'detector', source: EVIDENCE_SOURCE.DETECTOR, method: 'IssueContextEngine.resolve', url: issue.pageUrl, status: EVIDENCE_STATUS.UNAVAILABLE, summary: 'No stored detector evidence for this issue/page.' });
    }
  } catch (error) {
    ledger.add({ kind: 'detector', source: EVIDENCE_SOURCE.DETECTOR, method: 'IssueContextEngine.resolve', url: issue.pageUrl, status: EVIDENCE_STATUS.ERROR, summary: 'Detector evidence could not be loaded.', error: { code: 'DETECTOR_LOAD_FAILED', message: error.message } });
  }

  let crawl = null;
  try { crawl = await deps.loadCrawlPage?.(project.id, issue.pageUrl); } catch { crawl = null; }
  if (crawl) {
    ledger.add({
      kind: 'crawl_page', source: EVIDENCE_SOURCE.CRAWL_DATA, method: 'stored crawl (seo_page_data)', url: issue.pageUrl,
      retrievedAt: crawl.crawledAt || null, summary: `Stored crawl record${crawl.crawledAt ? ` from ${crawl.crawledAt}` : ' (crawl time unknown)'}.`,
      data: {
        title: crawl.title ?? null, canonical: crawl.canonical ?? null, httpStatus: crawl.httpStatus ?? null,
        structuredDataTypes: structuredTypesFromCrawl(crawl.structuredData), cms: crawl.cms ?? null, framework: crawl.framework ?? null,
        pageIssues: (crawl.pageIssues || []).slice(0, 20),
      },
    });
  } else {
    ledger.add({ kind: 'crawl_page', source: EVIDENCE_SOURCE.CRAWL_DATA, method: 'stored crawl (seo_page_data)', url: issue.pageUrl, status: EVIDENCE_STATUS.UNAVAILABLE, summary: 'No stored crawl record for this page.' });
  }

  if (cancelled()) return ledger;

  // ── Live page ──────────────────────────────────────────────────────────────────────────
  let pageItem = null;
  if (plan.facets.includes('page') || plan.facets.includes('headers')) {
    onStep('fetch_page');
    pageItem = await fetchInto('page', issue.pageUrl, { inspect: true });

    // Raw HTML vs what the headless crawler stored: the difference is what JavaScript adds.
    const rawTypes = pageItem.data?.facts?.structuredData?.jsonLdTypes;
    const crawlItem = ledger.first('crawl_page');
    if (rawTypes && crawlItem) {
      const crawlTypes = crawlItem.data.structuredDataTypes || [];
      ledger.add({
        kind: 'rendering_comparison', source: EVIDENCE_SOURCE.CRAWL_DATA, method: 'raw HTML vs stored crawl', url: issue.pageUrl,
        summary: 'Structured-data types in the live raw HTML compared with the stored crawl record.',
        data: {
          inRawHtmlOnly: rawTypes.filter((t) => !crawlTypes.includes(t)),
          inCrawlOnly: crawlTypes.filter((t) => !rawTypes.includes(t)),
          likelyClientRendered: !!pageItem.data.facts.rendering?.likelyClientRendered,
          note: 'The stored crawl comes from Odito\'s headless crawler; types only in the crawl are probably injected by JavaScript or changed since the crawl.',
        },
      });
    }
    // Targeted rendering: only when the final DOM can change the diagnosis AND there is a sign JavaScript is involved.
    const rawFacts = pageItem.status === EVIDENCE_STATUS.OK ? pageItem.data?.facts : null;
    const crawlComparison = ledger.first('rendering_comparison')?.data || null;
    const decision = decideRender({ plan, rawFacts, comparison: crawlComparison, rendererAvailable: !!deps.renderPage });
    ledger.add({
      kind: 'render_decision', source: EVIDENCE_SOURCE.DERIVED, method: 'render policy for the issue family', url: issue.pageUrl, derivedFrom: [pageItem.id],
      summary: decision.render ? `Rendering requested: ${decision.reasons.join('; ')}.` : `Rendering skipped: ${decision.skipped}.`, data: decision,
    });
    if (decision.render) {
      if (!deps.renderPage) {
        ledger.add({
          kind: 'rendered_dom', source: EVIDENCE_SOURCE.LIVE_FETCH, method: 'headless render', url: issue.pageUrl, status: EVIDENCE_STATUS.UNAVAILABLE,
          summary: 'Rendering would help here, but no renderer is configured; the stored headless crawl is the only rendered-state evidence.',
          error: { code: 'RENDER_UNAVAILABLE', message: 'On-demand rendering is not configured.' },
        });
      } else {
        onStep('render_page');
        const t0 = (deps.now || Date.now)();
        try {
          const rendered = await deps.renderPage(issue.pageUrl, { signal, siteUrl, projectId: project.id });
          const item = ledger.add({
            kind: 'rendered_dom', source: EVIDENCE_SOURCE.LIVE_FETCH, method: `headless render (${rendered.engine || 'chromium'}) under navigation policy`, url: issue.pageUrl, httpStatus: rendered.httpStatus ?? null,
            summary: `Rendered DOM retrieved in ${rendered.timings?.totalMs ?? '?'} ms (${rendered.requests?.allowed ?? '?'} requests allowed, ${rendered.requests?.blocked ?? 0} blocked${rendered.htmlTruncated ? ', DOM truncated' : ''}).`,
            data: rendered,
          });
          ledger.add({
            kind: 'raw_vs_rendered', source: EVIDENCE_SOURCE.DERIVED, method: 'same inspector over raw HTML and rendered DOM', url: issue.pageUrl, derivedFrom: [pageItem.id, item.id],
            summary: '', data: null,
          });
          const cmp = compareRawRendered(rawFacts, rendered.facts);
          const cmpItem = ledger.items[ledger.items.length - 1];
          cmpItem.data = cmp; cmpItem.summary = cmp.summary;
        } catch (error) {
          const code = error.code || 'RENDER_FAILED';
          const status = ['RENDER_NAVIGATION_BLOCKED', 'RENDER_POLICY_VIOLATION'].includes(code) ? EVIDENCE_STATUS.BLOCKED
            : ['RENDERER_UNAVAILABLE', 'RENDERER_BUSY', 'RENDER_CANCELLED'].includes(code) ? EVIDENCE_STATUS.UNAVAILABLE : EVIDENCE_STATUS.ERROR;
          ledger.add({
            kind: 'rendered_dom', source: EVIDENCE_SOURCE.LIVE_FETCH, method: 'headless render under navigation policy', url: issue.pageUrl, status,
            summary: `Rendering did not produce a DOM (${code}) after ${(deps.now || Date.now)() - t0} ms.`,
            error: { code, message: String(error.message || 'Rendering failed.').slice(0, 300) }, data: error.details ? { requests: error.details.requests || null } : null,
          });
        }
      }
    }
  }

  if (cancelled()) return ledger;

  // ── Remaining facets, in parallel and bounded ────────────────────────────────────────────
  const origin = originOf(issue.pageUrl);
  const tasks = [];

  if (plan.facets.includes('homepage') && origin && `${origin}/` !== issue.pageUrl) {
    tasks.push(fetchInto('homepage', `${origin}/`, { inspect: true }));
  }

  let robotsItem = null;
  if (plan.facets.includes('robots_txt') || plan.facets.includes('sitemap')) {
    tasks.push(fetchInto('robots_txt', `${origin}/robots.txt`).then((item) => {
      robotsItem = item;
      if (item.status === EVIDENCE_STATUS.OK && item.data?.text !== undefined) {
        item.data = { ...item.data, parsed: parseRobotsTxt(item.data.text, issue.pageUrl), text: item.data.text.slice(0, 1500) };
      }
      return item;
    }));
  }
  if (plan.facets.includes('llms_txt')) tasks.push(fetchInto('llms_txt', `${origin}/llms.txt`));

  if (plan.facets.includes('siblings') && deps.loadSiblings) {
    tasks.push((async () => {
      let siblings = [];
      try { siblings = (await deps.loadSiblings(project.id, issue.pageUrl, maxSiblingFetches)) || []; } catch { siblings = []; }
      const picked = siblings.filter((u) => u !== issue.pageUrl && isOnSite(u, siteUrl)).slice(0, maxSiblingFetches);
      if (!picked.length) {
        ledger.add({ kind: 'sibling', source: EVIDENCE_SOURCE.CRAWL_DATA, method: 'crawl sample', status: EVIDENCE_STATUS.UNAVAILABLE, summary: 'No comparable crawled pages were found.' });
        return;
      }
      await Promise.all(picked.map((u) => fetchInto('sibling', u, { inspect: true })));
    })());
  }
  await Promise.all(tasks);

  if (plan.facets.includes('sitemap') && !cancelled()) {
    onStep('fetch_sitemap');
    const declared = robotsItem?.data?.parsed?.sitemaps?.[0];
    const sitemapUrl = declared && isOnSite(declared, siteUrl) ? declared : `${origin}/sitemap.xml`;
    const item = await fetchInto('sitemap', sitemapUrl);
    if (item.status === EVIDENCE_STATUS.OK && typeof item.data?.text === 'string') {
      const text = item.data.text;
      const isIndex = /<sitemapindex/i.test(text);
      const target = issue.pageUrl.replace(/\/$/, '');
      const listed = !isIndex && new RegExp(`<loc>\\s*${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?\\s*</loc>`, 'i').test(text);
      item.data = { ...item.data, text: undefined, summary: { isIndex, urlCount: (text.match(/<loc>/gi) || []).length, pageListed: isIndex ? 'unknown (sitemap index not expanded)' : listed, truncated: item.data.bytes >= maxBytes } };
    }
  }

  if (plan.facets.includes('headers') && pageItem?.status !== EVIDENCE_STATUS.UNAVAILABLE && pageItem?.data) {
    ledger.add({ kind: 'response_headers', source: EVIDENCE_SOURCE.LIVE_FETCH, method: 'headers of page fetch', url: issue.pageUrl, summary: 'Relevant response headers and redirect chain.', data: { headers: pageItem.data.headers, redirects: pageItem.data.redirects, finalUrl: pageItem.data.finalUrl } });
  }

  // ── Structured-data analyzers (derived evidence; see structuredData/registry.js) ───────────────────────
  if (!cancelled()) {
    for (const analyzer of applicableAnalyzers({ issue, plan })) {
      onStep(`analyze_${analyzer.id}`);
      try {
        const out = await analyzer.analyze({ ledger, issue, siteUrl, project, deps, fetchUrl: (url) => fetchInto('hierarchy_url', url) });
        ledger.add({
          kind: 'structured_analysis', source: EVIDENCE_SOURCE.DERIVED, method: `${analyzer.id} analyzer over collected evidence`, url: issue.pageUrl, status: out.status,
          summary: out.summary, data: { analyzerId: analyzer.id, schemaTypes: analyzer.schemaTypes, ...out.data }, derivedFrom: out.derivedFrom || [],
        });
      } catch (error) {
        ledger.add({ kind: 'structured_analysis', source: EVIDENCE_SOURCE.DERIVED, method: `${analyzer.id} analyzer`, url: issue.pageUrl, status: EVIDENCE_STATUS.ERROR, summary: 'The analysis could not be completed.', error: { code: 'ANALYZER_FAILED', message: String(error.message).slice(0, 200) }, data: { analyzerId: analyzer.id } });
      }
    }
  }

  return ledger;
}

export default { collectEvidence, parseRobotsTxt, isOnSite };
