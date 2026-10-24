import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAnswer, computeVisibilityMetrics } from '../services/visibilityMetricsService.js';

const target = { brandNames: ['ASG Eye Hospital'], competitors: ['Sankara Eye Care', 'Vasan Eye Care'], targetHost: 'asgeye.example', brandMatchReliable: true, nameVerified: true };
const ok = (branded, answerText, annotations = []) => ({ status: 'succeeded', branded, answerText, annotations });
const bad = (branded, status = 'failed') => ({ status, branded });

describe('analyzeAnswer', () => {
  test('brand mention, repeated and distinct target citations, tracking params, competitors', () => {
    const a = analyzeAnswer({
      answerText: 'ASG Eye Hospital is strong; asg eye hospital offers LASIK. Sankara Eye Care is a rival.',
      annotations: [
        { url: 'https://www.asgeye.example/lasik?utm_source=chatgpt.com' },
        { url: 'https://asgeye.example/lasik/' },
        { url: 'https://blog.asgeye.example/post' },
        { url: 'https://example.org/asgeye.example' },
        { url: 'https://asgeye.example.attacker.test/x' },
        { url: 'garbage' },
      ],
    }, target);
    assert.equal(a.brandMentioned, true);
    assert.equal(a.brandMentionCount, 2);
    assert.equal(a.targetCitationCount, 3);
    assert.deepEqual(a.targetPages.sort(), ['https://asgeye.example/lasik', 'https://blog.asgeye.example/post']);
    assert.deepEqual(a.competitorMentions, [{ name: 'Sankara Eye Care', count: 1 }]);
  });

  test('empty / malformed input does not throw', () => {
    const a = analyzeAnswer({ answerText: null, annotations: 'x' }, target);
    assert.equal(a.brandMentioned, false);
    assert.equal(a.citationCount, 0);
  });
});

describe('computeVisibilityMetrics', () => {
  test('full run: rates use successful responses, branded and non-branded are separate', () => {
    const m = computeVisibilityMetrics([
      ok(false, 'Top clinics: Sankara Eye Care.', [{ url: 'https://other.example/a' }]),
      ok(false, 'ASG Eye Hospital offers LASIK.', [{ url: 'https://asgeye.example/lasik' }, { url: 'https://asgeye.example/lasik?gclid=1' }]),
      ok(true, 'ASG Eye Hospital is known for eye care.', [{ url: 'https://asgeye.example/' }]),
      ok(true, 'ASG Eye Hospital vs Sankara Eye Care and Vasan Eye Care.', []),
      ok(false, 'Try several clinics.', []),
    ], target);
    const o = m.overall;
    assert.equal(o.attempted, 5); assert.equal(o.succeeded, 5); assert.equal(o.executionSuccessRate, 1);
    assert.equal(o.brandMentions, 3); assert.equal(o.brandMentionRate, 0.6);
    assert.equal(o.responsesWithWebsiteCitation, 2); assert.equal(o.websiteCitationRate, 0.4);
    assert.equal(o.uniqueCitedPages, 2); // /lasik (cited twice) and the root
    assert.equal(o.citationOccurrences, 3);
    assert.equal(o.competitorMentions.totalOccurrences, 3);
    assert.deepEqual(o.competitorMentions.competitors.map((c) => c.name), ['Sankara Eye Care', 'Vasan Eye Care']);
    assert.equal(m.nonBranded.successfulResponses, 3); assert.equal(m.nonBranded.brandMentionRate, 0.3333);
    assert.equal(m.branded.successfulResponses, 2); assert.equal(m.branded.brandMentionRate, 1);
    assert.equal(m.partial, false);
    assert.ok(!m.limitations.includes('PARTIAL_EXECUTION'));
  });

  test('partial run: 3 of 5 succeed -> rates over 3, success rate over 5, flagged partial, failures not counted as zero visibility', () => {
    const m = computeVisibilityMetrics([
      ok(false, 'ASG Eye Hospital is listed.', [{ url: 'https://asgeye.example/x' }]),
      ok(false, 'Nothing relevant.'),
      ok(true, 'ASG Eye Hospital is an eye hospital.'),
      bad(true), bad(false),
    ], target);
    assert.equal(m.overall.attempted, 5);
    assert.equal(m.overall.succeeded, 3);
    assert.equal(m.overall.executionSuccessRate, 0.6);
    assert.equal(m.overall.brandMentionRate, 0.6667); // 2 of 3, NOT 2 of 5
    assert.equal(m.overall.websiteCitationRate, 0.3333); // 1 of 3
    assert.equal(m.partial, true);
    assert.ok(m.limitations.includes('PARTIAL_EXECUTION'));
  });

  test('skipped executions are not attempts', () => {
    const m = computeVisibilityMetrics([ok(false, 'x'), ok(false, 'y'), bad(false, 'skipped'), bad(true, 'skipped'), bad(true, 'skipped')], target);
    assert.equal(m.overall.attempted, 2);
    assert.equal(m.overall.skipped, 3);
    assert.equal(m.overall.executionSuccessRate, 1);
    assert.equal(m.partial, true);
  });

  test('zero successful responses: visibility rates are null (not 0), success rate is 0', () => {
    const m = computeVisibilityMetrics([bad(false), bad(false), bad(true), bad(true), bad(false)], target);
    assert.equal(m.overall.executionSuccessRate, 0);
    assert.equal(m.overall.brandMentionRate, null);
    assert.equal(m.overall.websiteCitationRate, null);
    assert.equal(m.overall.uniqueCitedPages, 0);
    assert.ok(m.limitations.includes('NO_SUCCESSFUL_RESPONSES'));
    assert.equal(m.partial, false);
  });

  test('nothing attempted at all', () => {
    assert.equal(computeVisibilityMetrics([], target).overall.executionSuccessRate, null);
  });

  test('unreliable brand name: mention rate withheld, raw count kept, limitation reported', () => {
    const m = computeVisibilityMetrics([ok(false, 'ASG Eye Hospital is here.')], { ...target, brandMatchReliable: false });
    assert.equal(m.overall.brandMentionRate, null);
    assert.equal(m.overall.brandMentions, 1);
    assert.ok(m.limitations.includes('BRAND_NAME_UNRELIABLE'));
  });

  test('unverified name and missing host are reported; citation metrics are null without a host', () => {
    const m = computeVisibilityMetrics([ok(false, 'x', [{ url: 'https://a.example' }])], { ...target, nameVerified: false, targetHost: null });
    assert.ok(m.limitations.includes('BRAND_NAME_UNVERIFIED'));
    assert.ok(m.limitations.includes('NO_TARGET_HOST'));
    assert.equal(m.overall.websiteCitationRate, null);
    assert.equal(m.overall.uniqueCitedPages, null);
  });

  test('unknown competitors are not classified; none known is reported', () => {
    const m = computeVisibilityMetrics([ok(false, 'Totally Unknown Clinic is great.')], { ...target, competitors: [] });
    assert.equal(m.overall.competitorMentions.totalOccurrences, 0);
    assert.ok(m.limitations.includes('NO_KNOWN_COMPETITORS'));
  });

  test('uses a stored analysis when present', () => {
    const analysis = { brandMentioned: true, brandMentionCount: 1, competitorMentions: [], citationCount: 0, targetCitationCount: 0, targetPages: [], citations: [] };
    const m = computeVisibilityMetrics([{ status: 'succeeded', branded: false, analysis }], target);
    assert.equal(m.overall.brandMentions, 1);
  });
});
