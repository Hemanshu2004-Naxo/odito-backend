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
import { verifySchemaFix } from '../../schema-evidence/schemaVerification.js';
import { addressToWire, wireAddress } from '../../schema-evidence/organizationAddress.js';
import {
  LOGO_URL, ORG_ID, ORIGIN, OTHER_ADDRESS, TEST_ADDRESS, TEST_ADDRESS_NODE, homePageDoc, probeOk, yoastGraph,
} from '../../schema-evidence/__fixtures__/addressSite.js';

/**
 * The Organization ADDRESS fix end to end against a STATEFUL fake of the Odito SEO Bridge (it enforces the same compare-and-set on
 * the address the real 1.6.0 Bridge does) and a live local Mongo for the audit record (auto-skipped when unreachable). The planner,
 * the service, the ledger and the verification code are the real ones. Nothing here touches a real WordPress site, and every name /
 * address is fictional test data (".example").
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

const CONFIRMED = { confirmed: { fields: TEST_ADDRESS, confirmedAt: new Date('2026-10-01') } };

function evidenceOf({ addressSources = CONFIRMED, graph = yoastGraph(), pages = null } = {}) {
  const doc = homePageDoc(graph);
  const ev = buildSchemaEvidence({ issueId: 'organization_schema', pageUrl: doc.url, pageData: doc, pageType: 'homepage', site: analyzeSiteEntity(pages || [doc]), profile: null, addressSources });
  return applyImageProbes(ev, [probeOk(LOGO_URL)]);
}

function makeBridge(initial = {}) {
  const state = { name: 'Eye Hospital Test Site', description: '', url: `${ORIGIN}/`, logo: LOGO_URL, type: '', kind: 'company', hasAddress: false, localSeoActive: true, address: {}, ...initial };
  const b = {
    state, writes: [], humanAddressBefore: null, failOnAddress: null, unreadable: false,
    status: { installed: true, provider: 'rank_math', siteSchemaSupported: true, organizationTypeSupported: true, organizationAddressSupported: true, conditionalWritesSupported: true, bridgeVersion: '1.6.0' },
    async getBridgeStatus() { return b.status; },
    async getSiteSchema() {
      if (b.unreadable) throw new WordPressConnectionError('TIMEOUT', 'The WordPress site took too long to respond.', 504);
      return { provider: 'rank_math', organization: { ...state, hasAddress: Object.keys(wireAddress(state.address)).length > 0, address: wireAddress(state.address) }, breadcrumbs: { enabled: false } };
    },
    async updateSiteSchemaField(_c, entity, field, value, op, { expected } = {}) {
      b.writes.push({ entity, field, value, op, expected });
      if (field !== 'address') { state[field] = op === 'clear' ? '' : value; return { provider: 'rank_math', operation: { id: 'op', atomic: true, attempts: 1 }, organization: { ...state } }; }
      if (b.humanAddressBefore) { state.address = b.humanAddressBefore; b.humanAddressBefore = null; } // someone saves a different address between the plan and the write
      if (b.failOnAddress) throw b.failOnAddress;
      if (expected !== undefined && addressToWire(state.address) !== expected) throw new WordPressConnectionError('CONFLICT', 'changed', 409);
      state.address = op === 'clear' ? {} : JSON.parse(value);
      return { provider: 'rank_math', operation: { id: `op-${b.writes.length}`, atomic: true, attempts: 1 }, organization: { ...state } };
    },
  };
  return b;
}

let seq = 0;
let currentProject;
function world({ bridgeInit, evidence = evidenceOf(), pageDoc = null } = {}) {
  const projectId = new mongoose.Types.ObjectId();
  projectIds.push(projectId);
  currentProject = projectId;
  const bridge = makeBridge(bridgeInit);
  const connectionId = new mongoose.Types.ObjectId();
  const task = {
    _id: new mongoose.Types.ObjectId(), projectId, issueKey: 'organization_schema', pageUrl: ORIGIN, status: 'task_created',
    recommendationId: new mongoose.Types.ObjectId(), fixHistory: [], saves: 0, async save() { this.saves += 1; },
  };
  const w = { task, bridge, projectId, pageDoc };
  w.deps = {
    wordPressService: { getHydratedConnectionOrThrow: async () => ({ _id: connectionId, site_url: ORIGIN, application_password: 'secret' }) },
    bridge,
    collectEvidence: async () => evidence,
    taskHistory: { applyImplementedTransition: async (t, { externalWrite } = {}) => { t.status = 'implemented'; t.fixHistory.push({ n: ++seq, fixApplied: { externalWrite } }); } },
    loadPageDoc: async () => w.pageDoc,
    loadSite: async () => analyzeSiteEntity(w.pageDoc ? [w.pageDoc] : []),
    // the REAL rendered verification; only the image fetch (a network call) is stubbed
    verifyRendered: (args) => verifySchemaFix({ ...args, verifyImages: async (urls) => urls.map((u) => probeOk(u)) }),
  };
  return w;
}

const preview = (w) => getOrganizationFixPreview(w.task, w.deps);
const apply = async (w, over = {}) => applyOrganizationFix(w.task, { approved: true, expectedPlanFingerprint: (await preview(w)).plan.fingerprint, actorId: new mongoose.Types.ObjectId(), ...over }, w.deps);
const addressWrites = (w) => w.bridge.writes.filter((x) => x.field === 'address');
const skip = (t) => { if (!mongoAvailable) { t.skip('local MongoDB not reachable'); return true; } return false; };

/** What the crawler stores after the site really published the address (Rank Math's output). */
const crawledAfter = (orgOver = {}, { dropNode = null, scrapedAt = new Date(Date.now() + 5 * 60 * 1000) } = {}) => {
  let graph = yoastGraph({ address: TEST_ADDRESS_NODE, ...orgOver });
  if (dropNode) graph = [{ ...graph[0], '@graph': graph[0]['@graph'].filter((n) => n['@id'] !== dropNode) }];
  return { ...homePageDoc(graph), scraped_at: scrapedAt };
};

beforeEach(() => {
  mock.restoreAll();
  mock.method(Recommendation, 'findById', () => ({ select: () => ({ lean: async () => ({ projectId: currentProject }) }) }));
});

describe('preview — the exact address change, read-only', () => {
  test('a confirmed address on an Organization without one: one address change, the expected entity = existing + address, nothing written', async (t) => {
    if (skip(t)) return;
    const w = world({ pageDoc: homePageDoc() });
    const p = await preview(w);
    assert.equal(p.plan.status, 'ready');
    assert.deepEqual(p.plan.changes.map((c) => [c.field, c.kind, c.before]), [['address', 'set', '']]);
    assert.deepEqual(JSON.parse(p.plan.changes[0].after), TEST_ADDRESS);
    assert.equal(p.plan.changes[0].afterLabel, '14 Lakeview Road, Rivertown, Karnataka, 560001, IN');
    assert.equal(p.plan.changes[0].rankMathOption, 'rank-math-options-titles.local_address');
    assert.equal(p.plan.changes[0].source, 'owner_confirmed');
    assert.deepEqual(p.expectedEntity.address, TEST_ADDRESS_NODE);
    assert.equal(p.expectedEntity['@id'], ORG_ID);
    assert.deepEqual(p.expectedAfterState.address && JSON.parse(p.expectedAfterState.address), TEST_ADDRESS);
    assert.equal(p.beforeState.address, '');
    assert.equal(p.validation.valid, true, p.validation.errors.join(' | '));
    assert.equal(p.approvalStatus, 'awaiting_approval');
    assert.equal(w.bridge.writes.length, 0, 'a preview never writes');
    assert.equal(await WordPressFixRecord.countDocuments({ taskId: w.task._id }), 0);
  });

  test('Local SEO module off -> the address is HELD BACK with the reason (nothing to approve), the rest of the plan is unaffected', async (t) => {
    if (skip(t)) return;
    const w = world({ bridgeInit: { localSeoActive: false, name: '' } });
    const p = await preview(w);
    assert.equal(p.plan.blocked[0].code, 'LOCAL_SEO_REQUIRED');
    assert.match(p.plan.blocked[0].message, /Local SEO/);
    assert.equal(p.plan.changes.some((c) => c.field === 'address'), false);
    assert.equal(p.approvalStatus === 'awaiting_approval', p.plan.status === 'ready');
  });

  test('a Bridge older than 1.6.0 cannot write the address -> held back, with the update instruction', async (t) => {
    if (skip(t)) return;
    const w = world();
    w.bridge.status = { ...w.bridge.status, organizationAddressSupported: false, bridgeVersion: '1.5.0' };
    const p = await preview(w);
    assert.equal(p.plan.status, 'blocked');
    assert.equal(p.plan.blocked[0].code, 'BRIDGE_UPDATE_REQUIRED');
    assert.match(p.plan.blocked[0].message, /1\.6\.0/);
  });

  test('no confirmed/verified address -> the plan is blocked until the address is confirmed (nothing guessed, nothing to apply)', async (t) => {
    if (skip(t)) return;
    const w = world({ evidence: evidenceOf({ addressSources: null }) });
    const p = await preview(w);
    assert.equal(p.plan.status, 'blocked');
    assert.equal(p.plan.blocked[0].code, 'ADDRESS_CONFIRMATION_REQUIRED');
    assert.deepEqual(p.plan.changes, []);
    assert.equal(p.approvalStatus, 'not_available');
  });

  test('conflicting addresses -> blocked with ADDRESS_CONFLICT', async (t) => {
    if (skip(t)) return;
    const other = { ...homePageDoc(), url: `${ORIGIN}/about` };
    other.structured_data = [{ '@context': 'https://schema.org', '@graph': [{ '@type': 'Place', '@id': `${ORIGIN}/#place`, address: { '@type': 'PostalAddress', ...OTHER_ADDRESS } }, { '@type': 'Organization', '@id': ORG_ID, name: 'x', url: `${ORIGIN}/`, location: { '@id': `${ORIGIN}/#place` } }] }];
    const contact = { ...homePageDoc(), url: `${ORIGIN}/contact`, structured_data: yoastGraph({ address: TEST_ADDRESS_NODE }) };
    const w = world({ evidence: evidenceOf({ addressSources: null, pages: [homePageDoc(), contact, other] }) });
    const p = await preview(w);
    assert.equal(p.plan.blocked[0].code, 'ADDRESS_CONFLICT');
  });

  test('Rank Math already holds a DIFFERENT address -> kept (never overwritten) and reported', async (t) => {
    if (skip(t)) return;
    const w = world({ bridgeInit: { address: OTHER_ADDRESS } });
    const p = await preview(w);
    assert.equal(p.plan.changes.some((c) => c.field === 'address'), false);
    assert.equal(p.plan.preserved[0].field, 'address');
    assert.match(p.plan.preserved[0].reason, /does not overwrite/);
  });

  test('Rank Math holds PART of the approved address -> it is completed, not contradicted', async (t) => {
    if (skip(t)) return;
    const w = world({ bridgeInit: { address: { addressLocality: 'Rivertown', addressCountry: 'IN' } } });
    const p = await preview(w);
    const c = p.plan.changes.find((x) => x.field === 'address');
    assert.equal(c.kind, 'complete');
    assert.deepEqual(JSON.parse(c.before), { addressLocality: 'Rivertown', addressCountry: 'IN' });
  });

  test('Rank Math already holds exactly this address -> nothing to change', async (t) => {
    if (skip(t)) return;
    const w = world({ bridgeInit: { address: TEST_ADDRESS } });
    const p = await preview(w);
    assert.equal(p.plan.changes.length, 0);
    assert.equal(p.plan.status, 'nothing_to_change');
  });

  test('another SEO plugin (the Yoast-style site) is unsupported with a clear reason, and the apply is refused', async (t) => {
    if (skip(t)) return;
    const w = world();
    w.bridge.status = { ...w.bridge.status, provider: 'yoast' };
    const p = await preview(w);
    assert.equal(p.plan.status, 'unsupported');
    assert.equal(p.plan.code, 'PROVIDER_NOT_SUPPORTED');
    await assert.rejects(() => applyOrganizationFix(w.task, { approved: true, expectedPlanFingerprint: p.plan.fingerprint }, w.deps), (e) => e.code === 'FIELD_NOT_WRITABLE');
    assert.equal(w.bridge.writes.length, 0);
  });

  test('an Organization published by something other than Rank Math is never "fixed" by editing Rank Math (no duplicate entity)', async (t) => {
    if (skip(t)) return;
    const theme = yoastGraph({ '@id': `${ORIGIN}/#theme-org` });
    const w = world({ evidence: evidenceOf({ graph: theme }) });
    const p = await preview(w);
    assert.equal(p.plan.status, 'unsupported');
    assert.equal(p.plan.code, 'ORGANIZATION_SOURCE_UNKNOWN');
  });
});

describe('apply — only after explicit, current approval', () => {
  test('approval is mandatory, and so is the fingerprint of the plan that was reviewed', async (t) => {
    if (skip(t)) return;
    const w = world();
    const fp = (await preview(w)).plan.fingerprint;
    await assert.rejects(() => applyOrganizationFix(w.task, { approved: false, expectedPlanFingerprint: fp }, w.deps), (e) => /explicitly approved/.test(e.message));
    await assert.rejects(() => applyOrganizationFix(w.task, { approved: true }, w.deps), (e) => e.code === 'EXPECTED_STATE_REQUIRED');
    assert.equal(w.bridge.writes.length, 0);
  });

  test('applies exactly the approved address with a compare-and-set against the empty value, records before/after, and is "applied" — NOT fixed', async (t) => {
    if (skip(t)) return;
    const w = world({ pageDoc: homePageDoc() });
    const r = await apply(w);
    assert.equal(addressWrites(w).length, 1);
    const [write] = addressWrites(w);
    assert.equal(write.expected, '', 'compared against what the plan saw: no address');
    assert.deepEqual(JSON.parse(write.value), TEST_ADDRESS);
    assert.deepEqual(wireAddress(w.bridge.state.address), TEST_ADDRESS);
    assert.equal(w.bridge.writes.length, 1, 'only the address was written — name/logo were already right');

    assert.equal(r.fix.status, 'applied');
    assert.equal(r.immediateVerification, 'success');
    assert.equal(r.fix.verification.saved.status, 'verified');
    assert.equal(r.fix.verification.rendered.status, 'pending', 'the rendered page is not verified by an HTTP 200');
    assert.equal(w.task.status, 'implemented', 'the task is implemented, never verified_fixed by this call');

    const rec = await WordPressFixRecord.findOne({ taskId: w.task._id }).lean();
    assert.equal(rec.changes[0].before, '');
    assert.deepEqual(JSON.parse(rec.changes[0].after), TEST_ADDRESS);
    assert.equal(rec.changes[0].writeMode, 'conditional_update');
    assert.ok(rec.structuredDataBefore.nodes.some((n) => n.id === ORG_ID), 'the page\'s entities were inventoried before the change');
  });

  test('a repeated apply of the same plan writes nothing more (idempotent)', async (t) => {
    if (skip(t)) return;
    const w = world({ pageDoc: homePageDoc() });
    const fp = (await preview(w)).plan.fingerprint;
    await applyOrganizationFix(w.task, { approved: true, expectedPlanFingerprint: fp }, w.deps);
    const second = await applyOrganizationFix(w.task, { approved: true, expectedPlanFingerprint: fp }, w.deps).catch((e) => e);
    assert.equal(addressWrites(w).length, 1);
    assert.ok(second.alreadyApplied === true || second.code === 'CONFLICT' || second.code === 'VALIDATION_FAILED', 'a repeat is a no-op or a refusal, never a second write');
  });

  test('STALE: the address in WordPress changed after the preview -> refused with preview_stale, nothing overwritten', async (t) => {
    if (skip(t)) return;
    const w = world();
    const fp = (await preview(w)).plan.fingerprint;
    w.bridge.state.address = OTHER_ADDRESS; // someone typed one in Rank Math
    await assert.rejects(() => applyOrganizationFix(w.task, { approved: true, expectedPlanFingerprint: fp }, w.deps), (e) => e.code === 'CONFLICT' && e.details?.reason === 'preview_stale');
    assert.equal(w.bridge.writes.length, 0);
    assert.deepEqual(wireAddress(w.bridge.state.address), OTHER_ADDRESS);
  });

  test('STALE: the owner confirmed a different address after the preview -> the old approval no longer applies', async (t) => {
    if (skip(t)) return;
    const w = world();
    const fp = (await preview(w)).plan.fingerprint;
    w.deps.collectEvidence = async () => evidenceOf({ addressSources: { confirmed: { fields: { ...TEST_ADDRESS, streetAddress: '15 Lakeview Road' } } } });
    await assert.rejects(() => applyOrganizationFix(w.task, { approved: true, expectedPlanFingerprint: fp }, w.deps), (e) => e.details?.reason === 'preview_stale');
    assert.equal(w.bridge.writes.length, 0);
  });

  test('STALE: Local SEO was switched off after the preview -> refused', async (t) => {
    if (skip(t)) return;
    const w = world();
    const fp = (await preview(w)).plan.fingerprint;
    w.bridge.state.localSeoActive = false;
    await assert.rejects(() => applyOrganizationFix(w.task, { approved: true, expectedPlanFingerprint: fp }, w.deps), (e) => e.code === 'CONFLICT');
    assert.equal(w.bridge.writes.length, 0);
  });

  test('a person saving a different address between the plan and the write wins: conflict, nothing overwritten, nothing recorded as applied', async (t) => {
    if (skip(t)) return;
    const w = world();
    w.bridge.humanAddressBefore = OTHER_ADDRESS;
    await assert.rejects(() => apply(w), (e) => e.code === 'CONFLICT');
    assert.deepEqual(wireAddress(w.bridge.state.address), OTHER_ADDRESS, 'their address was not overwritten');
    const rec = await WordPressFixRecord.findOne({ taskId: w.task._id }).lean();
    assert.equal(rec.status, 'conflict_detected');
    assert.equal(rec.changes[0].applied, false);
    assert.equal(w.task.status, 'task_created', 'the task is not moved to implemented');
  });

  test('application failure: WordPress refuses the write -> apply_failed, the address is untouched, the task is not implemented', async (t) => {
    if (skip(t)) return;
    const w = world();
    w.bridge.failOnAddress = new WordPressConnectionError('WRITE_FAILED', 'Failed to write this change to WordPress.', 502);
    await assert.rejects(() => apply(w), (e) => e.code === 'WRITE_FAILED');
    assert.deepEqual(wireAddress(w.bridge.state.address), {});
    const rec = await WordPressFixRecord.findOne({ taskId: w.task._id }).lean();
    assert.equal(rec.status, 'apply_failed');
    assert.equal(w.task.status, 'task_created');
  });

  test('WordPress unreadable right after the write -> saved verification is "unverifiable", never "verified"', async (t) => {
    if (skip(t)) return;
    const w = world();
    const origRead = w.bridge.getSiteSchema.bind(w.bridge);
    // readable while planning, unreadable once the write has been sent
    w.bridge.getSiteSchema = async () => { if (w.bridge.writes.length > 0) throw new WordPressConnectionError('TIMEOUT', 'slow', 504); return origRead(); };
    const r = await apply(w);
    assert.equal(r.fix.verification.saved.status, 'unverifiable');
    assert.equal(r.immediateVerification, 'unknown');
  });
});

describe('verification — what the rendered page actually shows (separate from "saved")', () => {
  const applied = async () => { const w = world({ pageDoc: homePageDoc() }); await apply(w); return w; };

  test('APPLIED AND VERIFIED: the re-crawled page carries the approved address on the same entity, every other entity is still there', async (t) => {
    if (skip(t)) return;
    const w = await applied();
    w.pageDoc = crawledAfter();
    const { fix } = await reverifyOrganizationFix(w.task, w.deps);
    assert.equal(fix.verification.rendered.status, 'verified', fix.verification.rendered.reasons.join(' | '));
    assert.equal(fix.status, 'verified');
  });

  test('ISSUE PERSISTS: saved in WordPress but the page still has no address (cache / theme) -> rendered FAILED, status verification_failed, with the detector-equivalent reason', async (t) => {
    if (skip(t)) return;
    const w = await applied();
    w.pageDoc = { ...homePageDoc(), scraped_at: new Date(Date.now() + 5 * 60 * 1000) };
    const { fix } = await reverifyOrganizationFix(w.task, w.deps);
    assert.equal(fix.verification.saved.status, 'verified');
    assert.equal(fix.verification.rendered.status, 'failed');
    assert.match(fix.verification.rendered.reasons.join(' '), /still has no address|detector/);
    assert.equal(fix.status, 'verification_failed');
  });

  test('the page shows a DIFFERENT address than the approved one -> failed', async (t) => {
    if (skip(t)) return;
    const w = await applied();
    w.pageDoc = crawledAfter({ address: { '@type': 'PostalAddress', ...OTHER_ADDRESS } });
    const { fix } = await reverifyOrganizationFix(w.task, w.deps);
    assert.equal(fix.verification.rendered.status, 'failed');
    assert.match(fix.verification.rendered.reasons.join(' '), /not the approved one/);
  });

  test('UNRELATED STRUCTURED DATA must survive: a vanished entity fails the verification even though the address is there', async (t) => {
    if (skip(t)) return;
    const w = await applied();
    w.pageDoc = crawledAfter({}, { dropNode: `${ORIGIN}/#website` });
    const { fix } = await reverifyOrganizationFix(w.task, w.deps);
    assert.equal(fix.verification.rendered.status, 'failed');
    assert.match(fix.verification.rendered.reasons.join(' '), /gone/);
  });

  test('a second Organization entity appearing (duplicate) fails the verification', async (t) => {
    if (skip(t)) return;
    const w = await applied();
    const doc = crawledAfter();
    doc.structured_data[0]['@graph'].push({ '@type': 'Organization', '@id': `${ORIGIN}/#dup`, name: 'Eye Hospital Test Site', url: `${ORIGIN}/` });
    w.pageDoc = doc;
    const { fix } = await reverifyOrganizationFix(w.task, w.deps);
    assert.equal(fix.verification.rendered.status, 'failed');
  });

  test('VERIFICATION PENDING: a crawl older than the write says nothing -> pending, never success or failure', async (t) => {
    if (skip(t)) return;
    const w = await applied();
    w.pageDoc = { ...crawledAfter(), scraped_at: new Date('2020-01-01') };
    const { fix } = await reverifyOrganizationFix(w.task, w.deps);
    assert.equal(fix.verification.rendered.status, 'pending');
    assert.equal(fix.status, 'applied');
  });

  test('VERIFICATION UNAVAILABLE: the page is not in the crawl -> pending/unverifiable, not a verdict', async (t) => {
    if (skip(t)) return;
    const w = await applied();
    w.pageDoc = null;
    const { fix } = await reverifyOrganizationFix(w.task, w.deps);
    assert.ok(['pending', 'unverifiable'].includes(fix.verification.rendered.status));
    assert.notEqual(fix.status, 'verified');
  });
});

describe('rollback — restores exactly the previous (empty) address, and only if nobody changed it since', () => {
  test('restores the empty address with a compare-and-set "clear", then reads it back', async (t) => {
    if (skip(t)) return;
    const w = world({ pageDoc: homePageDoc() });
    await apply(w);
    const { fix } = await rollbackOrganizationFix(w.task, {}, w.deps);
    const clearWrite = addressWrites(w).find((x) => x.op === 'clear');
    assert.ok(clearWrite, 'a clear was sent');
    assert.deepEqual(JSON.parse(clearWrite.expected), TEST_ADDRESS, 'only while it still holds what Odito wrote');
    assert.deepEqual(wireAddress(w.bridge.state.address), {});
    assert.equal(fix.status, 'rolled_back');
    assert.equal(fix.rollback.status, 'verified');
  });

  test('an address edited by a person after the fix is left as they left it (conflict), not reverted', async (t) => {
    if (skip(t)) return;
    const w = world({ pageDoc: homePageDoc() });
    await apply(w);
    w.bridge.state.address = OTHER_ADDRESS;
    const { fix, message } = await rollbackOrganizationFix(w.task, {}, w.deps);
    assert.deepEqual(wireAddress(w.bridge.state.address), OTHER_ADDRESS);
    assert.equal(fix.rollback.status, 'failed');
    assert.match(message, /was changed after Odito wrote it/);
  });
});

describe('scope and authorization guards of the service', () => {
  test('a page that does not belong to the connected WordPress site never produces a plan', async (t) => {
    if (skip(t)) return;
    const w = world();
    w.task.pageUrl = 'https://someone-else.example/';
    await assert.rejects(() => preview(w), (e) => e.details?.reason === 'page_not_on_connected_site');
  });

  test('a project without a WordPress connection cannot preview or apply (the connection lookup is project-scoped)', async (t) => {
    if (skip(t)) return;
    const w = world();
    w.deps.wordPressService = { getHydratedConnectionOrThrow: async () => { throw new WordPressConnectionError('NOT_CONNECTED', 'No WordPress connection for this project.', 404); } };
    await assert.rejects(() => preview(w), (e) => e.code === 'NOT_CONNECTED');
    await assert.rejects(() => applyOrganizationFix(w.task, { approved: true, expectedPlanFingerprint: 'a'.repeat(64) }, w.deps), (e) => e.code === 'NOT_CONNECTED');
    assert.equal(w.bridge.writes.length, 0);
  });

  test('a task for a different issue is not handled by this fix', async (t) => {
    if (skip(t)) return;
    const w = world();
    w.task.issueKey = 'meta_description_missing';
    await assert.rejects(() => applyOrganizationFix(w.task, { approved: true, expectedPlanFingerprint: 'a'.repeat(64) }, w.deps), (e) => e.code === 'FIELD_NOT_WRITABLE');
  });
});
