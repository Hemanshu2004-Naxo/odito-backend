import { unsupportedFigures } from '../aiContent/contentOutputSchema.js';

/**
 * AI Strategy output contract — the ONE definition of the strategy shape (schema version 2).
 *
 * The strategy is the BRAIN: who the brand is, who it talks to, what it says, which topics and hooks work, what
 * the competitive angle is, which platforms and formats matter. It deliberately does NOT contain a posting
 * schedule — the Content Calendar (service/calendar/) combines this strategy with the user's own posting
 * frequency, platforms and dates. It is also deliberately COMPACT: short fields, small lists, no essays.
 *
 * Used twice, from the same constants:
 *   1. buildStrategyToolSchema()  -> the JSON schema handed to the model as a forced
 *      tool, so the provider returns structured data (never markdown to parse);
 *   2. validateStrategyOutput()   -> the strict server-side validator. The model's
 *      output is NEVER trusted because it was JSON: it is rebuilt field by field
 *      from known keys only, every type/length/enum/bound is checked, and only the
 *      rebuilt object can be saved.
 *
 * Strategies saved before schema version 2 (no `schemaVersion`) keep their stored shape and stay readable; the
 * fields content generation consumes (summary, contentPillars, contentMix, platformStrategy, toneAndVoice,
 * hashtagStrategy, ctaStrategy.preferredCTAs, brandRules) are unchanged.
 */

export const STRATEGY_TOOL_NAME = 'emit_social_strategy';
export const STRATEGY_SCHEMA_VERSION = 3;

export const PLATFORMS = Object.freeze(['facebook', 'instagram']);
export const PRIORITIES = Object.freeze(['high', 'medium', 'low']);
/** Matches the post types the AI Strategy page already presents, plus the two engagement-style types. */
export const CONTENT_MIX_TYPES = Object.freeze(['informational', 'educational', 'soft_sell', 'hard_sell', 'engagement', 'behind_the_scenes']);
export const WEEKDAYS = Object.freeze(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']);

/** What a post is FOR (a marketing objective), and the KPI that measures it. Shared with the content calendar. */
export const MARKETING_OBJECTIVES = Object.freeze(['awareness', 'engagement', 'traffic', 'lead_generation', 'conversion']);
export const KPIS_BY_OBJECTIVE = Object.freeze({
  awareness: ['reach', 'views'],
  engagement: ['comments', 'shares', 'saves'],
  traffic: ['link_clicks'],
  lead_generation: ['dms', 'calls', 'form_submissions'],
  conversion: ['purchases', 'bookings'],
});
export const HOOK_CATEGORIES = Object.freeze(['educational', 'curiosity', 'problem_solution', 'contrarian', 'story', 'proof', 'engagement', 'promotional']);
export const TOPIC_FRESHNESS = Object.freeze(['evergreen', 'seasonal', 'emerging']);

/** A percentage list may be off by this much before it is rejected; within it, the largest item is adjusted to total exactly 100. */
export const PERCENT_SUM_TOLERANCE = 5;

export const LIMITS = Object.freeze({
  summary: 300,
  overview: { objective: 140, opportunity: 180, platformFocus: 120 },
  brandAnalysis: { item: 120, itemsMax: 5, personality: 40, personalityMax: 5, style: 180 },
  positioning: { brandPositioning: 220, valueProposition: 220, differentiator: 120, differentiatorsMax: 4, whyChoose: 220, messagingAngle: 160 },
  audience: { primary: 220, secondary: 120, secondaryMax: 3, painPoint: 120, painPointsMax: 4, interest: 60, interestsMax: 6, motivation: 120, motivationsMax: 4, item: 120, itemsMax: 4 },
  goals: { max: 4, goal: 120, rationale: 180 },
  pillars: { min: 2, max: 6, name: 50, description: 140, purpose: 120, topic: 80, topicsMin: 1, topicsMax: 4, format: 40, formatsMin: 1, formatsMax: 4 },
  mix: { min: 2, max: CONTENT_MIX_TYPES.length, rationale: 140 },
  trending: { max: 6, topic: 90, why: 160, angle: 140 },
  hooks: { min: 6, max: 12, hook: 150 },
  competitor: { namesMax: 10, name: 100, item: 180, itemsMax: 4 },
  platform: { role: 160, contentType: 40, contentTypesMin: 1, contentTypesMax: 5, postsPerWeekMax: 21, behavior: 160, guideline: 140, guidelinesMax: 3 },
  tone: { primary: 120, secondary: 60, secondaryMax: 3, guideline: 140, guidelinesMin: 1, guidelinesMax: 4, avoid: 100, avoidMax: 10 },
  posting: { postsPerWeekMax: 28, rangeMax: 14, window: 80, windowsMax: 3 },
  hashtags: { approach: 240, countMax: 30, category: 80, categoriesMax: 5 },
  cta: { preferred: 60, preferredMin: 1, preferredMax: 6, objective: 120, objectivesMax: 4, byObjectiveMax: MARKETING_OBJECTIVES.length, ctasMin: 1, ctasMax: 4 },
  brand: { guideline: 140, guidelinesMax: 4, rule: 140, rulesMax: 5 },
  recommendations: { max: 6, length: 200 },
  assumptions: { max: 5, length: 200 },
  gaps: { max: 8, field: 60, reason: 200 },
  // v3: what the chosen planning period needs (seasonal themes, campaign ideas, how success is read). Short phrases; no invented figures.
  outlook: { themesMax: 4, theme: 60, timing: 40, idea: 140, campaignsMax: 3, campaign: 60, metricsMax: 4, metric: 60, success: 140 },
});

// ── tool schema (what the model is asked to produce) ─────────────────────────

const str = (maxLength, description) => ({ type: 'string', maxLength, ...(description ? { description } : {}) });
const strList = (maxItems, maxLength, minItems = 0) => ({ type: 'array', minItems, maxItems, items: { type: 'string', maxLength } });

export function buildStrategyToolSchema() {
  const L = LIMITS;
  return {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'overview', 'brandAnalysis', 'positioning', 'audience', 'goals', 'contentPillars', 'contentMix', 'trendingTopics', 'workingHooks', 'competitorAnalysis', 'platformStrategy', 'toneAndVoice', 'postingStrategy', 'hashtagStrategy', 'ctaStrategy', 'brandRules', 'recommendations', 'assumptions', 'gaps', 'planOutlook'],
    properties: {
      summary: str(L.summary, 'One or two sentences: what this business should do on social media and why.'),
      overview: {
        type: 'object', additionalProperties: false, required: ['primaryObjective', 'strongestOpportunity', 'growthOpportunity', 'platformFocus'],
        properties: {
          primaryObjective: str(L.overview.objective, 'The main thing social media should achieve for this business.'),
          strongestOpportunity: str(L.overview.opportunity),
          growthOpportunity: str(L.overview.opportunity),
          platformFocus: str(L.overview.platformFocus, 'Which platform(s) to prioritise.'),
        },
      },
      brandAnalysis: {
        type: 'object', additionalProperties: false, required: ['strengths', 'weaknesses', 'differentiators', 'personality', 'communicationStyle', 'opportunities', 'risks'],
        properties: {
          strengths: strList(L.brandAnalysis.itemsMax, L.brandAnalysis.item),
          weaknesses: strList(L.brandAnalysis.itemsMax, L.brandAnalysis.item),
          differentiators: strList(L.brandAnalysis.itemsMax, L.brandAnalysis.item),
          personality: strList(L.brandAnalysis.personalityMax, L.brandAnalysis.personality),
          communicationStyle: str(L.brandAnalysis.style),
          opportunities: strList(L.brandAnalysis.itemsMax, L.brandAnalysis.item),
          risks: strList(L.brandAnalysis.itemsMax, L.brandAnalysis.item),
        },
      },
      positioning: {
        type: 'object', additionalProperties: false, required: ['brandPositioning', 'valueProposition', 'keyDifferentiators', 'whyCustomersChoose', 'messagingAngle'],
        properties: {
          brandPositioning: str(L.positioning.brandPositioning),
          valueProposition: str(L.positioning.valueProposition),
          keyDifferentiators: strList(L.positioning.differentiatorsMax, L.positioning.differentiator),
          whyCustomersChoose: str(L.positioning.whyChoose),
          messagingAngle: str(L.positioning.messagingAngle),
        },
      },
      audience: {
        type: 'object', additionalProperties: false, required: ['primaryAudience', 'secondaryAudiences', 'painPoints', 'needs', 'motivations', 'buyingTriggers', 'objections', 'interests'],
        properties: {
          primaryAudience: str(L.audience.primary, 'Empty string if no audience was supplied and none can be responsibly inferred.'),
          secondaryAudiences: strList(L.audience.secondaryMax, L.audience.secondary),
          painPoints: strList(L.audience.painPointsMax, L.audience.painPoint),
          needs: strList(L.audience.itemsMax, L.audience.item),
          motivations: strList(L.audience.motivationsMax, L.audience.motivation),
          buyingTriggers: strList(L.audience.itemsMax, L.audience.item),
          objections: strList(L.audience.itemsMax, L.audience.item),
          interests: strList(L.audience.interestsMax, L.audience.interest),
        },
      },
      goals: {
        type: 'array', maxItems: L.goals.max,
        items: { type: 'object', additionalProperties: false, required: ['goal', 'priority', 'rationale'], properties: { goal: str(L.goals.goal), priority: { type: 'string', enum: PRIORITIES }, rationale: str(L.goals.rationale) } },
      },
      contentPillars: {
        type: 'array', minItems: L.pillars.min, maxItems: L.pillars.max,
        description: 'suggestedPercentage values are whole numbers that add up to 100.',
        items: {
          type: 'object', additionalProperties: false, required: ['name', 'description', 'purpose', 'suggestedPercentage', 'exampleTopics', 'formats'],
          properties: {
            name: str(L.pillars.name), description: str(L.pillars.description), purpose: str(L.pillars.purpose),
            suggestedPercentage: { type: 'integer', minimum: 0, maximum: 100 },
            exampleTopics: strList(L.pillars.topicsMax, L.pillars.topic, L.pillars.topicsMin),
            formats: strList(L.pillars.formatsMax, L.pillars.format, L.pillars.formatsMin),
          },
        },
      },
      contentMix: {
        type: 'array', minItems: L.mix.min, maxItems: L.mix.max,
        description: 'One entry per post type used; each type at most once; percentages are whole numbers that add up to 100.',
        items: { type: 'object', additionalProperties: false, required: ['type', 'percentage', 'rationale'], properties: { type: { type: 'string', enum: CONTENT_MIX_TYPES }, percentage: { type: 'integer', minimum: 0, maximum: 100 }, rationale: str(L.mix.rationale) } },
      },
      trendingTopics: {
        type: 'array', maxItems: L.trending.max,
        description: 'Topics the brand could create content about NOW. You have NO live trend data: never claim a topic is trending, viral or popular, and never state numbers about it. These are recommended current topics.',
        items: {
          type: 'object', additionalProperties: false, required: ['topic', 'whyItMatters', 'relevance', 'angle', 'freshness'],
          properties: { topic: str(L.trending.topic), whyItMatters: str(L.trending.why), relevance: { type: 'string', enum: PRIORITIES }, angle: str(L.trending.angle), freshness: { type: 'string', enum: TOPIC_FRESHNESS } },
        },
      },
      workingHooks: {
        type: 'array', minItems: L.hooks.min, maxItems: L.hooks.max,
        description: 'Reusable opening lines specific to THIS business, audience and offer — not generic internet hooks.',
        items: { type: 'object', additionalProperties: false, required: ['hook', 'category'], properties: { hook: str(L.hooks.hook), category: { type: 'string', enum: HOOK_CATEGORIES } } },
      },
      competitorAnalysis: {
        type: 'object', additionalProperties: false, required: ['competitorsConsidered', 'differentiationOpportunities', 'contentGaps', 'recommendations'],
        description: 'ONLY from the competitors the business supplied (names and websites). You cannot see their content: never describe what a competitor actually posts. If none were supplied, return empty lists.',
        properties: {
          competitorsConsidered: strList(L.competitor.namesMax, L.competitor.name),
          differentiationOpportunities: strList(L.competitor.itemsMax, L.competitor.item),
          contentGaps: strList(L.competitor.itemsMax, L.competitor.item),
          recommendations: strList(L.competitor.itemsMax, L.competitor.item),
        },
      },
      platformStrategy: {
        type: 'array', minItems: 1, maxItems: PLATFORMS.length,
        items: {
          type: 'object', additionalProperties: false, required: ['platform', 'role', 'contentTypes', 'postsPerWeek', 'audienceBehavior', 'guidance'],
          properties: {
            platform: { type: 'string', enum: PLATFORMS }, role: str(L.platform.role), contentTypes: strList(L.platform.contentTypesMax, L.platform.contentType, L.platform.contentTypesMin),
            postsPerWeek: { type: 'integer', minimum: 0, maximum: L.platform.postsPerWeekMax, description: 'A recommendation only; the user chooses the real frequency.' },
            audienceBehavior: str(L.platform.behavior), guidance: strList(L.platform.guidelinesMax, L.platform.guideline),
          },
        },
      },
      toneAndVoice: {
        type: 'object', additionalProperties: false, required: ['primaryTone', 'secondaryTones', 'writingGuidelines', 'avoid'],
        properties: { primaryTone: str(L.tone.primary), secondaryTones: strList(L.tone.secondaryMax, L.tone.secondary), writingGuidelines: strList(L.tone.guidelinesMax, L.tone.guideline, L.tone.guidelinesMin), avoid: strList(L.tone.avoidMax, L.tone.avoid) },
      },
      postingStrategy: {
        type: 'object', additionalProperties: false, required: ['postsPerWeek', 'postsPerWeekRange', 'recommendedDays', 'recommendedTimeWindows'],
        description: 'A RECOMMENDATION. The user picks the real posts per week when creating the calendar.',
        properties: {
          postsPerWeek: { type: 'integer', minimum: 0, maximum: L.posting.postsPerWeekMax },
          postsPerWeekRange: { type: 'object', additionalProperties: false, required: ['min', 'max'], properties: { min: { type: 'integer', minimum: 1, maximum: L.posting.rangeMax }, max: { type: 'integer', minimum: 1, maximum: L.posting.rangeMax } } },
          recommendedDays: { type: 'array', maxItems: 7, items: { type: 'string', enum: WEEKDAYS } },
          recommendedTimeWindows: strList(L.posting.windowsMax, L.posting.window),
        },
      },
      hashtagStrategy: {
        type: 'object', additionalProperties: false, required: ['enabled', 'approach', 'recommendedCount', 'categories'],
        properties: { enabled: { type: 'boolean' }, approach: str(L.hashtags.approach), recommendedCount: { type: 'integer', minimum: 0, maximum: L.hashtags.countMax }, categories: strList(L.hashtags.categoriesMax, L.hashtags.category) },
      },
      ctaStrategy: {
        type: 'object', additionalProperties: false, required: ['preferredCTAs', 'objectives', 'byObjective'],
        properties: {
          preferredCTAs: strList(L.cta.preferredMax, L.cta.preferred, L.cta.preferredMin),
          objectives: strList(L.cta.objectivesMax, L.cta.objective),
          byObjective: {
            type: 'array', maxItems: L.cta.byObjectiveMax,
            description: 'Which calls to action suit which marketing objective (e.g. an awareness post asks to follow or save, not to buy).',
            items: { type: 'object', additionalProperties: false, required: ['objective', 'ctas'], properties: { objective: { type: 'string', enum: MARKETING_OBJECTIVES }, ctas: strList(L.cta.ctasMax, L.cta.preferred, L.cta.ctasMin) } },
          },
        },
      },
      brandRules: {
        type: 'object', additionalProperties: false, required: ['visualGuidelines', 'messagingRules'],
        properties: { visualGuidelines: strList(L.brand.guidelinesMax, L.brand.guideline), messagingRules: strList(L.brand.rulesMax, L.brand.rule) },
      },
      recommendations: strList(L.recommendations.max, L.recommendations.length),
      assumptions: { ...strList(L.assumptions.max, L.assumptions.length), description: 'Anything you had to assume because it was not supplied. Empty if nothing.' },
      gaps: {
        type: 'array', maxItems: L.gaps.max,
        description: 'Important information that was missing and limited this strategy.',
        items: { type: 'object', additionalProperties: false, required: ['field', 'reason', 'importance'], properties: { field: str(L.gaps.field), reason: str(L.gaps.reason), importance: { type: 'string', enum: PRIORITIES } } },
      },
      planOutlook: {
        type: 'object', additionalProperties: false, required: ['seasonalThemes', 'campaignIdeas', 'successMetrics'],
        description: 'What the chosen planning period needs. Suggestions only: no dates, statistics or figures that were not supplied.',
        properties: {
          seasonalThemes: { type: 'array', maxItems: L.outlook.themesMax, items: { type: 'object', additionalProperties: false, required: ['theme', 'timing', 'idea'], properties: { theme: str(L.outlook.theme), timing: str(L.outlook.timing, 'Where in the planning period, e.g. "Month 1" or "Late in the period".'), idea: str(L.outlook.idea) } } },
          campaignIdeas: { type: 'array', maxItems: L.outlook.campaignsMax, items: { type: 'object', additionalProperties: false, required: ['name', 'idea'], properties: { name: str(L.outlook.campaign), idea: str(L.outlook.idea) } } },
          successMetrics: { type: 'array', maxItems: L.outlook.metricsMax, items: { type: 'object', additionalProperties: false, required: ['metric', 'whatGoodLooks'], properties: { metric: str(L.outlook.metric), whatGoodLooks: str(L.outlook.success, 'What success looks like in plain words, without inventing a number the business never supplied.') } } },
        },
      },
    },
  };
}

// ── server-side validation ───────────────────────────────────────────────────

// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A claim that something is trending / viral. Odito has no live trend data, so it must never say so. */
export const TREND_CLAIM_RE = /\b(trending|viral|going viral|gone viral|breaking news|everyone is talking|all the rage|top trend|#1 trend)\b/i;

/** Labels a model naturally reaches for, mapped to the closest hook category (a hook is still a good hook under a near-synonym label). */
const HOOK_CATEGORY_ALIASES = Object.freeze({
  behind_the_scenes: 'story', behind_scenes: 'story', storytelling: 'story', case_study: 'proof', social_proof: 'proof', testimonial: 'proof', results: 'proof',
  how_to: 'educational', tip: 'educational', tips: 'educational', education: 'educational', insight: 'educational', myth_busting: 'contrarian', myth: 'contrarian',
  question: 'engagement', poll: 'engagement', community: 'engagement', interactive: 'engagement', offer: 'promotional', cta: 'promotional', sales: 'promotional', promotion: 'promotional',
  problem: 'problem_solution', solution: 'problem_solution', pain_point: 'problem_solution', curiosity_gap: 'curiosity', teaser: 'curiosity',
});

/** A hook category from the model: exact, a known near-synonym, or (unknown label) the neutral "engagement" - never a rejected strategy. */
function hookCategory(value, collector, path) {
  if (typeof value !== 'string' || !value.trim()) { collector.fail(path, `must be one of ${HOOK_CATEGORIES.join(', ')}`); return HOOK_CATEGORIES[0]; }
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (HOOK_CATEGORIES.includes(key)) return key;
  return HOOK_CATEGORY_ALIASES[key] || 'engagement';
}

/** Wording that makes a sentence a PROHIBITION (so naming a banned phrase in it forbids the phrase rather than using it). */
export const PROHIBITION_RE = /\b(never|avoid|don'?t|do not|must not|should not|shouldn'?t|cannot|can'?t|no|not|without|refrain|steer clear|stop|ban(?:ned)?|forbid(?:den)?|prohibit(?:ed)?)\b/i;

/** Text up to this many times its limit is fitted to the limit; beyond it the output is rejected. */
export const FIT_TOLERANCE = 1.5;
/** A list with up to this many times its allowed entries keeps its FIRST entries (the model's most important ones); beyond it the output is rejected. */
export const LIST_OVERFLOW_TOLERANCE = 3;

/**
 * Shortens `text` to at most `max` characters WITHOUT cutting a word: at the last sentence end, else the last clause break
 * (, ; : - dash), else the last space - as long as that keeps at least half of the allowed length. Never adds words, never
 * ends on a dangling connector or punctuation.
 */
export function fitText(text, max) {
  if (text.length <= max) return text;
  const head = text.slice(0, max + 1); // one extra character, so a cut exactly at a word end is recognised
  const floor = Math.floor(max * 0.5);
  const clean = (s) => s.replace(/[\s,;:–—-]+$/, '').replace(/\s+(and|or|but|with|for|to|of|in|on|at|the|a|an|&)$/i, '').trim();
  const lastSentence = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  if (lastSentence >= floor) return head.slice(0, lastSentence + 1).trim();
  const lastClause = Math.max(head.lastIndexOf(', '), head.lastIndexOf('; '), head.lastIndexOf(': '), head.lastIndexOf(' – '), head.lastIndexOf(' — '), head.lastIndexOf(' - '));
  if (lastClause >= floor) return clean(head.slice(0, lastClause));
  const lastSpace = head.lastIndexOf(' ');
  if (lastSpace >= floor) return clean(head.slice(0, lastSpace));
  return text.slice(0, max).trim();
}

class Collector {
  constructor() { this.errors = []; this.trimmed = []; }

  /** True when an over-long list may simply be cut to `max` (a format overrun, recorded); false when it is grossly over and must fail. */
  overflowOk(count, max, path) {
    if (count <= max) return true;
    if (count > max * LIST_OVERFLOW_TOLERANCE) return false;
    this.trimmed.push(path);
    return true;
  }
  fail(path, message) { if (this.errors.length < 25) this.errors.push(`${path}: ${message}`); }

  /** required, non-empty string within max, or '' when allowEmpty */
  text(v, path, max, { allowEmpty = false } = {}) {
    if (typeof v !== 'string') { this.fail(path, 'must be text'); return ''; }
    const t = v.replace(/\s+/g, ' ').trim();
    if (!t && !allowEmpty) { this.fail(path, 'must not be empty'); return ''; }
    if (t.length > max) {
      // A model that writes 130 characters where 120 are allowed has not produced a bad strategy. Throwing the whole
      // answer away costs a second full model call (~2 minutes), so a near miss is fitted to the limit (see fitText);
      // text that is far over the limit is still an error (the model ignored the brief) and triggers the repair pass.
      if (t.length > max * FIT_TOLERANCE) { this.fail(path, `must be ${max} characters or fewer`); return t.slice(0, max); }
      const fitted = fitText(t, max);
      if (BAD_CHARS.test(fitted)) { this.fail(path, 'contains control characters'); return ''; }
      return fitted;
    }
    if (BAD_CHARS.test(t)) { this.fail(path, 'contains control characters'); return ''; }
    return t;
  }

  list(v, path, { max, length, min = 0 }) {
    if (!Array.isArray(v)) { this.fail(path, 'must be a list'); return []; }
    if (!this.overflowOk(v.length, max, path)) this.fail(path, `can have at most ${max} entries`);
    const seen = new Set();
    const out = [];
    v.slice(0, max).forEach((entry, i) => {
      const t = this.text(entry, `${path}[${i}]`, length);
      if (!t || seen.has(t.toLowerCase())) return;
      seen.add(t.toLowerCase());
      out.push(t);
    });
    if (out.length < min) this.fail(path, `needs at least ${min} entr${min === 1 ? 'y' : 'ies'}`);
    return out;
  }

  oneOf(v, path, allowed) {
    if (!allowed.includes(v)) { this.fail(path, `must be one of ${allowed.join(', ')}`); return allowed[0]; }
    return v;
  }

  /** finite integer in [min, max] — rejects NaN, Infinity, negatives, fractions, strings */
  int(value, path, min, max) {
    // a harmless FORMAT slip is fixed deterministically: the plain numeric string "25" is 25. "25%", "3 posts/week", "" and anything else is not a number.
    const v = typeof value === 'string' && /^\s*-?\d{1,6}(\.\d+)?\s*$/.test(value) ? Number(value) : value;
    if (typeof v !== 'number' || !Number.isFinite(v)) { this.fail(path, 'must be a number'); return min; }
    const n = Math.round(v);
    if (n < min || n > max) { this.fail(path, `must be between ${min} and ${max}`); return Math.min(max, Math.max(min, n)); }
    return n;
  }

  bool(v, path) {
    if (typeof v !== 'boolean') { this.fail(path, 'must be true or false'); return false; }
    return v;
  }

  obj(v, path) {
    if (!isObj(v)) { this.fail(path, 'must be an object'); return {}; }
    return v;
  }
}

/** Makes `items[].key` total exactly 100: within tolerance the largest item absorbs the difference; beyond it, an error. */
function normalizeToHundred(items, key, path, c) {
  if (!items.length) return;
  const total = items.reduce((s, i) => s + i[key], 0);
  if (total === 100) return;
  if (Math.abs(total - 100) > PERCENT_SUM_TOLERANCE) { c.fail(path, `percentages must add up to 100 (got ${total})`); return; }
  const largest = items.reduce((m, i) => (i[key] > m[key] ? i : m), items[0]);
  largest[key] += 100 - total;
  if (largest[key] < 0 || largest[key] > 100) c.fail(path, 'percentages could not be balanced to 100');
}

/** Like collectStrings, but keeps where each string is: [{ path, text }]. */
function collectLocated(value, out, skipPaths, path = '') {
  if (typeof value === 'string') { out.push({ path: path || 'strategy', text: value }); return; }
  if (Array.isArray(value)) { value.forEach((x, i) => collectLocated(x, out, skipPaths, `${path}[${i}]`)); return; }
  if (isObj(value)) {
    for (const [k, x] of Object.entries(value)) {
      const p = path ? `${path}.${k}` : k;
      if (!skipPaths.includes(p)) collectLocated(x, out, skipPaths, p);
    }
  }
}

function collectStrings(value, out, skipPaths, path = '') {
  if (typeof value === 'string') { out.push(value); return; }
  if (Array.isArray(value)) { value.forEach((v, i) => collectStrings(v, out, skipPaths, `${path}[${i}]`)); return; }
  if (isObj(value)) {
    for (const [k, v] of Object.entries(value)) {
      const p = path ? `${path}.${k}` : k;
      if (!skipPaths.includes(p)) collectStrings(v, out, skipPaths, p);
    }
  }
}

/**
 * @param {unknown} raw  the model's tool input
 * @param {object} [context]
 * @param {string[]} [context.prohibitedPhrases]
 * @param {string[]} [context.suppliedCompetitors]  names the business supplied; the analysis may name no one else
 * @param {string} [context.allowedFactsText]  every string the business supplied; numbers / links in the new analytic sections must come from it
 * @param {string[]} [context.expectedPlatforms]  when the person chose platforms, the strategy must cover exactly those
 * @returns {{ ok: true, strategy: object, gaps: object[] } | { ok: false, errors: string[] }}
 */
export function validateStrategyOutput(raw, { prohibitedPhrases = [], suppliedCompetitors = null, allowedFactsText, expectedPlatforms = null } = {}) {
  const c = new Collector();
  const L = LIMITS;
  if (!isObj(raw)) return { ok: false, errors: ['The strategy must be an object.'] };

  const strategy = { schemaVersion: STRATEGY_SCHEMA_VERSION };
  strategy.summary = c.text(raw.summary, 'summary', L.summary);

  const ov = c.obj(raw.overview, 'overview');
  strategy.overview = {
    primaryObjective: c.text(ov.primaryObjective, 'overview.primaryObjective', L.overview.objective),
    strongestOpportunity: c.text(ov.strongestOpportunity, 'overview.strongestOpportunity', L.overview.opportunity),
    growthOpportunity: c.text(ov.growthOpportunity, 'overview.growthOpportunity', L.overview.opportunity),
    platformFocus: c.text(ov.platformFocus, 'overview.platformFocus', L.overview.platformFocus),
  };

  const ba = c.obj(raw.brandAnalysis, 'brandAnalysis');
  const baList = (key) => c.list(ba[key], `brandAnalysis.${key}`, { max: L.brandAnalysis.itemsMax, length: L.brandAnalysis.item });
  strategy.brandAnalysis = {
    strengths: baList('strengths'),
    weaknesses: baList('weaknesses'),
    differentiators: baList('differentiators'),
    personality: c.list(ba.personality, 'brandAnalysis.personality', { max: L.brandAnalysis.personalityMax, length: L.brandAnalysis.personality }),
    communicationStyle: c.text(ba.communicationStyle, 'brandAnalysis.communicationStyle', L.brandAnalysis.style),
    opportunities: baList('opportunities'),
    risks: baList('risks'),
  };

  const pos = c.obj(raw.positioning, 'positioning');
  strategy.positioning = {
    brandPositioning: c.text(pos.brandPositioning, 'positioning.brandPositioning', L.positioning.brandPositioning),
    valueProposition: c.text(pos.valueProposition, 'positioning.valueProposition', L.positioning.valueProposition),
    keyDifferentiators: c.list(pos.keyDifferentiators, 'positioning.keyDifferentiators', { max: L.positioning.differentiatorsMax, length: L.positioning.differentiator }),
    whyCustomersChoose: c.text(pos.whyCustomersChoose, 'positioning.whyCustomersChoose', L.positioning.whyChoose),
    messagingAngle: c.text(pos.messagingAngle, 'positioning.messagingAngle', L.positioning.messagingAngle),
  };

  const aud = c.obj(raw.audience, 'audience');
  const audList = (key) => c.list(aud[key], `audience.${key}`, { max: L.audience.itemsMax, length: L.audience.item });
  strategy.audience = {
    // may be empty: when no audience was supplied the model must say so (and the server adds a gap) rather than invent one
    primaryAudience: c.text(aud.primaryAudience, 'audience.primaryAudience', L.audience.primary, { allowEmpty: true }),
    secondaryAudiences: c.list(aud.secondaryAudiences, 'audience.secondaryAudiences', { max: L.audience.secondaryMax, length: L.audience.secondary }),
    painPoints: c.list(aud.painPoints, 'audience.painPoints', { max: L.audience.painPointsMax, length: L.audience.painPoint }),
    needs: audList('needs'),
    motivations: c.list(aud.motivations, 'audience.motivations', { max: L.audience.motivationsMax, length: L.audience.motivation }),
    buyingTriggers: audList('buyingTriggers'),
    objections: audList('objections'),
    interests: c.list(aud.interests, 'audience.interests', { max: L.audience.interestsMax, length: L.audience.interest }),
  };

  if (!Array.isArray(raw.goals)) c.fail('goals', 'must be a list');
  strategy.goals = (Array.isArray(raw.goals) ? raw.goals.slice(0, L.goals.max) : []).map((g, i) => {
    const o = c.obj(g, `goals[${i}]`);
    return { goal: c.text(o.goal, `goals[${i}].goal`, L.goals.goal), priority: c.oneOf(o.priority, `goals[${i}].priority`, PRIORITIES), rationale: c.text(o.rationale, `goals[${i}].rationale`, L.goals.rationale) };
  });
  if (Array.isArray(raw.goals) && !c.overflowOk(raw.goals.length, L.goals.max, 'goals')) c.fail('goals', `can have at most ${L.goals.max} entries`);

  if (!Array.isArray(raw.contentPillars) || raw.contentPillars.length < L.pillars.min || raw.contentPillars.length > L.pillars.max) {
    c.fail('contentPillars', `needs ${L.pillars.min}-${L.pillars.max} pillars`);
  }
  strategy.contentPillars = (Array.isArray(raw.contentPillars) ? raw.contentPillars.slice(0, L.pillars.max) : []).map((p, i) => {
    const o = c.obj(p, `contentPillars[${i}]`);
    return {
      name: c.text(o.name, `contentPillars[${i}].name`, L.pillars.name),
      description: c.text(o.description, `contentPillars[${i}].description`, L.pillars.description),
      purpose: c.text(o.purpose, `contentPillars[${i}].purpose`, L.pillars.purpose),
      suggestedPercentage: c.int(o.suggestedPercentage, `contentPillars[${i}].suggestedPercentage`, 0, 100),
      exampleTopics: c.list(o.exampleTopics, `contentPillars[${i}].exampleTopics`, { max: L.pillars.topicsMax, length: L.pillars.topic, min: L.pillars.topicsMin }),
      formats: c.list(o.formats, `contentPillars[${i}].formats`, { max: L.pillars.formatsMax, length: L.pillars.format, min: L.pillars.formatsMin }),
    };
  });
  // a pillar name is what a calendar item and a generated post refer to, so two pillars may not share one
  const pillarNames = new Set();
  strategy.contentPillars.forEach((p, i) => {
    const key = p.name.toLowerCase();
    if (pillarNames.has(key)) c.fail(`contentPillars[${i}].name`, `"${p.name}" appears more than once`);
    pillarNames.add(key);
  });
  normalizeToHundred(strategy.contentPillars, 'suggestedPercentage', 'contentPillars', c);

  if (!Array.isArray(raw.contentMix) || raw.contentMix.length < L.mix.min || raw.contentMix.length > L.mix.max) {
    c.fail('contentMix', `needs ${L.mix.min}-${L.mix.max} entries`);
  }
  const mixTypes = new Set();
  strategy.contentMix = (Array.isArray(raw.contentMix) ? raw.contentMix.slice(0, L.mix.max) : []).map((m, i) => {
    const o = c.obj(m, `contentMix[${i}]`);
    const type = c.oneOf(o.type, `contentMix[${i}].type`, CONTENT_MIX_TYPES);
    if (mixTypes.has(type)) c.fail(`contentMix[${i}].type`, `"${type}" appears more than once`);
    mixTypes.add(type);
    return { type, percentage: c.int(o.percentage, `contentMix[${i}].percentage`, 0, 100), rationale: c.text(o.rationale, `contentMix[${i}].rationale`, L.mix.rationale) };
  });
  normalizeToHundred(strategy.contentMix, 'percentage', 'contentMix', c);

  // trending / current topics: recommendations, never trend claims
  if (!Array.isArray(raw.trendingTopics)) c.fail('trendingTopics', 'must be a list');
  else if (!c.overflowOk(raw.trendingTopics.length, L.trending.max, 'trendingTopics')) c.fail('trendingTopics', `can have at most ${L.trending.max} entries`);
  strategy.trendingTopics = (Array.isArray(raw.trendingTopics) ? raw.trendingTopics.slice(0, L.trending.max) : []).map((t, i) => {
    const o = c.obj(t, `trendingTopics[${i}]`);
    const item = {
      topic: c.text(o.topic, `trendingTopics[${i}].topic`, L.trending.topic),
      whyItMatters: c.text(o.whyItMatters, `trendingTopics[${i}].whyItMatters`, L.trending.why),
      relevance: c.oneOf(o.relevance, `trendingTopics[${i}].relevance`, PRIORITIES),
      angle: c.text(o.angle, `trendingTopics[${i}].angle`, L.trending.angle),
      freshness: c.oneOf(o.freshness, `trendingTopics[${i}].freshness`, TOPIC_FRESHNESS),
    };
    if (TREND_CLAIM_RE.test(`${item.topic} ${item.whyItMatters} ${item.angle}`)) c.fail(`trendingTopics[${i}]`, 'must not claim a topic is trending or viral (there is no live trend data)');
    return item;
  });

  // working hooks: business-specific, de-duplicated
  if (!Array.isArray(raw.workingHooks) || raw.workingHooks.length < L.hooks.min || !c.overflowOk(raw.workingHooks.length, L.hooks.max, 'workingHooks')) c.fail('workingHooks', `needs ${L.hooks.min}-${L.hooks.max} hooks`);
  const seenHooks = new Set();
  strategy.workingHooks = (Array.isArray(raw.workingHooks) ? raw.workingHooks.slice(0, L.hooks.max) : []).map((h, i) => {
    const o = c.obj(h, `workingHooks[${i}]`);
    return { hook: c.text(o.hook, `workingHooks[${i}].hook`, L.hooks.hook), category: hookCategory(o.category, c, `workingHooks[${i}].category`) };
  }).filter((h) => {
    const key = h.hook.toLowerCase();
    if (!h.hook || seenHooks.has(key)) return false;
    seenHooks.add(key);
    return true;
  });
  if (strategy.workingHooks.length < L.hooks.min && !c.errors.some((e) => e.startsWith('workingHooks'))) c.fail('workingHooks', `needs at least ${L.hooks.min} different hooks`);

  // competitor analysis: only the competitors the business supplied
  const comp = c.obj(raw.competitorAnalysis, 'competitorAnalysis');
  const compList = (key) => c.list(comp[key], `competitorAnalysis.${key}`, { max: L.competitor.itemsMax, length: L.competitor.item });
  strategy.competitorAnalysis = {
    competitorsConsidered: c.list(comp.competitorsConsidered, 'competitorAnalysis.competitorsConsidered', { max: L.competitor.namesMax, length: L.competitor.name }),
    differentiationOpportunities: compList('differentiationOpportunities'),
    contentGaps: compList('contentGaps'),
    recommendations: compList('recommendations'),
  };
  if (Array.isArray(suppliedCompetitors)) {
    const allowed = new Set(suppliedCompetitors.map((n) => String(n).trim().toLowerCase()).filter(Boolean));
    strategy.competitorAnalysis.competitorsConsidered.forEach((name, i) => {
      if (!allowed.has(name.toLowerCase())) c.fail(`competitorAnalysis.competitorsConsidered[${i}]`, `"${name}" was not supplied by the business — do not name competitors that were not supplied`);
    });
  }

  if (!Array.isArray(raw.platformStrategy) || raw.platformStrategy.length < 1 || raw.platformStrategy.length > PLATFORMS.length) c.fail('platformStrategy', 'needs 1-2 platforms');
  const seenPlatforms = new Set();
  strategy.platformStrategy = (Array.isArray(raw.platformStrategy) ? raw.platformStrategy.slice(0, PLATFORMS.length) : []).map((p, i) => {
    const o = c.obj(p, `platformStrategy[${i}]`);
    const platform = c.oneOf(o.platform, `platformStrategy[${i}].platform`, PLATFORMS);
    if (seenPlatforms.has(platform)) c.fail(`platformStrategy[${i}].platform`, `"${platform}" appears more than once`);
    seenPlatforms.add(platform);
    return {
      platform,
      role: c.text(o.role, `platformStrategy[${i}].role`, L.platform.role),
      contentTypes: c.list(o.contentTypes, `platformStrategy[${i}].contentTypes`, { max: L.platform.contentTypesMax, length: L.platform.contentType, min: L.platform.contentTypesMin }),
      postsPerWeek: c.int(o.postsPerWeek, `platformStrategy[${i}].postsPerWeek`, 0, L.platform.postsPerWeekMax),
      audienceBehavior: c.text(o.audienceBehavior, `platformStrategy[${i}].audienceBehavior`, L.platform.behavior, { allowEmpty: true }),
      guidance: c.list(o.guidance, `platformStrategy[${i}].guidance`, { max: L.platform.guidelinesMax, length: L.platform.guideline }),
    };
  });

  if (Array.isArray(expectedPlatforms) && expectedPlatforms.length) {
    const covered = [...seenPlatforms].sort().join(', ');
    const wanted = [...expectedPlatforms].sort().join(', ');
    if (covered !== wanted) c.fail('platformStrategy', `must cover exactly the platforms the business chose (${wanted}), not (${covered || 'none'})`);
  }

  const tone = c.obj(raw.toneAndVoice, 'toneAndVoice');
  strategy.toneAndVoice = {
    primaryTone: c.text(tone.primaryTone, 'toneAndVoice.primaryTone', L.tone.primary),
    secondaryTones: c.list(tone.secondaryTones, 'toneAndVoice.secondaryTones', { max: L.tone.secondaryMax, length: L.tone.secondary }),
    writingGuidelines: c.list(tone.writingGuidelines, 'toneAndVoice.writingGuidelines', { max: L.tone.guidelinesMax, length: L.tone.guideline, min: L.tone.guidelinesMin }),
    avoid: c.list(tone.avoid, 'toneAndVoice.avoid', { max: L.tone.avoidMax, length: L.tone.avoid }),
  };

  const posting = c.obj(raw.postingStrategy, 'postingStrategy');
  const days = Array.isArray(posting.recommendedDays) ? posting.recommendedDays : (c.fail('postingStrategy.recommendedDays', 'must be a list'), []);
  const range = c.obj(posting.postsPerWeekRange, 'postingStrategy.postsPerWeekRange');
  let rangeMin = Math.min(L.posting.rangeMax, c.int(range.min, 'postingStrategy.postsPerWeekRange.min', 1, L.posting.postsPerWeekMax));
  let rangeMax = Math.min(L.posting.rangeMax, c.int(range.max, 'postingStrategy.postsPerWeekRange.max', 1, L.posting.postsPerWeekMax));
  if (rangeMin > rangeMax) [rangeMin, rangeMax] = [rangeMax, rangeMin];
  strategy.postingStrategy = {
    // a recommendation: the user chooses the real frequency when creating the calendar
    postsPerWeek: c.int(posting.postsPerWeek, 'postingStrategy.postsPerWeek', 0, L.posting.postsPerWeekMax),
    postsPerWeekRange: { min: rangeMin, max: rangeMax },
    recommendedDays: [...new Set(days.map((d, i) => c.oneOf(d, `postingStrategy.recommendedDays[${i}]`, WEEKDAYS)))].slice(0, 7),
    recommendedTimeWindows: c.list(posting.recommendedTimeWindows, 'postingStrategy.recommendedTimeWindows', { max: L.posting.windowsMax, length: L.posting.window }),
  };

  const hash = c.obj(raw.hashtagStrategy, 'hashtagStrategy');
  strategy.hashtagStrategy = {
    enabled: c.bool(hash.enabled, 'hashtagStrategy.enabled'),
    approach: c.text(hash.approach, 'hashtagStrategy.approach', L.hashtags.approach, { allowEmpty: true }),
    recommendedCount: c.int(hash.recommendedCount, 'hashtagStrategy.recommendedCount', 0, L.hashtags.countMax),
    categories: c.list(hash.categories, 'hashtagStrategy.categories', { max: L.hashtags.categoriesMax, length: L.hashtags.category }),
  };

  const cta = c.obj(raw.ctaStrategy, 'ctaStrategy');
  if (!Array.isArray(cta.byObjective)) c.fail('ctaStrategy.byObjective', 'must be a list');
  const ctaObjectives = new Set();
  strategy.ctaStrategy = {
    preferredCTAs: c.list(cta.preferredCTAs, 'ctaStrategy.preferredCTAs', { max: L.cta.preferredMax, length: L.cta.preferred, min: L.cta.preferredMin }),
    objectives: c.list(cta.objectives, 'ctaStrategy.objectives', { max: L.cta.objectivesMax, length: L.cta.objective }),
    byObjective: (Array.isArray(cta.byObjective) ? cta.byObjective.slice(0, L.cta.byObjectiveMax) : []).map((e, i) => {
      const o = c.obj(e, `ctaStrategy.byObjective[${i}]`);
      const objective = c.oneOf(o.objective, `ctaStrategy.byObjective[${i}].objective`, MARKETING_OBJECTIVES);
      if (ctaObjectives.has(objective)) c.fail(`ctaStrategy.byObjective[${i}].objective`, `"${objective}" appears more than once`);
      ctaObjectives.add(objective);
      return { objective, ctas: c.list(o.ctas, `ctaStrategy.byObjective[${i}].ctas`, { max: L.cta.ctasMax, length: L.cta.preferred, min: L.cta.ctasMin }) };
    }),
  };

  const brand = c.obj(raw.brandRules, 'brandRules');
  strategy.brandRules = {
    visualGuidelines: c.list(brand.visualGuidelines, 'brandRules.visualGuidelines', { max: L.brand.guidelinesMax, length: L.brand.guideline }),
    messagingRules: c.list(brand.messagingRules, 'brandRules.messagingRules', { max: L.brand.rulesMax, length: L.brand.rule }),
  };

  const outlook = c.obj(raw.planOutlook, 'planOutlook');
  const outlookList = (key, max, map) => (Array.isArray(outlook[key]) ? outlook[key].slice(0, max).map((e, i) => map(c.obj(e, `planOutlook.${key}[${i}]`), i)) : []);
  strategy.planOutlook = {
    seasonalThemes: outlookList('seasonalThemes', L.outlook.themesMax, (o, i) => ({ theme: c.text(o.theme, `planOutlook.seasonalThemes[${i}].theme`, L.outlook.theme), timing: c.text(o.timing, `planOutlook.seasonalThemes[${i}].timing`, L.outlook.timing, { allowEmpty: true }), idea: c.text(o.idea, `planOutlook.seasonalThemes[${i}].idea`, L.outlook.idea) })),
    campaignIdeas: outlookList('campaignIdeas', L.outlook.campaignsMax, (o, i) => ({ name: c.text(o.name, `planOutlook.campaignIdeas[${i}].name`, L.outlook.campaign), idea: c.text(o.idea, `planOutlook.campaignIdeas[${i}].idea`, L.outlook.idea) })),
    successMetrics: outlookList('successMetrics', L.outlook.metricsMax, (o, i) => ({ metric: c.text(o.metric, `planOutlook.successMetrics[${i}].metric`, L.outlook.metric), whatGoodLooks: c.text(o.whatGoodLooks, `planOutlook.successMetrics[${i}].whatGoodLooks`, L.outlook.success) })),
  };

  strategy.recommendations = c.list(raw.recommendations, 'recommendations', { max: L.recommendations.max, length: L.recommendations.length });
  strategy.assumptions = c.list(raw.assumptions, 'assumptions', { max: L.assumptions.max, length: L.assumptions.length });

  if (!Array.isArray(raw.gaps)) c.fail('gaps', 'must be a list');
  const gaps = (Array.isArray(raw.gaps) ? raw.gaps.slice(0, L.gaps.max) : []).map((g, i) => {
    const o = c.obj(g, `gaps[${i}]`);
    return { field: c.text(o.field, `gaps[${i}].field`, L.gaps.field), reason: c.text(o.reason, `gaps[${i}].reason`, L.gaps.reason), importance: c.oneOf(o.importance, `gaps[${i}].importance`, PRIORITIES), source: 'ai' };
  });

  // The strategy must not use a phrase the business asked never to use. (Listing it under "avoid" is the one allowed mention.)
  const banned = (prohibitedPhrases || []).map((p) => String(p).trim().toLowerCase()).filter(Boolean);
  if (banned.length) {
    const located = [];
    collectLocated(strategy, located, ['toneAndVoice.avoid']);
    for (const { path, text } of located) {
      const hit = banned.find((p) => text.toLowerCase().includes(p));
      if (!hit) continue;
      // a messaging rule such as "Never promise guaranteed results" NAMES the phrase in order to forbid it; only a rule that USES it is a violation
      if (path.startsWith('brandRules.messagingRules[') && PROHIBITION_RE.test(text)) continue;
      c.fail(path, `uses the prohibited phrase "${hit}"`);
      break;
    }
  }

  // The analytic sections must not invent statistics, prices, links or contact details: any such figure has to be one the business supplied.
  if (allowedFactsText !== undefined) {
    const analytic = [];
    collectStrings({ t: strategy.trendingTopics, h: strategy.workingHooks, c: strategy.competitorAnalysis, b: strategy.brandAnalysis, o: strategy.planOutlook }, analytic, []);
    const extra = unsupportedFigures(analytic.join(' \n '), allowedFactsText);
    if (extra.length) c.fail('strategy', `states figures or addresses that were not in the supplied business information: ${extra.slice(0, 4).join(', ')}`);
  }

  if (c.errors.length) return { ok: false, errors: c.errors };
  return { ok: true, strategy, gaps, trimmed: c.trimmed };
}

export default { STRATEGY_TOOL_NAME, STRATEGY_SCHEMA_VERSION, buildStrategyToolSchema, validateStrategyOutput, LIMITS, PLATFORMS, CONTENT_MIX_TYPES, PRIORITIES, WEEKDAYS, MARKETING_OBJECTIVES, KPIS_BY_OBJECTIVE, HOOK_CATEGORIES, TOPIC_FRESHNESS };
