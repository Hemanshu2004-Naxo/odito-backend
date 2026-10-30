import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { selectQuestions, eligibleQuestions, QuestionSelectionError } from '../selection/questionSelection.js';
import { resolveLocation, LocationConfigError, LOCATION_ERROR } from '../location/locationResolver.js';
import { generateQuestionSet } from '../../shared/questions/services/questionGenerationService.js';
import { makeProfile } from '../../shared/tests/fixtures.js';

const noAi = { provider: { isAvailable: () => false } };
async function approvedSet(profile = makeProfile()) {
  const g = await generateQuestionSet(profile, noAi);
  // The current generator no longer emits brand-named questions, but older approved sets still contain them: add one.
  const brand = { id: 'brand1', group: 'brand_reputation', intent: 'brand_reputation', text: 'What do people say about ASG Eye Hospital?', enabled: true, source: 'template' };
  return { _id: 'set1', version: 1, status: 'approved', language: g.language, inputs: g.inputs, questions: [...g.questions, brand] };
}
const visibility = (set) => set.questions.filter((q) => q.group === 'visibility');

describe('exactly five questions', () => {
  test('automatic selection returns exactly five unique, valid visibility questions', async () => {
    const profile = makeProfile();
    const set = await approvedSet(profile);
    assert.ok(visibility(set).length > 5, 'fixture has more than five questions, so selection must cap');
    const { snapshot, mode } = selectQuestions(set, profile);
    assert.equal(mode, 'auto');
    assert.equal(snapshot.length, 5);
    assert.equal(new Set(snapshot.map((q) => q.questionId)).size, 5);
    assert.equal(new Set(snapshot.map((q) => q.text.toLowerCase())).size, 5);
    assert.ok(snapshot.every((q) => q.group === 'visibility'));
  });
  test('selection is deterministic and spreads over intents', async () => {
    const profile = makeProfile();
    const set = await approvedSet(profile);
    const a = selectQuestions(set, profile).snapshot;
    const b = selectQuestions(set, profile).snapshot;
    assert.deepEqual(a, b);
    assert.ok(new Set(a.map((q) => q.intent)).size >= 3);
  });
  test('brand-reputation (brand-named) questions are never selected', async () => {
    const profile = makeProfile();
    const set = await approvedSet(profile);
    assert.ok(set.questions.some((q) => q.group === 'brand_reputation'));
    const { snapshot } = selectQuestions(set, profile);
    assert.ok(snapshot.every((q) => !/ASG Eye Hospital/i.test(q.text)));
  });
  test('fewer than five usable questions refuses the run (no padding, no invention)', async () => {
    const profile = makeProfile();
    const set = await approvedSet(profile);
    let kept = 0;
    set.questions = set.questions.map((q) => (q.group === 'visibility' && kept++ < 4 ? q : { ...q, enabled: q.group === 'visibility' ? false : q.enabled }));
    assert.throws(() => selectQuestions(set, profile), (e) => e instanceof QuestionSelectionError && e.code === 'NOT_ENOUGH_QUESTIONS' && e.details.available === 4 && e.details.required === 5);
  });
  test('more than five enabled questions: only five are selected', async () => {
    const profile = makeProfile();
    const set = await approvedSet(profile);
    const enabled = visibility(set).filter((q) => q.enabled).length;
    assert.ok(enabled > 5);
    assert.equal(selectQuestions(set, profile).snapshot.length, 5);
  });
  test('duplicate question text is collapsed before selection', async () => {
    const profile = makeProfile();
    const set = await approvedSet(profile);
    const v = visibility(set);
    const dup = { ...v[0], id: 'dup-of-first' };
    set.questions = [...set.questions, dup];
    const { eligible, excluded } = eligibleQuestions(set, profile);
    assert.ok(excluded.some((x) => x.questionId === 'dup-of-first' && x.reason === 'DUPLICATE_QUESTION'));
    assert.equal(new Set(eligible.map((q) => q.text.toLowerCase())).size, eligible.length);
  });
  test('a question that names a competitor added after approval is dropped, not sent', async () => {
    const base = makeProfile();
    const set = await approvedSet(base);
    const victim = visibility(set)[0];
    set.questions = set.questions.map((q) => (q.id === victim.id ? { ...q, text: `${q.text.replace(/\?$/, '')} compared with Sankara Eye Care?`, source: 'user' } : q));
    const { eligible, excluded } = eligibleQuestions(set, base);
    assert.ok(!eligible.some((q) => q.id === victim.id));
    assert.ok(excluded.some((x) => x.questionId === victim.id && x.reason === 'COMPETITOR_IN_VISIBILITY_QUESTION'));
  });
  test('services that are not confirmed are not invented: questions only mention confirmed services', async () => {
    const profile = makeProfile();
    const set = await approvedSet(profile);
    const services = set.inputs.services.map((s) => s.toLowerCase());
    for (const q of selectQuestions(set, profile).snapshot) if (q.service) assert.ok(services.includes(q.service.toLowerCase()));
  });
});

describe('user-chosen questions', () => {
  test('exactly five valid ids are accepted in the given order', async () => {
    const profile = makeProfile();
    const set = await approvedSet(profile);
    const ids = visibility(set).slice(0, 5).map((q) => q.id).reverse();
    assert.deepEqual(selectQuestions(set, profile, { questionIds: ids }).snapshot.map((q) => q.questionId), ids);
  });
  test('wrong count, duplicate ids, unknown ids and brand questions are refused', async () => {
    const profile = makeProfile();
    const set = await approvedSet(profile);
    const ids = visibility(set).slice(0, 6).map((q) => q.id);
    const code = (questionIds) => { try { selectQuestions(set, profile, { questionIds }); } catch (e) { return e.code; } return null; };
    assert.equal(code(ids.slice(0, 4)), 'QUESTION_COUNT_INVALID');
    assert.equal(code(ids), 'QUESTION_COUNT_INVALID');
    assert.equal(code([ids[0], ids[0], ids[1], ids[2], ids[3]]), 'DUPLICATE_QUESTION');
    assert.equal(code([...ids.slice(0, 4), 'nope']), 'QUESTION_NOT_ELIGIBLE');
    const brandId = 'brand1';
    assert.equal(code([...ids.slice(0, 4), brandId]), 'QUESTION_NOT_ELIGIBLE');
    assert.equal(code('x'), 'QUESTION_IDS_INVALID');
  });
});

// ── location ──
const LOCATIONS = [
  { location_code: 2356, location_name: 'India', country_iso_code: 'IN', location_type: 'Country' },
  { location_code: 1007740, location_name: 'Nashik,Maharashtra,India', country_iso_code: 'IN', location_type: 'City' },
  { location_code: 1007785, location_name: 'Mumbai,Maharashtra,India', country_iso_code: 'IN', location_type: 'City' },
  { location_code: 1001001, location_name: 'Springfield,Missouri,United States', country_iso_code: 'US', location_type: 'City' },
  { location_code: 1001002, location_name: 'Springfield,Illinois,United States', country_iso_code: 'US', location_type: 'City' },
  { location_code: 2840, location_name: 'United States', country_iso_code: 'US', location_type: 'Country' },
];
const loadLocations = async () => LOCATIONS;

describe('location resolution (never silently another place)', () => {
  test('Nashik resolves to Nashik, not Mumbai or the country', async () => {
    const r = await resolveLocation({ effectiveScope: 'local', city: 'Nashik', state: 'Maharashtra', countryCode: 'IN' }, { loadLocations });
    assert.deepEqual([r.locationCode, r.method], [1007740, 'city']);
  });
  test('unknown city is an error, not a country fallback', async () => {
    await assert.rejects(() => resolveLocation({ effectiveScope: 'local', city: 'Atlantis', countryCode: 'IN' }, { loadLocations }), { code: LOCATION_ERROR.NOT_FOUND });
  });
  test('ambiguous city needs the state', async () => {
    await assert.rejects(() => resolveLocation({ effectiveScope: 'local', city: 'Springfield', countryCode: 'US' }, { loadLocations }), { code: LOCATION_ERROR.AMBIGUOUS });
    const r = await resolveLocation({ effectiveScope: 'local', city: 'Springfield', state: 'Illinois', countryCode: 'US' }, { loadLocations });
    assert.equal(r.locationCode, 1001002);
  });
  test('missing country / city and an unreachable lookup are explicit configuration errors', async () => {
    await assert.rejects(() => resolveLocation({ effectiveScope: 'local', city: 'Nashik', countryCode: null }, { loadLocations }), { code: LOCATION_ERROR.COUNTRY_MISSING });
    await assert.rejects(() => resolveLocation({ effectiveScope: 'local', city: null, countryCode: 'IN' }, { loadLocations }), { code: LOCATION_ERROR.CITY_MISSING });
    await assert.rejects(() => resolveLocation({ effectiveScope: 'local', city: 'Nashik', countryCode: 'IN' }, { loadLocations: async () => { throw new Error('down'); } }), (e) => e instanceof LocationConfigError && e.code === LOCATION_ERROR.LOOKUP_FAILED);
  });
  test('national scope uses the country location', async () => {
    const r = await resolveLocation({ effectiveScope: 'national', city: null, countryCode: 'in' }, { loadLocations });
    assert.deepEqual([r.locationCode, r.method], [2356, 'country']);
  });
});
