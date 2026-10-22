import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { validateStrategyOutput, buildStrategyToolSchema, LIMITS } from './strategyOutputSchema.js';
import { summarizeValidationError, summarizeValidationErrors, describeProviderFailure, attemptRecord, flattenAttempts, VALIDATION_CODES } from './strategyDiagnostics.js';
import { buildSystemPrompt } from './socialAIStrategyPromptBuilder.js';
import { validRawStrategy } from '../../testSupport/aiStrategyFixtures.js';

/**
 * The strategy output CONTRACT: the tool schema the model is given, the prompt, and the server validator describe one structure,
 * harmless format slips are normalised deterministically, real business-rule violations are never normalised away, and every
 * rejection is explained with a sanitised path + code + rule (never a value).
 */

const clone = (v) => JSON.parse(JSON.stringify(v));
const mutate = (fn) => { const s = clone(validRawStrategy()); fn(s); return validateStrategyOutput(s, { prohibitedPhrases: ['guaranteed results'], suppliedCompetitors: [] }); };
const errorsOf = (r) => summarizeValidationErrors(r.errors);

describe('one contract: tool schema, prompt and validator agree', () => {
  test('1: a completely valid strategy is accepted and the output has exactly the schema\'s sections', () => {
    const r = validateStrategyOutput(validRawStrategy(), { prohibitedPhrases: [], suppliedCompetitors: [] });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    const schema = buildStrategyToolSchema();
    for (const key of schema.required) assert.ok(key in validRawStrategy(), `the fixture has the required section ${key}`);
    for (const key of Object.keys(schema.properties)) assert.ok(key in r.strategy || ['gaps'].includes(key), `the validator produces ${key}`);
    assert.deepEqual(r.trimmed, []);
  });

  test('2: every limit the validator enforces is one the tool schema tells the model (no hidden rule): max lengths and list sizes appear in the schema', () => {
    const schema = JSON.stringify(buildStrategyToolSchema());
    for (const n of [LIMITS.summary, LIMITS.hashtags.category, LIMITS.hashtags.approach, LIMITS.posting.rangeMax, LIMITS.goals.max, LIMITS.hooks.max]) assert.ok(schema.includes(String(n)), `${n} is in the schema`);
    assert.match(buildSystemPrompt(), /\S/);
  });

  test('3: the tool schema forbids unknown fields and the validator drops them: nothing the model invents is saved', () => {
    const schema = buildStrategyToolSchema();
    assert.equal(schema.additionalProperties, false);
    const r = mutate((s) => { s.invented = 'x'; s.platformStrategy[0].secretPlan = 'y'; });
    assert.equal(r.ok, true);
    assert.equal(JSON.stringify(r.strategy).includes('secretPlan'), false);
    assert.equal('invented' in r.strategy, false);
  });
});

describe('format slips are normalised; business-rule violations are not', () => {
  test('4: a plain numeric string is a number ("25" -> 25, "7.0" accepted); "25%", "3 posts/week", "" and objects are not numbers', () => {
    const ok = mutate((s) => { s.contentMix[0].percentage = String(s.contentMix[0].percentage); s.platformStrategy[0].postsPerWeek = '4'; });
    assert.equal(ok.ok, true, JSON.stringify(ok.errors));
    assert.equal(typeof ok.strategy.contentMix[0].percentage, 'number');
    assert.equal(ok.strategy.platformStrategy[0].postsPerWeek, 4);
    for (const bad of ['25%', '3 posts/week', '', ' ', '1e3x', {}, [], null, true]) {
      const r = mutate((s) => { s.platformStrategy[0].postsPerWeek = bad; });
      assert.equal(r.ok, false, JSON.stringify(bad));
      assert.deepEqual(errorsOf(r).filter((e) => e.path === 'platformStrategy[0].postsPerWeek').map((e) => e.code), ['WRONG_TYPE'], JSON.stringify(bad));
    }
  });

  test('5: numeric strings are still range-checked ("9999" and "-1" are out of range, never silently accepted)', () => {
    for (const bad of ['9999', '-1']) {
      const r = mutate((s) => { s.platformStrategy[0].postsPerWeek = bad; });
      assert.deepEqual(errorsOf(r).filter((e) => e.path === 'platformStrategy[0].postsPerWeek').map((e) => e.code), ['OUT_OF_RANGE'], bad);
    }
  });

  test('6: percentages: exactly 100 accepted; a small drift is corrected on the largest item; a total far from 100 is rejected with PERCENT_SUM', () => {
    assert.equal(mutate((s) => { /* untouched */ }).ok, true);
    const drift = mutate((s) => { s.contentMix[0].percentage += 2; });
    assert.equal(drift.ok, true);
    assert.equal(drift.strategy.contentMix.reduce((t, m) => t + m.percentage, 0), 100);
    const far = mutate((s) => { s.contentMix[0].percentage += 60; });
    assert.equal(far.ok, false);
    assert.ok(errorsOf(far).some((e) => e.path === 'contentMix' && e.code === 'PERCENT_SUM'));
  });

  test('7: an over-long LIST keeps its first entries when it is a modest overrun and is reported (trimmed); a grossly oversized one is rejected', () => {
    const modest = mutate((s) => { s.toneAndVoice.avoid = Array.from({ length: LIMITS.tone.avoidMax + 1 }, (_, i) => `avoid number ${i}`); });
    assert.equal(modest.ok, true, JSON.stringify(modest.errors));
    assert.equal(modest.strategy.toneAndVoice.avoid.length, LIMITS.tone.avoidMax);
    assert.equal(modest.strategy.toneAndVoice.avoid[0], 'avoid number 0');
    assert.ok(modest.trimmed.includes('toneAndVoice.avoid'));
    const gross = mutate((s) => { s.toneAndVoice.avoid = Array.from({ length: LIMITS.tone.avoidMax * 4 }, (_, i) => `avoid number ${i}`); });
    assert.equal(gross.ok, false);
    assert.ok(errorsOf(gross).some((e) => e.path === 'toneAndVoice.avoid' && e.code === 'TOO_MANY'));
  });

  test('8: THE BUG: 12 entries in toneAndVoice.avoid and 6 in brandAnalysis.strengths (limits 10 and 5) no longer discard a whole strategy', () => {
    const r = mutate((s) => {
      s.toneAndVoice.avoid = Array.from({ length: 12 }, (_, i) => `a different thing to avoid ${i}`);
      s.brandAnalysis.strengths = Array.from({ length: 6 }, (_, i) => `strength number ${i}`);
    });
    assert.equal(r.ok, true, JSON.stringify(errorsOf(r)));
    assert.deepEqual([...r.trimmed].sort(), ['brandAnalysis.strengths', 'toneAndVoice.avoid']);
  });

  test('9: a prohibited phrase USED anywhere is rejected and the report says WHERE (but never the phrase); listing it under "avoid" is the one allowed mention', () => {
    const used = mutate((s) => { s.brandAnalysis.strengths[0] = 'We deliver guaranteed results for every client'; });
    assert.equal(used.ok, false);
    const [e] = errorsOf(used);
    assert.deepEqual({ path: e.path, code: e.code }, { path: 'brandAnalysis.strengths[0]', code: 'PROHIBITED_PHRASE' });
    assert.equal(JSON.stringify(errorsOf(used)).toLowerCase().includes('guaranteed'), false, 'the phrase itself is not in the diagnostics');
    assert.equal(mutate((s) => { s.toneAndVoice.avoid[0] = 'guaranteed results'; }).ok, true);
  });

  test('9b: a messaging rule may NAME a banned phrase to forbid it ("Never promise guaranteed results"); a rule that USES the phrase is rejected, with its path', () => {
    const forbids = mutate((s) => { s.brandRules.messagingRules[0] = 'Never promise guaranteed results to a prospect'; });
    assert.equal(forbids.ok, true, JSON.stringify(errorsOf(forbids)));
    const uses = mutate((s) => { s.brandRules.messagingRules[0] = 'Lead with guaranteed results in every pitch'; });
    assert.equal(uses.ok, false);
    assert.deepEqual(errorsOf(uses).map((e) => `${e.path}:${e.code}`), ['brandRules.messagingRules[0]:PROHIBITED_PHRASE']);
    const elsewhere = mutate((s) => { s.recommendations[0] = 'Never use guaranteed results'; });
    assert.equal(elsewhere.ok, false, 'the allowance is only for messaging rules (and the avoid list)');
  });

  test('9c: a posting time window with its reason ("Tue-Thu, 9:00-11:00 AM local (peak B2B browsing)") fits; one far too long is rejected', () => {
    assert.equal(mutate((s) => { s.postingStrategy.recommendedTimeWindows[0] = 'Tue-Thu, 9:00-11:00 AM local time (peak B2B browsing hours)'; }).ok, true);
    assert.ok(errorsOf(mutate((s) => { s.postingStrategy.recommendedTimeWindows[0] = 'w'.repeat(200); })).some((e) => e.code === 'TOO_LONG'));
  });

  test('10: an unsupported platform, a duplicate platform, a missing required section and a wrong type each fail with the exact path and code', () => {
    const platform = mutate((s) => { s.platformStrategy[0].platform = 'myspace'; });
    assert.ok(errorsOf(platform).some((e) => e.path === 'platformStrategy[0].platform' && e.code === 'BAD_ENUM'));
    const dup = mutate((s) => { s.platformStrategy[1].platform = s.platformStrategy[0].platform; });
    assert.ok(errorsOf(dup).some((e) => e.path === 'platformStrategy[1].platform' && e.code === 'DUPLICATE'));
    const missing = mutate((s) => { delete s.overview; });
    assert.ok(errorsOf(missing).some((e) => e.path === 'overview' && e.code === 'WRONG_TYPE'));
    const wrong = mutate((s) => { s.summary = 42; });
    assert.ok(errorsOf(wrong).some((e) => e.path === 'summary' && e.code === 'WRONG_TYPE'));
    const empty = mutate((s) => { s.summary = '   '; });
    assert.ok(errorsOf(empty).some((e) => e.path === 'summary' && e.code === 'EMPTY'));
  });

  test('11: an empty or malformed tool result is a validation failure with explicit errors, never a crash', () => {
    for (const raw of [{}, [], 'text', null, 7]) {
      const r = validateStrategyOutput(raw, {});
      assert.equal(r.ok, false);
      assert.ok(r.errors.length > 0);
    }
  });
});

describe('diagnostics are safe', () => {
  test('12: path + code + generic rule only: quoted values, supplied figures and "got N" are removed; unknown messages become OTHER', () => {
    assert.deepEqual(summarizeValidationError('platformStrategy[1].role: must be 160 characters or fewer'), { path: 'platformStrategy[1].role', code: 'TOO_LONG', rule: 'must be 160 characters or fewer' });
    assert.deepEqual(summarizeValidationError('contentMix: percentages must add up to 100 (got 160)'), { path: 'contentMix', code: 'PERCENT_SUM', rule: 'percentages must add up to 100' });
    const phrase = summarizeValidationError('strategy: uses the prohibited phrase "Acme secret phrase"');
    assert.equal(JSON.stringify(phrase).includes('secret'), false);
    assert.equal(phrase.code, 'PROHIBITED_PHRASE');
    const figures = summarizeValidationError('strategy: states figures or addresses that were not in the supplied business information: $4,000, 12 Elm Street');
    assert.equal(JSON.stringify(figures).includes('Elm'), false);
    assert.equal(figures.code, 'UNSUPPORTED_FACT');
    const competitor = summarizeValidationError('competitorAnalysis.competitorsConsidered[0]: "Rival Ltd" was not supplied by the business — do not name competitors that were not supplied');
    assert.equal(JSON.stringify(competitor).includes('Rival'), false);
    assert.equal(summarizeValidationError('something odd').code, 'OTHER');
    assert.ok(VALIDATION_CODES.includes('OTHER'));
  });

  test('13: provider failures expose codes only; an attempt record and the persisted list are bounded', () => {
    assert.deepEqual(describeProviderFailure(Object.assign(new Error('secret text sk-123'), { code: 'CLAUDE_BAD_OUTPUT', reason: 'max_tokens_truncated', httpStatus: 200, bodySnippet: 'LEAK' })), { providerCode: 'CLAUDE_BAD_OUTPUT', reason: 'max_tokens_truncated', httpStatus: 200 });
    assert.equal(JSON.stringify(describeProviderFailure(new Error('sk-LEAK'))).includes('LEAK'), false);
    const many = Array.from({ length: 40 }, (_, i) => `field${i}: must not be empty`);
    const rec = attemptRecord({ attempt: 1, errors: many, outputTokens: 7000 });
    assert.equal(rec.errorCount, 40);
    assert.equal(rec.errors.length, 25);
    assert.equal(flattenAttempts([rec, attemptRecord({ attempt: 2, errors: many })]).length, 25);
  });
});
