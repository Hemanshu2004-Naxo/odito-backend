import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { resolveFixCapabilities, ELIGIBILITY } from '../capabilities/fixCapabilities.js';
import { deriveLifecycle, createLifecycleService } from './lifecycleService.js';
import { InvestigationRunner } from './investigationOrchestrator.js';
import { createInvestigationController, toView } from '../controller/investigationController.js';
import { PAGE, SITE, PROJECT, ELIGIBLE, page, VISIBLE_CRUMBS, fakeFetcher, fakeLlm, makeDeps, goodAnswer, waitFor } from '../testKit.js';

// ── Capability resolution (uses Odito's REAL provider registry) ───────────────────────────
const connected = { connected: true, bridgeInstalled: true, ambiguous: false, provider: 'rank_math', faqSchemaSupported: true, ratingSchemaSupported: true, capabilities: { title: { write: true } } };

test('capabilities: an issue with no adapter is not_supported with a manual-plan reason', async () => {
  const c = await resolveFixCapabilities({ issueId: 'images_missing_alt_text_xyz', projectId: 'p' }, { loadIntegration: async () => connected });
  assert.equal(c.eligibility, ELIGIBILITY.NOT_SUPPORTED);
  assert.equal(c.adapterId, null);
});

test('capabilities: registry-supported + connected site with the Bridge -> eligible (breadcrumblist_schema)', async () => {
  const c = await resolveFixCapabilities({ issueId: 'breadcrumblist_schema', projectId: 'p' }, { loadIntegration: async () => connected });
  assert.equal(c.eligibility, ELIGIBILITY.ELIGIBLE);
  assert.equal(c.adapterId, 'wordpress_seo_bridge');
  assert.equal(c.scope, 'site');
  assert.equal(c.typedFix, true);
});

test('capabilities: supported in principle but the site is not connected / has no Bridge / ambiguous plugins -> requires setup, listing what is missing', async () => {
  let c = await resolveFixCapabilities({ issueId: 'breadcrumblist_schema', projectId: 'p' }, { loadIntegration: async () => ({ connected: false }) });
  assert.equal(c.eligibility, ELIGIBILITY.REQUIRES_SETUP);
  assert.deepEqual(c.missingCapabilities, ['wordpress_connection']);
  c = await resolveFixCapabilities({ issueId: 'breadcrumblist_schema', projectId: 'p' }, { loadIntegration: async () => ({ ...connected, bridgeInstalled: false }) });
  assert.ok(c.missingCapabilities.includes('odito_seo_bridge'));
  c = await resolveFixCapabilities({ issueId: 'breadcrumblist_schema', projectId: 'p' }, { loadIntegration: async () => ({ ...connected, ambiguous: true }) });
  assert.ok(c.missingCapabilities.includes('single_active_seo_plugin'));
});

test('capabilities: per-field Bridge flags (faq schema) and per-field plugin write support are respected', async () => {
  const faq = await resolveFixCapabilities({ issueId: 'faq_schema', projectId: 'p' }, { loadIntegration: async () => ({ ...connected, faqSchemaSupported: false }) });
  assert.equal(faq.eligibility, ELIGIBILITY.REQUIRES_SETUP);
  assert.ok(faq.missingCapabilities.includes('faqSchemaSupported'));
  const title = await resolveFixCapabilities({ issueId: 'title_too_long', projectId: 'p' }, { loadIntegration: async () => ({ ...connected, capabilities: { title: { write: false } } }) });
  assert.equal(title.eligibility, ELIGIBILITY.REQUIRES_SETUP);
});

test('capabilities: statically unsupported registry entries stay unsupported even when the site is fully connected', async () => {
  const c = await resolveFixCapabilities({ issueId: 'author_info_missing', projectId: 'p' }, { loadIntegration: async () => connected });
  assert.equal(c.eligibility, ELIGIBILITY.NOT_SUPPORTED);
  assert.match(c.reason, /Person|Author|not/i);
});

test('capabilities: unreadable connection state -> unknown, never "eligible" by default', async () => {
  const c = await resolveFixCapabilities({ issueId: 'breadcrumblist_schema', projectId: 'p' }, { loadIntegration: async () => { throw new Error('db down'); } });
  assert.equal(c.eligibility, ELIGIBILITY.UNKNOWN);
});

// ── Lifecycle: applied / verified only from real execution + verification records ─────────
const inv = { result: { lifecycle: { fixProposed: true } }, lifecycle: { verificationRunId: null } };
const attempt = (over = {}) => ({ fixApplied: { externalWrite: { system: 'wordpress', field: 'breadcrumb_schema', writtenAt: new Date('2026-10-21T10:00:00Z') } }, verification: { verifiedAt: null, result: null }, ...over });

test('lifecycle: no task -> proposed only', () => {
  const l = deriveLifecycle({ investigation: inv, task: null });
  assert.deepEqual([l.fixProposed, l.fixApplied, l.fixVerified, l.verificationStatus], [true, false, false, 'not_started']);
});

test('lifecycle: user clicked "Mark as implemented" (no adapter write) is reported separately, NOT as applied or verified', () => {
  const l = deriveLifecycle({ investigation: inv, task: { status: 'implemented', fixHistory: [{ fixApplied: {}, verification: {} }] } });
  assert.equal(l.fixApplied, false);
  assert.equal(l.userReportedImplemented, true);
  assert.equal(l.fixVerified, false);
});

test('lifecycle: adapter write recorded -> applied; still NOT verified until the re-crawl says so', () => {
  const l = deriveLifecycle({ investigation: inv, task: { status: 'implemented', fixHistory: [attempt()] } });
  assert.equal(l.fixApplied, true);
  assert.equal(l.appliedBy, 'wordpress:breadcrumb_schema');
  assert.equal(l.fixVerified, false);
});

test('lifecycle: verification FAILED (detector still sees the issue) -> applied but not verified, status failed', () => {
  const task = { status: 'reopened', fixHistory: [attempt({ verification: { verifiedAt: new Date('2026-10-21T11:00:00Z'), result: 'reopened' } })] };
  const l = deriveLifecycle({ investigation: inv, task });
  assert.equal(l.fixApplied, true);
  assert.equal(l.fixVerified, false);
  assert.equal(l.verificationStatus, 'failed');
});

test('lifecycle: verified only when the task is verified_fixed WITH a verification record', () => {
  const ok = deriveLifecycle({ investigation: inv, task: { status: 'verified_fixed', fixHistory: [attempt({ verification: { verifiedAt: new Date('2026-10-21T11:00:00Z'), result: 'verified_fixed' } })] } });
  assert.equal(ok.fixVerified, true);
  assert.equal(ok.verificationStatus, 'passed');
  const inconsistent = deriveLifecycle({ investigation: inv, task: { status: 'verified_fixed', fixHistory: [attempt()] } });
  assert.equal(inconsistent.fixVerified, false, 'a status flag alone is not verification evidence');
});

test('lifecycle: fix execution failure leaves nothing applied (no write recorded)', () => {
  const l = deriveLifecycle({ investigation: inv, task: { status: 'task_created', fixHistory: [] } });
  assert.equal(l.fixApplied, false);
  assert.equal(l.userReportedImplemented, false);
});

test('requestVerification: started run is recorded as pending (not passed); refused/failed/stale/duplicate starts change nothing', async () => {
  const fresh = () => ({ _id: 'i1', projectId: 'p1', requestKey: 'k', status: 'completed', pageUrl: PAGE, lifecycle: { verificationStatus: 'not_started' } });
  const rows = new Map([['i1', fresh()]]);
  const store = {
    findById: async (id, pid) => (rows.get(id)?.projectId === pid ? structuredClone(rows.get(id)) : null),
    findLatestByKey: async (pid, key) => [...rows.values()].reverse().find((r) => r.projectId === pid && r.requestKey === key) || null,
    update: async (id, pid, patch) => { Object.assign(rows.get(id), patch); },
  };
  let calls = 0;
  let outcome = { success: true, code: 'STARTED', data: { verificationRunId: 'run-9' } };
  let task = null;
  const svc = createLifecycleService({ store, loadTask: async () => task, startVerification: async () => { calls += 1; return outcome; } });
  // nothing applied -> nothing to verify, and the pipeline is never asked
  const nothing = await svc.requestVerification({ investigationId: 'i1', projectId: 'p1', userId: 'u' });
  assert.deepEqual([nothing.started, nothing.code, calls], [false, 'NOTHING_TO_VERIFY', 0]);
  task = { status: 'implemented', fixHistory: [{ fixApplied: { externalWrite: { system: 'wordpress', field: 'f', writtenAt: new Date() } }, verification: {} }] };
  const started = await svc.requestVerification({ investigationId: 'i1', projectId: 'p1', userId: 'u' });
  assert.equal(started.started, true);
  assert.equal(rows.get('i1').lifecycle.verificationStatus, 'pending');
  assert.equal(rows.get('i1').lifecycle.verificationRunId, 'run-9');
  assert.equal((await svc.get({ investigationId: 'i1', projectId: 'p1' })).lifecycle.fixVerified, false);

  // a repeated click while one is pending does not start a second run
  const dup = await svc.requestVerification({ investigationId: 'i1', projectId: 'p1', userId: 'u' });
  assert.deepEqual([dup.started, dup.code, calls], [false, 'ALREADY_RUNNING', 1]);

  // the pipeline refusing is relayed and changes nothing
  rows.set('i1', fresh());
  outcome = { success: false, code: 'ALREADY_RUNNING', message: 'busy' };
  const refused = await svc.requestVerification({ investigationId: 'i1', projectId: 'p1', userId: 'u' });
  assert.equal(refused.started, false);
  assert.equal(rows.get('i1').lifecycle.verificationStatus, 'not_started');

  // an OLDER investigation for the same page cannot start a verification
  rows.set('i2', { ...fresh(), _id: 'i2' });
  const stale = await svc.requestVerification({ investigationId: 'i1', projectId: 'p1', userId: 'u' });
  assert.deepEqual([stale.started, stale.code], [false, 'STALE_INVESTIGATION']);
  // an unfinished investigation cannot either
  rows.set('i2', { ...fresh(), _id: 'i2', status: 'running' });
  assert.equal((await svc.requestVerification({ investigationId: 'i2', projectId: 'p1', userId: 'u' })).code, 'INVESTIGATION_NOT_COMPLETE');
  assert.equal(await svc.requestVerification({ investigationId: 'i1', projectId: 'OTHER', userId: 'u' }), null);
});

test('lifecycle: only attempts AFTER the investigation count; a verification older than the write is ignored', () => {
  const investigation = { createdAt: '2026-10-21T12:00:00Z', result: { lifecycle: { fixProposed: true } }, lifecycle: {} };
  const old = { fixApplied: { externalWrite: { system: 'wordpress', field: 'canonical', writtenAt: new Date('2026-10-01T10:00:00Z') } }, verification: { verifiedAt: new Date('2026-10-01T11:00:00Z'), result: 'verified_fixed' } };
  const before = deriveLifecycle({ investigation, task: { status: 'verified_fixed', fixHistory: [old] } });
  assert.deepEqual([before.fixApplied, before.fixVerified], [false, false], 'an old fix says nothing about what this investigation found');
  const writeAfter = { fixApplied: { externalWrite: { system: 'wordpress', field: 'canonical', writtenAt: new Date('2026-10-21T13:00:00Z') } }, verification: { verifiedAt: new Date('2026-10-21T12:30:00Z'), result: 'verified_fixed' } };
  const stale = deriveLifecycle({ investigation, task: { status: 'verified_fixed', fixHistory: [writeAfter] } });
  assert.deepEqual([stale.fixApplied, stale.fixVerified], [true, false], 'verification that predates the write is not evidence for it');
});

// ── HTTP: real Express, real controller, fake auth + fake deps ────────────────────────────
async function withServer(fn, { llmDelayMs = 0 } = {}) {
  const deps = makeDeps({ fetcher: fakeFetcher({ [PAGE]: { body: page({ body: VISIBLE_CRUMBS }) }, [`${SITE}/`]: { body: page() }, [`${SITE}/services`]: { body: page() } }), llm: fakeLlm([async () => { if (llmDelayMs) await new Promise((r) => setTimeout(r, llmDelayMs)); return { text: JSON.stringify(goodAnswer()), tokens: {} }; }]), resolveCapabilities: async () => ELIGIBLE });
  const runner = new InvestigationRunner(deps);
  const lifecycle = createLifecycleService({ store: deps.store, loadTask: async () => null, startVerification: async () => ({ success: false, code: 'NOT_FOUND', message: 'nope' }) });
  const ctrl = createInvestigationController({ runner, lifecycle, store: deps.store });
  const app = express();
  app.use(express.json());
  // Stand-in for auth + validateProjectAccess: the caller header chooses WHICH project they own.
  app.use((req, _res, next) => { const pid = req.headers['x-owned-project']; req.userId = 'u'; req.project = pid === PROJECT.id ? { _id: PROJECT.id, main_url: PROJECT.siteUrl } : { _id: pid, main_url: 'https://other-tenant.example/' }; req.projectId = pid; next(); });
  app.post('/investigations', ctrl.start);
  app.get('/investigations/:investigationId', ctrl.get);
  app.post('/investigations/:investigationId/cancel', ctrl.cancel);
  app.post('/investigations/:investigationId/verify', ctrl.verify);
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { owner = PROJECT.id, body } = {}) => {
    const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', 'x-owned-project': owner }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json() };
  };
  try { await fn({ call, runner, deps }); } finally { await new Promise((r) => server.close(r)); }
}

test('HTTP: start -> 202 with a client-safe view; poll to completion; prompt/raw page data are never exposed', async () => {
  await withServer(async ({ call, runner }) => {
    const started = await call('POST', '/investigations', { body: { projectId: PROJECT.id, issueId: 'breadcrumblist_schema', pageUrl: PAGE, ruleMetadata: { title: 'BreadcrumbList missing', category: 'Structured Data' } } });
    assert.equal(started.status, 202);
    assert.equal(started.json.meta.joinedExisting, false);
    const id = started.json.data.id;
    await waitFor(runner, id);
    const done = await call('GET', `/investigations/${id}?projectId=${PROJECT.id}`);
    assert.equal(done.status, 200);
    assert.equal(done.json.data.status, 'completed');
    assert.equal(done.json.data.result.automaticFixEligibility.eligible, true);
    assert.equal(done.json.data.result.lifecycle.fixApplied, false);
    const text = JSON.stringify(done.json);
    assert.ok(!text.includes('untrusted_evidence'), 'no prompt text');
    assert.ok(!('requestKey' in done.json.data) && !('userId' in done.json.data));
    // A second click while finished starts fresh; a click while running joins.
  });
});

test('HTTP: cross-project access is a plain 404 for read, cancel and verify; starting on a foreign page is 422', async () => {
  await withServer(async ({ call, runner }) => {
    const started = await call('POST', '/investigations', { body: { projectId: PROJECT.id, issueId: 'breadcrumblist_schema', pageUrl: PAGE } });
    const id = started.json.data.id;
    await waitFor(runner, id);
    const other = '64b0000000000000000000ff';
    assert.equal((await call('GET', `/investigations/${id}?projectId=${other}`, { owner: other })).status, 404);
    assert.equal((await call('POST', `/investigations/${id}/cancel`, { owner: other, body: { projectId: other } })).status, 404);
    assert.equal((await call('POST', `/investigations/${id}/verify`, { owner: other, body: { projectId: other } })).status, 404);
    const foreign = await call('POST', '/investigations', { owner: other, body: { projectId: other, issueId: 'breadcrumblist_schema', pageUrl: PAGE } });
    assert.equal(foreign.status, 422);
    assert.equal(foreign.json.code, 'OUT_OF_SCOPE');
    // The owner still sees their record untouched.
    assert.equal((await call('GET', `/investigations/${id}?projectId=${PROJECT.id}`)).json.data.status, 'completed');
  });
});

test('HTTP: bad input -> 400/422 with a stable code; verify refusal is relayed, never reported as success', async () => {
  await withServer(async ({ call, runner }) => {
    assert.equal((await call('POST', '/investigations', { body: { projectId: PROJECT.id, issueId: '', pageUrl: PAGE } })).status, 400);
    assert.equal((await call('POST', '/investigations', { body: { projectId: PROJECT.id, issueId: 'x', pageUrl: 'javascript:alert(1)' } })).status, 400);
    const started = await call('POST', '/investigations', { body: { projectId: PROJECT.id, issueId: 'breadcrumblist_schema', pageUrl: PAGE } });
    await waitFor(runner, started.json.data.id);
    const v = await call('POST', `/investigations/${started.json.data.id}/verify`, { body: { projectId: PROJECT.id } });
    assert.equal(v.status, 422);
    assert.equal(v.json.success, false);
  });
});

test('HTTP: simultaneous identical starts return the same investigation (joinedExisting)', async () => {
  await withServer(async ({ call, runner }) => {
    const body = { projectId: PROJECT.id, issueId: 'breadcrumblist_schema', pageUrl: PAGE };
    const res = await Promise.all([call('POST', '/investigations', { body }), call('POST', '/investigations', { body }), call('POST', '/investigations', { body })]);
    assert.equal(new Set(res.map((r) => r.json.data.id)).size, 1);
    assert.equal(res.filter((r) => r.json.meta.joinedExisting).length, 2);
    await waitFor(runner, res[0].json.data.id);
  }, { llmDelayMs: 200 });
});

test('toView: hides internals and merges the derived lifecycle over the stored one', () => {
  const v = toView({ _id: 'x', projectId: 'p', userId: 'u', requestKey: 'k', issueId: 'i', pageUrl: 'u', status: 'completed', result: { summary: 's', lifecycle: { fixApplied: false } }, evidenceTrace: [{ id: 'E1' }] }, { fixApplied: true });
  assert.equal(v.result.lifecycle.fixApplied, true);
  assert.ok(!('projectId' in v) && !('userId' in v) && !('requestKey' in v));
});
