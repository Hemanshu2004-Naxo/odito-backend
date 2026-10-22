import mongoose from 'mongoose';
import wordPressService, { WordPressConnectionError } from './wordPressService.js';
import oditoSeoBridgeService from './oditoSeoBridgeService.js';
import { getAdapterForConnection } from '../adapters/index.js';
import taskHistoryService from '../../tasks/service/TaskHistoryService.js';
import { inferSnapshotType } from '../../tasks/service/issueSnapshotTypes.js';
import Task from '../../tasks/model/Task.js';
import Recommendation from '../../recommendations/model/Recommendation.js';
import { applyH1Change, getH1Context as getContentH1Context } from '../content/wordPressContentService.js';
import { normalizeH1Value } from '../../tasks/service/h1Value.js';
import { resolutionFailureToError } from './wordPressUrlResolver.js';
import {
  normalizeTextValue,
  canonicalValuesMatch,
  parseRobotsDirectives,
  robotsValueToWireString,
  robotsValuesMatch,
} from '../../tasks/service/valueNormalization.js';
import {
  buildFaqPageJsonLd,
  faqPairsMatch,
  faqPairsAreSubset,
  sanitizeFaqPairs,
} from '../../tasks/service/faqSchema.js';
import { sameAsComparisonKey, validateSocialProfileList, SOCIAL_PROFILE_LIMITS } from '../../tasks/service/socialProfileUrls.js';
import {
  buildAggregateRatingNode,
  flattenSchemaNodes,
  ratingIsVisible,
  ratingsEqual,
} from '../../tasks/service/aggregateRatingSchema.js';

/**
 * WordPressSeoFixService (Phase 4, Step 4-9 of the locked architecture)
 *
 * Owns validateFix()/readCurrentValue()/applyFix() for a single, already
 * user-approved WordPress SEO fix. Provider-agnostic on purpose — every
 * `if (provider === ...)` branch lives in the adapters (../adapters/), never
 * here or in the controller. Callers pass an already-loaded, already
 * ownership-checked Task document (see taskController.applyWordPressFix) —
 * this service never loads a Task by a client-supplied ID itself, and never
 * accepts a provider/metaKey/endpoint from the caller: every one of those is
 * derived from the Task's own issueKey + its project's WordPressConnection.
 *
 * Scope: title, meta_description, canonical, robots (post-scoped — see
 * FIELD_CONFIG below), plus same_as and breadcrumb (SITE-scoped — no post
 * ID involved at all, see the `scope: 'site'` branches in validateFix()/
 * readCurrentValue()/applyFix()). See providerCapabilityRegistry.js for
 * the full, current issue -> field capability matrix, including the
 * Organization/Person schema fields intentionally NOT yet wired to an
 * automatable issue. `h1` (issue h1_missing only) is the one PAGE-CONTENT fix:
 * it does not touch an SEO plugin or the Bridge at all — see the `contentChannel`
 * branches and ../content/ (builder adapters, Divi only today). Deliberately
 * excludes `image_alt` (the existing Task/seo_page_issues before-snapshot for
 * `images_missing_alt_text` is not yet confirmed to carry a specific image
 * `src` this service could safely target — see the Phase 4 implementation
 * report's Remaining Limitations; wordpressCoreAdapter.writeAltText already
 * exists and is unit-tested, ready to be wired in once that's resolved).
 * Slug is similarly excluded: wordpressCoreAdapter.writeSlug exists, but
 * issueSnapshotTypes.js (which this service deliberately does not modify)
 * has no 'slug' snapshot type, so TaskVerificationService has no way to
 * verify a slug change — wiring slug in here without that would create a
 * WordPress fix Odito can apply but can never confirm or detect a
 * regression on, which is worse than not offering it yet.
 */

const FIELD_CONFIG = {
  title: {
    capabilityKey: 'title',
    writeMethod: 'writeTitle',
    readValue: (seo) => seo.title,
    expectedValue: (expected) => expected?.title,
  },
  meta_description: {
    capabilityKey: 'metaDescription',
    writeMethod: 'writeMetaDescription',
    readValue: (seo) => seo.metaDescription,
    expectedValue: (expected) => expected?.metaDescription,
  },
  canonical: {
    capabilityKey: 'canonical',
    writeMethod: 'writeCanonical',
    readValue: (seo) => seo.canonical,
    expectedValue: (expected) => expected?.canonical,
  },
  robots: {
    capabilityKey: 'robots',
    // Bridge-only: no legacy direct adapter currently reports write:true for
    // robots on any provider (see oditoSeoBridgeService.toLegacySeoShape and
    // the adapters/ files — none expose a robots field at all), so
    // validateFix()'s legacy branch always throws FIELD_NOT_WRITABLE before
    // this could ever be invoked; kept null rather than a fabricated method
    // name that would never exist on any adapter.
    writeMethod: null,
    // seo.robots is the Bridge's raw wire string (see
    // oditoSeoBridgeService.toLegacySeoShape) — parsed into the
    // {index, follow} shape here, at the point of use, so every comparison
    // in this file (valuesEqual, conflictValuesEqual) operates on the same
    // internal representation TaskHistoryService/TaskVerificationService use,
    // never on the wire string directly.
    // typeof seo.robots !== 'string' means the active provider/Bridge does
    // not report robots at all (e.g. Yoast/AIOSEO/SEOPress today, or no
    // Bridge) — null here (never a fabricated {index:true,follow:true}) so
    // that case is correctly treated as "can't confirm", exactly like an
    // unset title/meta_description/canonical.
    readValue: (seo) => (typeof seo.robots === 'string' ? parseRobotsDirectives(seo.robots) : null),
    expectedValue: (expected) => (expected ? { index: expected.index, follow: expected.follow } : null),
    // The frontend echoes back the SAME wire string it displayed (see
    // wordPressSeoDataService.getPageSeoData -> toLegacySeoShape) as
    // expectedCurrentValue — parsed the same way as a live read so the
    // read-before-write conflict check compares like with like.
    parseExpectedCurrentValue: (raw) => parseRobotsDirectives(typeof raw === 'string' ? raw : ''),
    // Converts the internal {index, follow} desired value to the Bridge's
    // wire string immediately before the PUT — the ONLY point in this file
    // where the object form is serialized back to a string.
    toWireValue: robotsValueToWireString,
  },
  // ── FAQPage schema — page-scoped like the fields above, but NOT written
  // through an SEO plugin's /seo/{postId} field. `channel: 'faq_schema'`
  // routes it to the Bridge's own /faq-schema/{postId} route (see the
  // `config.channel` branches in validateFix()/readCurrentValue()/applyFix()):
  // the Bridge stores the schema's Q/A pairs in one meta key of its own and
  // renders the JSON-LD itself, so it works with any (or no) SEO plugin and
  // never edits post content. The value in both directions is the list of
  // {question, answer} pairs — the schema object is rebuilt from them at the
  // single point of writing.
  faq_schema: {
    channel: 'faq_schema',
    readValue: (faq) => faq.pairs,
    expectedValue: (expected) => (expected?.pairs?.length ? expected.pairs : null),
  },
  // ── AggregateRating — same channel model as faq_schema (see SCHEMA_CHANNELS).
  // The value in both directions is {target: {type, id, name}, rating}: the
  // EXISTING entity the rating is attached to (by @id) and the rating figures.
  aggregate_rating: {
    channel: 'aggregate_rating',
    readValue: (stored) => stored.value,
    expectedValue: (expected) => (expected?.target && expected?.rating ? { target: expected.target, rating: expected.rating } : null),
  },
  // ── Page H1 — PAGE CONTENT, not an SEO field. `contentChannel` routes it to the
  // content adapters (../content/) over WordPress core REST: no SEO plugin, no Bridge,
  // no meta key. Only h1_missing is applicable (multiple_h1_tags shares the snapshot type
  // but is never auto-fixed: which H1 to change is a judgement call). The value is the
  // recommendation's plain-text H1; the adapter validates/normalizes it again at write time.
  h1: {
    contentChannel: 'h1',
    contentIssueCodes: ['h1_missing'],
    expectedValue: (expected) => expected?.h1Text,
  },
  // ── Site-scoped fields (scope: 'site') — NOT tied to any one post. Every
  // field above this point resolves a WordPress post ID and reads/writes
  // through /seo/{postId}; these two instead read/write the site's
  // Organization/Knowledge Graph and breadcrumb settings via /seo/site.
  // validateFix()/readCurrentValue()/applyFix() all check `config.scope`
  // and branch to oditoSeoBridgeService.getSiteSchema()/
  // updateSiteSchemaField() instead of the per-post equivalents — see
  // those functions below.
  same_as: {
    scope: 'site',
    siteEntity: 'organization',
    siteField: 'sameAs',
    // Unlike every other field here, the value is NOT derived from the linked
    // Recommendation: the site owner types their own verified profile URLs and
    // Odito never invents one (the AI recommendation is only told to say
    // "not provided in context"). Applied by applySameAsFix() below, which
    // writes ONLY Rank Math's social_additional_profiles bucket, one URL at a
    // time, through the Bridge's typed add/remove operations.
    userSuppliedValue: true,
    readValue: (schema) => schema.organization.sameAs,
  },
  breadcrumb: {
    scope: 'site',
    siteEntity: 'breadcrumbs',
    siteField: 'enabled',
    readValue: (schema) => schema.breadcrumbs.enabled,
    expectedValue: (expected) => (expected?.enabled ? true : null),
  },
};

/**
 * Type-aware value equality, sharing valueNormalization.js with
 * TaskVerificationService._valuesMatch() so "does this look like the same
 * value" can never silently disagree between the immediate check here and
 * the authoritative post-recrawl check there. Canonical gets its own
 * trailing-slash-tolerant comparison; every other supported field (title,
 * meta_description) uses the general text normalization (HTML-entity/
 * typographic-quote folding — see valueNormalization.js's own docblock for
 * why that matters even for this immediate, same-request comparison: the
 * adapters' `raw` reads are usually un-texturized, but a provider that only
 * exposes a rendered/escaped value would otherwise cause a false conflict).
 */
function valuesEqual(type, a, b) {
  if (type === 'canonical') return canonicalValuesMatch(a, b);
  if (type === 'robots') return robotsValuesMatch(a, b);
  if (type === 'breadcrumb') return a === b;
  // faq_schema: both sides are Q/A pair lists — equal only if every question
  // AND answer matches (order-insensitive, typography-tolerant).
  if (type === 'faq_schema') return faqPairsMatch(a, b);
  // aggregate_rating: same entity (@id) AND exactly the same figures.
  if (type === 'aggregate_rating') return !!a?.target?.id && a.target.id === b?.target?.id && ratingsEqual(a.rating, b.rating);
  return normalizeTextValue(a) === normalizeTextValue(b);
}

function isEmptyValue(value) {
  return value === null || value === undefined || value === '';
}

/**
 * Equality specifically for the read-before-write CONFLICT check, where the
 * question is "did the live value change since the user saw it" — unlike
 * valuesEqual()/canonicalValuesMatch() above (used for "does this match the
 * value we're trying to write," where an empty result deliberately never
 * counts as a match), two empty values here genuinely mean "unchanged,"
 * not "can't confirm." Without this distinction, a field that was and
 * still is empty (e.g. no canonical set) would incorrectly 409 on every
 * apply attempt.
 */
function conflictValuesEqual(type, a, b) {
  if (isEmptyValue(a) && isEmptyValue(b)) return true;
  if (isEmptyValue(a) || isEmptyValue(b)) return false;
  return valuesEqual(type, a, b);
}

/**
 * Structured log line for the WordPress fix lifecycle — normalized to the
 * event names the production-readiness audit specified (wordpress_fix_
 * started/applied/skipped/failed/conflict/verified), following this
 * codebase's existing convention (a plain console.log/[MODULE] tag with
 * pipe-separated key=value pairs — see TaskVerificationService.js,
 * taskController.js, etc.) rather than introducing a logging framework the
 * project doesn't otherwise use. Only ever passed safe identifiers —
 * NEVER a connection object, an Authorization header, or a raw WordPress
 * response body.
 */
function logFixEvent(event, task, fields = {}) {
  const parts = [
    `projectId=${task.projectId}`,
    `taskId=${task._id}`,
    `pageUrl=${task.pageUrl}`,
    ...Object.entries(fields).map(([key, value]) => `${key}=${value}`),
  ];
  console.log(`[WORDPRESS_FIX] ${event} | ${parts.join(' | ')}`);
}

/**
 * The page this task refers to, resolved through the ONE shared URL resolver
 * (wordPressUrlResolver.js). When it cannot be resolved, the error says WHY — different site,
 * blog-index homepage, unsupported content type, not exposed by REST — instead of one generic line.
 */
async function resolvePageOrThrow(connection, pageUrl) {
  const resolved = await wordPressService.resolvePostIdFromUrl(connection, pageUrl);
  if (resolved) return resolved;
  let why = null;
  try {
    const detail = await wordPressService.resolveWordPressResource(connection, pageUrl);
    if (detail && !detail.resolved) why = detail;
  } catch {
    // A failure while explaining must not hide the fact that the page was not resolved.
  }
  throw resolutionFailureToError(why || { reason: 'not_exposed_by_rest' });
}

/**
 * A Task may only be applied via WordPress from a status that can move to 'implemented' — the same gate the manual
 * "Mark as implemented" flow uses (see the comment where validateFix calls it).
 */
function assertTransitionAllowed(task) {
  if (!Task.isValidTransition(task.status, 'implemented')) {
    throw new WordPressConnectionError(
      'CONFLICT',
      `This task cannot be applied via WordPress from its current status (${task.status}). Refresh the page — it may have already been implemented or verified by a recent recrawl.`,
      409
    );
  }
}

/**
 * The task must link a Recommendation that belongs to its OWN project: this is the first flow that writes a
 * recommendation-derived value to a live external system, so a missing or cross-project link is refused.
 */
async function assertRecommendationLinked(task) {
  if (!task.recommendationId) {
    // Distinct from the generic WRITE_FAILED below — this is never a
    // transient/retryable failure (a WordPress outage, a stale value) but a
    // structural precondition that can only be resolved by generating and
    // linking a recommendation first. The frontend uses this specific code
    // to disable retry and point the user at that action, rather than
    // treating it like any other failed attempt worth immediately retrying.
    throw new WordPressConnectionError(
      'RECOMMENDATION_REQUIRED',
      'No AI recommendation is linked to this task yet — generate one before applying a WordPress fix.',
      422
    );
  }

  // Bug fix (production-readiness audit): confirm the linked Recommendation
  // actually belongs to this task's OWN project before ever using its
  // content as the value written to WordPress. Task.recommendationId is
  // client-suppliable on task creation/re-implementation (createTask/
  // updateTaskStatus in taskController.js) with no existing ownership
  // check — harmless for the manual/DIY flows (the value is only ever
  // displayed back to the same user), but this is the first flow that
  // WRITES that value to a live external system, so a cross-project
  // recommendationId must be rejected here rather than silently trusted.
  const linkedRecommendation = await Recommendation.findById(task.recommendationId).select('projectId').lean();
  if (!linkedRecommendation || linkedRecommendation.projectId.toString() !== task.projectId.toString()) {
    // Same non-retryable treatment as the missing-recommendationId case
    // above — the task's recommendation link is invalid (deleted, or
    // pointing cross-project), and no amount of retrying this exact
    // request fixes that; a fresh, correctly-linked recommendation is
    // required either way.
    throw new WordPressConnectionError(
      'RECOMMENDATION_REQUIRED',
      'The recommendation linked to this task is missing or does not belong to this project.',
      422
    );
  }
}

/**
 * Resolves everything about a Task needed to attempt a WordPress fix,
 * WITHOUT reading or writing any live WordPress value yet. Throws a typed
 * WordPressConnectionError for every reason a fix can't proceed — the
 * controller relays `.code`/`.statusCode` directly, never a generic 500.
 */
async function validateFix(task) {
  // Bug fix (production-readiness audit): this path previously called
  // TaskHistoryService.applyImplementedTransition() unconditionally,
  // bypassing the SAME Task.isValidTransition() gate updateTaskStatus()
  // already enforces for the manual "Mark as Implemented" flow. Without
  // this check, applying via WordPress could resurrect a terminal
  // 'verified_fixed' task straight back to 'implemented' (skipping
  // 'reopened' entirely — an invalid transition per Task.js's own state
  // machine) whenever the frontend's cached task status is stale relative
  // to a background TaskVerificationService pass that already moved it to
  // 'verified_fixed' or re-'implemented' it. Reusing the existing static
  // rather than inventing new state logic.
  assertTransitionAllowed(task);

  const type = inferSnapshotType(task.issueKey);
  const config = type && FIELD_CONFIG[type];
  if (!config) {
    throw new WordPressConnectionError(
      'FIELD_NOT_WRITABLE',
      'This issue type cannot be applied via WordPress yet.',
      422
    );
  }

  if (config.contentIssueCodes && !config.contentIssueCodes.includes(task.issueKey)) {
    throw new WordPressConnectionError(
      'FIELD_NOT_WRITABLE',
      'This issue cannot be changed automatically: only a missing H1 is applied via WordPress. Multiple H1s need a human decision about which to change.',
      422
    );
  }

  await assertRecommendationLinked(task);

  const connection = await wordPressService.getHydratedConnectionOrThrow(task.projectId);

  // ── Page content (H1) — independent of any SEO plugin and of the Bridge ─
  // Whether the page can be changed is decided per page by its builder adapter at apply time.
  if (config.contentChannel) {
    return { type, config, connection, contentChannel: config.contentChannel, bridgeProvider: 'none' };
  }

  // ── Odito SEO Bridge (preferred write layer) ────────────────────────────
  // The Bridge plugin is checked FIRST and, when it resolves to exactly one
  // supported provider, takes priority over the legacy direct-adapter path
  // below — it is the only way to actually write Rank Math/Yoast fields
  // (their public REST APIs expose no writable field for them; see
  // rankMathAdapter.js/yoastAdapter.js). The Bridge's own live-detected
  // provider is used here rather than the connection's possibly-stale
  // `detected_seo_provider` (set at connect/verify time from plugin-listing
  // + namespace probing) — the Bridge runs inside WordPress itself and can
  // check `is_active()`/class-exists in real time.
  //
  // "Prefer Bridge, no silent fallback to unsafe writes" (migration
  // strategy): if the Bridge is installed but reports 'multiple' (ambiguous
  // active SEO plugins), this is surfaced as the SAME PLUGIN_NOT_SUPPORTED
  // conflict the legacy path already raises for ambiguity — never silently
  // falls through to the legacy adapter, which could not disambiguate this
  // any better. Only when the Bridge is NOT installed, or reports 'none',
  // does control fall through to the legacy adapter path unchanged.
  const bridgeStatus = await oditoSeoBridgeService.getBridgeStatus(connection);

  // ── Schema channels (faq_schema, aggregate_rating) ──────────────────────
  // Checked BEFORE the SEO-provider ambiguity gate below on purpose: the
  // Bridge renders this JSON-LD itself, so which SEO plugin(s) are active
  // (even several, or none) is irrelevant to whether it can be applied.
  const schemaChannel = config.channel ? SCHEMA_CHANNELS[config.channel] : null;
  if (schemaChannel) {
    if (!bridgeStatus.installed) {
      throw new WordPressConnectionError(
        'FIELD_NOT_WRITABLE',
        `Applying ${schemaChannel.label} requires the Odito SEO Bridge plugin to be installed and active on this WordPress site.`,
        422
      );
    }
    if (!bridgeStatus[schemaChannel.supportFlag]) {
      throw new WordPressConnectionError(
        'FIELD_NOT_WRITABLE',
        `Applying ${schemaChannel.label} requires a newer version of the Odito SEO Bridge plugin than is currently installed on this WordPress site. Update the plugin, then try again.`,
        422
      );
    }
    const resolved = await resolvePageOrThrow(connection, task.pageUrl);
    return {
      type,
      config,
      connection,
      useBridge: true,
      channel: config.channel,
      // Recorded on the Task as externalWrite.provider (an enum that has no
      // 'multiple'): this write never goes through an SEO plugin, so 'none'
      // is the accurate value whatever the site's SEO setup is.
      bridgeProvider: 'none',
      postId: resolved.postId,
    };
  }

  if (bridgeStatus.installed && bridgeStatus.provider === 'multiple') {
    throw new WordPressConnectionError(
      'PLUGIN_NOT_SUPPORTED',
      'Multiple SEO plugins are active on this WordPress site. Resolve the ambiguity before applying fixes.',
      409
    );
  }

  // ── Site-scoped fields (Organization sameAs, breadcrumbs) ───────────────
  // Genuinely different from every field below: no post to resolve, no
  // legacy adapter ever supports this (site-level schema has only ever
  // been confirmed for Rank Math, via the Bridge) — so a site-scoped field
  // either has full Bridge support right now or is refused outright, with
  // no legacy fallback path to fall through to.
  if (config.scope === 'site') {
    if (!bridgeStatus.installed || bridgeStatus.provider === 'none') {
      throw new WordPressConnectionError(
        'FIELD_NOT_WRITABLE',
        'This site-wide field requires the Odito SEO Bridge to be installed and active.',
        422
      );
    }
    if (!bridgeStatus.siteSchemaSupported) {
      // Distinguishes "Bridge installed but running an older version that
      // predates this capability" from every other FIELD_NOT_WRITABLE
      // reason — this is exactly the naxonify.com situation found during
      // live verification: the deployed Bridge plugin was never updated
      // after this capability was added to the Node backend.
      throw new WordPressConnectionError(
        'FIELD_NOT_WRITABLE',
        'This site-wide field requires a newer version of the Odito SEO Bridge plugin than is currently installed on this WordPress site. Update the plugin, then try again.',
        422
      );
    }
    return {
      type,
      config,
      connection,
      useBridge: true,
      scope: 'site',
      bridgeProvider: bridgeStatus.provider,
    };
  }

  if (bridgeStatus.installed && bridgeStatus.provider !== 'none') {
    const capabilities = await oditoSeoBridgeService.getBridgeCapabilities(connection);
    const capability = capabilities.fields[type];
    if (!capability?.write) {
      throw new WordPressConnectionError(
        'FIELD_NOT_WRITABLE',
        `This field cannot currently be edited on this WordPress site's SEO setup (${bridgeStatus.provider}).`,
        422
      );
    }

    const resolved = await resolvePageOrThrow(connection, task.pageUrl);

    return {
      type,
      config,
      connection,
      useBridge: true,
      bridgeProvider: bridgeStatus.provider,
      postId: resolved.postId,
    };
  }

  // ── Legacy direct-adapter path (Bridge not installed) ───────────────────
  const { adapter, ambiguous } = getAdapterForConnection(connection);
  if (ambiguous) {
    throw new WordPressConnectionError(
      'PLUGIN_NOT_SUPPORTED',
      'Multiple SEO plugins are active on this WordPress site. Resolve the ambiguity before applying fixes.',
      409
    );
  }

  const capability = adapter.getCapabilities()[config.capabilityKey];
  if (!capability?.write) {
    throw new WordPressConnectionError(
      'FIELD_NOT_WRITABLE',
      `This field cannot currently be edited on this WordPress site's SEO setup (${connection.detected_seo_provider || 'none'}).`,
      422
    );
  }

  return { type, config, connection, useBridge: false, adapter };
}

/**
 * Live read of just the one field this fix targets, via whichever write
 * layer validateFix() resolved — the Bridge (when installed and
 * unambiguous) or the legacy direct adapter otherwise. `validation` is the
 * object validateFix() returned; `pageUrl` is only used on the legacy path
 * (adapters resolve their own postId internally), since the Bridge path
 * already resolved and cached `postId` once, in validateFix().
 */
async function readCurrentValue(validation, config, pageUrl) {
  if (validation.scope === 'site') {
    const schema = await oditoSeoBridgeService.getSiteSchema(validation.connection);
    return { currentValue: config.readValue(schema) };
  }

  if (validation.channel) {
    const stored = await SCHEMA_CHANNELS[validation.channel].read(validation.connection, validation.postId);
    return { currentValue: config.readValue(stored) };
  }

  if (validation.useBridge) {
    const seoData = await oditoSeoBridgeService.readSeoData(validation.connection, validation.postId);
    // Same shared reshaping oditoSeoBridgeService.js exports for
    // wordPressSeoDataService.getPageSeoData() — the Apply-fix dialog's
    // displayed "current value" and this write-time conflict-check read
    // must never diverge by going through two different mappings of the
    // same underlying Bridge response.
    const normalized = oditoSeoBridgeService.toLegacySeoShape(seoData.fields);
    return { currentValue: config.readValue(normalized) };
  }

  const seoData = await validation.adapter.getSeoData(pageUrl);
  if (!seoData) {
    throw new WordPressConnectionError(
      'FIELD_NOT_WRITABLE',
      'This page could not be resolved to a WordPress post or page.',
      422
    );
  }
  return { currentValue: config.readValue(seoData.seo) };
}

/**
 * The value Odito will write — ALWAYS derived server-side from the Task's
 * own linked Recommendation, never from the request body. This is what
 * makes it impossible for a client to submit an arbitrary "after" value.
 */
async function resolveDesiredValue(task, config) {
  const { expectedAfterValue } = await taskHistoryService.resolveExpectedValue(task.recommendationId, task.issueKey);
  const desired = config.expectedValue(expectedAfterValue);
  if (desired == null || desired === '') {
    throw new WordPressConnectionError(
      'WRITE_FAILED',
      'The linked recommendation does not provide a usable value for this field.',
      422
    );
  }
  return desired;
}

/**
 * FAQ schema may only ever describe FAQs that are actually visible on the
 * page. The pairs about to be written come from a stored Recommendation; this
 * re-checks them, at write time, against the LATEST crawl of the page's
 * visible FAQ pairs — so a recommendation that has gone stale (the FAQ was
 * edited or removed since it was generated) is refused rather than published
 * as schema that no longer matches the page.
 */
async function assertFaqPairsAreVisibleOnPage(task, desiredPairs) {
  const page = await mongoose.connection.db.collection('seo_page_data').findOne(
    { projectId: task.projectId, url: task.pageUrl },
    { projection: { 'faq_howto_signals.faq_pairs': 1 } }
  );
  const visiblePairs = sanitizeFaqPairs(page?.faq_howto_signals?.faq_pairs);
  if (!faqPairsAreSubset(desiredPairs, visiblePairs)) {
    logFixEvent('wordpress_fix_conflict', task, { field: 'faq_schema', reason: 'faq_content_changed' });
    const error = new WordPressConnectionError(
      'FAQ_CONTENT_CHANGED',
      'The FAQ on this page no longer matches the generated schema. Generate the recommendation again from the current page content, then apply it.',
      409
    );
    error.details = { field: 'faq_schema', regenerateRequired: true };
    throw error;
  }
}

/**
 * AggregateRating may only ever describe a rating the page actually displays,
 * on an entity that really exists in the page's schema. Re-checked at write time
 * against the LATEST crawl: the generated rating must still be one of the
 * displayed figures, and the target entity (@id) must still be in the page's
 * structured data — otherwise the recommendation is stale and is refused.
 */
async function assertRatingIsVisibleOnPage(task, desired) {
  const page = await mongoose.connection.db.collection('seo_page_data').findOne(
    { projectId: task.projectId, url: task.pageUrl },
    { projection: { 'rating_signals.rating_candidates': 1, structured_data: 1 } }
  );
  const shown = ratingIsVisible(desired.rating, page?.rating_signals?.rating_candidates);
  const targetStillThere = flattenSchemaNodes(page?.structured_data).some((n) => n['@id'] === desired.target.id);
  if (!shown || !targetStillThere) {
    logFixEvent('wordpress_fix_conflict', task, { field: 'aggregate_rating', reason: 'rating_content_changed' });
    const error = new WordPressConnectionError(
      'RATING_CONTENT_CHANGED',
      'The rating on this page, or the schema entity it belongs to, no longer matches the generated schema. Generate the recommendation again from the current page content, then apply it.',
      409
    );
    error.details = { field: 'aggregate_rating', regenerateRequired: true };
    throw error;
  }
}

/**
 * Bridge-owned schema channels: how each one is read, written, and re-checked
 * against the page. Adding a channel is one entry here plus a FIELD_CONFIG entry.
 *   supportFlag — getBridgeStatus() flag (independent of the SEO provider)
 *   write       — receives the validated desired value; builds the JSON-LD at the
 *                 single point of writing, never forwarding client content
 */
const SCHEMA_CHANNELS = {
  faq_schema: {
    label: 'FAQ schema',
    supportFlag: 'faqSchemaSupported',
    read: (connection, postId) => oditoSeoBridgeService.readFaqSchema(connection, postId),
    write: (connection, postId, desired) => oditoSeoBridgeService.writeFaqSchema(connection, postId, buildFaqPageJsonLd(desired)),
    assertStillOnPage: assertFaqPairsAreVisibleOnPage,
  },
  aggregate_rating: {
    label: 'AggregateRating schema',
    supportFlag: 'ratingSchemaSupported',
    read: (connection, postId) => oditoSeoBridgeService.readRatingSchema(connection, postId),
    write: (connection, postId, desired) => oditoSeoBridgeService.writeRatingSchema(connection, postId, buildAggregateRatingNode(desired)),
    assertStillOnPage: assertRatingIsVisibleOnPage,
  },
};

// ── sameAs: site-owner-supplied social profiles ──────────────────────────────

const SAME_AS_EXPECTED_LIST_MAX = 200;

function invalidProfiles(message, errors) {
  const error = new WordPressConnectionError('INVALID_PROFILES', message, 400);
  error.details = { field: 'same_as', errors };
  return error;
}

/**
 * Validates everything the client sent for a sameAs fix, before any WordPress
 * call. The frontend's own validation is a convenience only — this is the
 * enforcement. Returns normalized, de-duplicated data; throws a typed 400 that
 * names each offending entry otherwise.
 *
 * The client can send ONLY profile URLs (plus the list it displayed, for stale
 * detection). It can never name a WordPress option, meta key, Rank Math field
 * or schema object: the storage location is fixed in applySameAsFix().
 */
function parseSameAsInput({ additionalProfiles, removeProfiles, expectedAdditionalProfiles }) {
  const additions = validateSocialProfileList(additionalProfiles, { min: 1 });
  if (!additions.valid) {
    throw invalidProfiles(
      additions.errors[0].message,
      additions.errors.map((e) => ({ list: 'additionalProfiles', index: e.index, code: e.code, message: e.message }))
    );
  }

  // Removals refer to profiles already stored on the site, so they only need to
  // be recognisable URLs (matched against the live list by comparison key) —
  // not pass the stricter "may be newly added" rules.
  let removals = [];
  if (removeProfiles !== undefined && removeProfiles !== null) {
    if (!Array.isArray(removeProfiles) || removeProfiles.length > SOCIAL_PROFILE_LIMITS.maxProfilesPerRequest) {
      throw invalidProfiles(
        `removeProfiles must be a list of at most ${SOCIAL_PROFILE_LIMITS.maxProfilesPerRequest} URLs.`,
        [{ list: 'removeProfiles', index: null, code: 'INVALID_LIST' }]
      );
    }
    const seen = new Set();
    removals = removeProfiles.map((raw, index) => {
      const key = sameAsComparisonKey(raw);
      if (!key || seen.has(key)) {
        throw invalidProfiles(
          'A profile to remove is not a valid, unique URL.',
          [{ list: 'removeProfiles', index, code: key ? 'DUPLICATE' : 'INVALID_URL' }]
        );
      }
      seen.add(key);
      return { key, input: raw.trim() };
    });
  }

  const additionKeys = new Set(additions.keys);
  const overlap = removals.findIndex((r) => additionKeys.has(r.key));
  if (overlap !== -1) {
    throw invalidProfiles(
      'The same profile cannot be added and removed in one request.',
      [{ list: 'removeProfiles', index: overlap, code: 'ADD_AND_REMOVE' }]
    );
  }

  let expected;
  if (expectedAdditionalProfiles !== undefined && expectedAdditionalProfiles !== null) {
    if (
      !Array.isArray(expectedAdditionalProfiles) ||
      expectedAdditionalProfiles.length > SAME_AS_EXPECTED_LIST_MAX ||
      expectedAdditionalProfiles.some((u) => typeof u !== 'string' || u.length > SOCIAL_PROFILE_LIMITS.maxUrlLength)
    ) {
      throw invalidProfiles(
        'expectedAdditionalProfiles must be a list of URLs.',
        [{ list: 'expectedAdditionalProfiles', index: null, code: 'INVALID_LIST' }]
      );
    }
    expected = expectedAdditionalProfiles;
  }

  return { additions, removals, expected };
}

const profileKey = (raw) => sameAsComparisonKey(raw) ?? String(raw).trim();
const sortedProfileKeys = (list) => list.map(profileKey).sort();
const sameKeySet = (a, b) => {
  const [x, y] = [sortedProfileKeys(a), sortedProfileKeys(b)];
  return x.length === y.length && x.every((k, i) => k === y[i]);
};

/**
 * Saves the Task after a WordPress write already happened. A VersionError means
 * only recording it lost a race (WordPress has no transaction to roll back) —
 * surfaced as a CONFLICT that says the write itself succeeded.
 */
async function saveTaskRecordingWrite(task, type, provider) {
  try {
    await task.save();
  } catch (error) {
    if (error.name === 'VersionError') {
      // The WordPress write above already happened and is not rolled back —
      // only recording it on the Task lost the race. The caller should reload
      // the task (its next verification pass still picks this up via the live
      // WordPress value) rather than retry the write itself.
      logFixEvent('wordpress_fix_conflict', task, { field: type, provider, reason: 'task_version_conflict' });
      const conflict = new WordPressConnectionError(
        'CONFLICT',
        'This task was updated by another process while applying this fix. The WordPress write succeeded, but Odito could not record it on the task — please refresh.',
        409
      );
      conflict.details = { field: type, wordpressWriteSucceeded: true };
      throw conflict;
    }
    throw error;
  }
}

/**
 * Adds (and optionally removes) the site owner's social profile URLs on the
 * Organization schema — SITE-WIDE, Rank Math only.
 *
 * Storage is fixed here, never chosen by the client: Rank Math's
 * `social_additional_profiles`, reached only through the Bridge's typed
 * organization.sameAs add/remove operations. Facebook- and Twitter-derived
 * profiles (Rank Math's own social_url_facebook / twitter_author_names) are
 * structurally unreachable by those operations, and removing one is refused up
 * front. Existing additional profiles are never overwritten: each URL is
 * added/removed individually, so the result is a merge.
 *
 * Sequence: input already validated -> read live site schema -> stale check ->
 * classify (add / already present / remove / protected) -> write one URL at a
 * time -> read back and verify (added present, removed gone, others preserved,
 * protected + name/url/logo/description untouched) -> Task lifecycle. The
 * rendered-JSON-LD check is TaskVerificationService's, after the next crawl —
 * this never marks the task verified_fixed.
 */
async function applySameAsFix(task, validation, input) {
  const { type, connection } = validation;
  const provider = validation.bridgeProvider;

  if (provider !== 'rank_math') {
    throw new WordPressConnectionError(
      'FIELD_NOT_WRITABLE',
      "Social profiles can currently only be applied to Rank Math's Organization schema.",
      422
    );
  }

  const org = (await oditoSeoBridgeService.getSiteSchema(connection)).organization;
  const liveAdditional = org.additionalSameAs || [];
  const liveProtected = org.protectedSameAs || [];

  if (input.expected !== undefined && !sameKeySet(input.expected, liveAdditional)) {
    logFixEvent('wordpress_fix_conflict', task, { field: type, provider, reason: 'stale_site_schema' });
    const conflict = new WordPressConnectionError(
      'CONFLICT',
      'The social profiles on WordPress have changed since this dialog was opened. Refresh and review them before applying again.',
      409
    );
    conflict.details = { field: type, expectedCurrentValue: input.expected, actualCurrentValue: liveAdditional };
    throw conflict;
  }

  const protectedKeys = new Set(liveProtected.map(profileKey));
  const additionalByKey = new Map(liveAdditional.map((url) => [profileKey(url), url]));

  // Removals: only the managed additional bucket. A Facebook/Twitter-derived
  // profile is refused explicitly; a URL that is no longer in the list means the
  // site changed under the user (conflict), never a silent no-op.
  const toRemove = input.removals.map((removal) => {
    if (protectedKeys.has(removal.key)) {
      const error = new WordPressConnectionError(
        'PROFILE_PROTECTED',
        "This profile is managed by Rank Math's Facebook/Twitter settings and cannot be removed from here.",
        422
      );
      error.details = { field: type };
      throw error;
    }
    const stored = additionalByKey.get(removal.key);
    if (!stored) {
      logFixEvent('wordpress_fix_conflict', task, { field: type, provider, reason: 'profile_to_remove_not_found' });
      const conflict = new WordPressConnectionError(
        'CONFLICT',
        'A profile you asked to remove is no longer in the additional profiles list. Refresh and review before applying again.',
        409
      );
      conflict.details = { field: type, actualCurrentValue: liveAdditional };
      throw conflict;
    }
    return { key: removal.key, stored };
  });

  const alreadyPresent = [];
  const toAdd = [];
  input.additions.urls.forEach((url, i) => {
    const key = input.additions.keys[i];
    if (protectedKeys.has(key) || additionalByKey.has(key)) alreadyPresent.push(url);
    else toAdd.push(url);
  });

  const alreadyApplied = toAdd.length === 0 && toRemove.length === 0;
  let writeResult = { httpStatus: null };

  if (alreadyApplied) {
    logFixEvent('wordpress_fix_skipped', task, { field: type, provider, reason: 'already_applied' });
  } else {
    let written = 0;
    try {
      // Added first, then removed: a failure part-way never leaves the site with
      // fewer profiles than it started with.
      for (const url of toAdd) {
        await oditoSeoBridgeService.updateSiteSchemaField(connection, 'organization', 'sameAs', url, 'add');
        written += 1;
      }
      for (const removal of toRemove) {
        await oditoSeoBridgeService.updateSiteSchemaField(connection, 'organization', 'sameAs', removal.stored, 'remove');
        written += 1;
      }
      writeResult = { httpStatus: 200 };
      logFixEvent('wordpress_fix_applied', task, { field: type, provider, added: toAdd.length, removed: toRemove.length });
    } catch (error) {
      logFixEvent('wordpress_fix_failed', task, { field: type, provider, code: error?.code || 'UNKNOWN_ERROR', written });
      const failure = error instanceof WordPressConnectionError
        ? error
        : new WordPressConnectionError('WRITE_FAILED', 'Failed to write this change to WordPress.', 502);
      if (written > 0) {
        // Each profile is its own write, so some may already be saved. Say so —
        // the dialog re-reads the live list on refresh.
        failure.details = { ...(failure.details || {}), field: type, partialWrite: true, profilesWritten: written };
      }
      throw failure;
    }
  }

  // ── Read back and verify ─────────────────────────────────────────────────
  let immediateVerification = 'success';
  let afterAdditional = null;
  if (!alreadyApplied) {
    try {
      const afterOrg = (await oditoSeoBridgeService.getSiteSchema(connection)).organization;
      afterAdditional = afterOrg.additionalSameAs || [];
      const afterKeys = new Set(afterAdditional.map(profileKey));
      const removedKeys = new Set(toRemove.map((r) => r.key));
      const checks = [
        toAdd.every((url) => afterKeys.has(profileKey(url))),
        toRemove.every((r) => !afterKeys.has(r.key)),
        liveAdditional.filter((u) => !removedKeys.has(profileKey(u))).every((u) => afterKeys.has(profileKey(u))),
        sameKeySet(afterOrg.protectedSameAs || [], liveProtected),
        ['name', 'description', 'url', 'logo'].every((field) => (afterOrg[field] ?? '') === (org[field] ?? '')),
      ];
      immediateVerification = checks.every(Boolean) ? 'success' : 'failed';
    } catch {
      immediateVerification = 'unknown';
    }
  } else {
    afterAdditional = liveAdditional;
  }
  logFixEvent('wordpress_fix_verified', task, { field: type, provider, result: immediateVerification });

  // What the write is expected to have produced — the Task's after-state when
  // the read-back itself was unavailable.
  const removedKeySet = new Set(toRemove.map((r) => r.key));
  const profilesAfter = afterAdditional ?? [...liveAdditional.filter((u) => !removedKeySet.has(profileKey(u))), ...toAdd];

  await taskHistoryService.applyImplementedTransition(task, {
    origin: 'wordpress_auto',
    recommendationId: task.recommendationId,
    externalWrite: {
      system: 'wordpress',
      provider,
      field: type,
      wordpressPostId: null,
      httpStatus: writeResult.httpStatus,
      writtenAt: new Date(),
      scope: 'site',
      profilesBefore: liveAdditional,
      profilesAfter,
    },
    // Frozen "after state": the URLs the site owner asked to have in the
    // Organization schema (including any that were already there), which is what
    // TaskVerificationService looks for in the rendered JSON-LD after the recrawl.
    expectedAfterValueOverride: { type, urls: input.additions.urls, additionalProfiles: profilesAfter },
  });
  await saveTaskRecordingWrite(task, type, provider);

  return {
    task,
    field: type,
    provider,
    alreadyApplied,
    immediateVerification,
    desiredValue: input.additions.urls,
    sameAs: {
      added: toAdd,
      alreadyPresent,
      removed: toRemove.map((r) => r.stored),
      additionalProfiles: profilesAfter,
      protectedProfiles: liveProtected,
    },
  };
}

/**
 * Applies a PAGE-CONTENT fix (the H1). The value is derived here from the Task's own
 * Recommendation; the client only supplies the fingerprint of the page state it reviewed.
 * Everything about locating and editing the page is in ../content/ — see
 * wordPressContentService.applyH1Change for the stale/rollback rules. Never marks the task
 * verified_fixed: TaskVerificationService does that after a real recrawl.
 */
async function applyContentFix(task, validation, { expectedContentFingerprint }) {
  const { type, config, connection } = validation;
  const provider = validation.bridgeProvider;
  const desiredValue = await resolveDesiredValue(task, config);

  let result;
  try {
    result = await applyH1Change(connection, {
      pageUrl: task.pageUrl,
      value: desiredValue,
      expectedFingerprint: expectedContentFingerprint,
    });
    logFixEvent('wordpress_fix_applied', task, { field: type, provider, wordpressPostId: result.postId, builder: result.builder.name });
  } catch (error) {
    const isConflict = error?.code === 'CONFLICT';
    logFixEvent(isConflict ? 'wordpress_fix_conflict' : 'wordpress_fix_failed', task, {
      field: type, provider, code: error?.code || 'UNKNOWN_ERROR', reason: error?.details?.reason || '-',
    });
    throw error instanceof WordPressConnectionError
      ? error
      : new WordPressConnectionError('WRITE_FAILED', 'Failed to write this change to WordPress.', 502);
  }
  logFixEvent('wordpress_fix_verified', task, { field: type, provider, result: result.immediateVerification });

  const externalWrite = {
    system: 'wordpress',
    provider,
    field: type,
    scope: 'post',
    wordpressPostId: result.postId,
    httpStatus: 200,
    writtenAt: new Date(),
    contentAdapter: result.builder.name,
    contentFingerprintBefore: result.before.fingerprint,
    contentFingerprintAfter: result.after.fingerprint,
  };

  await taskHistoryService.applyImplementedTransition(task, {
    origin: 'wordpress_auto',
    recommendationId: task.recommendationId,
    externalWrite,
    // Frozen for TaskVerificationService: exactly one H1, with the text that was written.
    expectedAfterValueOverride: { type, h1Text: result.value, h1Count: 1 },
  });
  await saveTaskRecordingWrite(task, type, provider);

  return {
    task,
    field: type,
    provider,
    alreadyApplied: false,
    immediateVerification: result.immediateVerification,
    desiredValue: result.value,
    content: {
      builder: result.builder,
      postId: result.postId,
      rendered: result.rendered,
    },
  };
}

/**
 * Read-only: can this page's H1 be fixed automatically, and what would change? `recommended`
 * is only ever PREVIEWED (validated/normalized for display) — it is never written; the write
 * derives its own value from the Task's Recommendation.
 */
async function readH1Context({ projectId, pageUrl, recommended }) {
  const connection = await wordPressService.getHydratedConnectionOrThrow(projectId);
  const context = await getContentH1Context(connection, pageUrl);
  const preview = recommended === undefined ? null : normalizeH1Value(String(recommended));
  return {
    ...context,
    recommended: preview ? (preview.ok ? { ok: true, text: preview.text } : { ok: false, code: preview.code, message: preview.message }) : null,
  };
}

/**
 * Applies one approved WordPress SEO fix end to end:
 *   validate -> read-before-write conflict check -> idempotency check ->
 *   write (skipped if already correct) -> immediate verification ->
 *   Task transition to 'implemented' (via TaskHistoryService, never
 *   hand-rolled here) -> task.save() (respecting Task's own optimistic
 *   concurrency).
 *
 * Never marks the task 'verified_fixed' — that remains
 * TaskVerificationService's authoritative call after a real recrawl.
 *
 * @param {import('../../tasks/model/Task.js').default} task - already
 *   loaded and ownership-checked by the caller (taskController.js)
 * @param {{ expectedCurrentValue?: string, approved: boolean }} input
 */
async function applyFix(task, { expectedCurrentValue, approved, additionalProfiles, removeProfiles, expectedAdditionalProfiles, expectedContentFingerprint } = {}) {
  logFixEvent('wordpress_fix_started', task, { issueKey: task.issueKey });

  if (approved !== true) {
    throw new WordPressConnectionError(
      'WRITE_FAILED',
      'This fix must be explicitly approved before it can be applied.',
      400
    );
  }

  // sameAs is the one fix whose value comes from the site owner. Its input is
  // validated in full BEFORE any WordPress call; for every other issue type,
  // profile fields are refused rather than silently ignored.
  const isSameAs = inferSnapshotType(task.issueKey) === 'same_as';
  const sameAsInput = isSameAs
    ? parseSameAsInput({ additionalProfiles, removeProfiles, expectedAdditionalProfiles })
    : null;
  if (!isSameAs && (additionalProfiles !== undefined || removeProfiles !== undefined || expectedAdditionalProfiles !== undefined)) {
    throw new WordPressConnectionError('INVALID_PROFILES', 'Social profiles can only be supplied for a sameAs issue.', 400);
  }

  const validation = await validateFix(task);
  if (isSameAs) return applySameAsFix(task, validation, sameAsInput);
  if (validation.contentChannel) return applyContentFix(task, validation, { expectedContentFingerprint });

  const { type, config, connection } = validation;
  const desiredValue = await resolveDesiredValue(task, config);
  if (config.channel) {
    await SCHEMA_CHANNELS[config.channel].assertStillOnPage(task, desiredValue);
  }
  // The Bridge's own live-detected provider is more current than the
  // connection's possibly-stale detected_seo_provider (see validateFix()'s
  // docblock) — prefer it whenever this fix went through the Bridge.
  const provider = validation.useBridge ? validation.bridgeProvider : (connection.detected_seo_provider || 'none');

  // ── READ-BEFORE-WRITE (mandatory, never skipped) ────────────────────────
  const { currentValue: liveCurrentValue } = await readCurrentValue(validation, config, task.pageUrl);

  // For fields whose wire format differs from their internal comparison
  // shape (only robots, today — a string over the wire, an {index, follow}
  // object everywhere else in this file), the client-supplied
  // expectedCurrentValue arrives in the SAME wire shape it was displayed in
  // and must be parsed the same way as a live read before comparing.
  const normalizedExpectedCurrentValue = (expectedCurrentValue !== undefined && config.parseExpectedCurrentValue)
    ? config.parseExpectedCurrentValue(expectedCurrentValue)
    : expectedCurrentValue;

  if (expectedCurrentValue !== undefined && !conflictValuesEqual(type, liveCurrentValue, normalizedExpectedCurrentValue)) {
    logFixEvent('wordpress_fix_conflict', task, { field: type, provider, reason: 'stale_current_value' });
    const conflict = new WordPressConnectionError(
      'CONFLICT',
      'The live value on WordPress has changed since this fix was reviewed. Refresh and try again.',
      409
    );
    conflict.details = { field: type, expectedCurrentValue, actualCurrentValue: liveCurrentValue };
    throw conflict;
  }

  // ── IDEMPOTENCY — never write a value that's already correct ────────────
  let writeResult = { httpStatus: null, wordpressPostId: null };
  let alreadyApplied = false;
  if (valuesEqual(type, liveCurrentValue, desiredValue)) {
    alreadyApplied = true;
    logFixEvent('wordpress_fix_skipped', task, { field: type, provider, reason: 'already_applied' });
  } else {
    try {
      if (validation.channel) {
        // The schema object is rebuilt here, from the validated desired value, at
        // the one point of writing — never forwarded from any other source.
        await SCHEMA_CHANNELS[validation.channel].write(connection, validation.postId, desiredValue);
        writeResult = { httpStatus: 200, wordpressPostId: validation.postId };
      } else if (validation.scope === 'site') {
        // No postId — this write affects the whole site, never one post.
        await oditoSeoBridgeService.updateSiteSchemaField(connection, config.siteEntity, config.siteField, desiredValue, config.op || null);
        writeResult = { httpStatus: 200, wordpressPostId: null };
      } else if (validation.useBridge) {
        // The ONLY point where an internal value (object, for robots) is
        // serialized back to the Bridge's plain-string wire format.
        const wireValue = config.toWireValue ? config.toWireValue(desiredValue) : desiredValue;
        await oditoSeoBridgeService.writeSeoField(connection, validation.postId, type, wireValue);
        writeResult = { httpStatus: 200, wordpressPostId: validation.postId };
      } else {
        writeResult = await validation.adapter[config.writeMethod](task.pageUrl, desiredValue);
      }
      logFixEvent('wordpress_fix_applied', task, { field: type, provider, wordpressPostId: writeResult.wordpressPostId });
    } catch (error) {
      logFixEvent('wordpress_fix_failed', task, { field: type, provider, code: error?.code || 'UNKNOWN_ERROR' });
      throw error instanceof WordPressConnectionError
        ? error
        : new WordPressConnectionError('WRITE_FAILED', 'Failed to write this change to WordPress.', 502);
    }
  }

  // ── IMMEDIATE VERIFICATION — fast, best-effort, NOT authoritative ───────
  let immediateVerification = 'skipped';
  if (!alreadyApplied) {
    try {
      const { currentValue: postWriteValue } = await readCurrentValue(validation, config, task.pageUrl);
      immediateVerification = valuesEqual(type, postWriteValue, desiredValue) ? 'success' : 'failed';
    } catch {
      immediateVerification = 'unknown';
    }
  } else {
    immediateVerification = 'success';
  }
  logFixEvent('wordpress_fix_verified', task, { field: type, provider, result: immediateVerification });

  const externalWrite = {
    system: 'wordpress',
    provider,
    field: type,
    wordpressPostId: writeResult.wordpressPostId,
    httpStatus: writeResult.httpStatus,
    writtenAt: new Date(),
  };

  // ── TASK LIFECYCLE — reuse TaskHistoryService, never hand-rolled ────────
  await taskHistoryService.applyImplementedTransition(task, {
    origin: 'wordpress_auto',
    recommendationId: task.recommendationId,
    externalWrite,
  });

  await saveTaskRecordingWrite(task, type, provider);

  return {
    task,
    field: type,
    provider,
    alreadyApplied,
    // Mapping to the audit's requested state vocabulary (kept as two
    // fields rather than one combined enum — an HTTP 200 body distinguishing
    // its own sub-states — since every OTHER named state (write_failed,
    // conflict, unsupported, validation_failed) is already represented as a
    // distinct thrown WordPressConnectionError.code, not a success-body
    // field; unifying both under one enum would mean collapsing two
    // different HTTP outcomes into one shape for no functional gain):
    //   alreadyApplied:true                        -> already_applied
    //   alreadyApplied:false, immediateVerification:'success' -> applied_and_verified
    //   immediateVerification:'unknown'             -> applied_but_verification_unknown
    //   immediateVerification:'failed'              -> applied but live re-read didn't match (treat like unknown — never verified_fixed)
    immediateVerification,
    desiredValue,
  };
}

export { assertTransitionAllowed, assertRecommendationLinked, logFixEvent, saveTaskRecordingWrite };
export default { validateFix, readCurrentValue, resolveDesiredValue, applyFix, readH1Context };
