/**
 * altFixService — list / preview / apply / reverify / rollback of ONE image's alt text through the WordPress media library.
 *
 * What it reuses: the core adapter's media reads, the Odito SEO Bridge's conditional alt write (1.5.0+, with a core-REST fallback that
 * is reported as NOT atomic), the Task lifecycle, the WordPressFixRecord ledger and its idempotency, the existing connection (encrypted
 * credentials, no redirects, timeouts), project/task ownership (checked by the controller before anything here runs).
 *
 * What the client may send: the URL of one of THIS task's flagged images (checked against the task's own findings), the alt text a
 * person wrote, an "informative" confirmation, the preview fingerprint and the approval. Never an attachment id, a field name or a
 * WordPress path: the attachment is resolved server-side from evidence (imageIdentity.js) and only `alt_text` is ever sent.
 *
 * Reliability rules (ADR 0009), shared with the Organization fix:
 *   - the intent to write is persisted BEFORE the request is sent (writeState in_flight);
 *   - an ambiguous outcome (timeout, dropped connection, 5xx) is answered by READING the attachment, never by blind repetition;
 *   - a record left in flight by a crash is reconciled against WordPress before anything else happens to it;
 *   - rollback is staged requested -> applied -> verified and only restores a value that still equals Odito's;
 *   - the task-level result is derived from the per-image records (altTargetRollup.js) and is never "verified" unless every changed image is.
 *
 * It never marks a Task verified: "applied" = WordPress accepted the write; "verified" = the saved alt reads back AND the recrawled
 * page renders it on the SAME image (matched by attachment evidence, never by file-name similarity).
 */

import mongoose from 'mongoose';
import wordPressService, { WordPressConnectionError } from '../service/wordPressService.js';
import oditoSeoBridgeService from '../service/oditoSeoBridgeService.js';
import WordPressCoreAdapter from '../adapters/wordpressCoreAdapter.js';
import WordPressFixRecord from '../model/WordPressFixRecord.js';
import taskHistoryService from '../../tasks/service/TaskHistoryService.js';
import {
  claimFixRecord, describeFixRecord, idempotencyKey, classifyWriteError, isAbandoned, IN_FLIGHT_STATUSES,
} from '../ledger/fixLedger.js';
import { attachmentExactPaths, exactMatches, hostKey, matchRenderedImages, observedUrlsOf } from './imageIdentity.js';
import { resolveImageIdentity } from './imageIdentityResolver.js';
import { inspectContentEmbedding } from './contentEmbedding.js';
import { KIND, classifySnapshot } from './imageResource.js';
import { ALT_FIELD, ALT_FIX_TYPE, planAltFix } from './altFixPlan.js';
import { SOURCE_LABEL, diagnoseAlt, instancesFromPageDoc } from './altDiagnosis.js';
import { TARGET_KIND, applyDivi, describeSource, finalizeDivi, recoverDivi, resolveDiviTarget, reverifyDivi, rollbackDivi } from './diviAltFix.js';
import { loadTargetPage, readPageById, writePageContent } from '../content/wordPressContentService.js';
import { detectDiviVersion } from '../content/diviVersion.js';
import { checkLiveImageAlt } from './liveAlt.js';
import { detectBuilder } from '../content/contentAdapterRegistry.js';
import { normalizeAlt as normalizeAltText, validateProposedAlt as validateAltText } from './altText.js';
import { normalizeAlt } from './altText.js';
import { deriveTargetStatus, retryability, summarizeTargets } from './altTargetRollup.js';
import Recommendation from '../../recommendations/model/Recommendation.js';
import { loadRecommendationSource, orderedEmptyAltSrcs, provenanceOf, recommendationForImage, REC_STATUS } from './altRecommendation.js';

const RULE_ID = 'images_missing_alt_text';
const MAX_ATTEMPTS = 3; // one write + two bounded retries; a retry only ever follows a read that proved the value did not land

const defaultDeps = () => ({
  wordPressService,
  bridge: oditoSeoBridgeService,
  makeAdapter: (connection) => new WordPressCoreAdapter(connection),
  Record: WordPressFixRecord,
  taskHistory: taskHistoryService,
  loadFlaggedImages: (task) => mongoose.connection.db.collection('seo_page_issues')
    .find({ projectId: task.projectId, page_url: task.pageUrl, rule_id: RULE_ID, status: 'open' }, { projection: { before_snapshot: 1 } }).toArray(),
  loadPageDoc: (task) => mongoose.connection.db.collection('seo_page_data').findOne({ projectId: task.projectId, url: task.pageUrl }),
  // The AI recommendation already made for this page (read-only; nothing is generated here).
  loadRecommendation: (task) => loadRecommendationSource(task, { Recommendation }),
  // A fresh read of the LIVE page, used only to tell a stale finding from a real mismatch (same-host fetch, exact-path matching).
  checkLiveAlt: (args) => checkLiveImageAlt(args),
  // Divi page-module target: the page's editable content and the Divi version (same-site, authenticated, no new HTTP path).
  loadPage: (connection, pageUrl) => loadTargetPage(connection, pageUrl),
  readPage: (connection, ref) => readPageById(connection, ref),
  writePage: (connection, page, content) => writePageContent(connection, page, content),
  diviVersion: (connection) => detectDiviVersion(connection.site_url),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => new Date(),
});

const log = (event, task, fields = {}) => console.log(`[WORDPRESS_FIX] ${event} | projectId=${task.projectId} | taskId=${task._id} | fixType=${ALT_FIX_TYPE} | ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' | ')}`);
const err = (code, message, status, details) => { const e = new WordPressConnectionError(code, message, status); if (details) e.details = details; return e; };

// ── the existing AI recommendation, reused per image (read-only) ─────────────

/** Never throws: a recommendation that cannot be read is reported as `unavailable`, and the preview/list still work. */
async function loadSourceSafely(deps, task) {
  try { return await deps.loadRecommendation(task); } catch { return null; }
}

/** The recommendation for ONE image: exact match, or (legacy text) a position-mapped suggestion, or the honest reason there is none. */
async function recommendationFor(deps, task, snapshot, source) {
  const src = source === undefined ? await loadSourceSafely(deps, task) : source;
  let orderedSrcs = [];
  if (src?.found && src.proposals === null) {
    try { orderedSrcs = orderedEmptyAltSrcs(await deps.loadPageDoc(task)); } catch { orderedSrcs = []; }
  }
  return recommendationForImage({ snapshot, source: src, orderedSrcs });
}

// ── the task's own findings ──────────────────────────────────────────────────

async function flaggedImageOrThrow(deps, task, imageSrc) {
  if (typeof imageSrc !== 'string' || !imageSrc || imageSrc.length > 2048) throw err('IMAGE_NOT_FLAGGED', 'Choose one of the images listed for this task.', 422);
  const docs = await deps.loadFlaggedImages(task);
  const doc = docs.find((d) => d.before_snapshot?.src === imageSrc);
  if (!doc) throw err('IMAGE_NOT_FLAGGED', 'This image is not one of the findings for this task, so it cannot be changed from here.', 422);
  return doc.before_snapshot;
}

async function latestRecordFor(deps, task, imageSrc) {
  return deps.Record.findOne({ taskId: task._id, fixType: ALT_FIX_TYPE, 'target.imageSourceUrl': imageSrc }).sort({ createdAt: -1 });
}

const inFlightRecordFor = (deps, task, imageSrc) => deps.Record.findOne({
  taskId: task._id, fixType: ALT_FIX_TYPE, 'target.imageSourceUrl': imageSrc, status: { $in: IN_FLIGHT_STATUSES },
}).sort({ createdAt: -1 });

/**
 * Every image of the task, one row each: the open findings PLUS every image Odito has a record for (a fixed image disappears from the
 * open findings after the next crawl, but its fix must stay visible and verifiable). Each row carries a derived status.
 */
export async function listAltImages(task, overrides = {}) {
  return (await collectAltImages(task, overrides)).items;
}

async function collectAltImages(task, overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  const docs = await deps.loadFlaggedImages(task);
  const records = await deps.Record.find({ taskId: task._id, fixType: ALT_FIX_TYPE }).sort({ createdAt: 1 });
  const latest = new Map(records.map((r) => [r.target?.imageSourceUrl, r]));
  const now = deps.now();

  const aiSource = await loadSourceSafely(deps, task);
  const toItem = (s, rec, inFindings) => {
    const targetStatus = deriveTargetStatus(rec, now);
    const resource = classifySnapshot(s, task.pageUrl);
    const aiHit = aiSource?.found && Array.isArray(aiSource.proposals) ? recommendationForImage({ snapshot: s, source: aiSource }) : null;
    return {
      // true only for an exact-match proposal with usable text (a legacy text-only recommendation is resolved in the preview).
      aiSuggestion: aiHit?.status === REC_STATUS.AVAILABLE,
      src: s.src, altState: s.altState || 'unknown', hasAttachmentHint: s.wpAttachmentId != null,
      // What the image IS, so the person sees up front whether the media library can hold its alt text at all. Only an upload can;
      // the exact attachment is still proven by the preview before anything is offered.
      resourceKind: resource.kind, mediaLibraryCandidate: resource.kind === KIND.WP_MEDIA,
      decorativeSignals: s.altState === 'empty' || s.ariaHidden || ['presentation', 'none'].includes(s.role),
      figcaption: s.figcaption || null,
      inFindings,
      targetStatus, ...retryability(targetStatus),
      fix: rec ? {
        status: rec.status, appliedAt: rec.appliedAt, alt: rec.changes?.[0]?.after || null,
        saved: rec.verification?.saved?.status || 'pending', rendered: rec.verification?.rendered?.status || 'pending',
        rollback: rec.rollback?.status || 'none',
      } : null,
    };
  };

  // A finding persisted before the crawler could tell a tracker from an image stays "open" until the page is next analysed. A tracker
  // is not an image: it is left out of the list (and counted, so the person is told) — unless Odito somehow holds a fix record for it.
  const allSnapshots = docs.map((d) => d.before_snapshot).filter((s) => s?.src);
  const isTracker = (s) => !classifySnapshot(s, task.pageUrl).actionable;
  const snapshots = allSnapshots.filter((s) => latest.has(s.src) || !isTracker(s));
  const ignoredTracking = allSnapshots.length - snapshots.length;
  const items = snapshots.map((s) => toItem(s, latest.get(s.src), true));
  const seen = new Set(snapshots.map((s) => s.src));
  for (const [src, rec] of latest) {
    if (!src || seen.has(src)) continue;
    items.push(toItem({ src, altState: rec.target?.altStateObserved || 'unknown' }, rec, false));
  }
  return { items, ignoredTracking };
}

/** The list plus the derived task-level roll-up (what the page says about "the alt-text fix" as a whole). */
export async function listAltImagesWithSummary(task, overrides = {}) {
  const { items: images, ignoredTracking } = await collectAltImages(task, overrides);
  return { images, summary: summarizeTargets(images), ignored: { trackingEndpoints: ignoredTracking } };
}

// ── transport: Bridge compare-and-swap when available, core REST otherwise ───────

/** The Bridge's conditional write when it is installed and new enough; otherwise the core PUT, reported as NOT atomic. */
async function chooseTransport(deps, connection) {
  try {
    const status = await deps.bridge.getBridgeStatus(connection);
    if (status?.installed && status.mediaAltSupported) return 'bridge';
  } catch { /* an unreachable Bridge route is the same as no Bridge: fall back */ }
  return 'core';
}

// ── analysis shared by preview and apply (read-only) ─────────────────────────

async function analyze(task, input, deps) {
  const snapshot = await flaggedImageOrThrow(deps, task, input.imageSrc);
  const connection = await deps.wordPressService.getHydratedConnectionOrThrow(task.projectId);
  const siteHost = hostKey(connection.site_url);
  if (!siteHost || hostKey(task.pageUrl) !== siteHost) {
    throw err('FIELD_NOT_WRITABLE', 'This page is not on the connected WordPress site, so its images cannot be changed through it.', 422, { reason: 'site_mismatch' });
  }
  const adapter = deps.makeAdapter(connection);
  const identity = await resolveImageIdentity({ adapter, snapshot, siteUrl: connection.site_url });

  let content = null;
  let builderLabel = null;
  if (identity.status === 'resolved') {
    try {
      const resolved = await deps.wordPressService.resolvePostIdFromUrl(connection, task.pageUrl);
      const raw = resolved ? await adapter.readPostRawContent(resolved.postType, resolved.postId) : null;
      content = inspectContentEmbedding(raw, { attachmentId: identity.attachmentId, exactPaths: identity.exactPaths });
      const builder = typeof raw === 'string' ? detectBuilder({ content: { raw } }) : null;
      builderLabel = builder && builder.name !== 'generic_html' && builder.name !== 'html' ? builder.label : null;
    } catch {
      content = { status: 'unknown' };
    }
  }

  // What the page really renders for THIS image, compared with what WordPress holds (read-only).
  let diagnosis = null;
  if (identity.status === 'resolved') {
    let instances = null;
    try { instances = instancesFromPageDoc(await deps.loadPageDoc(task), { attachmentId: identity.attachmentId, exactPaths: identity.exactPaths }); } catch { instances = null; }
    // Only when WordPress already holds meaningful alt text but the crawl says the page has none is a live re-read worth making:
    // it separates a stale finding from an override.
    let live = null;
    const libAlt = normalizeAltText(identity.media?.alt_text);
    if (libAlt && validateAltText(libAlt).ok && content?.status !== 'embedded') {
      try { live = await deps.checkLiveAlt({ pageUrl: task.pageUrl, siteUrl: connection.site_url, attachmentId: identity.attachmentId, exactPaths: identity.exactPaths }); } catch { live = { status: 'unavailable', instances: [] }; }
    }
    diagnosis = diagnoseAlt({ snapshot, media: identity.media, content, instances, live, builderLabel });
  }

  // When a Divi page-builder module names this image, find out whether it is the editable source of the rendered alt (read-only).
  let divi = null;
  if (identity.status === 'resolved' && content?.status === 'builder_reference' && diagnosis?.state !== 'stale_finding') {
    try { divi = await resolveDiviTarget({ deps, connection, task, identity, content }); } catch (e) {
      divi = { status: 'unsupported', code: 'DIVI_RESOLUTION_FAILED', message: `The Divi module could not be examined (${e?.message || 'unexpected error'}).` };
    }
    if (divi?.status === 'not_applicable') divi = null;
  }

  const plan = planAltFix({
    snapshot, identity, content, diagnosis, target: divi, proposedAlt: input.proposedAlt, informative: input.informative === true, siteHost,
    context: { projectId: task.projectId, connectionId: connection._id, pageUrl: task.pageUrl },
  });
  const transport = await chooseTransport(deps, connection);
  return { snapshot, connection, adapter, identity, content, plan, siteHost, transport, diagnosis, divi };
}

/** The comparison the person is shown: what the page renders, what WordPress holds, what draws the image, and who can change it. */
const diagnosisView = (d) => (d ? {
  state: d.state, source: d.source, sourceLabel: SOURCE_LABEL[d.source] || null, fixMechanism: d.fixMechanism, supported: d.supported,
  renderedAlt: d.renderedAlt, libraryAlt: d.libraryAlt, libraryMeaningful: d.libraryMeaningful, builder: d.builder,
  builderMayOverride: !!d.builderMayOverride, evidence: d.evidence, manual: d.manual,
  instances: { crawl: d.instances.crawl.length, live: d.instances.live ? { status: d.instances.live.status, occurrences: d.instances.live.occurrences.length } : null },
} : null);

/** Where a change would be written, in the words the person approves: media library, a Divi page module, or "nowhere Odito can write". */
const sourceView = (a) => {
  if (a.plan.target?.kind === TARGET_KIND) return describeSource(a.plan.target);
  if (a.divi && (a.divi.status === 'unsupported' || a.divi.status === 'ambiguous')) {
    return { kind: 'manual', label: 'Divi page module (not editable by Odito)', code: a.divi.code, message: a.divi.message, status: a.divi.status };
  }
  if (a.identity.status !== 'resolved') return null;
  // The page's own content does not contain the image and the library alt is not what renders: a theme/builder TEMPLATE draws it. On a Divi
  // site that is a Theme Builder layout, which WordPress does not expose over REST — so Odito can neither read nor change it.
  if (a.diagnosis?.source === 'theme_template' && !a.plan.target) {
    return {
      kind: 'manual', label: 'Theme Builder / template (not editable by Odito)', code: 'THEME_TEMPLATE_NOT_EDITABLE', status: 'unsupported',
      message: a.diagnosis.builder === 'Divi'
        ? "On Divi, headers, footers and body areas are Theme Builder layouts. WordPress does not expose them through its REST API, so Odito cannot read or change them. In Divi > Theme Builder, open the header template, edit the Menu module that shows this logo and set its logo alt text (Divi stores it as the module's logo_alt setting)."
        : 'A theme or builder template renders this image. Templates are not part of the page content Odito can read or change; set the alt text in that template.',
    };
  }
  const unwritable = ['rendered_mismatch', 'stale_finding', 'unsupported', 'ambiguous_target', 'decorative'].includes(a.plan.status);
  return {
    kind: 'media_library', label: 'WordPress media library', identifier: `attachment ${a.identity.attachmentId}`, attachmentId: a.identity.attachmentId,
    writeTarget: unwritable ? null : `The alt text field of media-library attachment ${a.identity.attachmentId}. Nothing else about the attachment changes.`,
    verification: unwritable ? null : 'Odito reads the alt text back from WordPress, then confirms the rendered page after the next recrawl.',
  };
};

const identityView = (identity) => ({
  status: identity.status, code: identity.code || null, message: identity.message || null,
  attachmentId: identity.attachmentId ?? null, confidence: identity.confidence || null, method: identity.method || null,
  evidence: identity.evidence || [], matchedUrls: identity.matchedUrls || [],
});

// ── preview ──────────────────────────────────────────────────────────────────

export async function getAltFixPreview(task, input, overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  const a = await analyze(task, input, deps);
  const record = await latestRecordFor(deps, task, a.snapshot.src);
  const { plan, identity } = a;
  const ready = plan.status === 'ready';
  // The AI recommendation already made for this page, resolved for THIS exact image. Read-only; never generates anything.
  const recommendation = identity.status === 'resolved' ? await recommendationFor(deps, task, a.snapshot) : null;
  return {
    fixType: ALT_FIX_TYPE,
    projectId: task.projectId,
    connectionId: a.connection._id,
    fixId: record?._id || null,
    targetUrl: task.pageUrl,
    scope: 'post',
    image: {
      sourceUrl: a.snapshot.src, altState: a.snapshot.altState || 'unknown', observedAlt: null,
      srcsetUrls: a.snapshot.srcsetUrls || [], figcaption: a.snapshot.figcaption || null,
    },
    identity: identityView(identity),
    field: ALT_FIELD,
    source: sourceView(a),
    setting: sourceView(a)?.kind === 'manual' ? null : plan.target?.kind === TARGET_KIND
      ? `Divi page module → ${plan.target.module} (${plan.target.postType}/${plan.target.postId}) → ${plan.target.altAttr}`
      : (identity.attachmentId ? `WordPress media library → attachment ${identity.attachmentId} → alt text` : null),
    // Honest about the guarantee: 'database_conditional' = one conditional UPDATE of this attachment's alt, with the approved file
    // re-validated inside the Bridge (Bridge 1.5.0+); 'read_then_write' = read, compare, then a separate write.
    // `creationWindow`: WordPress cannot say whether an empty alt is a missing record or an empty one, and a missing record can only be created
    // check-then-insert (post meta has no unique key). It is created only if still absent and never overwrites; the read-back catches the rest.
    concurrency: plan.target?.kind === TARGET_KIND
      ? { writes: 'read_then_write', creationWindow: false }
      : { writes: a.transport === 'bridge' ? 'database_conditional' : 'read_then_write', creationWindow: a.transport === 'bridge' && plan.currentAlt === '' },
    classification: plan.classification,
    diagnosis: diagnosisView(a.diagnosis),
    current: plan.target?.kind === TARGET_KIND
      ? { alt: plan.target.storedAlt, note: plan.target.attrPresent ? "The module's own alt attribute (the media library is not changed)." : 'The module has no alt attribute of its own, so Divi renders alt="".' , rendered: plan.target.rendered?.alts?.[plan.target.rendered.alts.findIndex((x) => !x)] ?? '' }
      : { alt: plan.currentAlt, note: 'WordPress reports a missing and an empty alt text the same way.' },
    proposed: { alt: plan.change?.after ?? null },
    suggestions: plan.suggestions,
    recommendation,
    validation: plan.validation,
    contentEffect: a.content ? { status: a.content.status } : null,
    plan: { status: plan.status, code: plan.code, message: plan.message, fingerprint: plan.fingerprint, change: plan.change },
    approvalStatus: record && ['approved', 'applying', 'apply_uncertain', 'applied', 'verifying', 'verified', 'verification_failed'].includes(record.status) ? 'approved' : (ready ? 'awaiting_approval' : 'not_available'),
    executionStatus: record ? record.status : (ready ? 'not_started' : 'not_applicable'),
    verificationStatus: { saved: record?.verification?.saved?.status || 'pending', rendered: record?.verification?.rendered?.status || 'pending' },
    idempotencyKey: plan.target?.kind === TARGET_KIND ? idempotencyKey(task._id, ALT_FIX_TYPE, `page:${plan.target.postId}`, plan.fingerprint) : (identity.attachmentId ? idempotencyKey(task._id, ALT_FIX_TYPE, identity.attachmentId, plan.fingerprint) : null),
    lifecycle: record ? record.status : (ready ? 'awaiting_approval' : plan.status),
    record: describeFixRecord(record),
  };
}

// ── writing the alt, safely ──────────────────────────────────────────────────

const uncertain = (cause) => err(
  'OUTCOME_UNKNOWN',
  'WordPress did not confirm whether this alt text was saved, and the image could not be re-read to find out. Nothing was repeated. Check the status in a moment: Odito will compare WordPress with what it tried to write before doing anything else.',
  502,
  { reason: 'outcome_unknown', cause: cause?.code || null },
);

async function sendWrite(deps, ctx, { attachmentId, value, expectedRaw, expectedFile }) {
  if (ctx.transport === 'bridge') {
    // The Bridge compares `expected` (the exact stored value) and the approved file inside one conditional write.
    const r = await deps.bridge.swapMediaAlt(ctx.connection, attachmentId, { value, expected: expectedRaw, expectedFile });
    return { httpStatus: 200, operation: r.operation || null };
  }
  const r = await ctx.adapter.writeAltTextForAttachment(attachmentId, value);
  return { httpStatus: r.httpStatus ?? 200, operation: null };
}

/** A Bridge CONFLICT says whether the alt changed or the image itself was replaced. */
function conflictFrom(e) {
  const targetChanged = e?.reason === 'target_changed';
  return err('CONFLICT', targetChanged
    ? 'The attachment no longer matches the image that was approved. Nothing was written.'
    : 'The alt text changed in WordPress after you previewed it. Nothing was overwritten.', 409, { reason: targetChanged ? 'target_changed' : 'alt_changed', bridgeReason: e?.reason || null });
}

/**
 * Writes the alt in one direction and returns how that was established.
 *   'apply'    from `before` to `after`, persisting the intent first
 *   'restore'  from `after` to `before` (rollback)
 * A definite refusal or a conflict is thrown. An ambiguous failure is answered by reading the attachment: it landed (reconciled),
 * it did not land (a bounded retry, preceded by this very read), or somebody else changed it (conflict).
 */
async function writeAltReconciled(deps, ctx, record, change, { attachmentId, expectedFile, expectedRaw, direction }) {
  const from = direction === 'apply' ? change.before : change.after;
  const to = direction === 'apply' ? change.after : change.before;
  let expected = expectedRaw;
  let last = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (direction === 'apply') {
      // On disk BEFORE the request leaves: a crash after this line leaves `in_flight`, which recovery reconciles.
      change.writeState = 'in_flight'; change.attempts = (change.attempts || 0) + 1; change.startedAt = deps.now();
      await record.save();
    }
    try {
      const r = await sendWrite(deps, ctx, { attachmentId, value: to, expectedRaw: expected, expectedFile });
      return { via: r.operation?.alreadyApplied ? 'reconciled' : 'response', httpStatus: r.httpStatus, operation: r.operation, attempts: attempt };
    } catch (e) {
      const kind = classifyWriteError(e);
      if (kind === 'conflict') throw conflictFrom(e);
      if (kind === 'definite') throw e;
      last = e;
      let live;
      try { live = await ctx.adapter.readMediaById(attachmentId); } catch { throw uncertain(e); }
      if (!live) throw err('CONFLICT', 'The attachment no longer exists. Nothing was written.', 409, { reason: 'target_changed' });
      const now = normalizeAlt(live.alt_text);
      if (now === to) return { via: 'reconciled', httpStatus: 200, operation: null, attempts: attempt };
      if (now !== from) throw err('CONFLICT', 'The alt text changed in WordPress while the fix was being applied. Nothing was overwritten.', 409, { reason: 'alt_changed' });
      expected = String(live.alt_text ?? ''); // still the value it had: the write did not land; the next attempt is conditional on what was just read
      if (attempt < MAX_ATTEMPTS) await deps.sleep(250 * attempt);
    }
  }
  throw last;
}

function savedCheck(media, expected, now) {
  const actual = normalizeAlt(media?.alt_text);
  const ok = actual === expected;
  return {
    status: ok ? 'verified' : 'failed', checkedAt: now,
    reasonCode: ok ? null : 'SAVED_VALUE_DIFFERS',
    reasons: ok ? [] : [`WordPress holds "${actual}" instead of "${expected}".`],
    fields: [{ field: ALT_FIELD, expected, actual, ok }],
  };
}

const unreadable = (deps) => ({ status: 'unverifiable', checkedAt: deps.now(), reasonCode: 'WORDPRESS_UNREADABLE', reasons: ['WordPress could not be re-read right now.'], fields: [] });

// ── recovering a record left in flight ───────────────────────────────────────

/**
 * Reconciles a record whose write may or may not have happened against what WordPress holds NOW. Writes nothing.
 *   complete  the attachment holds Odito's text                       -> the apply is finished (verification + task are left)
 *   settled   it still holds the previous text (nothing landed), a person changed it, or the image was replaced -> record closed as failed
 */
async function recoverAltRecord(deps, adapter, record) {
  const change = record.changes[0];
  const live = await adapter.readMediaById(record.target.attachmentId); // cannot read -> throws; the record is left exactly as it is
  const sameImage = live && [...attachmentExactPaths(live)].some((p) => (record.target.exactPaths || []).includes(p));
  const now = live ? normalizeAlt(live.alt_text) : null;

  if (sameImage && now === change.after) {
    change.applied = true; change.writeState = 'landed'; change.attribution = 'reconciled';
    record.status = 'applying'; // finalized by the caller
    await record.save();
    return { kind: 'complete' };
  }
  change.writeState = 'not_written';
  const changedByOthers = !live || !sameImage || now !== change.before;
  record.status = changedByOthers ? 'conflict_detected' : 'apply_failed';
  record.failure = {
    code: changedByOthers ? 'CONFLICT' : 'ABANDONED',
    message: changedByOthers
      ? 'The image or its alt text was changed by someone else while this fix was being applied; nothing was overwritten.'
      : 'An earlier attempt was interrupted before it changed anything.',
  };
  await record.save();
  return { kind: 'settled' };
}

// ── apply ────────────────────────────────────────────────────────────────────

/** Verification + task bookkeeping that must happen exactly once after the write — idempotent, so recovery can call it too. */
async function finalizeApplied(deps, task, adapter, record, { fresh, httpStatus = 200 }) {
  const change = record.changes[0];
  if (record.status === 'applying') {
    record.appliedAt = record.appliedAt || deps.now();
    record.status = 'applied';
    await record.save();
    log('wordpress_fix_applied', task, { attachmentId: record.target.attachmentId, fixId: record._id });
  }
  if (!record.verification?.saved || record.verification.saved.status === 'pending') {
    // Saved-state verification: read the attachment back. Not the rendered page, not authoritative.
    let saved;
    try { saved = savedCheck(await adapter.readMediaById(record.target.attachmentId), change.after, deps.now()); } catch { saved = unreadable(deps); }
    record.verification.saved = saved;
    record.verification.rendered = { status: 'pending', reasonCode: 'NO_POST_WRITE_CRAWL', attempts: 0, reasons: ['The rendered page is checked after the next recrawl.'], fields: [] };
    if (saved.status === 'failed') record.status = 'verification_failed';
    await record.save();
  }
  await recordOnTask(task, deps, {
    src: record.target.imageSourceUrl, attachmentId: record.target.attachmentId, after: change.after,
    exactPaths: record.target.exactPaths, httpStatus, writtenAt: record.appliedAt,
  });
  const saved = record.verification.saved;
  return { task, fix: describeFixRecord(record), alreadyApplied: !fresh, immediateVerification: saved.status === 'verified' ? 'success' : saved.status === 'failed' ? 'failed' : 'unknown' };
}

export async function applyAltFix(task, input, overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  log('wordpress_fix_started', task);
  const { approved, expectedPlanFingerprint, actorId = null } = input;

  if (approved !== true) throw err('WRITE_FAILED', 'This fix must be explicitly approved before it can be applied.', 400);
  if (typeof expectedPlanFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(expectedPlanFingerprint)) {
    throw err('EXPECTED_STATE_REQUIRED', 'Preview the fix and send its plan fingerprint so Odito can confirm nothing changed since you reviewed it.', 400);
  }
  if (task.issueKey !== RULE_ID) throw err('FIELD_NOT_WRITABLE', 'This issue type is not handled by the image alt fix.', 422);
  if (!['task_created', 'reopened', 'implemented'].includes(task.status)) {
    throw err('CONFLICT', `This task cannot take another alt-text change from its current status (${task.status}). Refresh the page.`, 409);
  }

  const a = await analyze(task, input, deps);
  const { plan, identity, adapter, connection, snapshot } = a;

  // A record left in flight by a crash or a timeout is reconciled against WordPress BEFORE anything new is decided or written.
  const inflight = await inFlightRecordFor(deps, task, snapshot.src);
  if (inflight) {
    if (!isAbandoned(inflight, deps.now())) {
      throw err('CONFLICT', 'This fix is already being applied. Wait for it to finish.', 409, { reason: 'fix_in_progress', fixId: inflight._id });
    }
    const isDiviRecord = inflight.target?.sourceKind === TARGET_KIND;
    const outcome = isDiviRecord ? await recoverDivi({ deps, connection, record: inflight }) : await recoverAltRecord(deps, adapter, inflight);
    log('wordpress_fix_recovered', task, { outcome: outcome.kind, fixId: inflight._id });
    if (outcome.kind === 'complete') {
      const done = isDiviRecord ? await finalizeDivi({ deps, h: diviHelpers, task, connection, record: inflight, fresh: false }) : await finalizeApplied(deps, task, adapter, inflight, { fresh: false });
      return { ...done, recovered: true };
    }
  }

  if (plan.fingerprint !== expectedPlanFingerprint) {
    log('wordpress_fix_conflict', task, { reason: 'preview_stale' });
    throw err('CONFLICT', 'The image, its current alt text or the page changed since this fix was previewed. Review the refreshed preview and approve it again.', 409, { reason: 'preview_stale', currentFingerprint: plan.fingerprint });
  }
  if (['unsupported', 'ambiguous_target', 'rendered_mismatch', 'stale_finding'].includes(plan.status)) throw err('FIELD_NOT_WRITABLE', plan.message, 422, { reason: plan.code, planStatus: plan.status });
  if (plan.status !== 'ready') throw err('VALIDATION_FAILED', plan.message || 'There is nothing safe to apply for this image.', 422, { reason: plan.code, planStatus: plan.status });

  const attachmentId = identity.attachmentId;
  const after = plan.change.after;
  if (plan.target?.kind === TARGET_KIND) {
    // The rendered alt is controlled by a Divi page module: the approved text is written THERE (never to the media library).
    const diviRec = await recommendationFor(deps, task, snapshot);
    return applyDivi({ deps, h: diviHelpers, task, a, actorId, textSource: provenanceOf(after, diviRec), rec: diviRec });
  }
  // Where the approved text came from — decided HERE by comparing it with the recommendation, never taken from the client.
  const rec = await recommendationFor(deps, task, snapshot);
  const textSource = provenanceOf(after, rec);
  const key = idempotencyKey(task._id, ALT_FIX_TYPE, attachmentId, plan.fingerprint);
  const { record, claimed } = await claimFixRecord(deps, {
    projectId: task.projectId, connectionId: connection._id, taskId: task._id, fixType: ALT_FIX_TYPE, targetUrl: task.pageUrl,
    targetWordPressObjectId: attachmentId, scope: 'post', provider: 'none',
    target: {
      imageSourceUrl: snapshot.src, attachmentId, identityMethod: identity.method, identityConfidence: identity.confidence,
      exactPaths: (identity.exactPaths || []).slice(0, 24), altStateObserved: snapshot.altState || 'unknown',
      textSource, recommendationId: textSource === 'human_input' ? null : (rec?.recommendationId || null),
    },
    planFingerprint: plan.fingerprint, idempotencyKey: key,
    changes: [{ field: ALT_FIELD, before: plan.change.before, after, source: textSource }],
    approvedBy: actorId, approvedAt: deps.now(),
  });
  if (!claimed) {
    if (['applied', 'verifying', 'verified', 'verification_failed'].includes(record.status)) {
      log('wordpress_fix_skipped', task, { reason: 'already_applied', fixId: record._id });
      // An earlier attempt may have crashed after the write but before verification or the task update: finish that, once.
      return finalizeApplied(deps, task, adapter, record, { fresh: false });
    }
    throw err('CONFLICT', 'This fix is already being applied. Wait for it to finish.', 409, { reason: 'fix_in_progress', fixId: record._id });
  }

  const change = record.changes[0];
  const fail = async (status, e, extra = {}) => {
    change.writeState = e?.details?.reason === 'outcome_unknown' ? 'unknown' : 'not_written';
    record.status = status;
    record.failure = { code: e?.code || 'UNKNOWN_ERROR', message: (e?.message || 'WordPress rejected the change.').slice(0, 300) };
    await record.save();
    log('wordpress_fix_failed', task, { code: e?.code || 'UNKNOWN_ERROR', fixId: record._id });
    const out = e instanceof WordPressConnectionError ? e : err('WRITE_FAILED', 'Failed to write this change to WordPress.', 502);
    out.details = { ...(out.details || {}), fixId: record._id, ...extra };
    throw out;
  };

  // Re-read IMMEDIATELY before writing: a human (or another tool) may have edited the alt, or replaced the file, since the preview.
  let current;
  try { current = await adapter.readMediaById(attachmentId); } catch (e) { return fail(e?.code === 'PERMISSION_DENIED' ? 'permission_denied' : 'apply_failed', e); }
  if (!current || exactMatches(observedUrlsOf(snapshot), current).length === 0) {
    return fail('conflict_detected', err('CONFLICT', 'The attachment no longer matches the image that was approved. Nothing was written.', 409), { reason: 'target_changed' });
  }
  if (normalizeAlt(current.alt_text) !== plan.change.before) {
    return fail('conflict_detected', err('CONFLICT', 'The alt text changed in WordPress after you previewed it. Nothing was overwritten.', 409), { reason: 'alt_changed' });
  }

  const ctx = { adapter, connection, transport: a.transport };
  let write;
  try {
    write = await writeAltReconciled(deps, ctx, record, change, {
      attachmentId, direction: 'apply',
      expectedRaw: String(current.alt_text ?? ''),               // the EXACT stored value the Bridge compares inside its conditional write
      expectedFile: String(current.media_details?.file ?? ''),   // the file identity that was approved; the Bridge refuses a replaced image
    });
  } catch (e) {
    if (e?.details?.reason === 'outcome_unknown') {
      // Nothing could even be read back: do not restore or repeat anything on a guess.
      return fail('apply_uncertain', e);
    }
    return fail(e?.code === 'PERMISSION_DENIED' ? 'permission_denied' : (e?.code === 'CONFLICT' ? 'conflict_detected' : 'apply_failed'), e);
  }
  change.applied = true; change.writeState = 'landed'; change.attribution = write.via;
  change.operationId = write.operation?.id || null;
  // Honest about HOW it was written: an alt text that did not exist yet is created check-then-insert (never overwriting), not by one conditional UPDATE.
  change.writeMode = ctx.transport !== 'bridge' ? 'read_then_write' : (write.operation?.created ? 'conditional_insert' : (write.operation?.atomic ? 'conditional_update' : null));
  change.atomic = change.writeMode === 'conditional_update';
  await record.save();
  log('wordpress_fix_applied_write', task, { attachmentId, attempts: write.attempts, transport: ctx.transport, fixId: record._id });

  return finalizeApplied(deps, task, adapter, record, { fresh: true, httpStatus: write.httpStatus });
}

/**
 * The Task is a page-level record shared by every flagged image of the page. The first fix moves it to implemented; later fixes on
 * the same page add their image to the expected after-state, so the recrawl verifies every image Odito changed. Idempotent: recovery
 * and re-verification call it again for an image that is already recorded.
 */
async function recordOnTask(task, deps, { src, attachmentId, after, exactPaths, httpStatus, writtenAt, postId = null, occurrence = null }) {
  // `occurrence` (a Divi module write): one use of the attachment was changed, and the other uses legitimately keep their own alt, so the
  // recrawl check must not demand that EVERY use shows the approved text.
  const entry = { src, attachmentId, alt: after, exactPaths: (exactPaths || []).slice(0, 24), ...(occurrence ? { occurrence } : {}) };
  if (task.status === 'implemented') {
    const attempt = task.fixHistory?.[task.fixHistory.length - 1];
    const expected = attempt?.fixApplied?.expectedAfterValue;
    if (expected && expected.type === 'image_alt') {
      const existing = (expected.images || []).find((i) => i.src === entry.src);
      if (existing && existing.alt === entry.alt) return;
      const images = [...(expected.images || []).filter((i) => i.src !== entry.src), entry];
      attempt.fixApplied.expectedAfterValue = { ...expected, images };
      task.markModified?.('fixHistory');
      await saveTask(task);
    }
    return;
  }
  if (!['task_created', 'reopened'].includes(task.status)) return; // e.g. verified_fixed: never rewritten from here
  await deps.taskHistory.applyImplementedTransition(task, {
    origin: 'wordpress_auto',
    recommendationId: task.recommendationId || null,
    externalWrite: { system: 'wordpress', provider: 'none', field: ALT_FIX_TYPE, wordpressPostId: postId ?? attachmentId, httpStatus, writtenAt, scope: 'post' },
    expectedAfterValueOverride: { type: 'image_alt', alt: after, images: [entry] },
  });
  await saveTask(task);
}

/** What the Divi driver needs from this module (kept here so the two files do not import each other). */
const diviHelpers = { err, log, recordOnTask, ALT_FIX_TYPE };

async function saveTask(task) {
  try { await task.save(); } catch (error) {
    if (error?.name === 'VersionError') {
      const conflict = err('CONFLICT', 'This task was updated by another process while applying this fix. The WordPress write succeeded, but Odito could not record it on the task — please refresh.', 409, { wordpressWriteSucceeded: true });
      throw conflict;
    }
    throw error;
  }
}

// ── reverify ─────────────────────────────────────────────────────────────────

const PENDING_CODES = new Set(['NO_POST_WRITE_CRAWL', 'PAGE_NOT_CRAWLED']);

/**
 * What the recrawled page shows for THIS image. `pending` = no crawl newer than the change exists yet (a recrawl will settle it);
 * `unverifiable` = the page was looked at and the image cannot be matched by stable evidence; `failed` = observed and wrong.
 */
export function renderedAltCheck({ pageDoc, target, expected, appliedAt, now, previous = null }) {
  const attempts = (previous?.attempts || 0) + 1;
  const cannot = (code, reason, status = PENDING_CODES.has(code) ? 'pending' : 'unverifiable') => ({
    status, reasonCode: code, attempts, checkedAt: now, crawledAt: pageDoc?.scraped_at || null, reasons: [`cannot_be_checked: ${reason}`], fields: [],
  });
  if (!pageDoc) return cannot('PAGE_NOT_CRAWLED', 'the page is not in the latest crawl.');
  const crawledAt = pageDoc.scraped_at ? new Date(pageDoc.scraped_at) : null;
  if (crawledAt && appliedAt && crawledAt < new Date(appliedAt)) return cannot('NO_POST_WRITE_CRAWL', 'the page has not been re-crawled since the change, so the rendered page says nothing about it (a cache or CDN may also still serve the old page).');
  const { matched, conflicting } = matchRenderedImages(pageDoc.images, { attachmentId: target.attachmentId, exactPaths: target.exactPaths });
  if (!matched.length) {
    return conflicting.length
      ? cannot('IMAGE_LABELLED_AS_OTHER', 'a rendered image uses this file but is labelled as a different attachment, so it is not unambiguously this image.')
      : cannot('IMAGE_NOT_MATCHED', 'the image was not found in the crawl by stable evidence (a wp-image class or an exact upload path). Crawls from before this check recorded no such evidence — recrawl the page.');
  }
  const rendered = matched.map((i) => normalizeAlt(i.alt));
  const wrong = rendered.filter((alt) => alt !== expected);
  const base = { attempts, checkedAt: now, crawledAt: pageDoc.scraped_at || null, fields: [{ field: 'rendered_alt', expected, actual: rendered.join(' | '), ok: wrong.length === 0 }] };
  if (!wrong.length) return { status: 'verified', reasonCode: null, reasons: [], ...base };
  return {
    status: 'failed', reasonCode: 'RENDERED_DIFFERS', ...base,
    reasons: [`The rendered image shows alt "${wrong[0]}" instead of "${expected}".`, 'WordPress holds the new text, but the page does not show it: a cache or CDN may be serving the old page, or the page stores this image\'s alt in its own content. Odito does not re-write the same value to compensate.'],
  };
}

/** After a rollback the page must no longer show the text Odito applied. */
function renderedRollbackCheck({ pageDoc, target, applied, restored, rolledBackAt, now, previous }) {
  const attempts = (previous?.attempts || 0) + 1;
  const part = (status, code, reasons) => ({ status, reasonCode: code, attempts, checkedAt: now, crawledAt: pageDoc?.scraped_at || null, reasons, fields: [] });
  if (!pageDoc) return part('pending', 'PAGE_NOT_CRAWLED', ['The page is not in the latest crawl.']);
  const crawledAt = pageDoc.scraped_at ? new Date(pageDoc.scraped_at) : null;
  if (!crawledAt || (rolledBackAt && crawledAt < new Date(rolledBackAt))) return part('pending', 'NO_POST_WRITE_CRAWL', ['The page has not been re-crawled since the rollback.']);
  const { matched } = matchRenderedImages(pageDoc.images, { attachmentId: target.attachmentId, exactPaths: target.exactPaths });
  if (!matched.length) return part('unverifiable', 'IMAGE_NOT_MATCHED', ['The image was not found in the crawl by stable evidence.']);
  const stillShows = matched.some((i) => normalizeAlt(i.alt) === applied);
  if (stillShows && applied !== restored) return part('failed', 'RENDERED_STILL_SHOWS_APPLIED_TEXT', [`The page still shows the alt text Odito applied ("${applied}"): a cache or CDN may be serving the old page.`]);
  return part('verified', null, []);
}

export async function reverifyAltFix(task, { imageSrc }, overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  const record = await latestRecordFor(deps, task, imageSrc);
  if (!record || (!record.changes[0]?.applied && !['applying', 'apply_uncertain'].includes(record.status))) throw err('VALIDATION_FAILED', 'No alt-text change has been applied for this image.', 404);
  const connection = await deps.wordPressService.getHydratedConnectionOrThrow(task.projectId);
  const adapter = deps.makeAdapter(connection);
  const change = record.changes[0];

  if (record.target?.sourceKind === TARGET_KIND) {
    if (['applying', 'apply_uncertain'].includes(record.status)) {
      if (!isAbandoned(record, deps.now())) throw err('CONFLICT', 'This fix is still being applied.', 409, { reason: 'fix_in_progress', fixId: record._id });
      const outcome = await recoverDivi({ deps, connection, record });
      log('wordpress_fix_recovered', task, { outcome: outcome.kind, fixId: record._id });
      if (outcome.kind === 'complete') await finalizeDivi({ deps, h: diviHelpers, task, connection, record, fresh: false });
      return { fix: describeFixRecord(record) };
    }
    if (record.status !== 'rolled_back' && (!change.applied || change.restored)) throw err('VALIDATION_FAILED', 'No alt-text change has been applied for this image.', 404);
    return reverifyDivi({ deps, h: diviHelpers, task, connection, record });
  }

  // Re-checking is also how an uncertain or abandoned apply gets reconciled: read WordPress, then decide.
  if (['applying', 'apply_uncertain'].includes(record.status)) {
    if (!isAbandoned(record, deps.now())) throw err('CONFLICT', 'This fix is still being applied.', 409, { reason: 'fix_in_progress', fixId: record._id });
    const outcome = await recoverAltRecord(deps, adapter, record);
    log('wordpress_fix_recovered', task, { outcome: outcome.kind, fixId: record._id });
    if (outcome.kind === 'complete') await finalizeApplied(deps, task, adapter, record, { fresh: false });
    return { fix: describeFixRecord(record) };
  }
  if (record.status === 'rolled_back') return reverifyRollback(deps, adapter, task, record);
  if (!change.applied || change.restored) throw err('VALIDATION_FAILED', 'No alt-text change has been applied for this image.', 404);

  let saved;
  try { saved = savedCheck(await adapter.readMediaById(record.target.attachmentId), change.after, deps.now()); } catch { saved = unreadable(deps); }
  const pageDoc = await deps.loadPageDoc(task);
  const rendered = renderedAltCheck({ pageDoc, target: record.target, expected: change.after, appliedAt: record.appliedAt, now: deps.now(), previous: record.verification?.rendered });
  record.verification.saved = { ...saved, attempts: (record.verification?.saved?.attempts || 0) + 1 };
  record.verification.rendered = rendered;
  if (['applied', 'verifying', 'verification_failed', 'verified'].includes(record.status)) {
    record.status = saved.status === 'failed' || rendered.status === 'failed' ? 'verification_failed' : (saved.status === 'verified' && rendered.status === 'verified' ? 'verified' : 'applied');
  }
  await record.save();
  // An earlier attempt may have died between "applied" and the task update: finish that here, once.
  if (record.appliedAt) {
    await recordOnTask(task, deps, { src: record.target.imageSourceUrl, attachmentId: record.target.attachmentId, after: change.after, exactPaths: record.target.exactPaths, httpStatus: 200, writtenAt: record.appliedAt });
  }
  return { fix: describeFixRecord(record) };
}

/** A rolled-back image is re-checked the same two ways: WordPress holds the previous text, and the page no longer shows Odito's. */
async function reverifyRollback(deps, adapter, task, record) {
  const change = record.changes[0];
  let saved;
  try {
    const s = savedCheck(await adapter.readMediaById(record.target.attachmentId), change.before, deps.now());
    saved = s.status === 'verified' ? s : { ...s, reasons: s.reasons.map((r) => r.replace('instead of', 'instead of the restored')) };
  } catch { saved = unreadable(deps); }
  const pageDoc = await deps.loadPageDoc(task);
  record.rollback.saved = { ...saved, attempts: (record.rollback.saved?.attempts || 0) + 1 };
  record.rollback.rendered = renderedRollbackCheck({ pageDoc, target: record.target, applied: change.after, restored: change.before, rolledBackAt: record.rollback.at, now: deps.now(), previous: record.rollback.rendered });
  if (saved.status === 'verified' && record.rollback.status === 'applied') record.rollback.status = 'verified';
  await record.save();
  return { fix: describeFixRecord(record) };
}

// ── rollback ─────────────────────────────────────────────────────────────────

export async function rollbackAltFix(task, { imageSrc, actorId = null }, overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  const record = await latestRecordFor(deps, task, imageSrc);
  const change = record?.changes?.[0];
  if (!record || !change?.applied) throw err('VALIDATION_FAILED', 'There is no applied alt-text change to roll back for this image.', 404);
  const connection = await deps.wordPressService.getHydratedConnectionOrThrow(task.projectId);
  const adapter = deps.makeAdapter(connection);

  if (record.target?.sourceKind === TARGET_KIND) {
    if (['applying', 'apply_uncertain'].includes(record.status)) {
      if (!isAbandoned(record, deps.now())) throw err('CONFLICT', 'This fix is still being applied.', 409);
      await recoverDivi({ deps, connection, record });
      if (!change.applied) throw err('VALIDATION_FAILED', 'There is no applied alt-text change to roll back for this image.', 404);
    }
    if (change.restored) {
      if (record.rollback?.status === 'applied') {
        await reverifyDivi({ deps, h: diviHelpers, task, connection, record });
        return { fix: describeFixRecord(record), message: 'The Divi module was put back as it was. Recrawl the page to confirm the rendered output.' };
      }
      throw err('VALIDATION_FAILED', 'There is no applied alt-text change to roll back for this image.', 404);
    }
    return rollbackDivi({ deps, h: diviHelpers, task, connection, record, actorId });
  }

  const id = record.target.attachmentId;

  // An apply that never finished is reconciled first: what WordPress really holds decides what can be rolled back.
  if (['applying', 'apply_uncertain'].includes(record.status)) {
    if (!isAbandoned(record, deps.now())) throw err('CONFLICT', 'This fix is still being applied.', 409);
    await recoverAltRecord(deps, adapter, record);
    if (!change.applied) throw err('VALIDATION_FAILED', 'There is no applied alt-text change to roll back for this image.', 404);
  }

  // Restored already: a repeat only re-checks (if the earlier check could not confirm it); a verified rollback is finished.
  if (change.restored) {
    if (record.rollback?.status === 'applied') {
      await reverifyRollback(deps, adapter, task, record);
      return { fix: describeFixRecord(record), message: 'The previous alt text is restored. Recrawl the page to confirm the rendered output.' };
    }
    throw err('VALIDATION_FAILED', 'There is no applied alt-text change to roll back for this image.', 404);
  }

  // Intent first: if the process dies mid-rollback this is what recovery and the UI see.
  record.rollback.status = 'requested'; record.rollback.requestedAt = deps.now(); record.rollback.by = actorId;
  await record.save();

  const transport = await chooseTransport(deps, connection);
  const ctx = { adapter, connection, transport };
  const current = await adapter.readMediaById(id);
  const now = current ? normalizeAlt(current.alt_text) : null;
  // The attachment must still be the image that was approved (a replaced file is never written to).
  const sameImage = Boolean(current) && [...attachmentExactPaths(current)].some((p) => (record.target.exactPaths || []).includes(p));
  let restored = false; let how = null; let conflict = false;
  if (!current) {
    conflict = true;
  } else if (now === change.before && sameImage) {
    restored = true; how = 'already_restored'; // someone already put it back: idempotent
  } else if (now === change.after && sameImage) {
    try {
      await writeAltReconciled(deps, ctx, record, change, {
        attachmentId: id, direction: 'restore',
        expectedRaw: String(current.alt_text ?? ''), expectedFile: String(current.media_details?.file ?? ''),
      });
      restored = true; how = 'restored';
    } catch { conflict = true; }
  } else {
    conflict = true; // a newer human edit: it wins
  }

  record.rollback.at = deps.now(); record.rollback.by = actorId;
  if (restored) {
    change.restored = true; change.restoreState = how;
    record.rollback.restoredFields = [ALT_FIELD]; record.rollback.conflictFields = [];
    record.rollback.status = 'applied';
    record.status = 'rolled_back';
    await record.save();
    await reverifyRollback(deps, adapter, task, record);
  } else {
    change.restoreState = 'conflict';
    record.rollback.restoredFields = []; record.rollback.conflictFields = conflict ? [ALT_FIELD] : [];
    record.rollback.status = 'failed';
    await record.save();
  }
  log('wordpress_fix_rolled_back', task, { restored, fixId: record._id, rollback: record.rollback.status });
  return {
    fix: describeFixRecord(record),
    message: restored
      ? 'The previous alt text was restored. WordPress cannot tell a missing alt text from an empty one, so it is restored as empty. Recrawl the page to confirm.'
      : 'The alt text was changed after Odito wrote it, so it was left as it is now. Edit it in WordPress if you want it reverted.',
  };
}

export default { listAltImages, listAltImagesWithSummary, getAltFixPreview, applyAltFix, reverifyAltFix, rollbackAltFix, renderedAltCheck };
