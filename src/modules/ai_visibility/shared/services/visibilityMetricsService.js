import { findMentions } from './brandMatchingService.js';
import { extractCitations } from './citationNormalizationService.js';

/**
 * Provider-independent visibility metrics over sampled AI answers.
 *
 * DENOMINATORS (the rules every number below follows):
 *   attempted   executions that were actually sent to the provider:  succeeded + failed.  `skipped` ones (stopped by a
 *               cost guard, a fatal provider error or a cancellation) were never sent and are not attempted.
 *   executionSuccessRate   succeeded / attempted                  (null when nothing was attempted)
 *   brandMentionRate       succeeded answers naming the brand / succeeded answers
 *   websiteCitationRate    succeeded answers with >= 1 target-domain citation / succeeded answers
 * A FAILED or SKIPPED execution is missing data, never "no visibility": it is excluded from every visibility rate, and a run
 * with fewer than all five successes is reported as partial. With zero successful answers every visibility rate is null.
 *
 * Branded and non-branded prompts are reported separately because a branded prompt names the business: a mention there says
 * what the model knows, not that it recommends the business unprompted.
 *
 * Results are SAMPLED observations from a provider - not every ChatGPT answer and not every citation seen by users.
 */

/**
 * Per-answer analysis. `target` = { brandNames[], competitors[], targetHost }.
 * Stored on the execution so metrics can be recomputed and the answer inspected without re-parsing.
 */
export function analyzeAnswer({ answerText, annotations }, target) {
  const text = typeof answerText === 'string' ? answerText : '';
  const brand = findMentions(text, target.brandNames || []);
  const citations = extractCitations(annotations, target.targetHost);
  const targetCitations = citations.filter((c) => c.isTarget);
  return {
    brandMentioned: brand.length > 0,
    brandMentionCount: brand.reduce((n, m) => n + m.count, 0),
    competitorMentions: findMentions(text, target.competitors || []),
    citationCount: citations.length,
    targetCitationCount: targetCitations.length,
    targetPages: [...new Set(targetCitations.map((c) => c.normalizedUrl))],
    citations: citations.map((c) => ({ url: c.url, normalizedUrl: c.normalizedUrl, title: c.title, isTarget: c.isTarget })),
  };
}

const ratio = (num, den) => (den > 0 ? Math.round((num / den) * 10_000) / 10_000 : null);

function summarize(executions, target, { brandReliable }) {
  const succeeded = executions.filter((e) => e.status === 'succeeded');
  const failed = executions.filter((e) => e.status === 'failed');
  const skipped = executions.filter((e) => e.status === 'skipped');
  const attempted = succeeded.length + failed.length;

  const analyses = succeeded.map((e) => e.analysis || analyzeAnswer(e, target));
  const mentioning = analyses.filter((a) => a.brandMentioned).length;
  const citing = analyses.filter((a) => a.targetCitationCount > 0).length;
  const pages = new Set(analyses.flatMap((a) => a.targetPages));
  const competitorTotals = new Map();
  for (const a of analyses) {
    for (const m of a.competitorMentions) {
      const cur = competitorTotals.get(m.name) || { name: m.name, responses: 0, occurrences: 0 };
      cur.responses += 1;
      cur.occurrences += m.count;
      competitorTotals.set(m.name, cur);
    }
  }

  const haveHost = Boolean(target.targetHost);
  return {
    prompts: executions.length,
    attempted,
    succeeded: succeeded.length,
    failed: failed.length,
    skipped: skipped.length,
    executionSuccessRate: ratio(succeeded.length, attempted),
    successfulResponses: succeeded.length,
    brandMentions: mentioning,
    brandMentionRate: brandReliable ? ratio(mentioning, succeeded.length) : null,
    responsesWithWebsiteCitation: haveHost ? citing : null,
    websiteCitationRate: haveHost ? ratio(citing, succeeded.length) : null,
    uniqueCitedPages: haveHost ? pages.size : null,
    citationOccurrences: haveHost ? analyses.reduce((n, a) => n + a.targetCitationCount, 0) : null,
    competitorMentions: {
      totalOccurrences: [...competitorTotals.values()].reduce((n, c) => n + c.occurrences, 0),
      competitors: [...competitorTotals.values()].sort((a, b) => b.occurrences - a.occurrences || a.name.localeCompare(b.name)),
      note: 'Only competitors known to Odito are counted; names a model mentions that are not in the business profile are not classified.',
    },
  };
}

/**
 * @param {object[]} executions  { status, branded, answerText?, annotations?, analysis? }
 * @param {{brandNames:string[], competitors:string[], targetHost:string|null, brandMatchReliable?:boolean, nameVerified?:boolean}} target
 */
export function computeVisibilityMetrics(executions, target) {
  const list = Array.isArray(executions) ? executions : [];
  const brandReliable = target.brandMatchReliable !== false && (target.brandNames || []).length > 0;
  const opts = { brandReliable };
  const overall = summarize(list, target, opts);

  const limitations = [];
  if (!brandReliable) limitations.push('BRAND_NAME_UNRELIABLE');
  if (target.nameVerified === false) limitations.push('BRAND_NAME_UNVERIFIED');
  if (!target.targetHost) limitations.push('NO_TARGET_HOST');
  if (overall.succeeded === 0) limitations.push('NO_SUCCESSFUL_RESPONSES');
  else if (overall.succeeded < overall.prompts) limitations.push('PARTIAL_EXECUTION');
  if (!(target.competitors || []).length) limitations.push('NO_KNOWN_COMPETITORS');

  return {
    overall,
    branded: summarize(list.filter((e) => e.branded === true), target, opts),
    nonBranded: summarize(list.filter((e) => e.branded === false), target, opts),
    partial: overall.succeeded > 0 && overall.succeeded < overall.prompts,
    limitations,
    sampled: true,
  };
}

export default { analyzeAnswer, computeVisibilityMetrics };
