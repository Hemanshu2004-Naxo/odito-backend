/**
 * Deterministic, conservative scan for ad copy that commonly runs into
 * Google Ads policy trouble — unsupported guarantees, fabricated
 * certifications/awards, absolute/superlative claims (Phase 5, spec §15).
 *
 * THIS IS NOT A POLICY COMPLIANCE CHECKER. It is a small set of keyword/
 * phrase triggers that flag WARNINGS ONLY (never errors — a pattern match
 * is not proof of a policy violation, and the absence of a match is not
 * proof of compliance). Every finding is phrased as "potential policy
 * concern", never "guaranteed"/"violates policy" — see spec §15's explicit
 * instruction not to market this as policy-guaranteed.
 *
 * Pure, synchronous, no network — same determinism requirement as the rest
 * of campaignStructureValidator.js, which is where this plugs in (the
 * `runPolicy` seam left empty since Phase 1).
 */

// Each entry: a case-insensitive pattern + the concern it flags. Kept small
// and conservative on purpose — false positives on ordinary marketing copy
// erode trust in every other check, so only genuinely common problem
// patterns are listed.
const CLAIM_PATTERNS = [
  { re: /\bguarantee(d|s)?\b/i, concern: 'unsupported guarantee' },
  { re: /\b100%\s*(guaranteed|satisfaction|results?)\b/i, concern: 'unsupported guarantee' },
  // `\b` immediately before `#` never matches (both a space and `#` are
  // non-word characters, so there is no word-boundary transition there) —
  // the alternatives are split so each half keeps a `\b` only where it
  // actually sits next to a word character.
  { re: /\bnumber\s*one\b|#\s?1\b|\bno\.?\s?1\b/i, concern: 'unverifiable superlative ranking claim' },
  { re: /\bworld'?s\s+(best|largest|leading|#?1)\b/i, concern: 'unverifiable superlative claim' },
  { re: /\bbest\s+in\s+(the\s+)?(world|nashik|india|class|business)\b/i, concern: 'unverifiable superlative claim' },
  { re: /\baward[\s-]?winning\b/i, concern: 'unverifiable award claim' },
  { re: /\bcertified\b/i, concern: 'unverifiable certification claim' },
  { re: /\blicensed\b/i, concern: 'unverifiable licensing claim' },
  { re: /\b(cure|cures|cured)\b/i, concern: 'medical/health claim' },
  { re: /\brisk[\s-]?free\b/i, concern: 'unsupported guarantee' },
  { re: /\b(trusted|used)\s+by\s+[\d,]+\+?\s*(businesses|customers|clients|people)\b/i, concern: 'unverifiable customer-count claim' },
];

/**
 * @param {string} text
 * @returns {string[]} concerns found in this text (possibly empty)
 */
export function scanTextForPolicyConcerns(text) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const found = [];
  for (const { re, concern } of CLAIM_PATTERNS) {
    if (re.test(text)) found.push(concern);
  }
  return found;
}

/**
 * Scan every headline/description across every ad in a campaign draft-like
 * object, plus (additive) every campaign-level extension asset text
 * (sitelinks, callouts, structured-snippet values), and push a WARNING
 * (never an error) for each concern found.
 *
 * @param {object} draft - { campaign?: { sitelinks, callouts, structuredSnippets }, adGroups: [{ ads: [{ headlines, descriptions }] }] }
 * @param {string[]} warnings - appended to in place
 */
export function scanCampaignForPolicyConcerns(draft, warnings) {
  const adGroups = Array.isArray(draft?.adGroups) ? draft.adGroups : [];
  adGroups.forEach((ag, gi) => {
    (ag.ads || []).forEach((ad, ai) => {
      (ad.headlines || []).forEach((h, hi) => {
        const text = typeof h === 'string' ? h : h?.text;
        for (const concern of scanTextForPolicyConcerns(text)) {
          warnings.push(
            `Potential policy concern in adGroups[${gi}].ads[${ai}].headlines[${hi}]: ${concern} ("${text}"). Review for supporting evidence before publishing.`,
          );
        }
      });
      (ad.descriptions || []).forEach((d, di) => {
        const text = typeof d === 'string' ? d : d?.text;
        for (const concern of scanTextForPolicyConcerns(text)) {
          warnings.push(
            `Potential policy concern in adGroups[${gi}].ads[${ai}].descriptions[${di}]: ${concern} ("${text}"). Review for supporting evidence before publishing.`,
          );
        }
      });
    });
  });

  const campaign = draft?.campaign || {};
  (campaign.sitelinks || []).forEach((sl, i) => {
    for (const field of ['text', 'description1', 'description2']) {
      for (const concern of scanTextForPolicyConcerns(sl?.[field])) {
        warnings.push(`Potential policy concern in campaign.sitelinks[${i}].${field}: ${concern} ("${sl[field]}"). Review for supporting evidence before publishing.`);
      }
    }
  });
  (campaign.callouts || []).forEach((co, i) => {
    for (const concern of scanTextForPolicyConcerns(co?.text)) {
      warnings.push(`Potential policy concern in campaign.callouts[${i}]: ${concern} ("${co.text}"). Review for supporting evidence before publishing.`);
    }
  });
  (campaign.structuredSnippets || []).forEach((sn, i) => {
    (sn?.values || []).forEach((v, vi) => {
      for (const concern of scanTextForPolicyConcerns(v)) {
        warnings.push(`Potential policy concern in campaign.structuredSnippets[${i}].values[${vi}]: ${concern} ("${v}"). Review for supporting evidence before publishing.`);
      }
    });
  });
}

export default { scanTextForPolicyConcerns, scanCampaignForPolicyConcerns };
