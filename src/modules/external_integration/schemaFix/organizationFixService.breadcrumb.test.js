import { describe, test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import {
  applyOrganizationFix, getOrganizationFixPreview, reverifyOrganizationFix, rollbackOrganizationFix,
} from './organizationFixService.js';
import WordPressFixRecord from '../model/WordPressFixRecord.js';
import { WordPressConnectionError } from '../service/wordPressService.js';
import Recommendation from '../../recommendations/model/Recommendation.js';
import { inspectPagesBreadcrumbs } from '../../schema-evidence/breadcrumbs/breadcrumbDiscovery.js';
import { verifyBreadcrumbRollout, verifyRenderedBreadcrumbPage } from '../../schema-evidence/breadcrumbs/breadcrumbVerification.js';

/**
 * The breadcrumb fix through the SHARED fix engine, against a stateful double of the Odito SEO Bridge (breadcrumbs.enabled) and a double
 * "public site" that renders Rank Math's BreadcrumbList from that setting, plus a live local Mongo for the ledger (auto-skipped when
 * unreachable). Nothing here reaches a real WordPress site.
 */

let mongoAvailable = false;
before(async () => {
  try { await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 }); mongoAvailable = true; } catch { mongoAvailable = false; }
});
const projectIds = [];
after(async () => {
  if (mongoAvailable) {
    await WordPressFixRecord.deleteMany({ projectId: { $in: projectIds } });
    await mongoose.connection.close();
  }
});

const SITE = 'https://www.acme.test/';
const PAGE = `${SITE}services/local-seo/`;
const CRAWL_URL = `${SITE}services/local-seo`;
const OTHER_A = `${SITE}services/national-seo/`;
const OTHER_B = `${SITE}services/ppc/`;
const TRAIL = [{ name: 'Home', url: SITE }, { name: 'Services', url: `${SITE}services/` }, { name: 'Local SEO', url: PAGE }];
const rmTrailFor = (url) => (url === PAGE ? TRAIL : [{ name: 'Home', url: SITE }, { name: 'Services', url: `${SITE}services/` }, { name: 'Other', url }]);

const crumbHtml = (trail) => `<html><head><script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': [{ '@type': 'WebPage', '@id': `${SITE}#webpage` }, { '@type': 'BreadcrumbList', itemListElement: trail.map((t, i) => ({ '@type': 'ListItem', position: i + 1, name: t.name, item: t.url })) }] })}</script></head></html>`;
const plainHtml = '<html><head><script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage"}</script></head></html>';

function world({ provider = 'rank_math', connected = true, trail = TRAIL, predicted, extra = {} } = {}) {
  const projectId = new mongoose.Types.ObjectId();
  projectIds.push(projectId);
  const connectionId = new mongoose.Types.ObjectId();
  const bridge = {
    enabled: false, writes: [], faults: [],
    status: { installed: true, provider, siteSchemaSupported: true, organizationTypeSupported: true, bridgeVersion: '1.6.0' },
    async getBridgeStatus() { return bridge.status; },
    async getSiteSchema() { return { provider, organization: { name: 'Acme', kind: 'company', sameAs: [], protectedSameAs: [], additionalSameAs: [], address: {} }, breadcrumbs: { enabled: bridge.enabled } }; },
    async updateSiteSchemaField(_c, entity, field, value, op) {
      bridge.writes.push({ entity, field, value, op });
      const fault = bridge.faults.find((f) => (f.times ?? 1) > 0);
      if (fault) { fault.times = (fault.times ?? 1) - 1; if (fault.mode === 'commit_then_throw') bridge.enabled = value; throw fault.error; }
      bridge.enabled = value;
      if (bridge.onWrite) bridge.onWrite();
      return { provider, operation: null, organization: {}, breadcrumbs: { enabled: value } };
    },
  };
  const site = { cached: false, hide: new Set(), duplicate: new Set(), hits: 0 };
  // the public site: Rank Math prints the trail only while the setting is on (and the page is not served from a stale cache)
  const fetchHtml = async (url) => {
    site.hits += 1;
    const u = url.replace(/\/?$/, '/');
    if (site.duplicate.has(u)) return { status: 200, html: crumbHtml(rmTrailFor(u)).replace('</head>', `${crumbHtml(rmTrailFor(u)).match(/<script[\s\S]*<\/script>/)[0]}</head>`) };
    if (!bridge.enabled || site.cached || site.hide.has(u)) return { status: 200, html: plainHtml };
    return { status: 200, html: crumbHtml(rmTrailFor(u)) };
  };
  const task = { _id: new mongoose.Types.ObjectId(), projectId, issueKey: 'breadcrumblist_schema', pageUrl: CRAWL_URL, status: 'task_created', recommendationId: new mongoose.Types.ObjectId(), fixHistory: [], saves: 0, async save() { this.saves += 1; } };
  const w = {
    task, bridge, site, projectId, connectionId,
    deps: {
      wordPressService: { getHydratedConnectionOrThrow: async () => { if (!connected) throw new WordPressConnectionError('NOT_CONNECTED', 'No WordPress connection exists for this project.', 404); return { _id: connectionId, site_url: SITE }; } },
      bridge,
      loadBreadcrumbEvidence: async () => (trail ? { items: trail.map((t, i) => ({ position: i + 1, ...t })) } : null),
      loadPageDoc: async () => ({ url: CRAWL_URL, canonical: PAGE }),
      inspectBreadcrumbPages: ({ urls }) => inspectPagesBreadcrumbs({ urls }, { fetchHtml, isFetchable: () => true, limits: { cacheTtlMs: 0 } }),
      resolveResource: async () => ({ resolved: true, postId: 7, postType: 'pages', permalink: PAGE, isFrontPage: false }),
      predictTrail: async () => predicted ?? { predictable: true, urls: TRAIL.map((t) => t.url), reason: null },
      loadAffectedPages: async () => [CRAWL_URL, OTHER_A, OTHER_B],
      verifyBreadcrumbRollout: (input) => verifyBreadcrumbRollout(input, { fetchHtml }),
      verifyBreadcrumbPage: (input) => verifyRenderedBreadcrumbPage(input, { fetchHtml }),
      taskHistory: { applyImplementedTransition: async (t, p = {}) => { t.status = 'implemented'; t.fixHistory.push({ fixApplied: { externalWrite: p.externalWrite, expectedAfterValue: p.expectedAfterValueOverride } }); } },
      ...extra,
    },
  };
  return w;
}

let currentProject;
beforeEach(() => {
  mock.restoreAll();
  mock.method(Recommendation, 'findById', () => ({ select: () => ({ lean: async () => ({ projectId: currentProject }) }) }));
});
const withProject = (w) => { currentProject = w.projectId; return w; };
const skip = (t) => { if (!mongoAvailable) { t.skip('local MongoDB not reachable'); return true; } return false; };
const preview = (w) => getOrganizationFixPreview(w.task, w.deps);
const apply = async (w, over = {}) => applyOrganizationFix(w.task, { approved: true, expectedPlanFingerprint: (await preview(w)).plan.fingerprint, actorId: new mongoose.Types.ObjectId(), ...over }, w.deps);

describe('breadcrumb preview — read-only, deterministic, honest', () => {
  test('shows the confirmed trail, the exact JSON-LD, the site-wide scope and the write target — and writes nothing', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    const p = await preview(w);
    assert.equal(p.fixType, 'breadcrumb_setting');
    assert.equal(p.plan.status, 'ready'); assert.equal(p.breadcrumb.panelState, 'ready_to_apply');
    assert.deepEqual(p.proposedChanges.map((c) => [c.field, c.kind, c.before, c.after]), [['breadcrumbs_enabled', 'enable', '', 'on']]);
    assert.deepEqual(p.breadcrumb.trail.map((i) => i.name), ['Home', 'Services', 'Local SEO']);
    const ld = JSON.parse(/<script[^>]*>([\s\S]*?)<\/script>/.exec(p.breadcrumb.jsonLd)[1]);
    assert.equal(ld['@type'], 'BreadcrumbList'); assert.deepEqual(ld.itemListElement.map((i) => [i.position, i.name, i.item]), TRAIL.map((x, i) => [i + 1, x.name, x.url]));
    assert.equal(p.breadcrumb.scope.kind, 'site_wide'); assert.equal(p.breadcrumb.scope.affectedCount, 3);
    assert.match(p.breadcrumb.target.label, /Rank Math/); assert.equal(p.breadcrumb.settingNow, 'off');
    assert.equal(p.breadcrumb.canonicalUrl, PAGE);
    assert.equal(p.validation.valid, true); assert.equal(p.approvalStatus, 'awaiting_approval');
    assert.equal(w.bridge.writes.length, 0); assert.equal(await WordPressFixRecord.countDocuments({ taskId: w.task._id }), 0);
  });

  test('no confirmed trail yet: asks for it; the page already valid: stale finding; both offer nothing to approve', async (t) => {
    if (skip(t)) return;
    const none = withProject(world({ trail: null }));
    const n = await preview(none);
    assert.equal(n.plan.code, 'TRAIL_NOT_CONFIRMED'); assert.equal(n.breadcrumb.panelState, 'needs_trail'); assert.equal(n.approvalStatus, 'not_available');
    assert.equal(n.breadcrumb.jsonLd, null);

    const valid = withProject(world({ extra: { inspectBreadcrumbPages: async () => [{ url: CRAWL_URL, status: 'valid', items: [], problems: [] }] } }));
    const v = await preview(valid);
    assert.equal(v.plan.code, 'STALE_FINDING'); assert.equal(v.breadcrumb.panelState, 'already_valid'); assert.equal(v.approvalStatus, 'not_available');
  });

  test('a saved trail whose last item is no longer the canonical URL is stale and never reused', async (t) => {
    if (skip(t)) return;
    const w = withProject(world({ extra: { loadPageDoc: async () => ({ url: CRAWL_URL, canonical: `${SITE}services/renamed/` }) } }));
    const p = await preview(w);
    assert.equal(p.plan.code, 'TRAIL_NOT_CONFIRMED'); assert.equal(p.breadcrumb.confirmedTrailStale, true);
  });

  test('unsupported: Rank Math would build another trail, another plugin, WordPress not connected, existing duplicate → manual steps + the same JSON-LD, no Apply', async (t) => {
    if (skip(t)) return;
    const differs = withProject(world({ predicted: { predictable: true, urls: [SITE, PAGE], reason: null } }));
    const d = await preview(differs);
    assert.equal(d.plan.code, 'TRAIL_WOULD_DIFFER'); assert.equal(d.breadcrumb.panelState, 'unsupported_source'); assert.equal(d.approvalStatus, 'not_available');
    assert.ok(d.breadcrumb.manual.steps.length >= 2); assert.ok(d.breadcrumb.jsonLd.includes('"Services"'));

    const yoast = withProject(world({ provider: 'yoast' }));
    assert.match((await preview(yoast)).breadcrumb.manual.steps[0], /Yoast SEO/);

    const off = withProject(world({ connected: false }));
    const o = await preview(off);
    assert.equal(o.plan.code, 'WORDPRESS_NOT_CONNECTED'); assert.ok(o.breadcrumb.jsonLd);

    const dup = withProject(world({ extra: { inspectBreadcrumbPages: async () => [{ url: CRAWL_URL, status: 'duplicate', items: [], problems: [] }] } }));
    assert.equal((await preview(dup)).plan.code, 'EXISTING_BREADCRUMB_INVALID');
  });

  test('a page of another site is refused before anything is read or written', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    w.task.pageUrl = 'https://not-this-site.example/x';
    await assert.rejects(preview(w), (e) => e.details?.reason === 'page_not_on_connected_site');
  });
});

describe('breadcrumb apply — approval, write, read-back, per-page rendered verification, ledger', () => {
  test('switches the setting on once, reads it back, verifies the confirmed trail AND the other affected pages on the public site, records the ledger and the task', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    const actorId = new mongoose.Types.ObjectId();
    const r = await apply(w, { actorId });
    assert.deepEqual(w.bridge.writes, [{ entity: 'breadcrumbs', field: 'enabled', value: true, op: null }]);
    assert.equal(w.bridge.enabled, true);
    assert.equal(r.immediateVerification, 'success'); assert.equal(r.fix.status, 'verified');
    assert.equal(r.fix.verification.saved.status, 'verified'); assert.equal(r.fix.verification.rendered.status, 'verified');
    const fields = r.fix.verification.rendered.fields;
    assert.ok(fields.find((f) => f.field === 'breadcrumb_matches_confirmed').ok);
    assert.deepEqual(fields.filter((f) => f.field.startsWith('page:')).map((f) => [f.field.slice(5), f.ok]), [[OTHER_A, true], [OTHER_B, true]]);
    assert.equal(w.task.status, 'implemented'); assert.notEqual(w.task.status, 'verified_fixed');
    const write = w.task.fixHistory[0].fixApplied;
    assert.equal(write.externalWrite.field, 'breadcrumb_setting'); assert.deepEqual(write.expectedAfterValue, { type: 'breadcrumb', enabled: true });
    const rec = await WordPressFixRecord.findOne({ taskId: w.task._id });
    assert.equal(rec.fixType, 'breadcrumb_setting'); assert.equal(String(rec.approvedBy), String(actorId));
    assert.deepEqual(rec.changes.map((c) => [c.field, c.before, c.after, c.applied, c.writeState]), [['breadcrumbs_enabled', '', 'on', true, 'landed']]);
    assert.deepEqual(rec.target.trail.map((x) => x.url), TRAIL.map((x) => x.url)); assert.equal(rec.target.displayUrl, PAGE);
  });

  test('saved but the public page does not show it (cache): verification FAILED with the cache reason; the task is not verified; a re-check later verifies it without writing again', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    w.site.cached = true;
    const r = await apply(w);
    assert.equal(r.immediateVerification, 'failed'); assert.equal(r.fix.status, 'verification_failed');
    assert.equal(r.fix.verification.saved.status, 'verified'); assert.equal(r.fix.verification.rendered.reasonCode, 'NOT_IN_RENDERED_PAGE');
    assert.ok(r.fix.verification.rendered.reasons.some((x) => /cache/i.test(x)));
    assert.notEqual(w.task.status, 'verified_fixed');
    w.site.cached = false;
    const writes = w.bridge.writes.length;
    const again = await reverifyOrganizationFix(w.task, w.deps);
    assert.equal(again.fix.status, 'verified'); assert.equal(w.bridge.writes.length, writes);
  });

  test('Rank Math builds a different trail than the confirmed one (a prediction that was wrong) → verification FAILED naming both trails', async (t) => {
    if (skip(t)) return;
    const w = withProject(world({ predicted: { predictable: false, urls: [], reason: 'post' } }));
    const realFetch = w.deps.verifyBreadcrumbRollout;
    w.deps.verifyBreadcrumbRollout = (input) => realFetch(input);
    // the site publishes Home › Local SEO only
    const odd = world();
    odd.deps.verifyBreadcrumbRollout = (input) => verifyBreadcrumbRollout(input, { fetchHtml: async () => ({ status: 200, html: crumbHtml([{ name: 'Home', url: SITE }, { name: 'Local SEO', url: PAGE }]) }) });
    odd.deps.predictTrail = async () => ({ predictable: false, urls: [], reason: 'post' });
    withProject(odd);
    const r = await apply(odd);
    assert.equal(r.fix.status, 'verification_failed');
    const f = r.fix.verification.rendered.fields.find((x) => x.field === 'breadcrumb_matches_confirmed');
    assert.equal(f.ok, false); assert.match(f.actual, /differs from the one you confirmed/);
  });

  test('another affected page that does not show the trail is listed, never hidden, and never turns the confirmed page into a failure or a success for the other page', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    w.site.hide.add(OTHER_B);
    const r = await apply(w);
    assert.equal(r.fix.status, 'verified');
    const pages = r.fix.verification.rendered.fields.filter((f) => f.field.startsWith('page:'));
    assert.deepEqual(pages.map((f) => [f.field.slice(5), f.ok]), [[OTHER_A, true], [OTHER_B, false]]);
  });

  test('a duplicate BreadcrumbList that another source starts publishing right after the change is a verification FAILURE (breadcrumb_single)', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    w.bridge.onWrite = () => w.site.duplicate.add(PAGE);
    const r = await apply(w);
    assert.equal(r.fix.status, 'verification_failed'); assert.equal(r.immediateVerification, 'failed');
    const f = r.fix.verification.rendered.fields.find((x) => x.field === 'breadcrumb_single');
    assert.equal(f.ok, false); assert.match(f.actual, /2 BreadcrumbList entities/);
  });

  test('a duplicate that exists BEFORE approval is a stale preview (the plan changed): nothing is written', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    const fp = (await preview(w)).plan.fingerprint;
    w.site.duplicate.add(PAGE);
    await assert.rejects(applyOrganizationFix(w.task, { approved: true, expectedPlanFingerprint: fp }, w.deps), (e) => e.code === 'CONFLICT' && e.details.reason === 'preview_stale');
    assert.equal(w.bridge.writes.length, 0);
  });

  test('a stale preview (the setting changed since) is a conflict and writes nothing', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    const fp = (await preview(w)).plan.fingerprint;
    w.bridge.enabled = true; // somebody switched it on by hand after the preview
    await assert.rejects(applyOrganizationFix(w.task, { approved: true, expectedPlanFingerprint: fp }, w.deps), (e) => e.code === 'CONFLICT' && e.details.reason === 'preview_stale');
    assert.equal(w.bridge.writes.length, 0);
  });

  test('a stale preview (the confirmed trail changed since) is a conflict too; approval and fingerprint are mandatory; unsupported plans cannot be applied', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    const fp = (await preview(w)).plan.fingerprint;
    w.deps.loadBreadcrumbEvidence = async () => ({ items: [{ position: 1, name: 'Home', url: SITE }, { position: 2, name: 'Local SEO', url: PAGE }] });
    await assert.rejects(applyOrganizationFix(w.task, { approved: true, expectedPlanFingerprint: fp }, w.deps), (e) => e.details?.reason === 'preview_stale');
    await assert.rejects(applyOrganizationFix(w.task, { approved: false, expectedPlanFingerprint: fp }, w.deps), (e) => e.code === 'WRITE_FAILED');
    await assert.rejects(applyOrganizationFix(w.task, { approved: true }, w.deps), (e) => e.code === 'EXPECTED_STATE_REQUIRED');
    const yoast = withProject(world({ provider: 'yoast' }));
    const yfp = (await preview(yoast)).plan.fingerprint;
    await assert.rejects(applyOrganizationFix(yoast.task, { approved: true, expectedPlanFingerprint: yfp }, yoast.deps), (e) => e.code === 'FIELD_NOT_WRITABLE');
    assert.equal(w.bridge.writes.length + yoast.bridge.writes.length, 0);
  });

  test('applying the same approved plan twice writes once (idempotent); a timeout after WordPress committed is reconciled by READING, not repeated', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    const p = await preview(w);
    await applyOrganizationFix(w.task, { approved: true, expectedPlanFingerprint: p.plan.fingerprint }, w.deps);
    await applyOrganizationFix(w.task, { approved: true, expectedPlanFingerprint: p.plan.fingerprint }, w.deps).catch(() => null);
    assert.equal(w.bridge.writes.length, 1); assert.equal(await WordPressFixRecord.countDocuments({ taskId: w.task._id }), 1);

    const lost = withProject(world());
    lost.bridge.faults.push({ mode: 'commit_then_throw', error: new WordPressConnectionError('TIMEOUT', 'The WordPress site took too long to respond.', 504) });
    const r = await apply(lost);
    assert.equal(lost.bridge.writes.length, 1); assert.equal(r.fix.changes[0].attribution, 'reconciled'); assert.equal(lost.bridge.enabled, true);
  });

  test('a definite refusal puts nothing half-applied: failed record, task untouched', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    w.bridge.faults.push({ error: new WordPressConnectionError('WRITE_FAILED', 'rejected', 422) });
    await assert.rejects(apply(w), (e) => e.code === 'WRITE_FAILED');
    assert.equal(w.bridge.enabled, false); assert.equal(w.task.status, 'task_created');
    assert.equal((await WordPressFixRecord.findOne({ taskId: w.task._id })).status, 'apply_failed');
  });
});

describe('breadcrumb rollback', () => {
  test('switches the setting off again, reads it back, and confirms the page no longer publishes the trail; a second rollback is refused', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    await apply(w);
    const rb = await rollbackOrganizationFix(w.task, { actorId: new mongoose.Types.ObjectId() }, w.deps);
    assert.equal(w.bridge.enabled, false);
    assert.equal(rb.fix.status, 'rolled_back'); assert.equal(rb.fix.rollback.status, 'verified'); assert.equal(rb.fix.rollback.rendered.status, 'verified');
    await assert.rejects(rollbackOrganizationFix(w.task, {}, w.deps), (e) => e.statusCode === 404);
  });

  test('a person who changed the setting meanwhile is left alone', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    await apply(w);
    w.bridge.enabled = false; // switched off by hand
    const rb = await rollbackOrganizationFix(w.task, {}, w.deps);
    assert.equal(rb.fix.status, 'rolled_back'); assert.equal(w.bridge.writes.length, 1, 'nothing written: already off');
  });
});
