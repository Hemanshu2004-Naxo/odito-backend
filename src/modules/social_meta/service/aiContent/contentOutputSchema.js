import { PLATFORM_TEXT_LIMITS, MAX_HASHTAGS } from './contentConfig.js';

/**
 * Single-post AI content - the ONE definition of the output contract.
 *
 * Used twice, from the same constants:
 *   1. buildContentToolSchema()  -> the JSON schema handed to the model as a forced tool,
 *      so the provider returns structured data (never markdown to parse);
 *   2. validateContentOutput()   -> the strict server-side validator. The model's output is
 *      NEVER saved because it was JSON: it is rebuilt field by field from known keys only,
 *      every type / length / enum / echo is checked, hard business rules are enforced
 *      (prohibited phrases, hashtag rules, unsupported figures) and only the rebuilt object
 *      can become a draft.
 *
 * Persisted from the output: the post text (caption + hashtags) is the draft's `content`.
 * `callToAction` and `rationale` are kept only on the generation record, for display; `hook`
 * was deliberately not added - no field would store it and the preview does not need it.
 */

export const CONTENT_TOOL_NAME = 'emit_social_post';
export const PLATFORMS = Object.freeze(['facebook', 'instagram']);

export const LIMITS = Object.freeze({
  captionMin: 1,
  captionMax: 2_000, // the platform ceiling (PLATFORM_TEXT_LIMITS) is applied to the FINAL text on top of this
  cta: 150,
  hashtag: 50,
  rationale: 300,
});

// ── tool schema ──────────────────────────────────────────────────────────────

export function buildContentToolSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['platform', 'contentPillar', 'objective', 'caption', 'callToAction', 'hashtags', 'rationale'],
    properties: {
      platform: { type: 'string', enum: PLATFORMS, description: 'Echo the requested platform exactly.' },
      contentPillar: { type: 'string', maxLength: 100, description: 'Echo the requested content pillar exactly.' },
      objective: { type: 'string', maxLength: 40, description: 'Echo the requested objective exactly.' },
      caption: { type: 'string', maxLength: LIMITS.captionMax, description: 'The complete post text, ready to publish. Contains the call to action when one is used. Contains NO hashtags (they go in "hashtags").' },
      callToAction: { type: ['string', 'null'], maxLength: LIMITS.cta, description: 'The call to action exactly as it appears inside the caption, or null when the post has none.' },
      hashtags: { type: 'array', maxItems: Math.max(...Object.values(MAX_HASHTAGS)), items: { type: 'string', maxLength: LIMITS.hashtag }, description: 'Hashtags starting with #. Empty when hashtags are not recommended.' },
      rationale: { type: 'string', maxLength: LIMITS.rationale, description: `One or two short sentences (at most ${LIMITS.rationale} characters): how this post follows the pillar and objective.` },
    },
  };
}

// ── validation ───────────────────────────────────────────────────────────────

// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const HASHTAG_RE = /^#[\p{L}\p{N}_]{1,50}$/u;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Things a post must not state unless the business itself supplied them: prices / amounts,
 * percentages, large grouped numbers, web addresses, e-mail addresses and phone numbers.
 * (Ordinary words and small numbers like "5 tips" are not "facts" and are not checked.)
 */
const PHONE_RE = /\+?\d[\d\s().-]{7,}\d/g;
const FIGURE_PATTERNS = [
  /[$€£₹¥]\s?\d[\d,]*(?:\.\d+)?/g,
  /\b\d[\d,]*(?:\.\d+)?\s?(?:%|percent\b)/gi,
  /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/g,
  /https?:\/\/[^\s)]+/gi,
  /\bwww\.[^\s)]+/gi,
  /[^\s@]+@[^\s@]+\.[a-z]{2,}/gi,
  PHONE_RE,
  /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|app|uk|in|ai|dev|info|biz|us|ca|au)\b/gi,
];

const squash = (s) => norm(s).replace(/\s/g, '').replace(/[.,;:!?)\]]+$/g, '');

/** The figures in `text` that do not appear in `allowedText` (the business's own supplied words). */
export function unsupportedFigures(text, allowedText) {
  const allowed = squash(allowedText).replace(/[.,;:!?)\]]/g, '');
  const found = new Set();
  for (const re of FIGURE_PATTERNS) {
    for (const m of text.match(re) || []) {
      // a phone-like run needs at least 9 digits - "1998 - 2005" is a date range, not a phone number
      if (re === PHONE_RE && m.replace(/\D/g, '').length < 9) continue;
      const token = squash(m);
      if (token.length < 2) continue;
      if (!allowed.includes(token.replace(/[.,;:!?)\]]/g, ''))) found.add(m.trim());
    }
  }
  return [...found];
}

/**
 * @param {unknown} raw  the model's tool input
 * @param {object} ctx
 * @param {'facebook'|'instagram'} ctx.platform
 * @param {string} ctx.contentPillar
 * @param {string} ctx.objective
 * @param {{ enabled?: boolean, recommendedCount?: number }} [ctx.hashtagStrategy]
 * @param {string[]} [ctx.prohibitedPhrases]
 * @param {string} [ctx.allowedFactsText]   every string the business supplied (snapshot), for the unsupported-figure guard
 * @returns {{ ok: true, content: { caption, callToAction, hashtags, rationale, text } } | { ok: false, errors: string[] }}
 */
export function validateContentOutput(raw, ctx) {
  const errors = [];
  const fail = (path, message) => { if (errors.length < 15) errors.push(`${path}: ${message}`); };
  if (!isObj(raw)) return { ok: false, errors: ['The post must be an object.'] };

  // echoes must match the request exactly - the model may not pick a different platform / pillar / objective
  if (raw.platform !== ctx.platform) fail('platform', `must be "${ctx.platform}"`);
  if (raw.contentPillar !== ctx.contentPillar) fail('contentPillar', `must be exactly "${ctx.contentPillar}"`);
  if (raw.objective !== ctx.objective) fail('objective', `must be "${ctx.objective}"`);

  let caption = '';
  if (typeof raw.caption !== 'string') fail('caption', 'must be text');
  else {
    caption = raw.caption.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (caption.length < LIMITS.captionMin) fail('caption', 'must not be empty');
    if (caption.length > LIMITS.captionMax) fail('caption', `must be ${LIMITS.captionMax} characters or fewer`);
    if (BAD_CHARS.test(caption)) fail('caption', 'contains control characters');
    if (/(^|\s)#[\p{L}\p{N}_]+/u.test(caption)) fail('caption', 'must not contain hashtags (put them in "hashtags")');
  }

  let callToAction = null;
  if (raw.callToAction !== null && raw.callToAction !== undefined) {
    if (typeof raw.callToAction !== 'string') fail('callToAction', 'must be text or null');
    else {
      const cta = raw.callToAction.replace(/\s+/g, ' ').trim();
      if (cta.length > LIMITS.cta) fail('callToAction', `must be ${LIMITS.cta} characters or fewer`);
      else if (cta && !norm(caption).includes(norm(cta))) fail('callToAction', 'must appear inside the caption exactly as written');
      else callToAction = cta || null;
    }
  }

  const strat = ctx.hashtagStrategy || {};
  const maxTags = Math.min(MAX_HASHTAGS[ctx.platform] ?? 10, strat.enabled ? (Number(strat.recommendedCount) || 0) + 3 : 0);
  const hashtags = [];
  if (!Array.isArray(raw.hashtags)) fail('hashtags', 'must be a list');
  else {
    const seen = new Set();
    raw.hashtags.forEach((h, i) => {
      if (typeof h !== 'string') { fail(`hashtags[${i}]`, 'must be text'); return; }
      const tag = h.trim();
      if (!HASHTAG_RE.test(tag)) { fail(`hashtags[${i}]`, 'must start with # and contain only letters, numbers or underscores'); return; }
      if (seen.has(tag.toLowerCase())) { fail(`hashtags[${i}]`, 'is a duplicate'); return; }
      seen.add(tag.toLowerCase());
      hashtags.push(tag);
    });
    if (!strat.enabled && hashtags.length) fail('hashtags', 'must be empty - the strategy does not recommend hashtags');
    if (hashtags.length > maxTags) fail('hashtags', `can have at most ${maxTags} hashtags`);
  }

  let rationale = null;
  if (raw.rationale !== null && raw.rationale !== undefined) {
    if (typeof raw.rationale !== 'string') fail('rationale', 'must be text');
    else {
      const r = raw.rationale.replace(/\s+/g, ' ').trim();
      // A reviewer's note, never published: an over-long one is shortened (at a word boundary), not a reason to reject a good post.
      // (OpenAI strict structured output cannot enforce maxLength, so a model overrunning it is expected.)
      rationale = r.length > LIMITS.rationale ? `${r.slice(0, LIMITS.rationale - 1).replace(/\s+\S*$/, '')}…` : r || null;
    }
  }

  const text = hashtags.length ? `${caption}\n\n${hashtags.join(' ')}` : caption;
  const platformMax = PLATFORM_TEXT_LIMITS[ctx.platform];
  if (platformMax && text.length > platformMax) fail('caption', `the post (with hashtags) must be ${platformMax} characters or fewer for ${ctx.platform}`);

  // hard business rules on what will actually be PUBLISHED
  const banned = (ctx.prohibitedPhrases || []).map((p) => String(p).trim().toLowerCase()).filter(Boolean);
  const published = `${text}\n${callToAction || ''}`.toLowerCase();
  const hit = banned.find((p) => published.includes(p));
  if (hit) fail('caption', `uses the prohibited phrase "${hit}"`);

  if (caption && ctx.allowedFactsText !== undefined) {
    const extra = unsupportedFigures(`${caption}\n${callToAction || ''}`, ctx.allowedFactsText);
    if (extra.length) fail('caption', `states figures or addresses that were not in the supplied business information: ${extra.slice(0, 4).join(', ')}`);
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, content: { caption, callToAction, hashtags, rationale, text } };
}

export default { CONTENT_TOOL_NAME, buildContentToolSchema, validateContentOutput, unsupportedFigures, LIMITS, PLATFORMS };
