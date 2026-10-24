/**
 * Metrics for an approved-question run, computed from PERSISTED EVIDENCE documents (never from a worker's memory), so a recovered or
 * re-read run gives the same numbers. Pure; provider-independent.
 *
 * DENOMINATORS (every rate below says which one it uses):
 *   questions   questions in the run's snapshot (what was meant to be asked)
 *   attempted   evidence sent to the provider: succeeded + failed.  `skipped` ones (cancel, cost guard, fatal provider error) were never sent.
 *   succeeded   answered questions. EVERY visibility rate is   <count among succeeded answers> / succeeded .
 * A FAILED or SKIPPED question is missing data, never "no visibility": it is excluded from the succeeded-based rates. Because that can flatter
 * a run with many failures, `brandMentionRateOfAttempted` (mentions / attempted, failures counted as "not mentioned") is reported beside
 * the primary rate and is a LOWER BOUND. Both are null when their denominator is 0.
 *
 * GROUPS: `visibility` questions never name the brand, so their mention rate means "ChatGPT brought the business up on its own".
 * `brand_reputation` questions name it, so a mention there only says what the model knows; they are summarised separately and never
 * feed the headline `overview`.
 *
 * MENTION / RECOMMENDATION / CITATION are three different things:
 *   mention         the brand (or a verified alias) appears in the answer text
 *   recommendation  the brand is presented as an option (heuristic, see recommendationDetection.js)
 *   citation        the answer cites a URL on the target website (host equals or is a subdomain of the target host)
 *
 * Unique counts de-duplicate: first-party pages by NORMALIZED URL (tracking parameters removed), external domains by host.
 * Cost: only successful answers carry a cost; an answer with no provider-reported cost is counted in `unknownCostCount`, never as 0.
 * Everything is a SAMPLE of answers to the approved questions - not what ChatGPT says to every user, and not every citation on the web.
 */

export const APPROVED_METRICS_SCHEMA_VERSION = 2;

const ratio = (num, den) => (den > 0 ? Math.round((num / den) * 10_000) / 10_000 : null);
const pct = (r) => (r === null ? null : Math.round(r * 100));

function summarize(list, { brandReliable, haveHost }) {
  const succeeded = list.filter((e) => e.status === 'succeeded');
  const failed = list.filter((e) => e.status === 'failed');
  const skipped = list.filter((e) => e.status === 'skipped');
  const attempted = succeeded.length + failed.length;

  const mentioning = succeeded.filter((e) => e.analysis?.brandMentioned === true);
  const recommending = succeeded.filter((e) => e.analysis?.recommended === true);
  const citing = succeeded.filter((e) => (e.firstPartyPages || []).length > 0);

  const pages = new Set(succeeded.flatMap((e) => e.firstPartyPages || []));
  const rawUrls = new Set(succeeded.flatMap((e) => (e.citations || []).filter((c) => c.isTarget && c.valid !== false).map((c) => c.url)));
  const domains = new Set(succeeded.flatMap((e) => e.externalDomains || []));
  const firstPartyOccurrences = succeeded.reduce((n, e) => n + (e.citations || []).filter((c) => c.isTarget && c.valid !== false).length, 0);

  const competitors = new Map();
  for (const e of succeeded) {
    for (const m of e.analysis?.competitorMentions || []) {
      const cur = competitors.get(m.name) || { name: m.name, responses: 0, occurrences: 0 };
      cur.responses += 1;
      cur.occurrences += m.count || 0;
      competitors.set(m.name, cur);
    }
  }

  const knownCost = succeeded.filter((e) => typeof e.cost === 'number');
  const amount = knownCost.reduce((n, e) => n + e.cost, 0);

  return {
    questions: list.length,
    attempted,
    succeeded: succeeded.length,
    failed: failed.length,
    skipped: skipped.length,
    executionSuccessRate: ratio(succeeded.length, attempted),
    answersMentioningBrand: mentioning.length,
    brandMentionRate: brandReliable ? ratio(mentioning.length, succeeded.length) : null,
    brandMentionRateOfAttempted: brandReliable ? ratio(mentioning.length, attempted) : null,
    answersRecommendingBrand: recommending.length,
    recommendationRate: brandReliable ? ratio(recommending.length, succeeded.length) : null,
    answersCitingWebsite: haveHost ? citing.length : null,
    websiteCitationRate: haveHost ? ratio(citing.length, succeeded.length) : null,
    uniqueFirstPartyPages: haveHost ? pages.size : null,
    uniqueFirstPartyUrls: haveHost ? rawUrls.size : null,
    firstPartyCitationOccurrences: haveHost ? firstPartyOccurrences : null,
    uniqueExternalDomains: domains.size,
    competitorMentions: {
      totalOccurrences: [...competitors.values()].reduce((n, c) => n + c.occurrences, 0),
      // rate = answers mentioning that competitor / answered questions (same denominator as the business's own visibility rate)
      competitors: [...competitors.values()].map((c) => ({ ...c, rate: ratio(c.responses, succeeded.length) }))
        .sort((a, b) => b.occurrences - a.occurrences || a.name.localeCompare(b.name)),
      note: 'Only competitors known to Odito are counted; other names a model mentions are not classified.',
    },
    cost: {
      knownTotal: knownCost.length ? Math.round(amount * 1e6) / 1e6 : null,
      knownCount: knownCost.length,
      unknownCostCount: succeeded.length - knownCost.length,
    },
  };
}

/**
 * @param {object[]} evidence  persisted evidence documents of ONE run (status, group, intent, analysis, citations, firstPartyPages, externalDomains, cost)
 * @param {{brandNames:string[], competitors:string[], targetHost:string|null, brandMatchReliable?:boolean, nameVerified?:boolean}} target
 * @param {{ questionsPlanned?: number, costUnit?: string|null, budget?: number }} [opts]
 */
export function computeApprovedQuestionMetrics(evidence, target, { questionsPlanned = null, costUnit = null, budget = 0 } = {}) {
  const list = Array.isArray(evidence) ? evidence : [];
  const brandReliable = target.brandMatchReliable !== false && (target.brandNames || []).length > 0;
  const haveHost = Boolean(target.targetHost);
  const ctx = { brandReliable, haveHost };

  const visibility = list.filter((e) => e.group === 'visibility');
  const brandReputation = list.filter((e) => e.group === 'brand_reputation');
  const overall = summarize(visibility, ctx);

  const intents = [...new Set(visibility.map((e) => e.intent))].sort();
  const byIntent = Object.fromEntries(intents.map((i) => {
    const s = summarize(visibility.filter((e) => e.intent === i), ctx);
    return [i, {
      questions: s.questions, attempted: s.attempted, succeeded: s.succeeded, failed: s.failed,
      answersMentioningBrand: s.answersMentioningBrand, brandMentionRate: s.brandMentionRate,
      answersRecommendingBrand: s.answersRecommendingBrand, answersCitingWebsite: s.answersCitingWebsite,
      websiteCitationRate: s.websiteCitationRate, uniqueFirstPartyPages: s.uniqueFirstPartyPages,
    }];
  }));

  const brandSummary = summarize(brandReputation, ctx);
  const allSucceeded = list.filter((e) => e.status === 'succeeded');
  const unknownCostCount = allSucceeded.filter((e) => typeof e.cost !== 'number').length;
  const knownTotal = allSucceeded.filter((e) => typeof e.cost === 'number').reduce((n, e) => n + e.cost, 0);
  const knownCount = allSucceeded.length - unknownCostCount;

  const limitations = ['SAMPLED_QUESTIONS'];
  if (!brandReliable) limitations.push('BRAND_NAME_UNRELIABLE');
  if (target.nameVerified === false) limitations.push('BRAND_NAME_UNVERIFIED');
  if (!haveHost) limitations.push('NO_TARGET_HOST');
  if (overall.succeeded === 0) limitations.push('NO_SUCCESSFUL_VISIBILITY_ANSWERS');
  else if (overall.succeeded < overall.questions) limitations.push('PARTIAL_EXECUTION');
  if (!(target.competitors || []).length) limitations.push('NO_KNOWN_COMPETITORS');
  if (unknownCostCount > 0) limitations.push('UNKNOWN_COST_PRESENT');
  if (budget > 0 && unknownCostCount > 0) limitations.push('COST_BUDGET_NOT_FULLY_ENFORCEABLE');

  return {
    schemaVersion: APPROVED_METRICS_SCHEMA_VERSION,
    mode: 'approved_questions',
    questionsPlanned: questionsPlanned ?? list.length,
    // The headline card. Every rate has the SAME denominator: eligible answers = answered discovery (unbranded) questions. Brand
    // diagnostic questions never contribute; failed / skipped questions are not in the denominator (they are missing data).
    overview: {
      eligibleAnswers: overall.succeeded,
      visibilityRate: overall.brandMentionRate, // answers that mention the business / eligible answers
      visibilityAnswers: overall.answersMentioningBrand,
      recommendationRate: overall.recommendationRate, // answers presenting the business as an option (heuristic_v1) / eligible answers
      recommendationAnswers: overall.answersRecommendingBrand,
      recommendationMethod: 'heuristic_v1',
      websiteCitationRate: overall.websiteCitationRate, // answers citing >= 1 page of the website / eligible answers
      websiteCitationAnswers: overall.answersCitingWebsite,
      uniqueCitedPages: overall.uniqueFirstPartyPages, // distinct normalized first-party URLs
      citationOccurrences: overall.firstPartyCitationOccurrences, // every first-party citation, repeats included
      competitors: {
        configured: (target.competitors || []).length > 0,
        tracked: (target.competitors || []).length,
        mentioned: overall.competitorMentions.competitors.map((c) => ({ name: c.name, answers: c.responses, rate: c.rate, occurrences: c.occurrences })),
      },
      // Back-compat (schema v1 readers): 0-100 form of visibilityRate, and the counts the v1 card used.
      visibilityScore: pct(overall.brandMentionRate),
      mentions: overall.answersMentioningBrand,
      citedPages: overall.uniqueFirstPartyPages,
      basedOnAnswers: overall.succeeded,
    },
    visibility: overall,
    brandReputation: {
      questions: brandSummary.questions, succeeded: brandSummary.succeeded, failed: brandSummary.failed, skipped: brandSummary.skipped,
      answersMentioningBrand: brandSummary.answersMentioningBrand, answersCitingWebsite: brandSummary.answersCitingWebsite,
      uniqueFirstPartyPages: brandSummary.uniqueFirstPartyPages,
      note: 'These questions name the business, so a mention shows what the model knows, not unprompted visibility.',
    },
    byIntent,
    cost: { knownTotal: knownCount ? Math.round(knownTotal * 1e6) / 1e6 : null, unit: knownCount ? costUnit : null, knownCount, unknownCostCount },
    partial: overall.succeeded > 0 && overall.succeeded < overall.questions,
    limitations,
    sampled: true,
  };
}

export default { computeApprovedQuestionMetrics, APPROVED_METRICS_SCHEMA_VERSION };
