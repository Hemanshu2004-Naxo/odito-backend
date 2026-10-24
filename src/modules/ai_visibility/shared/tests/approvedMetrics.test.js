import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { detectRecommendation } from '../services/recommendationDetection.js';
import { computeApprovedQuestionMetrics } from '../services/approvedQuestionMetrics.js';
import { extractCitations } from '../services/citationNormalizationService.js';
import { analyzeAnswer } from '../services/visibilityMetricsService.js';
import { buildEventPayload } from '../../chatgpt_visibility/services/visibilityEvents.js';

const BRAND = ['ASG Eye Hospital'];
const target = { brandNames: BRAND, competitors: ['Sankara Eye Care'], targetHost: 'asgeye.example', brandMatchReliable: true, nameVerified: true };

describe('recommendation detection (heuristic_v1)', () => {
  test('a list item / bold option naming the brand is a recommendation', () => {
    assert.equal(detectRecommendation('Top options:\n1. **ASG Eye Hospital** - LASIK and cataract\n2. Other Clinic', BRAND).recommended, true);
    assert.equal(detectRecommendation('- ASG Eye Hospital offers LASIK.', BRAND).recommended, true);
  });
  test('a recommendation cue in the same sentence counts', () => {
    assert.equal(detectRecommendation('ASG Eye Hospital is a well-known choice in Ahmedabad.', BRAND).recommended, true);
  });
  test('a bare mention is NOT a recommendation (mention != recommendation)', () => {
    const r = detectRecommendation('Some patients travelled from ASG Eye Hospital to other cities for work.', BRAND);
    assert.equal(r.recommended, false);
  });
  test('negation and "no information" are not recommendations', () => {
    assert.equal(detectRecommendation('I would not recommend ASG Eye Hospital.', BRAND).recommended, false);
    assert.equal(detectRecommendation('I could not verify ASG Eye Hospital, so I am unable to find information about it.', BRAND).recommended, false);
    assert.equal(detectRecommendation('Best clinics include Sankara Eye Care.', BRAND).recommended, false);
  });
});

// evidence documents as persisted by the worker (just the fields metrics read)
function ev({ status = 'succeeded', group = 'visibility', intent = 'discovery', answer = '', annotations = [], cost = 0.01, recommended = null } = {}) {
  const citations = extractCitations(annotations, target.targetHost);
  const a = analyzeAnswer({ answerText: answer, annotations }, target);
  return {
    status, group, intent, cost: status === 'succeeded' ? cost : null,
    citations, firstPartyPages: a.targetPages, externalDomains: [...new Set(citations.filter((c) => c.valid && !c.isTarget).map((c) => c.host))],
    analysis: { brandMentioned: a.brandMentioned, recommended, competitorMentions: a.competitorMentions },
  };
}

describe('approved-question metrics: denominators and distinctions', () => {
  const docs = [
    ev({ answer: 'ASG Eye Hospital is great.', recommended: true, annotations: [{ url: 'https://www.asgeye.example/lasik?utm_source=chatgpt.com' }, { url: 'https://other.example/x' }] }),
    ev({ answer: 'ASG Eye Hospital exists.', recommended: false, annotations: [{ url: 'https://asgeye.example/lasik' }, { url: 'https://asgeye.example/cataract#top' }] }),
    ev({ answer: 'No brand here, only Sankara Eye Care.', annotations: [{ url: 'https://third.example/a' }] }),
    ev({ status: 'failed' }),
    ev({ status: 'skipped' }),
    ev({ group: 'brand_reputation', intent: 'brand_reputation', answer: 'ASG Eye Hospital is known for LASIK.', annotations: [{ url: 'https://asgeye.example/about' }] }),
  ];
  const m = computeApprovedQuestionMetrics(docs, target, { questionsPlanned: 6, costUnit: 'provider_reported', budget: 1 });

  test('attempted = succeeded + failed; skipped was never sent', () => {
    assert.deepEqual([m.visibility.questions, m.visibility.attempted, m.visibility.succeeded, m.visibility.failed, m.visibility.skipped], [5, 4, 3, 1, 1]);
    assert.equal(m.visibility.executionSuccessRate, 0.75);
  });

  test('rates use succeeded answers; the attempted-based rate counts failures as "not mentioned" and is lower', () => {
    assert.equal(m.visibility.answersMentioningBrand, 2);
    assert.equal(m.visibility.brandMentionRate, 0.6667); // 2 / 3 succeeded
    assert.equal(m.visibility.brandMentionRateOfAttempted, 0.5); // 2 / 4 attempted
    assert.ok(m.visibility.brandMentionRateOfAttempted < m.visibility.brandMentionRate);
  });

  test('mention, recommendation and website citation are counted separately', () => {
    assert.equal(m.visibility.answersMentioningBrand, 2);
    assert.equal(m.visibility.answersRecommendingBrand, 1);
    assert.equal(m.visibility.answersCitingWebsite, 2);
  });

  test('tracking parameters and fragments do not create extra unique pages; external domains are distinct hosts', () => {
    // /lasik is cited twice (once with utm_*, once without): one page. /cataract#top -> /cataract.
    assert.equal(m.visibility.uniqueFirstPartyPages, 2);
    assert.equal(m.visibility.firstPartyCitationOccurrences, 3);
    assert.equal(m.visibility.uniqueFirstPartyUrls, 3); // three distinct RAW urls
    assert.equal(m.visibility.uniqueExternalDomains, 2); // other.example, third.example
  });

  test('the brand-reputation group is separate and never feeds the headline overview', () => {
    assert.equal(m.brandReputation.answersMentioningBrand, 1);
    assert.equal(m.overview.mentions, 2);
    assert.equal(m.overview.citedPages, 2);
    assert.equal(m.overview.visibilityScore, 67);
    assert.equal(m.overview.basedOnAnswers, 3);
  });

  test('per-intent metrics are reported and competitor mentions come from known competitors only', () => {
    assert.equal(m.byIntent.discovery.succeeded, 3);
    assert.equal(m.visibility.competitorMentions.competitors[0].name, 'Sankara Eye Care');
  });

  test('flags partial execution; a failed question is never "no visibility"', () => {
    assert.equal(m.partial, true);
    assert.ok(m.limitations.includes('PARTIAL_EXECUTION') && m.limitations.includes('SAMPLED_QUESTIONS'));
    const allFailed = computeApprovedQuestionMetrics([ev({ status: 'failed' }), ev({ status: 'failed' })], target);
    assert.equal(allFailed.visibility.brandMentionRate, null);
    assert.equal(allFailed.overview.visibilityScore, null);
    assert.ok(allFailed.limitations.includes('NO_SUCCESSFUL_VISIBILITY_ANSWERS'));
  });

  test('unknown cost is counted as unknown, never as zero', () => {
    const withUnknown = computeApprovedQuestionMetrics([ev({ cost: 0.02 }), ev({ cost: null })], target, { costUnit: 'provider_reported', budget: 1 });
    assert.equal(withUnknown.cost.knownTotal, 0.02);
    assert.equal(withUnknown.cost.knownCount, 1);
    assert.equal(withUnknown.cost.unknownCostCount, 1);
    assert.ok(withUnknown.limitations.includes('UNKNOWN_COST_PRESENT') && withUnknown.limitations.includes('COST_BUDGET_NOT_FULLY_ENFORCEABLE'));
    const none = computeApprovedQuestionMetrics([ev({ cost: null })], target);
    assert.equal(none.cost.knownTotal, null); // not 0
  });

  test('an unreliable brand name suppresses the mention/recommendation rates', () => {
    const r = computeApprovedQuestionMetrics(docs, { ...target, brandMatchReliable: false });
    assert.equal(r.visibility.brandMentionRate, null);
    assert.ok(r.limitations.includes('BRAND_NAME_UNRELIABLE'));
  });
});

describe('visibility events: allow-listed payloads', () => {
  const run = { _id: 'r1', projectId: 'p1', status: 'running', executionMode: 'approved_questions', questionSetId: 's1', questionSetVersion: 3, progress: { completed: 2, total: 40, stage: 'running' } };
  test('carries identifiers and counters, never text, answers, costs or lease data', () => {
    const p = buildEventPayload({ ...run, lockedBy: 'worker-x', lease: { expiresAt: new Date() }, executions: [{ answerText: 'SECRET' }], questionSnapshot: [{ text: 'SECRET Q' }] },
      { questionId: 'q_1', questionStatus: 'succeeded', succeeded: 2, answer: 'SECRET ANSWER', questionText: 'SECRET', cost: 1, lockedBy: 'w' });
    const json = JSON.stringify(p);
    assert.doesNotMatch(json, /SECRET|worker-x|lease|lockedBy|cost/i);
    assert.equal(p.executionMode, 'approved_questions');
    assert.equal(p.questionSetVersion, 3);
    assert.equal(p.totalPrompts, 40);
    assert.equal(p.questionId, 'q_1');
  });
  test('legacy payloads are unchanged (no approved-question fields)', () => {
    const p = buildEventPayload({ _id: 'r', projectId: 'p', status: 'completed', progress: { completed: 5, total: 5, stage: 'completed' } });
    assert.equal('executionMode' in p, false);
    assert.equal(p.totalPrompts, 5);
  });
});
