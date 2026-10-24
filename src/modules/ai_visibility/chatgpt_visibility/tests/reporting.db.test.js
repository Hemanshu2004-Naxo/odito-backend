import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import ChatGptVisibilityRun from '../models/ChatGptVisibilityRun.js';
import AiVisibilityQuestionSet from '../../shared/questions/models/AiVisibilityQuestionSet.js';
import AiVisibilityEvidence from '../../shared/evidence/models/AiVisibilityEvidence.js';
import * as runs from '../services/runService.js';
import { startManualRun } from '../services/auditTriggerService.js';
import { processClaimedRun } from '../workers/runWorker.js';
import { getChatGptConfig } from '../config/chatgptConfig.js';
import { getTrend, getCitedPages, compareProjectRuns, listRunEvidence, parseRange } from '../controllers/chatgptVisibilityController.js';
import { makeProfile } from '../../shared/tests/fixtures.js';
import { connectTestDb, disconnectTestDb, dropTestCollections } from '../../shared/tests/testDb.js';

const COLLECTIONS = ['chatgpt_visibility_runs', 'ai_visibility_question_sets', 'ai_visibility_evidence'];
let up = false;
before(async () => {
  up = await connectTestDb();
  if (up) await Promise.all([ChatGptVisibilityRun.syncIndexes(), AiVisibilityQuestionSet.syncIndexes(), AiVisibilityEvidence.syncIndexes()]);
});
after(async () => { if (up) await dropTestCollections(COLLECTIONS); await disconnectTestDb(); });
beforeEach(async () => { if (up) await dropTestCollections(COLLECTIONS); });

const oid = () => new mongoose.Types.ObjectId();
const cfg = () => getChatGptConfig({ CHATGPT_VISIBILITY_ENABLED: 'true', CHATGPT_VISIBILITY_MAX_CONCURRENT_PROMPTS: '1', CHATGPT_VISIBILITY_COOLDOWN_MS: '0', CHATGPT_VISIBILITY_MAX_RUN_COST: '10' });
const res = () => { const r = { statusCode: 200, body: null, status(c) { r.statusCode = c; return r; }, json(b) { r.body = b; return r; } }; return r; };

const q = (id, text, o = {}) => ({ id, group: 'visibility', text, intent: 'discovery', service: null, location: 'Mumbai', language: 'en', templateId: 'svc_cat_loc', priority: 'high', selectionReason: 'r', source: 'template', enabled: true, ...o });
const QUESTIONS = [
  q('q1', 'Which eye hospitals in Mumbai offer LASIK surgery?'),
  q('q2', 'Which eye hospitals in Mumbai offer cataract surgery?'),
  q('q3', 'Where can I get help with blurred vision in Mumbai?', { intent: 'problem_solving' }),
];
async function approvedSet(projectId, version = 1, questions = QUESTIONS) {
  return (await AiVisibilityQuestionSet.create({ projectId, version, status: 'approved', profileHash: 'h', generatorVersion: '1.0.0', inputs: { cities: ['Mumbai'] }, generatedBy: 'template', questions, approvedAt: new Date() })).toObject();
}

/** Plan per question: which pages are cited, whether the brand is mentioned. */
function provider(plan) {
  return async ({ tag }) => {
    const id = tag.split(':')[2];
    const p = plan[id] || {};
    return {
      answerText: p.mention ? `Top picks:\n1. **ASG Eye Hospital**\n2. Sankara Eye Care` : 'Sankara Eye Care is an option.',
      annotations: (p.pages || []).map((u) => ({ title: 't', url: u })),
      cost: 0.01, requestId: `r-${id}`, model: 'm', usage: {}, attempts: 1, durationMs: 1,
    };
  };
}

async function finishedRun(projectId, plan, { version = 1, questions } = {}) {
  // Same version -> the same approved set is run again; a new version archives the old one first (as approval does).
  const current = await AiVisibilityQuestionSet.findOne({ projectId, status: 'approved' }).lean();
  if (!current || current.version !== version) {
    await AiVisibilityQuestionSet.updateMany({ projectId, status: 'approved' }, { $set: { status: 'archived' } });
    await approvedSet(projectId, version, questions);
  }
  const r = await startManualRun({ projectId, userId: oid(), mode: 'approved_questions' }, { config: cfg(), kick: () => true });
  assert.equal(r.scheduled, true, r.reason);
  const claimed = await runs.claimRun({ runId: r.run._id, workerId: 'w', config: cfg() });
  await processClaimedRun(claimed, { config: cfg(), workerId: 'w', execute: provider(plan), emit: () => {}, buildProfile: async (id) => ({ ...makeProfile(), projectId: String(id) }) });
  return r.run._id;
}

describe('most-cited pages', () => {
  test('distinct normalized pages, occurrences vs questions, latest date; tracking params do not create new pages', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const projectId = oid();
    const runId = await finishedRun(projectId, {
      q1: { mention: true, pages: ['https://www.asgeye.example/lasik?utm_source=chatgpt.com', 'https://asgeye.example/lasik#faq'] },
      q2: { mention: true, pages: ['https://asgeye.example/lasik', 'https://asgeye.example/cataract'] },
      q3: { pages: ['https://other.example/x'] },
    });
    const r = res();
    await getCitedPages({ project: { _id: projectId }, query: { runId: String(runId) } }, r);
    assert.equal(r.statusCode, 200);
    const pages = r.body.data.pages;
    assert.deepEqual(pages.map((p) => p.url), ['https://asgeye.example/lasik', 'https://asgeye.example/cataract']);
    assert.deepEqual([pages[0].occurrences, pages[0].questionCount], [3, 2]); // cited 3 times across 2 questions
    assert.ok(pages[0].lastCitedAt);
  });

  test('another project gets 404 for this run and sees none of its pages', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const projectId = oid();
    const runId = await finishedRun(projectId, { q1: { pages: ['https://asgeye.example/a'] } });
    const r = res();
    await getCitedPages({ project: { _id: oid() }, query: { runId: String(runId) } }, r);
    assert.equal(r.statusCode, 404);
    const all = res();
    await getCitedPages({ project: { _id: oid() }, query: { range: 'all' } }, all);
    assert.deepEqual(all.body.data.pages, []);
  });
});

describe('questions & answers table filters', () => {
  test('search, mentioned and cited filters work and are scoped to the run', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const projectId = oid();
    const runId = await finishedRun(projectId, { q1: { mention: true, pages: ['https://asgeye.example/a'] }, q2: { mention: false }, q3: { mention: true } });
    const call = async (query) => { const r = res(); await listRunEvidence({ project: { _id: projectId }, params: { runId: String(runId) }, query }, r); return r.body.data.map((e) => e.questionId).sort(); };
    assert.deepEqual(await call({ mentioned: 'true' }), ['q1', 'q3']);
    assert.deepEqual(await call({ cited: 'true' }), ['q1']);
    assert.deepEqual(await call({ q: 'cataract' }), ['q2']);
    assert.deepEqual(await call({ citedUrl: 'https://asgeye.example/a' }), ['q1']);
    assert.deepEqual(await call({ competitor: 'Sankara Eye Care' }), ['q1', 'q2', 'q3']);
  });
});

describe('trend and comparison', () => {
  test('trend points carry the figures and flag a change of question set', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const projectId = oid();
    await finishedRun(projectId, { q1: { mention: true } });
    await finishedRun(projectId, { q1: { mention: true }, q2: { mention: true } });
    await finishedRun(projectId, { q1: { mention: true } }, { version: 2 });
    const r = res();
    await getTrend({ project: { _id: projectId }, query: { range: 'all' } }, r);
    const pts = r.body.data.points;
    assert.equal(pts.length, 3);
    assert.deepEqual(pts.map((p) => p.figures.visibilityRate), [0.3333, 0.6667, 0.3333]);
    assert.deepEqual(pts.map((p) => p.comparableWithPrevious), [false, true, false]);
  });

  test('comparing equivalent runs gives deltas; a different set is flagged non-equivalent; cross-project is 404', async (t) => {
    if (!up) return t.skip('MongoDB not available');
    const projectId = oid();
    const a = await finishedRun(projectId, { q1: { mention: true } });
    const b = await finishedRun(projectId, { q1: { mention: true }, q2: { mention: true } });
    const c = await finishedRun(projectId, { q1: { mention: true } }, { version: 2, questions: [QUESTIONS[0], q('q4', 'Which eye hospitals in Pune offer LASIK surgery?', { location: 'Pune' })] });
    const call = async (runA, runB, project = projectId) => { const r = res(); await compareProjectRuns({ project: { _id: project }, query: { runA: String(runA), runB: String(runB) } }, r); return r; };
    const same = (await call(a, b)).body.data;
    assert.equal(same.equivalent, true);
    assert.equal(same.delta.visibilityRate, 0.3334);
    const diff = (await call(b, c)).body.data;
    assert.equal(diff.equivalent, false);
    assert.ok(diff.reasons.includes('DIFFERENT_QUESTION_SET_VERSION') && diff.reasons.includes('DIFFERENT_QUESTIONS'));
    assert.equal(diff.delta, null);
    assert.equal((await call(a, b, oid())).statusCode, 404);
    assert.equal((await call('nope', b)).statusCode, 400);
  });

  test('range parsing is validated', () => {
    assert.ok(parseRange({ range: '7y' }).error);
    assert.ok(parseRange({ from: 'not a date' }).error);
    assert.deepEqual(parseRange({ range: 'all' }), { from: null, to: null });
    assert.ok(parseRange({}).from instanceof Date);
  });
});
