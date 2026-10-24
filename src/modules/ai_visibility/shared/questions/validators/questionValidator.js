import { looksLikeInstruction, containsUrlLike, normalizeKey } from '../../utils/text.js';
import { normalizeForMatching, findMentions } from '../../services/brandMatchingService.js';
import { findUngroundedProperNouns } from '../../prompts/validators/promptValidator.js';
import { INTENT_NAMES, GROUPS, BRAND_INTENT, PRIORITIES, QUESTION_LIMITS } from '../config/questionConfig.js';
import { TEMPLATE_IDS } from '../templates/questionBank.js';

/**
 * Question validation: the gate between "text a template, a model or a user produced" and "a paid request is sent".
 * Pure. Issues are stable codes (never the offending text), so a repair message or a log cannot echo untrusted content.
 *
 * What is proven mechanically: no tracked brand / competitor / URL in unbranded questions, service and location come from
 * the confirmed inputs, no capitalised word that no input supplied, no unconfirmed capability or claim word. What is not
 * provable (a lower-case phrase that merely sounds like a capability) is why the generator stays template-anchored and a
 * failed model result falls back to deterministic templates instead of "fixing" text.
 */

const CLAIM_WORDS = /\b(award(?:s|ed|-winning)?|certified|certification|accredited|accreditation|ranked|ranking|top[- ]rated|number\s*(?:one|1)|no\.?\s*1|#\s*1|best[- ]in[- ]class|iso\s*\d+|guarantee[ds]?)\b/gi;
// Capabilities the business must CONFIRM before a question may assume them.
const CAPABILITY_WORDS = /\b(affordable|cheap(?:est)?|low[- ]cost|budget|free|24\s*[/x]\s*7|round[- ]the[- ]clock|emergency|same[- ]day|instant|premium|luxury)\b/gi;

const brandNames = (profile) => [profile.business.name, ...(profile.business.aliases || [])].filter(Boolean);

function inputText(inputs) {
  return normalizeForMatching([
    ...inputs.categories, ...inputs.services, ...inputs.cities, ...inputs.areas, ...inputs.requirements,
    ...inputs.problems, ...inputs.customerTypes, ...inputs.buyingRequirements,
  ].join(' '));
}

/** A pseudo-profile whose "allowed words" are exactly what the confirmed inputs supply (no brand, no competitors). */
function groundingProfile(profile, inputs, { allowBrand }) {
  return {
    business: {
      name: allowBrand ? profile.business.name : null,
      aliases: allowBrand ? (profile.business.aliases || []) : [],
      industry: inputs.categories[0] || null,
      services: [...inputs.services, ...inputs.requirements, ...inputs.problems, ...inputs.customerTypes, ...inputs.buyingRequirements, ...inputs.areas, ...inputs.categories],
      competitors: [],
    },
    market: { city: inputs.cities.join(' '), state: profile.market.state, country: profile.market.country, countryCode: profile.market.countryCode },
  };
}

const inList = (value, list) => list.some((v) => normalizeKey(v) === normalizeKey(value));

/**
 * @param {object} q        a question
 * @param {{profile:object, inputs:object, userEdited?:boolean}} ctx
 * @returns {string[]} issue codes (empty = valid)
 */
export function validateQuestion(q, { profile, inputs, userEdited = false }) {
  const issues = [];
  if (!q || typeof q !== 'object') return ['NOT_AN_OBJECT'];
  const text = typeof q.text === 'string' ? q.text.trim() : '';
  if (!text) return ['EMPTY_QUESTION'];

  if (text.length < QUESTION_LIMITS.minLength) issues.push('QUESTION_TOO_SHORT');
  if (text.length > QUESTION_LIMITS.maxLength) issues.push('QUESTION_TOO_LONG');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F-\u009F]/.test(text)) issues.push('CONTROL_CHARACTERS');
  if (looksLikeInstruction(text)) issues.push('INSTRUCTION_LIKE_CONTENT');

  const isBrandGroup = q.group === GROUPS.BRAND_REPUTATION;
  if (!Object.values(GROUPS).includes(q.group)) issues.push('UNKNOWN_GROUP');
  if (isBrandGroup !== (q.intent === BRAND_INTENT)) issues.push('GROUP_INTENT_MISMATCH');
  if (!isBrandGroup && !INTENT_NAMES.includes(q.intent)) issues.push('UNKNOWN_INTENT');
  if (q.priority !== undefined && !PRIORITIES.includes(q.priority)) issues.push('INVALID_PRIORITY');
  if (!userEdited && q.templateId !== undefined && q.templateId !== null && !TEMPLATE_IDS.has(q.templateId)) issues.push('UNKNOWN_TEMPLATE');

  // URLs never belong in a question. A brand's own name may look like a domain, so strip it first for the brand group.
  let urlCheckText = text;
  if (isBrandGroup) for (const n of brandNames(profile)) urlCheckText = urlCheckText.replace(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' ');
  if (containsUrlLike(urlCheckText)) issues.push('UNSUPPORTED_URL');

  const brandHits = findMentions(text, brandNames(profile)).length;
  if (isBrandGroup) {
    if (profile.business.name && brandHits === 0) issues.push('MISSING_BRAND_NAME');
  } else {
    if (brandHits > 0) issues.push('BRAND_IN_VISIBILITY_QUESTION');
    if (profile.business.competitors.some((c) => findMentions(text, [c]).length > 0)) issues.push('COMPETITOR_IN_VISIBILITY_QUESTION');
    if (profile.website?.targetHost && normalizeForMatching(text).includes(normalizeForMatching(profile.website.targetHost.replace(/^www\./, '')))) issues.push('DOMAIN_IN_VISIBILITY_QUESTION');
  }

  if (!userEdited) {
    if (q.service && !inList(q.service, inputs.services)) issues.push('SERVICE_NOT_CONFIRMED');
    if (q.location && !inList(q.location, [...inputs.cities, ...inputs.areas])) issues.push('LOCATION_NOT_CONFIRMED');
    if (findUngroundedProperNouns(text, groundingProfile(profile, inputs, { allowBrand: isBrandGroup })).length > 0) issues.push('UNGROUNDED_PROPER_NOUN');
    const confirmed = inputText(inputs);
    for (const m of text.match(CLAIM_WORDS) || []) if (!confirmed.includes(normalizeForMatching(m))) { issues.push('UNSUPPORTED_CLAIM'); break; }
    for (const m of text.match(CAPABILITY_WORDS) || []) if (!confirmed.includes(normalizeForMatching(m))) { issues.push('UNCONFIRMED_CAPABILITY'); break; }
  }
  return issues;
}

/**
 * Whole-set rules: bounded size, unique text and ids, bounded brand group. Per-question issues are reported by index so a
 * caller can drop just the bad ones.
 * @returns {{valid:boolean, issues:{code:string, index?:number}[]}}
 */
export function validateQuestionSet(questions, ctx) {
  const issues = [];
  if (!Array.isArray(questions)) return { valid: false, issues: [{ code: 'QUESTIONS_NOT_AN_ARRAY' }] };
  if (questions.length === 0) issues.push({ code: 'NO_QUESTIONS' });
  if (questions.length > QUESTION_LIMITS.maxQuestions + QUESTION_LIMITS.maxBrandQuestions) issues.push({ code: 'TOO_MANY_QUESTIONS' });
  const seenText = new Set();
  const seenId = new Set();
  let brand = 0;
  questions.forEach((q, index) => {
    for (const code of validateQuestion(q, ctx)) issues.push({ code, index });
    if (q?.group === GROUPS.BRAND_REPUTATION) brand += 1;
    const t = normalizeForMatching(q?.text || '');
    if (t && seenText.has(t)) issues.push({ code: 'DUPLICATE_QUESTION', index });
    seenText.add(t);
    if (q?.id && seenId.has(q.id)) issues.push({ code: 'DUPLICATE_ID', index });
    if (q?.id) seenId.add(q.id);
  });
  if (brand > QUESTION_LIMITS.maxBrandQuestions) issues.push({ code: 'TOO_MANY_BRAND_QUESTIONS' });
  return { valid: issues.length === 0, issues };
}

export default { validateQuestion, validateQuestionSet };
