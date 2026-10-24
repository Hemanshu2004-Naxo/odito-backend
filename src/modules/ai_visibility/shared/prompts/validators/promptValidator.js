import { VisibilityError, VISIBILITY_ERROR } from '../../errors/visibilityErrors.js';
import { containsUrlLike, looksLikeInstruction } from '../../utils/text.js';
import { normalizeForMatching, countMentions, findMentions } from '../../services/brandMatchingService.js';
import { PROMPT_CATEGORIES, CATEGORY_BRANDED, GENERATED_BY, PROMPT_LIMITS, GENERATOR_VERSION } from '../config/promptConfig.js';

/**
 * Prompt-set validation: the gate between "text a template or a model produced" and "a paid request is sent".
 * Pure; no I/O. Returns every problem found as a stable issue code (never the offending text), so a repair request
 * and the logs can name the problem without echoing untrusted content.
 *
 * What it can and cannot prove about "no invented facts": proper nouns (capitalised words that are not the first
 * word of a sentence) must all come from the profile; claim words (awards, certifications, rankings, guarantees)
 * must come from the profile; service and competitor names may only appear when they are profile values, and the
 * prompt's flags must be true. A lower-case descriptive phrase that merely sounds like a service cannot be detected
 * mechanically - that residual risk is why the generator is constrained to the template structure and why a failed
 * validation falls back to deterministic templates instead of "fixing" text.
 */

const CLAIM_WORDS = /\b(award(?:s|ed|-winning)?|certified|certification|accredited|accreditation|ranked|ranking|top[- ]rated|number\s*(?:one|1)|no\.?\s*1|#\s*1|best[- ]in[- ]class|iso\s*\d+|guarantee[ds]?)\b/gi;
const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’&.-]*/gu;
const UPPER_FIRST = /^\p{Lu}/u;

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function brandNames(profile) {
  return [profile.business.name, ...(profile.business.aliases || [])].filter(Boolean);
}

/** Every normalised token the profile supplies - the only capitalised words a prompt may carry besides sentence starts. */
function allowedTokens(profile) {
  const parts = [
    profile.business.name, ...(profile.business.aliases || []), profile.business.industry, ...profile.business.services,
    ...profile.business.competitors, profile.market.city, profile.market.state, profile.market.country, profile.market.countryCode,
  ].filter(Boolean);
  return new Set(normalizeForMatching(parts.join(' ')).split(' ').filter(Boolean));
}

function factsText(profile) {
  return normalizeForMatching([
    profile.business.name, profile.business.industry, ...profile.business.services, ...profile.business.competitors,
  ].filter(Boolean).join(' '));
}

/** Capitalised words that are not sentence-initial and are not supplied by the profile. */
export function findUngroundedProperNouns(text, profile) {
  const allowed = allowedTokens(profile);
  const out = [];
  for (const sentence of String(text).split(/(?<=[.?!])\s+/)) {
    const words = sentence.match(WORD) || [];
    words.forEach((w, i) => {
      if (i === 0) return;
      const bare = w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
      if (bare.length < 2 || !UPPER_FIRST.test(bare)) return;
      for (const token of normalizeForMatching(bare).split(' ')) {
        if (token && !allowed.has(token)) out.push(bare);
      }
    });
  }
  return out;
}

/** Remove the (sanitised) business and competitor names so a name that looks like a domain does not trip the URL check. */
function stripKnownNames(text, profile) {
  let t = text;
  for (const n of [...brandNames(profile), ...profile.business.competitors]) {
    t = t.replace(new RegExp(escapeRegExp(n), 'gi'), ' ');
  }
  return t;
}

/** Derive the three flags from the prompt text itself - the single source of truth for what a prompt actually contains. */
export function describePrompt(text, profile) {
  const branded = findMentions(text, brandNames(profile)).length > 0;
  const usesService = profile.business.services.some((s) => countMentions(text, s) > 0);
  const usesCompetitors = profile.business.competitors.some((c) => countMentions(text, c) > 0);
  return { branded, usesService, usesCompetitors };
}

/**
 * @param {object} set      { generatorVersion, profileHash, generatedBy, model, prompts[], tokenUsage }
 * @param {object} profile  normalized business profile (businessProfileService)
 * @returns {{valid:boolean, issues:{code:string, category?:string}[]}}
 */
export function validatePromptSet(set, profile) {
  const issues = [];
  const add = (code, category) => issues.push(category ? { code, category } : { code });

  if (!set || typeof set !== 'object') return { valid: false, issues: [{ code: 'NOT_AN_OBJECT' }] };

  // ── metadata ──
  if (set.generatorVersion !== GENERATOR_VERSION) add('GENERATOR_VERSION_MISMATCH');
  if (set.profileHash !== profile.profileHash) add('PROFILE_HASH_MISMATCH');
  if (!Object.values(GENERATED_BY).includes(set.generatedBy)) add('INVALID_GENERATED_BY');
  if (set.generatedBy === GENERATED_BY.OPENAI && (typeof set.model !== 'string' || !set.model.trim())) add('MISSING_MODEL');
  if (set.tokenUsage !== undefined) {
    const t = set.tokenUsage;
    const ok = t && Number.isInteger(t.inputTokens) && t.inputTokens >= 0 && Number.isInteger(t.outputTokens) && t.outputTokens >= 0;
    if (!ok) add('INVALID_TOKEN_USAGE');
  }

  // ── structure ──
  const prompts = set.prompts;
  if (!Array.isArray(prompts)) { add('PROMPTS_NOT_AN_ARRAY'); return { valid: false, issues }; }
  if (prompts.length !== PROMPT_CATEGORIES.length) add('WRONG_PROMPT_COUNT');
  const seenCategories = new Set();
  const seenTexts = new Set();
  for (const p of prompts) {
    if (!p || typeof p !== 'object') { add('PROMPT_NOT_AN_OBJECT'); continue; }
    if (!PROMPT_CATEGORIES.includes(p.category)) { add('UNKNOWN_CATEGORY'); continue; }
    if (seenCategories.has(p.category)) add('DUPLICATE_CATEGORY', p.category);
    seenCategories.add(p.category);
    if (typeof p.text !== 'string' || !p.text.trim()) { add('EMPTY_PROMPT', p.category); continue; }
    if (['branded', 'usesService', 'usesCompetitors'].some((k) => typeof p[k] !== 'boolean')) add('INVALID_FLAGS', p.category);
    const norm = normalizeForMatching(p.text);
    if (seenTexts.has(norm)) add('DUPLICATE_PROMPT_TEXT', p.category);
    seenTexts.add(norm);
  }
  for (const c of PROMPT_CATEGORIES) if (!seenCategories.has(c)) add('MISSING_CATEGORY', c);

  // ── per-prompt content checks ──
  const facts = factsText(profile);
  const hasBrandName = Boolean(profile.business.name);
  for (const p of prompts) {
    if (!p || typeof p.text !== 'string' || !PROMPT_CATEGORIES.includes(p.category)) continue;
    const text = p.text.trim();
    const cat = p.category;
    if (text.length < PROMPT_LIMITS.minLength) add('PROMPT_TOO_SHORT', cat);
    if (text.length > PROMPT_LIMITS.maxLength) add('PROMPT_TOO_LONG', cat);
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001F\u007F-\u009F]/.test(text)) add('CONTROL_CHARACTERS', cat);
    if (looksLikeInstruction(text)) add('INSTRUCTION_LIKE_CONTENT', cat);
    if (containsUrlLike(stripKnownNames(text, profile))) add('UNSUPPORTED_URL', cat);

    if (findUngroundedProperNouns(text, profile).length > 0) add('UNGROUNDED_PROPER_NOUN', cat);
    for (const m of text.match(CLAIM_WORDS) || []) {
      if (!facts.includes(normalizeForMatching(m))) { add('UNSUPPORTED_CLAIM', cat); break; }
    }

    // Truthful flags, derived from the text.
    const actual = describePrompt(text, profile);
    if (typeof p.branded === 'boolean' && p.branded !== actual.branded) add('BRANDED_FLAG_MISMATCH', cat);
    if (typeof p.usesService === 'boolean' && p.usesService !== actual.usesService) add('SERVICE_FLAG_MISMATCH', cat);
    if (typeof p.usesCompetitors === 'boolean' && p.usesCompetitors !== actual.usesCompetitors) add('COMPETITOR_FLAG_MISMATCH', cat);

    // Branded / non-branded rules. A brand that cannot be matched reliably (too generic) cannot be policed either way.
    const expectBranded = CATEGORY_BRANDED[cat];
    if (profile.business.nameReliability?.reliable !== false) {
      if (expectBranded && hasBrandName && !actual.branded) add('MISSING_BRAND_NAME', cat);
      if (!expectBranded && actual.branded) add('BRAND_NAME_IN_NON_BRANDED_PROMPT', cat);
    } else if (expectBranded && hasBrandName && !actual.branded) {
      add('MISSING_BRAND_NAME', cat);
    }

    // Competitors only belong to the comparison; where known they must be used there.
    if (cat !== 'competitor_comparison' && actual.usesCompetitors) add('COMPETITOR_IN_WRONG_CATEGORY', cat);
    if (cat === 'competitor_comparison' && profile.business.competitors.length > 0 && !actual.usesCompetitors) add('KNOWN_COMPETITORS_NOT_USED', cat);
    // Service discovery must use a known service when one exists.
    if (cat === 'service_discovery' && profile.business.services.length > 0 && !actual.usesService) add('KNOWN_SERVICE_NOT_USED', cat);
    // Local projects: the discovery prompts must carry the city.
    if (profile.market.effectiveScope === 'local' && profile.market.city && ['industry_discovery', 'service_discovery', 'local_market_intent'].includes(cat)) {
      if (countMentions(text, profile.market.city) === 0) add('MISSING_LOCAL_CONTEXT', cat);
    }
  }

  return { valid: issues.length === 0, issues };
}

/** Throws a VisibilityError (PROMPT_SET_INVALID) carrying the issue codes when the set is invalid. */
export function assertValidPromptSet(set, profile) {
  const result = validatePromptSet(set, profile);
  if (!result.valid) {
    throw new VisibilityError(VISIBILITY_ERROR.PROMPT_SET_INVALID, 'The generated prompt set failed validation', { issues: result.issues });
  }
  return set;
}

export default { validatePromptSet, assertValidPromptSet, describePrompt, findUngroundedProperNouns };
