/**
 * breadcrumbFixAdapter — everything the shared fix engine (organizationFixService.js) needs to know about the BREADCRUMB change: Rank Math's
 * site-wide breadcrumb switch, planned from the trail the owner confirmed. Same shape as sameAsFixAdapter.js: the engine supplies the ledger,
 * the compare-and-set write, reconcile, restore and rollback; this file supplies planning input, the change's read/write form, the
 * deterministic JSON-LD for the manual path, and what the rendered pages must show.
 *
 * One change: `breadcrumbs_enabled`  ''  →  'on'   (Bridge: breadcrumbs.enabled false → true; rollback puts it back to false).
 */

import mongoose from 'mongoose';
import wordPressService from '../service/wordPressService.js';
import { resolveWordPressResourceByUrl } from '../service/wordPressUrlResolver.js';
import { getUserBreadcrumbEvidence } from '../../schema-evidence/breadcrumbEvidenceStore.js';
import { checkBreadcrumbJsonLdMatches } from '../../recommendations/service/breadcrumbRecommendation.js';
import { generateBreadcrumbListJsonLd, serializeJsonLdForScript } from '../../schema-evidence/breadcrumbHierarchy.js';
import { pickDisplayUrl } from '../../schema-evidence/schemaGraph.js';
import { inspectPagesBreadcrumbs } from '../../schema-evidence/breadcrumbs/breadcrumbDiscovery.js';
import { verifyBreadcrumbRollout, verifyRenderedBreadcrumbPage } from '../../schema-evidence/breadcrumbs/breadcrumbVerification.js';
import { BREADCRUMB_FIELD, BREADCRUMB_FIX_TYPE, planBreadcrumbFix } from './breadcrumbFixPlan.js';

export const isBreadcrumbField = (field) => field === BREADCRUMB_FIELD;

/** Live state of the change as a string comparable with c.before / c.after: 'on' or ''. */
export const breadcrumbStateOf = (live) => (live?.breadcrumbs_enabled === 'on' ? 'on' : '');

export function writeBreadcrumbChange(deps, connection, from, to) {
  return deps.bridge.updateSiteSchemaField(connection, 'breadcrumbs', 'enabled', to === 'on', null);
}

export class BreadcrumbInputError extends Error {
  constructor(code, message, status = 422, details = undefined) { super(message); this.name = 'BreadcrumbInputError'; this.code = code; this.status = status; this.details = details; }
}

const MAX_ANCESTORS = 6;

/**
 * The trail Rank Math builds for a PAGE: home › each parent page (WordPress page hierarchy) › the page. Read from WordPress itself, never
 * guessed from the URL. Posts (category / blog page) and anything else cannot be predicted.
 */
export async function predictRankMathTrail(connection, resource) {
  const home = `${String(connection.site_url).replace(/\/+$/, '')}/`;
  if (!resource?.resolved) return null;
  if (resource.isFrontPage) return { predictable: false, urls: [], reason: 'This is the home page: Rank Math shows no trail on it.' };
  if (resource.postType !== 'pages') return { predictable: false, urls: [], reason: 'Rank Math builds a post\'s trail from its category or the blog page when it renders, so Odito cannot predict it exactly. The rendered page is checked right after the change.' };
  const urls = [];
  let id = resource.postId;
  for (let hops = 0; hops < MAX_ANCESTORS && id; hops += 1) {
    const { status, data } = await wordPressService.wpRequest(connection, { method: 'GET', path: `/wp-json/wp/v2/pages/${encodeURIComponent(id)}?_fields=id,parent,link`, timeout: 10_000, skipErrorClassification: true });
    if (status !== 200 || !data?.link) return { predictable: false, urls: [], reason: 'The page hierarchy could not be read from WordPress, so the trail Rank Math would build could not be predicted.' };
    urls.unshift(data.link);
    id = Number(data.parent) > 0 ? Number(data.parent) : 0;
  }
  if (id) return { predictable: false, urls: [], reason: 'The page hierarchy is deeper than Odito reads, so the trail could not be predicted.' };
  return { predictable: true, urls: [home, ...urls], reason: null };
}

async function loadAffectedPages(projectId) {
  const pid = (() => { try { return new mongoose.Types.ObjectId(String(projectId)); } catch { return null; } })();
  const db = mongoose.connection?.db;
  if (!pid || !db) return [];
  const rows = await db.collection('seo_page_issues').find({ projectId: pid, status: 'open', $or: [{ rule_id: 'breadcrumblist_schema' }, { issue_code: 'breadcrumblist_schema' }] }).project({ page_url: 1 }).limit(400).toArray();
  return [...new Set(rows.map((r) => r.page_url).filter(Boolean))];
}

/** Default collaborators; tests inject their own through the engine's `deps`. */
export const breadcrumbDefaultDeps = () => ({
  loadBreadcrumbEvidence: getUserBreadcrumbEvidence,
  inspectBreadcrumbPages: inspectPagesBreadcrumbs,
  resolveResource: (connection, url) => resolveWordPressResourceByUrl(connection, url, { useCache: false }),
  predictTrail: predictRankMathTrail,
  loadAffectedPages,
  verifyBreadcrumbRollout,
  verifyBreadcrumbPage: verifyRenderedBreadcrumbPage,
});

/**
 * The owner-confirmed trail for this task's page, only while it still ends at the page's canonical URL (a canonical that changed since the
 * confirmation makes the saved trail stale, never silently reused).
 */
async function confirmedTrail(task, deps) {
  const saved = await deps.loadBreadcrumbEvidence(task.projectId, task.pageUrl);
  if (!saved?.items?.length) return { trail: null, display: null };
  const doc = await deps.loadPageDoc(task.projectId, task.pageUrl).catch(() => null);
  const display = pickDisplayUrl({ canonical: Array.isArray(doc?.canonical) ? doc.canonical[0] : doc?.canonical, pageUrl: task.pageUrl });
  const last = saved.items[saved.items.length - 1];
  const norm = (u) => String(u || '').replace(/\/+$/, '');
  const stale = !display.url || norm(last.url) !== norm(display.url);
  return { trail: stale ? null : saved.items.map((i) => ({ name: i.name, url: i.url })), display, stale };
}

/**
 * Builds the plan for a breadcrumb task. Works without a WordPress connection (`connection === null`): the plan is then `unsupported` with
 * manual instructions, so the JSON-LD is never withheld because an integration is missing.
 */
export async function buildBreadcrumbPlan({ task, deps, connection, bridgeStatus, unavailable = null }) {
  const { trail, display, stale } = await confirmedTrail(task, deps);
  const live = (await deps.inspectBreadcrumbPages({ urls: [task.pageUrl] }))?.[0] || null;
  const affectedPages = await deps.loadAffectedPages(task.projectId).catch(() => []);

  let enabledNow = null; let resource = null; let predicted = null;
  if (connection && bridgeStatus && !unavailable && bridgeStatus.provider === 'rank_math' && bridgeStatus.siteSchemaSupported) {
    enabledNow = !!(await deps.bridge.getSiteSchema(connection)).breadcrumbs?.enabled;
    resource = await deps.resolveResource(connection, task.pageUrl);
    if (resource?.resolved && trail) predicted = await deps.predictTrail(connection, resource);
  }
  const plan = planBreadcrumbFix({
    trail, live, enabledNow, provider: unavailable ? 'none' : (bridgeStatus?.provider ?? 'none'), predicted, resource, affectedPages, unavailable,
    context: { projectId: task.projectId, connectionId: connection?._id ?? null, pageUrl: task.pageUrl },
    capabilities: { siteSchemaSupported: !!bridgeStatus?.siteSchemaSupported },
  });
  return { plan, trail, display, stale: !!stale, live, enabledNow, predicted, resource, affectedPages };
}

/** The deterministic JSON-LD for the confirmed trail, validated against the generator's exact shape. The same text serves the manual path. */
export function expectedAfterBreadcrumb({ plan, trail }) {
  const errors = [];
  let jsonLd = null; let text = null;
  if (trail && trail.length >= 2) {
    const items = trail.map((t, i) => ({ position: i + 1, name: t.name, url: t.url }));
    jsonLd = generateBreadcrumbListJsonLd(items);
    errors.push(...checkBreadcrumbJsonLdMatches(jsonLd, items));
    text = `<script type="application/ld+json">\n${serializeJsonLdForScript(jsonLd)}\n</script>`;
  } else {
    errors.push('There is no confirmed breadcrumb trail to build structured data from.');
  }
  return { entity: jsonLd, jsonLdText: text, state: { breadcrumbsEnabled: plan.status === 'ready' ? 'on' : '' }, validation: { valid: errors.length === 0, errors, warnings: (plan.warnings || []).map((w) => w.message) } };
}

export function previewExtras({ plan, trail, display, stale, live, enabledNow, predicted, after, record, lifecycle }) {
  let panelState;
  if (record?.status === 'verified') panelState = 'applied_verified';
  else if (record?.status === 'verification_failed') panelState = 'verification_failed';
  else if (record?.status === 'rolled_back') panelState = 'rolled_back';
  else if (record && ['applied', 'verifying', 'applying', 'apply_uncertain'].includes(record.status)) panelState = 'applied_verification_pending';
  else if (plan.code === 'STALE_FINDING') panelState = 'already_valid';
  else if (plan.code === 'TRAIL_NOT_CONFIRMED') panelState = 'needs_trail';
  else if (plan.status === 'unsupported') panelState = 'unsupported_source';
  else if (plan.status === 'ready') panelState = after.validation.valid ? 'ready_to_apply' : 'validation_failed';
  else panelState = plan.status === 'blocked' ? 'blocked' : 'not_available';
  return {
    panelState, trail: trail || [], confirmedTrailStale: stale, canonicalUrl: display?.url || null,
    live: live ? { status: live.status, problems: live.problems || [] } : null,
    settingNow: enabledNow === null ? null : (enabledNow ? 'on' : 'off'),
    scope: plan.scope, target: plan.target, manual: plan.manual, warnings: plan.warnings,
    predicted: predicted ? { predictable: !!predicted.predictable, urls: predicted.urls || [], reason: predicted.reason || null } : null,
    jsonLd: after.jsonLdText, lifecycle,
  };
}

/** What a record's rendered verification must prove — persisted on the record so a re-check never depends on the client. */
export function recordTarget({ plan, trail, display, task, connection }) {
  return {
    kind: BREADCRUMB_FIX_TYPE, pageUrl: task.pageUrl, displayUrl: display?.url || null,
    trail: (trail || []).map((t) => ({ name: t.name, url: t.url })),
    affectedPages: (plan.scope?.affectedPages || []).filter((u) => u !== task.pageUrl).slice(0, 200),
    siteUrl: connection?.site_url || null,
  };
}

export const rolloutInputFromRecord = (record) => ({
  pageUrl: record.target?.pageUrl || record.targetUrl, siteUrl: record.target?.siteUrl, displayUrl: record.target?.displayUrl || null,
  intended: record.target?.trail || null, otherPages: record.target?.affectedPages || [],
});

/** Maps a rollout result onto the ledger's verification part (the confirmed page decides; every checked page is listed). */
export function rolloutToPart(result, { attempts = 1, now }) {
  return {
    status: result.status === 'verified' ? 'verified' : result.status === 'failed' ? 'failed' : 'unverifiable',
    reasonCode: result.status === 'verified' ? null : (result.code || null),
    attempts, checkedAt: now, crawledAt: null, reasons: result.reasons || [],
    fields: [
      ...(result.checks || []).map((c) => ({ field: c.name, expected: 'ok', actual: c.ok ? 'ok' : (c.detail || 'failed'), ok: c.ok })),
      ...(result.pages || []).filter((p) => !p.confirmed).map((p) => ({ field: `page:${p.url}`, expected: 'valid', actual: p.status === 'verified' ? 'valid' : (p.reasons?.[0] || p.status), ok: p.status === 'verified' })),
    ],
  };
}

export const taskExpectedAfter = () => ({ type: 'breadcrumb', enabled: true });

export default { buildBreadcrumbPlan, expectedAfterBreadcrumb, previewExtras, recordTarget, rolloutInputFromRecord, rolloutToPart, writeBreadcrumbChange, breadcrumbStateOf, isBreadcrumbField, predictRankMathTrail, taskExpectedAfter, breadcrumbDefaultDeps, BreadcrumbInputError };
