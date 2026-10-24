import crypto from 'crypto';
import { INTENTS, INTENT_NAMES, GROUPS, BRAND_INTENT, QUESTION_LIMITS } from '../config/questionConfig.js';
import { QUESTION_TEMPLATES, BRAND_TEMPLATES, SLOT_TO_INPUT, slotsOf, fillTemplate } from '../templates/questionBank.js';
import { normalizeKey } from '../../utils/text.js';

/**
 * Deterministic expansion of the question bank into questions. Same profile always gives the same questions in the same order
 * (reproducibility is what makes comparisons over time meaningful). A template runs only when every slot it names has a confirmed
 * value; an intent that cannot reach its target is NOT back-filled with invented questions.
 *
 * De-duplication is by MEANING, not wording: each question has a semantic key (intent + subject + place). Two templates that would
 * ask the same thing about the same service in the same city produce one question, and the most specific template wins.
 */

const MAX_COMBOS_PER_TEMPLATE = 24;
const byKey = (a, b) => (normalizeKey(a) < normalizeKey(b) ? -1 : normalizeKey(a) > normalizeKey(b) ? 1 : 0);

export const questionId = (templateId, values) => {
  const material = `${templateId}|${Object.keys(values).sort().map((k) => `${k}=${normalizeKey(values[k])}`).join('|')}`;
  return `q_${crypto.createHash('sha1').update(material).digest('hex').slice(0, 12)}`;
};

/** intent | subject | place - what the question MEANS. */
export function semanticKey(intent, topic, values) {
  const subject = topic === 'category' ? '' : normalizeKey(values[topic] || '');
  const place = normalizeKey(values.location || values.area || '');
  return `${intent}|${topic}:${subject}|${place}`;
}

/** Every slot-value combination for a template, first slot varying slowest, capped. `category` and `categories` share one value. */
function combos(slots, inputs) {
  let out = [{}];
  const seen = new Set();
  for (const slot of slots) {
    const input = SLOT_TO_INPUT[slot];
    if (seen.has(input)) continue; // {category} and {categories} are the same value
    seen.add(input);
    const values = [...(inputs[input] || [])].sort(byKey);
    if (!values.length) return [];
    const key = slot === 'categories' ? 'category' : slot;
    const next = [];
    for (const base of out) for (const v of values) next.push({ ...base, [key]: v });
    out = next;
    if (out.length > MAX_COMBOS_PER_TEMPLATE) out = out.slice(0, MAX_COMBOS_PER_TEMPLATE);
  }
  return out;
}

const priorityFor = (intent) => (intent === 'discovery' || intent === 'local_discovery' ? 'high' : 'medium');

function toQuestion(template, values, language, key) {
  const used = Object.keys(values);
  return {
    id: questionId(template.id, values),
    group: GROUPS.VISIBILITY,
    text: fillTemplate(template, values),
    intent: template.intent,
    topic: template.topic,
    brandNamed: false,
    semanticKey: key,
    service: values.service || null,
    location: values.location || values.area || null,
    language,
    templateId: template.id,
    priority: priorityFor(template.intent),
    selectionReason: `Confirmed ${used.join(', ')} used in the "${template.intent}" template ${template.id}.`,
    source: 'template',
    validationStatus: 'passed',
    enabled: true,
  };
}

/**
 * Round-robin across an intent's templates for variety. Which template asks a given MEANING is decided up front: the first (most
 * specific) template that can express a semantic key owns it, so a fall-back wording can never claim a key ahead of a better one.
 */
function expandIntent(intent, inputs, target, takenKeys) {
  const queues = QUESTION_TEMPLATES
    .filter((t) => t.intent === intent)
    .map((t) => ({ t, list: combos(slotsOf(t), inputs), used: 0 }))
    .filter((q) => q.list.length);
  const owner = new Map();
  for (const { t, list } of queues) {
    for (const v of list) {
      const k = semanticKey(intent, t.topic, v);
      if (!owner.has(k)) owner.set(k, t.id);
    }
  }
  const out = [];
  let progressed = true;
  for (let round = 0; out.length < target && progressed; round += 1) {
    progressed = false;
    for (const q of queues) {
      const { t, list } = q;
      if (out.length >= target) break;
      if (round >= list.length) continue;
      progressed = true;
      if (t.max && q.used >= t.max) continue;
      const key = semanticKey(intent, t.topic, list[round]);
      if (owner.get(key) !== t.id || takenKeys.has(key)) continue;
      takenKeys.add(key);
      q.used += 1;
      out.push(toQuestion(t, list[round], inputs.language, key));
    }
  }
  return out;
}

/** @returns {object[]} unbranded discovery questions, in intent order */
export function buildTemplateQuestions(inputs) {
  const out = [];
  const taken = new Set();
  // Most-specific templates first within an intent: a key claimed by the first template is never reworded by a later one.
  for (const intent of INTENT_NAMES) {
    out.push(...expandIntent(intent, inputs, INTENTS[intent], taken));
    if (out.length >= QUESTION_LIMITS.maxQuestions) break;
  }
  return out.slice(0, QUESTION_LIMITS.maxQuestions);
}

/** @returns {object[]} brand diagnostic questions (name the business) - empty when the business has no usable name */
export function buildBrandQuestions(profile, inputs) {
  const brand = profile.business.name;
  if (!brand) return [];
  const category = inputs.categories[0] || null;
  const location = inputs.cities[0] || null;
  const out = [];
  for (const t of BRAND_TEMPLATES) {
    const slots = slotsOf(t);
    if (slots.includes('category') && !category) continue;
    if (slots.includes('location') && !location) continue;
    // With a location, the location-specific "services" question replaces the generic one (same meaning).
    if (t.id === 'brand_services' && location) continue;
    const values = { brand, ...(slots.includes('category') ? { category } : {}), ...(slots.includes('location') ? { location } : {}) };
    out.push({
      id: questionId(t.id, values),
      group: GROUPS.BRAND_REPUTATION,
      text: fillTemplate(t, values),
      intent: BRAND_INTENT,
      topic: 'brand',
      brandNamed: true,
      semanticKey: `${BRAND_INTENT}|${t.id}|${normalizeKey(location || '')}`,
      service: null,
      location: values.location || null,
      language: inputs.language,
      templateId: t.id,
      priority: 'low',
      selectionReason: 'Brand diagnostic question: checks what ChatGPT knows about the business; never counted as discovery visibility.',
      source: 'template',
      validationStatus: 'passed',
      enabled: true,
    });
  }
  return out.slice(0, QUESTION_LIMITS.maxBrandQuestions);
}

export default { buildTemplateQuestions, buildBrandQuestions, questionId, semanticKey };
