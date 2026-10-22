/**
 * organizationFixService — preview / apply / reverify / rollback of the Organization schema fix.
 *
 * Reuses everything the existing integration already guarantees (task ownership is checked by the controller; the
 * connection is the project's own, credentials stay encrypted and never leave the service; no redirects are followed by
 * wpRequest) and adds what a multi-field site-wide write needs:
 *
 *   preview    the typed fix contract: intent, evidence, exact field changes, before/expected-after state, validation
 *   apply      explicit approval + a plan fingerprint (a stale preview is a conflict) + idempotency + per-field
 *              compare-and-set + automatic restore of already-written fields if a later one fails + read-back
 *   reverify   saved WordPress state and rendered page reported SEPARATELY (a rolled-back fix is re-checked the same way)
 *   rollback   restores only the fields this fix wrote, only while they still hold the value Odito wrote; staged
 *              requested -> applied -> verified so a crash mid-rollback is visible and resumable
 *
 * Reliability rules (ADR 0009):
 *   - the INTENT to write a field is persisted before the request is sent (writeState in_flight);
 *   - a write whose outcome is ambiguous (timeout, dropped connection, 5xx) is never repeated blindly: WordPress is read, and the
 *     result is either "it landed" (attributed as reconciled), "it did not land" (one bounded, compare-and-set-protected retry) or
 *     "someone else changed it" (conflict);
 *   - a record left in flight by a crash is reconciled against the live settings before anything else happens to it;
 *   - Odito never claims atomicity it does not have: each write records whether the Bridge made it a database-level conditional update.
 *
 * It NEVER marks a Task verified_fixed: that is the crawler's verdict (TaskVerificationService). An HTTP 200 from
 * WordPress is "applied", never "verified".
 */

import mongoose from 'mongoose';
import wordPressService, { WordPressConnectionError } from '../service/wordPressService.js';
import oditoSeoBridgeService from '../service/oditoSeoBridgeService.js';
import { assertTransitionAllowed, assertRecommendationLinked, saveTaskRecordingWrite } from '../service/wordPressSeoFixService.js';
import taskHistoryService from '../../tasks/service/TaskHistoryService.js';
import WordPressFixRecord from '../model/WordPressFixRecord.js';
import {
  claimFixRecord, describeFixRecord as describeRecord, idempotencyKey as ledgerKey,
  classifyWriteError, findInFlightRecord, isAbandoned, isResumable,
} from '../ledger/fixLedger.js';
import { pageBelongsToSite } from '../ledger/siteScope.js';
import { analyzeOrganizations, flattenJsonLd } from '../../schema-evidence/schemaGraph.js';
import schemaEvidenceService from '../../schema-evidence/schemaEvidenceService.js';
import { summarizeSchemaEvidence } from '../../schema-evidence/schemaEvidence.js';
import { buildOrganizationJsonLd } from '../../schema-evidence/organizationMarkup.js';
import { checkSchemaAgainstEvidence } from '../../schema-evidence/schemaOutputGuard.js';
import { verifySchemaFix, structuredDataInventory } from '../../schema-evidence/schemaVerification.js';
import { addressFromWire, addressToWire, formatAddress } from '../../schema-evidence/organizationAddress.js';
import { collectSiteEntity } from '../../schema-evidence/siteEntity.js';
import { planOrganizationFix, ORGANIZATION_FIX_TYPE } from './organizationFixPlan.js';
import { SAMEAS_FIX_TYPE, SAMEAS_ISSUE_KEY, SAMEAS_TASK_FIELD } from './sameAsFixPlan.js';
import * as sameAsAdapter from './sameAsFixAdapter.js';
import { BREADCRUMB_FIX_TYPE, BREADCRUMB_ISSUE_KEY } from './breadcrumbFixPlan.js';
import * as breadcrumbAdapter from './breadcrumbFixAdapter.js';
import { verifyRenderedSameAs } from '../../schema-evidence/sameAs/sameAsVerification.js';

const ISSUE_KEY = 'organization_schema';
const trimSlash = (u) => (typeof u === 'string' ? u.trim().replace(/\/+$/, '') : '');

// One engine, two kinds of Organization fix. Everything below is shared (ledger, compare-and-set writes, reconcile, restore, crash
// recovery, rollback, read-back); a sameAs task differs only in its fix type / issue key, how a change is read and written, how
// it is planned and what its rendered verification proves (see sameAsFixAdapter.js).
const isSameAsTask = (task) => task?.issueKey === SAMEAS_ISSUE_KEY;
const isBreadcrumbTask = (task) => task?.issueKey === BREADCRUMB_ISSUE_KEY;
const fixTypeOf = (task) => (isSameAsTask(task) ? SAMEAS_FIX_TYPE : isBreadcrumbTask(task) ? BREADCRUMB_FIX_TYPE : ORGANIZATION_FIX_TYPE);
const issueKeyOf = (task) => (isSameAsTask(task) ? SAMEAS_ISSUE_KEY : isBreadcrumbTask(task) ? BREADCRUMB_ISSUE_KEY : ISSUE_KEY);
const taskFieldOf = (task) => (isSameAsTask(task) ? SAMEAS_TASK_FIELD : isBreadcrumbTask(task) ? BREADCRUMB_FIX_TYPE : ORGANIZATION_FIX_TYPE);
// sameAs and breadcrumbs are both verified against the PUBLIC page right after the write (the Organization fix waits for the next recrawl).
const verifiesLive = (task) => isSameAsTask(task) || isBreadcrumbTask(task);

const defaultDeps = () => ({
  wordPressService,
  bridge: oditoSeoBridgeService,
  collectEvidence: schemaEvidenceService.collectSchemaEvidence,
  Record: WordPressFixRecord,
  taskHistory: taskHistoryService,
  loadPageDoc: (projectId, pageUrl) => mongoose.connection.db.collection('seo_page_data').findOne({ projectId, url: pageUrl }),
  loadSitePages: (projectId) => mongoose.connection.db.collection('seo_page_data')
    .find({ projectId: new mongoose.Types.ObjectId(String(projectId)) }, { projection: { url: 1, structured_data: 1 } }).limit(400).toArray(),
  loadSite: collectSiteEntity,
  verifyRendered: verifySchemaFix,
  verifyLiveRendered: verifyRenderedSameAs,
  ...breadcrumbAdapter.breadcrumbDefaultDeps(),
  inspectAfterRollback: inspectRenderedAfterRollback,
  now: () => new Date(),
});

/** Writes that may be sent for one field: the first, plus ONE compare-and-set-protected retry after a read proved it did not land. */
const MAX_WRITE_ATTEMPTS = 2;

const sameValue = (field, a, b) => {
  if (sameAsAdapter.isSameAsField(field)) return sameAsAdapter.sameSameAsState(a, b);
  return field === 'logo' ? trimSlash(String(a ?? '')) === trimSlash(String(b ?? '')) : String(a ?? '') === String(b ?? '');
};

/** A change's name in logs, errors and the ledger's restored/conflict lists (one sameAs change = one URL). */
const nameOf = (c) => (sameAsAdapter.isSameAsField(c.field) ? `sameAs ${sameAsAdapter.changeUrl(c)}` : breadcrumbAdapter.isBreadcrumbField(c.field) ? 'Rank Math breadcrumbs' : c.field);

/** The live value of one change: a settings field for the Organization fix, "published or not" for one sameAs value. */
const liveValueOf = (live, c) => (sameAsAdapter.isSameAsField(c.field) ? sameAsAdapter.stateOfChange(live, c) : breadcrumbAdapter.isBreadcrumbField(c.field) ? breadcrumbAdapter.breadcrumbStateOf(live) : String(live?.[c.field] ?? ''));

const log = (event, task, fields = {}) => console.log(`[WORDPRESS_FIX] ${event} | projectId=${task.projectId} | taskId=${task._id} | fixType=${fixTypeOf(task)} | ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' | ')}`);

const err = (code, message, status, details) => {
  const e = new WordPressConnectionError(code, message, status);
  if (details) e.details = details;
  return e;
};

export const idempotencyKeyFor = (taskId, fingerprint, fixType = ORGANIZATION_FIX_TYPE) => ledgerKey(taskId, fixType, fingerprint);

/** Everything the Bridge must report before any Organization field is touched; throws a typed, actionable error otherwise. */
async function requireCapableBridge(deps, connection, { sameAs = false } = {}) {
  const status = await deps.bridge.getBridgeStatus(connection);
  if (!status.installed) {
    throw err('FIELD_NOT_WRITABLE', 'Applying Organization schema requires the Odito SEO Bridge plugin to be installed and active on this WordPress site.', 422, { reason: 'bridge_not_installed' });
  }
  if (status.provider === 'multiple') {
    throw err('PLUGIN_NOT_SUPPORTED', 'Multiple SEO plugins are active on this WordPress site. Resolve the ambiguity before applying fixes.', 409);
  }
  // sameAs add/remove exists since the first site-schema route (1.4.0's siteSchema); the type field is not involved.
  if (!status.siteSchemaSupported || (!sameAs && !status.organizationTypeSupported)) {
    throw err('FIELD_NOT_WRITABLE', 'Applying Organization schema requires Odito SEO Bridge 1.4.0 or newer. Update the plugin on this WordPress site, then try again.', 422, { reason: 'bridge_outdated', bridgeVersion: status.bridgeVersion });
  }
  return status;
}

/** Turns an adapter input error into the HTTP-shaped error every handler already understands. */
const fromTyped = (t) => err(t.code, t.message, t.status, t.details);

/** A page of another site must never produce a plan against THIS connection's settings. */
function assertPageInScope(task, connection) {
  if (!pageBelongsToSite(task.pageUrl, connection.site_url)) {
    throw err('VALIDATION_FAILED', 'This page does not belong to the WordPress site connected to this project, so its Organization settings cannot be changed from here.', 422, { reason: 'page_not_on_connected_site' });
  }
}

async function buildPlan(task, deps, connection, bridgeStatus) {
  const evidence = await deps.collectEvidence({ projectId: task.projectId, issueId: ISSUE_KEY, pageUrl: task.pageUrl });
  if (!evidence) throw err('VALIDATION_FAILED', 'No evidence could be collected for this page, so no fix can be planned.', 422);
  const siteSchema = await deps.bridge.getSiteSchema(connection);
  const plan = planOrganizationFix({
    evidence, site: siteSchema.organization, provider: bridgeStatus.provider,
    context: { projectId: task.projectId, connectionId: connection._id, pageUrl: task.pageUrl },
    capabilities: { organizationAddressSupported: !!bridgeStatus.organizationAddressSupported },
  });
  return { plan, evidence, live: siteSchema.organization };
}

/** The entity Rank Math would publish after the planned changes, validated against the verified evidence. */
function expectedAfter(evidence, plan, live) {
  const after = { name: live.name, logo: live.logo, type: live.type, address: addressToWire(live.address) };
  for (const c of plan.changes) after[c.field] = c.after;
  const addressChanged = plan.changes.some((c) => c.field === 'address');
  const typeChanged = plan.changes.some((c) => c.field === 'type');
  const base = buildOrganizationJsonLd(evidence);
  const entity = { ...base, name: after.name || base.name };
  if (after.logo) entity.logo = { '@type': 'ImageObject', url: after.logo };
  else delete entity.logo;
  // What Rank Math would really publish: the configured business type (plus Organization), or a plain Organization.
  entity['@type'] = after.type && after.type !== 'Organization' ? [after.type, 'Organization'] : 'Organization';
  // The address Rank Math will publish is the one it is configured with after this plan (never the page's, never a guess).
  const configuredAddress = addressFromWire(after.address);
  if (Object.keys(configuredAddress).length) entity.address = { '@type': 'PostalAddress', ...configuredAddress }; else delete entity.address;
  // Only the properties this fix controls are validated. The type is validated only when this fix changes it: a type Odito
  // deliberately PRESERVES (an unrelated specific type the site already has) is not something it asserts.
  const checked = {
    '@context': 'https://schema.org', '@type': typeChanged ? entity['@type'] : evidence.organization.intent.types, '@id': entity['@id'],
    name: entity.name, url: entity.url, ...(entity.logo ? { logo: entity.logo } : {}),
    ...(addressChanged && entity.address ? { address: entity.address } : {}),
  };
  const { errors, warnings } = checkSchemaAgainstEvidence(checked, evidence);
  return { state: { name: after.name || '', logo: after.logo || '', type: after.type || '', address: after.address || '', addressLabel: formatAddress(configuredAddress) }, entity, validation: { valid: errors.length === 0, errors, warnings } };
}

const lifecycleOf = (record, plan, validation) => {
  if (record) return record.status;
  if (plan.status !== 'ready') return plan.status === 'unsupported' ? 'unsupported' : plan.status === 'validation_failed' ? 'validation_failed' : 'proposed';
  return validation.valid ? 'awaiting_approval' : 'validation_failed';
};

async function latestRecord(deps, task) {
  // A preview made before the task exists (the sameAs panel shows the plan first) has no ledger yet.
  if (!task._id) return null;
  return deps.Record.findOne({ taskId: task._id, fixType: fixTypeOf(task) }).sort({ createdAt: -1 });
}

// ── preview ──────────────────────────────────────────────────────────────────

/**
 * Connection + Bridge for a sameAs plan, or the reason they are not available. A missing integration is not an error for sameAs: the
 * plan is then `unsupported` with manual instructions, so the recommendation and its JSON-LD are shown regardless.
 */
async function sameAsEnvironment(task, deps) {
  let connection;
  try {
    connection = await deps.wordPressService.getHydratedConnectionOrThrow(task.projectId);
  } catch (e) {
    if (e instanceof WordPressConnectionError) return { connection: null, bridgeStatus: null, unavailable: { code: e.code === 'NOT_CONNECTED' ? 'WORDPRESS_NOT_CONNECTED' : (e.code || 'WORDPRESS_UNAVAILABLE'), message: e.code === 'NOT_CONNECTED' ? 'WordPress is not connected to this project, so Odito cannot write the change. Use the manual steps below, or connect WordPress in Integrations.' : `The WordPress connection cannot be used right now (${e.message}) so Odito cannot write the change. Use the manual steps below, or fix the connection in Integrations.` } };
    throw e;
  }
  assertPageInScope(task, connection);
  try {
    const bridgeStatus = await requireCapableBridge(deps, connection, { sameAs: true });
    return { connection, bridgeStatus, unavailable: null };
  } catch (e) {
    if (e instanceof WordPressConnectionError && e.details?.reason === 'bridge_not_installed') {
      return { connection, bridgeStatus: null, unavailable: { code: 'BRIDGE_NOT_INSTALLED', message: 'The Odito SEO Bridge plugin is not installed or active on this WordPress site, so Odito cannot write the change. Install it, or use the manual steps below.' } };
    }
    throw e;
  }
}

async function buildSameAsPlanFor(task, deps, input) {
  const env = await sameAsEnvironment(task, deps);
  let built;
  try {
    built = await sameAsAdapter.buildSameAsPlan({ task, deps, connection: env.connection, bridgeStatus: env.bridgeStatus, unavailable: env.unavailable, input });
  } catch (e) {
    if (e instanceof sameAsAdapter.SameAsInputError) throw fromTyped(e);
    throw e;
  }
  return { ...env, ...built };
}

async function buildBreadcrumbPlanFor(task, deps) {
  const env = await sameAsEnvironment(task, deps); // same needs: the project's connection, the Bridge, site-level schema support
  const built = await breadcrumbAdapter.buildBreadcrumbPlan({ task, deps, connection: env.connection, bridgeStatus: env.bridgeStatus, unavailable: env.unavailable });
  return { ...env, ...built };
}

async function getBreadcrumbFixPreview(task, deps) {
  const record = await latestRecord(deps, task);
  const { connection, bridgeStatus, plan, trail, display, stale, live, enabledNow, predicted } = await buildBreadcrumbPlanFor(task, deps);
  const after = breadcrumbAdapter.expectedAfterBreadcrumb({ plan, trail });
  const lifecycle = lifecycleOf(record, plan, after.validation);
  const extras = breadcrumbAdapter.previewExtras({ plan, trail, display, stale, live, enabledNow, predicted, after, record, lifecycle });
  const ready = plan.status === 'ready' && after.validation.valid;
  return {
    fixType: BREADCRUMB_FIX_TYPE,
    projectId: task.projectId,
    connectionId: connection?._id || null,
    fixId: record?._id || null,
    targetUrl: task.pageUrl,
    targetWordPressObjectId: null,
    scope: 'site',
    source: { system: 'wordpress', provider: bridgeStatus?.provider || null, bridgeVersion: bridgeStatus?.bridgeVersion || null, writes: plan.changes.length ? [plan.target?.storage || null].filter(Boolean) : [] },
    concurrency: { writes: 'read_then_write' },
    plan: { status: plan.status, code: plan.code, message: plan.message, fingerprint: plan.fingerprint, changes: plan.changes, preserved: [], blocked: plan.blocked, notWritten: [] },
    proposedChanges: plan.changes.map((c) => ({ field: c.field, label: c.label, kind: c.kind, before: c.before, after: c.after, source: c.source })),
    beforeState: { breadcrumbsEnabled: enabledNow === null ? null : (enabledNow ? 'on' : '') },
    expectedAfterState: after.state,
    expectedEntity: after.entity,
    validation: after.validation,
    approvalStatus: record && ['approved', 'applying', 'apply_uncertain', 'applied', 'verifying', 'verified', 'verification_failed'].includes(record.status) ? 'approved' : (ready ? 'awaiting_approval' : 'not_available'),
    executionStatus: record ? record.status : (ready ? 'not_started' : 'not_applicable'),
    verificationStatus: record ? { saved: record.verification?.saved?.status || 'pending', rendered: record.verification?.rendered?.status || 'pending' } : { saved: 'pending', rendered: 'pending' },
    idempotencyKey: task._id ? idempotencyKeyFor(task._id, plan.fingerprint, BREADCRUMB_FIX_TYPE) : null,
    lifecycle,
    record: describeRecord(record),
    createdAt: record?.createdAt || null,
    updatedAt: record?.updatedAt || null,
    breadcrumb: extras,
  };
}

async function getSameAsFixPreview(task, deps, input) {
  const record = await latestRecord(deps, task);
  const { connection, bridgeStatus, plan, entity, live, selection, removeUrls } = await buildSameAsPlanFor(task, deps, input);
  const after = sameAsAdapter.expectedAfterSameAs({ plan, entity, live, selection, removeUrls });
  const lifecycle = lifecycleOf(record, plan, after.validation);
  const extras = sameAsAdapter.previewExtras({ plan, entity, live, after, record, lifecycle });
  const ready = plan.status === 'ready' && after.validation.valid;
  return {
    fixType: SAMEAS_FIX_TYPE,
    projectId: task.projectId,
    connectionId: connection?._id || null,
    fixId: record?._id || null,
    targetUrl: task.pageUrl,
    targetWordPressObjectId: null,
    scope: 'site',
    source: { system: 'wordpress', provider: bridgeStatus?.provider || null, bridgeVersion: bridgeStatus?.bridgeVersion || null, writes: plan.changes.length ? [plan.target?.storage || null].filter(Boolean) : [] },
    concurrency: { writes: 'read_then_write' },
    // The selection this plan was built from, echoed so the client sends exactly the same input back when it applies.
    selection: { urls: selection.map((s) => s.url), removeUrls },
    plan: {
      status: plan.status, code: plan.code, message: plan.message, fingerprint: plan.fingerprint,
      changes: plan.changes, preserved: plan.preserved, blocked: plan.blocked, notWritten: plan.notWritten,
    },
    proposedChanges: plan.changes.map((c) => ({ field: c.field, label: c.label, kind: c.kind, before: c.before, after: c.after, source: c.source })),
    beforeState: { kind: live?.kind || null, sameAs: live?.sameAs || [] },
    expectedAfterState: after.state,
    expectedEntity: after.entity,
    validation: after.validation,
    approvalStatus: record && ['approved', 'applying', 'apply_uncertain', 'applied', 'verifying', 'verified', 'verification_failed'].includes(record.status) ? 'approved' : (ready ? 'awaiting_approval' : 'not_available'),
    executionStatus: record ? record.status : (ready ? 'not_started' : 'not_applicable'),
    verificationStatus: record ? { saved: record.verification?.saved?.status || 'pending', rendered: record.verification?.rendered?.status || 'pending' } : { saved: 'pending', rendered: 'pending' },
    idempotencyKey: task._id ? idempotencyKeyFor(task._id, plan.fingerprint, SAMEAS_FIX_TYPE) : null,
    lifecycle,
    record: describeRecord(record),
    createdAt: record?.createdAt || null,
    updatedAt: record?.updatedAt || null,
    sameAs: extras,
  };
}

export async function getOrganizationFixPreview(task, overrides = {}, input = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  if (isSameAsTask(task)) return getSameAsFixPreview(task, deps, input);
  if (isBreadcrumbTask(task)) return getBreadcrumbFixPreview(task, deps);
  const connection = await deps.wordPressService.getHydratedConnectionOrThrow(task.projectId);
  const record = await latestRecord(deps, task);
  assertPageInScope(task, connection);
  const bridgeStatus = await requireCapableBridge(deps, connection);
  const { plan, evidence, live } = await buildPlan(task, deps, connection, bridgeStatus);
  const after = expectedAfter(evidence, plan, live);
  const summary = summarizeSchemaEvidence(evidence)?.organization || null;
  return {
    fixType: ORGANIZATION_FIX_TYPE,
    projectId: task.projectId,
    connectionId: connection._id,
    fixId: record?._id || null,
    targetUrl: task.pageUrl,
    targetWordPressObjectId: null, // site-scoped: Rank Math's Knowledge Graph settings, not one post
    scope: 'site',
    source: { system: 'wordpress', provider: bridgeStatus.provider, bridgeVersion: bridgeStatus.bridgeVersion, writes: plan.changes.map((c) => c.rankMathOption) },
    // Honest about the guarantee: 'database_conditional' = each write is one conditional UPDATE of Rank Math's settings row (Bridge 1.5.0+);
    // 'read_then_write' = the older Bridge checks the expected value and then writes, leaving a small window.
    concurrency: { writes: bridgeStatus.conditionalWritesSupported ? 'database_conditional' : 'read_then_write' },
    schemaIntent: summary ? { intent: summary.intent.intent, type: summary.intent.type, types: summary.intent.types, action: summary.intent.action, reasons: summary.intent.reasons, notes: summary.intent.notes } : null,
    evidence: summary ? { name: summary.name, factSources: summary.factSources, businessProfile: summary.businessProfile, logo: summary.logo, site: summary.site } : null,
    plan: {
      status: plan.status, code: plan.code, message: plan.message, fingerprint: plan.fingerprint,
      changes: plan.changes, preserved: plan.preserved, blocked: plan.blocked, notWritten: plan.notWritten,
    },
    proposedChanges: plan.changes.map((c) => ({ field: c.field, label: c.label, kind: c.kind, before: c.before, after: c.after, source: c.source, ...(c.afterLabel !== undefined ? { beforeLabel: c.beforeLabel, afterLabel: c.afterLabel } : {}) })),
    beforeState: { name: live.name, logo: live.logo, type: live.type, kind: live.kind, hasAddress: live.hasAddress, address: addressToWire(live.address), addressLabel: formatAddress(live.address), localSeoActive: live.localSeoActive },
    expectedAfterState: after.state,
    expectedEntity: after.entity,
    validation: after.validation,
    approvalStatus: record && ['approved', 'applying', 'apply_uncertain', 'applied', 'verifying', 'verified', 'verification_failed'].includes(record.status) ? 'approved' : (plan.status === 'ready' && after.validation.valid ? 'awaiting_approval' : 'not_available'),
    executionStatus: record ? record.status : (plan.status === 'ready' ? 'not_started' : 'not_applicable'),
    verificationStatus: record ? { saved: record.verification?.saved?.status || 'pending', rendered: record.verification?.rendered?.status || 'pending' } : { saved: 'pending', rendered: 'pending' },
    idempotencyKey: idempotencyKeyFor(task._id, plan.fingerprint),
    lifecycle: lifecycleOf(record, plan, after.validation),
    record: describeRecord(record),
    createdAt: record?.createdAt || null,
    updatedAt: record?.updatedAt || null,
  };
}


// ── writing one field, safely ────────────────────────────────────────────────

async function writeField(deps, connection, field, value, { expected, clear = false }) {
  // sameAs: one value per request through the Bridge's typed add/remove (it takes no expected value — see Security). `expected` is
  // the current state and `value` the target state, so an empty target removes the value that is currently there.
  if (sameAsAdapter.isSameAsField(field)) return sameAsAdapter.writeSameAsChange(deps, connection, expected, value);
  // breadcrumbs: Rank Math's site-wide switch through the Bridge's typed breadcrumbs.enabled route (a boolean; no expected value on the wire).
  if (breadcrumbAdapter.isBreadcrumbField(field)) return breadcrumbAdapter.writeBreadcrumbChange(deps, connection, expected, value);
  return deps.bridge.updateSiteSchemaField(connection, 'organization', field, clear ? '' : value, clear ? 'clear' : null, { expected });
}

// The address is an object on the wire; here (like every other field) it is one canonical string, so reconcile / restore / read-back
// compare it with the same string logic and a clear is simply "back to empty".
const readLive = async (deps, connection) => {
  const schema = await deps.bridge.getSiteSchema(connection);
  const org = schema.organization;
  // breadcrumbs_enabled: the site-wide breadcrumb switch as 'on' / '' (the breadcrumb fix has one change and reads it like any other field).
  return { ...org, address: addressToWire(org.address), breadcrumbs_enabled: schema.breadcrumbs?.enabled ? 'on' : '' };
};

const uncertain = (cause) => err(
  'OUTCOME_UNKNOWN',
  'WordPress did not confirm whether this change was saved, and the settings could not be re-read to find out. Nothing was repeated. Check the status in a moment: Odito will compare WordPress with what it tried to write before doing anything else.',
  502,
  { reason: 'outcome_unknown', cause: cause?.code || null },
);

/**
 * Writes ONE field in one direction and returns how that was established:
 *   direction 'apply'   before -> after, expecting `before`
 *   direction 'restore' after -> before, expecting `after`
 * A definite refusal or a conflict is thrown as is. An ambiguous failure is answered by READING the live value, never by
 * repeating: it landed (-> 'reconciled'), it did not land (-> one compare-and-set-protected retry), or somebody else changed it (-> CONFLICT).
 */
async function writeFieldReconciled(deps, connection, record, c, direction) {
  const from = direction === 'apply' ? c.before : c.after;
  const to = direction === 'apply' ? c.after : c.before;
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
    if (direction === 'apply') {
      // The intent is on disk BEFORE the request is sent: a crash after this line leaves `in_flight`, which recovery reconciles.
      c.writeState = 'in_flight'; c.attempts = (c.attempts || 0) + 1; c.startedAt = deps.now();
      await record.save();
    }
    try {
      const res = await writeField(deps, connection, c.field, to, { expected: from, clear: to === '' });
      return { via: 'response', operation: res?.operation || null };
    } catch (e) {
      if (classifyWriteError(e) !== 'ambiguous') throw e;
      lastError = e;
      let live;
      try { live = await readLive(deps, connection); } catch { throw uncertain(e); }
      const now = liveValueOf(live, c);
      if (sameValue(c.field, now, to)) return { via: 'reconciled', operation: null };
      if (!sameValue(c.field, now, from)) throw err('CONFLICT', 'A setting changed while the fix was being applied; nothing was overwritten.', 409, { reason: 'changed_during_write' });
      // Still the value it had before: the write did not land. The next loop iteration is the one bounded retry.
    }
  }
  throw lastError;
}

/** Writes every field not yet written (so a resumed fix never repeats a field that landed). Throws on the first problem. */
async function runWrites(deps, connection, record) {
  for (const c of record.changes) {
    if (c.applied) continue;
    try {
      const out = await writeFieldReconciled(deps, connection, record, c, 'apply');
      c.applied = true; c.writeState = 'landed'; c.attribution = out.via;
      c.operationId = out.operation?.id || null; c.atomic = out.operation ? out.operation.atomic === true : null;
      c.writeMode = out.operation ? (out.operation.atomic === true ? 'conditional_update' : 'read_then_write') : (out.via === 'response' ? 'read_then_write' : null);
      await record.save();
    } catch (e) {
      c.writeState = e?.details?.reason === 'outcome_unknown' ? 'unknown' : 'not_written';
      throw e;
    }
  }
}

/**
 * Puts back, in reverse order, every field this fix wrote — only while it still holds what Odito wrote. A field already at its
 * previous value counts as restored (a repeated rollback, or a rollback that stopped halfway, is not a conflict). Progress is
 * saved per field, so a crash leaves an accurate picture.
 */
async function restoreFields(deps, connection, record) {
  const restored = []; const conflicts = [];
  let live = null;
  try { live = await readLive(deps, connection); } catch { live = null; }
  for (const c of [...record.changes].reverse()) {
    if (!c.applied || c.restored) continue;
    const now = live ? liveValueOf(live, c) : null;
    if (now !== null && sameValue(c.field, now, c.before)) {
      c.restored = true; c.restoreState = 'already_restored'; restored.push(nameOf(c));
      await record.save();
      continue;
    }
    if (now !== null && !sameValue(c.field, now, c.after)) { c.restoreState = 'conflict'; conflicts.push(nameOf(c)); continue; } // a person's edit wins
    try {
      await writeFieldReconciled(deps, connection, record, c, 'restore');
      c.restored = true; c.restoreState = 'restored'; restored.push(nameOf(c));
      await record.save();
    } catch {
      c.restoreState = 'conflict'; conflicts.push(nameOf(c));
    }
  }
  return { restored, conflicts };
}

async function readbackSaved(deps, connection, changes) {
  const live = await readLive(deps, connection);
  const fields = changes.map((c) => {
    const actual = liveValueOf(live, c);
    return { field: c.field, expected: c.after, actual, ok: sameValue(c.field, actual, c.after) };
  });
  const failed = fields.filter((f) => !f.ok);
  return {
    status: failed.length ? 'failed' : 'verified',
    checkedAt: deps.now(),
    reasonCode: failed.length ? 'SAVED_VALUE_DIFFERS' : null,
    reasons: failed.map((f) => `${f.field}: WordPress holds "${f.actual}" instead of "${f.expected}".`),
    fields,
  };
}

const unreadable = (deps) => ({ status: 'unverifiable', checkedAt: deps.now(), reasonCode: 'WORDPRESS_UNREADABLE', reasons: ['WordPress could not be re-read right now.'], fields: [] });

// ── recovering a record left in flight ───────────────────────────────────────

const taskRecordsWrite = (task, record) => (task.fixHistory || []).some((h) => {
  const w = h?.fixApplied?.externalWrite;
  return w?.field === taskFieldOf(task) && w?.writtenAt && record.appliedAt && new Date(w.writtenAt).getTime() === new Date(record.appliedAt).getTime();
});

/** Moves the task to implemented exactly once for this record — also when an earlier attempt crashed between the two writes. */
async function ensureTaskRecorded(deps, task, record) {
  if (taskRecordsWrite(task, record) || !['task_created', 'reopened'].includes(task.status)) return false;
  await deps.taskHistory.applyImplementedTransition(task, {
    origin: 'wordpress_auto',
    recommendationId: task.recommendationId,
    externalWrite: { system: 'wordpress', provider: record.provider, field: taskFieldOf(task), wordpressPostId: null, httpStatus: 200, writtenAt: record.appliedAt, scope: 'site' },
    // The crawler's later verdict for a sameAs task is judged against exactly the URLs the owner approved.
    ...(isSameAsTask(task) ? { expectedAfterValueOverride: sameAsAdapter.taskExpectedAfter(record, null) } : {}),
    ...(isBreadcrumbTask(task) ? { expectedAfterValueOverride: breadcrumbAdapter.taskExpectedAfter() } : {}),
  });
  await saveTaskRecordingWrite(task, taskFieldOf(task), record.provider);
  return true;
}

/**
 * Reconciles a record whose writes may or may not have happened against what WordPress holds NOW. It never writes anything unless it
 * is putting back fields it can prove Odito wrote.
 *   complete   every planned field holds Odito's value  -> the apply is finished (only verification + the task are left)
 *   resume     some landed, the rest still hold their previous value, same approval, still within the resume window
 *   settled    nothing landed, someone else changed a field, or the approval is too old: written fields were put back
 */
async function recoverRecord(deps, connection, record, { allowResume }) {
  const live = await readLive(deps, connection); // cannot read -> throws; the record is left exactly as it is
  const pending = []; const conflicts = [];
  for (const c of record.changes) {
    if (c.applied) continue;
    const now = liveValueOf(live, c);
    if (sameValue(c.field, now, c.after)) { c.applied = true; c.writeState = 'landed'; c.attribution = 'reconciled'; }
    else if (sameValue(c.field, now, c.before)) { c.writeState = 'not_written'; pending.push(c.field); }
    else { c.writeState = 'not_written'; conflicts.push(c.field); }
  }
  const landed = record.changes.filter((c) => c.applied).map((c) => c.field);

  if (record.changes.length && !conflicts.length && !pending.length) {
    record.status = 'applying'; // finalized by the caller
    await record.save();
    return { kind: 'complete', landed };
  }
  if (landed.length && pending.length && !conflicts.length && allowResume && isResumable(record, deps.now())) {
    record.status = 'applying';
    await record.save(); // refreshes updatedAt so a parallel request sees it as live again
    return { kind: 'resume', landed, pending };
  }

  const { restored, conflicts: unrestored } = landed.length ? await restoreFields(deps, connection, record) : { restored: [], conflicts: [] };
  record.rollback.restoredFields = restored; record.rollback.conflictFields = unrestored;
  const changedByOthers = conflicts.length > 0;
  record.status = changedByOthers ? 'conflict_detected' : 'apply_failed';
  record.failure = {
    code: changedByOthers ? 'CONFLICT' : 'ABANDONED',
    message: changedByOthers
      ? 'A setting was changed by someone else while this fix was being applied; nothing was overwritten.'
      : (landed.length ? 'An earlier attempt was interrupted. The fields it had written were put back; approve a fresh preview to try again.' : 'An earlier attempt was interrupted before it changed anything.'),
  };
  await record.save();
  return { kind: 'settled', restored, unrestored };
}

// ── apply ────────────────────────────────────────────────────────────────────

/**
 * sameAs: the rendered page is fetched RIGHT NOW (same site only, cache-busted) and its JSON-LD inspected, so "WordPress saved it" is
 * never the whole answer. A page that cannot be fetched is `unverifiable`; a page that does not show the approved URLs on the intended
 * Organization is `failed` (the saved value may be right while a page cache or another markup source still serves the old one).
 */
async function verifyRenderedLive(deps, task, connection, expected, previous) {
  let result;
  try {
    result = await deps.verifyLiveRendered({ pageUrl: task.pageUrl, siteUrl: connection.site_url, expected });
  } catch (e) {
    result = { status: 'unverifiable', code: e?.code || 'RENDER_CHECK_FAILED', reasons: ['The public page could not be checked right now.'], checks: [] };
  }
  return {
    status: result.status === 'verified' ? 'verified' : result.status === 'failed' ? 'failed' : 'unverifiable',
    reasonCode: result.status === 'verified' ? null : (result.code || null),
    attempts: (previous?.attempts || 0) + 1,
    checkedAt: deps.now(),
    reasons: result.reasons || [],
    crawledAt: null,
    fields: (result.checks || []).map((c) => ({ field: c.name, expected: 'ok', actual: c.ok ? 'ok' : (c.detail || 'failed'), ok: c.ok })),
  };
}

/**
 * breadcrumbs: the public pages are fetched RIGHT NOW. The confirmed page must publish exactly ONE valid BreadcrumbList whose trail is the
 * confirmed one; the other pages of this site-wide change are checked one by one and listed (each keeps its own finding until its own page
 * is re-analysed). A page that cannot be fetched is `unverifiable`, never a success.
 */
async function verifyBreadcrumbLive(deps, record, previous) {
  let result;
  try {
    result = await deps.verifyBreadcrumbRollout(breadcrumbAdapter.rolloutInputFromRecord(record));
  } catch (e) {
    result = { status: 'unverifiable', code: e?.code || 'RENDER_CHECK_FAILED', reasons: ['The public pages could not be checked right now.'], checks: [], pages: [] };
  }
  return breadcrumbAdapter.rolloutToPart(result, { attempts: (previous?.attempts || 0) + 1, now: deps.now() });
}

const settleStatus = (record, saved, rendered) => {
  if (!['applied', 'verifying', 'verification_failed', 'verified'].includes(record.status)) return record.status;
  if (saved.status === 'failed' || rendered.status === 'failed') return 'verification_failed';
  return saved.status === 'verified' && rendered.status === 'verified' ? 'verified' : 'applied';
};

/** Verification + task bookkeeping that must happen exactly once after the writes — idempotent, so recovery can call it too. */
async function finalizeApplied(deps, task, connection, record, { fresh }) {
  if (record.status === 'applying') {
    record.appliedAt = record.appliedAt || deps.now();
    record.status = 'applied';
    await record.save();
    log('wordpress_fix_applied', task, { fields: record.changes.map(nameOf).join(','), fixId: record._id });
  }
  if (!record.verification?.saved || record.verification.saved.status === 'pending') {
    // Saved-state verification: read the values back from WordPress. NOT the rendered page, NOT authoritative.
    let saved;
    try { saved = await readbackSaved(deps, connection, record.changes); } catch { saved = unreadable(deps); }
    record.verification.saved = saved;
    if (verifiesLive(task) && saved.status === 'verified') {
      // Immediate rendered check on the public page; the crawler's verdict (task verified_fixed) still comes later.
      record.verification.rendered = isBreadcrumbTask(task)
        ? await verifyBreadcrumbLive(deps, record, null)
        : await verifyRenderedLive(deps, task, connection, sameAsAdapter.expectationFromRecord(record), null);
      record.status = settleStatus(record, saved, record.verification.rendered);
    } else {
      record.verification.rendered = { status: 'pending', reasonCode: 'NO_POST_WRITE_CRAWL', attempts: 0, reasons: ['The rendered page is checked on the next recrawl.'], fields: [] };
      if (saved.status === 'failed') record.status = 'verification_failed';
    }
    await record.save();
    log('wordpress_fix_verified', task, { saved: saved.status, fixId: record._id });
  }
  await ensureTaskRecorded(deps, task, record);
  const saved = record.verification.saved;
  const rendered = record.verification.rendered;
  // sameAs is only "success" when the public page shows it too; the Organization fix keeps its saved-state meaning (its rendered
  // check is the next recrawl's).
  const immediate = verifiesLive(task)
    ? (saved.status === 'failed' || rendered?.status === 'failed' ? 'failed' : saved.status === 'verified' && rendered?.status === 'verified' ? 'success' : 'unknown')
    : (saved.status === 'verified' ? 'success' : saved.status === 'failed' ? 'failed' : 'unknown');
  return { task, fix: describeRecord(record), alreadyApplied: !fresh, immediateVerification: immediate };
}

export async function applyOrganizationFix(task, { approved, expectedPlanFingerprint, actorId = null, urls, removeUrls } = {}, overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  log('wordpress_fix_started', task);

  if (approved !== true) throw err('WRITE_FAILED', 'This fix must be explicitly approved before it can be applied.', 400);
  if (typeof expectedPlanFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(expectedPlanFingerprint)) {
    throw err('EXPECTED_STATE_REQUIRED', 'Preview the fix and send its plan fingerprint so Odito can confirm nothing changed since you reviewed it.', 400);
  }
  if (task.issueKey !== ISSUE_KEY && !isSameAsTask(task) && !isBreadcrumbTask(task)) throw err('FIELD_NOT_WRITABLE', 'This issue type is not handled by the Organization fix.', 422);
  const sameAs = isSameAsTask(task);

  await assertRecommendationLinked(task);
  const connection = await deps.wordPressService.getHydratedConnectionOrThrow(task.projectId);
  assertPageInScope(task, connection);
  const breadcrumb = isBreadcrumbTask(task);
  const bridgeStatus = await requireCapableBridge(deps, connection, { sameAs: sameAs || breadcrumb });

  // A record left in flight by a crash or a timeout is reconciled against WordPress BEFORE anything new is planned or written.
  let resumed = null;
  const inflight = await findInFlightRecord(deps, { taskId: task._id, fixType: fixTypeOf(task) });
  if (inflight) {
    if (!isAbandoned(inflight, deps.now())) {
      throw err('CONFLICT', 'This fix is already being applied. Wait for it to finish.', 409, { reason: 'fix_in_progress', fixId: inflight._id });
    }
    const outcome = await recoverRecord(deps, connection, inflight, { allowResume: inflight.planFingerprint === expectedPlanFingerprint });
    log('wordpress_fix_recovered', task, { outcome: outcome.kind, fixId: inflight._id });
    if (outcome.kind === 'complete') return { ...(await finalizeApplied(deps, task, connection, inflight, { fresh: false })), recovered: true };
    if (outcome.kind === 'resume') resumed = inflight;
  }

  assertTransitionAllowed(task);

  let record = resumed;
  if (!record) {
    // The plan is rebuilt from the SAME input the owner reviewed (for sameAs: the exact URLs, validated again) and compared with the
    // fingerprint of the preview they approved; nothing the client sends is trusted beyond that.
    let built;
    if (sameAs) {
      try {
        built = await sameAsAdapter.buildSameAsPlan({ task, deps, connection, bridgeStatus, unavailable: null, input: { urls, removeUrls } });
      } catch (e) {
        if (e instanceof sameAsAdapter.SameAsInputError) throw fromTyped(e);
        throw e;
      }
    } else if (breadcrumb) {
      // Rebuilt from the server's own state: the confirmed trail, the live page, WordPress. The client sends only the fingerprint it approved.
      built = await breadcrumbAdapter.buildBreadcrumbPlan({ task, deps, connection, bridgeStatus, unavailable: null });
    } else {
      built = await buildPlan(task, deps, connection, bridgeStatus);
    }
    const { plan, evidence, live, entity, selection, removeUrls: removals } = built;

    if (plan.fingerprint !== expectedPlanFingerprint) {
      log('wordpress_fix_conflict', task, { reason: 'preview_stale' });
      throw err('CONFLICT', 'The WordPress settings or the site evidence changed since this fix was previewed. Review the refreshed preview and approve it again.', 409, { reason: 'preview_stale', currentFingerprint: plan.fingerprint });
    }
    if (plan.status === 'unsupported') throw err('FIELD_NOT_WRITABLE', plan.message, 422, { reason: plan.code });
    if (plan.status !== 'ready') throw err('VALIDATION_FAILED', plan.message || 'There is nothing safe to apply for this issue.', 422, { reason: plan.code, planStatus: plan.status });
    const after = sameAs ? sameAsAdapter.expectedAfterSameAs({ plan, entity, live, selection, removeUrls: removals })
      : breadcrumb ? breadcrumbAdapter.expectedAfterBreadcrumb({ plan, trail: built.trail })
        : expectedAfter(evidence, plan, live);
    if (!after.validation.valid) throw err('VALIDATION_FAILED', `The planned organization markup did not pass validation: ${after.validation.errors.join(' ')}`, 422, { reason: 'markup_invalid' });

    const idempotencyKey = idempotencyKeyFor(task._id, plan.fingerprint, fixTypeOf(task));
    let structuredDataBefore = null;
    if (!sameAs && plan.changes.some((c) => c.field === 'address')) {
      try {
        const pageBefore = await deps.loadPageDoc(task.projectId, task.pageUrl);
        if (pageBefore?.structured_data) structuredDataBefore = { capturedAt: deps.now(), crawledAt: pageBefore.scraped_at || null, nodes: structuredDataInventory(pageBefore.structured_data) };
      } catch { structuredDataBefore = null; }
    }
    const claim = await claimFixRecord(deps, {
      projectId: task.projectId, connectionId: connection._id, taskId: task._id, fixType: fixTypeOf(task), targetUrl: task.pageUrl,
      scope: 'site', provider: bridgeStatus.provider,
      ...(sameAs
        ? { target: sameAsAdapter.recordTarget({ plan, entity, live, task }) }
        : breadcrumb ? { target: breadcrumbAdapter.recordTarget({ plan, trail: built.trail, display: built.display, task, connection }) }
        : { schemaIntent: { intent: evidence.organization.intent.intent, type: evidence.organization.intent.type, action: evidence.organization.intent.action } }),
      planFingerprint: plan.fingerprint, idempotencyKey, structuredDataBefore,
      changes: plan.changes.map((c) => ({ field: c.field, before: c.before, after: c.after, source: c.source })),
      approvedBy: actorId, approvedAt: deps.now(),
    });
    if (!claim.claimed) {
      const existing = claim.record;
      if (['applied', 'verifying', 'verified', 'verification_failed'].includes(existing.status)) {
        log('wordpress_fix_skipped', task, { reason: 'already_applied', fixId: existing._id });
        // An earlier attempt may have crashed after the writes but before verification or the task update: finish that, once.
        return finalizeApplied(deps, task, connection, existing, { fresh: false });
      }
      throw err('CONFLICT', 'This fix is already being applied. Wait for it to finish.', 409, { reason: 'fix_in_progress', fixId: existing._id });
    }
    record = claim.record;
  }

  // Per-field compare-and-set write: a value somebody changed since the plan was made is never overwritten.
  try {
    await runWrites(deps, connection, record);
  } catch (e) {
    if (e?.details?.reason === 'outcome_unknown') {
      // We could not even read WordPress to find out. Do NOT restore or repeat anything: that would be acting on a guess.
      record.status = 'apply_uncertain';
      record.failure = { code: 'OUTCOME_UNKNOWN', message: 'WordPress did not confirm whether a change was saved; it will be reconciled before anything else is done.' };
      await record.save();
      log('wordpress_fix_uncertain', task, { fixId: record._id });
      e.details = { ...(e.details || {}), fixId: record._id };
      throw e;
    }
    const { restored, conflicts } = await restoreFields(deps, connection, record);
    const conflict = e?.code === 'CONFLICT';
    record.status = conflict ? 'conflict_detected' : (e?.code === 'PERMISSION_DENIED' ? 'permission_denied' : 'apply_failed');
    record.failure = { code: e?.code || 'UNKNOWN_ERROR', message: conflict ? 'A setting changed while the fix was being applied; nothing was overwritten.' : (e?.message || 'WordPress rejected the change.').slice(0, 300) };
    record.rollback.restoredFields = restored; record.rollback.conflictFields = conflicts;
    await record.save();
    log('wordpress_fix_failed', task, { code: e?.code || 'UNKNOWN_ERROR', restored: restored.join(','), unrestored: conflicts.join(','), fixId: record._id });
    const out = e instanceof WordPressConnectionError ? e : err('WRITE_FAILED', 'Failed to write this change to WordPress.', 502);
    out.details = { ...(out.details || {}), fixId: record._id, restoredFields: restored, unrestoredFields: conflicts };
    throw out;
  }

  return finalizeApplied(deps, task, connection, record, { fresh: true });
}

// ── reverify ─────────────────────────────────────────────────────────────────

const PENDING_CODES = new Set(['NO_POST_WRITE_CRAWL', 'PAGE_NOT_CRAWLED']);

/** Maps the crawler-based verdict onto pending (wait for a recrawl) / unverifiable (cannot be judged) / failed (observed and wrong). */
function renderedPart(deps, inspection, pageDoc, previous) {
  const status = inspection.status === 'verified' ? 'verified'
    : inspection.status === 'failed' ? 'failed'
      : (PENDING_CODES.has(inspection.code) ? 'pending' : 'unverifiable');
  return {
    status,
    reasonCode: status === 'verified' ? null : (inspection.code || (status === 'failed' ? 'RENDERED_DIFFERS' : null)),
    attempts: (previous?.attempts || 0) + 1,
    checkedAt: deps.now(),
    reasons: inspection.reasons,
    crawledAt: pageDoc?.scraped_at || null,
    fields: [],
  };
}

/** After a rollback: the page must not describe the organization twice (e.g. Rank Math's entity plus a leftover one). */
async function inspectRenderedAfterRollback({ pageDoc, rolledBackAt }) {
  if (!pageDoc?.url) return { status: 'unverifiable', code: 'PAGE_NOT_CRAWLED', reasons: ['The page was not found in the latest crawl.'] };
  const scraped = pageDoc.scraped_at ? new Date(pageDoc.scraped_at) : null;
  if (!scraped || Number.isNaN(scraped.getTime()) || (rolledBackAt && scraped < new Date(rolledBackAt))) {
    return { status: 'unverifiable', code: 'NO_POST_WRITE_CRAWL', reasons: ['The page has not been re-crawled since the rollback, so it could not be inspected.'] };
  }
  const nodes = flattenJsonLd(pageDoc.structured_data);
  const org = analyzeOrganizations(nodes, { siteUrl: new URL(pageDoc.url).origin + '/' });
  if (org.conflictingEntities || org.duplicateIds.length) {
    return { status: 'failed', code: 'DUPLICATE_ENTITIES', reasons: [`After the rollback the page still describes the organization more than once (${org.entityCount} entities).`] };
  }
  return { status: 'verified', code: null, reasons: [] };
}

/** What the rendered page must show, from the record: the schema intent plus (for an address fix) the approved address and the entities that must survive. */
function intendedFromRecord(record) {
  if (!record.schemaIntent?.type) return null;
  const addressChange = (record.changes || []).find((c) => c.field === 'address' && c.applied && !c.restored);
  const wanted = addressChange ? addressFromWire(addressChange.after) : {};
  return {
    type: record.schemaIntent.type, action: record.schemaIntent.action,
    ...(Object.keys(wanted).length ? { address: wanted } : {}),
    ...(addressChange && record.structuredDataBefore?.nodes?.length ? { preservedNodes: record.structuredDataBefore.nodes } : {}),
  };
}

export async function reverifyOrganizationFix(task, overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  const record = await latestRecord(deps, task);
  if (!record) throw err('VALIDATION_FAILED', 'No Organization fix has been applied for this task yet.', 404);
  const connection = await deps.wordPressService.getHydratedConnectionOrThrow(task.projectId);

  // Re-checking is also how an uncertain or abandoned apply gets reconciled: read WordPress, then decide.
  if (['applying', 'apply_uncertain'].includes(record.status)) {
    if (!isAbandoned(record, deps.now())) throw err('CONFLICT', 'This fix is still being applied.', 409, { reason: 'fix_in_progress', fixId: record._id });
    const outcome = await recoverRecord(deps, connection, record, { allowResume: false });
    log('wordpress_fix_recovered', task, { outcome: outcome.kind, fixId: record._id });
    if (outcome.kind === 'complete') await finalizeApplied(deps, task, connection, record, { fresh: false });
    return { fix: describeRecord(record) };
  }

  const pageDoc = await deps.loadPageDoc(task.projectId, task.pageUrl);

  if (record.status === 'rolled_back') return reverifyRollback(deps, connection, record, pageDoc);

  let saved;
  try { saved = await readbackSaved(deps, connection, record.changes); } catch { saved = unreadable(deps); }

  // Rendered state. Organization: what the latest crawl of the public page contains — never fetched here (a manual recrawl is a billed,
  // separate action) and a crawl older than the write says nothing about it. sameAs: the public page is fetched now (one same-site
  // GET, no billing) and its JSON-LD inspected, because a re-check is exactly when a page cache has had time to expire.
  let rendered;
  if (isBreadcrumbTask(task)) {
    rendered = await verifyBreadcrumbLive(deps, record, record.verification?.rendered);
  } else if (isSameAsTask(task)) {
    rendered = await verifyRenderedLive(deps, task, connection, sameAsAdapter.expectationFromRecord(record), record.verification?.rendered);
  } else {
    const site = await deps.loadSite(task.projectId);
    const inspection = await deps.verifyRendered({
      issueKey: ISSUE_KEY, pageDoc, implementedAt: record.appliedAt,
      intendedOrganization: intendedFromRecord(record), site,
    });
    rendered = renderedPart(deps, inspection, pageDoc, record.verification?.rendered);
  }
  record.verification.saved = { ...saved, attempts: (record.verification?.saved?.attempts || 0) + 1 };
  record.verification.rendered = rendered;
  if (['applied', 'verifying', 'verification_failed', 'verified'].includes(record.status)) {
    record.status = saved.status === 'failed' || rendered.status === 'failed' ? 'verification_failed' : (saved.status === 'verified' && rendered.status === 'verified' ? 'verified' : 'applied');
  }
  await record.save();
  // An earlier attempt may have died between "applied" and the task update: finish that here, once.
  if (record.appliedAt) await ensureTaskRecorded(deps, task, record);
  return { fix: describeRecord(record) };
}

/** A rolled-back fix is re-checked the same two ways: WordPress holds the previous values, and the page has no duplicate entity. */
async function reverifyRollback(deps, connection, record, pageDoc) {
  const restoredChanges = record.changes.filter((c) => c.applied && c.restored);
  let saved;
  try {
    const live = await readLive(deps, connection);
    const fields = restoredChanges.map((c) => {
      const actual = liveValueOf(live, c);
      return { field: c.field, expected: c.before, actual, ok: sameValue(c.field, actual, c.before) };
    });
    const bad = fields.filter((f) => !f.ok);
    saved = { status: bad.length ? 'failed' : 'verified', checkedAt: deps.now(), reasonCode: bad.length ? 'SAVED_VALUE_DIFFERS' : null, reasons: bad.map((f) => `${f.field}: WordPress holds "${f.actual}" instead of the restored "${f.expected}".`), fields };
  } catch { saved = unreadable(deps); }
  record.rollback.saved = { ...saved, attempts: (record.rollback.saved?.attempts || 0) + 1 };
  if (record.fixType === BREADCRUMB_FIX_TYPE) {
    // Switched off again: the confirmed page must no longer publish a BreadcrumbList from this setting. 'failed / NOT_IN_RENDERED_PAGE' is the SUCCESS here.
    let result;
    try { result = await deps.verifyBreadcrumbPage({ pageUrl: record.targetUrl, siteUrl: connection.site_url, displayUrl: record.target?.displayUrl || null, intended: null }); } catch (e) { result = { status: 'unverifiable', code: e?.code || 'RENDER_CHECK_FAILED', reasons: ['The public page could not be checked right now.'], checks: [] }; }
    const gone = result.status === 'failed' && result.code === 'NOT_IN_RENDERED_PAGE';
    record.rollback.rendered = {
      status: gone ? 'verified' : result.status === 'verified' ? 'failed' : 'unverifiable',
      reasonCode: gone ? null : (result.status === 'verified' ? 'STILL_PUBLISHED' : (result.code || null)), attempts: (record.rollback.rendered?.attempts || 0) + 1, checkedAt: deps.now(), crawledAt: null,
      reasons: gone ? [] : (result.status === 'verified' ? ['The page still publishes a BreadcrumbList - a page cache may still serve the old copy, or another source produces it.'] : (result.reasons || [])), fields: [],
    };
  } else if (record.fixType === SAMEAS_FIX_TYPE) {
    // The page must again show the previous values: the added profiles gone, a removed one back, nothing else changed.
    record.rollback.rendered = await verifyRenderedLive(deps, { pageUrl: record.targetUrl }, connection, sameAsAdapter.rollbackExpectation(record), record.rollback.rendered);
  } else {
    const inspection = await deps.inspectAfterRollback({ pageDoc, rolledBackAt: record.rollback?.at });
    record.rollback.rendered = renderedPart(deps, inspection, pageDoc, record.rollback.rendered);
  }
  if (saved.status === 'verified' && record.rollback.status === 'applied') record.rollback.status = 'verified';
  await record.save();
  return { fix: describeRecord(record) };
}

// ── rollback ─────────────────────────────────────────────────────────────────

export async function rollbackOrganizationFix(task, { actorId = null } = {}, overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  const record = await latestRecord(deps, task);
  if (!record) throw err('VALIDATION_FAILED', 'There is no applied Organization change to roll back for this task.', 404);
  const connection = await deps.wordPressService.getHydratedConnectionOrThrow(task.projectId);
  const bridgeStatus = await requireCapableBridge(deps, connection, { sameAs: isSameAsTask(task) || isBreadcrumbTask(task) });

  // An apply that never finished is reconciled first: what WordPress really holds decides what can be rolled back.
  if (['applying', 'apply_uncertain'].includes(record.status)) {
    if (!isAbandoned(record, deps.now())) throw err('CONFLICT', 'This fix is still being applied.', 409);
    await recoverRecord(deps, connection, record, { allowResume: false });
  }

  const outstanding = record.changes.some((c) => c.applied && !c.restored);
  const unverified = record.rollback?.status === 'applied';
  if (!outstanding && !unverified && !['requested', 'partial_conflict'].includes(record.rollback?.status)) {
    throw err('VALIDATION_FAILED', 'There is no applied Organization change to roll back for this task.', 404);
  }

  // Intent first: if the process dies mid-rollback this is what recovery and the UI see.
  if (outstanding) {
    record.rollback.status = 'requested'; record.rollback.requestedAt = deps.now(); record.rollback.by = actorId;
    await record.save();
  }
  const { restored, conflicts } = outstanding ? await restoreFields(deps, connection, record) : { restored: [], conflicts: [] };
  const allRestored = record.changes.filter((c) => c.applied).every((c) => c.restored);
  const restoredFields = record.changes.filter((c) => c.applied && c.restored).map(nameOf);

  record.rollback.at = deps.now(); record.rollback.by = actorId;
  record.rollback.restoredFields = restoredFields; record.rollback.conflictFields = conflicts;
  if (allRestored) {
    record.rollback.status = 'applied';
    record.status = 'rolled_back';
  } else {
    record.rollback.status = restoredFields.length ? 'partial_conflict' : 'failed';
  }
  await record.save();

  if (allRestored) {
    // Rolled back is only "verified" once the saved settings are read back and equal the previous values.
    const pageDoc = await deps.loadPageDoc(task.projectId, task.pageUrl);
    await reverifyRollback(deps, connection, record, pageDoc);
  }
  log('wordpress_fix_rolled_back', task, { restored: restored.join(','), conflicts: conflicts.join(','), provider: bridgeStatus.provider, fixId: record._id, rollback: record.rollback.status });
  return {
    fix: describeRecord(record),
    message: conflicts.length
      ? `Restored ${restoredFields.length ? restoredFields.join(', ') : 'nothing'}; ${conflicts.join(', ')} was changed after Odito wrote it, so it was left as it is now. Edit it in Rank Math if you want it reverted.`
      : 'Restored the previous values. Recrawl the page to confirm the rendered output.',
  };
}

export default { getOrganizationFixPreview, applyOrganizationFix, reverifyOrganizationFix, rollbackOrganizationFix, idempotencyKeyFor };
