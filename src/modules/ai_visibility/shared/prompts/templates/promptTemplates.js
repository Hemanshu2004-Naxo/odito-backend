import { VisibilityError, VISIBILITY_ERROR } from '../../errors/visibilityErrors.js';
import { normalizeKey } from '../../utils/text.js';
import { PROMPT_CATEGORIES } from '../config/promptConfig.js';

/**
 * Deterministic prompt templates: the five required categories, built ONLY from profile fields. They are the baseline
 * the OpenAI step may reword, and the fallback when it cannot. Nothing is invented: a missing service, competitor or
 * location simply selects the generic variant of the same category.
 *
 * Templates are English. A project whose language is not English still gets these (the language is part of the profile
 * hash, and the OpenAI step is asked to write in it); `promptLanguage` in the stored set records what was applied.
 *
 * Choices that must stay stable for reproducibility: the service used is the alphabetically first active one, and at most
 * three competitors are named, in alphabetical order. Reordering the stored lists therefore changes nothing.
 */

const byKey = (a, b) => (normalizeKey(a) < normalizeKey(b) ? -1 : normalizeKey(a) > normalizeKey(b) ? 1 : 0);

export const MAX_NAMED_COMPETITORS = 3;

function joinNames(names) {
  if (names.length <= 1) return names[0] || '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The facts a template (and the OpenAI step) is allowed to use, chosen deterministically. */
export function selectTemplateFacts(profile) {
  const { business, market } = profile;
  return {
    name: business.name,
    industry: business.industry,
    service: [...business.services].sort(byKey)[0] || null,
    competitors: [...business.competitors].sort(byKey).slice(0, MAX_NAMED_COMPETITORS),
    marketLabel: market.label || null,
    city: market.effectiveScope === 'local' ? market.city : null,
    effectiveScope: market.effectiveScope,
  };
}

/**
 * @returns {{category:string,text:string}[]} exactly five, in PROMPT_CATEGORIES order
 * @throws {VisibilityError} INSUFFICIENT_PROFILE when there is neither a business name nor any industry/service to ask about
 */
export function buildTemplatePrompts(profile) {
  const f = selectTemplateFacts(profile);
  if (!f.name) throw new VisibilityError(VISIBILITY_ERROR.INSUFFICIENT_PROFILE, 'The project has no usable business name');
  if (!f.industry && !f.service) {
    throw new VisibilityError(VISIBILITY_ERROR.INSUFFICIENT_PROFILE, 'The project has neither an industry nor a service to build discovery prompts from');
  }

  const inMarket = f.marketLabel ? ` in ${f.marketLabel}` : '';
  const providers = f.industry ? `${f.industry} providers` : `providers of ${f.service}`;

  const industryDiscovery = `Which are the leading ${providers}${inMarket}? Compare the top options based on their services, specialties and reputation, and provide sources for your recommendations.`;

  const serviceDiscovery = f.service
    ? `Which businesses${inMarket} offer ${f.service}? Compare the available options, explain what each provider includes, and provide sources.`
    : `Which ${f.industry} providers${inMarket} offer the services customers most commonly look for? Explain the main services each one offers and provide sources.`;

  const brandContext = f.industry ? ` in the ${f.industry} space` : '';
  const brandLocal = f.city ? ` in ${f.city}` : '';
  const brandRecognition = `What is ${f.name}${brandLocal} known for${brandContext}? Describe its main services, specialties and reputation, and provide sources to support your answer. If you do not have reliable information about ${f.name}, say so instead of guessing.`;

  const competitorComparison = f.competitors.length
    ? `Compare ${f.name} with ${joinNames(f.competitors)}${inMarket}. Explain how they differ in services and specialties, and provide sources for the comparison.`
    : `Compare ${f.name} with other leading ${f.industry ? `${f.industry} ` : ''}providers${inMarket}. Explain how they differ in services and specialties, and provide sources for the comparison.`;

  const seeking = f.industry ? `a ${f.industry} provider` : 'a provider';
  const localMarketIntent = f.city
    ? `I am looking for ${seeking} in ${f.marketLabel}. Which providers should I consider? Compare suitable options and provide sources, including official websites where available.`
    : `I am looking for a reliable ${f.industry ? `${f.industry} provider` : 'provider'}${inMarket}. Which providers should I consider? Compare suitable options and provide sources, including official websites where available.`;

  const byCategory = {
    industry_discovery: industryDiscovery,
    service_discovery: serviceDiscovery,
    brand_recognition: brandRecognition,
    competitor_comparison: competitorComparison,
    local_market_intent: localMarketIntent,
  };
  return PROMPT_CATEGORIES.map((category) => ({ category, text: byCategory[category] }));
}

export default { buildTemplatePrompts, selectTemplateFacts, MAX_NAMED_COMPETITORS };
