import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { capQuestions, generateQuestionSet } from '../../shared/questions/services/questionGenerationService.js';
import { selectQuestions } from '../selection/questionSelection.js';
import { makeProfile } from '../../shared/tests/fixtures.js';

const noAi = { provider: { isAvailable: () => false } };
const q = (id, intent, priority = 'medium') => ({ id, intent, priority, text: id });

describe('generation size cap', () => {
  test('capQuestions keeps at most max, spread across intents, deterministic, original order kept', () => {
    const list = [q('d1', 'discovery'), q('d2', 'discovery'), q('d3', 'discovery'), q('c1', 'comparison'), q('l1', 'local_discovery'), q('s1', 'specific_requirements'), q('p1', 'problem_solving'), q('b1', 'buying_decision')];
    const out = capQuestions(list, 5);
    assert.deepEqual(out.map((x) => x.id), ['d1', 'l1', 's1', 'p1', 'b1']);
    assert.deepEqual(capQuestions(list, 5), out);
    assert.equal(capQuestions(list, 20), list);
    assert.equal(capQuestions(list, null), list);
  });
  test('priority decides within an intent', () => {
    assert.deepEqual(capQuestions([q('a', 'discovery', 'low'), q('b', 'discovery', 'high')], 1).map((x) => x.id), ['b']);
  });
  test('a generated set capped at 7 has at most 7 visibility questions and still yields five for a run', async () => {
    const services = ['LASIK surgery', 'Cataract surgery', 'Glaucoma care', 'Retina care'].map((name) => ({ name, status: 'active' }));
    const profile = makeProfile({ social: { services, competitors: [] } });
    const full = await generateQuestionSet(profile, noAi);
    const capped = await generateQuestionSet(profile, { ...noAi, maxVisibility: 7 });
    const count = (g) => g.questions.filter((x) => x.group === 'visibility').length;
    assert.ok(count(capped) <= 7);
    assert.ok(count(capped) <= count(full));
    assert.equal(selectQuestions({ questions: capped.questions, inputs: capped.inputs, language: capped.language }, profile).snapshot.length, 5);
  });
});
