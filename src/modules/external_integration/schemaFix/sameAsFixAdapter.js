/**
 * sameAsFixAdapter — everything the shared Organization fix engine (organizationFixService.js) needs to know about ONE kind of
 * change: a single Organization `sameAs` value being added or removed. The engine already provides the ledger, the per-change
 * write → reconcile → restore loop, crash recovery, rollback and read-back; this file only supplies what is specific to sameAs:
 *
 *   - planning input (discovery is separate; here: entity + the owner's validated selection + the live Rank Math state)
 *   - how a change reads its CURRENT state out of the live settings (a sameAs value is present or absent)
 *   - how a change is written (the Bridge's typed organization.sameAs add/remove — one value per request) and restored
 *   - the deterministic expected JSON-LD, its validation, and the preview payload the panel renders
 *   - what the rendered page must show afterwards (live same-site fetch of the page, intended entity, exact URLs)
 *
 * One change = one URL. 'add':    before '' → after <url>.   'remove':  before <stored url> → after ''.
 */

import { resolveSameAsEntity } from '../../schema-evidence/sameAs/sameAsEntity.js';
import { evaluateProfileUrl, profileKey, validateProfileList, PROFILE_LIMITS } from '../../schema-evidence/sameAs/profileUrl.js';
import { buildSameAsPatch, renderRecommendedJsonLd } from '../../schema-evidence/sameAs/sameAsMarkup.js';
import { planSameAsFix, SAMEAS_FIX_TYPE } from './sameAsFixPlan.js';

export const SAMEAS_FIELD = 'sameAs';
export const isSameAsField = (field) => field === SAMEAS_FIELD;

/** The URL a change is about: the added value, or the stored value being removed. */
export const changeUrl = (c) => (c.after !== '' && c.after != null ? c.after : c.before);

const present = (live, url) => {
  const k = profileKey(url);
  return !!k && (live?.sameAs || []).some((v) => profileKey(v) === k);
};

/** The live state of one change as a string, comparable with c.before / c.after: the URL when it is published, '' when it is not. */
export const stateOfChange = (live, c) => (present(live, changeUrl(c)) ? changeUrl(c) : '');

/** Two states are the same when both are empty, or both name the same profile (www / scheme / slash / network-alias insensitive). */
export const sameSameAsState = (a, b) => {
  const x = String(a ?? ''); const y = String(b ?? '');
  if (x === '' || y === '') return x === y;
  return profileKey(x) === profileKey(y);
};

/** Writes ONE change in one direction. `to` empty = the value is removed (`from` is the exact stored string); otherwise it is added. */
export function writeSameAsChange(deps, connection, from, to) {
  const adding = to !== '';
  return deps.bridge.updateSiteSchemaField(connection, 'organization', SAMEAS_FIELD, adding ? to : from, adding ? 'add' : 'remove');
}

const originOf = (url) => { try { return `${new URL(url).origin}/`; } catch { return ''; } };

/** Bad input from the owner (an invalid link, a malformed list): the service turns it into the HTTP-shaped error every handler understands. */
export class SameAsInputError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'SameAsInputError';
    this.code = code; this.status = status; this.details = details;
  }
}
const typed = (code, message, status, details) => new SameAsInputError(code, message, status, details);

/**
 * Validates the owner's selection (shape AND content) and returns the plan. Throws a `SameAsInputError` for bad input; the
 * service turns it into its WordPressConnectionError. Works without a WordPress connection (`connection === null`): the plan is then
 * `unsupported` with manual instructions, so discovery and the recommended JSON-LD are never blocked by a missing integration.
 */
export async function buildSameAsPlan({ task, deps, connection, bridgeStatus, unavailable = null, input = {} }) {
  const siteUrl = connection?.site_url || originOf(task.pageUrl);
  const urls = input.urls ?? [];
  const parsed = validateProfileList(urls, { siteUrl, source: 'manual', max: PROFILE_LIMITS.maxProfilesPerRequest });
  if (!parsed.valid) throw typed('INVALID_PROFILES', 'One or more profile links are not valid.', 400, { errors: parsed.errors });

  const removeUrls = input.removeUrls ?? [];
  if (!Array.isArray(removeUrls) || removeUrls.length > PROFILE_LIMITS.maxProfilesPerRequest || removeUrls.some((v) => typeof v !== 'string' || v.length > PROFILE_LIMITS.maxUrlLength)) {
    throw typed('INVALID_PROFILES', 'removeUrls must be a short list of URLs.', 400, { errors: [{ index: null, code: 'INVALID_REMOVALS', message: 'removeUrls must be a short list of URLs.' }] });
  }

  const pages = await deps.loadSitePages(task.projectId);
  const entity = resolveSameAsEntity({ pages, pageUrl: task.pageUrl });

  let live = null;
  if (connection && bridgeStatus && !unavailable) live = (await deps.bridge.getSiteSchema(connection)).organization;

  const selection = parsed.items.map((i) => ({ ...i, origin: 'owner_approved' }));
  const plan = planSameAsFix({
    selection, removals: removeUrls, entity, site: live || {}, provider: unavailable ? 'none' : (bridgeStatus?.provider ?? 'none'), unavailable,
    context: { projectId: task.projectId, connectionId: connection?._id ?? null, pageUrl: task.pageUrl },
    capabilities: { siteSchemaSupported: !!bridgeStatus?.siteSchemaSupported },
  });
  return { plan, entity, live, selection, removeUrls };
}

/**
 * What the Organization publishes after the change: the existing entity with exactly the approved sameAs change and nothing else.
 * For a plan that cannot be applied automatically (another SEO plugin, WordPress not connected …) the same JSON-LD is still produced
 * from the owner's selection, so the manual path shows the same structured data an automatic apply would have produced.
 */
export function expectedAfterSameAs({ plan, entity, live, selection = [], removeUrls = [] }) {
  const ready = plan.status === 'ready';
  const adds = ready ? plan.changes.filter((c) => c.kind === 'add').map((c) => c.after) : (plan.status === 'unsupported' || plan.status === 'nothing_to_change' ? selection.map((s) => s.url) : []);
  const removes = ready ? plan.changes.filter((c) => c.kind === 'remove').map((c) => c.before) : (plan.status === 'unsupported' ? removeUrls : []);
  const crawled = entity?.entity?.node || null;
  // The base is what is published NOW. With the live Rank Math list available it replaces the crawled one (the crawl can lag behind a
  // settings change); without it (no WordPress access) the crawled node is the best evidence there is.
  let base = crawled ? { ...crawled } : null;
  if (base && live) {
    const liveList = live.sameAs || [];
    if (liveList.length) base.sameAs = liveList; else delete base.sameAs;
  }
  const patch = base ? buildSameAsPatch({ node: base, add: adds, remove: removes }) : null;

  const errors = [];
  const warnings = [];
  if (!patch) errors.push('There is no Organization entity to attach the profiles to.');
  else {
    if (entity.entity.id && patch.node['@id'] !== entity.entity.id) errors.push('The Organization @id would change.');
    if ('sameAs' in patch.node && (!Array.isArray(patch.node.sameAs) || !patch.node.sameAs.length)) errors.push('sameAs would be written empty.');
    const keys = (patch.sameAs || []).map((v) => (typeof v === 'string' ? profileKey(v) : null)).filter(Boolean);
    if (new Set(keys).size !== keys.length) errors.push('sameAs would contain the same profile twice.');
    for (const c of plan.changes.filter((x) => x.kind === 'add')) {
      const r = evaluateProfileUrl(c.after, { siteUrl: entity?.entity?.url || undefined, source: 'manual' });
      if (!r.ok) errors.push(`${c.after}: ${r.message}`);
    }
    try { JSON.parse(JSON.stringify(patch.node)); } catch { errors.push('The structured data could not be serialised.'); }
    for (const w of plan.warnings || []) warnings.push(w.message);
  }
  return {
    patch, base,
    state: { sameAs: patch?.sameAs || [] },
    entity: patch?.node || null,
    validation: { valid: errors.length === 0, errors, warnings },
    beforeJsonLd: base ? renderRecommendedJsonLd(base) : null,
    recommendedJsonLd: patch ? renderRecommendedJsonLd(patch.node) : null,
  };
}

/** The sameAs-specific part of the preview payload. */
export function previewExtras({ plan, entity, live, after, record, lifecycle }) {
  const shared = !!entity?.scope?.shared;
  let panelState;
  if (plan.status === 'unsupported') panelState = 'unsupported_source';
  else if (record?.status === 'verified') panelState = 'applied_verified';
  else if (record?.status === 'verification_failed') panelState = 'verification_failed';
  else if (record?.status === 'rolled_back') panelState = 'rolled_back';
  else if (record && ['applied', 'verifying', 'applying', 'apply_uncertain'].includes(record.status)) panelState = 'applied_verification_pending';
  else if (plan.status === 'ready') panelState = after.validation.valid ? 'ready_to_apply' : 'validation_failed';
  else if (plan.code === 'NO_PROFILES_SELECTED') panelState = 'no_selection';
  else if (plan.code === 'ALREADY_PRESENT') panelState = 'already_present';
  else panelState = plan.status === 'blocked' ? 'blocked' : 'not_available';
  return {
    panelState,
    entity: entity?.entity ? { id: entity.entity.id, types: entity.entity.types, name: entity.entity.name, foundOn: entity.entity.foundOn, sameAsState: entity.state } : null,
    scope: { ...(entity?.scope || {}), kind: shared ? 'site_wide' : 'page_specific' },
    existing: entity?.existing?.raw || [],
    additions: plan.changes.filter((c) => c.kind === 'add').map((c) => ({ url: c.after, platform: c.platform, platformLabel: c.platformLabel })),
    removals: plan.changes.filter((c) => c.kind === 'remove').map((c) => ({ url: c.before })),
    alreadyPresent: plan.alreadyPresent,
    preserved: plan.preserved,
    warnings: plan.warnings,
    target: plan.target,
    manual: plan.manual,
    protectedSameAs: live?.protectedSameAs || [],
    additionalSameAs: live?.additionalSameAs || [],
    beforeJsonLd: after.beforeJsonLd,
    recommendedJsonLd: after.recommendedJsonLd,
    lifecycle,
  };
}

/** What a record's rendered verification must prove: persisted on the record so reverify never depends on the client. */
export function recordTarget({ plan, entity, live, task }) {
  const adds = plan.changes.filter((c) => c.kind === 'add').map((c) => c.after);
  const removes = plan.changes.filter((c) => c.kind === 'remove').map((c) => c.before);
  const removedKeys = new Set(removes.map(profileKey));
  return {
    kind: 'organization_same_as',
    entityId: entity?.entity?.id || null,
    pageUrl: task.pageUrl,
    approvedUrls: [...adds, ...plan.alreadyPresent.map((a) => a.url)],
    keptUrls: [...(live?.sameAs || [])].filter((v) => !removedKeys.has(profileKey(v))),
    removedUrls: removes,
    organizationsBefore: new Set((entity?.entities || []).filter((e) => e.pageUrl === task.pageUrl).map((e) => e.id || e.pageUrl)).size || 1,
    shared: !!entity?.scope?.shared,
    affectedPages: (entity?.scope?.affectedPages || []).slice(0, 200),
  };
}

/** Rendered-verification input from a record's persisted target and its changes (a rolled-back/failed change is not expected). */
export function expectationFromRecord(record) {
  const t = record.target || {};
  const live = (record.changes || []).filter((c) => c.applied && !c.restored);
  return {
    entityId: t.entityId || null,
    add: [...new Set([...live.filter((c) => c.after !== '').map((c) => c.after), ...(t.approvedUrls || [])])],
    keep: t.keptUrls || [],
    remove: live.filter((c) => c.after === '').map((c) => c.before),
    organizationsBefore: t.organizationsBefore || 1,
  };
}

/** After a rollback the page must again show the previous values (the added ones gone, the removed ones back). */
export function rollbackExpectation(record) {
  const t = record.target || {};
  const restored = (record.changes || []).filter((c) => c.applied && c.restored);
  return {
    entityId: t.entityId || null,
    add: restored.filter((c) => c.before !== '').map((c) => c.before),
    keep: (t.keptUrls || []),
    remove: restored.filter((c) => c.before === '').map((c) => c.after),
    organizationsBefore: t.organizationsBefore || 1,
  };
}

/** The Task's frozen "after state": what TaskVerificationService looks for in the crawled Organization sameAs. */
export function taskExpectedAfter(record, liveAfter) {
  const urls = [...new Set([...(record.target?.approvedUrls || [])])];
  return { type: 'same_as', urls, additionalProfiles: liveAfter?.additionalSameAs || [] };
}

export default { buildSameAsPlan, expectedAfterSameAs, previewExtras, recordTarget, expectationFromRecord, rollbackExpectation, taskExpectedAfter, stateOfChange, sameSameAsState, writeSameAsChange, isSameAsField, changeUrl, SAMEAS_FIX_TYPE };
