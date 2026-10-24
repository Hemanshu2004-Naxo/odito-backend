import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { computeApprovedQuestionMetrics } from '../services/approvedQuestionMetrics.js';
import { detectRecommendation } from '../services/recommendationDetection.js';
import { extractCitations } from '../services/citationNormalizationService.js';
import { analyzeAnswer } from '../services/visibilityMetricsService.js';
import { compareRuns, compareQuestionSnapshots, buildTrend, pickRunFigures } from '../services/runComparisonService.js';
import { buildEvidenceFilter } from '../evidence/services/evidenceService.js';

const BRAND = ['ASG Eye Hospital'];
const target = { brandNames: BRAND, competitors: ['Sankara Eye Care', 'Vasan Eye Care'], targetHost: 'asgeye.example', brandMatchReliable: true, nameVerified: true };

function ev({ status = 'succeeded', group = 'visibility', intent = 'discovery', answer = '', annotations = [], cost = 0.01, recommended = null } = {}) {
  const citations = extractCitations(annotations, target.targetHost);
  const a = analyzeAnswer({ answerText: answer, annotations }, target);
  return {
    status, group, intent, cost: status === 'succeeded' ? cost : null, citations, firstPartyPages: a.targetPages,
    externalDomains: [...new Set(citations.filter((c) => c.valid && !c.isTarget).map((c) => c.host))],
    analysis: { brandMentioned: a.brandMentioned, recommended, competitorMentions: a.competitorMentions },
  };
}

// ─────────────────────────────── formulas ───────────────────────────────
describe('metric formulas (documented denominators)', () => {
  // 4 answered discovery questions, 1 failed, 1 skipped, 2 brand diagnostic answers that must NOT count.
  const docs = [
    ev({ answer: 'ASG Eye Hospital is recommended.', recommended: true, annotations: [{ url: 'https://www.asgeye.example/lasik?utm_source=chatgpt.com' }, { url: 'https://asgeye.example/lasik#top' }] }),
    ev({ answer: 'ASG Eye Hospital exists. Sankara Eye Care too.', recommended: false, annotations: [{ url: 'https://asgeye.example/cataract' }] }),
    ev({ answer: 'Sankara Eye Care and Vasan Eye Care.', annotations: [{ url: 'https://other.example/a' }] }),
    ev({ answer: 'Nothing relevant.' }),
    ev({ status: 'failed' }),
    ev({ status: 'skipped' }),
    ev({ group: 'brand_reputation', intent: 'brand_reputation', answer: 'ASG Eye Hospital is known for LASIK.', recommended: null, annotations: [{ url: 'https://asgeye.example/about' }] }),
    ev({ group: 'brand_reputation', intent: 'brand_reputation', answer: 'ASG Eye Hospital offers surgery.', annotations: [{ url: 'https://asgeye.example/services' }] }),
  ];
  const m = computeApprovedQuestionMetrics(docs, target, { questionsPlanned: 8, costUnit: 'provider_reported' });
  const o = m.overview;

  test('eligible answers = answered discovery questions only (not failed, skipped or brand diagnostic)', () => {
    assert.equal(o.eligibleAnswers, 4);
  });
  test('visibility rate = answers mentioning the business / eligible answers', () => {
    assert.equal(o.visibilityAnswers, 2);
    assert.equal(o.visibilityRate, 0.5);
  });
  test('recommendation rate = answers where the business is recommended / eligible answers (a mention is not a recommendation)', () => {
    assert.equal(o.recommendationAnswers, 1);
    assert.equal(o.recommendationRate, 0.25);
    assert.equal(o.recommendationMethod, 'heuristic_v1');
  });
  test('website citation rate = answers citing >= 1 first-party page / eligible answers', () => {
    assert.equal(o.websiteCitationAnswers, 2);
    assert.equal(o.websiteCitationRate, 0.5);
  });
  test('unique cited pages de-duplicate tracking params, fragments and www; occurrences count every citation', () => {
    assert.equal(o.uniqueCitedPages, 2); // /lasik (x2 forms) and /cataract; brand-diagnostic pages excluded
    assert.equal(o.citationOccurrences, 3);
  });
  test('competitor visibility uses the same denominator and only tracked competitors', () => {
    assert.equal(o.competitors.configured, true);
    const sankara = o.competitors.mentioned.find((c) => c.name === 'Sankara Eye Care');
    assert.deepEqual([sankara.answers, sankara.rate], [2, 0.5]);
    const vasan = o.competitors.mentioned.find((c) => c.name === 'Vasan Eye Care');
    assert.deepEqual([vasan.answers, vasan.rate], [1, 0.25]);
  });
  test('brand diagnostic answers are reported separately and do not move the headline', () => {
    assert.equal(m.brandReputation.answersMentioningBrand, 2);
    const withoutBrand = computeApprovedQuestionMetrics(docs.filter((d) => d.group === 'visibility'), target);
    assert.deepEqual(withoutBrand.overview.visibilityRate, o.visibilityRate);
    assert.deepEqual(withoutBrand.overview.uniqueCitedPages, o.uniqueCitedPages);
  });
  test('zero eligible answers -> every rate is unavailable (null), never 0, and nothing divides by zero', () => {
    const none = computeApprovedQuestionMetrics([ev({ status: 'failed' }), ev({ status: 'skipped' })], target);
    for (const k of ['visibilityRate', 'recommendationRate', 'websiteCitationRate']) assert.equal(none.overview[k], null, k);
    assert.equal(none.overview.eligibleAnswers, 0);
    assert.deepEqual(computeApprovedQuestionMetrics([], target).overview.visibilityRate, null);
  });
  test('no competitors configured is stated, not shown as zero visibility', () => {
    const noComp = computeApprovedQuestionMetrics(docs, { ...target, competitors: [] });
    assert.equal(noComp.overview.competitors.configured, false);
    assert.ok(noComp.limitations.includes('NO_KNOWN_COMPETITORS'));
  });
  test('deterministic: the same evidence gives the same metrics', () => {
    assert.deepEqual(computeApprovedQuestionMetrics(docs, target), computeApprovedQuestionMetrics([...docs], target));
  });
});

// ─────────────────────────────── recommendation detector accuracy ───────────────────────────────
// A hand-labelled sample of answer shapes ChatGPT produces. This MEASURES heuristic_v1; it is not proof of accuracy on real traffic.
const LABELLED = [
  ['Top eye hospitals in Mumbai:\n1. **ASG Eye Hospital** - cataract and LASIK\n2. Other Clinic', true],
  ['- ASG Eye Hospital: known for retina care', true],
  ['ASG Eye Hospital is a well-known choice for LASIK in Mumbai.', true],
  ['I recommend ASG Eye Hospital for cataract surgery.', true],
  ['ASG Eye Hospital is highly rated by patients.', true],
  ['Consider ASG Eye Hospital if you need glaucoma care.', true],
  ['### ASG Eye Hospital\nOffers comprehensive eye care.', true],
  ['ASG Eye Hospital is one of the leading eye hospitals in the city.', true],
  ['A good option is ASG Eye Hospital, which offers LASIK.', true],
  ['ASG Eye Hospital stands out for cataract surgery.', true],
  ['ASG Eye Hospital opened a new branch in 2020.', false],
  ['Patients sometimes compare prices with ASG Eye Hospital.', false],
  ['I would not recommend ASG Eye Hospital based on reviews.', false],
  ['I could not find reliable information about ASG Eye Hospital.', false],
  ['I do not have information on ASG Eye Hospital.', false],
  ['Avoid ASG Eye Hospital if you need emergency care at night.', false],
  ['Top choices: Sankara Eye Care, Vasan Eye Care.', false],
  ['1. Sankara Eye Care\n2. Vasan Eye Care', false],
  ['ASG Eye Hospital is located near the station.', false],
  ['The address listed for ASG Eye Hospital may be outdated.', false],
];

describe('recommendation detector (heuristic_v1) measured on a labelled sample', () => {
  test('precision and recall on the sample are reported and meet a minimum bar', () => {
    let tp = 0; let fp = 0; let fn = 0; let tn = 0;
    const misses = [];
    for (const [text, expected] of LABELLED) {
      const got = detectRecommendation(text, BRAND).recommended;
      if (got && expected) tp += 1; else if (got && !expected) { fp += 1; misses.push(['FP', text]); } else if (!got && expected) { fn += 1; misses.push(['FN', text]); } else tn += 1;
    }
    const precision = tp / (tp + fp);
    const recall = tp / (tp + fn);
    // Reported so the number is visible in CI output; the UI labels the metric "estimated" regardless.
    console.log(`[heuristic_v1] sample=${LABELLED.length} precision=${precision.toFixed(2)} recall=${recall.toFixed(2)} misses=${JSON.stringify(misses)}`);
    assert.ok(precision >= 0.9, `precision ${precision}`);
    assert.ok(recall >= 0.8, `recall ${recall}`);
  });
});

// ─────────────────────────────── comparisons and trend ───────────────────────────────
const snap = (over = []) => [
  { questionId: 'q1', group: 'visibility', intent: 'discovery', text: 'Which eye hospitals in Mumbai offer LASIK?', location: 'Mumbai', searchCity: 'Mumbai' },
  { questionId: 'q2', group: 'visibility', intent: 'problem_solving', text: 'Where can I get help with blurred vision in Mumbai?', location: 'Mumbai', searchCity: 'Mumbai' },
  { questionId: 'b1', group: 'brand_reputation', intent: 'brand_reputation', text: 'What is ASG known for?' },
  ...over,
];
const run = (id, o = {}) => ({ _id: id, createdAt: new Date(`2026-10-${10 + id.length}T10:00:00Z`), status: 'completed', questionSetVersion: 1, questionSnapshot: snap(), metrics: { visibility: { succeeded: 10, attempted: 10, failed: 0, skipped: 0, brandMentionRate: 0.4, recommendationRate: 0.2, websiteCitationRate: 0.3, uniqueFirstPartyPages: 3, firstPartyCitationOccurrences: 5 } }, ...o });

describe('historical comparability', () => {
  test('same set version and identical questions -> equivalent, with deltas', () => {
    const r = compareRuns(run('a'), run('bb', { metrics: { visibility: { ...run('x').metrics.visibility, brandMentionRate: 0.5 } } }));
    assert.equal(r.equivalent, true);
    assert.equal(r.delta.visibilityRate, 0.1);
    assert.equal(r.questions.comparable, 2);
  });
  test('a different set version is flagged and no delta is computed', () => {
    const r = compareRuns(run('a'), run('bb', { questionSetVersion: 2 }));
    assert.equal(r.equivalent, false);
    assert.ok(r.reasons.includes('DIFFERENT_QUESTION_SET_VERSION'));
    assert.equal(r.delta, null);
  });
  test('changed wording, intent or target location of the same question id is non-equivalent, with the reason', () => {
    const changed = run('bb', { questionSnapshot: snap().map((q) => (q.questionId === 'q1' ? { ...q, text: 'Which eye hospitals in Pune offer LASIK?', location: 'Pune', searchCity: 'Pune' } : q)) });
    const c = compareQuestionSnapshots(run('a'), changed);
    assert.equal(c.equivalent, false);
    assert.deepEqual(c.changed[0].reasons, ['text', 'location']);
    const added = run('bb', { questionSnapshot: snap([{ questionId: 'q3', group: 'visibility', intent: 'discovery', text: 'x?' }]) });
    assert.ok(compareQuestionSnapshots(run('a'), added).reasons.includes('DIFFERENT_QUESTIONS'));
  });
  test('brand diagnostic questions do not affect comparability', () => {
    const r = compareQuestionSnapshots(run('a'), run('bb', { questionSnapshot: snap().filter((q) => q.group === 'visibility') }));
    assert.equal(r.equivalent, true);
  });
  test('trend marks a point comparable only when its set version matches the previous point', () => {
    const t = buildTrend([run('a'), run('bb'), run('ccc', { questionSetVersion: 2 })]);
    assert.deepEqual(t.map((p) => p.comparableWithPrevious), [false, true, false]);
    assert.equal(t[0].figures.visibilityRate, 0.4);
    assert.equal(pickRunFigures({ metrics: null }), null);
  });
});

// ─────────────────────────────── evidence filter safety ───────────────────────────────
describe('evidence search / filter is allow-listed', () => {
  test('known filters map to fields; booleans imply answered results', () => {
    assert.deepEqual(buildEvidenceFilter({ mentioned: 'true', intent: 'discovery' }), { intent: 'discovery', status: 'succeeded', 'analysis.brandMentioned': true });
    assert.deepEqual(buildEvidenceFilter({ cited: 'false' }), { status: 'succeeded', 'firstPartyPages.0': { $exists: false } });
  });
  test('operators, bad values and regex metacharacters cannot get through', () => {
    assert.deepEqual(buildEvidenceFilter({ status: { $ne: 'x' }, group: 'admin', intent: 'a;drop', mentioned: 'maybe' }), {});
    const f = buildEvidenceFilter({ q: '.*(a+)+$' });
    assert.equal(f.questionText.$regex, '\\.\\*\\(a\\+\\)\\+\\$');
    assert.equal(buildEvidenceFilter({ citedUrl: 'javascript:alert(1)' }).firstPartyPages, undefined);
    assert.equal(buildEvidenceFilter({ q: 'x'.repeat(500) }).questionText.$regex.length, 100);
  });
});
