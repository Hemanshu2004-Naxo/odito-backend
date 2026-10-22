import {
  CONTENT_MIX_TYPES, MARKETING_OBJECTIVES, KPIS_BY_OBJECTIVE, TREND_CLAIM_RE, PLATFORMS,
} from '../aiStrategy/strategyOutputSchema.js';
import { fitText, FIT_TOLERANCE, LIST_OVERFLOW_TOLERANCE, PROHIBITION_RE } from '../aiStrategy/strategyOutputSchema.js';
import { unsupportedFigures } from '../aiContent/contentOutputSchema.js';
import { PLATFORM_TEXT_LIMITS, MAX_HASHTAGS } from '../aiContent/contentConfig.js';
import { CALENDAR_FORMATS, ASSET_TYPES } from '../../model/SocialContentCalendarItem.js';

/**
 * Calendar planning output contract — ONE definition, used twice from the same constants:
 *   1. buildCalendarToolSchema()   -> the JSON schema handed to the model as a forced tool;
 *   2. validateCalendarBatch()     -> the strict server-side validator. The model's output is never saved because it
 *      was JSON: every item is rebuilt field by field from known keys, every type / length / enum is checked, and the
 *      business rules below are enforced before anything can be persisted.
 *
 * The model plans ONE BATCH of slots per call. It returns each post fully written: planning fields plus the caption, hashtags and per-platform copy (no designs). The
 * server already decided each slot's date and pillar (and platforms, for fixed modes), so those are never the model's
 * to change: they are re-attached from the slot, and any platform the model returns is checked against it.
 *
 * Hard rules (a violation rejects the batch, which then gets ONE repair attempt):
 *   structure   exactly one item per requested slot; known enums; bounded text; no control characters
 *   references  service / product ids only from the business's own active catalog; never a service on a product
 *               business or a product on a service business; hookRef only an index of a real strategy hook
 *   alignment   the KPI must measure the objective; a purchase call-to-action only on a conversion objective;
 *               the content type must be in the strategy's content mix; text_post never on Instagram
 *   honesty     no "trending / viral" claims; no figure, price, link or contact detail the business did not supply;
 *               no phrase the business banned
 * Variety problems (the same service / product back to back, over-use) are NOT hard errors: the service clears the
 * repeat and records a warning (see applyVariety), so a fussy model cannot fail a whole calendar.
 */

export const CALENDAR_TOOL_NAME = 'emit_content_calendar_plan';
export const ALL_KPIS = Object.freeze([...new Set(Object.values(KPIS_BY_OBJECTIVE).flat())]);

export const CALENDAR_LIMITS = Object.freeze({
  deliverable: 80, audience: 160, occasion: 100, topic: 120, angle: 200, hook: 150, onCreativeText: 100,
  creativeDirection: 360, brief: 380, captionDirection: 260, cta: 60, engagementPrompt: 140, approvalNotes: 220, disclaimer: 160, assetsMax: 4,
  caption: 1800, hashtag: 50,
});

/** Purchase-style calls to action. Allowed only when the post's objective is conversion. */
export const PURCHASE_CTA_RE = /\b(buy|shop|order|purchase|add to cart|get yours|checkout|book now|buy now)\b/i;
/** Industries / claims where a human should look at the post before it goes anywhere. */
export const REGULATED_RE = /\b(health|medical|medicine|doctor|dentist|dental|clinic|therapy|treatment|cure|diagnos|legal|lawyer|attorney|law firm|financ|invest|loan|mortgage|insurance|guarantee[sd]?|clinically|risk-free)\b/i;

const str = (maxLength, description) => ({ type: 'string', maxLength, ...(description ? { description } : {}) });

export function buildCalendarToolSchema({ platforms = PLATFORMS, hasServices = false, hasProducts = false } = {}) {
  const L = CALENDAR_LIMITS;
  return {
    type: 'object',
    additionalProperties: false,
    required: ['items'],
    properties: {
      items: {
        type: 'array',
        description: 'Exactly one item per requested slot, each echoing its slot number.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['slot', 'platforms', 'format', 'deliverable', 'contentType', 'objective', 'primaryKpi', 'targetAudience', 'occasion', 'topic', 'angle', 'hook', 'hookRef', 'onCreativeText', 'creativeDirection', 'contentBrief', 'captionDirection', 'primaryCta', 'engagementPrompt', 'caption', 'hashtags', 'platformContent', 'requiredAssets', 'serviceId', 'productId', 'requiresReview', 'approvalNotes', 'footerDisclaimer'],
          properties: {
            slot: { type: 'integer', minimum: 0 },
            platforms: { type: 'array', minItems: 1, maxItems: platforms.length, items: { type: 'string', enum: [...platforms] } },
            format: { type: 'string', enum: [...CALENDAR_FORMATS] },
            deliverable: str(L.deliverable, 'What is produced, e.g. "Educational carousel".'),
            contentType: { type: 'string', enum: [...CONTENT_MIX_TYPES], description: 'The post type from the strategy content mix.' },
            objective: { type: 'string', enum: [...MARKETING_OBJECTIVES] },
            primaryKpi: { type: 'string', enum: [...ALL_KPIS], description: 'The one metric that measures this objective.' },
            targetAudience: str(L.audience, 'Empty string when no audience was supplied.'),
            occasion: str(L.occasion, 'A real occasion or season if one applies, otherwise an empty string. Never a claim that something is trending.'),
            topic: str(L.topic),
            angle: str(L.angle),
            hook: str(L.hook, 'The opening line. Use one of the strategy hooks (set hookRef) or write one for this post.'),
            hookRef: { type: ['integer', 'null'], minimum: 0, description: 'Index of the strategy hook used as-is, or null.' },
            onCreativeText: str(L.onCreativeText, 'Short text for the image itself, or an empty string.'),
            creativeDirection: str(L.creativeDirection),
            contentBrief: str(L.brief, 'What the post covers, in two sentences at most. NOT the caption.'),
            captionDirection: str(L.captionDirection, 'Guidance for the later caption writer. NOT the caption.'),
            primaryCta: str(L.cta),
            engagementPrompt: str(L.engagementPrompt),
            caption: str(L.caption, 'The complete, ready-to-post caption: opens with the hook, uses the call to action, contains NO hashtags. This is the shared caption used by every platform that has no copy of its own.'),
            hashtags: { type: 'array', maxItems: Math.max(...Object.values(MAX_HASHTAGS)), items: str(L.hashtag), description: 'Hashtags starting with #. Empty only when the strategy says hashtags are not recommended.' },
            platformContent: {
              type: 'array',
              maxItems: platforms.length,
              description: 'Required when the slot targets BOTH platforms: one entry per platform with its own adapted caption, call to action and hashtags (Instagram shorter and more visual, Facebook may say more). Empty when the slot targets one platform.',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['platform', 'caption', 'primaryCta', 'hashtags'],
                properties: {
                  platform: { type: 'string', enum: [...platforms] },
                  caption: str(L.caption),
                  primaryCta: str(L.cta),
                  hashtags: { type: 'array', maxItems: Math.max(...Object.values(MAX_HASHTAGS)), items: str(L.hashtag) },
                },
              },
            },
            requiredAssets: { type: 'array', maxItems: L.assetsMax, items: { type: 'string', enum: [...ASSET_TYPES] } },
            serviceId: { type: ['string', 'null'], description: hasServices ? 'An id from the supplied services, or null.' : 'Always null: no services were supplied.' },
            productId: { type: ['string', 'null'], description: hasProducts ? 'An id from the supplied products, or null.' : 'Always null: no products were supplied.' },
            requiresReview: { type: 'boolean', description: 'True for medical / legal / financial / product-claim / promotional content.' },
            approvalNotes: str(L.approvalNotes),
            footerDisclaimer: str(L.disclaimer, 'Only when a disclaimer is genuinely needed, otherwise an empty string.'),
          },
        },
      },
    },
  };
}

// ── validation ───────────────────────────────────────────────────────────────

// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;
const HASHTAG_RE = /^#[\p{L}\p{N}_]{1,50}$/u;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * @param {unknown} raw  the model's tool input
 * @param {object} ctx
 * @param {{ index:number, date:string, dayOfWeek:string, pillar:string, platforms:string[]|null }[]} ctx.slots  this batch's slots
 * @param {string[]} ctx.selectedPlatforms
 * @param {{ contentMix: {type:string,percentage:number}[], workingHooks?: {hook:string}[] }} ctx.strategy
 * @param {{ services: Map<string,string>, products: Map<string,string>, businessModel: string|null }} ctx.catalog  id -> name (active only)
 * @param {string[]} [ctx.prohibitedPhrases]
 * @param {string} [ctx.allowedFactsText]
 * @param {Set<string>} [ctx.usedTopics]  lower-cased topics already planned in earlier batches
 * @returns {{ ok: true, items: object[] } | { ok: false, errors: string[] }}
 */
export function validateCalendarBatch(raw, ctx) {
  const errors = [];
  const adjusted = []; // harmless format fixes applied deterministically (path + what), reported with the result
  const fail = (path, message) => { if (errors.length < 20) errors.push(`${path}: ${message}`); };
  if (!isObj(raw) || !Array.isArray(raw.items)) return { ok: false, errors: ['The plan must be an object with an "items" list.'] };

  const { slots, selectedPlatforms, strategy, catalog } = ctx;
  const allowedContentTypes = (strategy.contentMix || []).filter((m) => m.percentage > 0).map((m) => m.type);
  const hooks = strategy.workingHooks || [];
  const bySlot = new Map(slots.map((s) => [s.index, s]));

  if (raw.items.length !== slots.length) fail('items', `needs exactly ${slots.length} item${slots.length === 1 ? '' : 's'} (one per slot), got ${raw.items.length}`);

  const text = (v, path, max, { allowEmpty = true } = {}) => {
    if (typeof v !== 'string') { fail(path, 'must be text'); return ''; }
    const t = v.replace(/\s+/g, ' ').trim();
    if (!t && !allowEmpty) { fail(path, 'must not be empty'); return ''; }
    if (t.length > max) {
      // a near miss on a short planning field is fitted (a repair call costs minutes); far over is still an error
      if (t.length > max * FIT_TOLERANCE) { fail(path, `must be ${max} characters or fewer`); return t.slice(0, max); }
      const fitted = fitText(t, max);
      if (BAD_CHARS.test(fitted)) { fail(path, 'contains control characters'); return ''; }
      return fitted;
    }
    if (BAD_CHARS.test(t)) { fail(path, 'contains control characters'); return ''; }
    return t;
  };
  const oneOf = (v, path, allowed) => { if (!allowed.includes(v)) { fail(path, `must be one of ${allowed.join(', ')}`); return allowed[0]; } return v; };

  // written copy keeps its line breaks (a caption is paragraphs, not one line)
  const copy = (v, path, max) => {
    if (typeof v !== 'string') { fail(path, 'must be text'); return ''; }
    const t = v.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (t.length > max) { fail(path, `must be ${max} characters or fewer`); return t.slice(0, max); }
    if (BAD_CHARS.test(t)) { fail(path, 'contains control characters'); return ''; }
    if (/(^|\s)#[\p{L}\p{N}_]+/u.test(t)) { fail(path, 'must not contain hashtags (put them in "hashtags")'); return t; }
    return t;
  };
  const strategyTags = strategy.hashtagStrategy || {};
  const tagsRecommended = strategyTags.enabled === true;
  const tagList = (v, path, forPlatforms) => {
    if (!Array.isArray(v)) { fail(path, 'must be a list'); return []; }
    const out = [];
    const seen = new Set();
    v.forEach((h, i) => {
      const tag = typeof h === 'string' ? h.trim() : '';
      if (!HASHTAG_RE.test(tag)) { fail(`${path}[${i}]`, 'must start with # and contain only letters, numbers or underscores'); return; }
      if (seen.has(tag.toLowerCase())) { fail(`${path}[${i}]`, 'is a duplicate'); return; }
      seen.add(tag.toLowerCase());
      out.push(tag);
    });
    const max = Math.min(...(forPlatforms.length ? forPlatforms : PLATFORMS).map((x) => MAX_HASHTAGS[x]));
    if (!tagsRecommended && out.length) fail(path, 'must be empty - the strategy does not recommend hashtags');
    if (tagsRecommended && !out.length) fail(path, 'needs hashtags - the strategy recommends them');
    if (out.length > max) {
      // a few too many hashtags is a format overrun: the model's first (most important) ones are kept; a wildly long list is still refused
      if (out.length > max * LIST_OVERFLOW_TOLERANCE) fail(path, `can have at most ${max} hashtags for ${(forPlatforms.length ? forPlatforms : PLATFORMS).join(' and ')}`);
      else { out.length = max; adjusted.push(`${path}: trimmed to ${max}`); }
    }
    return out;
  };
  const checkLength = (path, caption, tags, forPlatforms) => {
    for (const platform of forPlatforms) {
      const total = caption.length + (tags.length ? 2 + tags.join(' ').length : 0);
      if (total > PLATFORM_TEXT_LIMITS[platform]) fail(path, `the post (with hashtags) must be ${PLATFORM_TEXT_LIMITS[platform]} characters or fewer for ${platform}`);
    }
  };

  const seenSlots = new Set();
  const seenTopics = new Set(ctx.usedTopics || []);
  const items = [];
  raw.items.slice(0, slots.length + 2).forEach((entry, i) => {
    const p = `items[${i}]`;
    if (!isObj(entry)) { fail(p, 'must be an object'); return; }
    const slot = bySlot.get(entry.slot);
    if (!slot) { fail(`${p}.slot`, `${JSON.stringify(entry.slot)} is not one of the requested slots`); return; }
    if (seenSlots.has(slot.index)) { fail(`${p}.slot`, `slot ${slot.index} appears more than once`); return; }
    seenSlots.add(slot.index);

    // platforms: fixed by the server for balanced / platform_specific; the model's choice (a subset of the selected) otherwise
    let platforms = [];
    if (!Array.isArray(entry.platforms) || !entry.platforms.length) fail(`${p}.platforms`, 'must list at least one platform');
    else {
      platforms = [...new Set(entry.platforms.map((x) => oneOf(x, `${p}.platforms`, PLATFORMS)))];
      if (platforms.some((x) => !selectedPlatforms.includes(x))) fail(`${p}.platforms`, `only the selected platforms (${selectedPlatforms.join(', ')}) may be used`);
      if (slot.platforms && (platforms.length !== slot.platforms.length || platforms.some((x) => !slot.platforms.includes(x)))) fail(`${p}.platforms`, `slot ${slot.index} is fixed to ${slot.platforms.join(', ')}`);
    }
    platforms = PLATFORMS.filter((x) => platforms.includes(x));

    const format = oneOf(entry.format, `${p}.format`, CALENDAR_FORMATS);
    if (format === 'text_post' && platforms.includes('instagram')) fail(`${p}.format`, 'an Instagram post needs an image or video, so text_post cannot target Instagram');

    const contentType = oneOf(entry.contentType, `${p}.contentType`, CONTENT_MIX_TYPES);
    if (allowedContentTypes.length && !allowedContentTypes.includes(contentType)) fail(`${p}.contentType`, `"${contentType}" is not part of the strategy's content mix (${allowedContentTypes.join(', ')})`);

    const objective = oneOf(entry.objective, `${p}.objective`, MARKETING_OBJECTIVES);
    let primaryKpi = oneOf(entry.primaryKpi, `${p}.primaryKpi`, ALL_KPIS);
    // the OBJECTIVE decides which measures fit it (a real KPI that does not measure this objective is replaced by the objective's own first one - deterministic, recorded)
    if (MARKETING_OBJECTIVES.includes(objective) && !KPIS_BY_OBJECTIVE[objective].includes(primaryKpi)) {
      adjusted.push(`${p}.primaryKpi: set to the ${objective} objective's own KPI`);
      primaryKpi = KPIS_BY_OBJECTIVE[objective][0];
    }

    const primaryCta = text(entry.primaryCta, `${p}.primaryCta`, CALENDAR_LIMITS.cta, { allowEmpty: false });
    if (PURCHASE_CTA_RE.test(primaryCta) && objective !== 'conversion') fail(`${p}.primaryCta`, `"${primaryCta}" asks for a purchase, which only suits a conversion objective`);

    // references: only the business's own active catalog, and only the kind its business model uses
    let serviceId = null;
    let productId = null;
    if (entry.serviceId !== null && entry.serviceId !== undefined) {
      if (typeof entry.serviceId !== 'string' || !OBJECT_ID_RE.test(entry.serviceId) || !catalog.services.has(entry.serviceId.toLowerCase())) fail(`${p}.serviceId`, 'is not one of the supplied services');
      else if (catalog.businessModel === 'product') fail(`${p}.serviceId`, 'this is a product business: reference a product, not a service');
      else serviceId = entry.serviceId.toLowerCase();
    }
    if (entry.productId !== null && entry.productId !== undefined) {
      if (typeof entry.productId !== 'string' || !OBJECT_ID_RE.test(entry.productId) || !catalog.products.has(entry.productId.toLowerCase())) fail(`${p}.productId`, 'is not one of the supplied products');
      else if (catalog.businessModel === 'service') fail(`${p}.productId`, 'this is a service business: reference a service, not a product');
      else productId = entry.productId.toLowerCase();
    }

    // the hook: a strategy hook is used verbatim; otherwise the model's own, which must exist when the strategy has hooks
    let hookRef = null;
    let hook = text(entry.hook, `${p}.hook`, CALENDAR_LIMITS.hook);
    if (entry.hookRef !== null && entry.hookRef !== undefined) {
      if (!Number.isInteger(entry.hookRef) || entry.hookRef < 0 || entry.hookRef >= hooks.length) fail(`${p}.hookRef`, `${JSON.stringify(entry.hookRef)} is not the index of a strategy hook`);
      else { hookRef = entry.hookRef; hook = hooks[hookRef].hook; }
    }
    if (!hook && hooks.length) fail(`${p}.hook`, 'must not be empty');

    const topic = text(entry.topic, `${p}.topic`, CALENDAR_LIMITS.topic, { allowEmpty: false });
    const topicKey = topic.toLowerCase();
    if (topic && seenTopics.has(topicKey)) fail(`${p}.topic`, `"${topic}" is already planned — every post needs its own topic`);
    seenTopics.add(topicKey);

    const requiredAssets = Array.isArray(entry.requiredAssets) ? [...new Set(entry.requiredAssets)] : (fail(`${p}.requiredAssets`, 'must be a list'), []);
    requiredAssets.forEach((a) => { if (!ASSET_TYPES.includes(a)) fail(`${p}.requiredAssets`, `"${a}" is not a known asset type`); });
    if (requiredAssets.length > CALENDAR_LIMITS.assetsMax) fail(`${p}.requiredAssets`, `can have at most ${CALENDAR_LIMITS.assetsMax} entries`);
    if (typeof entry.requiresReview !== 'boolean') fail(`${p}.requiresReview`, 'must be true or false');

    // the written copy: a shared caption + hashtags, and one adapted version per platform when the slot targets both
    const caption = copy(entry.caption, `${p}.caption`, CALENDAR_LIMITS.caption);
    if (!caption && typeof entry.caption === 'string') fail(`${p}.caption`, 'must not be empty: write the complete caption');
    const hashtags = tagList(entry.hashtags, `${p}.hashtags`, platforms);
    checkLength(`${p}.caption`, caption, hashtags, platforms);
    let platformContent = [];
    if (!Array.isArray(entry.platformContent)) fail(`${p}.platformContent`, 'must be a list');
    else if (platforms.length < 2) {
      if (entry.platformContent.length) fail(`${p}.platformContent`, 'must be empty when the slot targets one platform');
    } else {
      const seenPlatforms = new Set();
      entry.platformContent.forEach((pc, j) => {
        const q = `${p}.platformContent[${j}]`;
        if (!isObj(pc)) { fail(q, 'must be an object'); return; }
        if (!platforms.includes(pc.platform) || seenPlatforms.has(pc.platform)) { fail(`${q}.platform`, `must be one of ${platforms.join(', ')}, once each`); return; }
        seenPlatforms.add(pc.platform);
        const pcCaption = copy(pc.caption, `${q}.caption`, CALENDAR_LIMITS.caption);
        if (!pcCaption && typeof pc.caption === 'string') fail(`${q}.caption`, `must not be empty: write the ${pc.platform} caption`);
        const pcCta = text(pc.primaryCta, `${q}.primaryCta`, CALENDAR_LIMITS.cta, { allowEmpty: false });
        if (PURCHASE_CTA_RE.test(pcCta) && objective !== 'conversion') fail(`${q}.primaryCta`, `"${pcCta}" asks for a purchase, which only suits a conversion objective`);
        const pcTags = tagList(pc.hashtags, `${q}.hashtags`, [pc.platform]);
        checkLength(`${q}.caption`, pcCaption, pcTags, [pc.platform]);
        platformContent.push({ platform: pc.platform, caption: pcCaption, primaryCta: pcCta, hashtags: pcTags });
      });
      for (const platform of platforms) if (!seenPlatforms.has(platform)) fail(`${p}.platformContent`, `needs an entry for ${platform}: this slot targets both platforms, so each gets its own adapted copy`);
      platformContent = PLATFORMS.map((platform) => platformContent.find((x) => x.platform === platform)).filter(Boolean);
    }

    items.push({
      slot: slot.index,
      contentDate: slot.date,
      dayOfWeek: slot.dayOfWeek,
      contentPillar: slot.pillar, // the server's, never the model's
      platforms,
      format,
      deliverable: text(entry.deliverable, `${p}.deliverable`, CALENDAR_LIMITS.deliverable),
      contentType,
      objective,
      primaryKpi,
      targetAudience: text(entry.targetAudience, `${p}.targetAudience`, CALENDAR_LIMITS.audience),
      occasion: text(entry.occasion, `${p}.occasion`, CALENDAR_LIMITS.occasion),
      topic,
      angle: text(entry.angle, `${p}.angle`, CALENDAR_LIMITS.angle),
      hook,
      hookRef,
      onCreativeText: text(entry.onCreativeText, `${p}.onCreativeText`, CALENDAR_LIMITS.onCreativeText),
      creativeDirection: text(entry.creativeDirection, `${p}.creativeDirection`, CALENDAR_LIMITS.creativeDirection),
      contentBrief: text(entry.contentBrief, `${p}.contentBrief`, CALENDAR_LIMITS.brief),
      captionDirection: text(entry.captionDirection, `${p}.captionDirection`, CALENDAR_LIMITS.captionDirection),
      primaryCta,
      engagementPrompt: text(entry.engagementPrompt, `${p}.engagementPrompt`, CALENDAR_LIMITS.engagementPrompt),
      caption,
      hashtags,
      platformContent,
      requiredAssets: requiredAssets.filter((a) => ASSET_TYPES.includes(a)).slice(0, CALENDAR_LIMITS.assetsMax),
      serviceId,
      productId,
      requiresReview: entry.requiresReview === true,
      approvalNotes: text(entry.approvalNotes, `${p}.approvalNotes`, CALENDAR_LIMITS.approvalNotes),
      footerDisclaimer: text(entry.footerDisclaimer, `${p}.footerDisclaimer`, CALENDAR_LIMITS.disclaimer),
    });
  });
  for (const s of slots) if (!seenSlots.has(s.index)) fail('items', `slot ${s.index} (${s.date}) has no item`);

  const textOf = (it) => [it.deliverable, it.targetAudience, it.occasion, it.topic, it.angle, it.hook, it.onCreativeText, it.creativeDirection, it.contentBrief, it.captionDirection, it.primaryCta, it.engagementPrompt, it.approvalNotes, it.footerDisclaimer,
    it.caption, ...it.platformContent.flatMap((x) => [x.caption, x.primaryCta])].join(' \n ');

  // honesty: no trend claims
  items.forEach((it, i) => { if (TREND_CLAIM_RE.test(textOf(it))) fail(`items[${i}]`, 'must not claim a topic is trending or viral (there is no live trend data)'); });

  // honesty: no banned phrase
  const banned = (ctx.prohibitedPhrases || []).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  if (banned.length) {
    // direction notes for the team (creative / caption direction, the brief, approval notes) may NAME a banned phrase to forbid it ("never say guaranteed results");
    // everything that can be published - the caption, hook, on-image text, call to action - may never contain it
    const INTERNAL = new Set(['creativeDirection', 'contentBrief', 'captionDirection', 'approvalNotes']);
    items.forEach((it, i) => {
      const located = [
        ...['deliverable', 'targetAudience', 'occasion', 'topic', 'angle', 'hook', 'onCreativeText', 'creativeDirection', 'contentBrief', 'captionDirection', 'primaryCta', 'engagementPrompt', 'approvalNotes', 'footerDisclaimer', 'caption'].map((f) => [f, it[f]]),
        ...it.platformContent.flatMap((x, j) => [[`platformContent[${j}].caption`, x.caption], [`platformContent[${j}].primaryCta`, x.primaryCta]]),
      ];
      for (const [field, value] of located) {
        const hit = banned.find((b) => String(value ?? '').toLowerCase().includes(b));
        if (!hit) continue;
        if (INTERNAL.has(field) && PROHIBITION_RE.test(String(value))) continue;
        fail(`items[${i}].${field}`, `uses the prohibited phrase "${hit}"`);
        break;
      }
    });
  }

  // honesty: no figure, price, link or contact detail the business did not supply
  if (ctx.allowedFactsText !== undefined) {
    items.forEach((it, i) => {
      const extra = unsupportedFigures(textOf(it), ctx.allowedFactsText);
      if (extra.length) fail(`items[${i}]`, `states figures or addresses that were not in the supplied business information: ${extra.slice(0, 3).join(', ')}`);
    });
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, items: items.sort((a, b) => a.slot - b.slot), adjusted };
}

/**
 * Variety, applied AFTER validation, in calendar order. The same service / product on consecutive items (when there are at
 * least two to choose from) or used more than its fair share is cleared (the item becomes brand-level content) and a warning
 * recorded; a format repeated three times running is only warned about. Returns { items, warnings, carry } and never throws.
 *
 * It is INCREMENTAL, so a long calendar can be saved batch by batch (and resumed after a crash) with exactly the result one pass
 * over the whole calendar would give: the rules only ever look at the previous item, at how often an id was already kept, and at the
 * last two formats. `carry` is that state after this batch ({ used, prev, formats }); pass it back with the next batch, together with
 * `total` (the number of posts of the WHOLE calendar - the fair share is computed from it). `varietyCarryFromItems` rebuilds it from
 * the items already saved.
 */
export function applyVariety(items, { serviceCount = 0, productCount = 0, total = null, carry = null } = {}) {
  const warnings = [];
  const out = items.map((it) => ({ ...it }));
  const prior = carry || { used: {}, prev: { serviceId: null, productId: null }, formats: [] };
  const used = new Map(Object.entries(prior.used || {}));
  const refCount = Math.max(serviceCount, productCount);
  if (refCount >= 2) {
    const cap = Math.ceil((total ?? out.length) / refCount) + 1;
    out.forEach((it, i) => {
      for (const key of ['serviceId', 'productId']) {
        const id = it[key];
        if (!id) continue;
        const prev = i === 0 ? prior.prev?.[key] : out[i - 1]?.[key];
        const overUsed = (used.get(id) || 0) >= cap;
        if (prev === id || overUsed) {
          warnings.push(`${it.contentDate}: the ${key === 'serviceId' ? 'service' : 'product'} was ${prev === id ? 'repeated on consecutive posts' : 'used more than its share'}, so this post is brand-level content instead.`);
          it[key] = null;
          if (key === 'serviceId') it.serviceName = null;
          else it.productName = null;
        } else used.set(id, (used.get(id) || 0) + 1);
      }
    });
  }
  const formats = [...(prior.formats || []), ...out.map((it) => it.format)];
  const offset = (prior.formats || []).length;
  for (let j = Math.max(offset, 2); j < formats.length; j += 1) {
    if (formats[j] === formats[j - 1] && formats[j] === formats[j - 2]) warnings.push(`${out[j - offset].contentDate}: the same format (${formats[j]}) is used three posts in a row.`);
  }
  const last = out[out.length - 1];
  return {
    items: out,
    warnings,
    carry: {
      used: Object.fromEntries(used),
      prev: { serviceId: last ? last.serviceId || null : prior.prev?.serviceId || null, productId: last ? last.productId || null : prior.prev?.productId || null },
      formats: formats.slice(-2),
    },
  };
}

/** The `carry` of applyVariety rebuilt from items that are already saved (in slot order): what a resumed run continues from. */
export function varietyCarryFromItems(savedItems) {
  const used = {};
  for (const it of savedItems) for (const key of ['serviceId', 'productId']) if (it[key]) used[String(it[key])] = (used[String(it[key])] || 0) + 1;
  const last = savedItems[savedItems.length - 1];
  return {
    used,
    prev: { serviceId: last?.serviceId ? String(last.serviceId) : null, productId: last?.productId ? String(last.productId) : null },
    formats: savedItems.slice(-2).map((it) => it.format),
  };
}

export default { CALENDAR_TOOL_NAME, CALENDAR_LIMITS, buildCalendarToolSchema, validateCalendarBatch, applyVariety, varietyCarryFromItems, PURCHASE_CTA_RE, REGULATED_RE, ALL_KPIS };
