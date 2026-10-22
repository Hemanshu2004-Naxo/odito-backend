import { MARKETING_OBJECTIVES, KPIS_BY_OBJECTIVE, PLATFORMS, CONTENT_MIX_TYPES } from '../aiStrategy/strategyOutputSchema.js';
import { CALENDAR_FORMATS, ASSET_TYPES } from '../../model/SocialContentCalendarItem.js';
import { PLATFORM_TEXT_LIMITS, MAX_HASHTAGS } from '../aiContent/contentConfig.js';
import { PURCHASE_CTA_RE, ALL_KPIS } from './calendarOutputSchema.js';
import { parseDate, formatDate } from './calendarPlanner.js';
import { WEEKDAYS } from '../aiStrategy/strategyOutputSchema.js';

/**
 * Rules for editing / creating ONE content-calendar item. Pure (no database, no network): the service loads the
 * context (the item's pinned strategy, the business's live catalog, what is connected, the calendar's date range) and
 * this module decides what is allowed. The client sends only the fields below; every id is checked against the context,
 * every derived value (day of week, service / product names, hook link) is computed here, and a field the user cannot
 * own (status, publications, strategy pin, project) is rejected by name.
 *
 * The same honesty / alignment rules as AI planning apply to a person's edit where they protect the product:
 *   - platforms must be connected (when added) and covered by the strategy; the format must exist on every selected platform;
 *   - the KPI must measure the objective, and a purchase call to action only suits a conversion objective;
 *   - the pillar must be one of the strategy's pillars; service / product only from the active catalog, of the kind the business model uses;
 *   - copy must fit every selected platform (length, hashtag count). A person's own wording is theirs: the AI-only rules
 *     (no "trending" claims, no unsupported figures) are not applied to what they type.
 */

export const FORMAT_SUPPORT = Object.freeze({
  facebook: Object.freeze([...CALENDAR_FORMATS]),
  instagram: Object.freeze(CALENDAR_FORMATS.filter((f) => f !== 'text_post')), // an Instagram post needs an image or video
});

/** What a person may set. `date` is the planned (not publishing) date. */
export const EDITABLE_FIELDS = Object.freeze([
  'date', 'platforms', 'format', 'contentPillar', 'objective', 'primaryKpi', 'targetAudience', 'serviceId', 'productId', 'occasion',
  'topic', 'angle', 'hook', 'onCreativeText', 'creativeDirection', 'contentBrief', 'captionDirection', 'caption', 'hashtags', 'primaryCta',
  'engagementPrompt', 'requiredAssets', 'selectedMediaIds', 'platformContent', 'requiresReview', 'approvalNotes', 'footerDisclaimer',
]);

/** Fields the AI can write (and so the ones a regeneration could overwrite). */
export const REGEN_FIELDS = Object.freeze(['topic', 'angle', 'hook', 'caption', 'hashtags', 'captionDirection', 'primaryCta', 'creativeDirection', 'contentBrief', 'engagementPrompt', 'onCreativeText']);
/** A change to one of these is remembered as "edited by a person". */
export const TRACKED_FIELDS = Object.freeze([...REGEN_FIELDS, 'platformContent']);

export const USER_LIMITS = Object.freeze({
  targetAudience: 160, occasion: 120, topic: 150, angle: 200, hook: 200, onCreativeText: 120, creativeDirection: 360, contentBrief: 380,
  captionDirection: 260, primaryCta: 80, engagementPrompt: 160, approvalNotes: 260, footerDisclaimer: 200, caption: 3000, hashtag: 50, hashtagsMax: 30, mediaMax: 6,
});
const TEXT_FIELDS = ['targetAudience', 'occasion', 'topic', 'angle', 'hook', 'onCreativeText', 'creativeDirection', 'contentBrief', 'captionDirection', 'primaryCta', 'engagementPrompt', 'approvalNotes', 'footerDisclaimer'];
const MULTILINE_FIELDS = new Set(['caption']);

// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;
const HASHTAG_RE = /^[\p{L}\p{N}_]+$/u;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Normalises user text: strings only, trimmed, no control characters; single-line fields have their whitespace collapsed. */
function cleanText(value, field, max, errors) {
  if (typeof value !== 'string') { errors.push({ field, code: 'INVALID_FIELD', message: 'must be text' }); return ''; }
  const multiline = MULTILINE_FIELDS.has(field.split('.').pop());
  const t = (multiline ? value.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n') : value.replace(/\s+/g, ' ')).trim();
  if (BAD_CHARS.test(t)) { errors.push({ field, code: 'INVALID_FIELD', message: 'contains control characters' }); return ''; }
  if (t.length > max) { errors.push({ field, code: 'INVALID_FIELD', message: `must be ${max} characters or fewer` }); return t.slice(0, max); }
  return t;
}

/** "#tag" list from a list of strings; leading # optional; letters / numbers / underscore only; deduplicated. */
export function normalizeHashtags(list, field, errors) {
  if (!Array.isArray(list)) { errors.push({ field, code: 'INVALID_FIELD', message: 'must be a list' }); return []; }
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (typeof raw !== 'string') { errors.push({ field, code: 'INVALID_FIELD', message: 'every hashtag must be text' }); continue; }
    const tag = raw.trim().replace(/^#+/, '');
    if (!tag) continue;
    if (tag.length > USER_LIMITS.hashtag || !HASHTAG_RE.test(tag)) { errors.push({ field, code: 'INVALID_FIELD', message: `"${raw.trim().slice(0, 30)}" is not a valid hashtag (letters, numbers and underscores only)` }); continue; }
    if (seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(`#${tag}`);
  }
  if (out.length > USER_LIMITS.hashtagsMax) errors.push({ field, code: 'INVALID_FIELD', message: `can have at most ${USER_LIMITS.hashtagsMax} hashtags` });
  return out;
}

const today1 = (today) => formatDate(parseDate(today) - 24 * 60 * 60 * 1000);

/** The fields of a stored item in API naming, used as the base an edit is merged onto. */
function baseOf(item) {
  return {
    date: item.contentDate, platforms: [...(item.platforms || [])], format: item.format, contentPillar: item.contentPillar, objective: item.objective, primaryKpi: item.primaryKpi,
    targetAudience: item.targetAudience || '', serviceId: item.serviceId ? String(item.serviceId) : null, productId: item.productId ? String(item.productId) : null,
    occasion: item.occasion || '', topic: item.topic, angle: item.angle || '', hook: item.hook || '', onCreativeText: item.onCreativeText || '',
    creativeDirection: item.creativeDirection || '', contentBrief: item.contentBrief || '', captionDirection: item.captionDirection || '', caption: item.caption || '',
    hashtags: [...(item.hashtags || [])], primaryCta: item.primaryCta || '', engagementPrompt: item.engagementPrompt || '', requiredAssets: [...(item.requiredAssets || [])],
    selectedMediaIds: (item.selectedMediaIds || []).map(String), platformContent: (item.platformContent || []).map((p) => ({ platform: p.platform, caption: p.caption || '', primaryCta: p.primaryCta || '', hashtags: [...(p.hashtags || [])] })),
    requiresReview: !!item.requiresReview, approvalNotes: item.approvalNotes || '', footerDisclaimer: item.footerDisclaimer || '',
  };
}

const REQUIRED_ON_CREATE = ['date', 'platforms', 'format', 'contentPillar', 'objective', 'primaryKpi', 'topic'];

/**
 * @param {object} input  the client's fields (EDITABLE_FIELDS only)
 * @param {object} args
 * @param {object|null} args.current  the stored item (null when creating)
 * @param {object} args.ctx
 * @param {{ startDate: string, endDate: string }} args.ctx.calendar
 * @param {string} args.ctx.today  YYYY-MM-DD (UTC)
 * @param {object} args.ctx.strategy  the item's PINNED strategy object (contentPillars, workingHooks, platformStrategy, contentMix)
 * @param {{ facebook: boolean, instagram: boolean }} args.ctx.connected
 * @param {{ businessModel: string|null, services: Map<string,string>, products: Map<string,{ name: string, mediaIds: Set<string> }> }} args.ctx.catalog  ACTIVE entries, lower-cased ids
 * @param {Set<string>} [args.ctx.platformsWithPublication]  platforms that already have a linked publication
 * @returns {{ ok: true, changed: string[], set: object, edited: string[] } | { ok: false, errors: { field: string, code: string, message: string }[] }}
 */
export function validateItemInput(input, { current = null, ctx }) {
  const errors = [];
  const err = (field, code, message) => errors.push({ field, code, message });
  if (!isObj(input)) return { ok: false, errors: [{ field: '_', code: 'INVALID_BODY', message: 'The request body must be an object.' }] };
  for (const key of Object.keys(input)) if (!EDITABLE_FIELDS.includes(key)) return { ok: false, errors: [{ field: key, code: 'UNKNOWN_FIELD', message: `"${key}" cannot be set.` }] };
  if (!current) for (const key of REQUIRED_ON_CREATE) if (input[key] === undefined) err(key, 'INVALID_FIELD', 'is required');
  if (errors.length) return { ok: false, errors };

  const base = current ? baseOf(current) : {
    date: '', platforms: [], format: '', contentPillar: '', objective: '', primaryKpi: '', targetAudience: '', serviceId: null, productId: null, occasion: '', topic: '', angle: '', hook: '',
    onCreativeText: '', creativeDirection: '', contentBrief: '', captionDirection: '', caption: '', hashtags: [], primaryCta: '', engagementPrompt: '', requiredAssets: [], selectedMediaIds: [],
    platformContent: [], requiresReview: false, approvalNotes: '', footerDisclaimer: '',
  };
  const next = { ...base };
  const { strategy, catalog, connected } = ctx;
  const has = (k) => input[k] !== undefined;

  // ── text ──
  for (const f of TEXT_FIELDS) if (has(f)) next[f] = cleanText(input[f], f, USER_LIMITS[f], errors);
  if (has('caption')) next.caption = cleanText(input.caption, 'caption', USER_LIMITS.caption, errors);
  if (!next.topic) err('topic', 'INVALID_FIELD', 'is required');
  if (has('requiresReview')) { if (typeof input.requiresReview !== 'boolean') err('requiresReview', 'INVALID_FIELD', 'must be true or false'); else next.requiresReview = input.requiresReview; }

  // ── platforms ──
  if (has('platforms')) {
    const p = input.platforms;
    if (!Array.isArray(p) || !p.length) err('platforms', 'INVALID_FIELD', 'Choose at least one platform.');
    else if (!p.every((x) => typeof x === 'string' && PLATFORMS.includes(x))) err('platforms', 'INVALID_FIELD', `platforms must be from: ${PLATFORMS.join(', ')}.`);
    else if (new Set(p).size !== p.length) err('platforms', 'INVALID_FIELD', 'Each platform can only be chosen once.');
    else {
      next.platforms = PLATFORMS.filter((x) => p.includes(x));
      for (const platform of next.platforms.filter((x) => !base.platforms.includes(x))) {
        const label = platform === 'facebook' ? 'Facebook Page' : 'Instagram account';
        if (!connected[platform]) err('platforms', 'PLATFORM_NOT_CONNECTED', `Connect your ${label} before planning content for it.`);
        else if (!(strategy.platformStrategy || []).some((s) => s.platform === platform)) err('platforms', 'PLATFORM_NOT_IN_STRATEGY', `Your strategy does not cover ${platform === 'facebook' ? 'Facebook' : 'Instagram'}. Regenerate the strategy to include it.`);
      }
      for (const platform of base.platforms.filter((x) => !next.platforms.includes(x))) {
        if (ctx.platformsWithPublication?.has(platform)) err('platforms', 'PLATFORM_HAS_PUBLICATION', `${platform === 'facebook' ? 'Facebook' : 'Instagram'} already has content created from this plan, so it cannot be removed.`);
      }
    }
  }

  // ── format (must exist on EVERY selected platform) ──
  if (has('format')) {
    if (typeof input.format !== 'string' || !CALENDAR_FORMATS.includes(input.format)) err('format', 'INVALID_FIELD', `format must be one of: ${CALENDAR_FORMATS.join(', ')}.`);
    else next.format = input.format;
  }
  if (next.platforms.length && CALENDAR_FORMATS.includes(next.format)) {
    const unsupported = next.platforms.filter((p) => !FORMAT_SUPPORT[p].includes(next.format));
    if (unsupported.length) err('format', 'FORMAT_NOT_SUPPORTED', `${unsupported.map((p) => (p === 'facebook' ? 'Facebook' : 'Instagram')).join(' and ')} cannot publish a text-only post. Choose an image, carousel or video format.`);
  }

  // ── date: a PLANNING date inside the calendar's range (never a schedule) ──
  if (has('date')) {
    if (typeof input.date !== 'string' || parseDate(input.date) === null) err('date', 'INVALID_FIELD', 'date must be a real date like 2026-10-07.');
    else {
      next.date = input.date;
      if (input.date !== base.date) {
        if (input.date < ctx.calendar.startDate || input.date > ctx.calendar.endDate) err('date', 'DATE_OUT_OF_RANGE', `The date must be inside this calendar (${ctx.calendar.startDate} to ${ctx.calendar.endDate}).`);
        else if (input.date < today1(ctx.today)) err('date', 'DATE_IN_PAST', 'The planned date cannot be in the past.');
      }
    }
  }

  // ── pillar, objective, KPI, CTA ──
  if (has('contentPillar')) {
    if (typeof input.contentPillar !== 'string' || !(strategy.contentPillars || []).some((p) => p.name === input.contentPillar)) err('contentPillar', 'INVALID_FIELD', `The content pillar must be one of your strategy's pillars: ${(strategy.contentPillars || []).map((p) => p.name).join(', ')}.`);
    else next.contentPillar = input.contentPillar;
  }
  if (has('objective')) {
    if (typeof input.objective !== 'string' || !MARKETING_OBJECTIVES.includes(input.objective)) err('objective', 'INVALID_FIELD', `objective must be one of: ${MARKETING_OBJECTIVES.join(', ')}.`);
    else next.objective = input.objective;
  }
  if (has('primaryKpi')) {
    if (typeof input.primaryKpi !== 'string' || !ALL_KPIS.includes(input.primaryKpi)) err('primaryKpi', 'INVALID_FIELD', 'That is not a known KPI.');
    else next.primaryKpi = input.primaryKpi;
  }
  if (MARKETING_OBJECTIVES.includes(next.objective) && ALL_KPIS.includes(next.primaryKpi) && !KPIS_BY_OBJECTIVE[next.objective].includes(next.primaryKpi)) {
    err('primaryKpi', 'KPI_MISMATCH', `"${next.primaryKpi}" does not measure a ${next.objective.replace('_', ' ')} objective. Use ${KPIS_BY_OBJECTIVE[next.objective].join(' / ')}.`);
  }
  const ctaOf = (value) => value || '';
  if (PURCHASE_CTA_RE.test(ctaOf(next.primaryCta)) && next.objective !== 'conversion' && (has('primaryCta') || has('objective'))) err('primaryCta', 'CTA_MISMATCH', `"${next.primaryCta}" asks for a purchase, which only suits a conversion objective.`);

  // ── service / product (the business's own ACTIVE catalog, of the kind its business model uses) ──
  if (has('serviceId')) {
    const id = input.serviceId;
    if (id === null) next.serviceId = null;
    else if (typeof id !== 'string' || !OBJECT_ID_RE.test(id) || !catalog.services.has(id.toLowerCase())) err('serviceId', 'INVALID_FIELD', 'That is not one of your active services.');
    else if (catalog.businessModel === 'product') err('serviceId', 'INVALID_FIELD', 'This is a product business: choose a product, not a service.');
    else next.serviceId = id.toLowerCase();
  }
  if (has('productId')) {
    const id = input.productId;
    if (id === null) next.productId = null;
    else if (typeof id !== 'string' || !OBJECT_ID_RE.test(id) || !catalog.products.has(id.toLowerCase())) err('productId', 'INVALID_FIELD', 'That is not one of your active products.');
    else if (catalog.businessModel === 'service') err('productId', 'INVALID_FIELD', 'This is a service business: choose a service, not a product.');
    else next.productId = id.toLowerCase();
  }

  // ── product images: references to the chosen product's own media ──
  if (has('selectedMediaIds')) {
    const ids = input.selectedMediaIds;
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string' && OBJECT_ID_RE.test(x))) err('selectedMediaIds', 'INVALID_FIELD', 'must be a list of image ids');
    else if (new Set(ids.map((x) => x.toLowerCase())).size !== ids.length) err('selectedMediaIds', 'INVALID_FIELD', 'Each image can only be chosen once.');
    else if (ids.length > USER_LIMITS.mediaMax) err('selectedMediaIds', 'INVALID_FIELD', `Choose at most ${USER_LIMITS.mediaMax} images.`);
    else next.selectedMediaIds = ids.map((x) => x.toLowerCase());
  } else if (next.productId !== base.productId) next.selectedMediaIds = []; // images belong to the product they came from
  if ((has('selectedMediaIds') || next.productId !== base.productId) && next.selectedMediaIds.length) {
    const product = next.productId ? catalog.products.get(next.productId) : null;
    if (!product) err('selectedMediaIds', 'INVALID_FIELD', 'Choose a product before choosing product images.');
    else if (next.selectedMediaIds.some((id) => !product.mediaIds.has(id))) err('selectedMediaIds', 'INVALID_FIELD', 'One of those images does not belong to the selected product.');
  }

  // ── assets ──
  if (has('requiredAssets')) {
    const a = input.requiredAssets;
    if (!Array.isArray(a) || !a.every((x) => typeof x === 'string' && ASSET_TYPES.includes(x))) err('requiredAssets', 'INVALID_FIELD', `requiredAssets must be from: ${ASSET_TYPES.join(', ')}.`);
    else next.requiredAssets = [...new Set(a)];
  }

  // ── hook: a strategy hook keeps its link; anything else is the user's own ──
  const hooks = strategy.workingHooks || [];
  let hookRef = current?.hookRef ?? null;
  if (has('hook')) hookRef = hooks.findIndex((h) => h.hook === next.hook);
  if (hookRef === -1) hookRef = null;

  // ── hashtags and per-platform copy ──
  if (has('hashtags')) next.hashtags = normalizeHashtags(input.hashtags, 'hashtags', errors);
  if (has('platformContent')) {
    const list = input.platformContent;
    if (!Array.isArray(list)) err('platformContent', 'INVALID_FIELD', 'must be a list');
    else {
      const seen = new Set();
      next.platformContent = [];
      list.forEach((entry, i) => {
        const path = `platformContent[${i}]`;
        if (!isObj(entry)) { err(path, 'INVALID_FIELD', 'must be an object'); return; }
        const extra = Object.keys(entry).find((k) => !['platform', 'caption', 'primaryCta', 'hashtags'].includes(k));
        if (extra) { err(path, 'UNKNOWN_FIELD', `"${extra}" cannot be set.`); return; }
        if (typeof entry.platform !== 'string' || !PLATFORMS.includes(entry.platform)) { err(`${path}.platform`, 'INVALID_FIELD', 'must be facebook or instagram'); return; }
        if (seen.has(entry.platform)) { err(`${path}.platform`, 'INVALID_FIELD', 'is listed twice'); return; }
        seen.add(entry.platform);
        next.platformContent.push({
          platform: entry.platform,
          caption: entry.caption === undefined ? '' : cleanText(entry.caption, `platformContent.${entry.platform}.caption`, USER_LIMITS.caption, errors),
          primaryCta: entry.primaryCta === undefined ? '' : cleanText(entry.primaryCta, `platformContent.${entry.platform}.primaryCta`, USER_LIMITS.primaryCta, errors),
          hashtags: entry.hashtags === undefined ? [] : normalizeHashtags(entry.hashtags, `platformContent.${entry.platform}.hashtags`, errors),
        });
      });
    }
  }
  // copy only exists for platforms the item targets; per-platform copy follows the platform list
  const stray = next.platformContent.find((p) => !next.platforms.includes(p.platform));
  if (stray && has('platformContent')) err('platformContent', 'INVALID_FIELD', `${stray.platform} is not one of this post's platforms.`);
  next.platformContent = next.platformContent.filter((p) => next.platforms.includes(p.platform) && (p.caption || p.primaryCta || p.hashtags.length));
  for (const pc of next.platformContent) {
    if (PURCHASE_CTA_RE.test(pc.primaryCta) && next.objective !== 'conversion') err(`platformContent.${pc.platform}.primaryCta`, 'CTA_MISMATCH', `"${pc.primaryCta}" asks for a purchase, which only suits a conversion objective.`);
  }

  // ── the copy must fit every selected platform ──
  for (const platform of next.platforms) {
    const pc = next.platformContent.find((p) => p.platform === platform);
    const caption = pc?.caption || next.caption;
    const tags = pc?.hashtags?.length ? pc.hashtags : next.hashtags;
    const label = platform === 'facebook' ? 'Facebook' : 'Instagram';
    if (tags.length > MAX_HASHTAGS[platform]) err(pc?.hashtags?.length ? `platformContent.${platform}.hashtags` : 'hashtags', 'INVALID_FIELD', `${label} posts can have at most ${MAX_HASHTAGS[platform]} hashtags.`);
    const total = caption.length + (tags.length ? 2 + tags.join(' ').length : 0);
    if (total > PLATFORM_TEXT_LIMITS[platform]) err(pc?.caption ? `platformContent.${platform}.caption` : 'caption', 'INVALID_FIELD', `The ${label} caption with hashtags is ${total} characters; the limit is ${PLATFORM_TEXT_LIMITS[platform]}.`);
  }

  if (errors.length) return { ok: false, errors };

  // ── what actually changed ──
  const changed = Object.keys(next).filter((k) => !same(next[k], base[k]));
  const set = {};
  const nameOf = { serviceId: (id) => (id ? catalog.services.get(id) : null), productId: (id) => (id ? catalog.products.get(id)?.name : null) };
  for (const k of changed) {
    if (k === 'date') { set.contentDate = next.date; set.dayOfWeek = WEEKDAYS[(new Date(parseDate(next.date)).getUTCDay() + 6) % 7]; }
    else if (k === 'serviceId') { set.serviceId = next.serviceId; set.serviceName = nameOf.serviceId(next.serviceId) ?? null; }
    else if (k === 'productId') { set.productId = next.productId; set.productName = nameOf.productId(next.productId) ?? null; }
    else set[k] = next[k];
  }
  if (changed.includes('hook') || (current && hookRef !== (current.hookRef ?? null))) set.hookRef = hookRef;
  // a format change or a new platform can make the deliverable label wrong: it is derived, not typed
  if (changed.includes('format') || changed.includes('platforms')) set.deliverable = current?.deliverable && !changed.includes('format') ? current.deliverable : '';
  // names refresh when only the service / product id is unchanged but its name was renamed? (kept: names are display copies taken at edit time)
  return { ok: true, changed, set, edited: changed.filter((k) => TRACKED_FIELDS.includes(k)), next };
}

/** A manual item's content type (a strategy content-mix type) when the client does not give one: what the post is for. */
const MIX_FOR_OBJECTIVE = Object.freeze({ awareness: 'informational', engagement: 'engagement', traffic: 'informational', lead_generation: 'soft_sell', conversion: 'hard_sell' });
export function defaultContentType(objective, strategy) {
  const allowed = (strategy.contentMix || []).filter((m) => m.percentage > 0).map((m) => m.type);
  const wanted = MIX_FOR_OBJECTIVE[objective];
  if (allowed.includes(wanted)) return wanted;
  return [...(strategy.contentMix || [])].filter((m) => m.percentage > 0).sort((a, b) => b.percentage - a.percentage)[0]?.type || CONTENT_MIX_TYPES[0];
}

const LOCKING_PUBLICATION_STATUSES = ['scheduled', 'publishing', 'published'];

/** True once a linked publication is scheduled / publishing / published: the plan behind it is history and is no longer editable. */
export const isItemLocked = (item, publications = []) => item.status === 'cancelled' || publications.some((p) => LOCKING_PUBLICATION_STATUSES.includes(p.status));

/**
 * The ONE status a person sees. While there is no publication it is the item's own planning status (planned / edited /
 * plan_approved). Once content has been generated it comes from the real SocialPublication(s) - the source of truth for
 * review, scheduling and publishing - so there is no second, conflicting status system. With several publications the
 * LEAST advanced one speaks (an item is not "approved" while one platform's design is still in review), except that a
 * failure is always shown and "published" needs every publication to be published.
 */
export function effectiveStatusOf(item, publications = []) {
  if (item.status === 'cancelled') return 'cancelled';
  const pubs = publications.filter((p) => p.status !== 'cancelled');
  if (!pubs.length) return item.status === 'draft' ? 'planned' : item.status;
  if (pubs.some((p) => p.status === 'failed')) return 'failed';
  if (pubs.every((p) => p.status === 'published')) return 'published';
  if (pubs.some((p) => p.status === 'publishing' || p.status === 'scheduled')) return 'scheduled';
  const rank = (p) => (p.status === 'published' ? 5 : ({ content_review: 1, content_approved: 2, design_review: 3, design_approved: 4 }[p.approvalState] || 0));
  const least = Math.min(...pubs.map(rank));
  return ['content_generated', 'content_review', 'content_approved', 'design_review', 'approved'][least] || 'content_generated';
}

/** The derived label shown as "Content ID", e.g. OCT-P07: month of the planned date + the item's position in its calendar. Display only. */
export function contentIdOf(item) {
  const month = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][Number(String(item.contentDate).slice(5, 7)) - 1] || 'PLN';
  return `${month}-P${String((item.order ?? 0) + 1).padStart(2, '0')}`;
}

export default { FORMAT_SUPPORT, EDITABLE_FIELDS, REGEN_FIELDS, TRACKED_FIELDS, USER_LIMITS, validateItemInput, normalizeHashtags, defaultContentType, contentIdOf, effectiveStatusOf, isItemLocked };
