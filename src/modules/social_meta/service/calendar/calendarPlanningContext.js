import mongoose from 'mongoose';
import SocialAIStrategy from '../../model/SocialAIStrategy.js';
import { getActiveFacebookAccount, getActiveInstagramAccount, getExpiredFacebookAccount, getExpiredInstagramAccount } from '../facebookAccountService.js';
import { findProfile } from '../socialBusinessProfileService.js';
import { listActiveProducts } from '../socialProductService.js';
import { snapshotFactsText } from '../aiStrategy/profileSnapshot.js';
import { FAILURE_MESSAGES, failureFor } from '../aiStrategy/socialAIStrategyService.js';
import claudeStrategyProvider from '../aiStrategy/claudeStrategyProvider.js';
import { buildSlots, calendarSeed, allocatePillars, assignPlatforms } from './calendarPlanner.js';
import { REGULATED_RE } from './calendarOutputSchema.js';

/**
 * calendarPlanningContext - what BOTH halves of calendar generation share, kept apart from them so neither imports the other:
 * the AI provider seam, the user-safe failure messages, the planning context built from the stored strategy (and the business's
 * live catalog), the deterministic slot plan, and the server-owned finishing of an item. The read model + start/preview live in
 * socialContentCalendarService.js; the durable run (lease, batches, resume, recovery) lives in calendarGenerationRunner.js.
 * socialContentCalendarService.js re-exports these names, so existing importers are unaffected.
 */

export const toId = (id) => (mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : id);
export const fail = (code, message, extra = {}) => ({ success: false, error: { code, message, ...extra } });

// ── provider seam ────────────────────────────────────────────────────────────

// The service depends on a provider CONTRACT: isAvailable() and generateCalendarPlan({ system, user, schema }).
let _providerOverride = null;
/** Test seam only: substitute the AI provider (same contract). Production never sets it. */
export function setCalendarProviderOverride(provider) { _providerOverride = provider || null; }
export function resetCalendarProviderOverride() { _providerOverride = null; }
export const getProvider = () => _providerOverride || claudeStrategyProvider;
/** The same provider (and the same test seam) for the single-item regeneration in calendarItemService. */
export const getCalendarProvider = () => getProvider();

// ── failures (user-safe; never a provider message, prompt or key) ────────────

/** How many of Odito's own validation messages a repair attempt is shown. */
export const MAX_REPAIR_FEEDBACK = 15;

export const CALENDAR_FAILURE_MESSAGES = Object.freeze({
  ...FAILURE_MESSAGES,
  AI_UNAVAILABLE: 'Calendar generation is not available right now. Please try again later.',
  AI_BAD_OUTPUT: 'The AI returned a calendar plan that did not meet Odito\'s checks. Please try again.',
  GENERATION_INTERRUPTED: 'Calendar generation was interrupted. Please try again.',
  GENERATION_FAILED: 'Calendar generation failed. Please try again.',
});

export function calendarFailureFor(error) {
  if (error?.code === 'CALENDAR_INVALID') return { code: 'AI_BAD_OUTPUT', message: CALENDAR_FAILURE_MESSAGES.AI_BAD_OUTPUT };
  const base = failureFor(error);
  return { code: base.code, message: CALENDAR_FAILURE_MESSAGES[base.code] || base.message };
}

export const latestReadyStrategy = (projectId) => SocialAIStrategy.findOne({ project_id: toId(projectId), status: 'ready' }).sort({ version: -1 }).lean();

/**
 * The state of each platform's connection as a person needs to act on it: 'connected', 'expired' (it WAS connected, the token died or access was
 * revoked in Meta: the fix is Reconnect, not Connect) or 'none'. connectedPlatforms (below) is the yes/no view of the same thing.
 */
export async function platformStates(projectId) {
  const [facebook, instagram] = await Promise.all([getActiveFacebookAccount(projectId).catch(() => null), getActiveInstagramAccount(projectId).catch(() => null)]);
  const expiredFacebook = facebook ? null : await getExpiredFacebookAccount(projectId).catch(() => null);
  const pageId = (facebook || expiredFacebook)?.platformAccountId;
  const expiredInstagram = instagram ? null : await getExpiredInstagramAccount(projectId, pageId).catch(() => null);
  return {
    facebook: facebook ? 'connected' : (expiredFacebook ? 'expired' : 'none'),
    // an expired Page token marks every row that shares it (the Instagram account too) expired, so an Instagram account that WAS connected shows up here
    instagram: instagram ? 'connected' : (expiredInstagram ? 'expired' : 'none'),
  };
}

export async function connectedPlatforms(projectId) {
  const [facebook, instagram] = await Promise.all([getActiveFacebookAccount(projectId).catch(() => null), getActiveInstagramAccount(projectId).catch(() => null)]);
  return { facebook: !!facebook, instagram: !!instagram };
}

// ── planning context (everything the planner needs, resolved on the server) ──

/**
 * The strategy, its profile snapshot and the business's catalog as the planner may use them. Services and products
 * come from the snapshot the strategy was built on, limited to ids that are STILL active today, so a calendar can
 * never point at something the business has since removed.
 */
export async function buildPlanningContext(strategyDoc, projectId) {
  const snapshotData = strategyDoc.profileSnapshot.data;
  const strategy = strategyDoc.strategy;
  const [profileDoc, activeProducts] = await Promise.all([findProfile(projectId), listActiveProducts(projectId)]);
  const liveServiceIds = new Set((profileDoc?.services || []).filter((s) => (s.status || 'active') === 'active').map((s) => String(s._id)));
  const liveProductIds = new Set(activeProducts.map((p) => p.id));

  const services = (snapshotData.services || []).filter((s) => liveServiceIds.has(String(s.id)));
  const products = (snapshotData.products || []).filter((p) => liveProductIds.has(String(p.id)));
  const prohibitedPhrases = [...new Set([...(snapshotData.prohibitedPhrases || []), ...(strategy.brandRules?.prohibitedPhrases || []), ...(profileDoc?.prohibitedPhrases || [])].map((p) => String(p).trim()).filter(Boolean))];

  return {
    snapshotData,
    strategy,
    catalogEntries: { services, products },
    catalog: {
      businessModel: snapshotData.businessModel || null,
      services: new Map(services.map((s) => [String(s.id).toLowerCase(), s.name])),
      products: new Map(products.map((p) => [String(p.id).toLowerCase(), p.name])),
    },
    // the primary image of each product (a reference to the product's own media, never a copy), chosen for the post's design step
    productPrimaryImage: new Map(activeProducts.map((p) => [String(p.id).toLowerCase(), (p.images.find((i) => i.isPrimary) || p.images[0])?.mediaId || null])),
    prohibitedPhrases,
    allowedFactsText: `${snapshotFactsText(snapshotData)} \n ${snapshotFactsText(strategy)}`,
  };
}

/** The reproducibility seed of a stored calendar: project, version, date range and the strategy version it was planned from. A new version (regeneration) gets a new seed, so it gets a different valid weekday plan. */
export function seedForCalendar(doc) {
  return calendarSeed({ projectId: String(doc.project_id), version: doc.version, startDate: doc.config.startDate, endDate: doc.config.endDate, strategyVersion: doc.strategy?.version });
}

/**
 * Slots for a calendar's config with the server-decided pillar and (for fixed modes) platforms. Deterministic for a given
 * seed: the weekdays vary from week to week but the same calendar always yields the same dates. The weekday never decides
 * the pillar or platform - those are assigned to the dates afterwards, over the whole period.
 */
export function planSlots(config, strategy, seed = '') {
  const slots = buildSlots({ startDate: config.startDate, endDate: config.endDate, postsPerWeek: config.postsPerWeek, recommendedDays: strategy.postingStrategy?.recommendedDays || [], seed });
  const pillars = allocatePillars(slots, strategy.contentPillars || []);
  const platforms = assignPlatforms(slots, config.platforms, config.distributionMode, strategy.platformStrategy || [], seed);
  return {
    slots: slots.map((s, i) => ({ ...s, pillar: pillars.assignments[i], platforms: platforms ? platforms[i] : null })),
    distribution: pillars.distribution,
  };
}

export const chunk = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

/** Server-owned fields of an item: review flags, the product image asset, and display names. The model's `requiresReview` can only be raised, never lowered. */
export function finalizeItem(item, ctx, category) {
  const out = { ...item };
  out.serviceName = out.serviceId ? ctx.catalog.services.get(out.serviceId) || null : null;
  out.productName = out.productId ? ctx.catalog.products.get(out.productId) || null : null;
  const regulated = REGULATED_RE.test(`${category || ''} ${out.topic} ${out.contentBrief} ${out.angle}`);
  out.requiresReview = out.requiresReview || regulated || !!out.serviceId || !!out.productId || out.contentType === 'hard_sell';
  if (out.requiresReview && !out.approvalNotes) out.approvalNotes = 'Check any claims against what you can substantiate before approving.';
  if (out.productId && !out.requiredAssets.includes('product_image')) out.requiredAssets = ['product_image', ...out.requiredAssets].slice(0, 4);
  // a product post starts with the product's own primary image selected (when it has one); the person can change it
  const primary = out.productId ? ctx.productPrimaryImage?.get(out.productId) : null;
  out.selectedMediaIds = primary ? [String(primary)] : [];
  return out;
}

/**
 * The calendar's own summary (size, pillar mix against the strategy's targets, platform counts) computed from its items. Shared by the
 * generation run (which saves it when the calendar becomes ready) and by item edits (which keep it true afterwards), so the two can
 * never disagree. `pillarTargets` is the stored plan.pillarDistribution (it carries each pillar's target percentage).
 */
export function planSummaryOf(items, pillarTargets = []) {
  const total = items.length || 1;
  const counts = new Map();
  items.forEach((i) => counts.set(i.contentPillar, (counts.get(i.contentPillar) || 0) + 1));
  const platformCounts = {};
  items.forEach((i) => (i.platforms || []).forEach((p) => { platformCounts[p] = (platformCounts[p] || 0) + 1; }));
  const pillarDistribution = (pillarTargets || []).map((d) => ({ pillar: d.pillar, targetPercent: d.targetPercent, plannedCount: counts.get(d.pillar) || 0, plannedPercent: Math.round(((counts.get(d.pillar) || 0) / total) * 1000) / 10 }));
  return { totalItems: items.length, pillarDistribution, platformCounts };
}
