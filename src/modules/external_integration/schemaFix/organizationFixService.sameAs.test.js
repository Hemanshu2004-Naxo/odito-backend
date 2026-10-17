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
import { inspectRenderedSameAs } from '../../schema-evidence/sameAs/sameAsVerification.js';

/**
 * The sameAs fix through the SHARED Organization fix engine, against a stateful double of the Odito SEO Bridge that behaves like
 * Rank Math's real provider (add is an idempotent no-op when the value is already in the full list; remove works only on the
 * additional-profiles bucket; the Facebook/Twitter-derived values are untouchable; the typed route takes no expected value) and a
 * live local Mongo for the ledger. Nothing here reaches a real WordPress site.
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

const SITE = 'https://www.acme-agency.com/';
const ORG_ID = `${SITE}#organization`;
const LI = 'https://www.linkedin.com/company/acme-agency';
const FB = 'https://www.facebook.com/acmeagency';
const IG = 'https://www.instagram.com/acmeagency';
const TW = 'https://twitter.com/acmeagency';

function makeBridge({ protectedSameAs = [], additionalSameAs = [], provider = 'rank_math', kind = 'company' } = {}) {
  const b = {
    protectedSameAs: [...protectedSameAs], additional: [...additionalSameAs], writes: [], faults: [], humanAdds: [],
    status: { installed: true, provider, siteSchemaSupported: true, organizationTypeSupported: true, bridgeVersion: '1.6.0' },
    kind,
    full() { return [...b.protectedSameAs, ...b.additional]; },
    async getBridgeStatus() { return b.status; },
    async getSiteSchema() {
      return { provider, organization: { name: 'Acme', description: '', url: SITE, logo: '', type: '', kind: b.kind, hasAddress: false, address: {}, localSeoActive: false, sameAs: b.full(), protectedSameAs: [...b.protectedSameAs], additionalSameAs: [...b.additional] }, breadcrumbs: { enabled: false } };
    },
    async updateSiteSchemaField(_c, entity, field, value, op, opts = {}) {
      b.writes.push({ entity, field, value, op, expected: opts.expected });
      if (opts.expected !== undefined) throw new WordPressConnectionError('WRITE_FAILED', 'An expected value can only be a string for scalar fields.', 400);
      if (b.humanAdds.length) { b.additional.push(...b.humanAdds.splice(0)); }
      const fault = b.faults.find((f) => f.match(value, op) && (f.times ?? 1) > 0);
      if (fault) {
        fault.times = (fault.times ?? 1) - 1;
        if (fault.mode === 'commit_then_throw') { if (op === 'add' && !b.full().includes(value)) b.additional.push(value); }
        throw fault.error;
      }
      if (op === 'add') { if (!b.full().includes(value)) b.additional.push(value); } else if (op === 'remove') {
        const i = b.additional.indexOf(value);
        if (i < 0) throw new WordPressConnectionError('WRITE_FAILED', 'This URL is not one Odito can remove.', 422);
        b.additional.splice(i, 1);
      } else throw new WordPressConnectionError('WRITE_FAILED', 'sameAs requires an explicit op of add or remove.', 422);
      return { provider, operation: null, organization: {} };
    },
  };
  return b;
}

const orgNode = (sameAs) => ({ '@type': 'Organization', '@id': ORG_ID, name: 'Acme', url: SITE, logo: { '@type': 'ImageObject', url: `${SITE}logo.png` }, ...(sameAs ? { sameAs } : {}) });
const crawl = (sameAs, n = 4) => Array.from({ length: n }, (_, i) => ({ url: i ? `${SITE}p${i}/` : SITE, structured_data: [{ '@context': 'https://schema.org', '@graph': [orgNode(sameAs)] }] }));

let seq = 0;
function world({ bridgeInit, pages, connected = true, cached = false, rendererExtra } = {}) {
  const projectId = new mongoose.Types.ObjectId();
  projectIds.push(projectId);
  const bridge = makeBridge(bridgeInit);
  const connectionId = new mongoose.Types.ObjectId();
  const task = {
    _id: new mongoose.Types.ObjectId(), projectId, issueKey: 'sameas_array', pageUrl: `${SITE}p1/`, status: 'task_created',
    recommendationId: new mongoose.Types.ObjectId(), fixHistory: [], saves: 0, async save() { this.saves += 1; },
  };
  const frozen = bridge.full();
  const w = {
    task, bridge, projectId, connectionId, pagesFetched: 0, live: { cached, extra: rendererExtra || [] },
    deps: {
      wordPressService: { getHydratedConnectionOrThrow: async () => { if (!connected) throw new WordPressConnectionError('NOT_CONNECTED', 'No WordPress connection exists for this project.', 404); return { _id: connectionId, site_url: SITE }; } },
      bridge,
      loadSitePages: async () => pages || crawl(bridge.full().length ? bridge.full() : undefined),
      taskHistory: { applyImplementedTransition: async (t, p = {}) => { t.status = 'implemented'; t.fixHistory.push({ n: ++seq, fixApplied: { externalWrite: p.externalWrite, expectedAfterValue: p.expectedAfterValueOverride } }); } },
      loadPageDoc: async () => null,
      // The "public page": what Rank Math would publish from the current settings (or an old cached copy).
      verifyLiveRendered: async ({ pageUrl, expected }) => {
        w.pagesFetched += 1;
        const list = w.live.cached ? frozen : [...bridge.full(), ...w.live.extra];
        return inspectRenderedSameAs({ structuredData: [{ '@context': 'https://schema.org', '@graph': [orgNode(list.length ? list : undefined)] }], pageUrl, expected });
      },
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

const input = (...urls) => ({ urls });
const preview = (w, inp = input(LI)) => getOrganizationFixPreview(w.task, w.deps, inp);
const apply = async (w, inp = input(LI), over = {}) => applyOrganizationFix(w.task, { approved: true, expectedPlanFingerprint: (await preview(w, inp)).plan.fingerprint, actorId: new mongoose.Types.ObjectId(), ...inp, ...over }, w.deps);

describe('sameAs preview — read-only, deterministic, honest', () => {
  test('exposes the exact additions, the recommended JSON-LD, the scope and the write target — and writes nothing', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    const p = await preview(w, input(LI, FB));
    assert.equal(p.fixType, 'organization_same_as');
    assert.equal(p.plan.status, 'ready');
    assert.deepEqual(p.proposedChanges.map((c) => [c.field, c.kind, c.before, c.after]), [['sameAs', 'add', '', LI], ['sameAs', 'add', '', FB]]);
    assert.equal(p.sameAs.panelState, 'ready_to_apply');
    assert.equal(p.sameAs.scope.kind, 'site_wide'); assert.equal(p.sameAs.scope.affectedPages.length, 4);
    assert.match(p.sameAs.target.label, /Rank Math/);
    const jsonLd = JSON.parse(p.sameAs.recommendedJsonLd);
    assert.deepEqual(jsonLd.sameAs, [LI, FB]); assert.equal(jsonLd['@id'], ORG_ID); assert.equal(jsonLd.name, 'Acme');
    assert.deepEqual(jsonLd.logo, { '@type': 'ImageObject', url: `${SITE}logo.png` });
    assert.equal('sameAs' in JSON.parse(p.sameAs.beforeJsonLd), false);
    assert.deepEqual(p.selection, { urls: [LI, FB], removeUrls: [] });
    assert.equal(p.validation.valid, true); assert.equal(p.approvalStatus, 'awaiting_approval');
    assert.equal(w.bridge.writes.length, 0);
    assert.equal(await WordPressFixRecord.countDocuments({ taskId: w.task._id }), 0);
  });

  test('works before a task exists (no task id): same plan, no ledger lookup', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    const p = await getOrganizationFixPreview({ projectId: w.projectId, pageUrl: w.task.pageUrl, issueKey: 'sameas_array' }, w.deps, input(LI));
    assert.equal(p.plan.status, 'ready'); assert.equal(p.idempotencyKey, null); assert.equal(p.fixId, null);
    assert.equal(p.plan.fingerprint, (await preview(w)).plan.fingerprint, 'the fingerprint does not depend on the task');
  });

  test('invalid, unsafe or duplicate links are rejected per line before anything is planned', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    await assert.rejects(preview(w, input('javascript:alert(1)', LI, 'https://linkedin.com/company/acme-agency/')), (e) => {
      assert.equal(e.code, 'INVALID_PROFILES'); assert.equal(e.statusCode, 400);
      assert.deepEqual(e.details.errors.map((x) => [x.index, x.code]), [[0, 'NOT_HTTP'], [2, 'DUPLICATE']]);
      return true;
    });
    await assert.rejects(preview(w, input('https://www.example.com/acme')), (e) => e.details.errors[0].code === 'PLACEHOLDER');
    await assert.rejects(preview(w, { urls: LI }), (e) => e.code === 'INVALID_PROFILES');
    assert.equal(w.bridge.writes.length, 0);
  });

  test('no links selected: nothing_to_change, no empty array, nothing to approve', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    const p = await preview(w, input());
    assert.equal(p.plan.status, 'nothing_to_change'); assert.equal(p.plan.code, 'NO_PROFILES_SELECTED');
    assert.equal(p.sameAs.panelState, 'no_selection'); assert.equal(p.approvalStatus, 'not_available');
    assert.equal(p.expectedEntity.sameAs, undefined);
  });

  test('existing values are preserved in the recommended JSON-LD; a profile Rank Math already publishes is not added again', async (t) => {
    if (skip(t)) return;
    const w = withProject(world({ bridgeInit: { protectedSameAs: [FB, TW], additionalSameAs: [IG] } }));
    const p = await preview(w, input(LI, FB));
    assert.deepEqual(p.proposedChanges.map((c) => c.after), [LI]);
    assert.deepEqual(p.sameAs.alreadyPresent.map((a) => a.url), [FB]);
    assert.deepEqual(JSON.parse(p.sameAs.recommendedJsonLd).sameAs, [FB, TW, IG, LI]);
    assert.deepEqual(p.sameAs.protectedSameAs, [FB, TW]);
  });

  test('unsupported sources: Yoast, no WordPress connection, no Bridge, a theme-generated or duplicated entity → manual steps, no Apply', async (t) => {
    if (skip(t)) return;
    const yoast = withProject(world({ bridgeInit: { provider: 'yoast' } }));
    const y = await preview(yoast);
    assert.equal(y.plan.status, 'unsupported'); assert.equal(y.sameAs.panelState, 'unsupported_source'); assert.equal(y.approvalStatus, 'not_available');
    assert.match(y.sameAs.manual.steps.join(' '), /Yoast SEO/);
    assert.deepEqual(JSON.parse(y.sameAs.recommendedJsonLd).sameAs, [LI], 'the recommended JSON-LD is still shown for the manual path');

    const off = withProject(world({ connected: false }));
    const o = await preview(off);
    assert.equal(o.plan.code, 'WORDPRESS_NOT_CONNECTED'); assert.equal(o.sameAs.panelState, 'unsupported_source'); assert.ok(o.sameAs.manual.steps.length);

    const nobridge = withProject(world());
    nobridge.bridge.status = { installed: false, provider: 'none' };
    assert.equal((await preview(nobridge)).plan.code, 'BRIDGE_NOT_INSTALLED');

    const theme = withProject(world({ pages: [{ url: SITE, structured_data: [{ '@graph': [{ ...orgNode(), '@id': `${SITE}#theme-org` }] }] }, { url: `${SITE}p1/`, structured_data: [{ '@graph': [{ ...orgNode(), '@id': `${SITE}#theme-org` }] }] }] }));
    assert.equal((await preview(theme)).plan.code, 'ORGANIZATION_SOURCE_UNKNOWN');

    const dup = withProject(world({ pages: [{ url: `${SITE}p1/`, structured_data: [{ '@graph': [orgNode(), { ...orgNode(), '@id': `${SITE}#second` }] }] }] }));
    assert.equal((await preview(dup)).plan.code, 'DUPLICATE_ENTITIES');
  });

  test('page-specific markup is reported as page-specific', async (t) => {
    if (skip(t)) return;
    const pages = [{ url: SITE, structured_data: [{ '@graph': [orgNode([FB])] }] }, { url: `${SITE}p1/`, structured_data: [{ '@graph': [orgNode([IG])] }] }, { url: `${SITE}p2/`, structured_data: [{ '@graph': [orgNode([TW])] }] }];
    const w = withProject(world({ pages, bridgeInit: { additionalSameAs: [IG] } }));
    assert.equal((await preview(w)).sameAs.scope.kind, 'page_specific');
  });
});

describe('sameAs apply — approval, write, read-back, rendered verification, ledger', () => {
  test('writes only the approved URLs through the typed add route, reads back, verifies the rendered page, records the ledger and the task', async (t) => {
    if (skip(t)) return;
    const w = withProject(world({ bridgeInit: { protectedSameAs: [FB], additionalSameAs: [IG] } }));
    const actorId = new mongoose.Types.ObjectId();
    const r = await apply(w, input(LI), { actorId });

    assert.deepEqual(w.bridge.writes, [{ entity: 'organization', field: 'sameAs', value: LI, op: 'add', expected: undefined }]);
    assert.deepEqual(w.bridge.full(), [FB, IG, LI], 'existing values kept, the approved one appended');
    assert.equal(r.immediateVerification, 'success');
    assert.equal(r.fix.status, 'verified');
    assert.equal(r.fix.verification.saved.status, 'verified'); assert.equal(r.fix.verification.rendered.status, 'verified');
    assert.ok(r.fix.verification.rendered.fields.every((f) => f.ok));
    assert.equal(w.pagesFetched, 1);
    assert.equal(w.task.status, 'implemented'); assert.notEqual(w.task.status, 'verified_fixed');
    const write = w.task.fixHistory[0].fixApplied;
    assert.equal(write.externalWrite.field, 'organization_same_as');
    assert.deepEqual(write.expectedAfterValue, { type: 'same_as', urls: [LI], additionalProfiles: [] });

    const rec = await WordPressFixRecord.findOne({ taskId: w.task._id });
    assert.equal(rec.fixType, 'organization_same_as'); assert.equal(String(rec.approvedBy), String(actorId));
    assert.deepEqual(rec.changes.map((c) => [c.field, c.before, c.after, c.applied, c.writeState]), [['sameAs', '', LI, true, 'landed']]);
    assert.equal(rec.target.entityId, ORG_ID); assert.deepEqual(rec.target.keptUrls, [FB, IG]); assert.equal(rec.target.shared, true);
  });

  test('saved but not rendered (page cache) is a verification FAILURE that says so — the task is still not verified', async (t) => {
    if (skip(t)) return;
    const w = withProject(world({ cached: true }));
    const r = await apply(w);
    assert.equal(r.immediateVerification, 'failed');
    assert.equal(r.fix.status, 'verification_failed');
    assert.equal(r.fix.verification.saved.status, 'verified');
    assert.equal(r.fix.verification.rendered.status, 'failed'); assert.equal(r.fix.verification.rendered.reasonCode, 'NOT_IN_RENDERED_PAGE');
    assert.ok(r.fix.verification.rendered.reasons.some((x) => /cache/i.test(x)));
    assert.notEqual(w.task.status, 'verified_fixed');

    w.live.cached = false; // the cache expired: a re-check flips it, without writing anything again
    const writesBefore = w.bridge.writes.length;
    const again = await reverifyOrganizationFix(w.task, w.deps);
    assert.equal(again.fix.status, 'verified'); assert.equal(w.bridge.writes.length, writesBefore);
  });

  test('a stale preview (WordPress changed, or a different selection) is a conflict and writes nothing', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    const fp = (await preview(w)).plan.fingerprint;
    w.bridge.additional.push(IG); // somebody edited the profiles in Rank Math after the preview
    await assert.rejects(applyOrganizationFix(w.task, { approved: true, expectedPlanFingerprint: fp, urls: [LI] }, w.deps), (e) => e.code === 'CONFLICT' && e.details.reason === 'preview_stale');
    const fp2 = (await preview(w, input(LI))).plan.fingerprint;
    await assert.rejects(applyOrganizationFix(w.task, { approved: true, expectedPlanFingerprint: fp2, urls: [LI, FB] }, w.deps), (e) => e.code === 'CONFLICT');
    assert.equal(w.bridge.writes.length, 0);
  });

  test('approval and fingerprint are mandatory; unsupported and empty plans cannot be applied; invalid links are refused before any write', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    await assert.rejects(applyOrganizationFix(w.task, { approved: false, expectedPlanFingerprint: 'a'.repeat(64), urls: [LI] }, w.deps), (e) => e.code === 'WRITE_FAILED');
    await assert.rejects(applyOrganizationFix(w.task, { approved: true, urls: [LI] }, w.deps), (e) => e.code === 'EXPECTED_STATE_REQUIRED');
    await assert.rejects(applyOrganizationFix(w.task, { approved: true, expectedPlanFingerprint: 'a'.repeat(64), urls: ['javascript:1'] }, w.deps), (e) => e.code === 'INVALID_PROFILES');
    const empty = await preview(w, input());
    await assert.rejects(applyOrganizationFix(w.task, { approved: true, expectedPlanFingerprint: empty.plan.fingerprint, urls: [] }, w.deps), (e) => e.code === 'VALIDATION_FAILED');
    const yoast = withProject(world({ bridgeInit: { provider: 'yoast' } }));
    const fp = (await preview(yoast)).plan.fingerprint;
    await assert.rejects(applyOrganizationFix(yoast.task, { approved: true, expectedPlanFingerprint: fp, urls: [LI] }, yoast.deps), (e) => e.code === 'FIELD_NOT_WRITABLE');
    assert.equal(w.bridge.writes.length + yoast.bridge.writes.length, 0);
  });

  test('applying the same approved plan twice writes once (idempotent)', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    const p = await preview(w);
    await applyOrganizationFix(w.task, { approved: true, expectedPlanFingerprint: p.plan.fingerprint, urls: [LI] }, w.deps);
    const second = await applyOrganizationFix(w.task, { approved: true, expectedPlanFingerprint: p.plan.fingerprint, urls: [LI] }, w.deps).catch((e) => e);
    // The task is already implemented, so the guard may refuse; either way nothing is written twice.
    assert.equal(w.bridge.writes.length, 1);
    assert.ok(second.alreadyApplied === true || second instanceof WordPressConnectionError);
    assert.equal(await WordPressFixRecord.countDocuments({ taskId: w.task._id }), 1);
  });

  test('a failure part-way puts back what was written (no half-applied profile list)', async (t) => {
    if (skip(t)) return;
    const w = withProject(world({ bridgeInit: { additionalSameAs: [IG] } }));
    w.bridge.faults.push({ match: (v) => v === FB, error: new WordPressConnectionError('WRITE_FAILED', 'rejected', 422) });
    const inp = input(LI, FB);
    await assert.rejects(apply(w, inp), (e) => e.code === 'WRITE_FAILED' && e.details.restoredFields.includes(`sameAs ${LI}`));
    assert.deepEqual(w.bridge.full(), [IG], 'the first profile was removed again');
    const rec = await WordPressFixRecord.findOne({ taskId: w.task._id });
    assert.equal(rec.status, 'apply_failed'); assert.equal(w.task.status, 'task_created');
    assert.deepEqual(w.bridge.writes.map((x) => [x.op, x.value]), [['add', LI], ['add', FB], ['remove', LI]]);
  });

  test('a timeout after WordPress committed is reconciled by READING, never repeated', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    w.bridge.faults.push({ match: (v) => v === LI, mode: 'commit_then_throw', error: new WordPressConnectionError('TIMEOUT', 'The WordPress site took too long to respond.', 504) });
    const r = await apply(w);
    assert.equal(w.bridge.writes.length, 1, 'no blind repeat');
    assert.equal(r.fix.changes[0].attribution, 'reconciled'); assert.equal(r.fix.changes[0].applied, true);
    assert.deepEqual(w.bridge.full(), [LI]);
  });

  test('a person editing the list while the fix runs is never overwritten (their addition stays)', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    w.bridge.humanAdds.push(TW); // lands during the write
    await apply(w);
    assert.deepEqual(w.bridge.full(), [TW, LI]);
  });
});

describe('sameAs removal, reverify and rollback', () => {
  test('an explicit removal drops only that managed value; protected values cannot be removed', async (t) => {
    if (skip(t)) return;
    const w = withProject(world({ bridgeInit: { protectedSameAs: [FB], additionalSameAs: [IG, TW] } }));
    const inp = { urls: [], removeUrls: [IG] };
    const p = await getOrganizationFixPreview(w.task, w.deps, inp);
    assert.deepEqual(p.proposedChanges.map((c) => [c.kind, c.before, c.after]), [['remove', IG, '']]);
    assert.deepEqual(JSON.parse(p.sameAs.recommendedJsonLd).sameAs, [FB, TW]);
    await applyOrganizationFix(w.task, { approved: true, expectedPlanFingerprint: p.plan.fingerprint, ...inp }, w.deps);
    assert.deepEqual(w.bridge.full(), [FB, TW]);
    const prot = await getOrganizationFixPreview(w.task, w.deps, { urls: [], removeUrls: [FB] });
    assert.equal(prot.plan.status, 'blocked'); assert.equal(prot.plan.code, 'PROTECTED_PROFILE');
  });

  test('rollback removes only what this fix added, keeps everything else, and verifies the page again', async (t) => {
    if (skip(t)) return;
    const w = withProject(world({ bridgeInit: { protectedSameAs: [FB], additionalSameAs: [IG] } }));
    await apply(w, input(LI));
    w.bridge.additional.push(TW); // later edit by a person
    const rb = await rollbackOrganizationFix(w.task, { actorId: new mongoose.Types.ObjectId() }, w.deps);
    assert.deepEqual(w.bridge.full(), [FB, IG, TW]);
    assert.equal(rb.fix.status, 'rolled_back'); assert.equal(rb.fix.rollback.status, 'verified');
    assert.equal(rb.fix.rollback.rendered.status, 'verified');
    await assert.rejects(rollbackOrganizationFix(w.task, {}, w.deps), (e) => e.statusCode === 404);
  });

  test('rollback of a removal puts the value back; a value the person already changed is left alone', async (t) => {
    if (skip(t)) return;
    const w = withProject(world({ bridgeInit: { additionalSameAs: [IG] } }));
    const inp = { urls: [], removeUrls: [IG] };
    const p = await getOrganizationFixPreview(w.task, w.deps, inp);
    await applyOrganizationFix(w.task, { approved: true, expectedPlanFingerprint: p.plan.fingerprint, ...inp }, w.deps);
    assert.deepEqual(w.bridge.full(), []);
    await rollbackOrganizationFix(w.task, {}, w.deps);
    assert.deepEqual(w.bridge.full(), [IG]);
  });

  test('reverify reports a value removed by someone else as a saved-state failure', async (t) => {
    if (skip(t)) return;
    const w = withProject(world());
    await apply(w);
    w.bridge.additional.length = 0;
    const r = await reverifyOrganizationFix(w.task, w.deps);
    assert.equal(r.fix.status, 'verification_failed'); assert.equal(r.fix.verification.saved.status, 'failed');
  });
});
