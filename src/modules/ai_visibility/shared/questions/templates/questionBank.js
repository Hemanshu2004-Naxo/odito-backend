import { INTENT_NAMES } from '../config/questionConfig.js';

/**
 * The question bank: reusable templates organised by customer intent, written the way a prospective customer would ask. A template is
 * only expanded when EVERY slot it names has a confirmed value, so nothing is invented - a missing slot removes the templates that need
 * it (and the generator reports the missing business detail).
 *
 * Slots (all from the CONFIRMED business profile, never guessed):
 *   category / categories  the kind of business, singular / plural ("eye hospital" / "eye hospitals")
 *   service                a confirmed service
 *   location               a confirmed target city
 *   area                   a confirmed area served
 *   requirement            a confirmed capability customers ask for
 *   problem                a confirmed customer problem the business solves
 *   customerType           a confirmed customer type
 *   buyingRequirement      a confirmed buying criterion the business meets
 *
 * `topic` names the slot that carries the question's subject; together with the intent and the place it forms the question's
 * SEMANTIC KEY, and only the first template per key is used - so the same search intent is never asked twice with different wording.
 * Within an intent, templates are listed most-specific first; the later ones are fall-backs for profiles missing a detail.
 *
 * `max` (optional) caps how many questions one template may produce, so a phrasing is not repeated for every service and city.
 *
 * Template ids are stable (stored on every question for history). Changing any text requires bumping QUESTION_GENERATOR_VERSION.
 */

export const SLOT_TO_INPUT = Object.freeze({
  category: 'categories',
  categories: 'categories',
  service: 'services',
  location: 'cities',
  area: 'areas',
  requirement: 'requirements',
  problem: 'problems',
  customerType: 'customerTypes',
  buyingRequirement: 'buyingRequirements',
});

export const QUESTION_TEMPLATES = Object.freeze([
  // ── service discovery ──
  { id: 'svc_cat_loc', intent: 'discovery', topic: 'service', text: 'Which {categories} in {location} offer {service}?' },
  { id: 'svc_loc', intent: 'discovery', topic: 'service', text: 'Where can I get {service} in {location}?' },
  { id: 'svc_cat', intent: 'discovery', topic: 'service', text: 'Which {categories} offer {service}?' },
  { id: 'svc', intent: 'discovery', topic: 'service', text: 'Who provides {service}?' },

  // ── specific service / requirement discovery ──
  { id: 'req_cat_loc', intent: 'specific_requirements', topic: 'requirement', text: 'Which {categories} in {location} offer {requirement}?' },
  { id: 'req_svc_loc', intent: 'specific_requirements', topic: 'requirement', text: 'Which providers of {service} in {location} also offer {requirement}?' },
  { id: 'req_cat', intent: 'specific_requirements', topic: 'requirement', text: 'Which {categories} offer {requirement}?' },

  // ── problem-solving discovery ──
  { id: 'prob_loc', intent: 'problem_solving', topic: 'problem', text: 'Where can I get help with {problem} in {location}?' },
  { id: 'prob_cat', intent: 'problem_solving', topic: 'problem', text: 'Which {categories} can help with {problem}?' },

  // ── comparison and shortlist ──
  { id: 'cmp_type_loc', intent: 'comparison', topic: 'customerType', text: 'Which {categories} in {location} are a good fit for {customerType}?' },
  { id: 'cmp_type', intent: 'comparison', topic: 'customerType', text: 'Which {categories} are a good fit for {customerType}?' },
  { id: 'cmp_choose_svc_loc', intent: 'comparison', topic: 'service', max: 2, text: 'What should I compare when choosing a {category} in {location} for {service}?' },

  // ── buying decision ──
  { id: 'buy_cat_loc', intent: 'buying_decision', topic: 'buyingRequirement', text: 'Which {categories} in {location} offer {buyingRequirement}?' },
  { id: 'buy_svc', intent: 'buying_decision', topic: 'buyingRequirement', text: 'Which providers of {service} offer {buyingRequirement}?' },

  // ── local / market discovery ──
  { id: 'loc_consider', intent: 'local_discovery', topic: 'category', text: 'Which {categories} should I consider in {location}?' },
  { id: 'loc_area_svc', intent: 'local_discovery', topic: 'service', text: 'Which {categories} near {area} offer {service}?' },
  { id: 'loc_area', intent: 'local_discovery', topic: 'category', text: 'Which {categories} serve {area}?' },
]);

/**
 * Brand diagnostic questions: the ONLY questions that name the business. They check what ChatGPT knows about it and whether that is
 * accurate; they are kept in their own group and never count toward discovery visibility.
 */
// Brand-name questions ("What is <business> known for?") were removed from the product: no template names the business.
export const BRAND_TEMPLATES = Object.freeze([]);

export const TEMPLATE_IDS = Object.freeze(new Set([...QUESTION_TEMPLATES, ...BRAND_TEMPLATES].map((t) => t.id)));

export const slotsOf = (template) => [...new Set([...template.text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))];

/**
 * Plural of a business-kind phrase, by its last word: "eye hospital" -> "eye hospitals", "digital marketing agency" -> "digital marketing
 * agencies". A phrase already ending in "s" ("IT services") is left alone. Deterministic; no dictionary lookup.
 */
export function pluralizePhrase(phrase) {
  const p = String(phrase || '').trim();
  const m = p.match(/^(.*?)([A-Za-z]+)$/);
  if (!m) return p;
  const [, head, word] = m;
  const lower = word.toLowerCase();
  let plural;
  if (/s$/.test(lower)) plural = word;
  else if (/[^aeiou]y$/.test(lower)) plural = `${word.slice(0, -1)}ies`;
  else if (/(x|z|ch|sh)$/.test(lower)) plural = `${word}es`;
  else plural = `${word}s`;
  return `${head}${plural}`;
}

export function fillTemplate(template, values) {
  const filled = template.text.replace(/\{(\w+)\}/g, (_, slot) => (slot === 'categories' ? pluralizePhrase(values.category ?? values.categories) : values[slot]));
  // English article before an inserted word that starts with a vowel we can detect reliably ("a eye hospital" -> "an eye hospital").
  return filled.replace(/\b([Aa]) (?=[aeioAEIO])/g, (_, a) => (a === 'A' ? 'An ' : 'an '));
}

// Guard: every template must use only known slots and a known intent (checked at import so a typo fails fast).
for (const t of QUESTION_TEMPLATES) {
  if (!INTENT_NAMES.includes(t.intent)) throw new Error(`question bank: unknown intent "${t.intent}" on ${t.id}`);
  for (const s of slotsOf(t)) if (!SLOT_TO_INPUT[s]) throw new Error(`question bank: unknown slot "${s}" on ${t.id}`);
}

export default { QUESTION_TEMPLATES, BRAND_TEMPLATES, TEMPLATE_IDS, SLOT_TO_INPUT, slotsOf, fillTemplate, pluralizePhrase };
