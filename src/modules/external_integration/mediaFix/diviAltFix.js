/**
 * diviAltFix — the image-alt fix when the rendered alt is controlled by a DIVI PAGE MODULE, not the media library.
 *
 * It is a second TARGET KIND of the existing image-alt fix (same preview, plan fingerprint, explicit approval, fix ledger, task
 * bookkeeping and UI), not a parallel engine. altFixService calls into it at four seams: resolving the target while planning, applying,
 * re-verifying and rolling back. Nothing here is reachable except through that service, which has already proved project ownership.
 *
 * Three different things are never confused:
 *   rendered occurrence   one <img> on the live page — the unit of accessibility analysis
 *   Divi module           one shortcode in the page's post_content — the unit of a source-level write
 *   attachment            the media-library item — the unit of media-library metadata (never written here)
 *
 * A finding is mapped to a module only when ALL of these hold, otherwise it stays manual and says exactly why:
 *   - the page is Divi 4 shortcode content on a Divi version this has been checked against;
 *   - exactly ONE registered module names the image's exact file and has no alt text of its own (eligible: not global, not dynamic);
 *   - the LIVE page renders exactly ONE occurrence of that attachment without alt (so no template/widget also renders it empty, and
 *     the module's empty alt is what the page shows).
 *
 * Writes (after the person approved the exact text):
 *   re-read the page -> same fingerprint as the preview -> the same module, still without alt -> prepare the one-attribute edit and PROVE
 *   it touches nothing else (before anything is sent) -> record the intent -> write (an unclear outcome is answered by READING the page,
 *   never by blind repetition) -> read back -> a fresh fetch of the live page: exactly that occurrence now shows the approved alt.
 * No second write is ever made on Odito's own initiative: a failed verification is reported and the person decides (roll back).
 * Honest about the guarantee: WordPress offers no conditional post-content write, so this is read -> compare -> write, not one atomic step.
 */

import { classifyWriteError, claimFixRecord, describeFixRecord, idempotencyKey, isAbandoned } from '../ledger/fixLedger.js';
import { CODE, DIVI_ALT_MODULES, findAltSources, lf, locateByIdentity, planAltEdit, planAltRestore, verifyAltEdit } from '../content/diviImageAlt.js';
import { fingerprintOf } from '../content/wordPressContentService.js';
import { normalizeAlt } from './altText.js';

export const TARGET_KIND = 'divi_page_module';
export const DIVI_FIELD = 'divi_module_alt';

const MAX_ATTEMPTS = 3;
const normRendered = (s) => normalizeAlt(String(s ?? '').replace(/<br\s*\/?>/gi, ' ')); // WordPress's auto-paragraph filter appends <br /> to some rendered values

const INELIGIBLE_TEXT = {
  GLOBAL_MODULE: 'This module is a global Divi Library module: its settings are stored in the library item, not in this page.',
  DYNAMIC_ATTRIBUTE: 'This module takes its image or alt text from Divi dynamic content, so there is no fixed value to edit.',
  DYNAMIC_CONTENT: 'This module takes its image or alt text from Divi dynamic content, so there is no fixed value to edit.',
  ALT_ATTRIBUTE_NOT_QUOTED: "This module's alt attribute is stored in a format Odito will not rewrite.",
};

const idString = (t) => `${t.postType}/${t.postId}:${t.module}[${t.identity.ordinal}]`;

/** What the preview shows about the write target (no page content, no credentials). */
export function describeSource(target) {
  if (!target) return null;
  return {
    kind: TARGET_KIND, label: 'Divi page module', moduleLabel: target.moduleLabel, module: target.module, identifier: idString(target),
    postId: target.postId, postType: target.postType, imageAttribute: target.imageAttr, altAttribute: target.altAttr,
    attributePresent: target.attrPresent, storedValue: target.storedAlt, diviVersion: target.diviVersion, format: target.format,
    evidence: target.evidence,
    evidenceNote: target.evidence === 'observed_live'
      ? 'The module stores its alt text in this attribute; checked against the live page on this Divi version.'
      : "The attribute name comes from this Divi version's own builder source. This module has no stored value on your site yet, so the first change is also the first proof: Odito re-reads the live page afterwards and reports it if the alt does not appear.",
    writeTarget: `The ${target.altAttr} attribute of the ${target.module} module that shows this image, in the content of ${target.postType === 'pages' ? 'page' : 'post'} ${target.postId}. Nothing else on the page changes.`,
    verification: 'Odito reads the page back, proves only that attribute changed, then fetches the live page and checks that exactly this occurrence now renders the approved alt text. The audit finding is resolved only by the next successful analysis of the page.',
    writeMode: 'read_then_write',
    rendered: { occurrences: target.rendered?.total ?? null, withoutAlt: target.rendered?.empty ?? null },
  };
}

// ── resolving the target (read-only) ──────────────────────────────────────────

const unsupported = (code, message, extra = {}) => ({ status: 'unsupported', code, message, ...extra });
const ambiguous = (code, message, extra = {}) => ({ status: 'ambiguous', code, message, ...extra });

/**
 * @returns {Promise<{status: 'not_applicable'} | {status: 'unsupported'|'ambiguous', code: string, message: string} | {status: 'resolved', target: object}>}
 */
export async function resolveDiviTarget({ deps, connection, task, identity, content }) {
  if (content?.status !== 'builder_reference') return { status: 'not_applicable' };
  const exactPaths = [...(identity?.exactPaths || [])];

  let loaded;
  try { loaded = await deps.loadPage(connection, task.pageUrl); } catch (e) {
    return unsupported('PAGE_NOT_READABLE', `The page's content could not be read to find the module (${e?.message || 'unknown error'}).`);
  }
  if (!loaded?.ok) return unsupported(loaded?.code || 'PAGE_NOT_READABLE', loaded?.reason || 'This page cannot be read for editing.');
  const page = loaded.page;

  const sources = findAltSources(page.content.raw, { exactPaths });
  if (!sources.ok) return unsupported(sources.code, sources.message);

  let version;
  try { version = await deps.diviVersion(connection); } catch { version = { installed: false, version: null, tested: false, testedVersions: [] }; }
  if (!version.tested) {
    return unsupported(CODE.VERSION_NOT_VERIFIED, version.installed
      ? `Divi ${version.version || '(unknown version)'} has not been checked against this change. Odito edits Divi modules only on verified versions (${(version.testedVersions || []).join(', ')}).`
      : 'Odito could not confirm which Divi version this site runs, so it will not edit Divi module settings.');
  }

  const { candidates, others } = sources;
  if (!candidates.length) {
    const named = [...new Set(others.map((o) => `${o.module} (${o.attr})`))];
    return unsupported(CODE.NO_SUPPORTED_MODULE, named.length
      ? `The page content names this image only in ${named.join(', ')}, which is not a module whose alt-text attribute has been verified.`
      : 'No Divi module in the page content names this image, so its alt text is set somewhere Odito cannot edit (a template, widget or theme setting).');
  }

  let live;
  try { live = await deps.checkLiveAlt({ pageUrl: task.pageUrl, siteUrl: connection.site_url, attachmentId: identity.attachmentId, exactPaths, fresh: true }); } catch { live = { status: 'unavailable', instances: [] }; }
  if (live.status !== 'checked') {
    return unsupported(CODE.RENDER_NOT_VERIFIED, 'The live page could not be read, so Odito cannot prove which rendered image this module produces. Nothing is offered until it can.');
  }
  const renderedAlts = live.instances.map((i) => normRendered(i.alt));
  const renderedEmpty = renderedAlts.filter((a) => !a).length;

  const without = candidates.filter((c) => !c.storedAlt);
  if (!without.length) {
    return unsupported(CODE.NOT_ELIGIBLE, 'Every Divi module that shows this image already stores alt text, yet the page renders none: something other than the module controls it.');
  }
  const eligible = without.filter((c) => !c.ineligible);
  if (without.length > 1) {
    return ambiguous(CODE.MULTIPLE_MODULES, `${without.length} Divi modules on this page show this image without alt text, so the one behind this finding cannot be identified. Set the alt text on the modules in the page editor.`, { moduleCount: without.length });
  }
  if (!eligible.length) return unsupported(CODE.NOT_ELIGIBLE, INELIGIBLE_TEXT[without[0].ineligible] || 'This module cannot be edited safely from the page content.');
  if (renderedEmpty > 1) {
    return ambiguous(CODE.OTHER_SOURCE_ALSO_EMPTY, `The live page renders this image without alt text ${renderedEmpty} times, but only one Divi module on the page produces such an occurrence. Another place (a template, widget or theme setting) renders it too, so a module change alone would not fix every occurrence.`, { renderedEmpty });
  }
  if (renderedEmpty < 1) {
    return unsupported(CODE.RENDER_NOT_VERIFIED, 'The live page renders this image with alt text everywhere, so there is no empty occurrence for this module to explain.');
  }

  const c = eligible[0];
  const def = DIVI_ALT_MODULES[c.module];
  return {
    status: 'resolved',
    target: {
      kind: TARGET_KIND, postId: page.id, postType: page.postType, pageFingerprint: fingerprintOf(page),
      module: c.module, moduleLabel: def.label, imageAttr: c.imageAttr, altAttr: c.altAttr, evidence: c.evidence, identity: c.identity,
      imageValue: c.imageValue, attrPresent: c.attrPresent, storedAlt: c.storedAlt, diviVersion: version.version, format: 'divi4_shortcode',
      rendered: { total: renderedAlts.length, empty: renderedEmpty, alts: renderedAlts },
    },
  };
}

// ── verification helpers ──────────────────────────────────────────────────────

/** What the live (or crawled) page renders for this attachment now, compared with before: exactly one empty occurrence must now show the approved text. */
export function renderedOccurrenceCheck({ before, after, approved, now, source = 'live_fetch' }) {
  const base = { attempts: 1, checkedAt: now, crawledAt: null, fields: [] };
  if (!after || after.status === 'unavailable') return { status: 'unverifiable', reasonCode: 'LIVE_PAGE_UNREADABLE', reasons: ['The live page could not be read, so the rendered result is not confirmed. Re-verify in a moment.'], ...base };
  if (after.status === 'not_found') return { status: 'unverifiable', reasonCode: 'IMAGE_NOT_FOUND', reasons: ['The image was not found on the live page by stable evidence (wp-image class or exact upload path).'], ...base };
  const was = [...(before?.alts || [])].map(normRendered);
  const is = after.instances.map((i) => normRendered(i.alt));
  const want = [...was]; const emptyAt = want.findIndex((a) => !a);
  if (emptyAt >= 0) want[emptyAt] = normRendered(approved);
  const sorted = (xs) => [...xs].sort();
  const same = JSON.stringify(sorted(is)) === JSON.stringify(sorted(want));
  const fields = [{ field: 'rendered_alt', expected: normRendered(approved), actual: is.join(' | '), ok: same }];
  if (same) {
    return { status: 'verified', reasonCode: null, reasons: [source === 'live_fetch' ? 'Confirmed on a fresh fetch of the live page. The finding resolves after the next successful analysis of the page.' : 'Confirmed on the recrawled page.'], ...base, fields };
  }
  const unchanged = JSON.stringify(sorted(is)) === JSON.stringify(sorted(was));
  return {
    status: 'failed', reasonCode: unchanged ? 'RENDERED_UNCHANGED' : 'RENDERED_DIFFERS', ...base, fields,
    reasons: unchanged
      ? ['The module now holds the new alt text, but the live page still renders none for this image: a page cache may be serving the old page, or this module setting is not what the theme renders. Odito does not write it again to compensate.']
      : [`The occurrences on the live page changed in a way that is not exactly "this image's empty alt now shows the approved text" (now: ${is.map((a) => `"${a}"`).join(', ')}).`],
  };
}

async function readModule(deps, connection, target, exactPaths) {
  const page = await deps.readPage(connection, { postId: target.postId, postType: target.postType });
  return { page, candidate: locateByIdentity(page.content.raw, target.identity, { exactPaths }) };
}

const savedResult = (status, expected, actual, now, code = null, reasons = []) => ({
  status, checkedAt: now, reasonCode: code, reasons, fields: [{ field: DIVI_FIELD, expected, actual, ok: status === 'verified' }],
});

/** The stored module value, read back from the page. */
async function savedCheck(deps, connection, record, expected) {
  const now = deps.now();
  try {
    const { candidate } = await readModule(deps, connection, record.target, record.target.exactPaths || []);
    if (!candidate) return savedResult('failed', expected, null, now, 'MODULE_NOT_FOUND', ['The Divi module could not be found again on the page by its identity.']);
    const ok = candidate.storedAlt === expected;
    return savedResult(ok ? 'verified' : 'failed', expected, candidate.storedAlt, now, ok ? null : 'SAVED_VALUE_DIFFERS', ok ? [] : [`The module holds "${candidate.storedAlt}" instead of "${expected}".`]);
  } catch {
    return { status: 'unverifiable', checkedAt: now, reasonCode: 'WORDPRESS_UNREADABLE', reasons: ['WordPress could not be re-read right now.'], fields: [] };
  }
}

const liveCheck = (deps, connection, task, record) => deps.checkLiveAlt({ pageUrl: task.pageUrl, siteUrl: connection.site_url, attachmentId: record.target.attachmentId, exactPaths: record.target.exactPaths || [], fresh: true }).catch(() => ({ status: 'unavailable', instances: [] }));

/** Writes content; an unclear outcome is answered by reading the page, never by repeating blindly. */
async function writeReconciled({ deps, h, connection, page, newContent, baseFingerprint, record, change, direction }) {
  let last = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (direction === 'apply') {
      change.writeState = 'in_flight'; change.attempts = (change.attempts || 0) + 1; change.startedAt = deps.now();
      await record.save(); // on disk BEFORE the request leaves: a crash leaves `in_flight`, which recovery reconciles
    }
    try {
      await deps.writePage(connection, page, newContent);
      return { via: 'response', attempts: attempt };
    } catch (e) {
      const kind = classifyWriteError(e);
      if (kind === 'conflict' || kind === 'definite') throw e;
      last = e;
      let live;
      try { live = await deps.readPage(connection, { postId: page.id, postType: page.postType }); } catch {
        throw h.err('OUTCOME_UNKNOWN', 'WordPress did not confirm whether the change was saved, and the page could not be re-read to find out. Nothing was repeated. Check the status in a moment.', 502, { reason: 'outcome_unknown', cause: e?.code || null });
      }
      if (lf(live.content.raw) === lf(newContent)) return { via: 'reconciled', attempts: attempt };
      if (fingerprintOf(live) !== baseFingerprint) throw h.err('CONFLICT', 'The page changed in WordPress while the fix was being applied. Nothing was overwritten.', 409, { reason: 'page_changed' });
      if (attempt < MAX_ATTEMPTS) await deps.sleep(250 * attempt);
    }
  }
  throw last;
}

// ── apply ─────────────────────────────────────────────────────────────────────

/**
 * Verification + task bookkeeping, exactly once after the write. Idempotent: a repeated or recovered apply calls it again.
 */
export async function finalizeDivi({ deps, h, task, connection, record, fresh }) {
  const change = record.changes[0];
  if (record.status === 'applying') {
    record.appliedAt = record.appliedAt || deps.now();
    record.status = 'applied';
    await record.save();
    h.log('wordpress_fix_applied', task, { postId: record.target.postId, fixId: record._id, target: TARGET_KIND });
  }
  if (!record.verification?.saved || record.verification.saved.status === 'pending') {
    const saved = await savedCheck(deps, connection, record, change.after);
    const live = await liveCheck(deps, connection, task, record);
    const rendered = renderedOccurrenceCheck({ before: record.target.renderedBefore, after: live, approved: change.after, now: deps.now() });
    record.verification.saved = saved;
    record.verification.rendered = rendered;
    record.status = saved.status === 'failed' || rendered.status === 'failed' ? 'verification_failed' : (saved.status === 'verified' && rendered.status === 'verified' ? 'verified' : 'applied');
    await record.save();
  }
  await h.recordOnTask(task, deps, {
    src: record.target.imageSourceUrl, attachmentId: record.target.attachmentId, after: change.after, exactPaths: record.target.exactPaths,
    httpStatus: 200, writtenAt: record.appliedAt, postId: record.target.postId,
    occurrence: { mode: 'one_use', otherAlts: (record.target.renderedBefore?.alts || []).filter((a, i, all) => a && all.indexOf(a) === i) },
  });
  const saved = record.verification.saved; const rendered = record.verification.rendered;
  return {
    task, fix: describeFixRecord(record), alreadyApplied: !fresh,
    immediateVerification: saved.status === 'verified' && rendered?.status === 'verified' ? 'success' : (saved.status === 'failed' || rendered?.status === 'failed' ? 'failed' : 'unknown'),
  };
}

/**
 * @param {object} p
 * @param {object} p.a analyze() result (plan with plan.target, identity, connection, snapshot)
 */
export async function applyDivi({ deps, h, task, a, actorId, textSource, rec }) {
  const { plan, identity, connection, snapshot } = a;
  const target = plan.target;
  const after = plan.change.after;
  const exactPaths = (identity.exactPaths || []).slice(0, 24);
  const key = idempotencyKey(task._id, h.ALT_FIX_TYPE, `page:${target.postId}`, plan.fingerprint);

  const { record, claimed } = await claimFixRecord(deps, {
    projectId: task.projectId, connectionId: connection._id, taskId: task._id, fixType: h.ALT_FIX_TYPE, targetUrl: task.pageUrl,
    targetWordPressObjectId: target.postId, scope: 'post', provider: 'none',
    target: {
      sourceKind: TARGET_KIND, imageSourceUrl: snapshot.src, attachmentId: identity.attachmentId, identityMethod: identity.method, identityConfidence: identity.confidence,
      exactPaths, altStateObserved: snapshot.altState || 'unknown', textSource, recommendationId: textSource === 'human_input' ? null : (rec?.recommendationId || null),
      postId: target.postId, postType: target.postType, module: target.module, moduleLabel: target.moduleLabel, imageAttr: target.imageAttr, altAttr: target.altAttr,
      identity: target.identity, attrPresent: target.attrPresent, evidence: target.evidence, diviVersion: target.diviVersion, format: target.format, renderedBefore: target.rendered,
    },
    planFingerprint: plan.fingerprint, idempotencyKey: key,
    changes: [{ field: DIVI_FIELD, before: target.storedAlt, after, source: textSource }],
    approvedBy: actorId, approvedAt: deps.now(),
  });
  if (!claimed) {
    if (['applied', 'verifying', 'verified', 'verification_failed'].includes(record.status)) {
      h.log('wordpress_fix_skipped', task, { reason: 'already_applied', fixId: record._id, target: TARGET_KIND });
      return finalizeDivi({ deps, h, task, connection, record, fresh: false });
    }
    throw h.err('CONFLICT', 'This fix is already being applied. Wait for it to finish.', 409, { reason: 'fix_in_progress', fixId: record._id });
  }

  const change = record.changes[0];
  const fail = async (status, e, extra = {}) => {
    change.writeState = e?.details?.reason === 'outcome_unknown' ? 'unknown' : 'not_written';
    record.status = status;
    record.failure = { code: e?.code || 'UNKNOWN_ERROR', message: (e?.message || 'WordPress rejected the change.').slice(0, 300) };
    await record.save();
    h.log('wordpress_fix_failed', task, { code: e?.code || 'UNKNOWN_ERROR', fixId: record._id, target: TARGET_KIND });
    const out = e && e.name === 'WordPressConnectionError' ? e : h.err('WRITE_FAILED', 'Failed to write this change to WordPress.', 502);
    out.details = { ...(out.details || {}), fixId: record._id, ...extra };
    throw out;
  };

  // 1. Re-read IMMEDIATELY before writing: the page must be exactly what was previewed, and the SAME module must still lack alt text.
  let page; let candidate;
  try { ({ page, candidate } = await readModule(deps, connection, target, exactPaths)); } catch (e) { return fail(e?.code === 'PERMISSION_DENIED' ? 'permission_denied' : 'apply_failed', e); }
  if (page.status !== 'publish') return fail('conflict_detected', h.err('CONFLICT', 'The page is no longer published. Nothing was written.', 409), { reason: 'page_changed' });
  if (fingerprintOf(page) !== target.pageFingerprint) {
    return fail('conflict_detected', h.err('CONFLICT', 'The page changed in WordPress after you previewed it. Nothing was overwritten. Review the refreshed preview.', 409), { reason: 'page_changed' });
  }
  if (!candidate || candidate.storedAlt !== target.storedAlt || candidate.ineligible) {
    return fail('conflict_detected', h.err('CONFLICT', 'The Divi module that was approved is no longer on the page as it was. Nothing was written.', 409), { reason: 'target_changed' });
  }

  // 2. Prepare the one-attribute edit and PROVE it before anything is sent.
  let edit;
  try {
    edit = planAltEdit(page.content.raw, candidate, after);
    const proof = verifyAltEdit(page.content.raw, edit.content, candidate, { expectedAlt: after });
    if (!proof.ok) return fail('apply_failed', h.err('VALIDATION_FAILED', `The prepared change was not a single-attribute edit, so nothing was written (${proof.problems.join('; ')}).`, 422, { reason: 'edit_not_minimal' }));
  } catch (e) {
    if (e?.name === 'DiviParseError') return fail('apply_failed', h.err('VALIDATION_FAILED', `The module could not be edited safely (${e.message}). Nothing was written.`, 422, { reason: 'edit_not_minimal' }));
    throw e;
  }

  // 3. Write.
  let write;
  try {
    write = await writeReconciled({ deps, h, connection, page, newContent: edit.content, baseFingerprint: target.pageFingerprint, record, change, direction: 'apply' });
  } catch (e) {
    if (e?.details?.reason === 'outcome_unknown') return fail('apply_uncertain', e);
    return fail(e?.code === 'PERMISSION_DENIED' ? 'permission_denied' : (e?.code === 'CONFLICT' ? 'conflict_detected' : 'apply_failed'), e);
  }
  change.applied = true; change.writeState = 'landed'; change.attribution = write.via; change.writeMode = 'read_then_write'; change.atomic = false;
  await record.save();
  h.log('wordpress_fix_applied_write', task, { postId: target.postId, attempts: write.attempts, fixId: record._id, target: TARGET_KIND });

  // 4. Read back: what WordPress stored must be exactly what was sent, and a one-attribute difference from what was there. Any mismatch is reported (never silently "restored").
  try {
    const back = await deps.readPage(connection, { postId: target.postId, postType: target.postType });
    const exact = lf(back.content.raw) === lf(edit.content);
    const proof = verifyAltEdit(page.content.raw, back.content.raw, candidate, { expectedAlt: after });
    if (!exact || !proof.ok) {
      record.verification.saved = savedResult('failed', after, null, deps.now(), 'CONTENT_MISMATCH', [exact ? proof.problems.join('; ') : 'WordPress stored different content than was sent, or the page was changed again right after the write.']);
      record.verification.rendered = { status: 'pending', reasonCode: 'NOT_CHECKED', attempts: 0, reasons: ['Not checked: the saved content did not verify.'], fields: [] };
      record.status = 'verification_failed';
      await record.save();
      return finalizeDiviBookkeeping({ deps, h, task, record });
    }
  } catch { /* unreadable now: finalizeDivi reports it as unverifiable */ }

  return finalizeDivi({ deps, h, task, connection, record, fresh: true });
}

/** A verification_failed write is still a real write: the task must know about it so a recrawl can judge it. */
async function finalizeDiviBookkeeping({ deps, h, task, record }) {
  const change = record.changes[0];
  record.appliedAt = record.appliedAt || deps.now();
  await record.save();
  await h.recordOnTask(task, deps, {
    src: record.target.imageSourceUrl, attachmentId: record.target.attachmentId, after: change.after, exactPaths: record.target.exactPaths,
    httpStatus: 200, writtenAt: record.appliedAt, postId: record.target.postId,
    occurrence: { mode: 'one_use', otherAlts: (record.target.renderedBefore?.alts || []).filter((a, i, all) => a && all.indexOf(a) === i) },
  });
  return { task, fix: describeFixRecord(record), alreadyApplied: false, immediateVerification: 'failed' };
}

// ── recovery of a record left in flight ───────────────────────────────────────

/** Writes nothing. complete = the module holds Odito's text; settled = it does not (nothing landed, or someone else changed it). */
export async function recoverDivi({ deps, connection, record }) {
  const change = record.changes[0];
  const { candidate, page } = await readModule(deps, connection, record.target, record.target.exactPaths || []);
  if (candidate && candidate.storedAlt === change.after) {
    change.applied = true; change.writeState = 'landed'; change.attribution = 'reconciled';
    record.status = 'applying'; await record.save();
    return { kind: 'complete' };
  }
  change.writeState = 'not_written';
  const untouched = candidate && candidate.storedAlt === change.before;
  record.status = untouched ? 'apply_failed' : 'conflict_detected';
  record.failure = { code: untouched ? 'ABANDONED' : 'CONFLICT', message: untouched ? 'An earlier attempt was interrupted before it changed anything.' : 'The module or the page was changed by someone else while this fix was being applied; nothing was overwritten.' };
  await record.save();
  void page;
  return { kind: 'settled' };
}

// ── re-verify ─────────────────────────────────────────────────────────────────

export async function reverifyDivi({ deps, h, task, connection, record }) {
  const change = record.changes[0];
  const rolledBack = record.status === 'rolled_back';
  const expected = rolledBack ? change.before : change.after;
  const saved = await savedCheck(deps, connection, record, expected);
  const live = await liveCheck(deps, connection, task, record);
  let rendered;
  if (rolledBack) {
    const was = (record.target.renderedBefore?.alts || []).map(normRendered).sort();
    const is = (live.instances || []).map((i) => normRendered(i.alt)).sort();
    rendered = live.status !== 'checked'
      ? renderedOccurrenceCheck({ before: record.target.renderedBefore, after: live, approved: change.before, now: deps.now() })
      : { status: JSON.stringify(was) === JSON.stringify(is) ? 'verified' : 'failed', reasonCode: JSON.stringify(was) === JSON.stringify(is) ? null : 'RENDERED_STILL_SHOWS_APPLIED_TEXT', attempts: (record.rollback?.rendered?.attempts || 0) + 1, checkedAt: deps.now(), crawledAt: null, reasons: JSON.stringify(was) === JSON.stringify(is) ? [] : ['The live page does not show the original state again: a cache may be serving the old page.'], fields: [] };
  } else {
    rendered = renderedOccurrenceCheck({ before: record.target.renderedBefore, after: live, approved: change.after, now: deps.now() });
  }
  if (rolledBack) {
    record.rollback.saved = { ...saved, attempts: (record.rollback.saved?.attempts || 0) + 1 };
    record.rollback.rendered = rendered;
    if (saved.status === 'verified' && record.rollback.status === 'applied') record.rollback.status = 'verified';
  } else {
    record.verification.saved = { ...saved, attempts: (record.verification?.saved?.attempts || 0) + 1 };
    record.verification.rendered = { ...rendered, attempts: (record.verification?.rendered?.attempts || 0) + 1 };
    if (['applied', 'verifying', 'verification_failed', 'verified'].includes(record.status)) {
      record.status = saved.status === 'failed' || rendered.status === 'failed' ? 'verification_failed' : (saved.status === 'verified' && rendered.status === 'verified' ? 'verified' : 'applied');
    }
  }
  await record.save();
  if (!rolledBack && record.appliedAt) {
    await h.recordOnTask(task, deps, {
      src: record.target.imageSourceUrl, attachmentId: record.target.attachmentId, after: change.after, exactPaths: record.target.exactPaths,
      httpStatus: 200, writtenAt: record.appliedAt, postId: record.target.postId,
      occurrence: { mode: 'one_use', otherAlts: (record.target.renderedBefore?.alts || []).filter((x, i, all) => x && all.indexOf(x) === i) },
    });
  }
  return { fix: describeFixRecord(record) };
}

// ── rollback ──────────────────────────────────────────────────────────────────

/** Puts back ONLY the attribute, and only while the module still holds Odito's text. A newer human edit always wins. */
export async function rollbackDivi({ deps, h, task, connection, record, actorId }) {
  const change = record.changes[0];
  record.rollback.status = 'requested'; record.rollback.requestedAt = deps.now(); record.rollback.by = actorId;
  await record.save();

  let restored = false; let how = null; let conflict = false;
  try {
    const { page, candidate } = await readModule(deps, connection, record.target, record.target.exactPaths || []);
    const hadAttribute = !!record.target.attrPresent;
    if (!candidate) conflict = true;
    else if (candidate.storedAlt === change.before && (hadAttribute || !candidate.attrPresent)) { restored = true; how = 'already_restored'; }
    else if (candidate.storedAlt === change.after) {
      const back = planAltRestore(page.content.raw, candidate, { previousValue: change.before, hadAttribute });
      const proof = verifyAltEdit(page.content.raw, back.content, candidate, hadAttribute ? { expectedAlt: change.before } : { expectedAbsent: true });
      if (!proof.ok) conflict = true;
      else {
        await writeReconciled({ deps, h, connection, page, newContent: back.content, baseFingerprint: fingerprintOf(page), record, change, direction: 'restore' });
        const check = await readModule(deps, connection, record.target, record.target.exactPaths || []);
        restored = !!check.candidate && check.candidate.storedAlt === change.before && (hadAttribute || !check.candidate.attrPresent);
        how = restored ? 'restored' : null;
        conflict = !restored;
      }
    } else conflict = true; // a newer edit: it wins
  } catch { conflict = true; }

  record.rollback.at = deps.now(); record.rollback.by = actorId;
  if (restored) {
    change.restored = true; change.restoreState = how;
    record.rollback.restoredFields = [DIVI_FIELD]; record.rollback.conflictFields = [];
    record.rollback.status = 'applied'; record.status = 'rolled_back';
    await record.save();
    await reverifyDivi({ deps, h, task, connection, record });
  } else {
    change.restoreState = 'conflict';
    record.rollback.restoredFields = []; record.rollback.conflictFields = conflict ? [DIVI_FIELD] : [];
    record.rollback.status = 'failed';
    await record.save();
  }
  h.log('wordpress_fix_rolled_back', task, { restored, fixId: record._id, rollback: record.rollback.status, target: TARGET_KIND });
  return {
    fix: describeFixRecord(record),
    message: restored
      ? 'The Divi module was put back as it was (only its alt attribute was touched). Recrawl the page to confirm the rendered output.'
      : 'The module was changed after Odito wrote it, or could not be found again, so it was left as it is now. Edit it in the page editor if you want it reverted.',
  };
}

export { isAbandoned };
export default { TARGET_KIND, DIVI_FIELD, describeSource, resolveDiviTarget, renderedOccurrenceCheck, applyDivi, finalizeDivi, recoverDivi, reverifyDivi, rollbackDivi };
