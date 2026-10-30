import { ValidationFailure } from '../../shared/targetDomain.js';
import { ANCHOR_SETTINGS } from '../config.js';

/**
 * Pure input handling for the project's saved anchor settings: `brand_terms` and `target_keywords`. Each term is normalised the way the
 * page classifies anchors (lowercase, trimmed, inner spaces collapsed), so what is saved is what is compared. Duplicates are dropped.
 */

const bad = (field, message) => new ValidationFailure(field, message);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** "  Krishna   Eye " -> "krishna eye". */
export const normalizeTerm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();

function parseList(field, raw, { max, noun }) {
  if (!Array.isArray(raw)) throw bad(field, `${field} must be a list of ${noun}.`);
  const out = [];
  for (const item of raw) {
    if (typeof item !== 'string') throw bad(field, `Every entry in ${field} must be text.`);
    if (CONTROL.test(item)) throw bad(field, `${field} cannot contain control characters.`);
    const term = normalizeTerm(item);
    if (!term) continue; // a blank entry is just dropped
    if (term.length > ANCHOR_SETTINGS.maxTermLength) throw bad(field, `Each entry in ${field} can be at most ${ANCHOR_SETTINGS.maxTermLength} characters.`);
    if (!out.includes(term)) out.push(term);
  }
  if (out.length > max) throw bad(field, `You can save at most ${max} ${noun}. Remove some first.`);
  return out;
}

/** PUT body `{ brand_terms: string[], target_keywords: string[] }` -> both lists, clean. Both must be present: a save replaces both. */
export function parseAnchorSettingsBody(body) {
  return {
    brandTerms: parseList('brand_terms', body?.brand_terms, { max: ANCHOR_SETTINGS.maxBrandTerms, noun: 'brand terms' }),
    targetKeywords: parseList('target_keywords', body?.target_keywords, { max: ANCHOR_SETTINGS.maxTargetKeywords, noun: 'target keywords' }),
  };
}
