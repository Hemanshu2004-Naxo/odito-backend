/**
 * defaultDeps — production wiring of the engine's dependencies onto Odito's EXISTING services.
 * Nothing here crawls or calls a model itself: it adapts IssueContextEngine, the stored crawl, SSRF-safe fetch and Claude.
 */

import mongoose from 'mongoose';
import IssueContextEngine from '../../issue-context/service/IssueContextEngine.js';
import { safeFetch } from '../net/ssrfGuard.js';
import { claudeInvestigationLlm } from '../llm/investigationLlm.js';
import { resolveFixCapabilities } from '../capabilities/fixCapabilities.js';
import { createMongoStore } from './investigationStore.js';
import { createInvestigationRenderer } from '../render/investigationRenderer.js';
import { collectSiteEntity } from '../../schema-evidence/siteEntity.js';
import { loadBusinessProfileFacts } from '../../schema-evidence/businessProfileFacts.js';
import { loadAddressSources } from '../../schema-evidence/organizationAddressStore.js';

const toOid = (id) => { try { return new mongoose.Types.ObjectId(String(id)); } catch { return null; } };
const clip = (value, max) => { const s = JSON.stringify(value ?? null); return s.length > max ? { truncated: true, preview: s.slice(0, max) } : value; };

async function loadDetectorContext(projectId, issueId, pageUrl) {
  const ctx = await IssueContextEngine.resolve(projectId, issueId, pageUrl);
  if (!ctx) return null;
  return {
    currentState: clip(ctx.currentState, 5000),
    expectedState: clip(ctx.expectedState, 2500),
    pageContext: clip(ctx.pageContext, 1500),
    recommendationReady: ctx.recommendationReady ?? null,
    readinessScore: ctx.metadata?.readinessScore ?? null,
  };
}

async function loadCrawlPage(projectId, pageUrl) {
  const pid = toOid(projectId); const db = mongoose.connection?.db;
  if (!pid || !db) return null;
  const [page, issues] = await Promise.all([
    db.collection('seo_page_data').findOne({ projectId: pid, url: pageUrl }, {
      projection: { title: 1, canonical: 1, structured_data: 1, http_status: 1, cms: 1, framework: 1, crawled_at: 1, updated_at: 1, updatedAt: 1, createdAt: 1 },
    }),
    db.collection('seo_page_issues').find({ projectId: pid, page_url: pageUrl }).project({ issue_code: 1, rule_id: 1, detected_value: 1, expected_value: 1 }).limit(25).toArray(),
  ]);
  if (!page) return null;
  const when = page.crawled_at || page.updated_at || page.updatedAt || page.createdAt || null;
  return {
    title: page.title ?? null,
    canonical: Array.isArray(page.canonical) ? page.canonical[0] : page.canonical ?? null,
    httpStatus: page.http_status ?? null,
    structuredData: page.structured_data ?? null,
    cms: page.cms ?? null, framework: page.framework ?? null,
    crawledAt: when ? new Date(when).toISOString() : null,
    pageIssues: issues.map((i) => ({ issue: i.issue_code || i.rule_id, detected: clip(i.detected_value, 300), expected: clip(i.expected_value, 300) })),
  };
}

/** Same-site crawled pages, preferring the same top-level section (shared templates/conventions). */
async function loadSiblings(projectId, pageUrl, limit) {
  const pid = toOid(projectId); const db = mongoose.connection?.db;
  if (!pid || !db) return [];
  const docs = await db.collection('seo_page_data').find({ projectId: pid }, { projection: { url: 1 } }).limit(300).toArray();
  const section = (u) => { try { return new URL(u).pathname.split('/').filter(Boolean)[0] || ''; } catch { return ''; } };
  const depth = (u) => { try { return new URL(u).pathname.split('/').filter(Boolean).length; } catch { return 0; } };
  const mine = section(pageUrl); const myDepth = depth(pageUrl);
  return docs.map((d) => d.url).filter((u) => u && u !== pageUrl)
    .sort((a, b) => (section(b) === mine) - (section(a) === mine) || Math.abs(depth(a) - myDepth) - Math.abs(depth(b) - myDepth))
    .slice(0, limit);
}

/** Where an Organization's address could come from: the site's own entity, a verified business profile, owner/confirmed details. Each degrades to "nothing found". */
async function loadAddressContext(projectId, siteUrl) {
  const origin = (() => { try { return new URL(siteUrl).origin; } catch { return null; } })();
  const [site, profile, addressSources] = await Promise.all([
    collectSiteEntity(projectId).catch(() => null),
    loadBusinessProfileFacts(projectId, origin).catch(() => null),
    loadAddressSources(projectId, { siteUrl: origin }).catch(() => null),
  ]);
  return { site, profile, addressSources };
}

export function createDefaultDeps() {
  return {
    store: createMongoStore(),
    llm: claudeInvestigationLlm,
    fetcher: safeFetch,
    resolveCapabilities: resolveFixCapabilities,
    loadDetectorContext,
    loadAddressContext,
    loadCrawlPage,
    loadSiblings,
    // Targeted rendering through Odito's shared browser service under a per-request navigation policy. Only invoked when the evidence plan
    // decides the final DOM can change the diagnosis. Kill switch: INVESTIGATION_RENDER_ENABLED=false (the stored headless crawl is then labelled as the only rendered-state evidence).
    renderPage: process.env.INVESTIGATION_RENDER_ENABLED === 'false' ? null : createInvestigationRenderer(),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (level, event, fields) => console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](`[AI_INVESTIGATION] ${event}`, JSON.stringify(fields)),
  };
}

export default { createDefaultDeps };
