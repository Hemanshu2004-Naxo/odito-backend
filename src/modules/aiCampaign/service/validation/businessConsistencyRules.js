/**
 * Business-consistency rule (Phase 5, spec §14).
 *
 * Deliberately minimal. Spec §14 is explicit: "do not invent semantic
 * requirements that are impossible to reliably evaluate" and "do NOT
 * create an AI 'truth detector'". The only thing this rule checks is
 * something a plain string comparison can answer with certainty — whether
 * an ad's landing page points at the SAME domain as the project's own
 * website (when Odito already knows that website). A domain mismatch is
 * not necessarily wrong (a campaign can legitimately point at a
 * microsite/partner page), so this is always a WARNING, never an error.
 */

import { warning } from './issueHelpers.js';

function hostOf(url) {
  try {
    return new URL(url).host.replace(/^www\./i, '').toLowerCase();
  } catch {
    return null;
  }
}

/**
 * @param {object} draftPlain - { adGroups }
 * @param {object} [project] - the authorized SeoProject (may be null/undefined)
 * @returns {object[]} issues
 */
export function runBusinessConsistencyRule(draftPlain, project) {
  const issues = [];
  const projectHost = hostOf(project?.main_url);
  if (!projectHost) return issues; // nothing reliable to compare against

  const seen = new Set();
  (draftPlain?.adGroups || []).forEach((ag, gi) => {
    (ag.ads || []).forEach((ad, ai) => {
      const adHost = hostOf(ad.finalUrl);
      if (!adHost || adHost === projectHost || seen.has(adHost)) return;
      seen.add(adHost);
      issues.push(warning({
        code: 'LANDING_PAGE_DOMAIN_MISMATCH',
        category: 'business_consistency',
        path: `adGroups[${gi}].ads[${ai}].finalUrl`,
        message: `This ad's landing page domain (${adHost}) does not match this project's website (${projectHost}).`,
        recommendation: 'Double-check this is intentional (e.g. a microsite or partner page) before publishing.',
      }));
    });
  });

  return issues;
}

export default { runBusinessConsistencyRule };
