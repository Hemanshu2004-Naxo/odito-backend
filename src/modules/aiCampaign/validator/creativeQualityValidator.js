/**
 * creativeQualityValidator — Phase 2 RSA/asset CREATIVE QUALITY gate.
 *
 * Deliberately separate from campaignStructureValidator.js:
 *   - campaignStructureValidator.js enforces Google Ads' own hard bounds
 *     (a 3-headline RSA is still a VALID campaign Google will accept) and
 *     remains the final SHAPE authority for persistence/publish.
 *   - THIS file enforces Odito's own stricter pre-publish QUALITY bar —
 *     the direct fix for the reported "Average Ad Strength" issue, where a
 *     6-headline/3-description generation was schema-valid but creatively
 *     thin. It is only ever consulted by campaignGenerationService.js
 *     (Phase 2) before a fresh AI generation is allowed to reach `ready` —
 *     it never re-litigates a draft a user has manually, intentionally
 *     trimmed down via Phase 1/3 CRUD or a Phase 4 proposal.
 *
 * Pure, synchronous, deterministic, no network, no external similarity
 * service — same discipline as every other validator in this module.
 */

import { RSA_QUALITY_TARGETS, ASSET_TARGETS } from '../constants/generationConfig.js';
import { STRUCTURED_SNIPPET_HEADERS } from '../constants/aiCampaignEnums.js';

// ── text normalization + lightweight similarity ───────────────────────────

function normalizeForComparison(text) {
  if (typeof text !== 'string') return '';
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ') // strip punctuation — punctuation-only differences must not count as "different"
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSet(text) {
  return new Set(normalizeForComparison(text).split(' ').filter(Boolean));
}

/** Jaccard similarity of two texts' word sets — 0 (nothing shared) to 1 (identical word sets). */
function jaccardSimilarity(a, b) {
  const A = tokenSet(a);
  const B = tokenSet(b);
  if (A.size === 0 && B.size === 0) return 1;
  let intersection = 0;
  for (const t of A) if (B.has(t)) intersection += 1;
  const union = A.size + B.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

const NEAR_DUPLICATE_THRESHOLD = 0.8;

/** True for exact, case/punctuation/whitespace-only, or near-identical (high word overlap) duplicates. */
export function isNearDuplicate(a, b) {
  const na = normalizeForComparison(a);
  const nb = normalizeForComparison(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  return jaccardSimilarity(na, nb) >= NEAR_DUPLICATE_THRESHOLD;
}

/** Every pair of near-duplicate texts in the list — {a, b, textA, textB} (indexes). */
export function findDuplicatePairs(texts) {
  const pairs = [];
  for (let i = 0; i < texts.length; i += 1) {
    for (let j = i + 1; j < texts.length; j += 1) {
      if (isNearDuplicate(texts[i], texts[j])) {
        pairs.push({ a: i, b: j, textA: texts[i], textB: texts[j] });
      }
    }
  }
  return pairs;
}

/**
 * Catches the "same template repeated" pattern (spec example: "Grow Your
 * Business Online/Digitally/With Marketing") that pairwise Jaccard alone
 * can miss — three headlines sharing only 3 of 5 words score well under the
 * near-duplicate threshold pairwise, but the SET is still low-diversity if
 * a large share of all headlines open with the same words.
 */
export function findTemplateRepetition(texts, { prefixWords = 2, maxShareRatio = 0.3, minCount = 3 } = {}) {
  if (texts.length < 4) return null;
  const prefixCounts = new Map();
  for (const t of texts) {
    const words = normalizeForComparison(t).split(' ').filter(Boolean);
    if (words.length < prefixWords) continue;
    const key = words.slice(0, prefixWords).join(' ');
    prefixCounts.set(key, (prefixCounts.get(key) || 0) + 1);
  }
  let worst = null;
  for (const [prefix, count] of prefixCounts) {
    if (count >= minCount && count / texts.length > maxShareRatio) {
      if (!worst || count > worst.count) worst = { prefix, count, ratio: count / texts.length };
    }
  }
  return worst;
}

/** Whether `keywordText` appears as a complete phrase inside at least one of `texts` (case/punctuation-insensitive). */
function coveredByAny(texts, keywordText) {
  const nk = normalizeForComparison(keywordText);
  if (!nk) return true;
  return texts.some((t) => normalizeForComparison(t).includes(nk));
}

// ── RSA creative quality ────────────────────────────────────────────────

function pushIssue(issues, issue) {
  issues.push(issue);
}

/**
 * @param {object} draft - { adGroups: [{ id, keywords, ads: [{ headlines, descriptions }] }] } (already-mapped/normalized shape — plain strings or {text} objects both accepted)
 * @returns {{ valid: boolean, issues: object[], metrics: object }}
 */
export function validateCreativeQuality(draft) {
  const issues = [];
  const adGroups = Array.isArray(draft?.adGroups) ? draft.adGroups : [];
  const metrics = { adGroupCount: adGroups.length, totalHeadlines: 0, totalDescriptions: 0, totalRsas: 0, duplicateCount: 0 };

  adGroups.forEach((ag, agIdx) => {
    const keywordTexts = (ag.keywords || []).map((k) => (typeof k === 'string' ? k : k?.text)).filter(Boolean);
    const ads = Array.isArray(ag.ads) ? ag.ads : [];

    ads.forEach((ad, adIdx) => {
      const headlines = (ad.headlines || []).map((h) => (typeof h === 'string' ? h : h?.text)).filter(Boolean);
      const descriptions = (ad.descriptions || []).map((d) => (typeof d === 'string' ? d : d?.text)).filter(Boolean);
      metrics.totalRsas += 1;
      metrics.totalHeadlines += headlines.length;
      metrics.totalDescriptions += descriptions.length;

      const at = (assetType, extra = {}) => ({ adGroupIndex: agIdx, adGroupId: ag.id, rsaIndex: adIdx, assetType, ...extra });

      if (headlines.length < RSA_QUALITY_TARGETS.headlinesQualityMin) {
        pushIssue(issues, at('headline', {
          code: 'TOO_FEW_HEADLINES',
          message: `Ad group "${ag.name || agIdx}" RSA ${adIdx + 1} has only ${headlines.length} headlines — Odito targets ${RSA_QUALITY_TARGETS.headlinesTarget} and requires at least ${RSA_QUALITY_TARGETS.headlinesQualityMin} for Good/Excellent Ad Strength.`,
          count: headlines.length,
        }));
      }
      if (descriptions.length < RSA_QUALITY_TARGETS.descriptionsQualityMin) {
        pushIssue(issues, at('description', {
          code: 'TOO_FEW_DESCRIPTIONS',
          message: `Ad group "${ag.name || agIdx}" RSA ${adIdx + 1} has only ${descriptions.length} descriptions — Odito targets and requires ${RSA_QUALITY_TARGETS.descriptionsQualityMin}.`,
          count: descriptions.length,
        }));
      }

      const headlineDupes = findDuplicatePairs(headlines);
      metrics.duplicateCount += headlineDupes.length;
      headlineDupes.forEach((d) => pushIssue(issues, at('headline', {
        code: 'DUPLICATE_HEADLINES',
        message: `Headlines ${d.a + 1} and ${d.b + 1} are near-duplicates: "${d.textA}" / "${d.textB}".`,
        indexes: [d.a, d.b],
      })));

      const template = findTemplateRepetition(headlines);
      if (template) {
        pushIssue(issues, at('headline', {
          code: 'TEMPLATE_REPETITION',
          message: `${template.count} of ${headlines.length} headlines start with "${template.prefix}" — vary sentence structure, not just one word.`,
        }));
      }

      const descriptionDupes = findDuplicatePairs(descriptions);
      metrics.duplicateCount += descriptionDupes.length;
      descriptionDupes.forEach((d) => pushIssue(issues, at('description', {
        code: 'DUPLICATE_DESCRIPTIONS',
        message: `Descriptions ${d.a + 1} and ${d.b + 1} are near-duplicates.`,
        indexes: [d.a, d.b],
      })));

      // Keyword relevance (spec §4): at least SOME of this ad group's own
      // top keywords should appear verbatim in a headline. Never requires
      // every keyword — that would force keyword-stuffing, which spec §4
      // explicitly forbids.
      const topKeywords = keywordTexts.slice(0, 5);
      if (topKeywords.length > 0 && !topKeywords.some((k) => coveredByAny(headlines, k))) {
        pushIssue(issues, at('headline', {
          code: 'NO_KEYWORD_COVERAGE',
          message: `None of ad group "${ag.name || agIdx}"'s top keywords (${topKeywords.join(', ')}) appear in any headline.`,
        }));
      }
    });
  });

  return { valid: issues.length === 0, issues, metrics };
}

// ── Campaign extension assets (sitelinks / callouts / structured snippets) ─

/**
 * @param {object} campaign - { sitelinks, callouts, structuredSnippets }
 * @param {object} [opts]
 * @param {string[]} [opts.trustedUrls] - the ONLY URLs a sitelink's finalUrl may be — see sitelinkResolver.js. Never optional in production; defaults to [] (rejects every sitelink) so a caller can never accidentally skip this check.
 * @returns {{ valid: boolean, issues: object[] }}
 */
export function validateCampaignAssets(campaign, { trustedUrls = [] } = {}) {
  const issues = [];
  const c = campaign || {};

  const sitelinks = Array.isArray(c.sitelinks) ? c.sitelinks : [];
  const seenSitelinkText = new Set();
  const seenSitelinkUrl = new Set();
  sitelinks.forEach((sl, i) => {
    const text = sl?.text || '';
    const norm = normalizeForComparison(text);
    if (!norm) { issues.push({ assetType: 'sitelink', index: i, code: 'EMPTY_TEXT', message: `Sitelink ${i + 1} has no text.` }); return; }
    if (seenSitelinkText.has(norm)) issues.push({ assetType: 'sitelink', index: i, code: 'DUPLICATE_SITELINK_TEXT', message: `Sitelink ${i + 1} ("${text}") duplicates another sitelink's text.` });
    seenSitelinkText.add(norm);

    if (!sl?.finalUrl) {
      issues.push({ assetType: 'sitelink', index: i, code: 'MISSING_URL', message: `Sitelink ${i + 1} has no destination URL.` });
    } else if (seenSitelinkUrl.has(sl.finalUrl)) {
      issues.push({ assetType: 'sitelink', index: i, code: 'DUPLICATE_SITELINK_URL', message: `Sitelink ${i + 1} reuses a URL already used by another sitelink.` });
    } else if (!trustedUrls.includes(sl.finalUrl)) {
      // The one hard safety rule (spec §13): a sitelink may NEVER point
      // anywhere Odito hasn't already verified belongs to this project.
      issues.push({ assetType: 'sitelink', index: i, code: 'UNTRUSTED_URL', message: `Sitelink ${i + 1}'s URL is not one of this project's verified URLs.` });
    }
    if (sl?.finalUrl) seenSitelinkUrl.add(sl.finalUrl);
  });

  const callouts = Array.isArray(c.callouts) ? c.callouts : [];
  const seenCallout = new Set();
  callouts.forEach((co, i) => {
    const norm = normalizeForComparison(co?.text);
    if (!norm) { issues.push({ assetType: 'callout', index: i, code: 'EMPTY_TEXT', message: `Callout ${i + 1} has no text.` }); return; }
    if (seenCallout.has(norm)) issues.push({ assetType: 'callout', index: i, code: 'DUPLICATE_CALLOUT', message: `Callout ${i + 1} ("${co.text}") duplicates another callout.` });
    seenCallout.add(norm);
  });
  const calloutDupes = findDuplicatePairs(callouts.map((co) => co?.text || ''));
  calloutDupes.forEach((d) => issues.push({ assetType: 'callout', code: 'NEAR_DUPLICATE_CALLOUT', message: `Callouts ${d.a + 1} and ${d.b + 1} are near-duplicates: "${d.textA}" / "${d.textB}".`, indexes: [d.a, d.b] }));

  const snippets = Array.isArray(c.structuredSnippets) ? c.structuredSnippets : [];
  const seenHeader = new Set();
  snippets.forEach((sn, i) => {
    if (!STRUCTURED_SNIPPET_HEADERS.includes(sn?.header)) {
      issues.push({ assetType: 'structuredSnippet', index: i, code: 'INVALID_HEADER', message: `Structured snippet ${i + 1}'s header "${sn?.header}" is not a supported Google Ads header.` });
    } else if (seenHeader.has(sn.header)) {
      issues.push({ assetType: 'structuredSnippet', index: i, code: 'DUPLICATE_HEADER', message: `Header "${sn.header}" is used by more than one structured snippet.` });
    }
    if (sn?.header) seenHeader.add(sn.header);

    const values = Array.isArray(sn?.values) ? sn.values.filter(Boolean) : [];
    if (values.length < ASSET_TARGETS.structuredSnippetValuesMin) {
      issues.push({ assetType: 'structuredSnippet', index: i, code: 'TOO_FEW_VALUES', message: `Structured snippet ${i + 1} has only ${values.length} values — needs at least ${ASSET_TARGETS.structuredSnippetValuesMin}.` });
    }
    const seenValue = new Set();
    values.forEach((v, vi) => {
      const norm = normalizeForComparison(v);
      if (norm && seenValue.has(norm)) {
        issues.push({ assetType: 'structuredSnippet', index: i, code: 'DUPLICATE_VALUE', message: `Structured snippet ${i + 1}, value ${vi + 1} ("${v}") duplicates another value in the same snippet.` });
      }
      seenValue.add(norm);
    });
  });

  return { valid: issues.length === 0, issues };
}

export default {
  isNearDuplicate,
  findDuplicatePairs,
  findTemplateRepetition,
  validateCreativeQuality,
  validateCampaignAssets,
};
