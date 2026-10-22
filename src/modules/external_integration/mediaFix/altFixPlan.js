/**
 * altFixPlan — decides, from verified evidence only, whether an image's alt text may be written, and exactly what. Pure.
 *
 * Statuses (what the person sees and what apply refuses):
 *   ready                   one field of one resolved attachment will change: its media-library alt text
 *   needs_input             the target is resolved and a media-library write could help, but no alt text was proposed yet
 *   needs_review            alt="" and nothing says whether that was deliberate: a person confirms the image carries meaning first
 *   validation_failed       the proposed text is not publishable (empty, HTML, file name, stuffing, too long)
 *   decorative              explicit evidence (role/aria-hidden, a named link): no fix required, unless a person says it is informative
 *   rendered_mismatch       the library already holds meaningful alt text but the page renders none: the page/builder/template overrides it,
 *                           so a library write cannot fix it (manual change at the source)
 *   stale_finding           the live page already renders alt text on every occurrence: the finding is out of date
 *   existing_alt_preserved  the library already has meaningful alt text that differs from the proposal: kept
 *   nothing_to_change       the library already holds exactly this text
 *   unsupported             this image/page cannot take the change (not an upload, not in the library, alt stored inside the page content)
 *   ambiguous_target        the evidence does not name exactly one attachment
 *
 * Only `ready` can be approved or applied. An empty After is never a proposal.
 */

import crypto from 'crypto';
import { classifyImage, normalizeAlt, suggestionsFromEvidence, validateProposedAlt } from './altText.js';
import { STATE, diagnoseAlt } from './altDiagnosis.js';

export const ALT_FIX_TYPE = 'image_alt';
export const ALT_FIELD = 'alt_text';
/** The field a Divi page-module write changes (the module's own alt attribute — never the media library). */
export const DIVI_FIELD = 'divi_module_alt';

/** Part of the fingerprint: an approval given under older planner rules can never be applied under newer ones. */
export const ALT_PLAN_VERSION = 4;

const why = (code, message) => ({ code, message });

/**
 * @param {object} p
 * @param {object} p.snapshot   the finding's before_snapshot
 * @param {object} p.identity   resolveImageIdentity() result
 * @param {object|null} p.content inspectContentEmbedding() result (null when no page content was inspected)
 * @param {object|null} p.diagnosis diagnoseAlt() result; computed from the snapshot, media and content when not given
 * @param {object|null} p.target    resolveDiviTarget() result: a resolved Divi page module (the write target), or why none could be named
 * @param {string|null} p.proposedAlt
 * @param {boolean} p.informative  a person confirmed the image carries meaning
 * @param {string} p.siteHost
 * @param {{projectId: *, connectionId: *, pageUrl: string}} [p.context]  who/where this plan is for; part of the fingerprint, so an approval
 *        is bound to this project, WordPress connection and page and can never be replayed against another
 */
export function planAltFix({ snapshot, identity, content = null, diagnosis = null, target = null, proposedAlt = null, informative = false, siteHost = '', context = {} }) {
  const classification = classifyImage(snapshot);
  const media = identity?.media || null;
  const currentAlt = normalizeAlt(media?.alt_text);
  const suggestions = suggestionsFromEvidence(snapshot, media);
  const diag = diagnosis || diagnoseAlt({ snapshot, media, content });
  // A resolved Divi module is the source that controls the rendered alt: it becomes the write target INSTEAD of the media library.
  const moduleTarget = target?.status === 'resolved' ? target.target : null;
  const base = { classification, suggestions, currentAlt, diagnosis: diag, target: moduleTarget, validation: { ok: null, errors: [], warnings: [] }, change: null };
  const finish = (status, reason = {}, extra = {}) => seal({ ...base, status, code: reason.code || null, message: reason.message || null, ...extra }, { identity, content, siteHost, snapshot, context, diag, target });

  if (!identity || identity.status !== 'resolved') {
    return finish(identity?.status === 'ambiguous_target' ? 'ambiguous_target' : 'unsupported', why(identity?.code || 'IDENTITY_UNRESOLVED', identity?.message || 'The image could not be identified.'));
  }

  // The live page already renders alt text everywhere: nothing to apply, and the finding leaves the audit on the next recrawl.
  if (diag.state === STATE.STALE) {
    return finish('stale_finding', why('FINDING_STALE', 'The live page already renders alt text on every occurrence of this image, so this finding is out of date. It leaves the audit on the next recrawl; nothing was changed.'));
  }

  // Decorative on evidence, whatever else is true (a person may say it is informative).
  if (diag.state === STATE.DECORATIVE && !informative) {
    return finish('decorative', why('DECORATIVE_IMAGE', `${classification.signals.join(' ')} Decorative images should keep an empty alt, so no fix is required and Odito leaves it unchanged. If this image does carry meaning, confirm that and provide a description.`));
  }

  // The alt in the page's own markup is what is rendered; a media-library change would not reach it.
  if (content?.status === 'embedded') {
    return finish('unsupported', why('ALT_EMBEDDED_IN_CONTENT', `This image is placed inside the page content${content.hasAltAttr ? ` with its own alt text ("${content.embeddedAlt ?? ''}")` : ''}. WordPress copies the library alt into the markup only when the image is inserted, so changing the library would not change this page. Edit the image's alt text in the page editor instead.`));
  }

  // WordPress already has meaningful alt text, yet the page renders none: the media library is not what controls this image — unless a
  // Divi module was identified as the source, in which case THAT module is what a reviewed change edits.
  if (diag.state === STATE.OVERRIDDEN && !moduleTarget) {
    const why2 = target && (target.status === 'unsupported' || target.status === 'ambiguous') ? ` Odito also looked for a Divi module it could edit: ${target.message}` : '';
    return finish('rendered_mismatch', why('RENDERED_ALT_OVERRIDES_LIBRARY', `WordPress already holds alt text (“${diag.libraryAlt}”) for this image, but the page renders ${diag.renderedAlt === null ? 'no alt attribute' : diag.renderedAlt === '' ? 'alt=""' : 'no alt text'}: something on this page overrides it. ${diag.manual || ''}${why2} Changing the media library would not change the page, and Odito never overwrites meaningful alt text without a reviewed change, so no write is offered.`.replace(/\s+/g, ' ').trim()));
  }

  // alt="" with no evidence either way: a person confirms the image carries meaning before any text is prepared.
  if (diag.state === STATE.NEEDS_REVIEW && !informative) {
    return finish('needs_review', why('REVIEW_EMPTY_ALT', 'The page renders alt="" on this image and nothing in the markup says whether that is deliberate. If the image carries meaning for the reader, confirm that below and describe it; if it is decorative, leave it as it is.'));
  }

  if (proposedAlt == null || normalizeAlt(proposedAlt) === '') {
    const where = moduleTarget ? ` It will be written to the alt attribute of the ${moduleTarget.moduleLabel} that shows this image (the media library is not changed).` : '';
    return finish('needs_input', why('ALT_TEXT_REQUIRED', 'No alt text has been prepared yet. Write what the image shows and why it is on the page' + (suggestions.length ? ', or adapt one of the texts the site already published about it.' : '.') + where));
  }

  const validation = validateProposedAlt(proposedAlt);
  if (!validation.ok) return finish('validation_failed', why('ALT_TEXT_INVALID', validation.errors[0]), { validation });

  // The Divi module is the write target: its own stored value is what changes, whatever the library holds.
  if (moduleTarget) {
    if (moduleTarget.storedAlt === validation.value) return finish('nothing_to_change', why('ALREADY_SET', 'The Divi module already holds exactly this alt text.'), { validation });
    return finish('ready', {}, {
      validation,
      change: { field: DIVI_FIELD, before: moduleTarget.storedAlt, after: validation.value, attachmentId: identity.attachmentId },
    });
  }

  if (currentAlt === validation.value) return finish('nothing_to_change', why('ALREADY_SET', 'The media library already holds exactly this alt text.'), { validation });
  // Meaningful existing alt text is never replaced merely because a suggestion exists. (A non-meaningful one — a file name, "image" — may be replaced by a reviewed change.)
  if (currentAlt && diag.libraryMeaningful) {
    return finish('existing_alt_preserved', why('EXISTING_ALT_PRESERVED', `The media library already has alt text ("${currentAlt}"). Odito keeps existing alt text; if the page still shows no alt, recrawl it or check where the page stores the image.`), { validation });
  }

  return finish('ready', {}, {
    validation,
    change: { field: ALT_FIELD, before: currentAlt, after: validation.value, attachmentId: identity.attachmentId },
  });
}

function seal(plan, { identity, content, siteHost, snapshot, context = {}, diag, target = null }) {
  const t = plan.target;
  const material = JSON.stringify({
    v: ALT_PLAN_VERSION, t: ALT_FIX_TYPE,
    ctx: [String(context.projectId ?? ''), String(context.connectionId ?? ''), String(context.pageUrl ?? '')],
    s: plan.status, c: plan.code,
    id: identity?.attachmentId ?? null, m: identity?.method ?? null, cf: identity?.confidence ?? null,
    b: plan.change?.before ?? plan.currentAlt, a: plan.change?.after ?? null,
    ce: content?.status ?? null, k: plan.classification?.kind, h: siteHost, src: snapshot?.src ?? null,
    ds: diag?.state ?? null, dsrc: diag?.source ?? null,
    // The write target is part of what was approved: another page state, module, identity or stored value is a different plan.
    tg: t ? [t.kind, t.postType, t.postId, t.pageFingerprint, t.module, t.identity?.signature, t.identity?.context, t.storedAlt, t.diviVersion, t.rendered?.empty, t.rendered?.total] : (target?.status ?? null),
  });
  return { ...plan, fingerprint: crypto.createHash('sha256').update(material).digest('hex') };
}

export default { planAltFix, ALT_FIX_TYPE, ALT_FIELD };
