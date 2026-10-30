import { QUESTIONS_PER_RUN } from '../config/googleAioConfig.js';

/**
 * Run metrics, computed ONLY from persisted evidence documents (never from the frontend, never from in-memory counters).
 * Every rate states its denominator, and missing evidence is excluded from the denominator instead of being counted as "no":
 *
 *   aiOverviewRate    overviews returned          / questions answered successfully
 *   brandMentionRate  overviews naming the brand  / overviews that could be analysed (they have text)
 *   websiteCitationRate overviews citing the owned host / overviews whose source references could be inspected
 *   uniqueCitedPages  DISTINCT normalised owned URLs across the run (citation occurrences are reported apart)
 * A rate is null when its denominator is 0 ("cannot be computed"), never 0.
 */

export const METRICS_SCHEMA_VERSION = 1;

const rate = (n, d) => (d > 0 ? Math.round((n / d) * 10_000) / 10_000 : null);
const round6 = (n) => Math.round(n * 1e6) / 1e6;

/**
 * @param {object[]} docs  evidence documents of ONE run
 * @param {{competitors?:string[], brandMatchReliable?:boolean}} target
 * @param {{questionsPlanned?:number, costUnit?:string}} [opts]
 */
export function computeRunMetrics(docs, target = {}, { questionsPlanned = QUESTIONS_PER_RUN, costUnit = 'USD' } = {}) {
  const succeeded = docs.filter((d) => d.status === 'succeeded');
  const failed = docs.filter((d) => d.status === 'failed').length;
  const skipped = docs.filter((d) => d.status === 'skipped').length;
  const cancelled = docs.filter((d) => d.status === 'cancelled').length;

  const withOverview = succeeded.filter((d) => d.aiOverview?.present === true);
  const withoutOverview = succeeded.filter((d) => d.aiOverview?.present === false).length;
  const analysed = withOverview.filter((d) => d.analysis?.contentStatus === 'analysed');
  const mentioned = analysed.filter((d) => d.analysis?.mention?.mentioned === true);
  const ambiguous = analysed.filter((d) => d.analysis?.mention?.status === 'ambiguous').length;
  const inspected = withOverview.filter((d) => d.analysis?.referencesStatus === 'available');
  const citing = inspected.filter((d) => d.analysis?.ownedCited === true);

  const pages = new Set();
  let occurrences = 0;
  for (const d of citing) {
    for (const p of d.analysis.ownedPages || []) pages.add(p);
    occurrences += d.analysis.ownedCitationCount || 0;
  }

  // Competitors are the configured ones only; mention and citation are kept apart, each over its own denominator.
  const names = (target.competitors || []).filter(Boolean);
  const competitors = names.map((name) => {
    const per = (d) => (d.analysis?.competitors || []).find((c) => c.name === name);
    const mentionedIn = analysed.filter((d) => per(d)?.mentioned === true);
    const citedIn = inspected.filter((d) => per(d)?.cited === true);
    return {
      name,
      mentions: { count: mentionedIn.length, denominator: analysed.length, rate: rate(mentionedIn.length, analysed.length), questionIds: mentionedIn.map((d) => d.questionId) },
      citations: { count: citedIn.length, denominator: inspected.length, rate: rate(citedIn.length, inspected.length), questionIds: citedIn.map((d) => d.questionId) },
    };
  });

  let amount = 0;
  let known = 0;
  let unknownCount = 0;
  for (const d of succeeded) {
    if (typeof d.cost === 'number') { amount += d.cost; known += 1; } else unknownCount += 1;
  }
  // A failed request may also have been billed; its cost is unknown unless the provider said so.
  for (const d of docs.filter((x) => x.status === 'failed')) if (typeof d.cost === 'number') { amount += d.cost; known += 1; }

  const limitations = [];
  if (target.brandMatchReliable === false) limitations.push('BRAND_NAME_UNRELIABLE');
  if (!names.length) limitations.push('NO_KNOWN_COMPETITORS');
  if (succeeded.length && !withOverview.length) limitations.push('NO_AI_OVERVIEWS_RETURNED');
  if (withOverview.length > inspected.length) limitations.push('SOME_OVERVIEWS_HAVE_NO_SOURCE_REFERENCES');
  if (withOverview.length > analysed.length) limitations.push('SOME_OVERVIEWS_HAVE_NO_TEXT');

  return {
    schemaVersion: METRICS_SCHEMA_VERSION,
    questionsPlanned,
    questions: { planned: questionsPlanned, answered: succeeded.length, failed, skipped, cancelled, pending: Math.max(0, questionsPlanned - docs.filter((d) => ['succeeded', 'failed', 'skipped', 'cancelled'].includes(d.status)).length) },
    partial: succeeded.length < questionsPlanned,
    aiOverview: { count: withOverview.length, noOverviewCount: withoutOverview, denominator: succeeded.length, rate: rate(withOverview.length, succeeded.length) },
    brandMention: { count: mentioned.length, ambiguous, denominator: analysed.length, rate: target.brandMatchReliable === false ? null : rate(mentioned.length, analysed.length) },
    websiteCitation: { count: citing.length, denominator: inspected.length, rate: rate(citing.length, inspected.length), excluded: withOverview.length - inspected.length },
    uniqueCitedPages: { count: pages.size, pages: [...pages], citationOccurrences: occurrences },
    competitors,
    cost: { amount: known > 0 ? round6(amount) : null, unit: known > 0 ? costUnit : null, unknownCount },
    limitations,
  };
}

export default { computeRunMetrics, METRICS_SCHEMA_VERSION };
