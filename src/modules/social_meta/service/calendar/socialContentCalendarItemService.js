import mongoose from 'mongoose';
import SocialContentCalendar from '../../model/SocialContentCalendar.js';
import SocialContentCalendarItem, { ASSET_TYPES } from '../../model/SocialContentCalendarItem.js';
import SocialAIStrategy from '../../model/SocialAIStrategy.js';
import { findProfile } from '../socialBusinessProfileService.js';
import { listActiveProducts } from '../socialProductService.js';
import { MARKETING_OBJECTIVES, KPIS_BY_OBJECTIVE } from '../aiStrategy/strategyOutputSchema.js';
import { startContentGeneration } from '../aiContent/socialContentGenerationService.js';
import { PLATFORM_TEXT_LIMITS, MAX_HASHTAGS } from '../aiContent/contentConfig.js';
import {
  toApiItem, buildPlanningContext, connectedPlatforms, latestReadyStrategy, getCalendarProvider, calendarFailureFor,
} from './socialContentCalendarService.js';
import { planSummaryOf } from './calendarPlanningContext.js';
import { validateItemInput, defaultContentType, isItemLocked, FORMAT_SUPPORT, REGEN_FIELDS, USER_LIMITS } from './calendarItemRules.js';
import { loadPublicationSummaries, linkPublicationToItem } from './calendarItemLinks.js';
import { createPublication, submitContentForApproval } from '../socialPublishingService.js';
import { getActiveFacebookAccount, getActiveInstagramAccount } from '../facebookAccountService.js';
import { buildCalendarToolSchema, validateCalendarBatch, PURCHASE_CTA_RE } from './calendarOutputSchema.js';
import { buildSystemPrompt, buildUserPrompt } from './calendarPromptBuilder.js';
import { CALENDAR_MAX_REPAIR_ATTEMPTS, CALENDAR_MAX_ITEMS } from './calendarConfig.js';
import { formatDate } from './calendarPlanner.js';
import User from '../../../user/model/User.js';
import { LoggerUtil } from '../../../../utils/LoggerUtil.js';

/**
 * socialContentCalendarItemService - the workspace for ONE planned post: read, edit, approve the PLAN, regenerate the
 * plan with AI, and hand it to the existing content generator.
 *
 * What this service is, and is not:
 *   - It edits PLANNING data (what the post is about, its platforms / format / date, the planned copy). A planning date is
 *     not a schedule; nothing here schedules, publishes, approves content or design, or talks to Meta.
 *   - "Approve" means PLAN approval. It sets the item's own planning status; it never touches a SocialPublication, so it
 *     can never make anything publishable. Content and design approval stay in the existing approval workflow.
 *   - "Generate content" calls the EXISTING single-post generator (service/aiContent) with the item as the plan, which
 *     creates a real SocialPublication draft and submits it to the existing content approval workflow; the draft is linked
 *     back to the item. There is no second publication system.
 *
 * Safety:
 *   - Every query is scoped by the authenticated project; an item id / product id / service id from the client is only ever
 *     used inside such a query or checked against the project's own catalog.
 *   - Only an explicit whitelist of fields can be written (calendarItemRules); status, publications, strategy pin and
 *     project are never client-writable.
 *   - Every write names the revision it was based on (optimistic concurrency); a stale one is refused with the current item.
 *   - Items of a replaced calendar version are read-only history; items whose publications are scheduled / published are locked.
 *   - A person's edits are remembered (editedFields) and an AI regeneration will not overwrite them without confirmation.
 */

const toId = (id) => (mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : null);
const fail = (code, message, extra = {}) => ({ success: false, error: { code, message, ...extra } });
const MAX_ITEMS_PER_CALENDAR = CALENDAR_MAX_ITEMS;
const REGEN_LABELS = { topic: 'topic', angle: 'angle', hook: 'hook', caption: 'caption', hashtags: 'hashtags', captionDirection: 'caption direction', primaryCta: 'call to action', creativeDirection: 'creative direction', contentBrief: 'content brief', engagementPrompt: 'engagement prompt', onCreativeText: 'text on the creative' };

// ── context ──────────────────────────────────────────────────────────────────

/** The current (latest ready) calendar of a project - the only one whose items can be edited. */
const currentCalendar = (projectId) => SocialContentCalendar.findOne({ project_id: toId(projectId), status: 'ready' }).sort({ version: -1 }).lean();

/** The business's ACTIVE catalog as editing may reference it (live, not the snapshot: a person can pick what exists today). */
async function liveCatalog(projectId) {
  const [profile, products] = await Promise.all([findProfile(projectId), listActiveProducts(projectId)]);
  const services = (profile?.services || []).filter((s) => (s.status || 'active') === 'active');
  return {
    businessModel: profile?.businessModel || null,
    services: new Map(services.map((s) => [String(s._id).toLowerCase(), s.name])),
    products: new Map(products.map((p) => [String(p.id).toLowerCase(), { name: p.name, mediaIds: new Set((p.images || []).map((i) => String(i.mediaId).toLowerCase())) }])),
    servicesList: services.map((s) => ({ id: String(s._id), name: s.name })),
    productsList: products.map((p) => ({ id: p.id, name: p.name, images: (p.images || []).map((i) => ({ mediaId: i.mediaId, url: i.url, altText: i.altText || '', isPrimary: !!i.isPrimary })) })),
  };
}

/**
 * Loads what an edit needs. With an `itemId`, the item must exist IN THIS PROJECT and belong to the current calendar.
 * @returns {{ ok: true, calendar, item, pubs, strategyDoc, strategy, connected, catalog } | { ok: false, error }}
 */
async function loadContext(projectId, itemId = null, { catalog = true } = {}) {
  const pid = toId(projectId);
  const calendar = await currentCalendar(projectId);
  let item = null;
  if (itemId !== null) {
    const iid = toId(itemId);
    if (!iid) return { ok: false, error: fail('NOT_FOUND', 'That calendar item was not found.').error };
    item = await SocialContentCalendarItem.findOne({ _id: iid, project_id: pid }).lean();
    if (!item) return { ok: false, error: fail('NOT_FOUND', 'That calendar item was not found.').error };
    if (!calendar || String(item.calendar_id) !== String(calendar._id)) return { ok: false, error: fail('CALENDAR_ARCHIVED', 'This item belongs to an earlier version of the calendar, which is read-only. Open the current calendar to edit.').error };
  }
  if (!calendar) return { ok: false, error: fail('NO_CALENDAR', 'Create a content calendar first.').error };
  const strategyDoc = await SocialAIStrategy.findOne({ _id: calendar.strategy.id, project_id: pid }).lean();
  if (!strategyDoc?.strategy) return { ok: false, error: fail('NO_STRATEGY', 'The strategy this calendar was planned from is no longer available. Regenerate the calendar.').error };
  const [connected, cat] = await Promise.all([connectedPlatforms(projectId), catalog ? liveCatalog(projectId) : null]);
  const pubs = item ? [...(await loadPublicationSummaries(projectId, item.publicationIds)).values()] : [];
  return { ok: true, calendar, item, pubs, strategyDoc, strategy: strategyDoc.strategy, connected, catalog: cat };
}

const validationContext = (c, today) => ({
  calendar: { startDate: c.calendar.config.startDate, endDate: c.calendar.config.endDate },
  today: today || formatDate(Date.now()),
  strategy: c.strategy,
  connected: c.connected,
  catalog: c.catalog,
  platformsWithPublication: new Set(c.pubs.filter((p) => p.status !== 'cancelled').map((p) => p.platform)),
});

const checkEditable = (c) => {
  if (c.item.status === 'cancelled') return fail('ITEM_LOCKED', 'This item was cancelled and can no longer be edited.');
  if (isItemLocked(c.item, c.pubs)) return fail('ITEM_LOCKED', 'Content from this plan is already scheduled or published, so the plan can no longer be edited.');
  return null;
};

const validRevision = (v) => Number.isInteger(v) && v >= 0;
const needRevision = () => fail('INVALID_FIELD', 'expectedRevision is required (the revision of the item you are editing).', { field: 'expectedRevision' });

const conflict = async (projectId, itemId) => {
  const fresh = await SocialContentCalendarItem.findOne({ _id: toId(itemId), project_id: toId(projectId) }).lean();
  if (!fresh) return fail('NOT_FOUND', 'That calendar item was not found.');
  const pubs = [...(await loadPublicationSummaries(projectId, fresh.publicationIds)).values()];
  return fail('ITEM_CONFLICT', 'This item was changed somewhere else (another tab or person). Review the latest version and try again.', { item: toApiItem(fresh, pubs) });
};

/** Keeps the calendar's own summary (size, pillar mix, platform counts) true after items change. Never throws: it is a derived view. */
export async function recomputePlanSummary(projectId, calendarId) {
  try {
    const cal = await SocialContentCalendar.findOne({ _id: calendarId, project_id: toId(projectId) }).lean();
    if (!cal) return;
    const items = await SocialContentCalendarItem.find({ calendar_id: calendarId, project_id: toId(projectId), status: { $ne: 'cancelled' } }).select('contentPillar platforms').lean();
    const summary = planSummaryOf(items, cal.plan?.pillarDistribution);
    await SocialContentCalendar.updateOne({ _id: calendarId, project_id: toId(projectId) }, { $set: { 'plan.totalItems': summary.totalItems, 'plan.pillarDistribution': summary.pillarDistribution, 'plan.platformCounts': summary.platformCounts } });
  } catch (error) {
    LoggerUtil.warn('[SOCIAL_CALENDAR] Could not refresh the plan summary', { message: error.message });
  }
}

const respond = async (projectId, doc, extra = {}) => {
  const pubs = [...(await loadPublicationSummaries(projectId, doc.publicationIds)).values()];
  return { success: true, item: toApiItem(doc, pubs), ...extra };
};

/**
 * What a change did to the PLAN APPROVAL, in the response, so no client has to guess: `approvalStatus` is the state after the change,
 * `approvalRevoked` / `requiresReapproval` say it was withdrawn by this change, `contentLinked` that a post already exists for the plan
 * (an approval is then never withdrawn: the post keeps its own reviewed caption).
 */
const approvalOutcome = (doc, { revoked = false, hasContent = false } = {}) => ({
  approvalStatus: doc.status === 'plan_approved' || hasContent ? 'approved' : 'not_approved',
  approvalRevoked: revoked,
  requiresReapproval: revoked,
  contentLinked: hasContent,
});

/** A stored value and an AI value compared as the editor would see them: blank = missing, platform copy by its four fields. */
const canonicalValue = (v) => {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === 'object' ? { platform: x.platform ?? '', caption: x.caption ?? '', primaryCta: x.primaryCta ?? '', hashtags: [...(x.hashtags || [])] } : canonicalValue(x)));
  return typeof v === 'string' ? v.trim() : v;
};
const sameValue = (a, b) => JSON.stringify(canonicalValue(a)) === JSON.stringify(canonicalValue(b));

// ── reads ────────────────────────────────────────────────────────────────────

/** Everything the editor needs to offer real choices: the strategy's pillars and hooks, the live catalog (with product images), formats per platform, connection state. */
export async function getItemOptions(projectId, { userId = null } = {}) {
  const c = await loadContext(projectId);
  if (!c.ok) return { success: false, error: c.error };
  const { strategy, catalog, connected, calendar } = c;
  return {
    success: true,
    calendar: { id: String(calendar._id), version: calendar.version, startDate: calendar.config.startDate, endDate: calendar.config.endDate },
    // Planning vs. publishing: an item has a DATE; the exact time is chosen when its post is scheduled (behind the approvals). These are what the
    // strategy suggests - free text written by the AI, never parsed into a schedule - and the account's own time zone, for display only.
    scheduling: { timeWindows: [...(strategy.postingStrategy?.recommendedTimeWindows || [])], timezone: userId ? ((await User.findById(toId(userId)).select('timezone').lean())?.timezone || null) : null },
    pillars: (strategy.contentPillars || []).map((p) => ({ name: p.name, purpose: p.purpose || '' })),
    hooks: (strategy.workingHooks || []).map((h, index) => ({ index, hook: h.hook, category: h.category })),
    objectives: MARKETING_OBJECTIVES.map((value) => ({ value, kpis: [...KPIS_BY_OBJECTIVE[value]] })),
    ctas: { preferred: [...(strategy.ctaStrategy?.preferredCTAs || [])], byObjective: (strategy.ctaStrategy?.byObjective || []).map((e) => ({ objective: e.objective, ctas: [...e.ctas] })) },
    formats: { facebook: [...FORMAT_SUPPORT.facebook], instagram: [...FORMAT_SUPPORT.instagram] },
    platforms: ['facebook', 'instagram'].map((p) => ({ platform: p, connected: !!connected[p], inStrategy: (strategy.platformStrategy || []).some((s) => s.platform === p) })),
    businessModel: catalog.businessModel,
    services: catalog.servicesList,
    products: catalog.productsList,
    assetTypes: [...ASSET_TYPES],
    limits: { fields: { ...USER_LIMITS }, caption: { ...PLATFORM_TEXT_LIMITS }, hashtags: { ...MAX_HASHTAGS } },
  };
}

export async function getItem(projectId, itemId) {
  const pid = toId(projectId);
  const iid = toId(itemId);
  if (!iid) return fail('NOT_FOUND', 'That calendar item was not found.');
  const doc = await SocialContentCalendarItem.findOne({ _id: iid, project_id: pid }).lean();
  if (!doc) return fail('NOT_FOUND', 'That calendar item was not found.');
  return respond(projectId, doc);
}

// ── edit ─────────────────────────────────────────────────────────────────────

const failFrom = (errors) => {
  const first = errors[0];
  return fail(first.code, first.message, { field: first.field, fields: Object.fromEntries(errors.map((e) => [e.field, e.message])) });
};

/**
 * Saves a person's edit of one item atomically (one conditional update). `body` carries the fields to change plus
 * `expectedRevision`; nothing else is read from the client.
 */
export async function updateItem(projectId, userId, itemId, body = {}, { today } = {}) {
  const { expectedRevision, ...fields } = body || {};
  if (!validRevision(expectedRevision)) return needRevision();
  const c = await loadContext(projectId, itemId);
  if (!c.ok) return { success: false, error: c.error };
  const blocked = checkEditable(c);
  if (blocked) return blocked;

  const result = validateItemInput(fields, { current: c.item, ctx: validationContext(c, today) });
  if (!result.ok) return failFrom(result.errors);
  if (!result.changed.length) {
    if (c.item.revision !== expectedRevision) return conflict(projectId, itemId);
    return respond(projectId, c.item, { changed: [] });
  }

  const hasContent = c.pubs.length > 0;
  const edited = [...new Set([...(c.item.editedFields || []), ...result.edited])];
  const $set = { ...result.set, updatedBy: toId(userId), editedFields: edited };
  // A person's change reopens the plan: it needs approving again. Once content exists the planning status stays (the publication owns what comes next).
  if (!hasContent) { $set.status = 'edited'; $set.planApprovedAt = null; $set.planApprovedBy = null; }
  const approvalRevoked = !hasContent && c.item.status === 'plan_approved';

  const doc = await SocialContentCalendarItem.findOneAndUpdate(
    { _id: c.item._id, project_id: toId(projectId), calendar_id: c.calendar._id, revision: expectedRevision, status: { $ne: 'cancelled' } },
    { $set, $inc: { revision: 1 } },
    { new: true, runValidators: true },
  ).lean();
  if (!doc) return conflict(projectId, itemId);

  if (result.changed.includes('contentPillar') || result.changed.includes('platforms')) await recomputePlanSummary(projectId, c.calendar._id);
  return respond(projectId, doc, { changed: result.changed, ...approvalOutcome(doc, { revoked: approvalRevoked, hasContent }) });
}

/** A manual item: the same model, planned by a person, attached to the current calendar. */
export async function createItem(projectId, userId, body = {}, { today } = {}) {
  const c = await loadContext(projectId, null);
  if (!c.ok) return { success: false, error: c.error };
  const count = await SocialContentCalendarItem.countDocuments({ calendar_id: c.calendar._id, project_id: toId(projectId) });
  if (count >= MAX_ITEMS_PER_CALENDAR) return fail('LIMIT_REACHED', `A calendar can hold at most ${MAX_ITEMS_PER_CALENDAR} posts.`);

  const { contentType, ...fields } = body || {};
  const result = validateItemInput(fields, { current: null, ctx: validationContext({ ...c, pubs: [] }, today) });
  if (!result.ok) return failFrom(result.errors);
  const next = result.next;
  const mix = (c.strategy.contentMix || []).filter((m) => m.percentage > 0).map((m) => m.type);
  if (contentType !== undefined && (typeof contentType !== 'string' || !mix.includes(contentType))) return fail('INVALID_FIELD', `contentType must be one of your strategy's content-mix types: ${mix.join(', ')}.`, { field: 'contentType' });
  const last = await SocialContentCalendarItem.findOne({ calendar_id: c.calendar._id, project_id: toId(projectId) }).sort({ order: -1 }).select('order').lean();

  const doc = await SocialContentCalendarItem.create({
    project_id: toId(projectId),
    calendar_id: c.calendar._id,
    strategyId: c.calendar.strategy.id,
    strategyVersion: c.calendar.strategy.version,
    profileSnapshotHash: c.calendar.strategy.profileSnapshotHash || null,
    order: (last?.order ?? -1) + 1,
    contentDate: result.set.contentDate,
    dayOfWeek: result.set.dayOfWeek,
    platforms: next.platforms,
    format: next.format,
    contentPillar: next.contentPillar,
    contentType: contentType || defaultContentType(next.objective, c.strategy),
    objective: next.objective,
    primaryKpi: next.primaryKpi,
    targetAudience: next.targetAudience,
    serviceId: result.set.serviceId ?? null,
    serviceName: result.set.serviceName ?? null,
    productId: result.set.productId ?? null,
    productName: result.set.productName ?? null,
    occasion: next.occasion,
    topic: next.topic,
    angle: next.angle,
    hook: next.hook,
    hookRef: result.set.hookRef ?? null,
    onCreativeText: next.onCreativeText,
    creativeDirection: next.creativeDirection,
    contentBrief: next.contentBrief,
    captionDirection: next.captionDirection,
    caption: next.caption,
    hashtags: next.hashtags,
    platformContent: next.platformContent,
    primaryCta: next.primaryCta,
    engagementPrompt: next.engagementPrompt,
    requiredAssets: next.requiredAssets,
    selectedMediaIds: next.selectedMediaIds,
    requiresReview: next.requiresReview,
    approvalNotes: next.approvalNotes,
    footerDisclaimer: next.footerDisclaimer,
    status: 'planned',
    isManual: true,
    updatedBy: toId(userId),
  });
  await recomputePlanSummary(projectId, c.calendar._id);
  return respond(projectId, doc.toObject());
}

// ── plan approval ────────────────────────────────────────────────────────────

/** Approves the PLAN. It sets the item's planning status only; no publication is created, approved, scheduled or changed. */
export async function approveItem(projectId, userId, itemId, { expectedRevision } = {}, { today } = {}) {
  if (!validRevision(expectedRevision)) return needRevision();
  const c = await loadContext(projectId, itemId);
  if (!c.ok) return { success: false, error: c.error };
  const blocked = checkEditable(c);
  if (blocked) return blocked;
  if (c.item.status === 'plan_approved') {
    if (c.item.revision !== expectedRevision) return conflict(projectId, itemId);
    return respond(projectId, c.item, { alreadyApproved: true });
  }
  if (!['planned', 'edited', 'draft'].includes(c.item.status)) return fail('NOT_APPROVABLE', 'Content has already been created from this plan, so the plan cannot be approved again.');

  // an incomplete or inconsistent plan cannot be approved: re-run the rules on what is stored
  const check = validateItemInput({}, { current: c.item, ctx: validationContext(c, today) });
  if (!check.ok) return failFrom(check.errors);

  const doc = await SocialContentCalendarItem.findOneAndUpdate(
    { _id: c.item._id, project_id: toId(projectId), revision: expectedRevision, status: { $in: ['planned', 'edited', 'draft'] }, 'publicationIds.0': { $exists: false } },
    { $set: { status: 'plan_approved', planApprovedAt: new Date(), planApprovedBy: toId(userId), updatedBy: toId(userId) }, $inc: { revision: 1 } },
    { new: true },
  ).lean();
  if (!doc) return conflict(projectId, itemId);
  return respond(projectId, doc);
}

/** Takes plan approval back (only while no content exists for the item). */
export async function revokeItemApproval(projectId, userId, itemId, { expectedRevision } = {}) {
  if (!validRevision(expectedRevision)) return needRevision();
  const c = await loadContext(projectId, itemId, { catalog: false });
  if (!c.ok) return { success: false, error: c.error };
  const blocked = checkEditable(c);
  if (blocked) return blocked;
  if (c.item.status !== 'plan_approved') return fail('NOT_APPROVED', 'This plan is not approved.');
  if (c.pubs.length) return fail('NOT_APPROVABLE', 'Content has already been created from this plan, so its approval cannot be withdrawn.');
  const back = (c.item.editedFields || []).length ? 'edited' : 'planned';
  const doc = await SocialContentCalendarItem.findOneAndUpdate(
    { _id: c.item._id, project_id: toId(projectId), revision: expectedRevision, status: 'plan_approved', 'publicationIds.0': { $exists: false } },
    { $set: { status: back, planApprovedAt: null, planApprovedBy: null, updatedBy: toId(userId) }, $inc: { revision: 1 } },
    { new: true },
  ).lean();
  if (!doc) return conflict(projectId, itemId);
  return respond(projectId, doc);
}

/** The per-platform copy after an AI rewrite of the caption and / or the hashtags: rewritten parts come from the AI, the rest stays as it was. */
function mergePlatformCopy(item, result, { caption, hashtags }) {
  const old = new Map((item.platformContent || []).map((p) => [p.platform, p]));
  const ai = new Map((result.platformContent || []).map((p) => [p.platform, p]));
  return item.platforms.map((platform) => {
    const was = old.get(platform) || {};
    const now = ai.get(platform);
    return {
      platform,
      caption: caption ? (now?.caption || '') : (was.caption || ''),
      primaryCta: caption && now ? now.primaryCta : (was.primaryCta || ''),
      hashtags: hashtags ? (now?.hashtags || []) : (was.hashtags || []),
    };
  }).filter((p) => p.caption || p.primaryCta || p.hashtags.length);
}

// ── AI regeneration of the plan of ONE item ──────────────────────────────────

/**
 * Re-plans some fields of one item with AI. The server picks the context (pinned strategy, live catalog, the other
 * items' topics) and validates the answer with the same rules as a whole calendar. Fields a person has edited are not
 * overwritten unless `overwriteEdited` is true; the client asks the user first. Only planning fields are written - never a
 * caption, a design or a publication.
 */
export async function regenerateItem(projectId, userId, itemId, body = {}) {
  const { expectedRevision, fields: requested, overwriteEdited = false } = body || {};
  if (!validRevision(expectedRevision)) return needRevision();
  if (typeof overwriteEdited !== 'boolean') return fail('INVALID_FIELD', 'overwriteEdited must be true or false.', { field: 'overwriteEdited' });
  const fields = requested === undefined ? [...REGEN_FIELDS] : requested;
  if (!Array.isArray(fields) || !fields.length || !fields.every((f) => REGEN_FIELDS.includes(f)) || new Set(fields).size !== fields.length) {
    return fail('INVALID_FIELD', `fields must be a list taken from: ${REGEN_FIELDS.join(', ')}.`, { field: 'fields' });
  }
  const c = await loadContext(projectId, itemId);
  if (!c.ok) return { success: false, error: c.error };
  const blocked = checkEditable(c);
  if (blocked) return blocked;
  if (c.item.revision !== expectedRevision) return conflict(projectId, itemId);

  // per-platform copy (captions, CTAs, hashtags) is part of the caption / hashtags: editing it protects them too
  const edited = c.item.editedFields || [];
  const hit = fields.filter((f) => edited.includes(f) || (edited.includes('platformContent') && (f === 'caption' || f === 'hashtags')));
  if (hit.length && !overwriteEdited) {
    return fail('EDITED_FIELDS', `You have edited the ${hit.map((f) => REGEN_LABELS[f]).join(', ')}. Regenerating would replace your changes.`, { editedFields: hit });
  }

  const provider = getCalendarProvider();
  if (!provider.isAvailable()) return fail('AI_UNAVAILABLE', 'Plan regeneration is not available right now. Please try again later.');

  const { item, calendar, strategyDoc } = c;
  let result;
  try {
    const ctx = await buildPlanningContext(strategyDoc, projectId);
    const slot = { index: 0, date: item.contentDate, dayOfWeek: item.dayOfWeek, pillar: item.contentPillar, platforms: [...item.platforms] };
    const others = await SocialContentCalendarItem.find({ calendar_id: calendar._id, project_id: toId(projectId), _id: { $ne: item._id } }).select('topic serviceId productId').lean();
    const planned = { topics: others.map((o) => o.topic.toLowerCase()), services: {}, products: {} };
    others.forEach((o) => {
      if (o.serviceId) planned.services[String(o.serviceId)] = (planned.services[String(o.serviceId)] || 0) + 1;
      if (o.productId) planned.products[String(o.productId)] = (planned.products[String(o.productId)] || 0) + 1;
    });
    const config = { ...calendar.config, platforms: [...item.platforms], distributionMode: 'balanced' };
    const system = buildSystemPrompt();
    const schema = buildCalendarToolSchema({ platforms: item.platforms, hasServices: ctx.catalog.services.size > 0, hasProducts: ctx.catalog.products.size > 0 });
    const current = Object.fromEntries(REGEN_FIELDS.map((f) => [f, item[f]]).filter(([, v]) => v));
    const fixed = { format: item.format, objective: item.objective, content_type: item.contentType, service: item.serviceName, product: item.productName, service_id: item.serviceId ? String(item.serviceId) : null, product_id: item.productId ? String(item.productId) : null };

    let validated = null;
    let feedback = [];
    for (let i = 0; i <= CALENDAR_MAX_REPAIR_ATTEMPTS && !validated; i += 1) {
      const user = buildUserPrompt({
        snapshotData: ctx.snapshotData, strategy: ctx.strategy, config, slots: [slot], progress: { batch: 1, batches: 1 }, planned,
        catalog: { services: ctx.catalogEntries.services, products: ctx.catalogEntries.products }, prohibitedPhrases: ctx.prohibitedPhrases, repairFeedback: feedback,
        regenerate: { fields, current, fixed },
      });
      // eslint-disable-next-line no-await-in-loop
      const out = await provider.generateCalendarPlan({ system, user, schema });
      const check = validateCalendarBatch(out.parsed, {
        slots: [slot], selectedPlatforms: item.platforms, strategy: ctx.strategy, catalog: ctx.catalog,
        prohibitedPhrases: ctx.prohibitedPhrases, allowedFactsText: ctx.allowedFactsText, usedTopics: new Set(planned.topics),
      });
      if (check.ok) validated = check; else feedback = check.errors.slice(0, 8);
    }
    if (!validated) throw Object.assign(new Error('CALENDAR_INVALID'), { code: 'CALENDAR_INVALID' });
    result = validated.items[0];
  } catch (error) {
    const failure = calendarFailureFor(error);
    LoggerUtil.error('[SOCIAL_CALENDAR] Item regeneration failed', { providerCode: error?.code || null }, { projectId: String(projectId), itemId: String(itemId), failureCode: failure.code });
    return fail(failure.code, failure.message);
  }

  const warnings = [];
  const $set = { updatedBy: toId(userId) };
  for (const f of fields) {
    if (f === 'caption' || f === 'hashtags') { $set[f] = result[f]; continue; }
    if (f === 'primaryCta' && PURCHASE_CTA_RE.test(result.primaryCta) && item.objective !== 'conversion') { warnings.push('The suggested call to action asks for a purchase, which does not suit this post, so it was kept as it was.'); continue; }
    $set[f] = result[f];
  }
  if (fields.includes('hook')) $set.hookRef = result.hookRef ?? null;
  // the platform versions follow the caption / hashtags that were rewritten (an Instagram caption must not outlive a new shared one)
  const rewroteCopy = fields.includes('caption') || fields.includes('hashtags');
  if (rewroteCopy) $set.platformContent = mergePlatformCopy(item, result, { caption: fields.includes('caption'), hashtags: fields.includes('hashtags') });
  // The AI may land on exactly the words that are already there. When EVERY chosen field is identical, nothing is written: the revision stays,
  // the person's edit markers stay, and an approval stays valid - it is provable from the stored values, not assumed.
  const identical = Object.entries($set).filter(([key]) => key !== 'updatedBy').every(([key, value]) => sameValue(item[key], value));
  if (identical) {
    const current = await SocialContentCalendarItem.findOne({ _id: item._id, project_id: toId(projectId), calendar_id: calendar._id, revision: expectedRevision, status: { $ne: 'cancelled' } }).lean();
    if (!current) return conflict(projectId, itemId); // changed while the AI was working
    return respond(projectId, current, { regenerated: [], unchanged: true, warnings, ...approvalOutcome(current, { hasContent: c.pubs.length > 0 }) });
  }

  const editedFields = (item.editedFields || []).filter((f) => !fields.includes(f) && !(rewroteCopy && f === 'platformContent'));
  $set.editedFields = editedFields;
  const hasContent = c.pubs.length > 0;
  if (!hasContent) { $set.status = editedFields.length ? 'edited' : 'planned'; $set.planApprovedAt = null; $set.planApprovedBy = null; }
  if (hasContent && rewroteCopy) warnings.push('A post was already created from this plan. It keeps its own reviewed caption and hashtags; only the plan changed.');

  const doc = await SocialContentCalendarItem.findOneAndUpdate(
    { _id: item._id, project_id: toId(projectId), calendar_id: calendar._id, revision: expectedRevision, status: { $ne: 'cancelled' } },
    { $set, $inc: { revision: 1 } },
    { new: true, runValidators: true },
  ).lean();
  if (!doc) return conflict(projectId, itemId); // edited while the AI was working: nothing was overwritten
  const revoked = !hasContent && item.status === 'plan_approved';
  return respond(projectId, doc, { regenerated: fields.filter((f) => $set[f] !== undefined), warnings, ...approvalOutcome(doc, { revoked, hasContent }) });
}

// ── content hand-off ─────────────────────────────────────────────────────────

/**
 * The caption a person reviewed in the plan, as it will be posted on ONE platform: that platform's own copy when it has one, else the
 * shared caption (a blank platform field falls back to the shared one - the same rule the editor shows). Hashtags likewise.
 */
export function plannedCopyFor(item, platform) {
  const entry = (item.platformContent || []).find((p) => p.platform === platform);
  const caption = String(entry?.caption || item.caption || '').trim();
  const hashtags = [...((entry?.hashtags?.length ? entry.hashtags : item.hashtags) || [])];
  return { caption, hashtags };
}

/**
 * Turns an APPROVED plan item into a post draft for ONE platform.
 *
 * Two explicit modes, so a person always knows whether a caption will be kept or rewritten:
 *   'plan' (default when the plan has a caption for that platform)
 *        the draft's text IS the caption (and hashtags) the person reviewed, verbatim - no AI call, nothing rewritten, nothing charged.
 *        It is checked against the platform's length / hashtag limits and the business's prohibited phrases and REFUSED (with the
 *        reason) rather than silently shortened. The draft records which plan revision it came from.
 *   'ai'   (default when the plan has no caption for that platform, or when asked for)
 *        the existing single-post generator writes a NEW caption from the plan. The plan's own caption is left untouched; the AI text
 *        becomes a draft in Content Approvals, where it is reviewed before anything is used.
 * Either way the draft enters the existing content approval workflow (which decides review vs. auto-approval) and is linked back to the
 * item. Nothing is designed, scheduled or published here, and the item must be plan-approved with the strategy it was planned from still current.
 */
export async function generateItemContent(projectId, userId, itemId, body = {}) {
  const platform = body?.platform;
  if (typeof platform !== 'string' || !['facebook', 'instagram'].includes(platform)) return fail('INVALID_FIELD', 'platform must be facebook or instagram.', { field: 'platform' });
  if (body?.mode !== undefined && !['plan', 'ai'].includes(body.mode)) return fail('INVALID_FIELD', "mode must be 'plan' (use the caption in this plan) or 'ai' (write a new caption with AI).", { field: 'mode' });
  const c = await loadContext(projectId, itemId, { catalog: false });
  if (!c.ok) return { success: false, error: c.error };
  const blocked = checkEditable(c);
  if (blocked) return blocked;
  const { item } = c;
  if (!c.item.platforms.includes(platform)) return fail('INVALID_FIELD', `This post is not planned for ${platform}.`, { field: 'platform' });
  if (!['plan_approved', 'content_generated'].includes(item.status)) return fail('PLAN_NOT_APPROVED', 'Approve the plan before creating content from it.');
  if (c.pubs.some((p) => p.platform === platform && p.status !== 'cancelled')) return fail('ALREADY_GENERATED', `Content for ${platform === 'facebook' ? 'Facebook' : 'Instagram'} has already been created from this plan.`);
  const latest = await latestReadyStrategy(projectId);
  if (!latest || String(latest._id) !== String(item.strategyId)) return fail('STRATEGY_CHANGED', 'Your strategy has changed since this calendar was generated. Regenerate the calendar before creating content from it.');

  const copy = plannedCopyFor(item, platform);
  const mode = body?.mode || (copy.caption ? 'plan' : 'ai');
  if (mode === 'ai') return startContentGeneration(projectId, userId, { platform, contentPillar: item.contentPillar, objective: item.contentType }, { calendarItemId: item._id });

  // ── 'plan': the reviewed caption, verbatim ──
  if (!validRevision(body.expectedRevision)) return needRevision();
  const label = platform === 'facebook' ? 'Facebook' : 'Instagram';
  if (!copy.caption) return fail('NO_PLAN_CAPTION', `This plan has no ${label} caption to use. Write one in the plan, or choose to have AI write the post.`);
  const text = copy.hashtags.length ? `${copy.caption}\n\n${copy.hashtags.join(' ')}` : copy.caption;
  if (text.length > PLATFORM_TEXT_LIMITS[platform]) return fail('CAPTION_TOO_LONG', `The ${label} caption (with its hashtags) is ${text.length} characters; ${label} posts here can be at most ${PLATFORM_TEXT_LIMITS[platform]}. Shorten it in the plan first - Odito will not cut your words.`);
  if (copy.hashtags.length > MAX_HASHTAGS[platform]) return fail('TOO_MANY_HASHTAGS', `${label} posts here can have at most ${MAX_HASHTAGS[platform]} hashtags; this plan has ${copy.hashtags.length}.`);
  const ctx = await buildPlanningContext(c.strategyDoc, projectId);
  const lowered = text.toLowerCase();
  const banned = ctx.prohibitedPhrases.find((p) => lowered.includes(String(p).toLowerCase()));
  if (banned) return fail('PROHIBITED_PHRASE', `The ${label} caption uses "${banned}", which your business profile says never to use. Edit the caption in the plan first.`);
  const account = platform === 'facebook' ? await getActiveFacebookAccount(projectId) : await getActiveInstagramAccount(projectId);
  if (!account) return fail('PLATFORM_NOT_CONNECTED', `Connect your ${platform === 'facebook' ? 'Facebook Page' : 'Instagram account'} before creating a post for it.`);

  // Claim the item at the revision the person saw (one atomic update): a double click, a second tab or an edit made meanwhile gets a
  // conflict instead of a second draft or a draft of text that has since changed.
  const claimed = await SocialContentCalendarItem.findOneAndUpdate(
    { _id: item._id, project_id: toId(projectId), calendar_id: c.calendar._id, revision: body.expectedRevision, status: { $in: ['plan_approved', 'content_generated'] } },
    { $inc: { revision: 1 }, $set: { updatedBy: toId(userId) } },
    { new: true },
  ).lean();
  if (!claimed) return conflict(projectId, itemId);

  const created = await createPublication(projectId, userId, {
    platform,
    socialAccountId: String(account._id),
    content: text,
    generation: {
      source: 'calendar_plan',
      type: 'calendar_item',
      strategyId: item.strategyId,
      strategyVersion: item.strategyVersion,
      profileSnapshotHash: item.profileSnapshotHash || null,
      contentPillar: item.contentPillar,
      objective: item.contentType,
      calendarItemId: item._id,
      planRevision: body.expectedRevision,
      planApprovedAt: item.planApprovedAt || null,
    },
  });
  if (!created.success) return fail(created.error?.code?.startsWith('ACCOUNT_') ? 'PLATFORM_NOT_CONNECTED' : (created.error?.code || 'DRAFT_CREATE_FAILED'), created.error?.message || 'The post draft could not be created.');

  const submitted = await submitContentForApproval(projectId, created.publication.id, userId);
  if (!submitted.success) LoggerUtil.warn('[SOCIAL_CALENDAR] Draft created from a plan but could not be submitted for review', { itemId: String(itemId), code: submitted.error?.code });
  await linkPublicationToItem({ projectId, itemId: item._id, publicationId: created.publication.id });
  LoggerUtil.info('[SOCIAL_CALENDAR] Post draft created from the plan caption', { projectId: String(projectId), itemId: String(itemId), publicationId: String(created.publication.id), platform, planRevision: body.expectedRevision });

  const fresh = await SocialContentCalendarItem.findOne({ _id: item._id, project_id: toId(projectId) }).lean();
  return { ...(await respond(projectId, fresh)), mode: 'plan', publication: submitted.success ? submitted.publication : created.publication };
}

export default { getItemOptions, getItem, updateItem, createItem, approveItem, revokeItemApproval, regenerateItem, generateItemContent, recomputePlanSummary };
