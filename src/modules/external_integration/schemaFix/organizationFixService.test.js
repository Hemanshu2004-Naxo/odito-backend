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
import { applyImageProbes, buildSchemaEvidence } from '../../schema-evidence/schemaEvidence.js';
import { analyzeSiteEntity } from '../../schema-evidence/siteEntity.js';
import { HOME, ORIGIN, REAL_LOGO, probeOk } from '../../schema-evidence/__fixtures__/clinicSite.js';
import { hospitalSitePages, page } from '../../schema-evidence/__fixtures__/hospitalSite.js';

/**
 * The Organization fix end to end against a STATEFUL fake of the Odito SEO Bridge (it enforces the same compare-and-set the
 * real Bridge does) and a live local Mongo for the audit record (auto-skipped when unreachable). Nothing here touches a
 * real WordPress site: the Bridge, the crawl evidence and the task history are doubles.
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

const logoImages = [{ src: REAL_LOGO, alt: 'Clinic logo' }];
const noHome = () => hospitalSitePages().filter((p) => p.url !== `${ORIGIN}/`);

function evidenceOf({ pages = [], probes = [probeOk(REAL_LOGO)], structured_data = [], pageType = 'homepage', path = '/' } = {}) {
  const pd = page(path, structured_data, { meta_tags: { 'og:site_name': ['Clinic Eye Centre'] }, images: logoImages });
  return applyImageProbes(buildSchemaEvidence({ issueId: 'organization_schema', pageUrl: pd.url, pageData: pd, pageType, site: analyzeSiteEntity(pages), profile: null }), probes);
}

/** A Bridge double with real compare-and-set semantics, call recording and fault injection. */
function makeBridge(initial = {}) {
  const state = { name: '', description: '', url: '', logo: '', type: '', kind: 'company', hasAddress: true, localSeoActive: true, ...initial };
  const b = {
    state, writes: [], status: { installed: true, provider: 'rank_math', siteSchemaSupported: true, organizationTypeSupported: true, conditionalWritesSupported: true, bridgeVersion: '1.5.0' },
    failOn: null, failWith: null, humanEditsBefore: {}, readbackLies: false,
    // fault injection: { field, mode: 'throw' | 'commit_then_throw', error, times }
    faults: [], unreadable: false, reportOperation: true, dropWrites: false, // dropWrites: answers 200 but stores nothing
    async getBridgeStatus() { return b.status; },
    async getSiteSchema() {
      if (b.unreadable) throw new WordPressConnectionError('TIMEOUT', 'The WordPress site took too long to respond.', 504);
      const org = { ...state };
      if (b.readbackLies && b.writes.length > 0) org.name = 'something else';
      return { provider: 'rank_math', organization: org, breadcrumbs: { enabled: false } };
    },
    async updateSiteSchemaField(_c, entity, field, value, op, { expected } = {}) {
      b.writes.push({ entity, field, value, op, expected });
      if (b.humanEditsBefore[field] !== undefined) { state[field] = b.humanEditsBefore[field]; delete b.humanEditsBefore[field]; }
      if (b.failOn === field) throw (b.failWith || new WordPressConnectionError('WRITE_FAILED', 'Failed to write this change to WordPress.', 502));
      if (expected !== undefined && state[field] !== expected) throw new WordPressConnectionError('CONFLICT', 'changed', 409);
      const fault = b.faults.find((f) => f.field === field && (f.times ?? 1) > 0);
      if (fault) {
        fault.times = (fault.times ?? 1) - 1;
        if (fault.mode === 'commit_then_throw') state[field] = op === 'clear' ? '' : value; // WordPress saved it, the answer never arrived
        if (fault.then) fault.then();
        throw fault.error;
      }
      if (!b.dropWrites) state[field] = op === 'clear' ? '' : value;
      return { provider: 'rank_math', operation: b.reportOperation ? { id: `op-${b.writes.length}`, atomic: true, alreadyApplied: false, created: false, attempts: 1 } : null, organization: { ...state } };
    },
  };
  return b;
}

let seq = 0;
function world({ bridgeInit, evidence = evidenceOf(), rendered } = {}) {
  const projectId = new mongoose.Types.ObjectId();
  projectIds.push(projectId);
  const bridge = makeBridge(bridgeInit);
  const connectionId = new mongoose.Types.ObjectId();
  const task = {
    _id: new mongoose.Types.ObjectId(), projectId, issueKey: 'organization_schema', pageUrl: `${ORIGIN}/`, status: 'task_created',
    recommendationId: new mongoose.Types.ObjectId(), fixHistory: [], saves: 0,
    async save() { this.saves += 1; },
  };
  const deps = {
    wordPressService: { getHydratedConnectionOrThrow: async () => ({ _id: connectionId, site_url: ORIGIN, application_password: 'secret' }) },
    bridge,
    collectEvidence: async () => evidence,
    taskHistory: { applyImplementedTransition: async (t, { externalWrite } = {}) => { t.status = 'implemented'; t.fixHistory.push({ n: ++seq, fixApplied: { externalWrite } }); } },
    loadPageDoc: async () => rendered?.pageDoc || null,
    loadSite: async () => analyzeSiteEntity(rendered?.pages || []),
    verifyRendered: async () => rendered?.inspection || { status: 'unverifiable', reasons: ['The page has not been re-crawled since the fix was applied.'] },
  };
  return { task, bridge, deps, projectId };
}

const fingerprintOf = async (w) => (await getOrganizationFixPreview(w.task, w.deps)).plan.fingerprint;
const apply = async (w, over = {}) => applyOrganizationFix(w.task, { approved: true, expectedPlanFingerprint: await fingerprintOf(w), actorId: new mongoose.Types.ObjectId(), ...over }, w.deps);

beforeEach(() => {
  mock.restoreAll();
  mock.method(Recommendation, 'findById', () => ({ select: () => ({ lean: async () => ({ projectId: currentProject }) }) }));
});
let currentProject;
const withProject = (w) => { currentProject = w.projectId; return w; };

const skip = (t) => { if (!mongoAvailable) { t.skip('local MongoDB not reachable'); return true; } return false; };

describe('preview — the typed fix contract (read-only)', () => {
  test('exposes intent, evidence, exact changes, before/expected-after state, validation, lifecycle — and writes NOTHING', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    const p = await getOrganizationFixPreview(w.task, w.deps);

    assert.equal(p.fixType, 'organization_schema');
    assert.equal(p.scope, 'site');
    assert.equal(p.targetUrl, `${ORIGIN}/`);
    assert.equal(p.schemaIntent.type, 'Organization');
    assert.deepEqual(p.proposedChanges.map((c) => c.field), ['name', 'logo']);
    assert.deepEqual(p.beforeState, { name: '', logo: '', type: '', kind: 'company', hasAddress: true, address: '', addressLabel: '', localSeoActive: true });
    assert.deepEqual(p.expectedAfterState, { name: 'Clinic Eye Centre', logo: REAL_LOGO, type: '', address: '', addressLabel: '' });
    assert.equal(p.validation.valid, true);
    assert.equal(p.lifecycle, 'awaiting_approval');
    assert.equal(p.approvalStatus, 'awaiting_approval');
    assert.deepEqual(p.verificationStatus, { saved: 'pending', rendered: 'pending' });
    assert.equal(p.source.provider, 'rank_math');
    assert.deepEqual(p.source.writes, ['rank-math-options-titles.knowledgegraph_name', 'rank-math-options-titles.knowledgegraph_logo']);
    assert.equal(p.idempotencyKey.length, 64);
    assert.equal(w.bridge.writes.length, 0, 'a preview never writes');
    assert.equal(await WordPressFixRecord.countDocuments({ taskId: w.task._id }), 0, 'nor creates a record');
  });

  test('an unsupported or blocked situation is reported as such, with the reason, and offers nothing to approve', async (t) => {
    if (skip(t)) return;
    const person = withProject(world({ bridgeInit: { kind: 'person' } }));
    const p = await getOrganizationFixPreview(person.task, person.deps);
    assert.equal(p.lifecycle, 'unsupported');
    assert.equal(p.plan.code, 'SITE_IS_PERSON');
    assert.equal(p.approvalStatus, 'not_available');

    const hospital = withProject(world({ evidence: evidenceOf({ pages: noHome() }), bridgeInit: { name: 'Clinic Eye Centre', logo: REAL_LOGO, hasAddress: false } }));
    const h = await getOrganizationFixPreview(hospital.task, hospital.deps);
    assert.equal(h.plan.status, 'blocked');
    assert.equal(h.plan.blocked[0].code, 'ADDRESS_REQUIRED');
    assert.equal(h.approvalStatus, 'not_available');
  });

  test("a specific type the site already has is preserved: the name can still be applied, the expected entity shows the real type, and the preserved type is not 'invalid'", async (t) => {
    if (skip(t)) return;
    const w = withProject(world({ evidence: evidenceOf({ pages: noHome() }), bridgeInit: { type: 'Dentist', hasAddress: true } }));
    const p = await getOrganizationFixPreview(w.task, w.deps);
    assert.deepEqual(p.proposedChanges.map((c) => c.field), ['name', 'logo']);
    assert.equal(p.plan.preserved[0].field, 'type');
    assert.equal(p.validation.valid, true, p.validation.errors.join(' | '));
    assert.deepEqual(p.expectedEntity['@type'], ['Dentist', 'Organization']);
    assert.equal(p.lifecycle, 'awaiting_approval');
  });

  test('an outdated or missing Bridge fails explicitly (never a silent no-op)', async (t) => {
    if (skip(t)) return;
    const old = withProject(world());
    old.bridge.status = { installed: true, provider: 'rank_math', siteSchemaSupported: true, organizationTypeSupported: false, bridgeVersion: '1.3.1' };
    await assert.rejects(getOrganizationFixPreview(old.task, old.deps), (e) => e.code === 'FIELD_NOT_WRITABLE' && /1\.4\.0/.test(e.message) && e.details.reason === 'bridge_outdated');
    const none = withProject(world());
    none.bridge.status = { installed: false, provider: 'none' };
    await assert.rejects(getOrganizationFixPreview(none.task, none.deps), (e) => e.code === 'FIELD_NOT_WRITABLE' && e.details.reason === 'bridge_not_installed');
  });
});

describe('apply — approval, fingerprint, compare-and-set, saved-state verification', () => {
  test('applies exactly the previewed fields, records before/after + actor, reads back, and NEVER marks the task verified', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    const actorId = new mongoose.Types.ObjectId();
    const r = await apply(w, { actorId });

    assert.deepEqual(w.bridge.writes.map((x) => [x.field, x.value, x.expected]), [['name', 'Clinic Eye Centre', ''], ['logo', REAL_LOGO, '']]);
    assert.equal(w.bridge.state.name, 'Clinic Eye Centre');
    assert.equal(r.alreadyApplied, false);
    assert.equal(r.immediateVerification, 'success');
    assert.equal(r.fix.status, 'applied', 'applied — NOT verified: only the crawler can say the page renders it');
    assert.equal(r.fix.verification.saved.status, 'verified');
    assert.equal(r.fix.verification.rendered.status, 'pending');
    assert.equal(w.task.status, 'implemented');
    assert.notEqual(w.task.status, 'verified_fixed');
    assert.ok(w.task.saves >= 1);

    const rec = await WordPressFixRecord.findOne({ taskId: w.task._id });
    assert.equal(String(rec.approvedBy), String(actorId));
    assert.deepEqual(rec.changes.map((c) => [c.field, c.before, c.after, c.applied]), [['name', '', 'Clinic Eye Centre', true], ['logo', '', REAL_LOGO, true]]);
    assert.equal(rec.scope, 'site');
  });

  test('without explicit approval or without the previewed fingerprint nothing is written', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    await assert.rejects(applyOrganizationFix(w.task, { approved: false, expectedPlanFingerprint: await fingerprintOf(w) }, w.deps), (e) => e.code === 'WRITE_FAILED' && e.statusCode === 400);
    await assert.rejects(applyOrganizationFix(w.task, { approved: true }, w.deps), (e) => e.code === 'EXPECTED_STATE_REQUIRED');
    await assert.rejects(applyOrganizationFix(w.task, { approved: true, expectedPlanFingerprint: 'nope' }, w.deps), (e) => e.code === 'EXPECTED_STATE_REQUIRED');
    assert.equal(w.bridge.writes.length, 0);
    assert.equal(w.task.status, 'task_created');
  });

  test('CONFLICT: the live settings changed after the preview -> 409, nothing written, the current fingerprint is returned', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    const stale = await fingerprintOf(w);
    w.bridge.state.name = 'Edited by an editor in WordPress';
    await assert.rejects(applyOrganizationFix(w.task, { approved: true, expectedPlanFingerprint: stale }, w.deps), (e) => e.code === 'CONFLICT' && e.statusCode === 409 && e.details.reason === 'preview_stale' && e.details.currentFingerprint !== stale);
    assert.equal(w.bridge.writes.length, 0);
  });

  test('a human edit BETWEEN the preview and a write is never overwritten: the field is refused, written fields are restored, status conflict_detected', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    const fp = await fingerprintOf(w);
    w.bridge.humanEditsBefore.logo = 'https://clinic.example/editor-chose-this.png';
    await assert.rejects(applyOrganizationFix(w.task, { approved: true, expectedPlanFingerprint: fp }, w.deps), (e) => e.code === 'CONFLICT');

    assert.equal(w.bridge.state.logo, 'https://clinic.example/editor-chose-this.png', 'the editor\'s value is intact');
    assert.equal(w.bridge.state.name, '', 'the field Odito had already written is put back');
    const rec = await WordPressFixRecord.findOne({ taskId: w.task._id });
    assert.equal(rec.status, 'conflict_detected');
    assert.deepEqual([...rec.rollback.restoredFields], ['name']);
    assert.equal(w.task.status, 'task_created', 'the task is not implemented by a failed fix');
  });

  test('PARTIAL write failure: fields already written are restored; the record says apply_failed; the task is untouched', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    const fp = await fingerprintOf(w);
    w.bridge.failOn = 'logo';
    await assert.rejects(applyOrganizationFix(w.task, { approved: true, expectedPlanFingerprint: fp }, w.deps), (e) => e.code === 'WRITE_FAILED' && e.details.restoredFields.join() === 'name');
    assert.equal(w.bridge.state.name, '');
    const rec = await WordPressFixRecord.findOne({ taskId: w.task._id });
    assert.equal(rec.status, 'apply_failed');
    assert.equal(rec.failure.code, 'WRITE_FAILED');
    assert.equal(w.task.status, 'task_created');
  });

  test('permission denied from WordPress is recorded as permission_denied and rolled back', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    const fp = await fingerprintOf(w);
    w.bridge.failOn = 'name';
    w.bridge.failWith = new WordPressConnectionError('PERMISSION_DENIED', 'You do not have permission to change site-wide SEO settings.', 403);
    await assert.rejects(applyOrganizationFix(w.task, { approved: true, expectedPlanFingerprint: fp }, w.deps), (e) => e.code === 'PERMISSION_DENIED' && e.statusCode === 403);
    assert.equal((await WordPressFixRecord.findOne({ taskId: w.task._id })).status, 'permission_denied');
  });

  test('SAVED-state mismatch (WordPress answered 200 but does not hold the value): verification_failed, not verified, and the same mutation is not repeated', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    const fp = await fingerprintOf(w);
    w.bridge.readbackLies = true;
    const r = await applyOrganizationFix(w.task, { approved: true, expectedPlanFingerprint: fp }, w.deps);
    assert.equal(r.immediateVerification, 'failed');
    assert.equal(r.fix.status, 'verification_failed');
    assert.match(r.fix.verification.saved.reasons.join(' '), /name: WordPress holds/);
    const writesAfterFirst = w.bridge.writes.length;
    // Same plan again (the same fingerprint) is an idempotent no-op, not a second mutation.
    const again = await applyOrganizationFix(w.task, { approved: true, expectedPlanFingerprint: fp }, w.deps).catch((e) => e);
    assert.equal(w.bridge.writes.length, writesAfterFirst);
    assert.ok(again.alreadyApplied === true || again instanceof WordPressConnectionError);
  });

  test('IDEMPOTENCY: two simultaneous identical requests execute the writes exactly once', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    const fp = await fingerprintOf(w);
    const results = await Promise.allSettled([
      applyOrganizationFix(w.task, { approved: true, expectedPlanFingerprint: fp }, w.deps),
      applyOrganizationFix(w.task, { approved: true, expectedPlanFingerprint: fp }, w.deps),
    ]);
    assert.equal(w.bridge.writes.filter((x) => x.field === 'name').length, 1);
    assert.equal(w.bridge.writes.filter((x) => x.field === 'logo').length, 1);
    assert.equal(await WordPressFixRecord.countDocuments({ taskId: w.task._id }), 1);
    assert.ok(results.some((r) => r.status === 'fulfilled'));
  });

  test('a re-request after the settings already hold the values is refused as a stale preview, never re-written', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    const fp = await fingerprintOf(w);
    await applyOrganizationFix(w.task, { approved: true, expectedPlanFingerprint: fp }, w.deps);
    const writes = w.bridge.writes.length;
    w.task.status = 'task_created';
    await assert.rejects(applyOrganizationFix(w.task, { approved: true, expectedPlanFingerprint: fp }, w.deps), (e) => e.code === 'CONFLICT');
    assert.equal(w.bridge.writes.length, writes);
  });

  test('a stale in-flight record (a crashed earlier attempt) does not block a fresh attempt of the same plan', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    const fp = await fingerprintOf(w);
    const { idempotencyKeyFor } = await import('./organizationFixService.js');
    await WordPressFixRecord.create({
      projectId: w.projectId, connectionId: new mongoose.Types.ObjectId(), taskId: w.task._id, fixType: 'organization_schema', targetUrl: w.task.pageUrl,
      planFingerprint: fp, idempotencyKey: idempotencyKeyFor(w.task._id, fp), status: 'applying',
    });
    await WordPressFixRecord.collection.updateOne({ taskId: w.task._id }, { $set: { updatedAt: new Date(Date.now() - 10 * 60 * 1000) } });
    const r = await applyOrganizationFix(w.task, { approved: true, expectedPlanFingerprint: fp }, w.deps);
    assert.equal(r.fix.status, 'applied');
    // …but a FRESH in-flight one does block it
    const w2 = withProject(world());
    const fp2 = await fingerprintOf(w2);
    await WordPressFixRecord.create({
      projectId: w2.projectId, connectionId: new mongoose.Types.ObjectId(), taskId: w2.task._id, fixType: 'organization_schema', targetUrl: w2.task.pageUrl,
      planFingerprint: fp2, idempotencyKey: idempotencyKeyFor(w2.task._id, fp2), status: 'applying',
    });
    await assert.rejects(applyOrganizationFix(w2.task, { approved: true, expectedPlanFingerprint: fp2 }, w2.deps), (e) => e.details?.reason === 'fix_in_progress');
    assert.equal(w2.bridge.writes.length, 0);
  });

  test('guards: a task that cannot move to implemented, a cross-project recommendation, a different issue type, and an unsupported plan are all refused before any write', async (t) => {
    if (skip(t)) return;
    const done = withProject(world());
    done.task.status = 'verified_fixed';
    await assert.rejects(applyOrganizationFix(done.task, { approved: true, expectedPlanFingerprint: 'a'.repeat(64) }, done.deps), (e) => e.code === 'CONFLICT');

    const cross = world();
    currentProject = new mongoose.Types.ObjectId(); // the linked recommendation belongs to ANOTHER project
    await assert.rejects(applyOrganizationFix(cross.task, { approved: true, expectedPlanFingerprint: 'a'.repeat(64) }, cross.deps), (e) => e.code === 'RECOMMENDATION_REQUIRED');

    const other = withProject(world());
    other.task.issueKey = 'title_missing';
    await assert.rejects(applyOrganizationFix(other.task, { approved: true, expectedPlanFingerprint: 'a'.repeat(64) }, other.deps), (e) => e.code === 'FIELD_NOT_WRITABLE');

    const person = withProject(world({ bridgeInit: { kind: 'person' } }));
    await assert.rejects(applyOrganizationFix(person.task, { approved: true, expectedPlanFingerprint: await fingerprintOf(person) }, person.deps), (e) => e.code === 'FIELD_NOT_WRITABLE' && e.details.reason === 'SITE_IS_PERSON');
    for (const w of [done, cross, other, person]) assert.equal(w.bridge.writes.length, 0);
  });

  test('the Hospital type upgrade is applied only with a configured address; the write goes to the typed `type` field', async (t) => {
    if (skip(t)) return;
    const w = withProject(world({ evidence: evidenceOf({ pages: noHome() }), bridgeInit: { name: 'Clinic Eye Centre', logo: REAL_LOGO, hasAddress: true } }));
    const r = await apply(w);
    assert.deepEqual(w.bridge.writes.map((x) => [x.field, x.value]), [['type', 'Hospital']]);
    assert.equal(r.fix.status, 'applied');
    assert.equal(w.bridge.state.type, 'Hospital');
  });
});

describe('rollback — only what Odito wrote, never a newer edit', () => {
  test('restores previous values (empty fields are cleared with compare-and-set) and marks the fix rolled_back', async (t) => {
    if (skip(t)) return;
    const w = withProject(world({ bridgeInit: { name: '', logo: '' } }));
    await apply(w);
    const out = await rollbackOrganizationFix(w.task, { actorId: new mongoose.Types.ObjectId() }, w.deps);
    assert.equal(w.bridge.state.name, '');
    assert.equal(w.bridge.state.logo, '');
    assert.equal(out.fix.status, 'rolled_back');
    assert.equal(out.fix.rollback.status, 'verified', 'restored AND read back from WordPress');
    assert.equal(out.fix.rollback.saved.status, 'verified');
    const clears = w.bridge.writes.filter((x) => x.op === 'clear');
    assert.deepEqual(clears.map((c) => [c.field, c.expected]).sort(), [['logo', REAL_LOGO], ['name', 'Clinic Eye Centre']]);
  });

  test('a field edited by a person AFTER the fix is left as the person set it (partial_conflict); the others are restored', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    await apply(w);
    w.bridge.state.logo = 'https://clinic.example/newer-logo.png';
    const out = await rollbackOrganizationFix(w.task, {}, w.deps);
    assert.equal(w.bridge.state.logo, 'https://clinic.example/newer-logo.png');
    assert.equal(w.bridge.state.name, '');
    assert.equal(out.fix.rollback.status, 'partial_conflict');
    assert.deepEqual(out.fix.rollback.conflictFields, ['logo']);
    assert.match(out.message, /logo was changed after Odito wrote it/);
    assert.notEqual(out.fix.status, 'rolled_back');
  });

  test('nothing to roll back -> a clear error; rolling back twice is not possible', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    await assert.rejects(rollbackOrganizationFix(w.task, {}, w.deps), (e) => e.statusCode === 404);
    await apply(w);
    await rollbackOrganizationFix(w.task, {}, w.deps);
    await assert.rejects(rollbackOrganizationFix(w.task, {}, w.deps), (e) => e.statusCode === 404);
  });
});

describe('reverify — saved WordPress state and the rendered page are reported SEPARATELY', () => {
  test('saved ok but the crawl predates the write -> saved verified, rendered unverifiable (cache/recrawl pending), fix stays applied', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    await apply(w);
    const r = await reverifyOrganizationFix(w.task, w.deps);
    assert.equal(r.fix.verification.saved.status, 'verified');
    assert.equal(r.fix.verification.rendered.status, 'unverifiable');
    assert.match(r.fix.verification.rendered.reasons.join(' '), /re-crawled/);
    assert.equal(r.fix.status, 'applied');
  });

  test('saved ok AND the rendered entity checks out -> verified; the two parts each carry their own evidence', async (t) => {
    if (skip(t)) return;
    const w = withProject(world({ rendered: { inspection: { status: 'verified', reasons: [] }, pageDoc: { scraped_at: new Date() } } }));
    await apply(w);
    const r = await reverifyOrganizationFix(w.task, w.deps);
    assert.equal(r.fix.verification.saved.status, 'verified');
    assert.equal(r.fix.verification.rendered.status, 'verified');
    assert.ok(r.fix.verification.rendered.crawledAt);
    assert.equal(r.fix.status, 'verified');
  });

  test('saved ok but the rendered page is wrong (e.g. a cache or theme override) -> verification_failed with the rendered reasons', async (t) => {
    if (skip(t)) return;
    const w = withProject(world({ rendered: { inspection: { status: 'failed', reasons: ['The deployed entity is typed Organization but the recommendation was Hospital.'] }, pageDoc: { scraped_at: new Date() } } }));
    await apply(w);
    const r = await reverifyOrganizationFix(w.task, w.deps);
    assert.equal(r.fix.verification.saved.status, 'verified');
    assert.equal(r.fix.verification.rendered.status, 'failed');
    assert.equal(r.fix.status, 'verification_failed');
  });

  test('a WordPress setting that no longer holds the value is a saved-state failure even when the page still looks right', async (t) => {
    if (skip(t)) return;
    const w = withProject(world({ rendered: { inspection: { status: 'verified', reasons: [] }, pageDoc: { scraped_at: new Date() } } }));
    await apply(w);
    w.bridge.state.name = 'Changed later';
    const r = await reverifyOrganizationFix(w.task, w.deps);
    assert.equal(r.fix.verification.saved.status, 'failed');
    assert.equal(r.fix.status, 'verification_failed');
  });

  test('before any apply there is nothing to verify', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    await assert.rejects(reverifyOrganizationFix(w.task, w.deps), (e) => e.statusCode === 404);
  });
});

// ── Reliability hardening: ambiguity, crash recovery, staged rollback, approval binding ───────────────────────────────────

const timeout = () => new WordPressConnectionError('TIMEOUT', 'The WordPress site took too long to respond.', 504);
const recordOf = (w) => WordPressFixRecord.findOne({ taskId: w.task._id });

/** A record exactly as a crashed process would have left it: planned, approved, partly written. */
async function seedRecord(w, { status = 'applying', landed = [], inFlight = [], ageMs = 10 * 60 * 1000, approvedAgoMs = 60 * 1000, rollback = null, restored = [] } = {}) {
  const preview = await getOrganizationFixPreview(w.task, w.deps);
  const { idempotencyKeyFor } = await import('./organizationFixService.js');
  const doc = await WordPressFixRecord.create({
    projectId: w.projectId, connectionId: new mongoose.Types.ObjectId(), taskId: w.task._id, fixType: 'organization_schema', targetUrl: w.task.pageUrl,
    provider: 'rank_math', scope: 'site', planFingerprint: preview.plan.fingerprint, idempotencyKey: idempotencyKeyFor(w.task._id, preview.plan.fingerprint),
    status, approvedAt: new Date(Date.now() - approvedAgoMs),
    appliedAt: ['applied', 'rolled_back'].includes(status) ? new Date(Date.now() - 120000) : null,
    changes: preview.plan.changes.map((c) => ({
      field: c.field, before: c.before, after: c.after, source: c.source,
      applied: landed.includes(c.field), restored: restored.includes(c.field),
      writeState: landed.includes(c.field) ? 'landed' : (inFlight.includes(c.field) ? 'in_flight' : 'pending'),
    })),
    ...(rollback ? { rollback } : {}),
  });
  await WordPressFixRecord.collection.updateOne({ _id: doc._id }, { $set: { updatedAt: new Date(Date.now() - ageMs) } });
  return { fp: preview.plan.fingerprint, id: doc._id };
}

describe('ambiguous write outcomes are reconciled against WordPress, never repeated blindly', () => {
  test('timeout AFTER WordPress saved the value: the live value is read, the write is NOT repeated, and it is attributed as reconciled', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    w.bridge.faults.push({ field: 'name', mode: 'commit_then_throw', error: timeout() });
    const r = await apply(w);
    assert.equal(w.bridge.writes.filter((x) => x.field === 'name').length, 1, 'name was sent exactly once');
    assert.equal(w.bridge.state.name, 'Clinic Eye Centre');
    assert.equal(r.fix.status, 'applied');
    const name = r.fix.changes.find((c) => c.field === 'name');
    assert.equal(name.attribution, 'reconciled');
    assert.equal(name.writeState, 'landed');
    assert.equal(r.fix.changes.find((c) => c.field === 'logo').attribution, 'response');
  });

  test('timeout BEFORE WordPress saved anything: the read shows the old value, so exactly one compare-and-set retry is made', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    w.bridge.faults.push({ field: 'name', mode: 'throw', error: timeout() });
    const r = await apply(w);
    const nameWrites = w.bridge.writes.filter((x) => x.field === 'name');
    assert.equal(nameWrites.length, 2);
    assert.ok(nameWrites.every((x) => x.expected === ''), 'every attempt is conditional on the original value');
    assert.equal(r.fix.status, 'applied');
    assert.equal(r.fix.changes.find((c) => c.field === 'name').attribution, 'response');
  });

  test('retries are bounded: a field that keeps timing out without landing fails after one retry and written fields are put back', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    w.bridge.faults.push({ field: 'logo', mode: 'throw', error: timeout(), times: 10 });
    await assert.rejects(apply(w), (e) => e.code === 'TIMEOUT' && e.details.restoredFields.join() === 'name');
    assert.equal(w.bridge.writes.filter((x) => x.field === 'logo').length, 2);
    assert.equal(w.bridge.state.name, '');
    assert.equal((await recordOf(w)).status, 'apply_failed');
  });

  test('timeout, then someone ELSE changed the field to a third value: reported as a conflict, their value kept, the other fields restored', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    w.bridge.faults.push({ field: 'logo', mode: 'throw', error: timeout(), then: () => { w.bridge.state.logo = 'https://clinic.example/editor.png'; } });
    await assert.rejects(apply(w), (e) => e.code === 'CONFLICT');
    assert.equal(w.bridge.state.logo, 'https://clinic.example/editor.png');
    assert.equal(w.bridge.state.name, '');
    assert.equal((await recordOf(w)).status, 'conflict_detected');
  });

  test('timeout and WordPress cannot be re-read: status apply_uncertain, NOTHING repeated or restored, and the next request reconciles it', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    const fp = await fingerprintOf(w);
    w.bridge.faults.push({ field: 'logo', mode: 'commit_then_throw', error: timeout(), then: () => { w.bridge.unreadable = true; } });
    await assert.rejects(applyOrganizationFix(w.task, { approved: true, expectedPlanFingerprint: fp }, w.deps), (e) => e.code === 'OUTCOME_UNKNOWN' && Boolean(e.details.fixId));
    const rec = await recordOf(w);
    assert.equal(rec.status, 'apply_uncertain');
    assert.equal(rec.failure.code, 'OUTCOME_UNKNOWN');
    assert.equal(w.bridge.writes.filter((x) => x.field === 'logo').length, 1, 'no blind repeat');
    assert.equal(w.bridge.state.name, 'Clinic Eye Centre', 'no restore on a guess');
    assert.equal(w.task.status, 'task_created');

    // WordPress is reachable again: the same approval reconciles the record instead of stalling forever or writing twice.
    w.bridge.unreadable = false;
    const again = await applyOrganizationFix(w.task, { approved: true, expectedPlanFingerprint: fp }, w.deps);
    assert.equal(again.recovered, true);
    assert.equal(again.fix.status, 'applied');
    assert.equal(w.bridge.writes.filter((x) => x.field === 'logo').length, 1, 'still written once');
    assert.equal(w.task.status, 'implemented');
    assert.equal(w.task.fixHistory.length, 1);
    assert.equal(again.fix.changes.find((c) => c.field === 'logo').attribution, 'reconciled');
  });

  test('every write records the Bridge operation id and whether it was a conditional write; an older Bridge is recorded as unknown, never as atomic', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    const r = await apply(w);
    assert.ok(r.fix.changes.every((c) => c.atomic === true && c.writeMode === 'conditional_update'));
    assert.equal((await recordOf(w)).changes[0].operationId, 'op-1');

    const old = withProject(world());
    old.bridge.reportOperation = false;
    old.bridge.status.conditionalWritesSupported = false;
    const p = await getOrganizationFixPreview(old.task, old.deps);
    assert.equal(p.concurrency.writes, 'read_then_write', 'the preview says so plainly');
    const r2 = await apply(old);
    assert.ok(r2.fix.changes.every((c) => c.atomic === null && c.writeMode === 'read_then_write'), 'never claimed atomic when the Bridge did not say so');
    assert.equal((await getOrganizationFixPreview(w.task, w.deps)).concurrency.writes, 'database_conditional');
  });
});

describe('crash recovery: a record left in flight is reconciled before anything else happens to it', () => {
  test('crash after one field landed: the same approval RESUMES and the landed field is not rewritten', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    const { fp } = await seedRecord(w, { landed: [], inFlight: ['name'] });
    w.bridge.state.name = 'Clinic Eye Centre'; // the write committed, the process died before it was recorded
    const r = await applyOrganizationFix(w.task, { approved: true, expectedPlanFingerprint: fp }, w.deps);
    assert.deepEqual(w.bridge.writes.map((x) => x.field), ['logo'], 'only the missing field is written');
    assert.equal(r.fix.status, 'applied');
    assert.equal(r.fix.changes.find((c) => c.field === 'name').attribution, 'reconciled');
    assert.equal(w.task.status, 'implemented');
  });

  test('crash with every field already landed: finished (verification + task) without a single write', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    const { fp } = await seedRecord(w, { inFlight: ['name', 'logo'] });
    w.bridge.state.name = 'Clinic Eye Centre'; w.bridge.state.logo = REAL_LOGO;
    const r = await applyOrganizationFix(w.task, { approved: true, expectedPlanFingerprint: fp }, w.deps);
    assert.equal(w.bridge.writes.length, 0);
    assert.equal(r.recovered, true);
    assert.equal(r.fix.status, 'applied');
    assert.equal(r.fix.verification.saved.status, 'verified');
    assert.equal(w.task.fixHistory.length, 1);
  });

  test('crash before anything was written: the abandoned record is settled and a fresh attempt proceeds normally', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    const { fp } = await seedRecord(w, { inFlight: ['name'] });
    const r = await applyOrganizationFix(w.task, { approved: true, expectedPlanFingerprint: fp }, w.deps);
    assert.equal(r.fix.status, 'applied');
    assert.equal(await WordPressFixRecord.countDocuments({ taskId: w.task._id }), 1, 'the same ledger row is reused');
  });

  test('an OLD approval is not resumed: the written field is put back first (compare-and-set), and only this request approval proceeds', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    const { fp } = await seedRecord(w, { inFlight: ['name'], approvedAgoMs: 3 * 60 * 60 * 1000 });
    w.bridge.state.name = 'Clinic Eye Centre';
    const r = await applyOrganizationFix(w.task, { approved: true, expectedPlanFingerprint: fp }, w.deps);
    const nameWrites = w.bridge.writes.filter((x) => x.field === 'name');
    assert.equal(nameWrites[0].op, 'clear', 'restored first');
    assert.equal(nameWrites[0].expected, 'Clinic Eye Centre');
    assert.equal(r.fix.status, 'applied');
  });

  test('crash while someone else edited another field: nothing is overwritten, the Odito field is put back, the record says conflict', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    const { fp } = await seedRecord(w, { inFlight: ['name', 'logo'] });
    w.bridge.state.name = 'Clinic Eye Centre';
    w.bridge.state.logo = 'https://clinic.example/editor.png';
    await assert.rejects(applyOrganizationFix(w.task, { approved: true, expectedPlanFingerprint: fp }, w.deps), (e) => e.code === 'CONFLICT');
    assert.equal(w.bridge.state.logo, 'https://clinic.example/editor.png');
    assert.equal(w.bridge.state.name, '');
  });

  test('a record that is still fresh is never touched (a parallel request is a conflict, not a second writer)', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    const { fp } = await seedRecord(w, { inFlight: ['name'], ageMs: 1000 });
    await assert.rejects(applyOrganizationFix(w.task, { approved: true, expectedPlanFingerprint: fp }, w.deps), (e) => e.details?.reason === 'fix_in_progress');
    assert.equal(w.bridge.writes.length, 0);
  });

  test('crash between "applied" and the task update: Re-verify finishes the task bookkeeping exactly once', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    await seedRecord(w, { status: 'applied', landed: ['name', 'logo'] });
    w.bridge.state.name = 'Clinic Eye Centre'; w.bridge.state.logo = REAL_LOGO;
    assert.equal(w.task.status, 'task_created');
    await reverifyOrganizationFix(w.task, w.deps);
    await reverifyOrganizationFix(w.task, w.deps);
    assert.equal(w.task.status, 'implemented');
    assert.equal(w.task.fixHistory.length, 1);
  });

  test('Re-verify also reconciles an abandoned apply instead of reporting on a half-known state', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    await seedRecord(w, { status: 'apply_uncertain', inFlight: ['name', 'logo'] });
    w.bridge.state.name = 'Clinic Eye Centre'; w.bridge.state.logo = REAL_LOGO;
    const out = await reverifyOrganizationFix(w.task, w.deps);
    assert.equal(out.fix.status, 'applied');
    assert.equal(w.bridge.writes.length, 0);
  });
});

describe('rollback: staged, resumable, idempotent', () => {
  test('rollback is requested, applied, then verified against the saved settings, and states which stage it reached', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    await apply(w);
    const out = await rollbackOrganizationFix(w.task, { actorId: new mongoose.Types.ObjectId() }, w.deps);
    assert.equal(out.fix.rollback.status, 'verified');
    assert.deepEqual([...out.fix.rollback.restoredFields].sort(), ['logo', 'name']);
    assert.ok(out.fix.rollback.requestedAt);
    assert.deepEqual(out.fix.changes.map((c) => c.restored), [true, true]);
  });

  test('restored in WordPress but the read-back disagrees: the rollback is "applied", NOT "verified"', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    await apply(w);
    w.bridge.dropWrites = true; // WordPress answers 200 to the restore but keeps the Odito value
    const out = await rollbackOrganizationFix(w.task, {}, w.deps);
    assert.equal(out.fix.rollback.status, 'applied');
    assert.equal(out.fix.rollback.saved.status, 'failed');
    assert.match(out.fix.rollback.saved.reasons.join(' '), /instead of the restored/);
    w.bridge.state.name = ''; w.bridge.state.logo = ''; // the value really is put back later
    const again = await reverifyOrganizationFix(w.task, w.deps);
    assert.equal(again.fix.rollback.status, 'verified');
  });

  test('a rollback that died halfway resumes: only the field still to restore is written', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    await seedRecord(w, { status: 'applied', landed: ['name', 'logo'], restored: ['name'], rollback: { status: 'requested', requestedAt: new Date(), restoredFields: [], conflictFields: [] } });
    w.bridge.state.logo = REAL_LOGO; // name already put back by the first, interrupted rollback
    const out = await rollbackOrganizationFix(w.task, {}, w.deps);
    assert.deepEqual(w.bridge.writes.map((x) => x.field), ['logo']);
    assert.equal(out.fix.rollback.status, 'verified');
  });

  test('a field a person already reverted by hand counts as restored (no write, no false conflict)', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    await apply(w);
    w.bridge.state.logo = '';
    const before = w.bridge.writes.length;
    const out = await rollbackOrganizationFix(w.task, {}, w.deps);
    assert.deepEqual(w.bridge.writes.slice(before).map((x) => x.field), ['name']);
    assert.equal(out.fix.rollback.status, 'verified');
    assert.equal((await recordOf(w)).changes.find((c) => c.field === 'logo').restoreState, 'already_restored');
  });

  test('rolling back a second time changes nothing and writes nothing', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    await apply(w);
    await rollbackOrganizationFix(w.task, {}, w.deps);
    const writes = w.bridge.writes.length;
    await assert.rejects(rollbackOrganizationFix(w.task, {}, w.deps), (e) => e.statusCode === 404);
    assert.equal(w.bridge.writes.length, writes);
  });

  test('a rollback does not touch a field Odito never wrote', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    await apply(w);
    w.bridge.state.description = 'someone typed this';
    await rollbackOrganizationFix(w.task, {}, w.deps);
    assert.equal(w.bridge.state.description, 'someone typed this');
    assert.ok(w.bridge.writes.every((x) => ['name', 'logo'].includes(x.field)));
  });

  test('after a rollback the page is re-checked for a duplicate Organization: pending until a post-rollback crawl, failed when duplicated', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    await apply(w);
    let verdict = { status: 'unverifiable', code: 'NO_POST_WRITE_CRAWL', reasons: ['not recrawled'] };
    w.deps.inspectAfterRollback = async () => verdict;
    const out = await rollbackOrganizationFix(w.task, {}, w.deps);
    assert.equal(out.fix.rollback.rendered.status, 'pending');
    verdict = { status: 'failed', code: 'DUPLICATE_ENTITIES', reasons: ['described twice'] };
    const re = await reverifyOrganizationFix(w.task, w.deps);
    assert.equal(re.fix.rollback.rendered.status, 'failed');
    assert.equal(re.fix.rollback.rendered.reasonCode, 'DUPLICATE_ENTITIES');
    assert.equal(re.fix.rollback.rendered.attempts, 2);
    verdict = { status: 'verified', code: null, reasons: [] };
    assert.equal((await reverifyOrganizationFix(w.task, w.deps)).fix.rollback.rendered.status, 'verified');
  });
});

describe('verification states: pending is not unverifiable is not failed', () => {
  test('no crawl since the write is PENDING; an unreachable asset is UNVERIFIABLE; the attempts are counted', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    await apply(w);
    let inspection = { status: 'unverifiable', code: 'NO_POST_WRITE_CRAWL', reasons: ['not recrawled'] };
    w.deps.verifyRendered = async () => inspection;
    let r = await reverifyOrganizationFix(w.task, w.deps);
    assert.equal(r.fix.verification.rendered.status, 'pending');
    assert.equal(r.fix.verification.rendered.reasonCode, 'NO_POST_WRITE_CRAWL');
    inspection = { status: 'unverifiable', code: 'ASSET_UNREACHABLE', reasons: ['logo could not be fetched'] };
    r = await reverifyOrganizationFix(w.task, w.deps);
    assert.equal(r.fix.verification.rendered.status, 'unverifiable');
    assert.equal(r.fix.verification.rendered.attempts, 2);
    assert.equal(r.fix.status, 'applied', 'cannot-verify never reads as failed or as verified');
  });
});

describe('approval binding and authorization', () => {
  test('the plan fingerprint is bound to the project and the connection: the same state in another project gives another fingerprint, and its approval is refused', async (t) => {
    if (skip(t)) return;
    const a = withProject(world());
    const b = withProject(world());
    const fpA = await fingerprintOf(a);
    const fpB = await fingerprintOf(b);
    assert.notEqual(fpA, fpB);
    await assert.rejects(applyOrganizationFix(b.task, { approved: true, expectedPlanFingerprint: fpA }, b.deps), (e) => e.details?.reason === 'preview_stale');
    assert.equal(b.bridge.writes.length, 0);
  });

  test('a page that does not belong to the connected WordPress site is refused in preview AND apply, before any write', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    w.task.pageUrl = 'https://some-other-site.example/';
    await assert.rejects(getOrganizationFixPreview(w.task, w.deps), (e) => e.details?.reason === 'page_not_on_connected_site');
    await assert.rejects(applyOrganizationFix(w.task, { approved: true, expectedPlanFingerprint: 'a'.repeat(64) }, w.deps), (e) => e.details?.reason === 'page_not_on_connected_site');
    assert.equal(w.bridge.writes.length, 0);
  });

  test('a www or upper-case difference in the host is still the same site', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    w.task.pageUrl = w.task.pageUrl.replace('://', '://WWW.');
    const p = await getOrganizationFixPreview(w.task, w.deps).catch((e) => e);
    assert.ok(!(p instanceof Error) || p.details?.reason !== 'page_not_on_connected_site');
  });
});
